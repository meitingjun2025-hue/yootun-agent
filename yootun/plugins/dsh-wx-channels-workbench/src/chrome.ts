/**
 * 视频号浏览器能力自检投影（探测与生命周期封装在
 * [kit](../../../packages/dsh-workbench-host-kit/src/chrome.ts)，此处保留
 * browserStatus 投影；投影只回可用性枚举，不含任何路径）。
 * @module
 */
import { resolveSystemChrome } from '@yootun/dsh-workbench-host-kit'

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
