/**
 * 作品页纯函数：表头排序状态机与按日趋势行装配（发布日前补 0、发布日后缺失
 * 断线）。排序与整账号聚合（加权完播率、缺口计数、最近采集时间）都在服务端
 * 完成，页面只组装查询参数并渲染返回的当页行。
 * @module
 */
import { type WorkDailyRow } from './schema.ts'
import { shanghaiCompletedDay } from './format.ts'

/** 表头排序方向（默认态即发布时间降序，无独立 default 方向）。 */
export interface SortState {
  key: SortKey
  direction: 'desc' | 'asc'
}

/** 可排序列（与服务端排序枚举一致）。 */
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

/**
 * 表头排序三态状态机：点击新列 → desc；同列 desc → asc；asc → 回默认态
 * （发布时间降序）。每次变化都触发一次新的服务端查询并回到第 1 页。
 * @param currentState - 当前排序态。
 * @param columnKey - 被点击的列。
 * @returns 下一个排序态。
 */
export function nextSortState(currentState: SortState, columnKey: SortKey): SortState {
  if (currentState.key !== columnKey) return { key: columnKey, direction: 'desc' }
  if (currentState.direction === 'desc') return { key: columnKey, direction: 'asc' }
  return { ...DEFAULT_SORT_STATE }
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
