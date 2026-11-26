/**
 * 任务登记表测试（node --test；实施单 workbench-host-kit 附录 B.1 H9 的 G1–G2
 * 迁入）：awaitSettled 预算（等待与计时器赛跑，now 可注入）、dispose 预算耗尽
 * 告警与挂起任务 finally 收敛。运行：`node --test tests/task-registry.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_DISPOSE_BUDGET_MS, createTaskRegistry, type TaskRegistry } from '../src/task-registry.ts'

/** disposeHostTasks 的最小信号表形状（各插件收口的共同核心，H9 G2 迁入）。 */
async function disposeCore(deps: { disposing: boolean; signals: Map<string, AbortController>; taskRegistry: TaskRegistry }, budget: { disposeBudgetMs?: number; warn?: (message: string) => void } = {}): Promise<void> {
  deps.disposing = true
  for (const controller of deps.signals.values()) controller.abort()
  const outcome = await deps.taskRegistry.awaitSettled(budget.disposeBudgetMs ?? DEFAULT_DISPOSE_BUDGET_MS)
  if (outcome.exhausted) budget.warn?.(`lifecycle: dispose budget exhausted, ${outcome.pending} tasks pending`)
  deps.signals.clear()
}

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
  const deps = { disposing: false, signals: new Map([['t1', new AbortController()]]), taskRegistry: registry }
  const gate = Promise.withResolvers<void>()
  let finallyRan = false
  const task = gate.promise.finally(() => { finallyRan = true })
  registry.track(task)
  const warnings: string[] = []
  await disposeCore(deps, { disposeBudgetMs: 50, warn: message => { warnings.push(message) } })
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
