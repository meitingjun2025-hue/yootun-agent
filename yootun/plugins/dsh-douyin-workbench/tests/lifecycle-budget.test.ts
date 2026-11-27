/**
 * 生命周期时间预算测试（node --test，实施单 host-lifecycle-budget 附录 B
 * G1–G4）：awaitSettled 预算（等待与计时器赛跑，now 可注入）、dispose 预算
 * 耗尽告警与挂起任务 finally 收敛、closeContext 关闭预算、launchWithTimeout
 * 启动预算与迟到结果清理。G6（既有 dispose/abort/批量取消用例在新预算下通过）
 * 由 dispose/abort/lifecycle3/batch-concurrency 既有文件承载。
 * 运行：`node --test tests/lifecycle-budget.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserLaunchTimeoutError, closeContext, launchWithTimeout } from '../src/chrome.ts'
import { safeCode } from '../src/errors.ts'
import { createTaskRegistry, disposeHostTasks } from '../src/lifecycle.ts'

test('G1 awaitSettled(50)：永不 settle 的任务在预算处返回 exhausted；无任务立即返回', async () => {
  const registry = createTaskRegistry()
  const never = Promise.withResolvers<void>()
  registry.track(never.promise)
  const started = Date.now()
  const outcome = await registry.awaitSettled(50)
  const elapsed = Date.now() - started
  assert.deepEqual(outcome, { exhausted: true, pending: 1 })
  assert.ok(elapsed >= 40 && elapsed < 500, `应在预算附近返回，实际 ${String(elapsed)}ms`)
  never.resolve()
  await registry.awaitSettled()
  // 无任务：立即返回，不空等预算。
  const empty = await createTaskRegistry().awaitSettled(50)
  assert.deepEqual(empty, { exhausted: false, pending: 0 })
})

test('G1 awaitSettled 预算按注入 now 计算，唤醒用真实计时器', async () => {
  let clock = 0
  const registry = createTaskRegistry({ now: () => clock })
  const gate = Promise.withResolvers<void>()
  registry.track(gate.promise)
  // 入口先按 now 记起点（start=0），等待期间推进 now：下一轮剩余预算为负，
  // 按预算返回 exhausted；唤醒来自真实计时器（100ms 一轮）。
  const pending = registry.awaitSettled(100)
  clock = 1000
  assert.deepEqual(await pending, { exhausted: true, pending: 1 })
  gate.resolve()
  await registry.awaitSettled()
})

test('G1 awaitSettled 正常收敛时计时器被清除（任务 settle 后迅速返回）', async () => {
  const registry = createTaskRegistry()
  const gate = Promise.withResolvers<void>()
  registry.track(gate.promise)
  const started = Date.now()
  setTimeout(() => gate.resolve(), 20)
  const outcome = await registry.awaitSettled(10_000)
  const elapsed = Date.now() - started
  assert.deepEqual(outcome, { exhausted: false, pending: 0 })
  assert.ok(elapsed < 1000, `settle 先到应立即返回（计时器已清），实际 ${String(elapsed)}ms`)
})

test('G2 dispose 预算耗尽：告警且 signals 已清空；挂起任务随后 settle 时 finally 执行', async () => {
  const registry = createTaskRegistry()
  const deps = { disposing: false, signals: new Map([['t1', new AbortController()]]), loginRuns: new Map<string, unknown>(), taskRegistry: registry }
  const gate = Promise.withResolvers<void>()
  let finallyRan = false
  const task = gate.promise.finally(() => { finallyRan = true })
  registry.track(task)
  const warnings: string[] = []
  await disposeHostTasks({ deps }, { disposeBudgetMs: 50, warn: message => { warnings.push(message) } })
  assert.equal(deps.disposing, true)
  assert.equal(deps.signals.size, 0, '预算耗尽后信号表仍清空')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /lifecycle: dispose budget exhausted, 1 tasks pending/)
  assert.equal(finallyRan, false, 'dispose 返回时挂起任务尚未 settle')
  // 被 abort 的任务随后 settle：其 finally（锁释放/临时 profile 清理/runs 终态写
  // 的同型收尾）照常执行，且不产生 unhandled rejection。
  gate.resolve()
  await registry.awaitSettled()
  assert.equal(finallyRan, true)
  assert.equal(registry.activeCount, 0)
})

test('G3 closeContext：正常关闭不触发 onTimeout；挂起的 close 超时触发 onTimeout 并 resolve', async () => {
  let timedOut = false
  let closed = false
  await closeContext({ close: async () => { closed = true } }, 1000, () => { timedOut = true })
  assert.equal(closed, true)
  assert.equal(timedOut, false)
  // 挂起的 close：closeContext 在预算处返回（close 永不 settle 也不悬挂调用方）。
  const gate = Promise.withResolvers<void>()
  const started = Date.now()
  await closeContext({ close: () => gate.promise }, 40, () => { timedOut = true })
  const elapsed = Date.now() - started
  assert.equal(timedOut, true)
  assert.ok(elapsed >= 30 && elapsed < 500, `应在预算附近返回，实际 ${String(elapsed)}ms`)
  gate.resolve()
  // close 抛错：旁路消费，closeContext 永不抛。
  timedOut = false
  await closeContext({ close: async () => { throw new Error('close failed') } }, 100, () => { timedOut = true })
  assert.equal(timedOut, false)
})

test('G4 launchWithTimeout：超时抛 BrowserLaunchTimeoutError（safeCode → browser_launch_timeout），迟到结果被关闭', async () => {
  const late = Promise.withResolvers<{ close(): Promise<void> }>()
  let closed = false
  let lateCleaned = false
  setTimeout(() => { late.resolve({ close: async () => { closed = true } }) }, 60)
  let caught: unknown = null
  try {
    await launchWithTimeout(() => late.promise, 40, result => {
      lateCleaned = true
      return result.close()
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BrowserLaunchTimeoutError, '超时必须抛 BrowserLaunchTimeoutError')
  assert.equal(safeCode(caught), 'browser_launch_timeout')
  await late.promise
  // 迟到的启动结果被 onLateResult 立即关闭。
  const deadline = Date.now() + 2000
  while (!(lateCleaned && closed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lateCleaned, true)
  assert.equal(closed, true)
  // 预算内成功：结果原样返回。
  assert.equal(await launchWithTimeout(() => Promise.resolve('ok'), 1000), 'ok')
})
