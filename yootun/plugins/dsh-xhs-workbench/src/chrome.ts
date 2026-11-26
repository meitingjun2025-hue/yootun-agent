/**
 * 系统 Chrome 启动与能力自检（迁移旧 chrome.js 启动/自检半）：持久化 Profile
 * 上下文（每账号一个 `--user-data-dir`，绝不触碰个人 Chrome Profile）；登录、
 * 探测、采集共用同一账号 Profile，storage_state 仅作备份介质。探测半见
 * [chrome-probe.ts](./chrome-probe.ts)。浏览器生命周期封装也在这里：closeContext
 * （close 与超时赛跑，永不抛）与 launchWithTimeout（启动预算，超时抛
 * BrowserLaunchTimeoutError）。
 * @module
 */
import type { BrowserContext } from 'playwright-core'
import { ChromeMissingError, DriverMissingError, LAUNCH_ARGS, resolveSystemChrome } from './chrome-probe.ts'
import { platform as osPlatform } from 'node:os'

export { ChromeMissingError, DriverMissingError, LAUNCH_ARGS, chromeCandidates, resolveSystemChrome, type ResolvedChrome } from './chrome-probe.ts'

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
 * @param target - any object with an async `close()`（XhsBrowserContext 或 session 包装）。
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

/** 浏览器能力自检投影（device path 细节不回传页面）。 */
export interface BrowserStatus {
  chromeAvailable: boolean
  driverAvailable: boolean
  platform: string
}

/**
 * 设备端浏览器能力自检：供 UI 在无 Chrome / 无驱动时给出可执行提示。
 * @param options - test seams for platform/env/driver.
 * @returns availability booleans plus the platform name.
 */
export async function browserStatus(options: { chromium?: unknown; platform?: string; env?: NodeJS.ProcessEnv } = {}): Promise<BrowserStatus> {
  const platform = options.platform ?? osPlatform()
  let chromeAvailable = false
  try {
    await resolveSystemChrome({ platform, env: options.env ?? process.env })
    chromeAvailable = true
  } catch (error) {
    if (!(error instanceof ChromeMissingError)) throw error
  }
  let driverAvailable = Boolean(options.chromium)
  if (!driverAvailable) {
    try {
      await import('playwright-core')
      driverAvailable = true
    } catch {
      driverAvailable = false
    }
  }
  return { chromeAvailable, driverAvailable, platform }
}

/** 系统 Chrome 持久化上下文启动结果。 */
export interface ChromeLaunch {
  context: BrowserContext
}

/** Chrome launcher seam（测试注入 fake context；undefined = launchChrome 真实实现）。 */
export type ChromeFactory = (options: { headless: boolean; profileDir: string }) => Promise<ChromeLaunch>

/**
 * Launch the account's persistent-profile system Chrome context.
 * @param options - headless flag + per-account profile dir.
 * @returns the launched persistent context.
 * @throws {ChromeMissingError} no system Chrome installed.
 * @throws {DriverMissingError} the packaged playwright-core driver is unavailable.
 */
export async function launchChrome(options: { headless: boolean; profileDir: string }): Promise<ChromeLaunch> {
  const chrome = await resolveSystemChrome()
  try {
    const { chromium } = await import('playwright-core')
    const context = await chromium.launchPersistentContext(options.profileDir, {
      headless: options.headless,
      channel: chrome.channel,
      executablePath: chrome.path,
      args: [...LAUNCH_ARGS],
      viewport: options.headless ? { width: 1440, height: 900 } : null,
    })
    return { context }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'GOOGLE_CHROME_MISSING') throw error
    const missing = /Executable doesn't exist|playwright/iu.test(String(error))
    if (missing) throw new DriverMissingError(error instanceof Error ? error : undefined)
    throw error
  }
}
