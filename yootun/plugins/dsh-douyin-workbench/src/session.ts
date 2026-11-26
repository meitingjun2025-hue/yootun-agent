/**
 * 抖音创作者中心扫码登录与会话管理（移植旧 session.js 全语义 + 新仓库
 * AbortController 生命周期）：产品路径只有扫码——有头系统 Chrome 打开
 * creator.douyin.com，用户用抖音 App 扫页面上的码；代码只轮询上下文
 * sessionid/sessionid_ss Cookie，Cookie 命中必须经同源 user/info 探活读出
 * 账号标识才算登录（死 Cookie 不假成功的真机回归锁）。未传 accountId 用
 * pending- 占位；登录成功把 profile/storage_state/记录整体迁到真实账号。
 * probe 用本地 storage_state 无头实测；采集与登录共用一份系统 Chrome 最小
 * 启动参数。启动经 launchWithTimeout 受 Config.launchTimeoutMs 预算；context
 * 关闭经 closeContext 受 Config.browserCloseTimeoutMs 预算（挂起时告警并继续
 * finally 清理）。dispose 经 AbortSignal 中止登录并等待 settle（至多卸载预算）。
 * @module
 */
import type { BrowserContext, Browser, Page } from 'playwright-core'
import {
  DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS, LAUNCH_ARGS, browserCloseTimeoutMessage,
  closeContext, launchWithTimeout, resolveSystemChrome,
} from './chrome.ts'
import { normalizeAvatarUrl } from './avatar.ts'
import { safeCode, DouyinError } from './errors.ts'
import {
  bumpSessionSeqWith, clearLocalCredentials, ensureProfileDir, getAccount, hasStorageState,
  moveProfile, moveStorageState, paths, saveStorageState, stateRoot, type AccountRecord,
} from './state.ts'
import { tryWithProfileLocks, withProfileLock, withProfileLocks } from './locks.ts'

/** 浏览器关闭预算在调用链上的透传字段（Config.browserCloseTimeoutMs + 告警接缝）。 */
export interface BrowserCloseBudget {
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number | undefined
  /** 关闭超时告警（插件 logger；缺省不记录）。 */
  onBrowserCloseTimeout?: ((message: string) => void) | undefined
}

/** closeContext 的账号侧包装：预算缺省 {@linkcode DEFAULT_BROWSER_CLOSE_TIMEOUT_MS}。 */
function closeBudgeted(target: { close(): Promise<void> }, accountId: string, budget: BrowserCloseBudget): Promise<void> {
  return closeContext(target, budget.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, () => {
    budget.onBrowserCloseTimeout?.(browserCloseTimeoutMessage(accountId))
  })
}

/** launchWithTimeout 的预算读取（Config.launchTimeoutMs 透传；缺省 60s）。 */
function launchBudgetOf(launchTimeoutMs?: number | undefined): number {
  return launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
}

/** 创作者中心入口（登录与采集同源）。 */
export const CREATOR_ORIGIN = 'https://creator.douyin.com/'
/** 用户资料接口（页面上下文同源 fetch，浏览器自带签名）。 */
export const USER_INFO_PATH = '/web/api/media/user/info/'
/** 登录会话 Cookie 名（只记录名，不记录值，永不外发）。 */
export const SESSION_COOKIE_NAMES = ['sessionid', 'sessionid_ss'] as const
/** 占位账号 ID 前缀（登录期无法解析账号标识时的占位）。 */
export const PENDING_ACCOUNT_PREFIX = 'pending-'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const COOKIE_POLL_INTERVAL_MS = 2000
const VERIFY_INTERVAL_MS = 2500
const PROBE_TIMEOUT_MS = 45_000
const OPEN_TIMEOUT_MS = 60_000
const PROFILE_RETRY_ATTEMPTS = 4
const PROFILE_RETRY_DELAY_MS = 1200

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Race `promise` against a timeout, always clearing the timer once settled（输
 * 掉的 setTimeout 会把 event loop 挂到超时为止）; a rejection propagates
 * unchanged. `onTimeout()` runs inside a timer callback and must not throw.
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

/** 浏览器会话：持久化上下文（登录）或 storage_state 临时上下文（探测/采集）。 */
export interface LaunchedSession {
  context: BrowserContext
  /** 临时上下文模式下非空；close 时随 context 一并关闭。 */
  browser: Browser | null
  /** Close the context and any owning browser; errors swallowed by caller policy. */
  close(): Promise<void>
}

/** Chrome launcher seam（测试注入；生产实现见 {@link launchChromeSession}）。 */
export type ChromeFactory = (options: {
  headless: boolean
  profileDir: string
  /** 临时上下文模式的 storage_state 文件路径（缺失 = 持久化上下文模式）。 */
  storageStatePath?: string | undefined
  /** 临时上下文模式的页面 locale（采集固定 zh-CN）。 */
  locale?: string | undefined
  /** 临时上下文模式的时区（采集固定 Asia/Shanghai）。 */
  timezoneId?: string | undefined
  /** context.close 的等待预算毫秒（生产 close() 构造使用；fake factory 可忽略）。 */
  browserCloseTimeoutMs?: number | undefined
}) => Promise<LaunchedSession>

/**
 * Launch a system Chrome session（旧 chrome.js 口径）：登录为有头持久化上下文
 * （viewport 跟随窗口）；探测/采集为无头临时上下文（storage_state 注入，
 * viewport 1440×900）。不下载浏览器、不回退 Chromium、参数仅最小集合。返回的
 * `close()` 经 closeContext 受关闭预算约束（临时模式先 context 后 browser）。
 */
export async function launchChromeSession(options: {
  headless: boolean
  profileDir: string
  storageStatePath?: string | undefined
  locale?: string | undefined
  timezoneId?: string | undefined
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number | undefined
}): Promise<LaunchedSession> {
  const chrome = await resolveSystemChrome()
  const closeTimeoutMs = options.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS
  // 内层 close 的超时不告警：factory 只有 profileDir（本地路径不进日志），
  // 账号口径的告警由调用方的 closeBudgeted 外层施加。
  const closeTimedOut = (): void => undefined
  try {
    const { chromium } = await import('playwright-core')
    if (options.storageStatePath === undefined) {
      const context = await chromium.launchPersistentContext(options.profileDir, {
        headless: options.headless,
        channel: 'chrome',
        executablePath: chrome.path,
        args: [...LAUNCH_ARGS],
        viewport: null,
      })
      return { context, browser: null, close: () => closeContext(context, closeTimeoutMs, closeTimedOut) }
    }
    const browser = await chromium.launch({
      headless: options.headless,
      channel: 'chrome',
      executablePath: chrome.path,
      args: [...LAUNCH_ARGS],
    })
    const context = await browser.newContext({
      storageState: options.storageStatePath,
      viewport: { width: 1440, height: 900 },
      ...(options.locale !== undefined ? { locale: options.locale } : {}),
      ...(options.timezoneId !== undefined ? { timezoneId: options.timezoneId } : {}),
    })
    return {
      context,
      browser,
      close: async () => {
        await closeContext(context, closeTimeoutMs, closeTimedOut)
        await closeContext(browser, closeTimeoutMs, closeTimedOut)
      },
    }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'GOOGLE_CHROME_MISSING') throw error
    const missing = /Executable doesn't exist|playwright/iu.test(String(error))
    if (missing) throw new DouyinError('PLAYWRIGHT_DRIVER_MISSING', String(error))
    throw error
  }
}

/** 页面上下文同源 fetch 的统一结果（status 0 = 网络/签名层失败）。 */
export interface FetchOutcome {
  status: number
  text: string
  error?: string | undefined
}

/** 页面上下文同源 GET fetch 的最小页面面（Playwright Page 的结构化子集）。 */
export interface CollectorPage {
  evaluate(script: (arg: string) => Promise<FetchOutcome>, url: string): Promise<FetchOutcome>
}

/**
 * Wrap a real Playwright Page into the collector surface（闭包转发，无类型
 * 断言——Page.evaluate 的签名对 (fn, arg) 泛型可直接转发）。
 */
export function collectorPageOf(page: Page): CollectorPage {
  return {
    evaluate: (script, url) => page.evaluate(script, url),
  }
}

/**
 * 在页面上下文执行同源 fetch 读 JSON：由页面自身生成 msToken/a_bogus 签名
 * （设备端执行，tools 不直连抖音）。网络/解析失败统一折为 status 0。
 */
export async function evaluateJson(page: CollectorPage, url: string): Promise<{ status: number; json: unknown }> {
  const raw = await page.evaluate(async (target: string) => {
    try {
      const response = await fetch(target, { credentials: 'same-origin' })
      return { status: response.status, text: await response.text() }
    } catch (error: unknown) {
      return { status: 0, text: '', error: String(error) }
    }
  }, url)
  if (raw.status === 0 || raw.status >= 400) return { status: raw.status, json: null }
  try {
    return { status: raw.status, json: JSON.parse(raw.text) }
  } catch {
    return { status: raw.status, json: null }
  }
}

/** user/info 返回的用户对象字段兜底读取。 */
export interface DouyinProfile {
  accountId: string
  nickname: string | null
  avatar: string | null
  fanCount: number | null
}

/** 第一个非空字符串（有限数字转字符串）。 */
function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

/** 第一个非 undefined/null 值。 */
function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 有限数值或 null。 */
function numberOrNull(value: unknown): number | null {
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/**
 * Read the logged-in account's profile via the same-origin user/info API.
 * accountId 读不到直接返回 null（空对象 = 未登录/被风控，绝不猜测）。
 * @param page - collector surface bound to creator.douyin.com.
 * @returns the profile, or null when unreadable.
 */
export async function readAccountProfile(page: CollectorPage): Promise<DouyinProfile | null> {
  const outcome = await evaluateJson(page, CREATOR_ORIGIN.replace(/\/$/u, '') + USER_INFO_PATH)
  if (outcome.json === null || typeof outcome.json !== 'object') return null
  const payload = outcome.json as Record<string, unknown>
  const user = (payload.user ?? payload.data ?? payload) as Record<string, unknown>
  if (!user || typeof user !== 'object') return null
  const accountId = firstNonEmpty(user.sec_uid, user.secUid, user.uid, user.user_id, user.id)
  if (accountId === null) return null
  return {
    accountId,
    nickname: firstNonEmpty(user.nickname, user.name, user.nick_name),
    avatar: normalizeAvatarUrl(firstPresent(user.avatar_uri, user.avatar_url, user.avatarUrl, user.avatar)),
    fanCount: numberOrNull(firstPresent(user.follower_count, user.fans_count, user.fan_count, user.mplatform_followers_count)),
  }
}

/**
 * 登录瞬间 user/info 常未就绪：短间隔重试（消灭「账号永久挂 pending- 占位
 * ID」的最常见失败形态）；全部失败返回最后一次结果（可能 null）。
 */
export async function readAccountProfileWithRetry(page: CollectorPage, options: {
  attempts?: number
  delayMs?: number
  signal?: AbortSignal | undefined
} = {}): Promise<DouyinProfile | null> {
  const attempts = options.attempts ?? PROFILE_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? PROFILE_RETRY_DELAY_MS
  let last: DouyinProfile | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (options.signal?.aborted === true) return last
    last = await readAccountProfile(page)
    if (last !== null) return last
    await sleep(delayMs)
  }
  return last
}

/** waitForSessionCookie 的结果。 */
export interface CookieWaitResult {
  loggedIn: boolean
  cookieName: string | null
  profile: DouyinProfile | null
}

/**
 * 轮询上下文 Cookie + 同源 user/info 探活，直到读出账号标识或超时。verify 必
 * 传（登录流程）：Cookie 命中只说明「有 Cookie」——旧 Profile 残留的死 Cookie
 * 会秒假成功；探活读出 accountId 才算登录。探活失败继续轮询（等扫码换新
 * Cookie 或 SPA 就绪）。
 */
export async function waitForSessionCookie(context: BrowserContext, page: CollectorPage, options: {
  timeoutMs?: number
  intervalMs?: number
  verifyIntervalMs?: number
  now?: () => number
  signal?: AbortSignal | undefined
} = {}): Promise<CookieWaitResult> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? COOKIE_POLL_INTERVAL_MS
  const verifyIntervalMs = options.verifyIntervalMs ?? VERIFY_INTERVAL_MS
  const now = options.now ?? Date.now
  const signal = options.signal
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) return { loggedIn: false, cookieName: null, profile: null }
    const cookies = await context.cookies()
    const hit = cookies.find(item => (SESSION_COOKIE_NAMES as readonly string[]).includes(item.name) && item.value !== '')
    if (hit !== undefined) {
      let profile: DouyinProfile | null = null
      try {
        profile = await readAccountProfile(page)
      } catch (error: unknown) {
        // Cookie 命中但 user/info 未就绪：继续轮询。
        void error
        profile = null
      }
      if (profile !== null) return { loggedIn: true, cookieName: hit.name, profile }
    }
    if (now() >= deadline) return { loggedIn: false, cookieName: null, profile: null }
    await sleep(hit !== undefined ? verifyIntervalMs : intervalMs)
  }
}

/** 扫码登录结果。 */
export type LoginResult =
  | { status: 'ok'; accountId: string; profile: DouyinProfile | null }
  | { status: 'timeout' }
  | { status: 'failed'; reason: string }

/** Whether the id is a login-pending placeholder. */
export function isPendingAccountId(accountId: string): boolean {
  return typeof accountId === 'string' && accountId.startsWith(PENDING_ACCOUNT_PREFIX)
}

/**
 * 扫码登录全流程：一律先写 pending- 临时 Profile（不把登录态写进正式账号
 * 目录）；探活读出真实账号标识后才迁移。超时必须关有头窗口（否则窗口与进程
 * 滞留）；任何失败路径都清理临时 profile。Chrome 启动受 `launchTimeoutMs`
 * 预算（超时抛 BrowserLaunchTimeoutError，登录以 failed 收敛）；迟到的启动
 * 结果立即关闭并清理临时凭证（promise 交 trackCleanup 登记）。
 */
export async function loginWithQrCode(options: {
  accountId?: string
  root?: string
  timeoutMs?: number
  chromeFactory?: ChromeFactory | undefined
  onPage?: ((page: Page) => Promise<void> | void) | undefined
  signal?: AbortSignal | undefined
  /** 晚 factory 清理 promise（abort 后 close+二次清理）交给调用方任务登记；dispose 等待它。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
} & BrowserCloseBudget): Promise<LoginResult> {
  const root = options.root ?? stateRoot()
  const chromeFactory = options.chromeFactory ?? launchChromeSession
  const tempId = options.accountId !== undefined && options.accountId !== '' ? options.accountId : `pending-${String(Date.now())}`
  const profileDir = await ensureProfileDir(tempId, root)
  const signal = options.signal
  let session: LaunchedSession | null = null
  const closeTimeout = (target: { close(): Promise<void> }): Promise<void> => closeBudgeted(target, tempId, options)
  /** 在每个 await 点检查 abort（同步检查，窄化安全）。 */
  const checkAbort = (): void => {
    if (signal?.aborted === true) throw new DouyinError('login_failed', 'login_aborted')
  }
  try {
    checkAbort()
    // 捕获 factory promise（带启动预算）：abort 赢得 race 后 factory 晚 resolve
    // 时，context 可能在 abort 之后才创建/写入 pending-* profile——close 完成
    // 后必须再清一次临时凭证；启动超预算后迟到成功的结果同样立即关闭清理。
    const factoryPromise = launchWithTimeout(
      () => chromeFactory({
        headless: false,
        profileDir,
        ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
      }),
      launchBudgetOf(options.launchTimeoutMs),
      result => {
        // 迟到成功：close + 二次清理临时凭证；promise 在此同步交登记表（dispose 等待）。
        const cleanup = closeTimeout(result).then(async () => {
          await clearLocalCredentials(tempId, root).catch(() => undefined)
        }).catch(() => undefined)
        options.trackCleanup?.(cleanup)
        return cleanup
      },
    )
    const cleanupPromise = factoryPromise.then(async result => {
      if (signal?.aborted !== true) return
      await closeTimeout(result)
      await clearLocalCredentials(tempId, root).catch(() => undefined)
    }).catch(() => undefined)
    options.trackCleanup?.(cleanupPromise)
    let rejectLaunch: ((reason: Error) => void) | null = null
    const onLaunchAbort = (): void => { rejectLaunch?.(new DouyinError('login_failed', 'login_aborted')) }
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
      session = await launchOrAbort
    } finally {
      // race 结束即移除 listener：正常完成后不得继续挂在 signal 上。
      if (signal !== undefined) signal.removeEventListener('abort', onLaunchAbort)
    }
    const page = session.context.pages()[0] ?? await session.context.newPage()
    if (options.onPage !== undefined) await options.onPage(page)
    checkAbort()
    await page.goto(CREATOR_ORIGIN, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    checkAbort()
    const waited = await waitForSessionCookie(session.context, collectorPageOf(page), {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal,
    })
    if (!waited.loggedIn) {
      await closeTimeout(session)
      session = null
      await clearLocalCredentials(tempId, root).catch(() => undefined)
      return { status: 'timeout' }
    }
    checkAbort()
    const profile = waited.profile ?? await readAccountProfileWithRetry(collectorPageOf(page), { signal })
    checkAbort()
    const resolvedId = profile?.accountId !== undefined && profile.accountId !== '' ? profile.accountId : tempId
    await commitLoginIdentity({
      tempId,
      resolvedId,
      profile,
      context: session.context,
      root,
      ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
      ...(options.onBrowserCloseTimeout !== undefined ? { onBrowserCloseTimeout: options.onBrowserCloseTimeout } : {}),
    })
    session = null
    return { status: 'ok', accountId: resolvedId, profile }
  } catch (error) {
    if (session !== null) await closeTimeout(session)
    // 任何失败路径都清理临时 profile（正式账号未被创建，不留残留）。
    await clearLocalCredentials(tempId, root).catch(() => undefined)
    if (signal?.aborted === true) return { status: 'failed', reason: 'login_aborted' }
    return { status: 'failed', reason: safeCode(error) }
  }
}

/**
 * 登录成果提交（resolvedId 确定后的迁移临界区）：同时持有 tempId 与 resolvedId
 * 两把账号 profile 锁（排序获取防死锁），在锁内完成 storage_state 落盘（0600）、
 * context 关闭（受关闭预算约束）、profile 迁移到真实名下与序号/资料推进——与
 * realId 的 probe/collect/remove 严格串行。
 * @param options - tempId（登录期临时目录）、resolvedId（真实账号）、资料、
 *   仍打开着的登录 context 与状态根目录。
 */
export async function commitLoginIdentity(options: {
  tempId: string
  resolvedId: string
  profile: DouyinProfile | null
  context: BrowserContext
  root: string
} & BrowserCloseBudget): Promise<void> {
  const closeTimeout = (target: { close(): Promise<void> }): Promise<void> =>
    closeBudgeted(target, options.tempId, options)
  await withProfileLocks([options.tempId, options.resolvedId], async () => {
    if (options.profile === null) {
      // 探活未读出资料（罕见：verify 成功后重读也失败）：仍按 Cookie 命中提交，
      // 但不写 profile 字段，账号保持 pending- 语义由后续 probe 提升。
      await saveStorageState(options.tempId, options.context, options.root)
      await closeTimeout(options.context)
      return
    }
    await saveStorageState(options.resolvedId, options.context, options.root)
    await closeTimeout(options.context)
    if (options.resolvedId !== options.tempId) await moveProfile(options.tempId, options.resolvedId, options.root)
    const nowIso = new Date().toISOString()
    await bumpSessionSeqWith(options.resolvedId, {
      nickname: options.profile.nickname ?? undefined,
      avatar: options.profile.avatar ?? undefined,
      fanCount: options.profile.fanCount ?? undefined,
      sessionStatus: 'ok',
      sessionCheckedAt: nowIso,
      lastLoginAt: nowIso,
      vaultRef: paths(options.root).vaultRef(options.resolvedId),
    }, 0, options.root)
  })
}

/** 设备端会话探测结果（白名单投影：ok/expired/unknown + 细分原因）。 */
export interface ProbeResult {
  status: 'ok' | 'expired' | 'unknown'
  reason: string | null
  profile: DouyinProfile | null
  sessionSeq: number
  checkedAt: string
}

/**
 * 设备端会话探测：无 storage_state 直接 expired（不启动浏览器）；用本地
 * storage_state 无头打开创作者中心，同源 user/info 读出账号标识才算 ok
 * （旧 chrome.js 口径：探活与采集共用同一份最小启动参数避免指纹不一致）。
 * Chrome 启动受 `launchTimeoutMs` 预算；迟到的启动结果立即关闭（promise 交
 * trackCleanup 登记）。
 */
export async function probeSession(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
  /** 迟到启动结果清理 promise 的登记接缝（dispose 等待）。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
} & BrowserCloseBudget): Promise<ProbeResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const checkedAt = new Date().toISOString()
  const record = await getAccount(accountId, root).catch(() => undefined)
  const sessionSeq = Number(record?.sessionSeq ?? 0)
  if (!(await hasStorageState(accountId, root))) {
    return { status: 'expired', reason: 'storage_state_missing', profile: null, sessionSeq, checkedAt }
  }
  const chromeFactory = options.chromeFactory ?? launchChromeSession
  const profileDir = await ensureProfileDir(accountId, root)
  const closeTimeout = (target: { close(): Promise<void> }): Promise<void> => closeBudgeted(target, accountId, options)
  let session: LaunchedSession | null = null
  try {
    session = await launchWithTimeout(
      () => chromeFactory({
        headless: true,
        profileDir,
        storageStatePath: paths(root).storageStatePath(accountId),
        ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
      }),
      launchBudgetOf(options.launchTimeoutMs),
      result => {
        // 迟到成功：立即关闭（探测已按超时失败返回）；promise 同步交登记表。
        const cleanup = closeTimeout(result).catch(() => undefined)
        options.trackCleanup?.(cleanup)
        return cleanup
      },
    )
    const page = session.context.pages()[0] ?? await session.context.newPage()
    await page.goto(CREATOR_ORIGIN, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS })
    const outcome = await raceWithTimeout(
      readAccountProfile(collectorPageOf(page)).then(profile => ({ profile, error: null as string | null })).catch((error: unknown) => ({ profile: null, error: safeCode(error) })),
      PROBE_TIMEOUT_MS,
      () => ({ profile: null, error: 'probe_failed' }),
    )
    if (outcome.profile === null) {
      await closeTimeout(session)
      session = null
      return { status: 'expired', reason: outcome.error ?? 'user_info_unavailable', profile: null, sessionSeq, checkedAt }
    }
    // 探活成功后落盘刷新 storage_state（会话续期；0600；上下文仍打开）。
    await saveStorageState(accountId, session.context, root)
    await closeTimeout(session)
    session = null
    if (outcome.profile.accountId !== accountId) {
      return { status: 'expired', reason: 'account_mismatch', profile: outcome.profile, sessionSeq, checkedAt }
    }
    return { status: 'ok', reason: null, profile: outcome.profile, sessionSeq, checkedAt }
  } catch (error) {
    if (session !== null) await closeTimeout(session)
    const code = (error as { code?: unknown }).code
    if (code === 'GOOGLE_CHROME_MISSING' || code === 'PLAYWRIGHT_DRIVER_MISSING' || (error instanceof Error && error.name === 'BrowserLaunchTimeoutError')) {
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
  profile: DouyinProfile | null
}

/**
 * Probe + persist：ok → bumpSessionSeqWith(ok)；expired → bumpSessionSeqWith(expired)；
 * unknown 只更新 checkedAt 不改状态。每次探测消耗一个新序号（旧 session.js
 * refreshSessionState 口径）。不加锁：账号锁由调用方持有（handler 级 probe
 * 包锁；采集全程持锁时经本函数直接探测，嵌套加锁会死锁）。
 */
export async function refreshSessionState(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
  /** 登录链路取消：探测前后检查（浏览器路径本身不受 signal 影响）。 */
  signal?: AbortSignal | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
  /** 迟到启动结果清理 promise 的登记接缝（透传 probeSession）。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
} & BrowserCloseBudget): Promise<RefreshedSession> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  // abort 检查走函数边界（第二次在 await 之后；const 收窄不跨 await）。
  const aborted = (): boolean => options.signal?.aborted === true
  if (aborted()) throw new DouyinError('login_aborted', 'login_aborted')
  const probe = await probeSession({
    accountId,
    root,
    chromeFactory: options.chromeFactory,
    ...(options.launchTimeoutMs !== undefined ? { launchTimeoutMs: options.launchTimeoutMs } : {}),
    ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
    ...(options.onBrowserCloseTimeout !== undefined ? { onBrowserCloseTimeout: options.onBrowserCloseTimeout } : {}),
    ...(options.trackCleanup !== undefined ? { trackCleanup: options.trackCleanup } : {}),
  })
  if (aborted()) throw new DouyinError('login_aborted', 'login_aborted')
  const vaultRef = paths(root).vaultRef(accountId)
  const nowIso = new Date().toISOString()
  if (probe.status === 'ok') {
    const { record, seq } = await bumpSessionSeqWith(accountId, {
      sessionStatus: 'ok',
      sessionCheckedAt: nowIso,
      nickname: probe.profile?.nickname ?? undefined,
      avatar: probe.profile?.avatar ?? undefined,
      fanCount: probe.profile?.fanCount ?? undefined,
      vaultRef,
    }, probe.sessionSeq, root)
    void record
    return { sessionStatus: 'ok', reason: null, sessionSeq: seq, checkedAt: nowIso, vaultRef, accountId, profile: probe.profile }
  }
  if (probe.status === 'expired') {
    const { seq } = await bumpSessionSeqWith(accountId, {
      sessionStatus: 'expired',
      sessionCheckedAt: nowIso,
      vaultRef,
    }, probe.sessionSeq, root)
    return { sessionStatus: 'expired', reason: probe.reason, sessionSeq: seq, checkedAt: nowIso, vaultRef, accountId, profile: probe.profile }
  }
  const { seq } = await bumpSessionSeqWith(accountId, { sessionCheckedAt: nowIso, vaultRef }, probe.sessionSeq, root)
  return { sessionStatus: 'unknown', reason: probe.reason, sessionSeq: seq, checkedAt: nowIso, vaultRef, accountId, profile: probe.profile }
}

/** promotePendingAccount 的结果（promoted=false 时 reason 说明稳定原因）。 */
export type PromoteResult = {
  promoted: boolean
  accountId: string
  fromAccountId?: string
  reason?: string
  profile?: DouyinProfile
  record?: AccountRecord
}

/**
 * 占位账号提升（两阶段锁）：阶段 1 持 pending 锁探测出真实 id；阶段 2 以 try
 * 语义同时锁 pending + realId（排序获取防死锁），realId 正被 collect/probe/
 * remove 使用时立即返回 collect_busy，绝不排队等长采集。迁移顺序固定「先迁
 * 文件再迁记录」（中途失败时本地记录仍指向旧 ID）；序号取两侧最大值保持单调。
 */
export async function promotePendingAccount(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
  /** 迟到启动结果清理 promise 的登记接缝（透传 probeSession）。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
} & BrowserCloseBudget): Promise<PromoteResult> {
  const { accountId } = options
  const root = options.root ?? stateRoot()
  if (!isPendingAccountId(accountId)) return { promoted: false, accountId, reason: 'not_pending' }
  const probe = await withProfileLock(accountId, () =>
    probeSession({
      accountId,
      root,
      chromeFactory: options.chromeFactory,
      ...(options.launchTimeoutMs !== undefined ? { launchTimeoutMs: options.launchTimeoutMs } : {}),
      ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
      ...(options.onBrowserCloseTimeout !== undefined ? { onBrowserCloseTimeout: options.onBrowserCloseTimeout } : {}),
      ...(options.trackCleanup !== undefined ? { trackCleanup: options.trackCleanup } : {}),
    })).catch((error: unknown) => ({
    status: 'unknown' as const, reason: safeCode(error), profile: null as DouyinProfile | null, sessionSeq: 0, checkedAt: new Date().toISOString(),
  }))
  const probeProfile = probe.profile
  // pending 账号的 storage 身份是登录期未能解析的占位：探活读出真实身份时
  // probeSession 以 account_mismatch 拒绝——这正是 promote 要接手的迁移场景。
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
    const fanCount = [probeProfile.fanCount, existing?.fanCount, previous?.fanCount].find((value): value is number => typeof value === 'number' && Number.isFinite(value))
    const { record } = await bumpSessionSeqWith(realId, {
      sessionStatus: 'ok',
      sessionCheckedAt: new Date().toISOString(),
      promotedFrom: accountId,
      nickname: probeProfile.nickname ?? existing?.nickname ?? previous?.nickname ?? undefined,
      avatar: probeProfile.avatar ?? existing?.avatar ?? previous?.avatar ?? undefined,
      ...(fanCount !== undefined ? { fanCount } : {}),
      lastLoginAt: previous?.lastLoginAt,
      vaultRef: paths(root).vaultRef(realId),
    }, floorSeq, root)
    await clearLocalCredentials(accountId, root)
    return { promoted: true, accountId: realId, fromAccountId: accountId, profile: probeProfile, record }
  })
  if (!attempt.acquired) return { promoted: false, accountId, reason: 'collect_busy' }
  return attempt.result
}

/** removeLocal：本地凭证与 profile 清理（远端删除的前置步骤；双清理成功才算 removed）。 */
export async function removeLocalAccount(options: { accountId: string; root?: string }): Promise<{ removed: boolean }> {
  const root = options.root ?? stateRoot()
  const cleared = await clearLocalCredentials(options.accountId, root)
  return { removed: cleared.profile && cleared.storageState }
}
