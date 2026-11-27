/**
 * 小红书系统 Chrome 启动与能力自检（探测与生命周期封装在
 * [kit](../../../packages/dsh-workbench-host-kit/src/chrome.ts)，此处保留
 * launchChrome 启动函数与 browserStatus 投影）：持久化 Profile 上下文（每账号
 * 一个 `--user-data-dir`，绝不触碰个人 Chrome Profile）；登录、探测、采集共用
 * 同一账号 Profile，storage_state 仅作备份介质。
 * @module
 */
import type { BrowserContext } from 'playwright-core'
import { ChromeMissingError, DriverMissingError, LAUNCH_ARGS, resolveSystemChrome } from '@yootun/dsh-workbench-host-kit'
import { platform as osPlatform } from 'node:os'

export {
  chromeCandidates,
  resolveSystemChrome,
  LAUNCH_ARGS,
  ChromeMissingError,
  DriverMissingError,
  BrowserLaunchTimeoutError,
  closeContext,
  launchWithTimeout,
  browserCloseTimeoutMessage,
  DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
} from '@yootun/dsh-workbench-host-kit'

/** 解析到的系统 Chrome（kit resolveSystemChrome 的返回形状别名）。 */
export type ResolvedChrome = Awaited<ReturnType<typeof resolveSystemChrome>>

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
