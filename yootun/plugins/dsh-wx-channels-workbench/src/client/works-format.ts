/**
 * 作品页纯函数：加权完播率、缺口计数、表头排序状态机与客户端排序、最近采集
 * 时间、按日趋势行装配（发布日前补 0、发布日后缺失断线）。排序白名单与 tools
 * work_list 的 sort 枚举对齐；完播率 / 平均播放时长服务端不可排序，本地排序
 * 只作用于已入库数据，缺失值恒沉底。
 * @module
 */
import { CORE_GAP_FIELDS, type WorkDailyRow, type WorkRow } from './schema.ts'
import { shanghaiCompletedDay } from './format.ts'

/** 表头排序方向（默认态即发布时间降序，无独立 default 方向）。 */
export interface SortState {
  key: SortKey
  direction: 'desc' | 'asc'
}

/** 可排序列（与旧工作台列一致）。 */
export type SortKey =
  | 'publish_time'
  | 'completion_rate_pct'
  | 'avg_play_duration_s'
  | 'play_count'
  | 'like_count'
  | 'favorite_count'
  | 'comment_count'
  | 'share_count'
  | 'forward_count'
  | 'follow_count'

/** 默认排序态：发布时间降序（进入页面即最近发布在前）。 */
export const DEFAULT_SORT_STATE: SortState = { key: 'publish_time', direction: 'desc' }

/** 服务端可排序键（tools work_list sort 枚举）；其余键走客户端排序。 */
export const SERVER_SORT_KEYS: ReadonlySet<SortKey> = new Set([
  'publish_time',
  'play_count',
  'like_count',
  'favorite_count',
  'comment_count',
  'share_count',
  'forward_count',
  'follow_count',
])

/** 排序键 → WorkRow 可排序字段（客户端排序取值；均为 string | number | null）。 */
type SortableField = 'publishTime' | 'completionRatePct' | 'avgPlayDurationS' | 'playCount' | 'likeCount'
  | 'favoriteCount' | 'commentCount' | 'shareCount' | 'forwardCount' | 'followCount'

const SORT_FIELD: Readonly<Record<SortKey, SortableField>> = {
  publish_time: 'publishTime',
  completion_rate_pct: 'completionRatePct',
  avg_play_duration_s: 'avgPlayDurationS',
  play_count: 'playCount',
  like_count: 'likeCount',
  favorite_count: 'favoriteCount',
  comment_count: 'commentCount',
  share_count: 'shareCount',
  forward_count: 'forwardCount',
  follow_count: 'followCount',
}

/**
 * 表头排序三态状态机：点击新列 → desc；同列 desc → asc；asc → 回默认态
 * （发布时间降序）。
 * @param currentState - 当前排序态。
 * @param columnKey - 被点击的列。
 * @returns 下一个排序态。
 */
export function nextSortState(currentState: SortState, columnKey: SortKey): SortState {
  if (currentState.key !== columnKey) return { key: columnKey, direction: 'desc' }
  if (currentState.direction === 'desc') return { key: columnKey, direction: 'asc' }
  return { ...DEFAULT_SORT_STATE }
}

/**
 * 客户端排序（本地、只基于已入库数据）：缺失值恒沉底且不参与方向翻转；
 * 稳定排序保持接口原序。
 * @param rows - 已入库作品行。
 * @param sortState - 表头排序态。
 * @returns 排序后的行。
 */
export function sortWorkRows(rows: readonly WorkRow[], sortState: SortState): WorkRow[] {
  const field = SORT_FIELD[sortState.key]
  const sign = sortState.direction === 'asc' ? 1 : -1
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const av: number | string | null = left.row[field]
      const bv: number | string | null = right.row[field]
      if (av === null && bv === null) return left.index - right.index
      if (av === null) return 1
      if (bv === null) return -1
      if (av === bv) return left.index - right.index
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * sign
      }
      return (av - bv) * sign
    })
    .map(entry => entry.row)
}

/**
 * 播放量加权完播率：仅 completion 与 play 均非空的作品参与；分母 0 为 null。
 * @param rows - 已入库作品行。
 * @returns 加权完播率（两位小数）或 null。
 */
export function weightedCompletionRate(rows: readonly WorkRow[]): number | null {
  let numerator = 0
  let denominator = 0
  for (const row of rows) {
    if (row.completionRatePct === null || row.playCount === null) continue
    numerator += row.completionRatePct * row.playCount
    denominator += row.playCount
  }
  return denominator > 0 ? Number((numerator / denominator).toFixed(2)) : null
}

/** 单行是否存在核心字段缺口（is_original 等非核心字段不计）。 */
export function hasCoreGap(row: WorkRow): boolean {
  return row.dataGap !== null && Object.keys(row.dataGap).some(field => CORE_GAP_FIELDS.has(field))
}

/** 缺口作品数：至少一个核心字段缺口的作品数。 */
export function gapWorkCount(rows: readonly WorkRow[]): number {
  return rows.filter(hasCoreGap).length
}

/**
 * 作品列表「最近采集时间」：取所有行 latest_collected_at 的最大值，无有效值
 * 返回 null。
 * @param rows - 已入库作品行。
 * @returns 最新采集时间 ISO 或 null。
 */
export function latestCollectedAt(rows: readonly WorkRow[]): string | null {
  let latest: number | null = null
  let latestRaw: string | null = null
  for (const row of rows) {
    if (row.latestCollectedAt === null) continue
    const time = Date.parse(row.latestCollectedAt)
    if (Number.isNaN(time)) continue
    if (latest === null || time > latest) {
      latest = time
      latestRaw = row.latestCollectedAt
    }
  }
  return latestRaw
}

/** 来源分布行按播放量降序（最多的在最上方），缺失值沉底、不折算 0。 */
export function sortTrafficRowsByValue<T extends { value: number | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => {
    if (left.value === null && right.value === null) return 0
    if (left.value === null) return 1
    if (right.value === null) return -1
    return right.value - left.value
  })
}

/**
 * 最近 N 个上海语义日（含终点「昨天」——运行日未收盘不入日表）。
 * @param count - 天数。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns 升序 YYYY-MM-DD 数组。
 */
export function recentDays(count: number, now: () => number = Date.now): string[] {
  const end = shanghaiCompletedDay(1, now)
  const endMs = Date.parse(`${end}T00:00:00Z`)
  return Array.from({ length: count }, (_, index) =>
    new Date(endMs - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10))
}

/**
 * ISO 时间戳 → 上海语义日（YYYY-MM-DD）；不可解析返回 null。
 * @param iso - ISO 8601 时间。
 * @returns 上海日。
 */
export function shanghaiDayOf(iso: string | null): string | null {
  if (iso === null) return null
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return null
  return new Date(time + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 按日趋势一行：七系列数值（缺失 null 断线）。 */
export interface DailyTrendRow {
  day: string
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  forwardCount: number | null
  followCount: number | null
}

/**
 * 按日数据近 7 天趋势行：x 轴固定最近 7 个上海语义日；发布日之前按 0
 * （作品尚不存在，确定性为 0），发布日之后的缺失断线（不造 0）。
 * @param dailyRows - work.get 的 daily_metrics 行。
 * @param publishTime - 作品发布时间。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns 7 行趋势数据。
 */
export function dailyTrendRows(
  dailyRows: readonly WorkDailyRow[],
  publishTime: string | null,
  now: () => number = Date.now,
): DailyTrendRow[] {
  const byDay = new Map(dailyRows.map(row => [row.day, row]))
  const publishDay = shanghaiDayOf(publishTime)
  const days = recentDays(7, now)
  return days.map(day => {
    if (publishDay !== null && day < publishDay) {
      return { day, playCount: 0, likeCount: 0, favoriteCount: 0, commentCount: 0, shareCount: 0, forwardCount: 0, followCount: 0 }
    }
    return byDay.get(day) ?? {
      day,
      playCount: null,
      likeCount: null,
      favoriteCount: null,
      commentCount: null,
      shareCount: null,
      forwardCount: null,
      followCount: null,
    }
  })
}
