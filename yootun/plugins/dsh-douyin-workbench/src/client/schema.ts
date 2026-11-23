/**
 * Host action 载荷 → 页面视图模型的投影层：字段名以 Host/Workbench 真实
 * schema 为准（works/work.get 等直通 snake_case；overview/analysis/trend 挂
 * envelope 键；schedule/report 在 `data` 下）。缺失与非数值一律 null 不补 0；
 * URL 只接受白名单。播放量趋势/受众画像等展示口径由调用方决定，本层只投影。
 * @module
 */
import { safeHttpUrl, safeWorkUrl } from './format.ts'

/** record 读取：对象返回原值，否则 undefined。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 数值读取：有限数字原样返回，其余 null（缺失不补 0）。 */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** 文本读取：非字符串或 trim 后空串为 null。 */
export function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text === '' ? null : text
}

/** 布尔读取：仅字面 true 为 true，其余 false。 */
export function booleanOf(value: unknown): boolean {
  return value === true
}

/** 数组读取：非数组为空数组。 */
export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// ---- browser.status / accounts.list / 登录 / 采集 ----

/** browser.status 五态（页面级）。 */
export type BrowserState = 'loading' | 'available' | 'chrome_missing' | 'driver_missing' | 'api_error'

/** accounts.list 账号行投影。 */
export interface AccountRow {
  accountId: string
  nickname: string | null
  avatar: string | null
  fanCount: number | null
  sessionStatus: string
  sessionCheckedAt: string | null
  lastCollectedAt: string | null
  ownerName: string | null
  deleteState: string
  isPending: boolean
}

/** account.beginLogin / account.loginStatus 投影（五字段白名单）。 */
export interface LoginView {
  loginKey: string
  status: string
  accountId: string | null
  error: string | null
  saveError: string | null
}

/** collect.status 的 collect 投影（RunRecord 白名单视图）。 */
export interface CollectView {
  accountId: string
  status: string
  phase: string | null
  progress: Record<string, unknown>
  error: string | null
  finishedAt: string | null
}

/** collectAll.status 投影（批量面板数据源）。 */
export interface BatchItemView {
  accountId: string
  status: string
  reason: string | null
}

export interface BatchView {
  status: string | null
  phase: string | null
  total: number
  runnableTotal: number
  runnableDone: number
  completedCount: number
  partialCount: number
  failedCount: number
  skippedCount: number
  probedCount: number
  currentAccountId: string | null
  items: BatchItemView[]
}

/** browser.status → 五态投影（传输失败由调用方映射 api_error）。 */
export function readBrowserState(payload: Record<string, unknown>): BrowserState {
  const chrome = payload.chromeAvailable === true
  const driver = payload.driverAvailable === true
  if (chrome && driver) return 'available'
  if (!chrome) return 'chrome_missing'
  if (chrome && !driver) return 'driver_missing'
  return 'api_error'
}

/** accounts.list → AccountRow[]（无效行丢弃）。 */
export function readAccounts(payload: Record<string, unknown>): AccountRow[] {
  const rows: AccountRow[] = []
  for (const entry of arrayOf(payload.accounts)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const accountId = textOf(record.accountId)
    if (accountId === null) continue
    rows.push({
      accountId,
      nickname: textOf(record.nickname),
      avatar: safeHttpUrl(record.avatar),
      fanCount: numberOf(record.fanCount),
      sessionStatus: textOf(record.sessionStatus) ?? 'unknown',
      sessionCheckedAt: textOf(record.sessionCheckedAt),
      lastCollectedAt: textOf(record.lastCollectedAt),
      ownerName: textOf(record.ownerName),
      deleteState: textOf(record.deleteState) ?? 'none',
      isPending: booleanOf(record.isPending),
    })
  }
  return rows
}

/** account.loginStatus → LoginView（缺失 run 给 idle 形态）。 */
export function readLogin(payload: Record<string, unknown>): LoginView {
  const record = recordOf(payload.login)
  const key = record !== undefined ? textOf(record.loginKey) ?? '' : ''
  return {
    loginKey: key,
    status: record !== undefined ? textOf(record.status) ?? 'idle' : 'idle',
    accountId: record !== undefined ? textOf(record.accountId) : null,
    error: record !== undefined ? textOf(record.error) : null,
    saveError: record !== undefined ? textOf(record.saveError) : null,
  }
}

/** collect.status → CollectView | null（含 G-2 恢复投影 recovery/lastRun）。 */
export function readCollectStatus(payload: Record<string, unknown>): {
  collect: CollectView | null
  recovery: string | null
  lastRun: CollectView | null
} {
  const lastRunRecord = recordOf(payload.lastRun)
  const lastRun = lastRunRecord === undefined ? null : runViewOf(lastRunRecord)
  if (payload.collect === null || payload.collect === undefined) {
    return { collect: null, recovery: textOf(payload.recovery), lastRun }
  }
  const record = recordOf(payload.collect)
  return { collect: record === undefined ? null : runViewOf(record), recovery: null, lastRun }
}

/** RunRecord → 白名单视图。 */
function runViewOf(record: Record<string, unknown>): CollectView {
  const progress = recordOf(record.progress)
  return {
    accountId: textOf(record.accountId) ?? '',
    status: textOf(record.status) ?? 'unknown',
    phase: textOf(record.phase),
    progress: progress ?? {},
    error: textOf(record.error),
    finishedAt: textOf(record.finishedAt),
  }
}

/** collectAll.status → BatchView。 */
export function readBatchStatus(payload: Record<string, unknown>): BatchView {
  const record = recordOf(payload.batch) ?? payload
  const items: BatchItemView[] = []
  for (const entry of arrayOf(record.items)) {
    const item = recordOf(entry)
    if (item === undefined) continue
    const accountId = textOf(item.accountId)
    if (accountId === null) continue
    items.push({ accountId, status: textOf(item.status) ?? 'unknown', reason: textOf(item.reason) })
  }
  return {
    status: textOf(record.status),
    phase: textOf(record.phase),
    total: numberOf(record.total) ?? 0,
    runnableTotal: numberOf(record.runnableTotal) ?? 0,
    runnableDone: numberOf(record.runnableDone) ?? 0,
    completedCount: numberOf(record.completedCount) ?? 0,
    partialCount: numberOf(record.partialCount) ?? 0,
    failedCount: numberOf(record.failedCount) ?? 0,
    skippedCount: numberOf(record.skippedCount) ?? 0,
    probedCount: numberOf(record.probedCount) ?? 0,
    currentAccountId: textOf(record.currentAccountId),
    items,
  }
}

// ---- 作品（works.list / work.get / work.trend） ----

/** works.list 行（snake_case 真实字段；缺失为 null）。 */
export interface WorkRow {
  work_id: string
  title: string | null
  url: string | null
  cover_url: string | null
  duration_s: number | null
  publish_time: string | null
  latest_collected_at: string | null
  play_count: number | null
  collect_count: number | null
  like_count: number | null
  comment_count: number | null
  bounce_rate_2s_pct: number | null
  completion_rate_5s_pct: number | null
  completion_rate_pct: number | null
  fans_gain_count: number | null
  avg_watch_duration_s: number | null
  avg_view_proportion_pct: number | null
  promoted: boolean
  visibility: string | null
  data_gap: Record<string, unknown> | null
}

/** works.list → WorkRow[]（无 work_id 的行丢弃）。 */
export function readWorkRows(payload: Record<string, unknown>): WorkRow[] {
  const rows: WorkRow[] = []
  for (const entry of arrayOf(payload.works)) {
    const row = workRowOf(entry)
    if (row !== null) rows.push(row)
  }
  return rows
}

/** 单行投影（work.get 的 work 字段同构）。 */
function workRowOf(entry: unknown): WorkRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const workId = textOf(record.work_id)
  if (workId === null) return null
  return {
    work_id: workId,
    title: textOf(record.title),
    url: safeWorkUrl(record.url),
    cover_url: safeHttpUrl(record.cover_url),
    duration_s: numberOf(record.duration_s),
    publish_time: textOf(record.publish_time),
    latest_collected_at: textOf(record.latest_collected_at),
    play_count: numberOf(record.play_count),
    collect_count: numberOf(record.collect_count),
    like_count: numberOf(record.like_count),
    comment_count: numberOf(record.comment_count),
    bounce_rate_2s_pct: numberOf(record.bounce_rate_2s_pct),
    completion_rate_5s_pct: numberOf(record.completion_rate_5s_pct),
    completion_rate_pct: numberOf(record.completion_rate_pct),
    fans_gain_count: numberOf(record.fans_gain_count),
    avg_watch_duration_s: numberOf(record.avg_watch_duration_s),
    avg_view_proportion_pct: numberOf(record.avg_view_proportion_pct),
    promoted: booleanOf(record.promoted),
    visibility: textOf(record.visibility),
    data_gap: recordOf(record.data_gap) ?? null,
  }
}

/** 受众一个维度的分布行。 */
export interface DistRow {
  key: string
  pct: number | null
}

/** 投流记录投影（camelCase，服务端 Decimal 转字符串原样保留）。 */
export interface PromotionView {
  id: string
  playCount: string | null
  costAmount: string | null
  fansCount: string | null
  durationHours: string | null
}

/** work.get 详情投影。 */
export interface WorkDetailView {
  work: WorkRow | null
  /** 流量来源分布（原始 key/label + share_pct；share_pct 降序前 5）。 */
  trafficRows: { sourceKey: string; label: string | null; value: number | null }[]
  /** 观看趋势 current 曲线（retention_trend.current）。 */
  retentionCurrent: unknown
  /** 跳出曲线（retention_bounce，结构与留存同族）。 */
  retentionBounce: unknown
  audience: {
    gender: DistRow[] | null
    age: DistRow[] | null
    province: DistRow[] | null
    city_level: DistRow[] | null
  }
  promotion: PromotionView | null
  hotwords: string[]
  searchKeywords: string[]
}

/** 字符串优先、数值回退的展示文本（投流数值字段双形态下发兼容）。 */
function numTextOf(value: unknown): string | null {
  return textOf(value) ?? (numberOf(value) !== null ? String(numberOf(value)) : null)
}

/** work.get → 详情投影（`data` envelope 直通）。 */
export function readWorkDetail(payload: Record<string, unknown>): WorkDetailView {
  const data = recordOf(payload.data) ?? {}
  const workRecord = recordOf(data.work)
  const audience = recordOf(data.audience)
  const promotion = recordOf(data.promotion)
  // traffic_source 顶层即条目数组（[{source_key, source_label, play_count, source_type}…]），
  // 不是 {rows: […]} 包装——误读包装曾致流量来源恒空（2026-11-23 真机）。
  const trafficSource = arrayOf(workRecord?.traffic_source)
  const trafficRows: { sourceKey: string; label: string | null; value: number | null }[] = []
  for (const entry of trafficSource) {
    const row = recordOf(entry)
    if (row === undefined) continue
    if ((row.source_type ?? row.sourceType) === 999) continue
    const sourceKey = textOf(row.source_key)
    if (sourceKey === null) continue
    // 旧 convertSource 同口径：占比字段是 share_pct（0..100 百分比）
    trafficRows.push({ sourceKey, label: textOf(row.source_label), value: numberOf(row.share_pct) })
  }
  trafficRows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  trafficRows.splice(5)
  return {
    work: workRecord === undefined ? null : workRowOf(workRecord),
    trafficRows,
    retentionCurrent: workRecord === undefined ? undefined : workRecord.retention_trend,
    retentionBounce: workRecord === undefined ? undefined : workRecord.retention_bounce,
    audience: {
      gender: distRows(audience?.gender),
      age: distRows(audience?.age),
      province: distRows(audience?.province),
      city_level: distRows(audience?.city_level),
    },
    promotion: promotion === undefined ? null : {
      id: textOf(promotion.id) ?? '',
      // 服务端数值字段可能以 number 下发（真机 2026-11-23：播放量/粉丝量显示 —）：
      // textOf 之外回退 numberOf 转字符串，金额/时长同口径加固。
      playCount: numTextOf(promotion.playCount),
      costAmount: numTextOf(promotion.costAmount),
      fansCount: numTextOf(promotion.fansCount),
      durationHours: numTextOf(promotion.durationHours),
    },
    hotwords: arrayOf(data.hotwords).map(item => {
      const row = recordOf(item)
      return row !== undefined ? textOf(row.word) : null
    }).filter((word): word is string => word !== null),
    searchKeywords: arrayOf(workRecord?.search_keywords).map(item => {
      const row = recordOf(item)
      return row !== undefined ? textOf(row.keyword) : null
    }).filter((word): word is string => word !== null),
  }
}

/** 受众维度分布（空分布保留 null；调用方呈现「数据不足」）。 */
function distRows(value: unknown): DistRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: DistRow[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const key = textOf(record.key)
    if (key === null) continue
    rows.push({ key, pct: numberOf(record.pct) })
  }
  return rows.length > 0 ? rows : null
}

/** 趋势日点（account.trend / work.trend 共构：day + value）。 */
export interface TrendPoint {
  day: string
  value: number | null
}

/** account.trend → 趋势点（窗口 30 天由调用方裁剪）。 */
/** account.trend → 趋势点（trend.points 形态：`{day, value}`）。 */
export function readAccountTrend(payload: Record<string, unknown>): TrendPoint[] {
  const trend = recordOf(payload.trend)
  return trendPointsOf(trend?.points)
}

/** work.trend → 趋势点（snapshots 形态）。 */
export function readWorkTrend(payload: Record<string, unknown>): TrendPoint[] {
  const data = recordOf(payload.data)
  return snapshotTrendPointsOf(data?.snapshots)
}

/**
 * account.trend 的 points → 日点：行形态为 ``{day, value}``（与 work.trend 快照行
 * 不同族，二者不可共用投影——共用曾致单账号趋势恒空）；无 day 或非数值的行丢弃。
 * @param value - trend.points 原始数组。
 * @returns 按服务端顺序的日点（value 缺失为 null）。
 */
function trendPointsOf(value: unknown): TrendPoint[] {
  const rows: TrendPoint[] = []
  for (const entry of arrayOf(value)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const day = textOf(record.day)
    if (day === null) continue
    rows.push({ day, value: numberOf(record.value) })
  }
  return rows
}

/**
 * 快照行 → 日点（旧 snapshotTrendPoints 同构）：值为 ``play_count``（快照行无
 * value 字段）；同日多次采集按 captured_at 取最大（日收盘语义）；day 缺失回退
 * captured_at + 8h 的上海自然日。窗口锚点随最后一次采集走，不锚真今天。
 * @param value - work.trend 的 snapshots 原始数组。
 * @returns 按自然日升序的日点。
 */
function snapshotTrendPointsOf(value: unknown): TrendPoint[] {
  const byDay = new Map<string, { value: number; capturedMs: number }>()
  for (const entry of arrayOf(value)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const capturedAt = textOf(record.captured_at)
    const play = numberOf(record.play_count)
    if (capturedAt === null || play === null) continue
    const capturedMs = Date.parse(capturedAt)
    if (!Number.isFinite(capturedMs)) continue
    const day = textOf(record.day)
      ?? new Date(capturedMs + 8 * 3_600_000).toISOString().slice(0, 10)
    const existing = byDay.get(day)
    if (existing === undefined || capturedMs >= existing.capturedMs) {
      byDay.set(day, { value: play, capturedMs })
    }
  }
  return [...byDay.entries()]
    .map(([day, entry]) => ({ day, value: entry.value }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
}

// ---- 账号总览（overview.get） ----

/** 总览 KPI 汇总（缺失字段 null → 调用方整卡消失）。 */
export interface OverviewSummary {
  accountCount: number | null
  workCount: number | null
  totalPlayCount: number | null
  netFansCount: number | null
  completionRate5sPct: number | null
  hotWorkCount: number | null
  hotRatePct: number | null
}

/** 排行账号行。 */
export interface OverviewAccountRow {
  accountId: string
  nickname: string | null
  ownerName: string | null
  fanCount: number | null
  windowNetFansCount: number | null
  windowPlayCount: number | null
  workCount: number | null
  medianPlayCount: number | null
  hotWorkCount: number | null
  hotRatePct: number | null
  engagementRatePct: number | null
  sessionStatus: string
  suspiciousEmptyCollect: boolean
  lastCollectedAt: string | null
}

/** 爆款作品行（总览/分析共用）。 */
export interface HotWorkRow {
  workId: string
  accountId: string | null
  accountNickname: string | null
  title: string | null
  publishTime: string | null
  playCount: number | null
  engagementRatePct: number | null
  fansGainCount: number | null
  basis: string | null
  labels: string[] | null
  promoted: boolean
  rank: number | null
}

/** 爆款账号分布行。 */
export interface HotDistributionRow {
  accountId: string
  nickname: string | null
  hotWorkCount: number
}

/** 账号目录项（筛选数据源）。 */
export interface CatalogEntry {
  accountId: string
  nickname: string | null
  workCount: number
  ownerName: string | null
}

/** overview.get 投影。 */
export interface OverviewData {
  summary: OverviewSummary
  accounts: OverviewAccountRow[]
  hotWorks: HotWorkRow[]
  distribution: HotDistributionRow[] | null
  catalog: CatalogEntry[]
  /** 服务端完整目录账号数（目录完整性判定；null = 不可判定）。 */
  accountTotal: number | null
}

/** overview.get → OverviewData。 */
export function readOverview(payload: Record<string, unknown>): OverviewData {
  const overview = recordOf(payload.overview) ?? {}
  const summaryRecord = recordOf(overview.summary)
  const field = (record: Record<string, unknown> | undefined, key: string): number | null =>
    record === undefined ? null : numberOf(record[key])
  const accounts: OverviewAccountRow[] = []
  for (const entry of arrayOf(overview.accounts)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const accountId = textOf(record.accountId)
    if (accountId === null) continue
    accounts.push({
      accountId,
      nickname: textOf(record.nickname),
      ownerName: textOf(record.ownerName),
      fanCount: numberOf(record.fanCount),
      windowNetFansCount: numberOf(record.windowNetFansCount),
      windowPlayCount: numberOf(record.windowPlayCount),
      workCount: numberOf(record.workCount),
      medianPlayCount: numberOf(record.medianPlayCount),
      hotWorkCount: numberOf(record.hotWorkCount),
      hotRatePct: numberOf(record.hotRatePct),
      engagementRatePct: numberOf(record.engagementRatePct),
      sessionStatus: textOf(record.sessionStatus) ?? 'unknown',
      suspiciousEmptyCollect: booleanOf(record.suspiciousEmptyCollect),
      lastCollectedAt: textOf(record.lastCollectedAt),
    })
  }
  const catalog: CatalogEntry[] = []
  for (const entry of arrayOf(overview.accountOptions)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const accountId = textOf(record.accountId)
    if (accountId === null) continue
    if (catalog.some(item => item.accountId === accountId)) continue
    catalog.push({
      accountId,
      nickname: textOf(record.nickname),
      workCount: numberOf(record.workCount) ?? 0,
      ownerName: textOf(record.ownerName),
    })
  }
  return {
    summary: {
      accountCount: field(summaryRecord, 'accountCount'),
      workCount: field(summaryRecord, 'workCount'),
      totalPlayCount: field(summaryRecord, 'totalPlayCount'),
      netFansCount: field(summaryRecord, 'netFansCount'),
      completionRate5sPct: field(summaryRecord, 'completionRate5sPct'),
      hotWorkCount: field(summaryRecord, 'hotWorkCount'),
      hotRatePct: field(summaryRecord, 'hotRatePct'),
    },
    accounts,
    hotWorks: arrayOf(overview.hotWorks).map(hotWorkOf).filter((row): row is HotWorkRow => row !== null),
    distribution: Array.isArray(overview.hotAccountDistribution)
      ? overview.hotAccountDistribution.map(entry => {
          const record = recordOf(entry)
          if (record === undefined) return null
          const accountId = textOf(record.accountId)
          if (accountId === null) return null
          return { accountId, nickname: textOf(record.nickname), hotWorkCount: numberOf(record.hotWorkCount) ?? 0 }
        }).filter((row): row is HotDistributionRow => row !== null)
      : null,
    catalog,
    accountTotal: numberOf(overview.accountTotal),
  }
}

/** 爆款作品行投影。 */
function hotWorkOf(entry: unknown): HotWorkRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const workId = textOf(record.workId ?? record.work_id)
  if (workId === null) return null
  const labels = Array.isArray(record.labels)
    ? record.labels.map(label => typeof label === 'string' ? label : '').filter(label => label !== '')
    : null
  return {
    workId,
    accountId: textOf(record.accountId),
    accountNickname: textOf(record.accountNickname) ?? textOf(record.account_nickname),
    title: textOf(record.title),
    publishTime: textOf(record.publishTime) ?? textOf(record.publish_time),
    playCount: numberOf(record.playCount ?? record.play_count),
    engagementRatePct: numberOf(record.engagementRatePct ?? record.engagement_rate_pct),
    fansGainCount: numberOf(record.fansGainCount ?? record.fans_gain_count),
    basis: textOf(record.basis),
    labels,
    promoted: booleanOf(record.promoted),
    rank: numberOf(record.rank),
  }
}

// ---- 单账号分析（account.analysis） ----

/** 内容指标卡（值 + 覆盖率三段）。 */
export interface ContentMetricRow {
  key: string
  value: number | null
  coveragePct: number | null
}

/** 分析页投影。 */
export interface AnalysisData {
  account: {
    accountId: string
    nickname: string | null
    ownerName: string | null
    fanCount: number | null
    lastCollectedAt: string | null
    sessionStatus: string
    suspiciousEmptyCollect: boolean
  } | null
  workCount: number | null
  kpi: {
    totalPlayCount: number | null
    medianPlayCount: number | null
    maxPlayCount: number | null
    hotWorkCount: number | null
    hotRatePct: number | null
    engagementRatePct: number | null
  }
  fansSummary: {
    totalFansCount: number | null
    newFansCount: number | null
    cancelFansCount: number | null
    homeViewFansCount: number | null
    homepageViewCount: number | null
  } | null
  content: ContentMetricRow[]
  audience: {
    gender: DistRow[] | null
    age: DistRow[] | null
    province: DistRow[] | null
    city_level: DistRow[] | null
  }
  traffic: { key: string; pct: number | null; label: string | null }[]
  hotWorks: HotWorkRow[]
  alerts: { ruleId: string; workCount: number }[]
}

/** 内容指标固定清单（键 = 服务端 overview/段名键）。 */
const CONTENT_METRIC_KEYS: readonly { key: string; section: 'kpi' | 'fansSummary' | 'interaction' | 'completion' | 'playback' }[] = [
  { key: 'engagementRatePct', section: 'kpi' },
  { key: 'likeCount', section: 'interaction' },
  { key: 'commentCount', section: 'interaction' },
  { key: 'collectCount', section: 'interaction' },
  { key: 'shareCount', section: 'interaction' },
  { key: 'newFansCount', section: 'fansSummary' },
  { key: 'completion5s', section: 'completion' },
  { key: 'avgViewProportion', section: 'playback' },
  { key: 'avgWatchDuration', section: 'playback' },
]

/** account.analysis → AnalysisData。 */
export function readAnalysis(payload: Record<string, unknown>): AnalysisData {
  const analysis = recordOf(payload.analysis) ?? {}
  const accountRecord = recordOf(analysis.account)
  const kpi = recordOf(analysis.kpi)
  const summary = recordOf(analysis.summary)
  const fans = recordOf(analysis.fansSummary)
  const interaction = recordOf(analysis.interaction)
  const completion = recordOf(analysis.completion)
  const playback = recordOf(analysis.playback)
  const audience = recordOf(analysis.audience)
  const dimensions = recordOf(audience?.dimensions)
  const traffic = recordOf(analysis.traffic)
  const content: ContentMetricRow[] = CONTENT_METRIC_KEYS.map(metric => {
    if (metric.section === 'kpi') return { key: metric.key, value: numberOf(kpi?.[metric.key]), coveragePct: null }
    if (metric.section === 'fansSummary') return { key: metric.key, value: numberOf(fans?.[metric.key]), coveragePct: null }
    if (metric.section === 'completion' || metric.section === 'playback') {
      const item = recordOf((metric.section === 'completion' ? completion : playback)?.[metric.key])
      return { key: metric.key, value: item === undefined ? null : numberOf(item.value), coveragePct: item === undefined ? null : numberOf(item.coveragePct) }
    }
    const item = recordOf(interaction?.[metric.key])
    return { key: metric.key, value: item === undefined ? null : numberOf(item.ratePct), coveragePct: item === undefined ? null : numberOf(item.coveragePct) }
  })
  return {
    account: accountRecord === undefined ? null : {
      accountId: textOf(accountRecord.accountId) ?? '',
      nickname: textOf(accountRecord.nickname),
      ownerName: textOf(accountRecord.ownerName),
      fanCount: numberOf(accountRecord.fanCount),
      lastCollectedAt: textOf(accountRecord.lastCollectedAt),
      sessionStatus: textOf(accountRecord.sessionStatus) ?? 'unknown',
      suspiciousEmptyCollect: booleanOf(accountRecord.suspiciousEmptyCollect),
    },
    workCount: summary === undefined ? null : numberOf(summary.workCount),
    kpi: {
      totalPlayCount: numberOf(kpi?.totalPlayCount),
      medianPlayCount: numberOf(kpi?.medianPlayCount),
      maxPlayCount: numberOf(kpi?.maxPlayCount),
      hotWorkCount: numberOf(kpi?.hotWorkCount),
      hotRatePct: numberOf(kpi?.hotRatePct),
      engagementRatePct: numberOf(kpi?.engagementRatePct),
    },
    fansSummary: fans === undefined ? null : {
      totalFansCount: numberOf(fans.totalFansCount),
      newFansCount: numberOf(fans.newFansCount),
      cancelFansCount: numberOf(fans.cancelFansCount),
      homeViewFansCount: numberOf(fans.homeViewFansCount),
      homepageViewCount: numberOf(fans.homepageViewCount),
    },
    content,
    audience: {
      // weighted dimension 形状是 {distributions: [{key, pct}...]}：读其中的
      // distributions 数组（2026-11-22 真机「数据不足」根因——误读维度 dict 本身）。
      gender: distRows(recordOf(dimensions?.gender)?.distributions),
      age: distRows(recordOf(dimensions?.age)?.distributions),
      province: distRows(recordOf(dimensions?.province)?.distributions),
      city_level: distRows(recordOf(dimensions?.city_level)?.distributions),
    },
    traffic: arrayOf(traffic?.distributions).map(entry => {
      const record = recordOf(entry)
      if (record === undefined) return null
      const key = textOf(record.key) ?? ''
      return { key, pct: numberOf(record.pct), label: textOf(record.sourceLabel) }
    }).filter((row): row is { key: string; pct: number | null; label: string | null } => row !== null),
    hotWorks: arrayOf(analysis.hotWorks).map(hotWorkOf).filter((row): row is HotWorkRow => row !== null),
    alerts: arrayOf(analysis.alerts).map(entry => {
      const record = recordOf(entry)
      if (record === undefined) return null
      const ruleId = textOf(record.ruleId) ?? textOf(record.rule_id)
      if (ruleId === null) return null
      return { ruleId, workCount: numberOf(record.workCount) ?? 0 }
    }).filter((row): row is { ruleId: string; workCount: number } => row !== null),
  }
}

// ---- AI 分析（aiAnalysis.get） ----

/** AI 维度行。 */
export interface AiDimension {
  key: string
  title: string | null
  level: string
  facts: string[]
  insight: string | null
  limitations: string[]
  evidenceWorkIds: string[]
}

/** AI 风险/建议/规律条目。 */
export interface AiItem {
  title: string | null
  detail: string | null
  priority: string | null
  evidenceWorkIds: string[]
}

/** AI 分析结果投影。 */
export interface AiAnalysisView {
  status: string
  result: {
    overallAssessment: string | null
    summary: string | null
    generatedAt: string | null
    sampleCount: number | null
    disclaimer: string | null
    dimensions: AiDimension[]
    risks: AiItem[]
    recommendations: AiItem[]
    viralPatterns: { title: string | null; confidence: string | null }[]
    dataLimitations: string[]
  } | null
  evidenceWorks: { workId: string; title: string | null }[]
  retainedError: string | null
}

/** aiAnalysis.get → 投影（aiStatus 顶层 + analysis 载荷）。 */
export function readAiAnalysis(payload: Record<string, unknown>): { aiStatus: string | null; ai: AiAnalysisView | null } {
  const aiStatus = textOf(payload.aiStatus)
  const record = recordOf(payload.analysis)
  if (record === undefined) return { aiStatus, ai: null }
  const result = recordOf(record.result)
  const aiItem = (entry: unknown): AiItem | null => {
    const item = recordOf(entry)
    if (item === undefined) return null
    return {
      title: textOf(item.title) ?? textOf(item.action) ?? textOf(item.pattern),
      detail: textOf(item.reason) ?? textOf(item.detail) ?? textOf(item.expectedSignal),
      priority: textOf(item.priority) ?? textOf(item.confidence),
      evidenceWorkIds: arrayOf(item.evidenceWorkIds).map(id => typeof id === 'string' ? id : '').filter(id => id !== ''),
    }
  }
  return {
    aiStatus,
    ai: {
      status: textOf(record.status) ?? 'not_analyzed',
      result: result === undefined ? null : {
        overallAssessment: textOf(result.overallAssessment),
        summary: textOf(result.summary),
        generatedAt: textOf(record.generatedAt) ?? textOf(result.generatedAt),
        sampleCount: numberOf(record.sampleCount) ?? numberOf(result.sampleCount),
        disclaimer: textOf(result.disclaimer),
        dimensions: arrayOf(result.dimensions).map(entry => {
          const dim = recordOf(entry)
          if (dim === undefined) return null
          return {
            key: textOf(dim.key) ?? '',
            title: textOf(dim.title),
            level: textOf(dim.level) ?? 'insufficient',
            facts: arrayOf(dim.facts).map(fact => typeof fact === 'string' ? fact : '').filter(fact => fact !== ''),
            insight: textOf(dim.insight),
            limitations: arrayOf(dim.limitations).map(limit => typeof limit === 'string' ? limit : '').filter(limit => limit !== ''),
            evidenceWorkIds: arrayOf(dim.evidenceWorkIds).map(id => typeof id === 'string' ? id : '').filter(id => id !== ''),
          }
        }).filter((dim): dim is AiDimension => dim !== null),
        risks: arrayOf(result.risks).map(aiItem).filter((item): item is AiItem => item !== null),
        recommendations: arrayOf(result.recommendations).map(aiItem).filter((item): item is AiItem => item !== null),
        viralPatterns: arrayOf(result.viralPatterns).map(entry => {
          const pattern = recordOf(entry)
          if (pattern === undefined) return null
          return { title: textOf(pattern.pattern) ?? textOf(pattern.title), confidence: textOf(pattern.confidence) }
        }).filter((pattern): pattern is { title: string | null; confidence: string | null } => pattern !== null),
        dataLimitations: arrayOf(result.dataLimitations).map(limit => typeof limit === 'string' ? limit : '').filter(limit => limit !== ''),
      },
      evidenceWorks: arrayOf(record.evidenceWorks).map(entry => {
        const work = recordOf(entry)
        if (work === undefined) return null
        const workId = textOf(work.workId)
        return workId === null ? null : { workId, title: textOf(work.title) }
      }).filter((work): work is { workId: string; title: string | null } => work !== null),
      retainedError: textOf(recordOf(record.retainedError)?.code),
    },
  }
}

// ---- 发布排期（schedule.*） ----

/** 平台白名单（固定顺序）。 */
export const SCHEDULE_PLATFORMS: readonly string[] = ['xhs', 'douyin', 'wx_channels']

/** 排期 UI 行（rowId/rowVersion 十进制字符串，不转 Number）。 */
export interface ScheduleUiRow {
  rowId: string
  accountId: string
  shootingDate: string
  videoContent: string
  shootingStatus: boolean
  published: boolean
  assetLink: string
  note: string
  publishDate: string
  publishPlatforms: string[]
  shootingOwner: string
  editingOwner: string
  rowVersion: string
}

/** 服务端 snake_case 行 → UI 行；无 id 的行丢弃。 */
export function toScheduleUiRow(raw: unknown): ScheduleUiRow | null {
  const record = recordOf(raw)
  if (record === undefined) return null
  const id = record.id
  if (id === null || id === undefined || id === '') return null
  return {
    rowId: String(id),
    accountId: typeof record.account_id === 'string' ? record.account_id : '',
    shootingDate: typeof record.shooting_date === 'string' ? record.shooting_date : '',
    videoContent: typeof record.video_content === 'string' ? record.video_content : '',
    shootingStatus: booleanOf(record.shooting_status),
    published: booleanOf(record.published),
    assetLink: typeof record.asset_link === 'string' ? record.asset_link : '',
    note: typeof record.note === 'string' ? record.note : '',
    publishDate: typeof record.publish_date === 'string' ? record.publish_date : '',
    publishPlatforms: arrayOf(record.publish_platforms)
      .map(item => typeof item === 'string' ? item : '')
      .filter(item => SCHEDULE_PLATFORMS.includes(item)),
    shootingOwner: typeof record.shooting_owner === 'string' ? record.shooting_owner : '',
    editingOwner: typeof record.editing_owner === 'string' ? record.editing_owner : '',
    rowVersion: String(record.row_version ?? '1'),
  }
}

/**
 * rowId 十进制字符串比较（长度优先、等长逐位；绝不转 Number 避免
 * MAX_SAFE_INTEGER 精度丢失）。
 * @param a - 左 rowId。
 * @param b - 右 rowId。
 * @returns 比较结果。
 */
export function compareRowId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 发布日期升序比较：无日期排组内最后；同日期按 rowId 十进制字符串序稳定。
 * @param a - 左行。
 * @param b - 右行。
 * @returns 比较结果。
 */
export function comparePublishDate(a: ScheduleUiRow, b: ScheduleUiRow): number {
  const da = a.publishDate === '' ? null : a.publishDate
  const db = b.publishDate === '' ? null : b.publishDate
  if (da === db) return compareRowId(a.rowId, b.rowId)
  if (da === null) return 1
  if (db === null) return -1
  return da < db ? -1 : 1
}

/** schedule.list → 行数组（服务端 (account_id,id) 序保持）。 */
export function readScheduleRows(payload: Record<string, unknown>): ScheduleUiRow[] {
  const data = recordOf(payload.data) ?? {}
  return arrayOf(data.rows).map(toScheduleUiRow).filter((row): row is ScheduleUiRow => row !== null)
}

/** schedule.rowCreate / rowUpdate 的返回行。 */
export function readScheduleRow(payload: Record<string, unknown>): ScheduleUiRow | null {
  const data = recordOf(payload.data) ?? {}
  return toScheduleUiRow(data.row)
}

/** UI 行 → 服务端整行业务快照（空串归 null、平台白名单重排）。 */
export function buildServerSnapshot(row: ScheduleUiRow): {
  shootingDate: string | null
  videoContent: string | null
  shootingStatus: boolean
  published: boolean
  assetLink: string | null
  note: string | null
  publishDate: string | null
  publishPlatforms: string[]
  shootingOwner: string | null
  editingOwner: string | null
} {
  const trim = (value: string): string | null => {
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  const seen = new Set(row.publishPlatforms)
  return {
    shootingDate: trim(row.shootingDate),
    videoContent: trim(row.videoContent),
    shootingStatus: row.shootingStatus,
    published: row.published,
    assetLink: trim(row.assetLink),
    note: trim(row.note),
    publishDate: trim(row.publishDate),
    publishPlatforms: SCHEDULE_PLATFORMS.filter(value => seen.has(value)),
    shootingOwner: trim(row.shootingOwner),
    editingOwner: trim(row.editingOwner),
  }
}

// ---- AI 报表（report.*） ----

/** 报表列表行。 */
export interface ReportListItem {
  reportId: string
  reportType: string
  periodStart: string | null
  periodEnd: string | null
  status: string
  version: number | null
  coreAvailable: boolean | null
  coveredAccounts: number | null
  totalAccounts: number | null
  finishedAt: string | null
  createdAt: string | null
  summary: string | null
  errorCode: string | null
  isCurrent: boolean
}

/** KPI 指标卡（available=false → —）。 */
export interface ReportMetric {
  key: string
  label: string | null
  value: number | null
  available: boolean
  changePct: number | null
  prevValue: number | null
  note: string | null
}

/** 报表作品卡。 */
export interface ReportWork {
  workId: string
  title: string | null
  nickname: string | null
  accountId: string | null
  isHot: boolean
  metrics: {
    plays: number | null
    likes: number | null
    comments: number | null
    fansGain: number | null
    collects: number | null
    shares: number | null
    completion5s: number | null
    bounce2s: number | null
    avgWatchSeconds: number | null
  }
}

/** 报表账号行（9 列）。 */
export interface ReportAccountRow {
  accountId: string
  nickname: string | null
  ownerName: string | null
  sessionStatus: string | null
  fanCount: number | null
  eachAvailable: boolean
  marks: string[]
  metrics: { plays: number | null; netFans: number | null; publishes: number | null; likes: number | null; comments: number | null; shares: number | null }
}

/** 报表详情投影。 */
export interface ReportDetail {
  reportId: string
  reportType: string
  periodStart: string | null
  periodEnd: string | null
  status: string
  outputSchemaVersion: string
  errorCode: string | null
  finishedAt: string | null
  data: {
    generatedAt: string | null
    coverage: {
      totalAccounts: number | null
      coveredAccounts: number | null
      lastCollectedAt: string | null
      missingAccounts: { nickname: string | null; accountId: string; reason: string | null }[]
      signals: Record<string, number | null>
      insufficientReason: string | null
    } | null
    coreMetrics: ReportMetric[]
    trendSeries: { days: string[]; bars: (number | null)[]; line: (number | null)[] }
    accounts: ReportAccountRow[]
    works: ReportWork[]
    worksOmittedCount: number | null
    anomalies: { type: string; message: string | null }[]
  } | null
  ai: {
    summary: string | null
    facts: { title: string | null; detail: string | null; evidence: string | null }[]
    inferences: { title: string | null; detail: string | null; evidence: string | null; confidence: string | null }[]
    recommendations: { title: string | null; detail: string | null; evidence: string | null; priority: string | null }[]
    limitations: string[]
  } | null
}

/** report.list → 行数组 + nextCursor。 */
export function readReportList(payload: Record<string, unknown>): { items: ReportListItem[]; nextCursor: string | null } {
  const data = recordOf(payload.data) ?? {}
  const items = arrayOf(data.items).map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const reportId = textOf(record.reportId)
    if (reportId === null) return null
    const coverage = recordOf(record.coverageSummary)
    return {
      reportId,
      reportType: textOf(record.reportType) ?? 'daily',
      periodStart: textOf(record.periodStart),
      periodEnd: textOf(record.periodEnd),
      status: textOf(record.status) ?? 'pending',
      version: numberOf(record.version),
      coreAvailable: record.coreAvailable === undefined || record.coreAvailable === null ? null : booleanOf(record.coreAvailable),
      coveredAccounts: coverage === undefined ? null : numberOf(coverage.coveredAccounts),
      totalAccounts: coverage === undefined ? null : numberOf(coverage.totalAccounts),
      finishedAt: textOf(record.finishedAt),
      createdAt: textOf(record.createdAt),
      summary: textOf(record.summary),
      errorCode: textOf(record.errorCode),
      isCurrent: booleanOf(record.isCurrent),
    } satisfies ReportListItem
  }).filter((row): row is ReportListItem => row !== null)
  return { items, nextCursor: textOf(data.nextCursor) }
}

/** report.get → 详情投影。 */
export function readReportDetail(payload: Record<string, unknown>): ReportDetail {
  const data = recordOf(payload.data) ?? {}
  const report = recordOf(data.report) ?? data
  const resultJson = recordOf(report.resultJson)
  const resultData = recordOf(resultJson?.data)
  const coverage = recordOf(resultData?.coverage)
  const series = recordOf(resultData?.trendSeries)
  const ai = recordOf(resultJson?.ai)
  const metric = (entry: unknown): ReportMetric | null => {
    const record = recordOf(entry)
    if (record === undefined) return null
    return {
      key: textOf(record.key) ?? '',
      label: textOf(record.label),
      value: numberOf(record.value),
      available: record.available !== false,
      changePct: numberOf(record.changePct),
      prevValue: numberOf(record.prevValue),
      note: textOf(record.note),
    }
  }
  return {
    reportId: textOf(report.reportId) ?? '',
    reportType: textOf(report.reportType) ?? 'daily',
    periodStart: textOf(report.periodStart),
    periodEnd: textOf(report.periodEnd),
    status: textOf(report.status) ?? 'pending',
    outputSchemaVersion: textOf(report.outputSchemaVersion) ?? '',
    errorCode: textOf(report.errorCode),
    finishedAt: textOf(report.finishedAt),
    data: resultData === undefined ? null : {
      generatedAt: textOf(resultData.generatedAt),
      coverage: coverage === undefined ? null : {
        totalAccounts: numberOf(coverage.totalAccounts),
        coveredAccounts: numberOf(coverage.coveredAccounts),
        lastCollectedAt: textOf(coverage.lastCollectedAt),
        missingAccounts: arrayOf(coverage.missingAccounts).map(entry => {
          const record = recordOf(entry)
          if (record === undefined) return null
          const accountId = textOf(record.accountId) ?? ''
          return { nickname: textOf(record.nickname), accountId, reason: textOf(record.reason) }
        }).filter((row): row is { nickname: string | null; accountId: string; reason: string | null } => row !== null),
        signals: {
          dailyRows: numberOf(recordOf(coverage.signals)?.dailyRows),
          workSnapshotRows: numberOf(recordOf(coverage.signals)?.workSnapshotRows),
          fansProfileRows: numberOf(recordOf(coverage.signals)?.fansProfileRows),
          periodWorks: numberOf(recordOf(coverage.signals)?.periodWorks),
        },
        insufficientReason: textOf(coverage.insufficientReason),
      },
      coreMetrics: arrayOf(resultData.coreMetrics).map(metric).filter((row): row is ReportMetric => row !== null),
      trendSeries: {
        days: arrayOf(series?.days).map(day => typeof day === 'string' ? day : '').filter(day => day !== ''),
        bars: arrayOf(series?.bars).map(bar => numberOf(bar)),
        line: arrayOf(series?.line).map(point => numberOf(point)),
      },
      accounts: arrayOf(resultData.accounts).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        const metrics = recordOf(record.metrics)
        return {
          accountId: textOf(record.accountId) ?? '',
          nickname: textOf(record.nickname),
          ownerName: textOf(record.ownerName),
          sessionStatus: textOf(record.sessionStatus),
          fanCount: numberOf(record.fanCount),
          eachAvailable: record.eachAvailable !== false,
          marks: arrayOf(record.marks).map(mark => typeof mark === 'string' ? mark : '').filter(mark => mark !== ''),
          metrics: {
            plays: numberOf(metrics?.plays),
            netFans: numberOf(metrics?.netFans),
            publishes: numberOf(metrics?.publishes),
            likes: numberOf(metrics?.likes),
            comments: numberOf(metrics?.comments),
            shares: numberOf(metrics?.shares),
          },
        }
      }).filter((row): row is ReportAccountRow => row !== null),
      works: arrayOf(resultData.works).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        const metrics = recordOf(record.metrics)
        return {
          workId: textOf(record.workId) ?? '',
          title: textOf(record.title),
          nickname: textOf(record.nickname),
          accountId: textOf(record.accountId),
          isHot: booleanOf(record.isHot),
          metrics: {
            plays: numberOf(metrics?.plays),
            likes: numberOf(metrics?.likes),
            comments: numberOf(metrics?.comments),
            fansGain: numberOf(metrics?.fansGain),
            collects: numberOf(metrics?.collects),
            shares: numberOf(metrics?.shares),
            completion5s: numberOf(metrics?.completion5s),
            bounce2s: numberOf(metrics?.bounce2s),
            avgWatchSeconds: numberOf(metrics?.avgWatchSeconds),
          },
        }
      }).filter((row): row is ReportWork => row !== null),
      worksOmittedCount: numberOf(resultData.worksOmittedCount),
      anomalies: arrayOf(resultData.anomalies).map(entry => {
        const record = recordOf(entry)
        if (record === undefined) return null
        return { type: textOf(record.type) ?? 'business', message: textOf(record.message) }
      }).filter((row): row is { type: string; message: string | null } => row !== null),
    },
    ai: ai === undefined ? null : {
      summary: textOf(ai.summary),
      facts: insightItems(ai.facts, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence) })),
      inferences: insightItems(ai.inferences, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence), confidence: textOf(record.confidence) })),
      recommendations: insightItems(ai.recommendations, record => ({ title: textOf(record.title), detail: textOf(record.detail), evidence: textOf(record.evidence), priority: textOf(record.priority) })),
      limitations: arrayOf(ai.limitations).map(limit => typeof limit === 'string' ? limit : '').filter(limit => limit !== ''),
    },
  }
}

/** AI 洞察条目投影（detail/evidence 折叠区数据；调用方映射徽章字段）。 */
function insightItems<T>(value: unknown, map: (record: Record<string, unknown>) => T): T[] {
  return arrayOf(value).map(entry => {
    const record = recordOf(entry)
    return record === undefined ? null : map(record)
  }).filter((row): row is T => row !== null)
}

// ---- 爆款拆解（breakdown.*） ----

/** 仿写规则行（rewriteRuleId/name/description；prompt 正文服务端不下发）。 */
export interface RewriteRuleRow {
  rewriteRuleId: string
  name: string | null
  description: string | null
}

/** breakdown.rewriteRules → 规则行（无 id 的行丢弃）。 */
export function readRewriteRules(payload: Record<string, unknown>): RewriteRuleRow[] {
  const rows: RewriteRuleRow[] = []
  for (const entry of arrayOf(payload.rules)) {
    const record = recordOf(entry)
    if (record === undefined) continue
    const id = textOf(record.rewriteRuleId)
    if (id === null) continue
    rows.push({ rewriteRuleId: id, name: textOf(record.name), description: textOf(record.description) })
  }
  return rows
}

/** workflow 投影行（蛇形 candidate_id 已由 Host 归一为 candidateId）。 */
export interface WorkflowRow {
  workflowId: string | null
  candidateId: string
  status: string
  currentStep: string | null
  currentStepLabel: string | null
  candidateTitle: string | null
  candidateAuthor: string | null
  candidatePlayCount: number | null
  rewriteRuleId: string | null
  /** 键是否存在由 inWorkflow 携带（false = 同步失败 payload 缺键，回退会话规则）。 */
  hasRewriteRuleKey: boolean
  updatedAt: string | null
  retryAfterSeconds: number | null
  errorCode: string | null
}

/** workflow 载荷行 → 白名单视图（无 candidateId 的行丢弃）。 */
function workflowRowOf(entry: unknown): WorkflowRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const candidateId = textOf(record.candidateId ?? record.candidate_id)
  if (candidateId === null) return null
  const admin = recordOf(record.admin)
  return {
    workflowId: textOf(record.workflowId) ?? (admin !== undefined ? textOf(admin.workflowId) : null),
    candidateId,
    status: textOf(record.status) ?? '',
    currentStep: textOf(record.currentStep),
    currentStepLabel: textOf(record.currentStepLabel),
    candidateTitle: textOf(record.candidateTitle),
    candidateAuthor: textOf(record.candidateAuthor),
    candidatePlayCount: numberOf(record.candidatePlayCount),
    rewriteRuleId: textOf(record.rewriteRuleId),
    hasRewriteRuleKey: 'rewriteRuleId' in record,
    updatedAt: textOf(record.updatedAt),
    retryAfterSeconds: numberOf(record.retryAfterSeconds),
    errorCode: textOf(record.errorCode) ?? (admin !== undefined ? textOf(admin.errorCode) : null),
  }
}

/** 历史行 = workflow 行 + hasStoryboard 保守标记。 */
export interface BreakdownHistoryRow extends WorkflowRow {
  hasStoryboard: boolean
}

/** breakdown.history → 历史行。 */
export function readBreakdownHistory(payload: Record<string, unknown>): BreakdownHistoryRow[] {
  const rows: BreakdownHistoryRow[] = []
  for (const entry of arrayOf(payload.history)) {
    const row = workflowRowOf(entry)
    if (row === null) continue
    rows.push({ ...row, hasStoryboard: booleanOf(recordOf(entry)?.hasStoryboard) })
  }
  return rows
}

/** breakdown.workflowStatus → workflow 行 + total。 */
export function readBreakdownWorkflows(payload: Record<string, unknown>): { workflows: WorkflowRow[]; total: number } {
  const workflows = arrayOf(payload.workflows).map(workflowRowOf)
    .filter((row): row is WorkflowRow => row !== null)
  const total = numberOf(payload.total)
  return { workflows, total: total ?? workflows.length }
}

/** breakdown.archiveStart / archiveStatus → 异步 run 回执。 */
export interface ArchiveRunView {
  runId: string
  runStatus: string
  nextAction: string | null
  candidateId: string | null
  error: string | null
}

export function readArchiveRun(payload: Record<string, unknown>): ArchiveRunView | null {
  const record = recordOf(payload.archive)
  if (record === undefined) return null
  const runId = textOf(record.runId)
  if (runId === null) return null
  const result = recordOf(record.result)
  return {
    runId,
    runStatus: textOf(record.runStatus) ?? '',
    nextAction: textOf(record.nextAction),
    candidateId: result !== undefined ? textOf(result.candidateId) : null,
    error: textOf(recordOf(record.error)?.code) ?? textOf(record.error),
  }
}

/** breakdown.downloadStart / downloadStatus → 下载任务视图。 */
export interface DownloadJobView {
  jobId: string | null
  status: string
  downloadUrl: string | null
  fallbackPlayUrl: string | null
  title: string | null
  errorCode: string | null
}

export function readDownloadJob(payload: Record<string, unknown>): DownloadJobView | null {
  const record = recordOf(payload.download)
  if (record === undefined) return null
  return {
    jobId: textOf(record.jobId),
    status: textOf(record.status) ?? '',
    downloadUrl: safeHttpUrl(record.downloadUrl),
    fallbackPlayUrl: safeHttpUrl(record.fallbackPlayUrl) ?? safeHttpUrl(record.playUrl),
    title: textOf(record.title),
    errorCode: textOf(recordOf(record.error)?.code) ?? textOf(record.errorCode),
  }
}

/** 拆解详情的原文/仿写分段。 */
export interface BreakdownSegment {
  timeRange: string | null
  role: string | null
  originalVisual: string | null
  originalSpeech: string | null
  rewrittenSpeech: string | null
  rewrittenVisual: string | null
  sourceSegmentIndexes: number[]
}

/** 分段投影（原表与仿写卡共用；无值字段 null）。 */
function segmentOf(entry: unknown): BreakdownSegment | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  return {
    timeRange: textOf(record.timeRange),
    role: textOf(record.role),
    originalVisual: textOf(record.originalVisual),
    originalSpeech: textOf(record.originalSpeech),
    rewrittenSpeech: textOf(record.rewrittenSpeech),
    rewrittenVisual: textOf(record.rewrittenVisual),
    sourceSegmentIndexes: arrayOf(record.sourceSegmentIndexes)
      .map(index => numberOf(index))
      .filter((index): index is number => index !== null),
  }
}

/** 拍摄脚本块（status=succeeded 才有 markdown）。 */
export interface ShotScriptView {
  status: string | null
  markdown: string | null
  quotaDigest: string | null
}

/** storyboard 行投影（详情主体）。 */
export interface StoryboardRow {
  originalSummary: string | null
  originalSegments: BreakdownSegment[]
  rewrittenSummary: string | null
  rewrittenSegments: BreakdownSegment[]
  shotScript: ShotScriptView
  ruleId: string | null
  rulePrompt: string | null
}

function storyboardRowOf(entry: unknown): StoryboardRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const original = recordOf(record.originalVideoAnalysis)
  const rewritten = recordOf(record.rewrittenStoryboard)
  const shotScript = recordOf(record.shotScript)
  const input = recordOf(record.input)
  const quotas = shotScript !== undefined ? recordOf(shotScript.shotSizeQuotas) : undefined
  const quotaDigest = quotas === undefined ? null
    : Object.entries(quotas).map(([size, count]) => `${size}×${String(count)}`).join(' · ')
  return {
    originalSummary: original !== undefined ? textOf(original.summary) : null,
    originalSegments: original === undefined ? [] : arrayOf(original.segments).map(segmentOf)
      .filter((row): row is BreakdownSegment => row !== null),
    rewrittenSummary: rewritten !== undefined ? textOf(rewritten.summary) : null,
    rewrittenSegments: rewritten === undefined ? [] : arrayOf(rewritten.segments).map(segmentOf)
      .filter((row): row is BreakdownSegment => row !== null),
    shotScript: {
      status: shotScript !== undefined ? textOf(shotScript.status) : null,
      markdown: shotScript !== undefined ? textOf(shotScript.markdown) : null,
      quotaDigest: quotaDigest === '' ? null : quotaDigest,
    },
    ruleId: input !== undefined ? textOf(input.rewriteRuleId) : null,
    rulePrompt: input !== undefined ? textOf(input.rewriteRulePrompt) : null,
  }
}

/** 候选公开指标（辅助源；缺失独立降级）。 */
export interface BreakdownCandidate {
  playCount: number | null
  likeCount: number | null
  commentCount: number | null
  collectCount: number | null
  shareCount: number | null
  interactionRate: number | null
  publishedAt: string | null
  shareUrl: string | null
}

function breakdownCandidateOf(entry: unknown): BreakdownCandidate | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  return {
    playCount: numberOf(record.playCount),
    likeCount: numberOf(record.likeCount),
    commentCount: numberOf(record.commentCount),
    collectCount: numberOf(record.collectCount),
    shareCount: numberOf(record.shareCount),
    interactionRate: numberOf(record.interactionRate),
    publishedAt: textOf(record.publishedAt),
    shareUrl: safeShareWorkUrl(record.shareUrl),
  }
}

/** breakdown.detail → 三源组合投影（storyboards 主体 + 辅助源独立降级）。 */
export interface BreakdownDetail {
  storyboards: StoryboardRow[]
  analysis: Record<string, unknown> | null
  analysisError: string | null
  candidate: BreakdownCandidate | null
  candidateError: string | null
}

export function readBreakdownDetail(payload: Record<string, unknown>): BreakdownDetail {
  return {
    storyboards: arrayOf(payload.storyboards).map(storyboardRowOf)
      .filter((row): row is StoryboardRow => row !== null),
    analysis: recordOf(payload.analysis) ?? null,
    analysisError: textOf(payload.analysisError),
    candidate: breakdownCandidateOf(payload.candidate),
    candidateError: textOf(payload.candidateError),
  }
}

/** 详情页口播全文（analysis.candidates[0].products.asr.transcript）。 */
export function asrTranscriptOf(analysis: Record<string, unknown> | null): string | null {
  if (analysis === null) return null
  const candidate = recordOf(arrayOf(analysis.candidates)[0])
  const products = candidate === undefined ? undefined : recordOf(candidate.products)
  const asr = products === undefined ? undefined : recordOf(products.asr)
  return asr === undefined ? null : textOf(asr.transcript)
}

/** 分享链接白名单：v.douyin.com 短链域同样放行（拆解输入域，宽于作品链接域）。 */
function safeShareWorkUrl(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '' || text.length > 2048) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    const host = url.hostname.toLowerCase()
    const allowed = host === 'douyin.com' || host.endsWith('.douyin.com')
      || host === 'iesdouyin.com' || host.endsWith('.iesdouyin.com')
    return allowed ? text : null
  } catch {
    return null
  }
}

// ---- 爆款素材看板（material.*） ----

/** 素材候选行（candidates_list 投影字段；缺失 null 不补 0）。 */
export interface MaterialCandidateRow {
  candidateId: string
  awemeId: string | null
  title: string | null
  coverUrl: string | null
  shareUrl: string | null
  tags: string[] | null
  hotScore: number | null
  hotLevel: string | null
  playCount: number | null
  likeCount: number | null
  commentCount: number | null
  collectCount: number | null
  shareCount: number | null
  interactionRate: number | null
  publishedAt: string | null
  sourceMatches: { keyword: string | null; accountSeedId: string | null }[]
  scoreReasons: string[]
  scoreReasonDetails: { name: string; observed: number | null; threshold: number | null; points: number | null; hit: boolean }[]
  scoreRuleVersion: string | null
}

/** 看板响应投影（total 服务端口径；hotLevelSummary 筛选聚合可缺省）。 */
export interface MaterialBoard {
  rows: MaterialCandidateRow[]
  total: number | null
  levelSummary: Record<string, number> | null
  offset: number
  limit: number
}

export function readMaterialBoard(payload: Record<string, unknown>): MaterialBoard {
  const data = recordOf(payload.data) ?? {}
  const summary = recordOf(data.hotLevelSummary)
  let levelSummary: Record<string, number> | null = null
  if (summary !== undefined) {
    const levels: Record<string, number> = {}
    for (const [level, count] of Object.entries(summary)) {
      const num = numberOf(count)
      if (num !== null) levels[level] = num
    }
    levelSummary = levels
  }
  return {
    rows: arrayOf(data.candidates).map(candidateOf).filter((row): row is MaterialCandidateRow => row !== null),
    total: numberOf(data.total),
    levelSummary,
    offset: numberOf(data.offset) ?? 0,
    limit: numberOf(data.limit) ?? 20,
  }
}

/** 单候选投影（无 candidateId 的行丢弃）。 */
function candidateOf(entry: unknown): MaterialCandidateRow | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const candidateId = textOf(record.candidateId)
  if (candidateId === null) return null
  return {
    candidateId,
    awemeId: textOf(record.awemeId),
    title: textOf(record.title),
    coverUrl: safeHttpUrl(record.coverUrl),
    shareUrl: safeHttpUrl(record.shareUrl),
    tags: Array.isArray(record.tags)
      ? record.tags.map(tag => typeof tag === 'string' ? tag : '').filter(tag => tag !== '')
      : null,
    hotScore: numberOf(record.hotScore),
    hotLevel: textOf(record.hotLevel),
    playCount: numberOf(record.playCount),
    likeCount: numberOf(record.likeCount),
    commentCount: numberOf(record.commentCount),
    collectCount: numberOf(record.collectCount),
    shareCount: numberOf(record.shareCount),
    interactionRate: numberOf(record.interactionRate),
    publishedAt: textOf(record.publishedAt),
    sourceMatches: arrayOf(record.sourceMatches).map(match => {
      const item = recordOf(match)
      return item === undefined ? null : { keyword: textOf(item.keyword), accountSeedId: textOf(item.accountSeedId) }
    }).filter((row): row is { keyword: string | null; accountSeedId: string | null } => row !== null),
    scoreReasons: arrayOf(record.scoreReasons).map(reason => typeof reason === 'string' ? reason : '').filter(reason => reason !== ''),
    scoreReasonDetails: arrayOf(record.scoreReasonDetails).map(detail => {
      const item = recordOf(detail)
      if (item === undefined) return null
      return {
        name: textOf(item.name) ?? '',
        observed: numberOf(item.observed),
        threshold: numberOf(item.threshold),
        points: numberOf(item.points),
        hit: booleanOf(item.hit),
      }
    }).filter((row): row is { name: string; observed: number | null; threshold: number | null; points: number | null; hit: boolean } => row !== null),
    scoreRuleVersion: textOf(record.scoreRuleVersion),
  }
}

/** 关键词 seed 行。 */
export interface KeywordSeedRow {
  seedId: string
  keyword: string
  priority: string | null
  status: string
  searchCount: number | null
  updatedAt: string | null
}

/** 对标账号 seed 行。 */
export interface AccountSeedRow {
  accountSeedId: string
  displayName: string | null
  inputForm: string
  inputValue: string
  priority: string | null
  status: string
  maxVideos: number | null
  resolved: boolean
  verificationStatus: string | null
  lastResolutionError: string | null
  lastContentFetchedAt: string | null
}

/** seeds.list 投影（两表 + 启用计数）。 */
export interface MaterialSeeds {
  keywords: KeywordSeedRow[]
  accounts: AccountSeedRow[]
  activeKeywords: number | null
  activeAccounts: number | null
}

export function readMaterialSeeds(payload: Record<string, unknown>): MaterialSeeds {
  const data = recordOf(payload.data) ?? {}
  const keywordByStatus = recordOf(data.keywordByStatus)
  const accountByStatus = recordOf(data.accountByStatus)
  return {
    keywords: arrayOf(data.keywords).map(entry => {
      const record = recordOf(entry)
      if (record === undefined) return null
      const seedId = textOf(record.seedId)
      const keyword = textOf(record.keyword)
      if (seedId === null || keyword === null) return null
      return {
        seedId,
        keyword,
        priority: textOf(record.priority),
        status: textOf(record.status) ?? 'active',
        searchCount: numberOf(record.searchCount),
        updatedAt: textOf(record.updatedAt),
      } satisfies KeywordSeedRow
    }).filter((row): row is KeywordSeedRow => row !== null),
    accounts: arrayOf(data.accounts).map(entry => {
      const record = recordOf(entry)
      if (record === undefined) return null
      const accountSeedId = textOf(record.accountSeedId)
      if (accountSeedId === null) return null
      return {
        accountSeedId,
        displayName: textOf(record.displayName),
        inputForm: textOf(record.inputForm) ?? 'douyin_id',
        inputValue: textOf(record.inputValue) ?? '',
        priority: textOf(record.priority),
        status: textOf(record.status) ?? 'active',
        maxVideos: numberOf(record.maxVideos),
        resolved: booleanOf(record.resolved),
        verificationStatus: textOf(record.verificationStatus),
        lastResolutionError: textOf(recordOf(record.lastResolutionError)?.reason),
        lastContentFetchedAt: textOf(record.lastContentFetchedAt),
      } satisfies AccountSeedRow
    }).filter((row): row is AccountSeedRow => row !== null),
    activeKeywords: keywordByStatus === undefined ? null : numberOf(keywordByStatus.active),
    activeAccounts: accountByStatus === undefined ? null : numberOf(accountByStatus.active),
  }
}

/** 采集 run 行（runs_list 投影字段）。 */
export interface MaterialRunRow {
  runId: string
  runStatus: string
  startedAt: string | null
  durationSeconds: number | null
  keywordCount: number | null
  accountCount: number | null
  succeededJobs: number | null
  failedJobs: number | null
  newVideos: number | null
  promotedCandidates: number | null
  duplicatesSkipped: number | null
  discovered: number | null
  candidatesInserted: number | null
  materialCandidateCount: number | null
  hotLevelSummary: Record<string, number> | null
  failedKeywords: string[]
  failedAccounts: string[]
  runError: { code: string | null; message: string | null } | null
}

export function readMaterialRuns(payload: Record<string, unknown>): MaterialRunRow[] {
  const data = recordOf(payload.data) ?? {}
  return arrayOf(data.runs).map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const runId = textOf(record.runId)
    if (runId === null) return null
    const summary = recordOf(record.hotLevelSummary)
    let hotLevelSummary: Record<string, number> | null = null
    if (summary !== undefined) {
      const levels: Record<string, number> = {}
      for (const [level, count] of Object.entries(summary)) {
        const num = numberOf(count)
        if (num !== null) levels[level] = num
      }
      hotLevelSummary = levels
    }
    const runError = recordOf(record.runError)
    return {
      runId,
      runStatus: textOf(record.runStatus) ?? '',
      startedAt: textOf(record.startedAt),
      durationSeconds: numberOf(record.durationSeconds),
      keywordCount: numberOf(record.keywordCount),
      accountCount: numberOf(record.accountCount),
      succeededJobs: numberOf(record.succeededJobs),
      failedJobs: numberOf(record.failedJobs),
      newVideos: numberOf(record.newVideos),
      promotedCandidates: numberOf(record.promotedCandidates),
      duplicatesSkipped: numberOf(record.duplicatesSkipped),
      discovered: numberOf(record.discovered),
      candidatesInserted: numberOf(record.candidatesInserted),
      materialCandidateCount: numberOf(record.materialCandidateCount),
      hotLevelSummary,
      failedKeywords: arrayOf(record.failedKeywords).map(item => typeof item === 'string' ? item : '').filter(item => item !== ''),
      failedAccounts: arrayOf(record.failedAccounts).map(item => typeof item === 'string' ? item : '').filter(item => item !== ''),
      runError: runError === undefined ? null : { code: textOf(runError.code), message: textOf(runError.message) },
    } satisfies MaterialRunRow
  }).filter((row): row is MaterialRunRow => row !== null)
}

/** 采集受理/轮询回执（async_submit_get 投影）。 */
export interface MaterialRunStatus {
  runId: string | null
  runStatus: string
  startedAt: string | null
  nextAction: string | null
}

export function readMaterialRunStatus(payload: Record<string, unknown>): MaterialRunStatus | null {
  const data = recordOf(payload.data)
  if (data === undefined) return null
  return {
    runId: textOf(data.runId),
    runStatus: textOf(data.runStatus) ?? '',
    startedAt: textOf(data.startedAt),
    nextAction: textOf(data.nextAction),
  }
}

/** 标签 facets（dashboard_get materialFacets.tags 窄投影）。 */
export interface MaterialFacetTag {
  tag: string
  count: number
}

export function readMaterialFacets(payload: Record<string, unknown>): MaterialFacetTag[] {
  return arrayOf(payload.tags).map(entry => {
    const record = recordOf(entry)
    if (record === undefined) return null
    const tag = textOf(record.tag)
    if (tag === null) return null
    return { tag, count: numberOf(record.count) ?? 0 }
  }).filter((row): row is MaterialFacetTag => row !== null)
}

// ---- 爆款基因库（gene.*） ----

/** 基因卡片行（knowledge_search results / knowledge_get record 共构）。 */
export interface GeneRecord {
  recordId: string
  awemeId: string | null
  title: string | null
  coverUrl: string | null
  authorName: string | null
  publishedAt: string | null
  durationSeconds: number | null
  metrics: { playCount: number | null; likeCount: number | null; commentCount: number | null; shareCount: number | null; collectCount: number | null }
  geneTags: Record<string, string[]>
  adoptionStatus: string | null
  geneStatus: string | null
  updatedAt: string | null
  // 详情独有（卡片缺省 null）。
  shareUrl: string | null
  manualNotes: string | null
  reportJson: Record<string, unknown> | null
  geneEvidenceJson: Record<string, unknown> | null
  geneAttemptCount: number | null
  geneErrorCode: string | null
  geneErrorSummary: string | null
  audienceInsightState: string | null
  bgmStyleState: string | null
}

/** 单条基因记录投影（search results 与 detail record 同构）。 */
function geneRecordOf(entry: unknown): GeneRecord | null {
  const record = recordOf(entry)
  if (record === undefined) return null
  const recordId = textOf(record.recordId)
  if (recordId === null) return null
  const metrics = recordOf(record.metrics)
  const tags: Record<string, string[]> = {}
  const rawTags = recordOf(record.geneTags)
  if (rawTags !== undefined) {
    for (const [dim, labels] of Object.entries(rawTags)) {
      if (!Array.isArray(labels)) continue
      const clean = labels.map(label => typeof label === 'string' ? label : '').filter(label => label !== '')
      if (clean.length > 0) tags[dim] = clean
    }
  }
  return {
    recordId,
    awemeId: textOf(record.awemeId),
    title: textOf(record.title),
    coverUrl: safeHttpUrl(record.coverUrl),
    authorName: textOf(record.authorName),
    publishedAt: textOf(record.publishedAt),
    durationSeconds: numberOf(record.durationSeconds),
    metrics: {
      playCount: numberOf(metrics?.playCount),
      likeCount: numberOf(metrics?.likeCount),
      commentCount: numberOf(metrics?.commentCount),
      shareCount: numberOf(metrics?.shareCount),
      collectCount: numberOf(metrics?.collectCount),
    },
    geneTags: tags,
    adoptionStatus: textOf(record.adoptionStatus),
    geneStatus: textOf(record.geneStatus),
    updatedAt: textOf(record.updatedAt),
    shareUrl: safeHttpUrl(record.shareUrl),
    manualNotes: textOf(record.manualNotes),
    reportJson: recordOf(record.reportJson) ?? null,
    geneEvidenceJson: recordOf(record.geneEvidenceJson) ?? null,
    geneAttemptCount: numberOf(record.geneAttemptCount),
    geneErrorCode: textOf(record.geneErrorCode),
    geneErrorSummary: textOf(record.geneErrorSummary),
    audienceInsightState: textOf(record.audienceInsightState),
    bgmStyleState: textOf(record.bgmStyleState),
  }
}

/** 维度定义（id/name/maxLabels）。 */
export interface GeneDimension {
  id: string
  name: string
  maxLabels: number
}

/** facets 条目。 */
export interface GeneFacetEntry {
  label: string
  count: number
}

/** gene.search 投影。 */
export interface GeneSearch {
  results: GeneRecord[]
  total: number | null
  hasMore: boolean
  facets: Record<string, GeneFacetEntry[]>
  facetsError: boolean
  stats: { total: number | null; last7d: number | null; adoptedRatio: number | null; failedCount: number | null } | null
  statsError: boolean
  dimensions: GeneDimension[]
}

export function readGeneSearch(payload: Record<string, unknown>): GeneSearch {
  const data = recordOf(payload.data) ?? {}
  const facets: Record<string, GeneFacetEntry[]> = {}
  const rawFacets = recordOf(data.facets)
  if (rawFacets !== undefined) {
    for (const [dim, entries] of Object.entries(rawFacets)) {
      if (!Array.isArray(entries)) continue
      facets[dim] = entries.map(entry => {
        const item = recordOf(entry)
        if (item === undefined) return null
        const label = textOf(item.label)
        if (label === null) return null
        return { label, count: numberOf(item.count) ?? 0 }
      }).filter((row): row is GeneFacetEntry => row !== null)
    }
  }
  const stats = recordOf(data.stats)
  return {
    results: arrayOf(data.results).map(geneRecordOf).filter((row): row is GeneRecord => row !== null),
    total: numberOf(data.total),
    hasMore: booleanOf(data.hasMore),
    facets,
    facetsError: booleanOf(data.facetsError),
    stats: stats === undefined ? null : {
      total: numberOf(stats.total),
      last7d: numberOf(stats.last7d),
      adoptedRatio: numberOf(stats.adoptedRatio),
      failedCount: numberOf(stats.failedCount),
    },
    statsError: booleanOf(data.statsError),
    dimensions: arrayOf(data.dimensions).map(entry => {
      const item = recordOf(entry)
      if (item === undefined) return null
      const id = textOf(item.id)
      if (id === null) return null
      return { id, name: textOf(item.name) ?? id, maxLabels: numberOf(item.maxLabels) ?? 3 }
    }).filter((row): row is GeneDimension => row !== null),
  }
}

/** gene.get → 单条详情。 */
export function readGeneRecord(payload: Record<string, unknown>): GeneRecord | null {
  // Workbench MCP knowledge_get 把 record 平铺在 data 顶层（与 gene.search
  // results 条目同构）；兼容旧 route 的 data.record 包装形态。
  const data = recordOf(payload.data)
  return geneRecordOf(data?.record ?? data)
}

/** 维度依据条目（label/basis）；非对象条目按既有解析规则剔除。 */
export interface GeneEvidenceItem {
  label: string
  basis: string
}

/** geneEvidenceJson[dim] → 依据条目数组（守卫式投影，无类型断言）。 */
export function readGeneEvidence(value: unknown): GeneEvidenceItem[] {
  if (!Array.isArray(value)) return []
  const items: GeneEvidenceItem[] = []
  for (const entry of value) {
    const record = recordOf(entry)
    if (record === undefined) continue
    items.push({
      label: typeof record.label === 'string' ? record.label : '',
      basis: typeof record.basis === 'string' ? record.basis : '',
    })
  }
  return items
}

/** gene.list（失败条目）→ 记录数组。 */
export function readGeneList(payload: Record<string, unknown>): GeneRecord[] {
  const data = recordOf(payload.data) ?? {}
  return arrayOf(data.items ?? data.results).map(geneRecordOf)
    .filter((row): row is GeneRecord => row !== null)
}

// ---- 导出 ----

/** 导出载荷投影（base64 + 字节数 + 文件名）。 */
export interface ExportPayload {
  fileName: string
  mimeType: string
  base64: string
  contentBytes: number
}

/** export / overview.export / accountAnalysis.export → ExportPayload。 */
export function readExport(payload: Record<string, unknown>): ExportPayload {
  const base64 = textOf(payload.content_base64)
  const contentBytes = numberOf(payload.content_bytes)
  return {
    fileName: textOf(payload.file_name) ?? 'douyin-export.xlsx',
    mimeType: textOf(payload.mime_type) ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    base64: base64 ?? '',
    contentBytes: contentBytes ?? 0,
  }
}
