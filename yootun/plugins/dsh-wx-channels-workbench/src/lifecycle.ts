/**
 * 插件任务注册表与 dispose 统一收口：登录/单账号采集/批量采集/probe/promote/
 * 晚 factory 清理/runs 写盘/启动恢复/迟到启动清理等全部后台 promise 经
 * track/runTracked 登记，settle 自动移除，失败经旁路消费不产生 unhandled
 * rejection；dispose 按「拒绝新请求 → abort 全部信号 → batch.stop →
 * awaitSettled(预算) → 清理 controllers」收口。等待与计时器赛跑：任务正常收敛
 * 时计时器被清除；永不 settle 的任务（Chrome close 挂起等）被预算兜住，超时后
 * dispose 照常完成，被 abort 的任务随后 settle 时其 finally（锁释放、临时
 * profile 清理、runs 终态写）照常执行。
 * @module
 */

/** Config.disposeBudgetMs 未透传时的缺省卸载预算（生产路径由 apply 显式注入）。 */
export const DEFAULT_DISPOSE_BUDGET_MS = 20_000

/** awaitSettled 的结果（预算耗尽时 exhausted=true 且 pending 为剩余任务数）。 */
export interface AwaitSettledOutcome {
  /** 预算耗尽（仍有未 settle 任务）时 true。 */
  exhausted: boolean
  /** 返回时尚未 settle 的任务数。 */
  pending: number
}

/** 任务注册表（可观察 active count，测试与诊断用）。 */
export interface TaskRegistry {
  /**
   * Track an existing promise: it is removed from the registry once settled.
   * Rejection is consumed on a side branch so an unhandled caller cannot crash
   * dispose — the caller may still attach its own handlers to the returned
   * promise.
   * @param promise - the background promise to await on dispose.
   * @returns the same promise (callers keep their own error handling).
   */
  track<T>(promise: Promise<T>): Promise<T>
  /**
   * Run `fn` and track its promise.
   * @param fn - the async operation.
   * @returns the operation's result; rejection propagates to the caller.
   */
  runTracked<T>(fn: () => Promise<T>): Promise<T>
  /** Number of currently unsettled tasks. */
  readonly activeCount: number
  /**
   * 等全部任务 settle，至多等 `budgetMs`（缺省无限，收尾期间派生的任务也被
   * 等到）。等待与计时器赛跑：全部 settle 先到即返回；预算耗尽返回
   * `{ exhausted: true, pending }`，不抛——调用方（dispose）决定是否继续。
   * 计时器只在等待期间存在，settle 先到时被清除，不拖住事件循环。
   * @param budgetMs - the wait budget in milliseconds (default unbounded).
   * @returns the settle outcome（预算耗尽时带剩余任务数）。
   */
  awaitSettled(budgetMs?: number): Promise<AwaitSettledOutcome>
}

/**
 * Create a task registry.
 * @param options.now - monotonic-ish clock for the budget math（测试注入；
 *   生产用 Date.now）。
 * @returns the registry.
 */
export function createTaskRegistry(options: { now?: () => number } = {}): TaskRegistry {
  const now = options.now ?? Date.now
  const pending = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise)
    // 旁路消费 rejection：调用方自行处理返回值上的失败，registry 只保证
    // 未处理路径不会变成 unhandled rejection。
    void promise.catch(() => undefined).finally(() => { pending.delete(promise) })
    return promise
  }
  const registry: TaskRegistry = {
    track,
    runTracked: fn => track(fn()),
    get activeCount(): number { return pending.size },
    awaitSettled: async (budgetMs: number = Number.POSITIVE_INFINITY): Promise<AwaitSettledOutcome> => {
      // 无界等待保持旧语义：纯 settle 驱动，不设计时器（Infinity 会溢出
      // setTimeout 的 32 位刻度，折成 1ms 轮询）。
      if (!Number.isFinite(budgetMs)) {
        while (pending.size > 0) {
          await Promise.allSettled([...pending])
        }
        return { exhausted: false, pending: 0 }
      }
      const start = now()
      for (;;) {
        if (pending.size === 0) return { exhausted: false, pending: 0 }
        const remaining = budgetMs - (now() - start)
        if (remaining <= 0) return { exhausted: true, pending: pending.size }
        // 等待与真实计时器赛跑：settle 先到清掉计时器；计时器先到则回到
        // 循环头按预算返回（pending 里可以有永不 settle 的任务）。
        const settled = Promise.allSettled([...pending])
        let wake: (() => void) | undefined
        const timer = new Promise<void>(resolve => {
          const handle = setTimeout(() => { wake = undefined; resolve() }, remaining)
          wake = () => { clearTimeout(handle); resolve() }
        })
        await Promise.race([settled, timer])
        wake?.()
      }
    },
  }
  return registry
}

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
