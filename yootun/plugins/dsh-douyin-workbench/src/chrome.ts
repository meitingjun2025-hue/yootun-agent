/**
 * 抖音浏览器能力自检投影（探测与生命周期封装在
 * [kit](../../../packages/dsh-workbench-host-kit/src/chrome.ts)，此处保留
 * browserStatus 投影与 playwright-core 驱动加载；探测结果不含本地路径，
 * browserStatus 只回布尔与平台，chromePath 不出探测层）。
 * @module
 */
import { ChromeMissingError, resolveSystemChrome, DriverMissingError } from '@yootun/dsh-workbench-host-kit'
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
  const { chromium = null, platform = osPlatform(), env = process.env, exists } = options
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
