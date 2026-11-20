/**
 * 插件任务注册表与 dispose 统一收口（迁移 wx 模板同款，无批量控制器）：登录/
 * 探测/采集/probe/晚 factory 清理等后台 promise 经 track/runTracked 登记，
 * settle 自动移除，失败经旁路消费不产生 unhandled rejection；dispose 按
 * 「拒绝新请求 → abort 全部信号 → 等全部任务 settle → 清理 controllers」收口，
 * 不用固定 setTimeout——settle 由任务自身驱动。
 * @module
 */

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
  /** 等全部任务 settle；收尾期间派生的任务（终态写等）也会被等到。 */
  awaitSettled(): Promise<void>
}

/**
 * Create a task registry.
 * @returns the registry.
 */
export function createTaskRegistry(): TaskRegistry {
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
    awaitSettled: async (): Promise<void> => {
      while (pending.size > 0) {
        await Promise.allSettled([...pending])
      }
    },
  }
  return registry
}

/**
 * dispose 统一收口：①deps.disposing 置位（route handler 稳定拒绝新 action，
 * 稳定码 plugin_disposing）②abort 全部登录/探测/采集信号（登录 10 分钟等待与
 * 采集翻页在 await 点检查 abort 提前退出）③等所有登记任务 settle（含晚 factory
 * 清理）④清空 controllers。
 * @param options.deps - Host deps（含 signals/registry/disposing 标志）。
 */
export async function disposeHostTasks(options: {
  deps: {
    disposing: boolean
    loginSignals: Map<string, AbortController>
    probeSignals: Map<string, AbortController>
    collectSignals: Map<string, AbortController>
    taskRegistry: TaskRegistry
  }
}): Promise<void> {
  const { deps } = options
  deps.disposing = true
  for (const controller of deps.loginSignals.values()) controller.abort()
  for (const controller of deps.probeSignals.values()) controller.abort()
  for (const controller of deps.collectSignals.values()) controller.abort()
  await deps.taskRegistry.awaitSettled()
  deps.loginSignals.clear()
  deps.probeSignals.clear()
  deps.collectSignals.clear()
}
