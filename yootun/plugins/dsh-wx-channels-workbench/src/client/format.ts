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
  session_expired: 'collect.reason.session_expired',
  probe_failed: 'collect.reason.probe_failed',
  plugin_disposing: 'collect.reason.plugin_disposing',
  pending_account: 'collect.reason.pending_account',
  storage_state_missing: 'collect.reason.storage_state_missing',
  account_mismatch: 'collect.reason.account_mismatch',
  identity_check_failed: 'collect.reason.identity_check_failed',
  identity_not_stable: 'collect.reason.identity_not_stable',
  no_session_cookie: 'collect.reason.no_session_cookie',
  auth_data_unavailable: 'collect.reason.auth_data_unavailable',
  partial: 'collect.reason.partial',
  ACCOUNT_NOT_FOUND: 'collect.reason.ACCOUNT_NOT_FOUND',
  INVALID_TIME_WINDOW: 'collect.reason.INVALID_TIME_WINDOW',
  WX_SESSION_INVALID: 'error.WX_SESSION_INVALID',
  WX_TOOL_UNAVAILABLE: 'error.WX_TOOL_UNAVAILABLE',
  GOOGLE_CHROME_MISSING: 'error.CHROME',
  PLAYWRIGHT_DRIVER_MISSING: 'error.CHROME_DRIVER',
}

/** 身份稳定类前缀（`identity_check_failed:<detail>`）共用同一文案键。 */
const IDENTITY_PREFIX = 'identity_check_failed'

/**
 * 稳定 reason → 单行文案；已知码给可行动文案并保留原码，`identity_check_failed:*`
 * 前缀码归并到同一文案，未知码给通用文案并保留原码。
 * @param reason - Host 响应中的稳定 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function reasonText(reason: string, t: Translate): string {
  const normalized = reason.startsWith(`${IDENTITY_PREFIX}:`) || reason.startsWith(`${IDENTITY_PREFIX}_`)
    ? IDENTITY_PREFIX
    : reason
  const key = REASON_KEYS[normalized]
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

/** locale 紧凑格式化缓存（zh 万/亿、en K/M；绝对值满 1 万的计数走这里）。 */
const COMPACT_FORMATS = new Map<string, Intl.NumberFormat>()

/**
 * 计数展示：缺失为占位符；绝对值满 1 万用 locale 紧凑格式（zh 万/亿、en K/M，
 * 最多 1 位小数），不足 1 万整数直排。
 * @param value - 计数或 null。
 * @param localeTag - 展示 locale（缺省 'zh'）。
 * @returns 展示计数。
 */
export function formatCount(value: number | null, localeTag: string = 'zh'): string {
  if (value === null) return '—'
  if (Math.abs(value) >= 10000) {
    let formatter = COMPACT_FORMATS.get(localeTag)
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 })
      COMPACT_FORMATS.set(localeTag, formatter)
    }
    return formatter.format(value)
  }
  return String(Math.round(value))
}

/**
 * 比率展示：0..100 → 两位小数百分比；缺失为占位符（不把缺失伪装成 0%）。
 * @param value - 百分比数值或 null。
 * @returns 展示百分比。
 */
export function formatPct(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)}%`
}

/**
 * 时长展示：秒 → 两位小数 + 单位；缺失为占位符。
 * @param value - 秒数或 null。
 * @param t - 页面翻译函数（单位文案）。
 * @returns 展示时长。
 */
export function formatSeconds(value: number | null, t: Translate): string {
  return value === null ? '—' : `${value.toFixed(2)} ${t('unit.seconds')}`
}

/**
 * 次数/人数组合展示：uv 缺失只显示次数，双缺失占位符。
 * @param count - 次数。
 * @param uv - 人数。
 * @returns 组合展示文本。
 */
export function formatPair(count: number | null, uv: number | null): string {
  if (count === null) return '—'
  if (uv === null) return String(Math.round(count))
  return `${Math.round(count)} / ${Math.round(uv)}`
}

/**
 * 上海时区已完成自然日（YYYY-MM-DD）：offsetDays=1 是昨天（运行日不入窗），
 * 与 parse.ts 的上海日窗口口径一致。
 * @param offsetDays - 距今的天数（1 = 上海昨天）。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns YYYY-MM-DD。
 */
export function shanghaiCompletedDay(offsetDays: number, now: () => number = Date.now): string {
  const shifted = new Date(now() + 8 * 3600 * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - offsetDays)
  return shifted.toISOString().slice(0, 10)
}

/** 涨跌方向（净增卡与表格净增列共用）：up 红 / down 绿 / flat 无色。 */
export type DeltaTone = 'up' | 'down' | 'flat'

/**
 * 带符号增量展示：正数 `+N`（红）、负数 `-N`（绿）、`0` 与缺失「—」无色
 * （口径同抖音 fanDelta；量级经 formatCount，满 1 万转「万」并保留符号）。
 * @param value - 增量数值或 null。
 * @param localeTag - 展示 locale。
 * @returns 文本与方向。
 */
export function formatDelta(value: number | null, localeTag: string): { text: string; tone: DeltaTone } {
  if (value === null || !Number.isFinite(value) || value === 0) return { text: '—', tone: 'flat' }
  return value > 0
    ? { text: `+${formatCount(value, localeTag)}`, tone: 'up' }
    : { text: `-${formatCount(Math.abs(value), localeTag)}`, tone: 'down' }
}

/**
 * 上海语义日位移（YYYY-MM-DD → ±N 天；非法输入原样返回）。用于趋势窗口逐日
 * 枚举与自定义日期越界纠偏（原样迁自抖音工作台）。
 * @param dayText - 起始日。
 * @param deltaDays - 位移天数（可负）。
 * @returns 位移后的日文本。
 */
export function shiftDay(dayText: string, deltaDays: number): string {
  const date = new Date(`${dayText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return dayText
  date.setUTCDate(date.getUTCDate() + deltaDays)
  return date.toISOString().slice(0, 10)
}
