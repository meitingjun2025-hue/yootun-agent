/**
 * 页面展示格式化与稳定 reason → 文案映射。reason 只显示稳定码：已知码出
 * 可行动文案并附原码，未知码走通用失败文案并附原码（不透传内部信息）。
 * @module
 */
import type { WxLocaleKey } from './locales.ts'

/** 页面翻译函数（词典键集见 locales.ts）。 */
export type Translate = (key: WxLocaleKey, values?: Record<string, string | number>) => string

/** 已知稳定 reason 的文案键映射（其余走 unknownWithCode 通用文案）。 */
const REASON_KEYS: Readonly<Record<string, WxLocaleKey>> = {
  collect_busy: 'collect.reason.collect_busy',
  session_required: 'collect.reason.session_required',
  probe_failed: 'collect.reason.probe_failed',
  plugin_disposing: 'collect.reason.plugin_disposing',
  pending_account: 'collect.reason.pending_account',
  storage_state_missing: 'collect.reason.storage_state_missing',
  session_expired: 'error.WX_SESSION_INVALID',
  WX_SESSION_INVALID: 'error.WX_SESSION_INVALID',
  WX_TOOL_UNAVAILABLE: 'error.WX_TOOL_UNAVAILABLE',
  GOOGLE_CHROME_MISSING: 'error.CHROME',
  PLAYWRIGHT_DRIVER_MISSING: 'error.CHROME_DRIVER',
}

/**
 * 稳定 reason → 单行文案；已知码给可行动文案并保留原码，未知码给通用文案
 * 并保留原码。
 * @param reason - Host 响应中的稳定 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function reasonText(reason: string, t: Translate): string {
  const key = REASON_KEYS[reason]
  if (key !== undefined) return `${t(key)}（${reason}）`
  return t('error.unknownWithCode', { code: reason })
}

/**
 * ISO 时间 → 本地 `YYYY-MM-DD HH:mm`；null/不可解析返回 null（不虚构）。
 * @param iso - ISO 8601 时间或 null。
 * @returns 展示时间。
 */
export function formatDateTime(iso: string | null): string | null {
  if (iso === null) return null
  const moment = new Date(iso)
  if (Number.isNaN(moment.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`
}

/**
 * 计数展示：null 显示占位符，整数直排。
 * @param value - 计数或 null。
 * @returns 展示计数。
 */
export function formatCount(value: number | null): string {
  return value === null ? '—' : String(Math.round(value))
}

/**
 * 上海时区已完成自然日（YYYY-MM-DD）：offsetDays=1 是昨天（运行日不入窗），
 * 与 parse.ts 的上海日窗口径一致。
 * @param offsetDays - 距今的天数（1 = 上海昨天）。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns YYYY-MM-DD。
 */
export function shanghaiCompletedDay(offsetDays: number, now: () => number = Date.now): string {
  const shifted = new Date(now() + 8 * 3600 * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - offsetDays)
  return shifted.toISOString().slice(0, 10)
}
