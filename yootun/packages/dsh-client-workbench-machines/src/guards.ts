/**
 * 序号守卫：发起异步操作时取号，返回时号不匹配即丢弃——过期的异步结果不得
 * 覆盖较新的状态（W2）。
 * @module
 */

/** 发起时取号、返回时校验的序号守卫。 */
export interface LatestGuard {
  /** 发起一次异步操作：返回本次操作的序号。 */
  take(): number
  /** 该序号是否仍是最新的一次发起。 */
  isCurrent(seq: number): boolean
}

/**
 * Create a sequence guard. 单调递增：`take` 递增并返回新号；只有持有当前最大
 * 号的异步结果才被采纳。
 * @returns the guard.
 */
export function createLatest(): LatestGuard {
  let seq = 0
  return {
    take: () => ++seq,
    isCurrent: taken => taken === seq,
  }
}
