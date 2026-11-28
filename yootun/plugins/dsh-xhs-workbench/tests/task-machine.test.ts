/**
 * 仿写任务状态机测试（旧 test/task-machine.test.mjs 全行为移植）：创建 → 轮询 →
 * 读结果 → 终态、暂态失败重试、stop/resume（含在途创建竞态）、取消确认、
 * 单版可编辑版本数契约。
 * 运行：`node --test tests/task-machine.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTaskMachine, type TaskVersion } from '../src/client/task-machine.ts'

const VERSIONS: TaskVersion[] = [
  { version: 'A', title: 'a', body: '**a**', tags: [], coverCopy: '', leadGuide: '' },
  { version: 'B', title: 'b', body: 'b', tags: [], coverCopy: '', leadGuide: '' },
  { version: 'C', title: 'c', body: 'c', tags: [], coverCopy: '', leadGuide: '' },
]

// 手动假定时器：schedule 捕获回调，测试里用 fire() 手动推进到下一个轮询周期。
function fakeTimers() {
  let scheduled: (() => void) | null = null
  return {
    schedule: (fn: () => void): number => { scheduled = fn; return 1 },
    clear: (): void => { scheduled = null },
    fire: async (): Promise<void> => {
      const fn = scheduled
      scheduled = null
      if (fn !== null) await fn()
    },
    get pending(): boolean { return scheduled !== null },
  }
}

function makeMachine(overrides: {
  createTask?: (input: { mediaType: string; idempotencyKey: string }) => Promise<{ taskId: string; taskStatus?: string }>
  queryStatus?: () => Promise<Record<string, unknown>>
  queryResult?: () => Promise<{ versions: TaskVersion[] }>
  cancelTask?: (taskId: string, idempotencyKey: string) => Promise<unknown>
  onChange?: () => void
} = {}) {
  const timers = fakeTimers()
  const machine = createTaskMachine({
    createTask: overrides.createTask ?? (async input => ({ taskId: 't-1', taskStatus: 'queued', ...(input as { mediaType: string }) })),
    queryStatus: (overrides.queryStatus as (() => Promise<never>)) ?? (async () => ({ taskStatus: 'running', currentStep: 'copywriting' })),
    // 单版可编辑定案：默认假结果为 1 版。
    queryResult: overrides.queryResult ?? (async () => ({ versions: [VERSIONS[0] as TaskVersion] })),
    cancelTask: overrides.cancelTask ?? (async () => undefined),
    intervalMs: 30_000,
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    onChange: overrides.onChange ?? (() => {}),
  })
  return { machine, timers }
}

const BASE = { versionCount: 1 as const }

test('create → poll → succeeded → result returns single version', async () => {
  const statuses = [{ taskStatus: 'running' }, { taskStatus: 'succeeded' }]
  let i = 0
  const { machine, timers } = makeMachine({ queryStatus: async () => statuses[i++] ?? { taskStatus: 'succeeded' } })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().task?.taskStatus, 'running')
  assert.ok(timers.pending)
  await timers.fire()
  assert.equal(machine.get().task?.taskStatus, 'succeeded')
  assert.equal(machine.get().versions?.length, 1)
  assert.equal(machine.get().error, '')
  assert.equal(timers.pending, false)
})

test('create returning failed surfaces failure', async () => {
  const { machine } = makeMachine({ createTask: async () => ({ taskId: 't-1', taskStatus: 'failed' }) })
  await machine.submit({ mediaType: 'video', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().task?.taskStatus, 'failed')
  assert.equal(machine.get().error, 'failed')
  assert.equal(machine.get().versions, null)
})

test('poll failed keeps step and controlled reason for display', async () => {
  const { machine } = makeMachine({
    queryStatus: async () => ({
      taskStatus: 'failed', currentStep: 'copywriting', nextStep: 'copywriting',
      errorCode: 'copywriting_failed', errorMessage: 'no fact or reference basis for copywriting',
    }),
  })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  const state = machine.get()
  assert.equal(state.error, 'failed')
  assert.deepEqual(state.failure, { step: 'copywriting', errorCode: 'copywriting_failed', errorMessage: 'no fact or reference basis for copywriting' })
})

test('poll cancelled clears failure detail', async () => {
  const { machine } = makeMachine({ queryStatus: async () => ({ taskStatus: 'cancelled', currentStep: 'copywriting' }) })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().error, 'cancelled')
  assert.equal(machine.get().failure, null)
})

test('failed failure detail survives terminal resume and is cleared on resubmit', async () => {
  let statusCalls = 0
  const { machine } = makeMachine({
    createTask: async input => ({ taskId: input.idempotencyKey, taskStatus: 'queued' }),
    queryStatus: async () => {
      statusCalls++
      if (statusCalls === 1) return { taskStatus: 'failed', currentStep: 'copywriting', errorCode: 'copywriting_failed', errorMessage: 'no fact or reference basis for copywriting' }
      return { taskStatus: 'queued', currentStep: 'ingest' }
    },
  })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.deepEqual(machine.get().failure, { step: 'copywriting', errorCode: 'copywriting_failed', errorMessage: 'no fact or reference basis for copywriting' })
  // 终态 resume：轮询走 isTerminal 分支，failure 详情保留（跨页面开关可见）。
  await machine.resume()
  assert.deepEqual(machine.get().failure, { step: 'copywriting', errorCode: 'copywriting_failed', errorMessage: 'no fact or reference basis for copywriting' })
  // 重新提交新任务（queued）：failure 清空，不残留上一轮失败引导。
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k2', ...BASE })
  assert.equal(machine.get().failure, null)
  assert.equal(machine.get().task?.idempotencyKey, 'k2')
})

test('create returning cancelled surfaces cancelled', async () => {
  const { machine } = makeMachine({ createTask: async () => ({ taskId: 't-1', taskStatus: 'cancelled' }) })
  await machine.submit({ mediaType: 'video', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().error, 'cancelled')
})

test('transient status failure retries and eventually succeeds', async () => {
  let statusCalls = 0
  const { machine, timers } = makeMachine({
    queryStatus: async () => {
      statusCalls++
      if (statusCalls === 1) throw new Error('network')
      return { taskStatus: 'succeeded' }
    },
  })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().error, 'pollFailed')
  assert.ok(timers.pending)
  await timers.fire()
  assert.equal(machine.get().task?.taskStatus, 'succeeded')
  assert.equal(machine.get().versions?.length, 1)
  assert.equal(machine.get().error, '')
})

test('stop() halts polling; resume() continues', async () => {
  let statusCalls = 0
  const { machine, timers } = makeMachine({ queryStatus: async () => { statusCalls++; return { taskStatus: 'running' } } })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.ok(timers.pending)
  machine.stop()
  assert.equal(timers.pending, false)
  const callsAfterStop = statusCalls
  await machine.resume()
  assert.equal(statusCalls, callsAfterStop + 1)
  assert.ok(timers.pending)
})

test('result count mismatch with versionCount=1 sets resultFailed', async () => {
  // 单版可编辑定案：期望 1 版；0/2+ 版均按读取失败处理（防静默异常版本数）。
  const single: TaskVersion = { version: 'A', title: 'a', body: 'a', tags: [], coverCopy: '', leadGuide: '' }
  const ok = makeMachine({ queryStatus: async () => ({ taskStatus: 'succeeded' }), queryResult: async () => ({ versions: [single] }) })
  await ok.machine.submit({ mediaType: 'video', idempotencyKey: 'k-single', ...BASE })
  assert.equal(ok.machine.get().versions?.length, 1)
  assert.equal(ok.machine.get().error, '')
  const bad = makeMachine({ queryStatus: async () => ({ taskStatus: 'succeeded' }), queryResult: async () => ({ versions: [single, { ...single, version: 'B' }] }) })
  await bad.machine.submit({ mediaType: 'video', idempotencyKey: 'k-single-bad', ...BASE })
  assert.equal(bad.machine.get().error, 'resultFailed')
  assert.equal(bad.machine.get().versions, null)
})

test('create failure surfaces createFailed and keeps no versions', async () => {
  const { machine } = makeMachine({ createTask: async () => { throw new Error('create_failed') } })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.equal(machine.get().error, 'createFailed')
  assert.equal(machine.get().task, null)
  assert.equal(machine.get().versions, null)
})

test('stop during in-flight create does not start polling', async () => {
  let resolveCreate: ((value: { taskId: string; taskStatus: string }) => void) | undefined
  let statusCalls = 0
  const { machine, timers } = makeMachine({
    createTask: () => new Promise(resolve => { resolveCreate = resolve }),
    queryStatus: async () => { statusCalls++; return { taskStatus: 'running' } },
  })
  const submitPromise = machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  // 创建请求尚未返回时关闭页面。
  machine.stop()
  resolveCreate?.({ taskId: 't-1', taskStatus: 'queued' })
  await submitPromise
  // 关闭后不得启动轮询。
  assert.equal(statusCalls, 0)
  assert.equal(timers.pending, false)
  // 任务已保存，重开页面 resume 可继续查询。
  assert.equal(machine.get().task?.taskId, 't-1')
  await machine.resume()
  assert.equal(statusCalls, 1)
})

test('reopening before in-flight create completes starts polling after create', async () => {
  let resolveCreate: ((value: { taskId: string; taskStatus: string }) => void) | undefined
  let statusCalls = 0
  const { machine, timers } = makeMachine({
    createTask: () => new Promise(resolve => { resolveCreate = resolve }),
    queryStatus: async () => { statusCalls++; return { taskStatus: 'running' } },
  })
  const submitPromise = machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  machine.stop()
  await machine.resume()
  assert.equal(statusCalls, 0)
  resolveCreate?.({ taskId: 't-1', taskStatus: 'queued' })
  await submitPromise
  assert.equal(machine.get().task?.taskId, 't-1')
  assert.equal(statusCalls, 1)
  assert.equal(timers.pending, true)
})

test('requestCancel stops polling and lands cancelled', async () => {
  let statusCalls = 0
  let cancelKey = ''
  const { machine, timers } = makeMachine({
    queryStatus: async () => { statusCalls++; return { taskStatus: 'running' } },
    cancelTask: async (taskId, key) => { cancelKey = `${taskId}:${key}`; return undefined },
  })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  assert.ok(timers.pending)
  await machine.requestCancel()
  assert.equal(machine.get().task?.taskStatus, 'cancelled')
  assert.equal(machine.get().error, 'cancelled')
  assert.equal(timers.pending, false)
  assert.equal(statusCalls, 1) // 取消后不再轮询
  // 取消复用任务原幂等键（重试不换键）。
  assert.equal(cancelKey, 't-1:k1')
})

test('requestCancel failure resumes polling and surfaces cancelFailed', async () => {
  const { machine, timers } = makeMachine({
    queryStatus: async () => ({ taskStatus: 'running' }),
    cancelTask: async () => { throw new Error('cancel_failed') },
  })
  await machine.submit({ mediaType: 'images', idempotencyKey: 'k1', ...BASE })
  await machine.requestCancel()
  assert.equal(machine.get().task?.taskStatus, 'running')
  assert.equal(machine.get().error, 'cancelFailed')
  assert.ok(timers.pending)
})

test('requestCancel without a task is a no-op', async () => {
  const { machine, timers } = makeMachine()
  await machine.requestCancel()
  assert.equal(machine.get().task, null)
  assert.equal(machine.get().error, '')
  assert.equal(timers.pending, false)
})
