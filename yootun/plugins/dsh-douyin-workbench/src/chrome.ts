/**
 * 系统 Google Chrome 探测（分册 15 §7 冻结的旧 chrome.js 合规基线）：只用设备
 * 已安装的系统 Chrome（Playwright `channel: 'chrome'`），不打包/下载 Chromium，
 * 无系统 Chrome 时阻断并给稳定码。启动参数只有 --no-sandbox /
 * --disable-dev-shm-usage，不引入任何自动化特征规避或指纹伪装参数。探测结果
 * 不含本地路径（browserStatus 只回布尔与平台，chromePath 不出探测层）。
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

/** 允许的最小启动参数：不追加任何自动化特征规避参数（分册 15 §7 冻结）。 */
export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'] as const

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
  } catch {
    return false
  }
}

async function findOnPath(env: NodeJS.ProcessEnv, exists: (file: string) => Promise<boolean>): Promise<string | null> {
  const dirs = String(env.PATH ?? '').split(delimiter).filter(Boolean)
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
 * @param options.platform - target platform (test injection).
 * @param options.env - environment for install-location and PATH lookup (test injection).
 * @param options.exists - filesystem probe seam (test injection).
 * @returns the executable path and the fixed `chrome` channel.
 * @throws {ChromeMissingError} no system Chrome (blocked, no Chromium fallback).
 */
export async function resolveSystemChrome(options: {
  platform?: string
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => Promise<boolean>
} = {}): Promise<{ path: string; channel: 'chrome' }> {
  const { platform = osPlatform(), env = process.env, exists = isExecutable } = options
  for (const candidate of chromeCandidates(platform, env)) {
    if (await exists(candidate)) return { path: candidate, channel: 'chrome' }
  }
  if (platform !== 'win32') {
    const onPath = await findOnPath(env, exists)
    if (onPath !== null) return { path: onPath, channel: 'chrome' }
  }
  throw new ChromeMissingError()
}

/**
 * Load the Playwright driver (`playwright-core`, no browser binaries).
 * @returns the driver module namespace.
 * @throws {DriverMissingError} the driver is not bundled with the app.
 */
export async function loadPlaywrightDriver(): Promise<{ chromium: unknown }> {
  try {
    return await import('playwright-core')
  } catch (error: unknown) {
    throw new DriverMissingError(error)
  }
}

/**
 * 设备端浏览器能力自检（旧 index.js `browser.status` 投影口径）：只回布尔、
 * 平台与可执行提示，不回传 chromePath 等设备路径；无系统 Chrome 不抛错，由
 * UI 按 hint 呈现安装指引。
 * @param options.chromium - preloaded driver namespace (test injection).
 * @param options.platform - target platform (test injection).
 * @param options.env - environment (test injection).
 * @param options.exists - filesystem probe seam (test injection).
 * @returns availability flags, platform, and the stable install hint.
 */
export async function browserStatus(options: {
  chromium?: unknown
  platform?: string
  env?: NodeJS.ProcessEnv
  exists?: (file: string) => Promise<boolean>
} = {}): Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }> {
  const { chromium = null, platform = osPlatform(), env = process.env, exists = isExecutable } = options
  let chromeAvailable = false
  try {
    await resolveSystemChrome({ platform, env, exists })
    chromeAvailable = true
  } catch (error) {
    if (!(error instanceof ChromeMissingError)) throw error
  }
  let driverAvailable = chromium !== null
  if (!driverAvailable) {
    try {
      await loadPlaywrightDriver()
      driverAvailable = true
    } catch {
      driverAvailable = false
    }
  }
  return {
    chromeAvailable,
    driverAvailable,
    platform,
    hint: chromeAvailable ? null : 'install_google_chrome',
  }
}
