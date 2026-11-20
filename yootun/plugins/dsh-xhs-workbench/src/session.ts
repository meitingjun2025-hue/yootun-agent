/**
 * 小红书创作者中心扫码登录、会话探测与本地账号管理（迁移旧 session.js 全语义）。
 * 产品路径只有扫码：有头系统 Chrome → 打开 creator.xiaohongshu.com/login →
 * 用小红书 App 扫码 → 轮询创作平台会话 Cookie → 保存 storage_state 备份到设备端。
 * 无 Cookie 粘贴入口、无 Cookie 外发、无 stealth/反检测参数（红线）。
 *
 * 会话绑定持久 Profile：登录/探测/采集共用同一账号 Profile 目录，Cookie 原生
 * 存于 Profile 内，storage_state 仅作备份/迁移介质。验证码策略（红线）：出现
 * 验证码/安全验证 → 该任务置 failed（CAPTCHA_DETECTED），绝不自动绕过。
 * @module
 */
import { launchChrome, type ChromeFactory } from './chrome.ts'
import { ChromeMissingError } from './chrome-probe.ts'
import { safeCode } from './errors.ts'
import {
  clearLocalCredentials, ensureProfileDir, getAccount, hasStorageState, moveProfile,
  moveStorageState, nextSessionSeq, saveStorageState, stateRoot, updateAccount,
  type StorageStateSource,
} from './state.ts'

/** 创作者中心 origin 与登录页。 */
export const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com/'
export const LOGIN_URL = `${CREATOR_ORIGIN}login`
/** 创作平台登录成功信号 Cookie 名（只记录名，不记录值，永不外发）。 */
export const SESSION_COOKIE_NAMES = [
  'customerClientId',
  'galaxy_creator_session_id',
  'access-token-creator.xiaohongshu.com',
  'customer-sso-sid',
]
/** 账号基本资料接口（页面上下文同源 fetch，免签名）。 */
export const USER_INFO_PATH = '/api/galaxy/user/info'
/** 登录框可见性探测选择器（失效特征）。 */
export const LOGIN_BOX_SELECTOR = 'div[class*="login-box"]'
/** 验证码特征选择器（redcaptcha 弹窗；出现即 CAPTCHA_DETECTED，绝不绕过）。 */
export const CAPTCHA_SELECTOR = '[class*="redcaptcha"], iframe[src*="redcaptcha"], iframe[src*="captcha"]'

/** 扫码等待上限 10 分钟（业务员找手机扫码可能较慢，旧口径）。 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
export const COOKIE_POLL_INTERVAL_MS = 2000
export const PROBE_TIMEOUT_MS = 45_000
export const OPEN_TIMEOUT_MS = 60_000

/** 登录期没能解析出账号 ID 时使用的占位账号 ID 前缀。 */
export const PENDING_ACCOUNT_PREFIX = 'pending-'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 登录/探测/采集触达的最小 playwright Page 子集（结构化兼容，测试可造 fake）。 */
export interface XhsPage {
  goto(url: string, options?: { waitUntil?: 'commit' | 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>
  evaluate<T>(pageFunction: (arg: string) => T | Promise<T>, arg: string): Promise<T>
  isVisible(selector: string): Promise<boolean>
  url(): string
  reload(options?: { waitUntil?: 'commit' | 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<unknown>
  isClosed(): boolean
  waitForFunction(pageFunction: () => unknown, options?: { timeout?: number }): Promise<unknown>
  context(): XhsBrowserContext
}

/** 最小 playwright BrowserContext 子集（含 storage_state 备份落盘）。 */
export interface XhsBrowserContext extends StorageStateSource {
  cookies(urls?: string[]): Promise<Array<{ name: string; value: string }>>
  newPage(): Promise<XhsPage>
  pages(): XhsPage[]
  close(options?: { reason?: string }): Promise<void>
  /** 一次性事件监听（publish 保持打开语义：锁随 context close 释放）。 */
  once(event: 'close', listener: () => void): unknown
}

/** Whether the id is a login-pending placeholder. */
export function isPendingAccountId(accountId: string): boolean {
  return typeof accountId === 'string' && accountId.startsWith(PENDING_ACCOUNT_PREFIX)
}

/** 验证码/安全验证特征可见性检测（登录/采集/发布流程共用；出现即失败，绝不绕过）。 */
export async function detectCaptcha(page: XhsPage): Promise<boolean> {
  try {
    return await page.isVisible(CAPTCHA_SELECTOR)
  } catch {
    return false
  }
}

/** waitForSessionCookie 的结果。 */
export interface CookieWaitResult {
  loggedIn: boolean
  cookieName: string | null
  captcha: boolean
}

/**
 * 轮询上下文 Cookie，直到出现创作平台会话 Cookie 或超时；期间检测验证码。
 * @param context - the login browser context.
 * @param page - the login page.
 * @param options - timeout/poll/now/signal seams（signal 用于 dispose 中止）。
 * @returns the wait outcome（loggedIn / captcha / 超时）。
 */
export async function waitForSessionCookie(context: XhsBrowserContext, page: XhsPage, options: {
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  signal?: AbortSignal | undefined
} = {}): Promise<CookieWaitResult> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? COOKIE_POLL_INTERVAL_MS
  const now = options.now ?? Date.now
  const signal = options.signal
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal?.aborted === true) return { loggedIn: false, captcha: false, cookieName: null }
    const cookies = await context.cookies()
    const hit = cookies.find(item => SESSION_COOKIE_NAMES.includes(item.name) && item.value !== '')
    if (hit !== undefined) return { loggedIn: true, captcha: false, cookieName: hit.name }
    if (page.isClosed() !== true && await detectCaptcha(page)) {
      return { loggedIn: false, captcha: true, cookieName: null }
    }
    if (now() >= deadline) return { loggedIn: false, captcha: false, cookieName: null }
    await sleep(intervalMs)
  }
}

/** 页面上下文同源 fetch 结果。 */
interface EvaluateJsonResult {
  status: number
  json: unknown
}

/** 页面上下文同源 fetch：由页面自身携带会话与签名；返回 null 表示取不到。 */
async function evaluateJson(page: XhsPage, url: string): Promise<EvaluateJsonResult | null> {
  try {
    const result = await page.evaluate(async target => {
      try {
        const response = await fetch(target, { credentials: 'same-origin' })
        const text = await response.text()
        try {
          const json: unknown = JSON.parse(text)
          return { status: response.status, json }
        } catch {
          return { status: response.status, json: null }
        }
      } catch (error) {
        return { status: 0, json: null, error: String(error && typeof error === 'object' && 'message' in error ? (error as { message: unknown }).message : error) }
      }
    }, url)
    return result && typeof result === 'object' ? result as EvaluateJsonResult : null
  } catch {
    return null
  }
}

/** 账号基本资料（账号 ID/昵称/头像；接口无粉丝数/笔记数字段，诚实留空）。 */
export interface AccountProfile {
  accountId: string
  nickname: string | null
  avatar: string | null
}

/** 头像 URL 白名单：仅放行 http(s) 绝对地址，危险协议/相对地址一律 null。 */
function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (!/^https?:\/\//iu.test(candidate)) return null
  return candidate.slice(0, 2048)
}

function firstNonEmpty(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return null
}

function firstPresent(...values: unknown[]): unknown {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value
  return null
}

/**
 * 读取账号基本资料（/api/galaxy/user/info；实测无粉丝数/笔记数字段）。返回
 * null 表示本次没取到，由调用方决定是否记为缺口，绝不编造。
 * @param page - the creator-center page.
 * @returns the profile, or null when unreadable.
 */
export async function readAccountProfile(page: XhsPage): Promise<AccountProfile | null> {
  const result = await evaluateJson(page, USER_INFO_PATH)
  const payload = result?.json !== null && typeof result?.json === 'object' ? result.json as Record<string, unknown> : null
  if (payload === null) return null
  const data = payload.data !== null && typeof payload.data === 'object' ? payload.data as Record<string, unknown> : payload
  if (data === null || typeof data !== 'object') return null
  const accountId = firstNonEmpty(data.userId, data.user_id, data.id)
  if (accountId === null) return null
  return {
    accountId,
    nickname: firstNonEmpty(data.userName, data.nickname, data.name, data.nick_name),
    avatar: httpUrlOrNull(firstPresent(data.userImage, data.image, data.images, data.avatar, data.userAvatar, data.headPhoto)),
  }
}

/**
 * 登录瞬间读取账号资料，读不到时短间隔重试（SPA 未就绪/接口 302 的常见形态）。
 * @param page - the creator-center page.
 * @param options - attempts/delay seams.
 * @returns the profile, or null after the retry budget.
 */
export async function readAccountProfileWithRetry(page: XhsPage, options: { attempts?: number; delayMs?: number } = {}): Promise<AccountProfile | null> {
  const attempts = options.attempts ?? 4
  const delayMs = options.delayMs ?? 1200
  let last: AccountProfile | null = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      last = await readAccountProfile(page)
    } catch {
      last = null
    }
    if (last !== null) return last
    if (attempt < attempts - 1) await sleep(delayMs)
  }
  return last
}

/** 扫码登录结果。 */
export type LoginResult =
  | { status: 'ok'; accountId: string; profile: AccountProfile | null; profilePending: boolean }
  | { status: 'timeout' }
  | { status: 'failed'; reason: string }

/**
 * 扫码登录：有头系统 Chrome（该账号/占位持久 Profile）→ 等待扫码 → 保存备份。
 * 显式 accountId（重新登录）直接复用该账号 Profile（新会话落进探测/采集共用的
 * 目录）；占位登录成功后迁移到正式账号名下（目标目录/备份已存在时绝不覆盖）。
 *
 * Profile 互斥由调用方（handlers 层）持有；本函数只做 resolvedId 竞态防御：
 * 占位成果迁移前该账号已被其他操作占用时（isResolvedBusy 由调用方注入），丢弃
 * 本次成果（PROFILE_BUSY），绝不覆盖正在使用的会话。
 * @param options - accountId/root/timeout/chrome factory/onPage/signal/晚清理登记。
 * @returns the login outcome.
 */
export async function loginWithQrCode(options: {
  accountId?: string
  root?: string
  timeoutMs?: number
  chromeFactory?: ChromeFactory | undefined
  onPage?: ((page: XhsPage) => Promise<void> | void) | undefined
  signal?: AbortSignal | undefined
  /** 晚 factory 清理 promise（abort 后 close + 二次清理）交给调用方任务登记。 */
  trackCleanup?: ((promise: Promise<void>) => void) | undefined
  /** 占位成果迁移前 resolvedId 占用检查（调用方以 profile 锁状态注入）。 */
  isResolvedBusy?: ((accountId: string) => boolean) | undefined
}): Promise<LoginResult> {
  const root = options.root ?? stateRoot()
  const chromeFactory = options.chromeFactory ?? launchChrome
  const tempId = options.accountId ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const profileDir = await ensureProfileDir(tempId, root)
  const signal = options.signal
  let context: XhsBrowserContext | null = null
  const checkAbort = (): void => {
    if (signal?.aborted === true) throw new Error('login_aborted')
  }
  try {
    checkAbort()
    const factoryPromise = chromeFactory({ headless: false, profileDir })
    // 晚 factory 清理（abort 赢得 race 后 factory 晚 resolve 时）：close + 二次清理
    // 临时凭证；promise 交给调用方任务登记（dispose 等待）。正常完成路径不触碰
    // 正式账号。
    const cleanupPromise = factoryPromise.then(async result => {
      if (signal?.aborted !== true) return
      await result.context.close().catch(() => undefined)
      await cleanupPendingTemp(tempId, root)
    }).catch(() => undefined)
    options.trackCleanup?.(cleanupPromise)
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
      if (signal !== undefined) signal.removeEventListener('abort', onLaunchAbort)
    }
    const page = context.pages()[0] ?? await context.newPage()
    if (options.onPage !== undefined) await options.onPage(page)
    checkAbort()
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    const waited = await waitForSessionCookie(context, page, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal,
    })
    if (!waited.loggedIn) {
      // 超时/验证码必须关闭有头窗口，否则窗口与进程会滞留（登录窗口关闭后可重新发起）。
      await context.close().catch(() => undefined)
      context = null
      await cleanupPendingTemp(tempId, root)
      if (waited.captcha) return { status: 'failed', reason: 'CAPTCHA_DETECTED' }
      return { status: 'timeout' }
    }
    checkAbort()
    const profile = await readAccountProfileWithRetry(page)
    const resolvedId = profile?.accountId !== undefined && profile.accountId !== '' ? profile.accountId : tempId
    if (resolvedId !== tempId && isPendingAccountId(tempId) && options.isResolvedBusy?.(resolvedId) === true) {
      // 竞态防御：扫码期间另一操作（如对同账号的重登/采集）已持锁。moveProfile
      // 目标目录绝不覆盖——丢弃本次 pending 成果（受控冲突，扫码极少与同账号操作并发）。
      await context.close()
      context = null
      await clearLocalCredentials(tempId, root)
      return { status: 'failed', reason: 'PROFILE_BUSY' }
    }
    // 先存登录态备份（此时上下文仍打开），再关窗、再迁移 Profile 目录到正式账号 ID。
    await saveStorageState(resolvedId, context, root)
    await context.close()
    context = null
    if (resolvedId !== tempId) {
      await moveProfile(tempId, resolvedId, root)
      await moveStorageState(tempId, resolvedId, root)
    }
    const now = new Date().toISOString()
    await updateAccount(resolvedId, {
      nickname: profile?.nickname ?? null,
      avatar: profile?.avatar ?? null,
      // Cookie 命中但账号资料不可读（stale Cookie/风控空响应）时 sessionStatus
      // 不得落 ok（false-positive 会把过期 Cookie 当有效账号）；落 unknown，
      // 随后 account.probe 给出 ok/expired。
      sessionStatus: profile !== null ? 'ok' : 'unknown',
      sessionCheckedAt: now,
      lastLoginAt: now,
    }, root)
    return { status: 'ok', accountId: resolvedId, profile, profilePending: profile === null }
  } catch (error) {
    if (context !== null) await context.close().catch(() => undefined)
    await cleanupPendingTemp(tempId, root)
    if (signal?.aborted === true) return { status: 'failed', reason: 'login_aborted' }
    return { status: 'failed', reason: localFailureReason(error) }
  }
}

/**
 * 临时凭证清理：仅限 pending 占位目录。显式重登（tempId 即正式账号）绝不清理
 * ——abort/失败路径若删除正式账号的 Profile/备份，会把用户既有登录数据一并
 * 抹掉（清理只碰临时目录是硬边界）。
 */
async function cleanupPendingTemp(tempId: string, root: string): Promise<void> {
  if (!isPendingAccountId(tempId)) return
  await clearLocalCredentials(tempId, root).catch(() => undefined)
}

/** 登录失败原因收敛：Chrome/驱动缺失保留专码，其余收敛 LOGIN_FAILED。 */
function localFailureReason(error: unknown): string {
  if (error instanceof ChromeMissingError) return error.code
  const name = error instanceof Error ? error.name : ''
  if (name === 'DriverMissingError') return 'PLAYWRIGHT_DRIVER_MISSING'
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (typeof code === 'string' && ['GOOGLE_CHROME_MISSING', 'PLAYWRIGHT_DRIVER_MISSING'].includes(code)) return code
  return 'LOGIN_FAILED'
}

/**
 * 在已打开的创作者中心页面上做会话判定并回写账号状态（probeSession 与发布打开
 * 共用同一口径）。失效判定以 user/info 接口探测为准（不受 SPA 视觉时序影响）；
 * 接口探测失败时短重试，仍失败再用「URL 跳 /login + 登录框可见（含 reload 复验）」
 * 兜底判定。ok 时回写 ok 状态并保存 storage_state 备份；expired 时回写 expired。
 * @param page - the creator-center page.
 * @param options - accountId/root/reload timeout.
 * @returns the session verdict（ok/expired/unknown，unknown 不猜测）。
 */
export async function confirmSessionOnPage(page: XhsPage, options: {
  accountId: string
  root?: string
  reloadTimeoutMs?: number
}): Promise<ProbeResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const profile = await readAccountProfileWithRetry(page, { attempts: 3, delayMs: 1200 })
  if (profile !== null && profile.accountId !== '') {
    const now = new Date().toISOString()
    const seq = await nextSessionSeq(accountId, root)
    await updateAccount(accountId, {
      sessionStatus: 'ok',
      sessionCheckedAt: now,
      sessionSeq: seq,
      ...(profile.nickname !== null ? { nickname: profile.nickname } : {}),
      ...(profile.avatar !== null ? { avatar: profile.avatar } : {}),
    }, root)
    // 备份回写失败可忽略（page/context 可能已关闭）；try/catch 而非 .catch——
    // page.context() 本身的异常发生在参数求值阶段，Promise catch 兜不住。
    try {
      await saveStorageState(accountId, page.context(), root)
    } catch (error) {
      void error // 备份失败不影响会话判定。
    }
    return { status: 'ok', reason: null, profile }
  }
  // user/info 未取到：以 URL/登录框兜底判定（含 reload 复验），绝不单次误标。
  const loginPageDetected = async (): Promise<boolean> =>
    String(page.url()).includes('/login') || (await page.isVisible(LOGIN_BOX_SELECTOR).catch(() => false))
  await sleep(1500)
  let expiredConfirmed = await loginPageDetected()
  if (!expiredConfirmed) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: options.reloadTimeoutMs ?? PROBE_TIMEOUT_MS }).catch(() => undefined)
    await sleep(2500)
    expiredConfirmed = await loginPageDetected()
  }
  if (expiredConfirmed) {
    const now = new Date().toISOString()
    const seq = await nextSessionSeq(accountId, root)
    await updateAccount(accountId, { sessionStatus: 'expired', sessionCheckedAt: now, sessionSeq: seq }, root)
    return { status: 'expired', reason: 'login_page_detected', profile: null }
  }
  // 既未确认有效也未确认失效（接口抖动且页面无登录特征）→ unknown，不猜测。
  return { status: 'unknown', reason: 'user_info_unavailable', profile: null }
}

/** 设备端会话探测结果。 */
export interface ProbeResult {
  status: 'ok' | 'expired' | 'unknown'
  reason: string | null
  profile: AccountProfile | null
}

/**
 * 设备端会话探测：有头复用该账号持久 Profile 打开创作者中心，失效特征判定。
 * storage_state 备份缺失时直接 expired（storage_state_missing），不开浏览器。
 * Profile 互斥由调用方（handlers 层）持有。
 * @param options - accountId/root/chrome factory/signal。
 * @returns the probe verdict.
 */
export async function probeSession(options: {
  accountId: string
  root?: string
  chromeFactory?: ChromeFactory | undefined
  signal?: AbortSignal | undefined
}): Promise<ProbeResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  if (!(await hasStorageState(accountId, root))) return { status: 'expired', reason: 'storage_state_missing', profile: null }
  const chromeFactory = options.chromeFactory ?? launchChrome
  const profileDir = await ensureProfileDir(accountId, root)
  let context: XhsBrowserContext | null = null
  try {
    if (options.signal?.aborted === true) return { status: 'unknown', reason: 'probe_aborted', profile: null }
    ;({ context } = await chromeFactory({ headless: false, profileDir }))
    const page = context.pages()[0] ?? await context.newPage()
    await page.goto(CREATOR_ORIGIN, { waitUntil: 'domcontentloaded', timeout: PROBE_TIMEOUT_MS })
    return await confirmSessionOnPage(page, { accountId, root, reloadTimeoutMs: PROBE_TIMEOUT_MS })
  } catch (error) {
    if (options.signal?.aborted === true) return { status: 'unknown', reason: 'probe_aborted', profile: null }
    const name = error instanceof Error ? error.name : ''
    if (name === 'ChromeMissingError' || name === 'DriverMissingError') {
      return { status: 'unknown', reason: safeCode(error), profile: null }
    }
    return { status: 'unknown', reason: 'session_error', profile: null }
  } finally {
    if (context !== null) await context.close().catch(() => undefined)
  }
}

/** 移除本地账号结果。 */
export interface RemoveLocalResult {
  accountId: string
  cleared: { profile: boolean; storageState: boolean; data: boolean }
  hadRecord: boolean
}

/**
 * 移除本地账号：清除设备端 Profile/storage_state/采集快照与本地记录（幂等：
 * 源不存在也视为已清除）。远端删除前置条件即本函数完成后的 storage_state 缺失。
 * @param options - accountId/root.
 * @returns the removal projection.
 */
export async function removeLocalAccount(options: { accountId: string; root?: string }): Promise<RemoveLocalResult> {
  const root = options.root ?? stateRoot()
  const record = await getAccount(options.accountId, root)
  const removed = await clearLocalCredentials(options.accountId, root)
  return { accountId: options.accountId, cleared: removed, hadRecord: record !== null }
}
