/**
 * 抖音 dispose 统一收口：后台任务登记表与卸载预算在
 * [kit](../../../packages/dsh-workbench-host-kit/src/task-registry.ts)，本模块
 * 只保留抖音的信号表形状（单表 signals）的收口顺序。dispose 按「拒绝新请求 →
 * abort 全部信号 → awaitSettled(预算) → 清理 controllers」收口。等待与计时器
 * 赛跑：任务正常收敛时计时器被清除；永不 settle 的任务（Chrome close 挂起等）
 * 被预算兜住，超时后 dispose 照常完成，被 abort 的任务随后 settle 时其
 * finally（锁释放、临时 profile 清理、runs 终态写）照常执行。
 * @module
 */
import { DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry } from '@yootun/dsh-workbench-host-kit'

export { createTaskRegistry, DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry, type AwaitSettledOutcome } from '@yootun/dsh-workbench-host-kit'

/**
 * dispose 统一收口：①deps.disposing 置位（route handler 稳定拒绝新 action，
 * 稳定码 `plugin_disposing`）②abort 全部登记信号（D2+ 登录/采集长任务在 await
 * 点检查 abort 提前退出）③等所有登记任务 settle 至多 `disposeBudgetMs`（耗尽
 * 时告警并继续——挂起任务的 finally 随其 settle 照常执行）④清空 controllers。
 * @param options.deps - Host deps（disposing 标志 / 信号表 / 任务注册表）。
 * @param budget.disposeBudgetMs - 卸载预算毫秒（Config.disposeBudgetMs 透传；
 *   缺省 {@linkcode DEFAULT_DISPOSE_BUDGET_MS}）。
 * @param budget.warn - 预算耗尽告警（插件 logger；缺省不记录）。
 */
export async function disposeHostTasks(options: {
  deps: {
    disposing: boolean
    signals: Map<string, AbortController>
    taskRegistry: TaskRegistry
  }
}, budget: {
  disposeBudgetMs?: number | undefined
  warn?: ((message: string) => void) | undefined
} = {}): Promise<void> {
  const { deps } = options
  deps.disposing = true
  for (const controller of deps.signals.values()) controller.abort()
  const outcome = await deps.taskRegistry.awaitSettled(budget.disposeBudgetMs ?? DEFAULT_DISPOSE_BUDGET_MS)
  if (outcome.exhausted) budget.warn?.(`lifecycle: dispose budget exhausted, ${outcome.pending} tasks pending`)
  deps.signals.clear()
}
