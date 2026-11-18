/**
 * Host action 载荷 → 页面视图模型的投影层：字段名以 tools 真实 schema 为准
 * （snake_case：work_id / play_count / like_count / publish_time /
 * daily_play_count / daily_like_count / follower_net_count / fans_profile
 * envelope；work.trend 顶层 snapshots；run.get 顶层 `{ run, batches }`）。
 * 缺失与非数值一律 null，不补 0。
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

/** 远端 run 的一条批次行（workbench_wx_collect_run_get）。 */
export interface RunBatchRow {
  batchNo: number | null
  batchType: string | null
  batchStatus: string | null
  itemCount: number | null
  succeededCount: number | null
  failedCount: number | null
}

/** run.get 的运行投影（tools 真实形状：顶层 `{ run, batches }`）。 */
export interface RunView {
  runId: string | null
  accountId: string | null
  status: string | null
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
  expectedWorkCount: number | null
  succeededWorkCount: number | null
  failedWorkCount: number | null
  batches: RunBatchRow[]
}

/** 服务端 availability 单源取值（缺失为 null，调用方回退本地推导）。 */
export interface OverviewAvailability {
  accountMetrics: string | null
  fansTrend: string | null
  fansProfile: string | null
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

/**
 * work.trend → 趋势日行（tools 真实形状：顶层 `{ account_id, work_id,
 * snapshots: [...] }`，snapshot 行为 day + daily_play_count / daily_like_count）。
 */
export function readWorkTrend(payload: Record<string, unknown>): WorkTrendData {
  const snapshots = Array.isArray(payload.snapshots) ? payload.snapshots : []
  const points = snapshots.map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const day = textOf(pick(record, 'day'))
    if (day === null) return null
    return {
      day,
      playCount: numberOf(pick(record, 'daily_play_count')),
      likeCount: numberOf(pick(record, 'daily_like_count')),
    }
  }).filter((point): point is WorkTrendPoint => point !== null)
  return { points }
}

/** 一条批次行：batch_no / batch_type / batch_status / item_count / 对象数组取长度。 */
function runBatchRow(entry: unknown): RunBatchRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const objects = (key: string): number | null => {
    const value = record[key]
    return Array.isArray(value) ? value.length : null
  }
  const batchNo = numberOf(record.batch_no)
  const batchType = textOf(record.batch_type)
  const batchStatus = textOf(record.batch_status)
  const itemCount = numberOf(record.item_count)
  const succeeded = objects('succeeded_objects')
  const failed = objects('failed_objects')
  if (batchNo === null && batchType === null && batchStatus === null) return null
  return { batchNo, batchType, batchStatus, itemCount, succeededCount: succeeded, failedCount: failed }
}

/**
 * run.get → 运行投影（tools 真实形状：顶层 `{ run: {...}, batches: [...] }`；
 * run 字段为 run_id / account_id / status / error_code / started_at /
 * finished_at / expected_work_count / succeeded_work_count /
 * failed_work_count）。无 `run` 对象的载荷返回 null（调用方按未命中处理）。
 */
export function readRunView(payload: Record<string, unknown>): RunView | null {
  const run = recordOf(payload.run)
  if (run === undefined) return null
  const rawBatches = Array.isArray(payload.batches) ? payload.batches : []
  return {
    runId: textOf(pick(run, 'run_id')),
    accountId: textOf(pick(run, 'account_id')),
    status: textOf(pick(run, 'status')),
    errorCode: textOf(pick(run, 'error_code')),
    startedAt: textOf(pick(run, 'started_at')),
    finishedAt: textOf(pick(run, 'finished_at')),
    expectedWorkCount: numberOf(pick(run, 'expected_work_count')),
    succeededWorkCount: numberOf(pick(run, 'succeeded_work_count')),
    failedWorkCount: numberOf(pick(run, 'failed_work_count')),
    batches: rawBatches.map(runBatchRow).filter((row): row is RunBatchRow => row !== null),
  }
}

/**
 * account.overview → 服务端 availability 三源取值（availability.account_metrics
 * / fans_trend / fans_profile）；字段缺失保留 null（调用方回退本地推导）。
 */
export function readOverviewAvailability(payload: Record<string, unknown>): OverviewAvailability {
  const availability = recordOf(payload.availability)
  return {
    accountMetrics: availability === undefined ? null : textOf(pick(availability, 'account_metrics')),
    fansTrend: availability === undefined ? null : textOf(pick(availability, 'fans_trend')),
    fansProfile: availability === undefined ? null : textOf(pick(availability, 'fans_profile')),
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
