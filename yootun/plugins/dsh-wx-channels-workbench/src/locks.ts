/**
 * Per-account profile lock：防止扫码/探活/采集并发打开同一 Chrome profile。
 * 同进程 Map<string, Promise> 锁；跨进程场景由 Chrome 自身的 profile 文件锁兜底。
 * @module
 */

const locks = new Map<string, Promise<void>>()

/**
 * Run `task` while holding the per-account profile lock. Concurrent callers
 * for the same accountId wait for the previous holder to settle.
 * @param accountId - the account whose profile is being accessed.
 * @param task - the exclusive operation.
 * @returns the task's result.
 */
export async function withProfileLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const key = `profile:${accountId}`
  const previous = locks.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  // 排在前面（无论前一个成功还是失败）。
  const current = previous.then(() => gate)
  locks.set(key, current)
  await previous
  try {
    return await task()
  } finally {
    release()
    // 清理：只在 current settle 后删 key，避免泄漏。
    void current.then(() => {
      if (locks.get(key) === current) locks.delete(key)
    })
  }
}

/** Whether the account's profile lock is currently held. */
export function isProfileLocked(accountId: string): boolean {
  return locks.has(`profile:${accountId}`)
}
