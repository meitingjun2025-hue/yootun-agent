/**
 * 系统 Chrome 启动与能力自检（迁移旧 chrome.js 启动/自检半）：持久化 Profile
 * 上下文（每账号一个 `--user-data-dir`，绝不触碰个人 Chrome Profile）；登录、
 * 探测、采集共用同一账号 Profile，storage_state 仅作备份介质。探测半见
 * [chrome-probe.ts](./chrome-probe.ts)。
 * @module
 */
import type { BrowserContext } from 'playwright-core'
import { ChromeMissingError, DriverMissingError, LAUNCH_ARGS, resolveSystemChrome } from './chrome-probe.ts'
import { platform as osPlatform } from 'node:os'

export { ChromeMissingError, DriverMissingError, LAUNCH_ARGS, chromeCandidates, resolveSystemChrome, type ResolvedChrome } from './chrome-probe.ts'

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
