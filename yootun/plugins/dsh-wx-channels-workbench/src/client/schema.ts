/**
 * Host action 载荷 → 页面视图模型的投影层：字段名以 tools 真实 schema 为准
 * （snake_case：work_id / play_count / like_count / publish_time /
 * daily_play_count / daily_like_count / follower_net_count / fans_profile
 * envelope）。缺失与非数值一律 null，不补 0；包装形态（`{ work }` / `{ run }` /
 * `{ trend }`）与顶层平铺两种返回形态都被接受。
 * @module
 */

/** works.list 行（tools 真实字段，缺失为 null）。 */
export interface WorkRow {
  workId: string
  title: string | null
  playCount: number | null
  likeCount: number | null
  publishTime: string | null
}

/** account.overview KPI 总量。 */
export interface OverviewTotals {
  dailyPlayCount: number | null
  dailyLikeCount: number | null
  followerNetCount: number | null
  workCount: number | null
}

/** 粉丝增长趋势日行。 */
export interface FansTrendPoint {
  day: string
  followerTotalCount: number | null
  followerNetCount: number | null
}

/** account.overview 投影。 */
export interface OverviewData {
  totals: OverviewTotals
  fansTrend: FansTrendPoint[]
}

/** 画像一个维度的一行分布。 */
export interface PortraitSlice {
  key: string
  label: string
  count: number
}

/** 粉丝画像五维投影（fans_profile envelope）。 */
export interface FansProfileData {
  age: PortraitSlice[] | null
  gender: PortraitSlice[] | null
  province: PortraitSlice[] | null
  city: PortraitSlice[] | null
  device: PortraitSlice[] | null
}

/** 作品单日趋势点。 */
export interface WorkTrendPoint {
  day: string
  playCount: number | null
  likeCount: number | null
}

/** work.trend 投影。 */
export interface WorkTrendData {
  points: WorkTrendPoint[]
}

/** run.get / collect 记录共用的运行投影。 */
export interface RunView {
  runId: string | null
  attemptId: string | null
  status: string | null
  progress: Record<string, unknown>
  error: string | null
  startedAt: string | null
  finishedAt: string | null
  worksCount: number | null
}

/** browser.status 五态（页面级）。 */
export type BrowserState =
  | 'loading'
  | 'available'
  | 'chrome_missing'
  | 'driver_missing'
  | 'api_error'

/** record 字段读取：对象返回原值，否则 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 数值读取：有限数字原样返回，字符串数字解析，其余 null。 */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** 键读取：snake_case 真实字段（tools schema 单一来源）。 */
function pick(record: Record<string, unknown>, key: string): unknown {
  return record[key]
}

/** 画像一行：key/dim 键、count/value 计数（缺失行丢弃，不补 0）。 */
function portraitSlice(entry: unknown): PortraitSlice | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const count = numberOf(record.count ?? record.value)
  const key = textOf(record.key ?? record.dim)
  if (count === null || key === null) return null
  return { key, label: textOf(record.label) ?? key, count }
}

function portraitDimension(value: unknown): PortraitSlice[] | null {
  if (!Array.isArray(value)) return null
  const slices = value.map(portraitSlice).filter((slice): slice is PortraitSlice => slice !== null)
  return slices.length > 0 ? slices : null
}

/** works.list → WorkRow[]（tools 真实行字段；无 work_id 的行丢弃）。 */
export function readWorkRows(payload: Record<string, unknown>): WorkRow[] {
  const works = payload.works
  if (!Array.isArray(works)) return []
  const rows: WorkRow[] = []
  for (const entry of works) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const workId = textOf(pick(record, 'work_id'))
    if (workId === null) continue
    rows.push({
      workId,
      title: textOf(pick(record, 'title')),
      playCount: numberOf(pick(record, 'play_count')),
      likeCount: numberOf(pick(record, 'like_count')),
      publishTime: textOf(pick(record, 'publish_time')),
    })
  }
  return rows
}

/** work.get / work.trend 共用：`{ work }` 包装或顶层平铺的行对象。 */
function workRowOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return recordOf(payload.work) ?? payload
}

/** work.get → 单行 WorkRow（缺失 work_id 返回 null）。 */
export function readWorkDetail(payload: Record<string, unknown>): WorkRow | null {
  const record = workRowOf(payload)
  if (record === undefined) return null
  const workId = textOf(pick(record, 'work_id'))
  if (workId === null) return null
  return {
    workId,
    title: textOf(pick(record, 'title')),
    playCount: numberOf(pick(record, 'play_count')),
    likeCount: numberOf(pick(record, 'like_count')),
    publishTime: textOf(pick(record, 'publish_time')),
  }
}

/** fans_trend 日行：day + follower_total_count + follower_net_count。 */
function fansTrendPoint(entry: unknown): FansTrendPoint | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const day = textOf(pick(record, 'day'))
  if (day === null) return null
  return {
    day,
    followerTotalCount: numberOf(pick(record, 'follower_total_count')),
    followerNetCount: numberOf(pick(record, 'follower_net_count')),
  }
}

/** account.overview → KPI 总量 + 粉丝趋势日行（metrics.totals / fans_trend）。 */
export function readOverview(payload: Record<string, unknown>): OverviewData {
  const metrics = recordOf(payload.metrics)
  const totals = recordOf(metrics?.totals)
  const fansTrend = recordOf(payload.fans_trend)
  const fansTotals = recordOf(fansTrend?.totals)
  const daily = Array.isArray(fansTrend?.daily) ? fansTrend.daily : []
  return {
    totals: {
      dailyPlayCount: totals === undefined ? null : numberOf(pick(totals, 'daily_play_count')),
      dailyLikeCount: totals === undefined ? null : numberOf(pick(totals, 'daily_like_count')),
      followerNetCount: fansTotals === undefined ? null : numberOf(pick(fansTotals, 'follower_net_count')),
      workCount: totals === undefined ? null : numberOf(pick(totals, 'work_count')),
    },
    fansTrend: daily.map(fansTrendPoint).filter((point): point is FansTrendPoint => point !== null),
  }
}

/** fans.profile.get → fans_profile envelope 五维投影（顶层平铺字段不读取）。 */
export function readFansProfile(payload: Record<string, unknown>): FansProfileData | null {
  const envelope = recordOf(payload.fans_profile)
  if (envelope === undefined) return null
  const data: FansProfileData = {
    age: portraitDimension(envelope.age),
    gender: portraitDimension(envelope.gender),
    province: portraitDimension(envelope.province),
    city: portraitDimension(envelope.city),
    device: portraitDimension(envelope.device),
  }
  const hasAny = data.age !== null || data.gender !== null || data.province !== null
    || data.city !== null || data.device !== null
  return hasAny ? data : null
}

/** work.trend → 趋势日行（形状未定：`{ trend: { daily } }` 或顶层 `daily`，日行 play/like 双命名都接受）。 */
export function readWorkTrend(payload: Record<string, unknown>): WorkTrendData {
  const trend = recordOf(payload.trend) ?? payload
  const daily = Array.isArray(trend.daily) ? trend.daily : []
  const points = daily.map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const day = textOf(pick(record, 'day'))
    if (day === null) return null
    return {
      day,
      playCount: numberOf(record.daily_play_count ?? record.play_count),
      likeCount: numberOf(record.daily_like_count ?? record.like_count),
    }
  }).filter((point): point is WorkTrendPoint => point !== null)
  return { points }
}

/** run.get → 运行投影（远端形状未定：`{ run }` 包装或顶层平铺，snake/驼峰都接受）。 */
export function readRunView(payload: Record<string, unknown>): RunView | null {
  const record = recordOf(payload.run) ?? payload
  const runId = textOf(record.run_id ?? record.runId)
  const status = textOf(record.status ?? record.run_status)
  const startedAt = textOf(record.started_at ?? record.startedAt)
  if (runId === null && status === null && startedAt === null) return null
  const progress = recordOf(record.progress) ?? {}
  const result = recordOf(record.result)
  return {
    runId,
    attemptId: textOf(record.attempt_id ?? record.attemptId),
    status,
    progress,
    error: textOf(record.error),
    startedAt,
    finishedAt: textOf(record.finished_at ?? record.finishedAt),
    worksCount: result === undefined ? numberOf(record.works ?? record.works_count) : numberOf(result.works),
  }
}

/** browser.status → 五态投影（envelope error 或传输失败由调用方映射 api_error）。 */
export function readBrowserState(payload: Record<string, unknown>): BrowserState {
  const chrome = payload.chrome
  const driver = payload.driver
  if (chrome === 'available' && driver === 'available') return 'available'
  if (chrome === 'missing') return 'chrome_missing'
  if (chrome === 'available' && driver === 'missing') return 'driver_missing'
  return 'api_error'
}
