/**
 * 报表页展示格式化（上移自抖音工作台 `format.ts`，抖音口径实现不变）：
 * 缺失一律显示「—」不造 0；满 1 万用 locale compact 单位，不足 1 万加千位
 * 分隔；时间固定上海时区（UTC+8），不依赖宿主时区。
 * @module
 */

/** 展示占位符（缺失不伪装成 0）。 */
export const EMPTY = '—'

/** locale compact 格式化缓存（zh 万/亿、en K/M）。 */
const COMPACT_FORMATS = new Map<string, Intl.NumberFormat>()

/**
 * 计数展示：缺失为「—」；≥1 万用 locale compact 单位（zh 万/亿），以下千分位
 * 直排。
 * @param value - 计数或 null。
 * @param localeTag - 展示 locale（'zh' | 'en'）。
 * @returns 展示计数。
 */
export function formatCount(value: number | null, localeTag: string = 'zh'): string {
  if (value === null || !Number.isFinite(value)) return EMPTY
  if (Math.abs(value) >= 10000) {
    let formatter = COMPACT_FORMATS.get(localeTag)
    if (formatter === undefined) {
      formatter = new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 })
      COMPACT_FORMATS.set(localeTag, formatter)
    }
    return formatter.format(value)
  }
  return value.toLocaleString('en-US')
}

/**
 * 百分比展示：0..100 clamp 后两位小数；缺失为「—」（不把缺失伪装成 0%）。
 * @param value - 百分比数值或 null。
 * @returns 展示百分比。
 */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY
  const bounded = Math.max(0, Math.min(100, value))
  return `${Math.round(bounded * 100) / 100}%`
}

/**
 * ISO 时间 → 上海时区 `YYYY-MM-DD HH:mm`（固定 UTC+8，不依赖宿主时区）；
 * 非法/缺失返回「—」。
 * @param value - ISO 8601 时间或 null。
 * @returns 展示时间。
 */
export function formatDateTime(value: string | null): string {
  if (typeof value !== 'string' || value.trim() === '') return EMPTY
  const ms = Date.parse(value.trim())
  if (!Number.isFinite(ms)) return EMPTY
  const shifted = new Date(ms + 8 * 3_600_000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

/**
 * 日期文本位移（UTC 语义解析，规避本地时区偏移）。
 * @param dayText - YYYY-MM-DD。
 * @param deltaDays - 位移天数。
 * @returns 位移后日期。
 */
export function shiftDay(dayText: string, deltaDays: number): string {
  const date = new Date(`${dayText}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return dayText
  date.setUTCDate(date.getUTCDate() + deltaDays)
  return date.toISOString().slice(0, 10)
}

/** 客户端幂等键后缀（32 位小写 hex；「重新生成」同一次点击的重试复用同键）。 */
export function attemptId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}
