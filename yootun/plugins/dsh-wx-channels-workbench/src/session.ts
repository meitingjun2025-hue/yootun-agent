/**
 * 视频号助手扫码登录与会话管理（移植旧 session.js 全语义）：产品路径只有扫码
 * ——有头系统 Chrome → 打开助手页 → 微信扫码确认 → 轮询 Cookie + 页面
 * auth_data 真正读出 finderUsername 才算登录（Cookie 命中≠会话有效）；连续
 * 3 次相同身份才算选完（多视频号串号修复）；无 Cookie 粘贴入口、无反检测参数。
 * @module
 */
import type { BrowserContext, Page } from 'playwright-core'
import { LAUNCH_ARGS, resolveSystemChrome } from './chrome.ts'
import type { CollectorPage } from './collector.ts'
import { ASSISTANT_ORIGIN, fetchAuthData } from './collector.ts'
import { SessionInvalidError } from './parse.ts'
import { safeCode, WxError } from './errors.ts'
import type { AuthProfile } from './parse.ts'
export { WxError }
import {
  bumpSessionSeqWith, clearLocalCredentials, ensureProfileDir, getAccount, hasStorageState,
  moveProfile, moveStorageState, paths, saveStorageState, stateRoot, type AccountRecord,
} from './state.ts'
import { tryWithProfileLocks, withProfileLock, withProfileLocks } from './locks.ts'

/** 登录会话 Cookie 名（只记录名，不记录值，永不外发）。 */
export const SESSION_COOKIE_NAMES = ['sessionid', 'wxuin']
/** 占位账号 ID 前缀（登录期无法解析 finderUsername 时的占位）。 */
export const PENDING_ACCOUNT_PREFIX = 'pending-'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const COOKIE_POLL_INTERVAL_MS = 2000
// 身份稳定等待：同一微信多视频号时，扫码后官方页面才出现身份选择；连续读到
// 同一身份才算用户选完（约 6 秒窗口，留足用户在官方页面点击的时间）。
const IDENTITY_STABLE_ATTEMPTS = 8
const IDENTITY_STABLE_INTERVAL_MS = 2000
const IDENTITY_STABLE_REQUIRED = 3
const PROBE_TIMEOUT_MS = 45_000
const OPEN_TIMEOUT_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Race `promise` against a timeout, always clearing the timer once settled:
 * when the promise finishes first, no `Timeout` stays active behind it（输掉的
 * setTimeout 会把进程/event loop 挂到超时为止）; when the timer wins, deliver
 * `onTimeout()`'s result; a rejection propagates unchanged. Deliberately no
 * `unref()` —— 修复手段是清掉 timer，不是把它从 event loop 摘除。
 * @param promise - the operation to await.
 * @param timeoutMs - the timeout budget in milliseconds.
 * @param onTimeout - builds the timeout outcome (same type as the promise);
 *   it runs inside a timer callback, so it must not throw（同步抛出会绕过本函数
 *   的 try，成为 uncaughtException 而非 rejection）.
 * @returns the promise's outcome, or `onTimeout()` on timeout.
 */
export async function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<T>(resolve => { timer = setTimeout(() => resolve(onTimeout()), timeoutMs) })
  // promise 输掉 race 之后才 reject 时，拒绝必须被旁路消费，否则成为
  // unhandled rejection；race 本身看到的仍是原 promise，语义不变。
  promise.catch(() => undefined)
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timer)
  }
}

/** Playwright Page 满足采集器的最小页面面（结构化兼容）。 */
export function asCollectorPage(page: Page): CollectorPage {
  return page as unknown as CollectorPage
}

/** Chrome launcher seam（测试注入）。 */
export interface ChromeFactoryResult {
  context: BrowserContext
}
export type ChromeFactory = (options: { headless: boolean; profileDir: string }) => Promise<ChromeFactoryResult>

/**
 * Launch a headed/headless system Chrome with the account's persistent profile.
 * @param options - headless flag + profile dir.
 * @returns the launched persistent context.
 * @throws {ChromeMissingError} no system Chrome.
 */
export async function launchChrome(options: { headless: boolean; profileDir: string }): Promise<ChromeFactoryResult> {
  const chrome = await resolveSystemChrome()
  try {
    const { chromium } = await import('playwright-core')
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      channel: 'chrome',
      executablePath: chrome.path,
      args: [...LAUNCH_ARGS],
      viewport: null,
    })
    return { context }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'GOOGLE_CHROME_MISSING') throw error
    const missing = /Executable doesn't exist|playwright/iu.test(String(error))
    if (missing) throw new WxError('PLAYWRIGHT_DRIVER_MISSING', String(error))
    throw error
  }
}

/** waitForSessionCookie 的结果。 */
export interface CookieWaitResult {
  loggedIn: boolean
  cookieName: string | null
  profile?: AuthProfile | undefined
}

/**
 * 轮询上下文 Cookie + 页面 auth_data 探活，直到读出账号资料或超时。verify 必传
 * （登录流程）：Cookie 命中只说明「有 Cookie」——旧 Profile 残留的失效 Cookie 会
 * 秒假成功；探活读出 finderUsername 才算登录。
 */
export async function waitForSessionCookie(context: BrowserContext, page: Page, options: {
  timeoutMs?: number
  intervalMs?: number
  verifyIntervalMs?: number
  now?: () => number
  signal?: AbortSignal | undefined
} = {}): Promise<CookieWaitResult> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? COOKIE_POLL_INTERVAL_MS
  const verifyIntervalMs = Math.max(2500, intervalMs)
  const now = options.now ?? Date.now
  const signal = options.signal
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) return { loggedIn: false, cookieName: null }
    const cookies = await context.cookies()
    const hit = cookies.find(item => SESSION_COOKIE_NAMES.includes(item.name) && item.value)
    if (hit) {
      let profile: AuthProfile | null = null
      try {
        profile = await fetchAuthData(asCollectorPage(page))
      } catch (error: unknown) {
        // Cookie 命中但 auth_data 未就绪：继续轮询。
        void error
        profile = null
      }
      if (profile && profile.accountId) return { loggedIn: true, cookieName: hit.name, profile }
    }
    if (now() >= deadline) return { loggedIn: false, cookieName: null }
    await sleep(hit ? verifyIntervalMs : intervalMs)
  }
}

/**
 * 等待官方页面上的视频号身份选择稳定（多视频号串号根因）：身份不在 cookie 里，
 * 由官方页面选择态决定；auth_data 首次可读返回默认/上次身份。连续 3 次相同才算
 * 「用户已选完」；身份变化则以新身份重新计数。
 * @returns the stable profile, or null when the poll budget ran out.
 */
export async function waitStableIdentity(page: Page, firstProfile: AuthProfile, signal?: AbortSignal | undefined): Promise<AuthProfile | null> {
  let current = firstProfile
  let streak = 1
  const isAborted = (): boolean => signal !== undefined && signal.aborted
  for (let attempt = 1; attempt < IDENTITY_STABLE_ATTEMPTS; attempt += 1) {
    if (isAborted()) return null
    await sleep(IDENTITY_STABLE_INTERVAL_MS)
    if (isAborted()) return null
    let profile: AuthProfile | null = null
    try {
      profile = await fetchAuthData(page)
    } catch (error: unknown) {
      // SPA 未就绪：交由重试逻辑。
      void error
      profile = null
    }
    if (profile && profile.accountId === current.accountId) {
      streak += 1
      if (streak >= IDENTITY_STABLE_REQUIRED) return current
    } else if (profile) {
      current = profile
      streak = 1
    }
  }
  return null
}

/** 扫码登录结果。 */
export type LoginResult =
  | { status: 'ok'; accountId: string; profile: AuthProfile | null }
  | { status: 'timeout' }
  | { status: 'failed'; reason: string }

/**
 * 扫码登录全流程：一律先写临时 Profile（P2-11：不把登录态写进正式账号目录）；
 * 身份稳定后才 resolve 真实账号 id；storage_state 0600 落盘；profile 迁移到
 * 真实名下；seq 与资料同锁定序。
 */
export async function loginWithQrCode(options: {
  accountId?: string
  root?: string
  timeoutMs?: number
  chromeFactory?: ChromeFactory
  onPage?: ((page: Page) => Promise<void> | void) | undefined
  signal?: AbortSignal | undefined
}): Promise<LoginResult> {
  const root = options.root ?? stateRoot()
  const chromeFactory = options.chromeFactory ?? launchChrome
  const tempId = `pending-${String(Date.now())}`
  const profileDir = await ensureProfileDir(tempId, root)
  const signal = options.signal
  let context: BrowserContext | null = null
  /** 在每个 await 点检查 abort（同步检查，窄化安全）。 */
  const checkAbort = (): void => {
    if (signal?.aborted === true) throw new Error('login_aborted')
  }
  try {
    checkAbort()
    // 捕获 factory promise：abort 赢得 race 后 factory 晚 resolve 时，context 可能在
    // abort 之后才创建/写入 pending-* profile——close 完成后必须再清一次临时凭证
    // （主 catch 的清理可能发生在 factory 创建目录之前）。
    const factoryPromise = chromeFactory({ headless: false, profileDir })
    void factoryPromise.then(async result => {
      if (signal?.aborted !== true) return
      await result.context.close().catch(() => undefined)
      await clearLocalCredentials(tempId, root).catch(() => undefined)
    }).catch(() => undefined)
    let rejectLaunch: ((reason: Error) => void) | null = null
    const onLaunchAbort = (): void => { rejectLaunch?.(new Error('login_aborted')) }
    const launchOrAbort = signal !== undefined
      ? Promise.race([
          factoryPromise,
          new Promise<never>((_, reject) => {
            rejectLaunch = reject
            signal.addEventListener('abort', onLaunchAbort, { once: true })
          }),
        ])
      : factoryPromise
    try {
      ;({ context } = await launchOrAbort)
    } finally {
      // race 结束即移除 listener：正常完成后不得继续挂在 signal 上。
      if (signal !== undefined) signal.removeEventListener('abort', onLaunchAbort)
    }
    const page = context.pages()[0] ?? await context.newPage()
    if (options.onPage !== undefined) await options.onPage(page)
    checkAbort()
    await page.goto(ASSISTANT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    checkAbort()
    // 轮询 Cookie + auth_data（传 signal 以便 abort 时跳出）。
    const waited = await waitForSessionCookie(context, page, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal,
    })
    if (!waited.loggedIn) {
      await context.close().catch(() => undefined)
      await clearLocalCredentials(tempId, root).catch(() => undefined)
      return { status: 'timeout' }
    }
    checkAbort()
    const firstProfile = waited.profile ?? await readAccountProfileWithRetry(page)
    checkAbort()
    const stableIdentity = await waitStableIdentity(page, firstProfile, signal)
    if (!stableIdentity) {
      await context.close().catch(() => undefined)
      await clearLocalCredentials(tempId, root).catch(() => undefined)
      return { status: 'failed', reason: 'identity_not_stable' }
    }
    checkAbort()
    const profile = stableIdentity
    const resolvedId = profile.accountId || tempId
    await commitLoginIdentity({ tempId, resolvedId, profile, context, root })
    context = null
    return { status: 'ok', accountId: resolvedId, profile }
  } catch (error) {
    if (context !== null) await context.close().catch(() => undefined)
    // 任何失败路径都清理临时 profile（正式账号未被创建，不留残留）。
    await clearLocalCredentials(tempId, root).catch(() => undefined)
    if (signal?.aborted === true) return { status: 'failed', reason: 'login_aborted' }
    const reason = safeCode(error)
    return { status: 'failed', reason: reason === 'WX_TOOL_UNAVAILABLE' ? 'login_failed' : reason }
  }
}

/**
 * 登录成果提交（resolvedId 确定后的迁移临界区）：同时持有 tempId 与 resolvedId
 * 两把账号 profile 锁（排序获取防死锁），在锁内完成 storage_state 落盘（0600）、
 * context 关闭、profile 迁移到真实名下与 seq 推进——与 realId 的
 * probe/collect/remove/promote 严格串行，迁移期间它们不可能并发使用 profile。
 * 失败时异常向调用方传播（loginWithQrCode 统一清理 tempId，永不触碰 realId）。
 * @param options - tempId（登录期临时目录）、resolvedId（真实账号）、身份资料、
 *   仍打开着的登录 context 与状态根目录。
 * @returns the resolved account id.
 */
export async function commitLoginIdentity(options: {
  tempId: string
  resolvedId: string
  profile: AuthProfile
  context: BrowserContext
  root: string
}): Promise<{ accountId: string }> {
  const profile = options.profile
  await withProfileLocks([options.tempId, options.resolvedId], async () => {
    await saveStorageState(options.resolvedId, options.context, options.root)
    await options.context.close()
    if (options.resolvedId !== options.tempId) await moveProfile(options.tempId, options.resolvedId, options.root)
    await bumpSessionSeqWith(options.resolvedId, {
      nickname: profile.nickname ?? undefined,
      avatar: profile.avatar ?? undefined,
      followerTotalCount: profile.fansCount ?? undefined,
      feedCount: profile.feedsCount ?? undefined,
      isMasterFinder: profile.isMasterFinder ?? undefined,
      sessionStatus: 'ok',
      sessionCheckedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    }, 0, options.root)
  })
  return { accountId: options.resolvedId }
}

/** 登录期没能解析出 finderUsername 时重读资料（官方 SPA 未就绪会短暂失败）。 */
export async function readAccountProfileWithRetry(page: Page, options: { attempts?: number; delayMs?: number } = {}): Promise<AuthProfile> {
  const attempts = options.attempts ?? 4
  const delayMs = options.delayMs ?? 1200
  let lastError: unknown = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetchAuthData(asCollectorPage(page))
    } catch (error) {
      lastError = error
      await sleep(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('profile_unavailable')
}

/** Whether the id is a login-pending placeholder. */
export function isPendingAccountId(accountId: string): boolean {
  return typeof accountId === 'string' && accountId.startsWith(PENDING_ACCOUNT_PREFIX)
}

/** 设备端会话探测结果（白名单投影：ok/expired/unknown + 细分原因）。 */
export interface ProbeResult {
  status: 'ok' | 'expired' | 'unknown'
  reason: string | null
  profile: AuthProfile | null
  sessionSeq: number
  checkedAt: string
}

/**
 * 设备端会话探测：用本地 storage_state 无头访问助手页，auth_data 读出
 * finderUsername 且与 accountId 一致才算 ok（身份不一致 = account_mismatch，
 * 绝不放行——串号防线）。
 */
export async function probeSession(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
}): Promise<ProbeResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const checkedAt = new Date().toISOString()
  const record = await getAccount(accountId, root).catch(() => undefined)
  const sessionSeq = Number(record?.sessionSeq ?? 0)
  if (!(await hasStorageState(accountId, root))) {
    return { status: 'expired', reason: 'storage_state_missing', profile: null, sessionSeq, checkedAt }
  }
  const chromeFactory = options.chromeFactory ?? launchChrome
  const profileDir = await ensureProfileDir(accountId, root)
  let context: BrowserContext | null = null
  try {
    ;({ context } = await chromeFactory({ headless: true, profileDir }))
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(ASSISTANT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS })
    const probe = await raceWithTimeout(
      fetchAuthData(asCollectorPage(page)).then(profile => ({ profile, error: null as string | null })).catch((error: unknown) => ({ profile: null, error: error instanceof SessionInvalidError ? (error.reason || 'session_invalid') : 'auth_data_unavailable' })),
      PROBE_TIMEOUT_MS,
      () => ({ profile: null, error: 'auth_data_unavailable' }),
    )
    // storage_state 探活后落盘刷新（会话续期；0600）。
    if (probe.profile !== null) await saveStorageState(accountId, context, root)
    await context.close().catch(() => undefined)
    context = null
    if (probe.profile === null) {
      return { status: 'expired', reason: probe.error ?? 'auth_data_unavailable', profile: null, sessionSeq, checkedAt }
    }
    if (probe.profile.accountId !== accountId) {
      return { status: 'expired', reason: 'account_mismatch', profile: probe.profile, sessionSeq, checkedAt }
    }
    return { status: 'ok', reason: null, profile: probe.profile, sessionSeq, checkedAt }
  } catch (error) {
    if (context !== null) await context.close().catch(() => undefined)
    const code = (error as { code?: unknown }).code
    if (code === 'GOOGLE_CHROME_MISSING' || code === 'PLAYWRIGHT_DRIVER_MISSING') {
      return { status: 'unknown', reason: safeCode(error), profile: null, sessionSeq, checkedAt }
    }
    return { status: 'unknown', reason: 'probe_failed', profile: null, sessionSeq, checkedAt }
  }
}

/** refreshSessionState 投影：探测 + 本地记录更新（sessionStatus/checkedAt/seq）。 */
export interface RefreshedSession {
  sessionStatus: 'ok' | 'expired' | 'unknown'
  reason: string | null
  sessionSeq: number
  checkedAt: string
  vaultRef: string
  accountId: string
  sessionStatusReported: boolean
}

/**
 * Probe + persist: ok → markSessionOk；expired → markSessionExpired；unknown 只
 * 更新 checkedAt 不改状态。
 * @param options - account id + root + chrome factory.
 * @returns the refreshed whitelisted state.
 */
export async function refreshSessionState(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
}): Promise<RefreshedSession> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const probe = await probeSession({ accountId, root, chromeFactory: options.chromeFactory })
  const vaultRef = paths(root).vaultRef(accountId)
  if (probe.status === 'ok') {
    const { seq } = await bumpSessionSeqWith(accountId, {
      sessionStatus: 'ok',
      sessionCheckedAt: probe.checkedAt,
      nickname: probe.profile?.nickname ?? undefined,
      avatar: probe.profile?.avatar ?? undefined,
    }, probe.sessionSeq, root)
    return { sessionStatus: 'ok', reason: null, sessionSeq: seq, checkedAt: probe.checkedAt, vaultRef, accountId, sessionStatusReported: false }
  }
  if (probe.status === 'expired') {
    await bumpSessionSeqWith(accountId, {
      sessionStatus: 'expired',
      sessionCheckedAt: probe.checkedAt,
    }, probe.sessionSeq, root)
    return { sessionStatus: 'expired', reason: probe.reason, sessionSeq: probe.sessionSeq, checkedAt: probe.checkedAt, vaultRef, accountId, sessionStatusReported: false }
  }
  await bumpSessionSeqWith(accountId, { sessionCheckedAt: probe.checkedAt }, probe.sessionSeq, root)
  return { sessionStatus: 'unknown', reason: probe.reason, sessionSeq: probe.sessionSeq, checkedAt: probe.checkedAt, vaultRef, accountId, sessionStatusReported: false }
}

/** promotePendingAccount 的结果（promoted=false 时 reason 说明稳定原因）。 */
export type PromoteResult = {
  promoted: boolean
  accountId: string
  fromAccountId?: string
  reason?: string
  profile?: AuthProfile
  record?: AccountRecord
}

/**
 * 占位账号提升（两阶段锁）：阶段 1 持 pending 锁探测出真实 id（pending 不参与
 * collect，等待者只有同类 probe/promote，等待语义不会长挂）；阶段 2 以 try 语义
 * 同时锁 pending + realId（排序获取防死锁），realId 正被 collect/probe/remove
 * 使用时立即返回 collect_busy，绝不排队等长采集，也不执行任何迁移。阶段 1 释放
 * pending 锁后状态可能已变，迁移前重新核对 storage_state 仍在。
 */
export async function promotePendingAccount(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
}): Promise<PromoteResult> {
  const { accountId } = options
  const root = options.root ?? stateRoot()
  if (!isPendingAccountId(accountId)) return { promoted: false, accountId, reason: 'not_pending' }
  const probe = await withProfileLock(accountId, () =>
    probeSession({ accountId, root, chromeFactory: options.chromeFactory }),
  ).catch((error: unknown) => ({
    status: 'unknown' as const, reason: safeCode(error), profile: null as AuthProfile | null, sessionSeq: 0, checkedAt: new Date().toISOString(),
  }))
  const probeProfile = probe.profile
  // pending 账号的 storage 身份是登录期未能解析的占位：探活读出真实身份时
  // probeSession 以 account_mismatch 拒绝（串号防线）——这正是 promote 要接手的
  // 迁移场景；其余失败（profile 读不出）原样返回。
  if (probeProfile === null) {
    return { promoted: false, accountId, reason: probe.reason ?? 'profile_unavailable' }
  }
  const realId = probeProfile.accountId
  if (realId === accountId) {
    return { promoted: false, accountId, reason: probe.status === 'ok' ? 'already_resolved' : probe.reason ?? 'profile_unavailable' }
  }
  const attempt = await tryWithProfileLocks([accountId, realId], async (): Promise<PromoteResult> => {
    if (!(await hasStorageState(accountId, root))) {
      return { promoted: false, accountId, reason: 'storage_state_missing' }
    }
    const previous = await getAccount(accountId, root)
    const existing = await getAccount(realId, root)
    await moveStorageState(accountId, realId, root)
    await moveProfile(accountId, realId, root)
    const floorSeq = Math.max(Number(previous?.sessionSeq ?? 0), Number(existing?.sessionSeq ?? 0))
    const { record } = await bumpSessionSeqWith(realId, {
      sessionStatus: 'ok',
      sessionCheckedAt: new Date().toISOString(),
      promotedFrom: accountId,
      nickname: probeProfile.nickname ?? existing?.nickname ?? previous?.nickname ?? undefined,
      avatar: probeProfile.avatar ?? existing?.avatar ?? previous?.avatar ?? undefined,
      followerTotalCount: probeProfile.fansCount ?? existing?.followerTotalCount ?? previous?.followerTotalCount ?? undefined,
      feedCount: probeProfile.feedsCount ?? existing?.feedCount ?? previous?.feedCount ?? undefined,
      lastLoginAt: previous?.lastLoginAt,
    }, floorSeq, root)
    await clearLocalCredentials(accountId, root)
    return { promoted: true, accountId: realId, fromAccountId: accountId, profile: probeProfile, record }
  })
  if (!attempt.acquired) return { promoted: false, accountId, reason: 'collect_busy' }
  return attempt.result
}

/** removeLocal：本地凭证与 profile 清理（远端删除的前置步骤）。 */
export async function removeLocalAccount(options: { accountId: string; root?: string }): Promise<{ removed: boolean }> {
  const root = options.root ?? stateRoot()
  await clearLocalCredentials(options.accountId, root)
  return { removed: !(await hasStorageState(options.accountId, root)) }
}

/** AccountRecord 增强（promote 携带 promotedFrom/lastLoginAt 等）。 */
export type WxAccountRecord = AccountRecord
