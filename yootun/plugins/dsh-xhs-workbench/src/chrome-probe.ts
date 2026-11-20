/**
 * 系统 Chrome 可执行文件探测（迁移旧 chrome.js 探测半）：平台候选路径 + PATH
 * 回退，绝不下载 Chromium。独立模块便于在无 playwright-core 的测试环境导入。
 * @module
 */
import { access, constants } from 'node:fs/promises'
import { platform as osPlatform } from 'node:os'
import { delimiter, join } from 'node:path'

/** 无系统 Chrome（阻断；不回退 Chromium）。 */
export class ChromeMissingError extends Error {
  /** 稳定错误码。 */
  readonly code: string

  constructor() {
    super('google_chrome_missing')
    this.name = 'ChromeMissingError'
    this.code = 'GOOGLE_CHROME_MISSING'
  }
}

/** Playwright 驱动缺失（运行时未随应用打包 playwright-core）。 */
export class DriverMissingError extends Error {
  /** 稳定错误码。 */
  readonly code: string

  constructor(cause?: unknown) {
    super('playwright_driver_missing')
    this.name = 'DriverMissingError'
    this.code = 'PLAYWRIGHT_DRIVER_MISSING'
    this.cause = cause
  }
}

/** 允许的最小启动参数：不追加任何自动化特征规避或指纹伪装参数。 */
export const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'] as const

/** 解析到的系统 Chrome。 */
export interface ResolvedChrome {
  path: string
  channel: 'chrome'
}

/** 各平台系统 Chrome 常见安装位置（仅用于探测，不下载）。 */
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

/** PATH 上的命令名（Linux/macOS）。 */
const COMMAND_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chrome']

const isExecutable = async (file: string): Promise<boolean> => {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const findOnPath = async (env: NodeJS.ProcessEnv, exists: (file: string) => Promise<boolean>): Promise<string | null> => {
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
 * 解析系统 Chrome 可执行文件。
 * @param options - platform/env/exists seams（exists 仅测试注入）。
 * @returns the executable path with the fixed `chrome` channel.
 * @throws {ChromeMissingError} 设备上没有系统 Chrome（阻断，不做 Chromium 回退）。
 */
export async function resolveSystemChrome(options: { platform?: string; env?: NodeJS.ProcessEnv; exists?: (file: string) => Promise<boolean> } = {}): Promise<ResolvedChrome> {
  const exists = options.exists ?? isExecutable
  for (const candidate of chromeCandidates(options.platform, options.env)) {
    if (await exists(candidate)) return { path: candidate, channel: 'chrome' }
  }
  if (options.platform !== 'win32' && (options.platform ?? osPlatform()) !== 'win32') {
    const onPath = await findOnPath(options.env ?? process.env, exists)
    if (onPath) return { path: onPath, channel: 'chrome' }
  }
  throw new ChromeMissingError()
}
