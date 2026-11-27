/**
 * 工作台 Host 任务登记表（P0 生命周期单落地后的抖音版迁入）：后台 promise 经
 * track/runTracked 登记，settle 自动移除，失败经旁路消费不产生 unhandled
 * rejection；`awaitSettled(budgetMs)` 按「等待与计时器赛跑」给 dispose 时间
 * 预算。各插件的 `disposeHostTasks` 收口（signal 表形状不同）留在各自插件。
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

/** 任务登记表（可观察 active count，测试与诊断用）。 */
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
