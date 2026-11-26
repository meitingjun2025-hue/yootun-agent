/**
 * 系统 Google Chrome 探测（移植旧 chrome.js 合规基线）：只用设备已安装的系统
 * Chrome（Playwright `channel: 'chrome'`），不打包/下载 Chromium；无系统 Chrome
 * 时阻断并给稳定码。启动参数只有 --no-sandbox / --disable-dev-shm-usage，
 * 不引入任何反检测内核或指纹伪装参数。浏览器生命周期封装也在这里：closeContext
 * （close 与超时赛跑，永不抛）与 launchWithTimeout（启动预算，超时抛
 * BrowserLaunchTimeoutError）。
 * @module
 */
import { access, constants } from 'node:fs/promises'
import { platform as osPlatform } from 'node:os'
import { delimiter, join } from 'node:path'

/** 系统 Chrome 缺失（阻断，不做 Chromium 回退）。 */
export class ChromeMissingError extends Error {
  /** Stable machine code. */
  readonly code = 'GOOGLE_CHROME_MISSING'

  constructor() {
    super('google_chrome_missing')
    this.name = 'ChromeMissingError'
  }
}

/** Playwright 驱动缺失（包安装不完整）。 */
export class DriverMissingError extends Error {
  /** Stable machine code. */
  readonly code = 'PLAYWRIGHT_DRIVER_MISSING'
  /** The underlying driver-resolution failure. */
  override readonly cause: unknown

  constructor(cause: unknown) {
    super('playwright_driver_missing')
    this.name = 'DriverMissingError'
    this.cause = cause
  }
}

/** 允许的最小启动参数：不追加任何自动化特征规避参数。 */
export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'] as const

/** Config.browserCloseTimeoutMs 未透传时的缺省关闭预算（生产路径由 apply 显式注入）。 */
export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 8_000

/** Config.launchTimeoutMs 未透传时的缺省启动预算（生产路径由 apply 显式注入）。 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000

/** Chrome 启动超预算（BrowserLaunchTimeoutError；safeCode 按类名映射 `browser_launch_timeout`）。 */
export class BrowserLaunchTimeoutError extends Error {
  constructor() {
    super('browser_launch_timeout')
    this.name = 'BrowserLaunchTimeoutError'
  }
}

/**
 * Close a browser context (or any closer) racing a timeout: 正常关闭先到即返回；
 * `close()` 挂起（Chrome 进程卡死）超过 `timeoutMs` 时触发 `onTimeout()` 并
 * resolve——close 的失败与迟到 rejection 均旁路消费，本函数永不抛。调用方在
 * `onTimeout` 后继续执行 finally 的其余清理（锁释放、临时 profile 清理）。
 * 输掉 race 的 setTimeout 在 finally 清除，不拖住事件循环。
 * @param target - any object with an async `close()`（BrowserContext 或 session 包装）。
 * @param timeoutMs - close 预算毫秒（Config.browserCloseTimeoutMs 透传）。
 * @param onTimeout - 超时回调（日志告警）；在计时器回调内执行，不得抛。
 */
export async function closeContext(target: { close(): Promise<void> }, timeoutMs: number, onTimeout: () => void): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
  // closeContext 实现内部：target 的 close 与超时赛跑；调用经微任务解包
  // （close 同步抛出也折为 rejection 被旁路消费），计时器清理不被跳过。
  // 本调用点是 §5.1「src 下无绕过封装的关闭」的唯一豁免（grep -v closeContext）。
  const closing = Promise.resolve().then(() => target.close()).catch(() => undefined) // closeContext 实现内部
  try {
    const outcome = await Promise.race([closing.then(() => 'closed' as const), timeoutPromise])
    if (outcome === 'timeout') onTimeout()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * browser close 超时告警行（分册 08 §12.4 口径）；accountId 摘要截前 16 字符，
 * 完整标识与本地路径不进日志。
 * @param accountId - the account the hanging close belonged to.
 * @returns the warn line.
 */
export function browserCloseTimeoutMessage(accountId: string): string {
  return `browser close timed out (${accountId.slice(0, 16)})`
}

/**
 * Launch something racing a startup budget: 超时抛 {@link BrowserLaunchTimeoutError}
 * （safeCode → `browser_launch_timeout`）；launch 迟到成功时其结果交
 * `onLateResult` 立即清理（关闭迟到 context、清理临时 profile），该清理 promise
 * 由调用方在 `onLateResult` 内同步交给任务登记表（dispose 等待）。正常成败按
 * launch 原样传播；输掉 race 的计时器在 finally 清除。
 * @param launch - the launch operation.
 * @param timeoutMs - startup budget in milliseconds（Config.launchTimeoutMs 透传）。
 * @param onLateResult - cleanup for a result that arrives after the timeout won.
 * @returns the launch result when it settles within the budget.
 * @throws {BrowserLaunchTimeoutError} the launch exceeded `timeoutMs`.
 */
export async function launchWithTimeout<T>(
  launch: () => Promise<T>,
  timeoutMs: number,
  onLateResult?: ((result: T) => Promise<void> | void) | undefined,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeoutRejection = Promise.withResolvers<never>()
  timer = setTimeout(() => {
    timedOut = true
    timeoutRejection.reject(new BrowserLaunchTimeoutError())
  }, timeoutMs)
  // 经微任务解包：launch 同步抛出也折为 rejection 走正常失败路径，计时器
  // 清理（finally）不被跳过。
  const launching = Promise.resolve().then(launch)
  try {
    return await Promise.race([launching, timeoutRejection.promise])
  } finally {
    clearTimeout(timer)
    if (timedOut) {
      // 迟到结果：成功交清理钩子（其错误旁路消费），失败静默——都不产生
      // unhandled rejection。
      void launching.then(
        result => { void Promise.resolve(onLateResult?.(result)).catch(() => undefined) },
        () => undefined,
      )
    }
  }
}

/** 各平台系统 Chrome 常见安装位置（仅探测，不下载）。 */
export function chromeCandidates(platform: string = osPlatform(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[]
    return roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(env.HOME ?? '', 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ].filter(Boolean)
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']
}

const COMMAND_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chrome']

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch (error: unknown) {
    // 不可执行/不存在：探测否定分支。
    void error
    return false
  }
}

async function findOnPath(env: NodeJS.ProcessEnv, exists: (file: string) => Promise<boolean>): Promise<string | null> {
  const dirs = String(env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of COMMAND_CANDIDATES) {
      const candidate = join(dir, name)
      if (await exists(candidate)) return candidate
    }
  }
  return null
}

/**
 * Resolve the system Chrome executable.
 * @param options - platform/env/exists injection for tests.
 * @returns the executable path; `channel` is always 'chrome'.
 * @throws {ChromeMissingError} no system Chrome on this device.
 */
export async function resolveSystemChrome(options: {
  platform?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  exists?: ((file: string) => Promise<boolean>) | undefined
} = {}): Promise<{ path: string; channel: 'chrome' }> {
  const platform = options.platform ?? osPlatform()
  const env = options.env ?? process.env
  const exists = options.exists ?? isExecutable
  for (const candidate of chromeCandidates(platform, env)) {
    if (await exists(candidate)) return { path: candidate, channel: 'chrome' }
  }
  if (platform !== 'win32') {
    const onPath = await findOnPath(env, exists)
    if (onPath !== null) return { path: onPath, channel: 'chrome' }
  }
  throw new ChromeMissingError()
}

/** browser.status 投影（页面会话状态卡数据源；不含任何路径）。 */
export interface BrowserStatus {
  chrome: 'available' | 'missing'
  driver: 'available' | 'missing'
}

/**
 * Probe the device's Chrome + driver availability (no launch).
 * @returns the whitelisted status projection.
 */
export async function browserStatus(): Promise<BrowserStatus> {
  try {
    await resolveSystemChrome()
  } catch (error) {
    if ((error as { code?: unknown }).code === 'PLAYWRIGHT_DRIVER_MISSING') {
      return { chrome: 'available', driver: 'missing' }
    }
    return { chrome: 'missing', driver: 'missing' }
  }
  // Chrome 可用后真实探测 playwright-core 驱动可解析（不能在只找到 Chrome 时
  // 直接假设 driver available——复审 P1-3）。
  try {
    await import('playwright-core')
    return { chrome: 'available', driver: 'available' }
  } catch {
    return { chrome: 'available', driver: 'missing' }
  }
}
