/**
 * 单飞轮询器：tick 在途时忽略新的触发；stop() 清定时器。machine 卸载与
 * 页面卸载都调用 stop()。定时器句柄经注入的 schedule/cancel 管理，测试可
 * 注入假时钟。
 * @module
 */

/** 定时器注入面（真实实现用 setInterval/clearInterval；测试注入假时钟）。 */
export interface PollerSchedule {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

export interface PollerOptions extends PollerSchedule {
  /** 轮询间隔毫秒。 */
  intervalMs: number
}

/** 单飞轮询器：上一拍未返回不发下一拍。 */
export interface Poller {
  /** 启动轮询：第一拍立即执行；已在轮询时幂等（不重启）。 */
  start(tick: () => Promise<void> | void): void
  /** 停止轮询并清定时器；停止后迟到的 tick 结果由调用方的守卫丢弃。 */
  stop(): void
  /** 是否已启动（stop 后为 false）。 */
  readonly running: boolean
}

/**
 * Create a single-flight poller. 首拍立即同步发起；其后每 `intervalMs` 一拍，
 * 上一拍未 settle 时跳过（不发新请求）。
 * @param options - interval 与定时器注入。
 * @returns the poller.
 */
export function createPoller(options: PollerOptions): Poller {
  let handle: unknown = null
  let inFlight = false
  let tick: (() => Promise<void> | void) | null = null

  const loop = (): void => {
    if (tick === null || inFlight) return
    inFlight = true
    void Promise.resolve(tick()).catch(() => undefined).finally(() => { inFlight = false })
  }

  return {
    start(startedTick) {
      if (handle !== null) return
      tick = startedTick
      loop()
      handle = options.schedule(() => { loop() }, options.intervalMs)
    },
    stop() {
      if (handle !== null) {
        options.cancel(handle)
        handle = null
      }
      tick = null
    },
    get running() { return handle !== null },
  }
}
