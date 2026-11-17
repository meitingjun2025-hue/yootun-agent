/**
 * 系统 Google Chrome 探测（移植旧 chrome.js 合规基线）：只用设备已安装的系统
 * Chrome（Playwright `channel: 'chrome'`），不打包/下载 Chromium；无系统 Chrome
 * 时阻断并给稳定码。启动参数只有 --no-sandbox / --disable-dev-shm-usage，
 * 不引入任何反检测内核或指纹伪装参数。
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
    return { chrome: 'available', driver: 'available' }
  } catch (error) {
    if ((error as { code?: unknown }).code === 'PLAYWRIGHT_DRIVER_MISSING') {
      return { chrome: 'available', driver: 'missing' }
    }
    return { chrome: 'missing', driver: 'available' }
  }
}
