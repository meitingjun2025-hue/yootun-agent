/**
 * Per-account profile lock：防止扫码/探活/采集/迁移/删除并发打开或改动同一
 * Chrome profile。同进程锁（FIFO 队列，非重入）；跨进程场景由 Chrome 自身的
 * profile 文件锁兜底。
 *
 * 四个入口覆盖两类语义：
 * - 等待语义（`withProfileLock` / `withProfileLocks`）：调用方必须获得临界区，
 *   允许排队等待前一持有者 settle（probe、collect 全程、登录迁移）。
 * - try 语义（`tryWithProfileLock` / `tryWithProfileLocks`）：占用时立即返回
 *   `acquired: false`，绝不排队（removeLocal / promote 不得等长采集）。
 * 多锁入口按 key 排序获取，全序一致，不会循环等待。
 * @module
 */

interface LockEntry {
  /** 是否已被持有（含已移交但尚未运行的下一位持有者）。 */
  busy: boolean
  /** FIFO 等待队列（不含当前持有者）。 */
  waiters: Array<() => void>
}

const locks = new Map<string, LockEntry>()

function entryOf(key: string): LockEntry {
  let entry = locks.get(key)
  if (entry === undefined) {
    entry = { busy: false, waiters: [] }
    locks.set(key, entry)
  }
  return entry
}

/** 获取单把锁；已被持有时排入 FIFO 并等待。promise settle 即代表持有。 */
function acquire(key: string): Promise<void> {
  const entry = entryOf(key)
  if (!entry.busy) {
    entry.busy = true
    return Promise.resolve()
  }
  return new Promise(resolve => { entry.waiters.push(resolve) })
}

/** 同步尝试获取；已被持有时返回 false，不排队。 */
function tryAcquire(key: string): boolean {
  const entry = entryOf(key)
  if (entry.busy) return false
  entry.busy = true
  return true
}

/** 释放一把锁：优先把所有权移交给队首等待者；无人等待则回收 entry。 */
function release(key: string): void {
  const entry = locks.get(key)
  if (entry === undefined) return
  const next = entry.waiters.shift()
  if (next !== undefined) {
    next()
    return
  }
  entry.busy = false
  locks.delete(key)
}

function keysOf(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)].map(id => `profile:${id}`).sort()
}

/**
 * Run `task` while holding the per-account profile lock. Concurrent callers
 * for the same accountId wait (FIFO) for the previous holder to settle.
 * @param accountId - the account whose profile is being accessed.
 * @param task - the exclusive operation.
 * @returns the task's result.
 */
export async function withProfileLock<T>(accountId: string, task: () => Promise<T>): Promise<T> {
  const key = `profile:${accountId}`
  await acquire(key)
  try {
    return await task()
  } finally {
    release(key)
  }
}

/** try 锁的结果：未获取时 `result` 为 undefined，不得读取。 */
export type ProfileLockAttempt<T> = { acquired: false; result: undefined } | { acquired: true; result: T }

/**
 * Try to run `task` under the per-account profile lock without waiting: when
 * the lock is held, return `{ acquired: false }` immediately (the task never
 * runs) — callers project a stable busy reason instead of queueing behind a
 * long collect.
 * @param accountId - the account whose profile is being accessed.
 * @param task - the exclusive operation.
 * @returns the acquisition outcome and, when acquired, the task's result.
 */
export async function tryWithProfileLock<T>(accountId: string, task: () => Promise<T>): Promise<ProfileLockAttempt<T>> {
  const key = `profile:${accountId}`
  if (!tryAcquire(key)) return { acquired: false, result: undefined }
  try {
    return { acquired: true, result: await task() }
  } finally {
    release(key)
  }
}

/**
 * Run `task` while holding several account profile locks at once (login 迁移
 * 同时锁 tempId 与 resolvedId). Keys are acquired in sorted order so every
 * caller uses the same global order — concurrent multi-lock calls cannot
 * deadlock. Duplicate ids collapse to one lock (non-reentrant).
 * @param accountIds - the accounts whose profiles are being accessed.
 * @param task - the exclusive operation.
 * @returns the task's result.
 */
export async function withProfileLocks<T>(accountIds: readonly string[], task: () => Promise<T>): Promise<T> {
  const keys = keysOf(accountIds)
  for (const key of keys) await acquire(key)
  try {
    return await task()
  } finally {
    for (const key of [...keys].reverse()) release(key)
  }
}

/**
 * Try to run `task` under several account profile locks without waiting:
 * either all keys are acquired (sorted order) or none are — a partially
 * acquired set is rolled back before returning `acquired: false`.
 * @param accountIds - the accounts whose profiles are being accessed.
 * @param task - the exclusive operation.
 * @returns the acquisition outcome and, when acquired, the task's result.
 */
export async function tryWithProfileLocks<T>(accountIds: readonly string[], task: () => Promise<T>): Promise<ProfileLockAttempt<T>> {
  const keys = keysOf(accountIds)
  const held: string[] = []
  for (const key of keys) {
    if (!tryAcquire(key)) {
      for (const key of held.reverse()) release(key)
      return { acquired: false, result: undefined }
    }
    held.push(key)
  }
  try {
    return { acquired: true, result: await task() }
  } finally {
    for (const key of held.reverse()) release(key)
  }
}

/**
 * Whether the account's profile lock is currently held. Diagnostics/tests
 * only: production code must not check-then-act on this (use the try variants).
 */
export function isProfileLocked(accountId: string): boolean {
  return locks.get(`profile:${accountId}`)?.busy === true
}

/**
 * Number of callers queued behind the account's profile lock. Diagnostics/tests
 * only — same check-then-act prohibition as {@link isProfileLocked}.
 */
export function profileLockWaiters(accountId: string): number {
  return locks.get(`profile:${accountId}`)?.waiters.length ?? 0
}
