/**
 * 视频号 dispose 统一收口：后台任务登记表与卸载预算在
 * [kit](../../../packages/dsh-workbench-host-kit/src/task-registry.ts)，本模块
 * 只保留视频号的信号表形状（login/collect 双表 + batch.stop）的收口顺序。
 * dispose 按「拒绝新请求 → abort 全部信号 → batch.stop → awaitSettled(预算) →
 * 清理 controllers」收口。等待与计时器赛跑：任务正常收敛时计时器被清除；永不
 * settle 的任务（Chrome close 挂起等）被预算兜住，超时后 dispose 照常完成，被
 * abort 的任务随后 settle 时其 finally（锁释放、临时 profile 清理、runs 终态写）
 * 照常执行。
 * @module
 */
import { DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry } from '@yootun/dsh-workbench-host-kit'

export { createTaskRegistry, DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry, type AwaitSettledOutcome } from '@yootun/dsh-workbench-host-kit'

/**
 * dispose 统一收口：①deps.disposing 置位（route handler 稳定拒绝新 action，
 * 稳定码 plugin_disposing）②abort 全部登录/单账号采集信号 ③batch.stop 停止
 * 当前账号与后续账号 ④等所有登记任务 settle 至多 `disposeBudgetMs`（含晚
 * factory 清理、runs 终态写、batch 整体 run；耗尽时告警并继续——挂起任务的
 * finally 随其 settle 照常执行）⑤清空 controllers。在途 action 的处理由类型
 * 决定：collect/login 被 abort 并等待 settle；probe/promote 被等待；removeLocal
 * 因 try 锁在 collect 释放后才执行、dispose 拒绝后不会半途新起。
 * @param options.deps - Host deps（含 signals/registry/disposing 标志）。
 * @param options.batch - 批量控制器（stop() 停当前账号与后续账号）。
 * @param budget.disposeBudgetMs - 卸载预算毫秒（Config.disposeBudgetMs 透传；
 *   缺省 {@linkcode DEFAULT_DISPOSE_BUDGET_MS}）。
 * @param budget.warn - 预算耗尽告警（插件 logger；缺省不记录）。
 */
export async function disposeHostTasks(options: {
  deps: {
    disposing: boolean
    loginSignals: Map<string, AbortController>
    collectSignals: Map<string, AbortController>
    taskRegistry: TaskRegistry
  }
  batch: { stop(): void }
}, budget: {
  disposeBudgetMs?: number | undefined
  warn?: ((message: string) => void) | undefined
} = {}): Promise<void> {
  const { deps, batch } = options
  deps.disposing = true
  for (const controller of deps.loginSignals.values()) controller.abort()
  for (const controller of deps.collectSignals.values()) controller.abort()
  batch.stop()
  const outcome = await deps.taskRegistry.awaitSettled(budget.disposeBudgetMs ?? DEFAULT_DISPOSE_BUDGET_MS)
  if (outcome.exhausted) budget.warn?.(`lifecycle: dispose budget exhausted, ${outcome.pending} tasks pending`)
  deps.loginSignals.clear()
  deps.collectSignals.clear()
}
