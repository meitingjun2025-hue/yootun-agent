/**
 * 页面展示格式化与稳定 reason → 文案映射（旧 ui-format.js 的语义迁移，视觉与
 * 实现不迁移）。缺失一律显示「—」不造 0；已知稳定码出可行动文案并附原码，
 * 未知码走通用失败文案并附原码（不透传内部信息）。
 * @module
 */
import { zh, type DouyinLocaleKey } from './locales.ts'

/** 页面翻译函数（词典键集见 locales.ts）。 */
export type Translate = (key: DouyinLocaleKey, values?: Record<string, string | number>) => string

/** 展示占位符（缺失不伪装成 0）。 */
export const EMPTY = '—'

/**
 * 稳定 reason → 单行文案：已知码给可行动文案并保留原码，未知码给通用文案并
 * 保留原码。
 * @param reason - Host 响应中的稳定 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function reasonText(reason: string, t: Translate): string {
  const key = `reason.${reason}` as DouyinLocaleKey
  if (zh[key] !== undefined) return `${t(key)}（${reason}）`
  return t('error.unknownWithCode', { code: reason })
}

/**
 * 分域错误码 → 文案（schedule / report / ai / bd / mat / gene 全表在 locales，
 * 前缀即词典段名；未登记码回退通用文案）。
 * @param domain - 错误文案域（词典前缀）。
 * @param code - 稳定错误码。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function domainErrorText(domain: 'schedule' | 'report' | 'ai' | 'bd' | 'mat' | 'gene', code: string | null, t: Translate): string {
  if (code === null || code === '') return t(`${domain}.error.default` as DouyinLocaleKey)
  const key = `${domain}.error.${code}` as DouyinLocaleKey
  return zh[key] !== undefined ? t(key) : t(`${domain}.error.default` as DouyinLocaleKey)
}

/** locale compact 格式化缓存（zh 万/亿、en K/M）。 */
const COMPACT_FORMATS = new Map<string, Intl.NumberFormat>()

/**
 * 计数展示（旧 formatCount 万位口径）：缺失为「—」；≥1 万用 locale compact
 * 单位（zh 万/亿），以下千分位直排。
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
 * 0–1 比率 → 百分比两位小数（素材互动率/基因采纳率口径：服务端小数比率，
 * 展示层统一 ×100）；缺失为「—」。
 * @param value - 0..1 比率或 null。
 * @returns 展示百分比。
 */
export function formatRateRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY
  return `${(Math.max(0, value) * 100).toFixed(2)}%`
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
 * 时长（毫秒）→ mm:ss / h:mm:ss；非有限数/负数返回 null（缺失 → —）。
 * @param ms - 毫秒时长。
 * @returns 展示时长或 null。
 */
export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null
  const totalSeconds = Math.round(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

/** 粉丝增量的着色方向（红涨绿跌由 CSS token 承担，色彩不承载唯一信息）。 */
export type DeltaTone = 'up' | 'down' | 'flat'

/**
 * 粉丝域增量统一展示（用户规定 2026-10-16）：net 模式正数 `+N`（红）、负数
 * `-N`（绿）；cancel 模式（脱粉）恒 `-N`（绿）；0 与缺失「—」（中性）。
 * @param value - 增量数值或 null。
 * @param mode - 语义模式（净增/吸粉 = net，脱粉 = cancel）。
 * @param localeTag - 展示 locale。
 * @returns 文本与着色方向。
 */
export function fanDelta(value: number | null, mode: 'net' | 'cancel' = 'net', localeTag: string = 'zh'): { text: string; tone: DeltaTone } {
  if (value === null || !Number.isFinite(value) || value === 0) {
    return { text: EMPTY, tone: 'flat' }
  }
  const magnitude = formatCount(Math.abs(value), localeTag)
  if (mode === 'cancel') return { text: `-${magnitude}`, tone: 'down' }
  return value > 0
    ? { text: `+${magnitude}`, tone: 'up' }
    : { text: `-${magnitude}`, tone: 'down' }
}

/**
 * 常规增量文本：正数 `+N`、负数原值、0 与缺失「—」。
 * @param value - 增量数值或 null。
 * @param localeTag - 展示 locale。
 * @returns 文本与方向。
 */
export function deltaText(value: number | null, localeTag: string = 'zh'): { text: string; tone: DeltaTone } {
  if (value === null || !Number.isFinite(value)) return { text: EMPTY, tone: 'flat' }
  if (value > 0) return { text: `+${formatCount(value, localeTag)}`, tone: 'up' }
  if (value < 0) return { text: formatCount(value, localeTag), tone: 'down' }
  return { text: EMPTY, tone: 'flat' }
}

/**
 * 秒数值展示：两位小数 + 单位；缺失为「—」。
 * @param value - 秒数或 null。
 * @param t - 页面翻译函数（单位文案）。
 * @returns 展示时长。
 */
export function formatSeconds(value: number | null, t: Translate): string {
  if (value === null || !Number.isFinite(value)) return EMPTY
  return `${Math.round(value * 100) / 100}${t('unit.seconds')}`
}

// ---- 作品表排序（三态；默认态严格保持接口顺序） ----

/** 可排序数值列（12 列中的 10 个数值列）。 */
export type WorkSortKey =
  | 'play_count'
  | 'collect_count'
  | 'like_count'
  | 'comment_count'
  | 'bounce_rate_2s_pct'
  | 'completion_rate_5s_pct'
  | 'completion_rate_pct'
  | 'fans_gain_count'
  | 'avg_watch_duration_s'
  | 'avg_view_proportion_pct'

/** 排序态：default 严格保持接口返回顺序（key=null）。 */
export interface WorkSortState {
  key: WorkSortKey | null
  direction: 'default' | 'desc' | 'asc'
}

/** 默认排序态（接口顺序）。 */
export const DEFAULT_WORK_SORT: WorkSortState = { key: null, direction: 'default' }

/**
 * 表头排序三态状态机：default → desc → asc → default；点击另一列直接 desc。
 * @param currentState - 当前排序态。
 * @param columnKey - 被点击的列。
 * @returns 下一个排序态。
 */
export function nextWorkSort(currentState: WorkSortState, columnKey: WorkSortKey): WorkSortState {
  if (currentState.key !== columnKey || currentState.direction === 'default') {
    return { key: columnKey, direction: 'desc' }
  }
  if (currentState.direction === 'desc') return { key: columnKey, direction: 'asc' }
  return { ...DEFAULT_WORK_SORT }
}

/**
 * 数值比较：空值与非有限值恒排最后且与方向无关（缺失不能被当作 0）。
 * @param a - 左值（原始 unknown 形态；null/undefined/'' 均为缺失）。
 * @param b - 右值。
 * @param direction - 排序方向（default 由调用方短路）。
 * @returns 比较结果。
 */
export function compareNullableNumbers(a: unknown, b: unknown, direction: 'asc' | 'desc'): number {
  const valueA = Number(a)
  const valueB = Number(b)
  const validA = a !== null && a !== undefined && a !== '' && Number.isFinite(valueA)
  const validB = b !== null && b !== undefined && b !== '' && Number.isFinite(valueB)
  if (!validA && !validB) return 0
  if (!validA) return 1
  if (!validB) return -1
  return direction === 'asc' ? valueA - valueB : valueB - valueA
}

/**
 * 排序返回新数组不改入参；同值行保持接口原始相对顺序。
 * @param rows - 作品行。
 * @param sortState - 表头排序态。
 * @param valueOf - 行 → 可排序列取值（调用方持有行类型）。
 * @returns 排序后的行。
 */
export function sortWorkRows<T>(rows: readonly T[], sortState: WorkSortState, valueOf: (row: T, key: WorkSortKey) => unknown): T[] {
  if (sortState.key === null || sortState.direction === 'default') return [...rows]
  const key = sortState.key
  const direction = sortState.direction === 'asc' ? 'asc' : 'desc'
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const diff = compareNullableNumbers(valueOf(left.row, key), valueOf(right.row, key), direction)
      return diff !== 0 ? diff : left.index - right.index
    })
    .map(entry => entry.row)
}

// ---- 观看趋势四状态（1104 方案 §2.3 语义迁移） ----

/** 观看趋势状态：请求失败 / 未提供 / 未满 24h / 暂无数据（ok 由调用方渲染图形）。 */
export type RetentionStatus = 'request_failed' | 'not_exposed' | 'not_ready' | 'no_data' | 'ok'

/** 24 小时毫秒数（「发布未满 24 小时，数据未就绪」判定窗口）。 */
const NOT_READY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 观看趋势状态判定：data_gap 记 request_failed 优先；字段缺失 = not_exposed
 * （功能上线前的历史行）；字段在但曲线空 = no_data（发布 <24h 呈现「未就绪」）。
 * @param retention - retention_trend 投影（current 曲线点数组）。
 * @param gapReason - data_gap 中该字段的 reason（无则 null）。
 * @param publishTime - 作品发布时间。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns 四状态之一或 ok。
 */
export function retentionStatus(retention: unknown, gapReason: string | null, publishTime: string | null, now: () => number = Date.now): RetentionStatus {
  if (gapReason === 'request_failed') return 'request_failed'
  if (retention === null || typeof retention !== 'object') return 'not_exposed'
  const current = (retention as { current?: unknown }).current
  if (Array.isArray(current) && current.length > 0) return 'ok'
  const publishedAt = publishTime === null ? Number.NaN : Date.parse(publishTime)
  if (Number.isFinite(publishedAt) && now() - publishedAt < NOT_READY_WINDOW_MS) return 'not_ready'
  return 'no_data'
}

/** 观看趋势状态 → 词典键。 */
export function retentionStatusKey(status: RetentionStatus): DouyinLocaleKey | null {
  if (status === 'ok') return null
  if (status === 'request_failed') return 'retention.requestFailed'
  if (status === 'not_exposed') return 'retention.notExposed'
  if (status === 'not_ready') return 'retention.notReady'
  return 'retention.noData'
}

// ---- 数据缺口 ----

/**
 * 缺口 reason → 文案（五类 + 兜底；未知 reason 收敛「其他原因」）。
 * @param reason - data_gap 条目的 reason。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function gapReasonText(reason: string | null, t: Translate): string {
  switch (reason) {
    case 'not_exposed': return t('gap.reason.not_exposed')
    case 'below_min_view': return t('gap.reason.below_min_view')
    case 'past_item_below_min_count': return t('gap.reason.past_item_below_min_count')
    case 'request_failed': return t('gap.reason.request_failed')
    case 'no_data': return t('gap.reason.no_data')
    default: return t('gap.reason.other')
  }
}

/** 缺口字段名 → 列文案键（列字段复用表格文案；未知字段「其他指标」）。 */
const GAP_FIELD_KEYS: Readonly<Record<string, DouyinLocaleKey>> = {
  title: 'col.title',
  url: 'col.url',
  play_count: 'col.play',
  collect_count: 'col.collect',
  like_count: 'col.like',
  comment_count: 'col.comment',
  bounce_rate_2s_pct: 'col.bounce2s',
  completion_rate_5s_pct: 'col.completion5s',
  completion_rate_pct: 'col.completion',
  fans_gain_count: 'col.fansGain',
  avg_watch_duration_s: 'col.duration',
  avg_view_proportion_pct: 'col.proportion',
  cover_url: 'cover.fallback',
  publish_time: 'overview.col.publishTime',
  progress_analysis: 'gap.field.progress_analysis',
  retention_trend: 'gap.field.retention_trend',
  retention_bounce: 'gap.field.retention_bounce',
  search_keywords: 'detail.searchKeywords',
}

/**
 * 缺口字段名中文化（禁止把原始英文 code 展示给业务用户）。
 * @param field - data_gap 字段名。
 * @param t - 页面翻译函数。
 * @returns 展示字段名。
 */
export function gapFieldLabel(field: string, t: Translate): string {
  const key = GAP_FIELD_KEYS[field]
  return key !== undefined ? t(key) : t('gap.field.other')
}

// ---- 安全 URL ----

/**
 * 作品链接域名白名单：仅 http(s) 且主机名固定 douyin.com 家族；不满足返回
 * null（按普通文本展示，不调用外部浏览器）。
 * @param value - 链接字符串。
 * @returns 安全链接或 null。
 */
export function safeWorkUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    if (host !== 'www.douyin.com' && host !== 'douyin.com' && !host.endsWith('.douyin.com')) return null
    return trimmed
  } catch {
    return null
  }
}

/**
 * 头像/封面地址白名单：仅 http(s) 绝对地址。
 * @param value - URL 字符串。
 * @returns 安全 URL 或 null。
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null
  } catch {
    return null
  }
}

/**
 * 头像降级首字符（白名单失败/缺失时取昵称首字符）。
 * @param name - 昵称或账号 ID。
 * @returns 首字符（空名回退「·」）。
 */
export function avatarFallbackChar(name: string): string {
  const trimmed = name.trim()
  return trimmed === '' ? '·' : trimmed.slice(0, 1)
}

// ---- 批量未完成原因（七类） ----

/**
 * 批量 skipped/failed 稳定原因 → 文案键；未知码收敛通用失败文案。
 * @param reason - 批量条目稳定原因。
 * @returns 词典键。
 */
export function batchReasonKey(reason: string | null): DouyinLocaleKey {
  if (reason === null || reason === '') return 'batch.reason.failed'
  if (reason === 'session_required' || reason === 'session_invalid' || reason === 'session_expired') return 'batch.reason.sessionExpired'
  if (reason === 'storage_state_missing') return 'batch.reason.storageMissing'
  if (reason === 'pending_account') return 'batch.reason.pending'
  if (reason === 'probe_failed') return 'batch.reason.probeFailed'
  if (reason === 'ingest_failed') return 'batch.reason.ingestFailed'
  if (reason === 'risk_paused') return 'batch.reason.riskPaused'
  return 'batch.reason.failed'
}

/**
 * 爆款依据纵向分组：接口依据是「 · 」分隔的单个字符串，展示层按分隔符拆行；
 * 缺失返回空数组（调用方不渲染空行，客户端不拼装或推断依据）。
 * @param basis - 依据字符串。
 * @returns 分行后的依据。
 */
export function basisLines(basis: string | null): string[] {
  if (basis === null || basis === '') return []
  return basis.split(' · ').map(line => line.trim()).filter(line => line !== '')
}

/**
 * 爆款标签中文化：未登记标签收敛「其他标签」，原始 key 不进页面；去重。
 * @param labels - 标签数组。
 * @param t - 页面翻译函数。
 * @returns 展示标签文本。
 */
export function hotLabelText(labels: readonly string[] | null, t: Translate): string {
  if (labels === null || labels.length === 0) return t('overview.insufficientSample')
  const known: Readonly<Record<string, DouyinLocaleKey>> = {
    absolute: 'hot.label.absolute',
    account_relative: 'hot.label.account_relative',
    potential: 'hot.label.potential',
  }
  const parts = [...new Set(labels.map(label => {
    const key = known[label]
    return key !== undefined ? t(key) : t('hot.label.other')
  }))]
  return parts.join(' + ')
}

/**
 * 性别 key 中文化（male/female/其他）。
 * @param value - 性别枚举 key。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function genderLabel(value: string, t: Translate): string {
  if (value === 'male') return t('gender.male')
  if (value === 'female') return t('gender.female')
  return t('gender.other')
}

/** 年龄分桶 key → 词典键（已知区间精确映射；未识别兜底「其他年龄段」）。 */
const AGE_BUCKET_KEYS: Readonly<Record<string, DouyinLocaleKey>> = {
  '-18': 'age.-18',
  '18-23': 'age.18-23',
  '24-30': 'age.24-30',
  '31-40': 'age.31-40',
  '41-50': 'age.41-50',
  '50-': 'age.50-',
}

/**
 * 年龄分桶 key 中文化。
 * @param value - 分桶 key。
 * @param t - 页面翻译函数。
 * @returns 展示文案。
 */
export function formatAgeBucket(value: string, t: Translate): string {
  const key = AGE_BUCKET_KEYS[value.trim()]
  return key !== undefined ? t(key) : t('age.other')
}

/** 已知流量来源 key → 词典键（与采集端 SOURCE_LABELS 同一清单）。 */
const SOURCE_KEY_LABELS: Readonly<Record<string, DouyinLocaleKey>> = {
  homepage_hot: 'src.homepage_hot',
  homepage: 'src.homepage',
  familiar: 'src.familiar',
  follow: 'src.follow',
  search: 'src.search',
  message: 'src.message',
  nearby: 'src.nearby',
  other: 'src.other',
}

/** 裸枚举形态（历史数据曾把未映射 key 原样写入 label，不可信）。 */
const RAW_KEY_SHAPE = /^[A-Za-z0-9_.-]+$/

/**
 * 流量来源展示名：label 优先（非空、不等于原始 key、非裸枚举形态），已知 key
 * 用映射，未知/缺失「其他来源」；原始 key 不进页面文本。
 * @param sourceKey - 来源 key。
 * @param sourceLabel - 来源 label（可空）。
 * @param t - 页面翻译函数。
 * @returns 展示名。
 */
export function trafficSourceLabel(sourceKey: string, sourceLabel: string | null, t: Translate): string {
  const key = sourceKey.trim()
  const label = sourceLabel === null ? '' : sourceLabel.trim()
  if (label !== '' && label !== key && !RAW_KEY_SHAPE.test(label)) return label.slice(0, 128)
  const mapped = SOURCE_KEY_LABELS[key]
  return mapped !== undefined ? t(mapped) : t('src.other')
}

// ---- 日期窗口（上海自然日） ----

/**
 * 今日 YYYY-MM-DD（上海语义日；测试注入 now）。
 * @param now - 当前毫秒时刻。
 * @returns 上海今日。
 */
export function shanghaiToday(now: () => number = Date.now): string {
  return new Date(now() + 8 * 3_600_000).toISOString().slice(0, 10)
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
