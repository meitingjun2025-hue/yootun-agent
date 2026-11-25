/**
 * Host action 载荷 → 页面视图模型的投影层：字段名以 tools 真实 schema 为准
 * （snake_case：work_id / cover_url / completion_rate_pct / daily_play_count /
 * follower_net_count / fans_profile envelope；work.trend 顶层 snapshots；
 * collectAll.status 顶层 items；overview.accounts 的 summary.totals.fans_totals /
 * follower_total_count / trend_daily（snake_case 指标键）与 accountCount /
 * trendWindow / rowAvailability（camelCase 元数据键））。缺失与非数值一律 null，
 * 不补 0；封面 URL 只接受 http(s)。
 * @module
 */
import type { WxLocaleKey } from './locales.ts'
import { zh } from './locales.ts'
import type { Translate } from './format.ts'

/** works.list / work.get 行（tools 真实字段，缺失为 null）。 */
export interface WorkRow {
  workId: string
  /** 发布文案口径：description 优先，回退系统短标题 title。 */
  title: string | null
  coverUrl: string | null
  durationS: number | null
  publishTime: string | null
  latestCollectedAt: string | null
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  forwardCount: number | null
  followCount: number | null
  completionRatePct: number | null
  avgPlayDurationS: number | null
  wecomLinkClickCount: number | null
  wecomLinkClickUv: number | null
  wecomContactAddCount: number | null
  wecomContactAddUv: number | null
  /** 核心字段缺口（tools 原始 data_gap 对象；null/非对象为 null）。 */
  dataGap: Record<string, unknown> | null
}

/** account.overview 全部视频指标窗口求和（metrics.totals）。 */
export interface OverviewTotals {
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  forwardCount: number | null
  followCount: number | null
  ringsetCount: number | null
  statusRefCount: number | null
  statusCoverCount: number | null
  workCount: number | null
}

/** 关注者增长窗口求和（fans_trend.totals）。 */
export interface FansTotals {
  netCount: number | null
  addCount: number | null
  reduceCount: number | null
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
  fansTotals: FansTotals
  /** 关注者总数时点值（fans_trend.followerTotalCount，窗口内最新非空行）。 */
  followerTotalCount: number | null
  fansTrend: FansTrendPoint[]
}

/** 画像一个维度的一行分布（label 已按维度编码映射为 locale 文案）。 */
export interface PortraitSlice {
  key: string
  label: string
  count: number
}

/** 粉丝画像五维投影（fans_profile envelope）。 */
export interface FansProfileData {
  /** 画像快照日（envelope.day；缺失 null，展示「当前截止昨日」）。 */
  day: string | null
  age: PortraitSlice[] | null
  gender: PortraitSlice[] | null
  province: PortraitSlice[] | null
  city: PortraitSlice[] | null
  device: PortraitSlice[] | null
}

/** 来源分布一行（排除「全部」sourceType=999；播放量缺失保留 null）。 */
export interface TrafficRow {
  name: string
  value: number | null
}

/** 观众留存一个采样点（ratePct 为整数千分比口径的百分比）。 */
export interface RetentionPoint {
  second: number
  ratePct: number | null
}

/** 作品单日多指标行（详情 Modal 按日趋势的 7 个系列）。 */
export interface WorkDailyRow {
  day: string
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  forwardCount: number | null
  followCount: number | null
}

/** 作品单日趋势点（work.trend 主线）。 */
export interface WorkTrendPoint {
  day: string
  playCount: number | null
  likeCount: number | null
}

/** work.trend 投影。 */
export interface WorkTrendData {
  points: WorkTrendPoint[]
}

/** work.get 完整详情投影（tools 真实包装 `{ work, traffic_source, retention_trend, daily_metrics, data_gap }`）。 */
export interface WorkDetailData {
  work: WorkRow | null
  trafficRows: TrafficRow[]
  retentionPoints: RetentionPoint[]
  dailyRows: WorkDailyRow[]
}

/** collectAll.status 的单账号条目（终态含稳定 reason）。 */
export interface BatchItemView {
  accountId: string
  status: string
  reason: string | null
}

/** collectAll.status 投影（逐字段读取，不整包断言）。 */
export interface BatchStatusView {
  ready: boolean
  phase: string | null
  total: number | null
  currentAccountIndex: number | null
  currentAccountId: string | null
  completedCount: number | null
  partialCount: number | null
  failedCount: number | null
  skippedCount: number | null
  items: BatchItemView[]
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

/** 封面/头像 URL 防御：仅 http(s)，解析失败返回 null。 */
function safeHttpUrl(value: unknown): string | null {
  const raw = textOf(value)
  if (raw === null) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : null
  } catch {
    return null
  }
}

/** data_gap 原始对象（非对象为 null）。 */
function gapOf(value: unknown): Record<string, unknown> | null {
  return recordOf(value) ?? null
}

/** works.list / work.get 行字段投影（description 优先的标题口径；封面 http(s) 防御）。 */
function workRowOf(record: Record<string, unknown>): WorkRow | null {
  const workId = textOf(pick(record, 'work_id'))
  if (workId === null) return null
  const description = textOf(pick(record, 'description'))
  const title = textOf(pick(record, 'title'))
  return {
    workId,
    title: description ?? title,
    coverUrl: safeHttpUrl(pick(record, 'cover_url')),
    durationS: numberOf(pick(record, 'duration_s')),
    publishTime: textOf(pick(record, 'publish_time')),
    latestCollectedAt: textOf(pick(record, 'latest_collected_at')),
    playCount: numberOf(pick(record, 'play_count')),
    likeCount: numberOf(pick(record, 'like_count')),
    favoriteCount: numberOf(pick(record, 'favorite_count')),
    commentCount: numberOf(pick(record, 'comment_count')),
    shareCount: numberOf(pick(record, 'share_count')),
    forwardCount: numberOf(pick(record, 'forward_count')),
    followCount: numberOf(pick(record, 'follow_count')),
    completionRatePct: numberOf(pick(record, 'completion_rate_pct')),
    avgPlayDurationS: numberOf(pick(record, 'avg_play_duration_s')),
    wecomLinkClickCount: numberOf(pick(record, 'wecom_link_click_count')),
    wecomLinkClickUv: numberOf(pick(record, 'wecom_link_click_uv')),
    wecomContactAddCount: numberOf(pick(record, 'wecom_contact_add_count')),
    wecomContactAddUv: numberOf(pick(record, 'wecom_contact_add_uv')),
    dataGap: gapOf(pick(record, 'data_gap')),
  }
}

/** works.list → WorkRow[]（tools 真实行字段；无 work_id 的行丢弃）。 */
export function readWorkRows(payload: Record<string, unknown>): WorkRow[] {
  const works = payload.works
  if (!Array.isArray(works)) return []
  const rows: WorkRow[] = []
  for (const entry of works) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const row = workRowOf(record)
    if (row !== null) rows.push(row)
  }
  return rows
}

/** work.get → 详情四段投影（tools 真实形状 `{ work, traffic_source, retention_trend, daily_metrics }`）。 */
export function readWorkDetail(payload: Record<string, unknown>): WorkDetailData {
  const workRecord = recordOf(payload.work)
  return {
    work: workRecord === undefined ? null : workRowOf(workRecord),
    trafficRows: readTrafficRows(recordOf(payload.traffic_source)),
    retentionPoints: readRetentionPoints(recordOf(payload.retention_trend)),
    dailyRows: readDailyRows(payload.daily_metrics),
  }
}

/** 来源分布行规范化：排除「全部」（sourceType=999）；缺失播放量保留 null。 */
function readTrafficRows(trafficSource: Record<string, unknown> | undefined): TrafficRow[] {
  const rows = trafficSource !== undefined && Array.isArray(trafficSource.rows) ? trafficSource.rows : []
  const result: TrafficRow[] = []
  for (const entry of rows) {
    const record = recordOf(entry)
    if (record === undefined) continue
    if (record.sourceType === 999) continue
    const name = textOf(record.name) ?? textOf(record.sourceKey)
    if (name === null) continue
    result.push({ name, value: numberOf(record.playCount) })
  }
  return result
}

/** 留存行规范化：second 数值行；rate_pct / ratePct 两种历史键都读，缺失保留 null。 */
function readRetentionPoints(retentionTrend: Record<string, unknown> | undefined): RetentionPoint[] {
  const points = retentionTrend !== undefined && Array.isArray(retentionTrend.points) ? retentionTrend.points : []
  const result: RetentionPoint[] = []
  for (const entry of points) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const second = numberOf(record.second)
    if (second === null) continue
    const rate = numberOf(record.rate_pct) ?? numberOf(record.ratePct)
    result.push({ second, ratePct: rate === null ? null : Math.round(rate) })
  }
  return result
}

/** 按日快照行：day + 7 个 daily_* 系列（缺 work_id 无关的行不进图表，day 缺失丢弃）。 */
function readDailyRows(value: unknown): WorkDailyRow[] {
  const rows = Array.isArray(value) ? value : []
  const result: WorkDailyRow[] = []
  for (const entry of rows) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const day = textOf(pick(record, 'day'))
    if (day === null) continue
    result.push({
      day,
      playCount: numberOf(pick(record, 'daily_play_count')),
      likeCount: numberOf(pick(record, 'daily_like_count')),
      favoriteCount: numberOf(pick(record, 'daily_favorite_count')),
      commentCount: numberOf(pick(record, 'daily_comment_count')),
      shareCount: numberOf(pick(record, 'daily_share_count')),
      forwardCount: numberOf(pick(record, 'daily_forward_count')),
      followCount: numberOf(pick(record, 'daily_follow_count')),
    })
  }
  return result
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

/** totals 记录 → 11 字段投影（snake_case tools 键与 camelCase 视图键一一对应）。 */
function readMetricTotals(record: Record<string, unknown> | undefined): OverviewTotals {
  const field = (key: string): number | null =>
    record === undefined ? null : numberOf(pick(record, key))
  return {
    playCount: field('daily_play_count'),
    likeCount: field('daily_like_count'),
    favoriteCount: field('daily_favorite_count'),
    commentCount: field('daily_comment_count'),
    shareCount: field('daily_share_count'),
    forwardCount: field('daily_forward_count'),
    followCount: field('daily_follow_count'),
    ringsetCount: field('daily_ringset_count'),
    statusRefCount: field('daily_status_ref_count'),
    statusCoverCount: field('daily_status_cover_count'),
    workCount: field('work_count'),
  }
}

/** fans_trend.totals 记录 → 3 字段投影。 */
function readFansTotals(record: Record<string, unknown> | undefined): FansTotals {
  const field = (key: string): number | null =>
    record === undefined ? null : numberOf(pick(record, key))
  return {
    netCount: field('follower_net_count'),
    addCount: field('follower_add_count'),
    reduceCount: field('follower_reduce_count'),
  }
}

/** account.overview → 全部视频指标 + 关注者增长（metrics.totals / fans_trend）。 */
export function readOverview(payload: Record<string, unknown>): OverviewData {
  const metrics = recordOf(payload.metrics)
  const fansTrend = recordOf(payload.fans_trend)
  const daily = Array.isArray(fansTrend?.daily) ? fansTrend.daily : []
  const field = (record: Record<string, unknown> | undefined, key: string): number | null =>
    record === undefined ? null : numberOf(pick(record, key))
  return {
    totals: readMetricTotals(recordOf(metrics?.totals)),
    fansTotals: readFansTotals(recordOf(fansTrend?.totals)),
    followerTotalCount: field(fansTrend, 'followerTotalCount'),
    fansTrend: daily.map(fansTrendPoint).filter((point): point is FansTrendPoint => point !== null),
  }
}

/** account_metrics 源是否有任一真实值（缺失不补 0，供本地推导回退）。 */
export function overviewTotalsHaveData(totals: OverviewTotals): boolean {
  return totals.playCount !== null || totals.likeCount !== null || totals.workCount !== null
}

/** fans_trend 源是否有数据：任一汇总非 null 或趋势日行非空。 */
export function overviewFansHaveData(data: OverviewData): boolean {
  return data.fansTotals.netCount !== null || data.followerTotalCount !== null || data.fansTrend.length > 0
}

/** 未知编码统一显示「未知」（官方拼写 `unknow`，兼容 `unknown`）。 */
function isUnknownKey(key: string): boolean {
  return key === 'unknow' || key === 'unknown'
}

/** 画像维度标签：编码 → locale 文案（gender 1/2、age fage_*、device 1/2；省市用官方名）。 */
function profileLabel(dimension: string, key: string, rawLabel: string | null, t: Translate): string {
  if (isUnknownKey(key)) return t('portrait.unknown')
  if (dimension === 'gender') {
    if (key === '1') return t('portrait.genderMale')
    if (key === '2') return t('portrait.genderFemale')
    return t('portrait.unknown')
  }
  if (dimension === 'age') {
    const range = key.replace(/^fage_/u, '')
    if (range.endsWith('_+')) return t('portrait.agePlus', { range: range.slice(0, -2).replace(/^0+(?=\d)/u, '') })
    return t('portrait.ageRange', { range: range.split('_').map(part => part.replace(/^0+(?=\d)/u, '')).join('-') })
  }
  if (dimension === 'device') {
    if (key === '1') return t('portrait.deviceIos')
    if (key === '2') return t('portrait.deviceAndroid')
    return t('portrait.deviceOther', { code: key })
  }
  return rawLabel ?? key
}

/** 画像一行：key/dim 键、count/value 计数；`@_all` 汇总行与缺失计数行丢弃。 */
function portraitSlice(entry: unknown, dimension: string, t: Translate): PortraitSlice | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const key = textOf(record.key ?? record.dim)
  if (key === null || key === '@_all') return null
  const count = numberOf(record.count ?? record.value)
  if (count === null) return null
  return { key, label: profileLabel(dimension, key, textOf(record.label), t), count }
}

/** 画像一个维度：空分布保留 null（渲染「该画像维度本次未提供」）。 */
function portraitDimension(value: unknown, dimension: string, t: Translate): PortraitSlice[] | null {
  if (!Array.isArray(value)) return null
  const slices = value.map(entry => portraitSlice(entry, dimension, t)).filter((slice): slice is PortraitSlice => slice !== null)
  return slices.length > 0 ? slices : null
}

/** fans.profile.get → fans_profile envelope 五维投影（顶层平铺字段不读取）。 */
export function readFansProfile(payload: Record<string, unknown>, t: Translate): FansProfileData | null {
  const envelope = recordOf(payload.fans_profile)
  if (envelope === undefined) return null
  const data: FansProfileData = {
    day: textOf(envelope.day),
    age: portraitDimension(envelope.age, 'age', t),
    gender: portraitDimension(envelope.gender, 'gender', t),
    province: portraitDimension(envelope.province, 'province', t),
    city: portraitDimension(envelope.city, 'city', t),
    device: portraitDimension(envelope.device, 'device', t),
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

/** collectAll.status → 批量投影（items 只留 accountId/status/reason 三个渲染字段）。 */
export function readBatchStatus(payload: Record<string, unknown>): BatchStatusView {
  const rawItems = Array.isArray(payload.items) ? payload.items : []
  const items: BatchItemView[] = []
  for (const entry of rawItems) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const accountId = textOf(record.accountId)
    if (accountId === null) continue
    items.push({
      accountId,
      status: textOf(record.status) ?? 'unknown',
      reason: textOf(record.reason),
    })
  }
  const numberField = (key: string): number | null => numberOf(payload[key])
  return {
    ready: payload.ready === true,
    phase: textOf(payload.phase),
    total: numberField('total'),
    currentAccountIndex: numberField('currentAccountIndex'),
    currentAccountId: textOf(payload.currentAccountId),
    completedCount: numberField('completedCount'),
    partialCount: numberField('partialCount'),
    failedCount: numberField('failedCount'),
    skippedCount: numberField('skippedCount'),
    items,
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

/** 详情页与摘要卡共用的核心缺口白名单（is_original 等非核心字段不计）。 */
export const CORE_GAP_FIELDS: ReadonlySet<string> = new Set([
  'traffic_source',
  'retention_trend',
  'daily_metrics',
  'play_count',
  'like_count',
  'favorite_count',
  'comment_count',
  'share_count',
  'forward_count',
  'follow_count',
  'completion_rate_pct',
  'avg_play_duration_s',
  'cover_url',
  'publish_time',
  'duration_s',
])

/** 缺口字段 → 词典键（白名单外字段返回 null，由调用方原样透出）。 */
export function gapFieldKey(field: string): WxLocaleKey | null {
  const key = `gap.${field}` as WxLocaleKey
  return zh[key] !== undefined ? key : null
}

/** overview.accounts 的汇总求和（summary.totals / accounts[].metrics.totals 共用键集）。 */
export interface AccountsOverviewTotals {
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  shareCount: number | null
  forwardCount: number | null
  followCount: number | null
  ringsetCount: number | null
  statusRefCount: number | null
  statusCoverCount: number | null
  workCount: number | null
}

/** 关注者增长窗口求和（summary.fans_totals / accounts[].fans_trend.totals）。 */
export interface AccountsFansTotals {
  netCount: number | null
  addCount: number | null
  reduceCount: number | null
}

/** 起止日闭区间（YYYY-MM-DD；summary.window / summary.trendWindow 共用形状）。 */
export interface AccountsDayRange {
  startDay: string | null
  endDay: string | null
}

/** overview.accounts 顶层 summary 投影。 */
export interface AccountsOverviewSummary {
  /** 过滤后的账号数（= rows.length 的服务端口径）。 */
  accountCount: number | null
  /** 过滤前未删除账号总数（「共 N 个账号」）。 */
  accountTotal: number | null
  window: AccountsDayRange
  totals: AccountsOverviewTotals
  fansTotals: AccountsFansTotals
  /** 各账号最新非空关注者总数之和（近似合计；全部缺失 null）。 */
  followerTotalCount: number | null
  trendWindow: AccountsDayRange
  /** 合计趋势逐日行（day + follower_total_count；缺失日 null，行不省略）。 */
  trendDaily: Array<{ day: string; followerTotalCount: number | null }>
  /** 汇总窗口内有日表行的去重日历天数（分源）。 */
  daysObserved: { accountMetrics: number | null; fansTrend: number | null }
  /** 分源可用性（ok / partial / no_data；缺失 null）。 */
  availability: { accountMetrics: string | null; fansTrend: string | null }
}

/** overview.accounts 单账号行投影。 */
export interface AccountsOverviewRow {
  accountId: string
  nickname: string | null
  avatar: string | null
  sessionStatus: string | null
  lastCollectedAt: string | null
  feedCount: number | null
  /** 窗口内最新非空关注者总数（服务端已回退账号记录值；仍可能 null）。 */
  followerTotalCount: number | null
  /** metrics.totals（含 work_count 投影；单账号模式 10 卡数据源）。 */
  totals: AccountsOverviewTotals
  /** fans_trend.totals（单账号模式 4 卡数据源）。 */
  fansTotals: AccountsFansTotals
  availability: { accountMetrics: string | null; fansTrend: string | null }
}

/** overview.accounts 顶层投影。 */
export interface AccountsOverviewData {
  /** 回传的入参窗口枚举（yesterday / last_7d / last_30d / custom）。 */
  window: string | null
  summary: AccountsOverviewSummary
  rows: AccountsOverviewRow[]
}

/** 单日范围记录读取（startDay / endDay 缺失为 null）。 */
function readDayRange(record: Record<string, unknown> | undefined): AccountsDayRange {
  return {
    startDay: record === undefined ? null : textOf(pick(record, 'startDay')),
    endDay: record === undefined ? null : textOf(pick(record, 'endDay')),
  }
}

/** overview.accounts → 汇总 + 逐账号行（缺失不补 0；缺 account_id 的行丢弃）。 */
export function readAccountsOverview(payload: Record<string, unknown>): AccountsOverviewData {
  const summaryRecord = recordOf(payload.summary)
  const availability = recordOf(summaryRecord?.availability)
  const daysObserved = recordOf(summaryRecord?.daysObserved)
  const trendRows = Array.isArray(summaryRecord?.trend_daily) ? summaryRecord.trend_daily : []
  const trendDaily: AccountsOverviewSummary['trendDaily'] = []
  for (const entry of trendRows) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const day = textOf(pick(record, 'day'))
    if (day === null) continue
    trendDaily.push({ day, followerTotalCount: numberOf(pick(record, 'follower_total_count')) })
  }
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : []
  const rows: AccountsOverviewRow[] = []
  for (const entry of accounts) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const accountId = textOf(pick(record, 'account_id'))
    if (accountId === null) continue
    const metrics = recordOf(record.metrics)
    const fansTrend = recordOf(record.fans_trend)
    rows.push({
      accountId,
      nickname: textOf(pick(record, 'nickname')),
      avatar: safeHttpUrl(pick(record, 'avatar')),
      sessionStatus: textOf(pick(record, 'session_status')),
      lastCollectedAt: textOf(pick(record, 'last_collected_at')),
      feedCount: numberOf(pick(record, 'feed_count')),
      followerTotalCount: numberOf(pick(record, 'follower_total_count')),
      totals: readMetricTotals(recordOf(metrics?.totals)),
      fansTotals: readFansTotals(recordOf(fansTrend?.totals)),
      availability: {
        accountMetrics: metrics === undefined ? null : textOf(pick(metrics, 'rowAvailability')),
        fansTrend: fansTrend === undefined ? null : textOf(pick(fansTrend, 'rowAvailability')),
      },
    })
  }
  const field = (key: string): number | null =>
    summaryRecord === undefined ? null : numberOf(pick(summaryRecord, key))
  return {
    window: textOf(payload.window),
    summary: {
      accountCount: field('accountCount'),
      accountTotal: field('accountTotal'),
      window: readDayRange(recordOf(summaryRecord?.window)),
      totals: readMetricTotals(recordOf(summaryRecord?.totals)),
      fansTotals: readFansTotals(recordOf(summaryRecord?.fans_totals)),
      followerTotalCount: field('followerTotalCount'),
      trendWindow: readDayRange(recordOf(summaryRecord?.trendWindow)),
      trendDaily,
      daysObserved: {
        accountMetrics: daysObserved === undefined ? null : numberOf(pick(daysObserved, 'account_metrics')),
        fansTrend: daysObserved === undefined ? null : numberOf(pick(daysObserved, 'fans_trend')),
      },
      availability: {
        accountMetrics: availability === undefined ? null : textOf(pick(availability, 'account_metrics')),
        fansTrend: availability === undefined ? null : textOf(pick(availability, 'fans_trend')),
      },
    },
    rows,
  }
}
