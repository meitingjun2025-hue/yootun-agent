/**
 * AbortSignal 贯穿测试（node --test）：callerOf 透传、ingest 重试等待可中断、
 * abort 后不再下一批、dispose 中断采集链路 Workbench 调用并等待 settle。
 * 运行：`node --test tests/abort.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDouyinHostDeps } from '../src/index.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import { createIngestClient, ingestCollectedWorks, type IngestWorkbench } from '../src/ingest.ts'

/** 记录 signal 的假 workbench（按脚本应答）。 */
function signalRecordingFace(script: Array<(signal: AbortSignal | undefined, call: FakeWorkbenchCall) => { structuredContent?: unknown; throwCode?: string }>): {
  face: ReturnType<typeof createFakeWorkbench>['face']
  seen: Array<AbortSignal | undefined>
  calls: FakeWorkbenchCall[]
} {
  const calls: FakeWorkbenchCall[] = []
  const seen: Array<AbortSignal | undefined> = []
  let index = 0
  const face = {
    async callTool(caller: string, domain: string, name: string, args: unknown, signal?: AbortSignal) {
      calls.push({ caller, domain, name, args })
      seen.push(signal)
      const step = script[index] ?? (() => ({ structuredContent: {} }))
      index += 1
      const outcome = step(signal, calls[calls.length - 1] as FakeWorkbenchCall)
      if ('throwCode' in outcome && outcome.throwCode !== undefined) {
        const error = new Error(JSON.stringify({ error: { code: outcome.throwCode } })) as Error & { payload?: unknown }
        error.name = 'WorkbenchMcpError'
        error.payload = { error: { code: outcome.throwCode } }
        throw error
      }
      return { structuredContent: outcome.structuredContent ?? {}, content: null }
    },
  }
  return { face, seen, calls }
}

test('AbortSignal 原样传入 Workbench callTool（callerOf 透传）', async () => {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: fake.face })
    const controller = new AbortController()
    await deps.callTool('workbench_douyin_account_list', { accountId: 'a' }, controller.signal)
    // fake face 丢弃 signal？——createFakeWorkbench 不记录 signal，此处用透传面验证：
    // callerOf 是 deps.callTool 的实现，改用记录版 face 断言。
    void controller
  } finally {
    await cleanup()
  }
  const recorder = signalRecordingFace([() => ({ structuredContent: { accounts: [] } })])
  const { root: root2, cleanup: cleanup2 } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root: root2, workbenchFace: recorder.face })
    const controller = new AbortController()
    await deps.callTool('workbench_douyin_account_list', {}, controller.signal)
    assert.equal(recorder.seen[0], controller.signal, 'signal 必须原样到达 face.callTool')
    await deps.callTool('workbench_douyin_account_list', {})
    assert.equal(recorder.seen[1], undefined, '未传 signal 时为 undefined')
  } finally {
    await cleanup2()
  }
})

test('withRetry 退避等待期间 abort 即刻中断，不再发起下一次重试', async () => {
  const controller = new AbortController()
  let metaCalls = 0
  const workbench: IngestWorkbench = {
    async callTool(tool) {
      if (tool === 'workbench_douyin_collect_run_set_list_meta') {
        metaCalls += 1
        // 瞬态错误（非确定性集）→ 进入 500ms 退避。
        const error = new Error(JSON.stringify({ error: { code: 'workbench_network_error' } })) as Error & { payload?: unknown }
        error.name = 'WorkbenchMcpError'
        error.payload = { error: { code: 'workbench_network_error' } }
        throw error
      }
      return { structuredContent: { run: { run_id: 'run-a', last_heartbeat_seq: 0 } }, content: null }
    },
  }
  const client = createIngestClient({ workbench, accountId: 'acc', signal: controller.signal })
  await client.startRun({ newAttempt: true })
  const pending = client.publishListMeta({ expectedWorkCount: 1, listComplete: true })
  await new Promise(resolve => setTimeout(resolve, 60))
  controller.abort()
  const startedAt = Date.now()
  await assert.rejects(() => pending)
  assert.ok(Date.now() - startedAt < 400, 'abort 后应即刻中断（不等满 500ms 退避）')
  assert.equal(metaCalls, 1, 'abort 后不得再发起下一次重试')
})

test('abort 后不再调用下一批 ingest_batch（批间检查）', async () => {
  const controller = new AbortController()
  const batchCalls: number[] = []
  const workbench: IngestWorkbench = {
    async callTool(tool, args) {
      if (tool === 'workbench_douyin_collect_run_start') return { structuredContent: { run: { run_id: 'run-b', last_heartbeat_seq: 0 } }, content: null }
      if (tool === 'workbench_douyin_collect_run_set_list_meta') return { structuredContent: {}, content: null }
      if (tool === 'workbench_douyin_collect_ingest_batch') {
        const batchNo = Number((args as Record<string, unknown>).batchNo)
        batchCalls.push(batchNo)
        if (batchNo === 1) {
          // 第一批成功响应后立即 abort（模拟 dispose/用户取消落在批间）。
          controller.abort()
        }
        return { structuredContent: { batch: { succeeded_work_ids: ['w1'], failed_work_ids: [] }, replayed: false }, content: null }
      }
      return { structuredContent: {}, content: null }
    },
  }
  const client = createIngestClient({ workbench, accountId: 'acc', batchSize: 1, signal: controller.signal })
  await assert.rejects(() => ingestCollectedWorks({
    client,
    works: [
      { work_id: 'w1' }, { work_id: 'w2' },
    ],
    listComplete: true,
    expectedWorkCount: 2,
    publishSince: '2026-05-31T16:00:00Z',
    dashboard: { dashboardRows: [], dashboardFansRows: [] },
  }))
  assert.deepEqual(batchCalls, [1], 'abort 后不得调用第二批')
})

test('dispose 中断采集链路中的 Workbench 调用并等待任务 settle', async () => {
  const controller = new AbortController()
  const workbench: IngestWorkbench = {
    async callTool(tool, _args, signal) {
      if (tool === 'workbench_douyin_collect_run_start') {
        // 挂起直到 signal abort（模拟在途远端调用收到取消）。
        return new Promise((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          void setTimeout(() => resolve({ structuredContent: { run: { run_id: 'run-late' } }, content: null }), 10_000)
        })
      }
      return { structuredContent: {}, content: null }
    },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face })
    deps.signals.set('collect:acc-d', controller)
    const client = createIngestClient({ workbench, accountId: 'acc-d', signal: controller.signal })
    const task = deps.taskRegistry.track(ingestCollectedWorks({
      client,
      works: [],
      listComplete: true,
      expectedWorkCount: 0,
      publishSince: null,
      dashboard: { dashboardRows: [], dashboardFansRows: [] },
    }))
    const settled = task.then(() => 'settled', () => 'settled')
    await new Promise(resolve => setTimeout(resolve, 50))
    const start = Date.now()
    await disposeHostTasks({ deps })
    assert.ok(Date.now() - start < 3000, 'dispose 应等待任务 settle 而非等满挂起超时')
    assert.equal(await settled, 'settled')
    assert.equal(controller.signal.aborted, true)
  } finally {
    await cleanup()
  }
})
