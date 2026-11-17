/**
 * 视频号助手响应解析（移植旧 parse.js 全语义）：上海时区日窗、长数字 ID 保真、
 * auth_data/post_list/留存/按日序列/fans_trend/画像。空值/非数字一律 null，
 * 不补 0；会话失效抛 SessionInvalidError。
 * @module
 */
import { WxError } from './errors.ts'

const SHANGHAI_OFFSET_SECONDS = 8 * 3600

/** SessionInvalidError：解析层在官方明确返回登录失效形态时抛出；采集收尾保留已采集数据。 */
export class SessionInvalidError extends Error {
  /** Stable machine code. */
  readonly code = 'WX_SESSION_INVALID'
  /** Short reason (≤64 chars). */
  readonly reason: string

  constructor(reason = 'session_invalid') {
    super(`wx_channels_session_invalid: ${reason}`)
    this.name = 'SessionInvalidError'
    this.reason = reason.slice(0, 64)
  }
}

/** 日序列等确定性解析失败的稳定码载体（collector/ingest 层映射）。 */
export class ParseCodeError extends Error {
  /** Stable code (e.g. TIME_SERIES_LENGTH_MISMATCH). */
  readonly code: string

  constructor(code: string) {
    super(code)
    this.name = 'ParseCodeError'
    this.code = code
  }
}

/**
 * Shanghai midnight (seconds) for one ISO day.
 * @param dayIso - YYYY-MM-DD.
 * @returns epoch seconds.
 * @throws when the day is not a valid date.
 */
export function shanghaiDayStartTs(dayIso: string): number {
  const ms = Date.parse(`${dayIso}T00:00:00+08:00`)
  if (Number.isNaN(ms)) throw new ParseCodeError(`INVALID_DAY_RANGE`)
  return Math.floor(ms / 1000)
}

/** Epoch seconds → Shanghai calendar day (YYYY-MM-DD). */
export function shanghaiDayFromTs(tsSeconds: number): string {
  const shifted = new Date((Number(tsSeconds) + SHANGHAI_OFFSET_SECONDS) * 1000)
  return shifted.toISOString().slice(0, 10)
}

/** Latest completed Shanghai day (yesterday; the running day never enters day tables). */
export function latestCompletedDay(now: Date | number | (() => Date | number) = new Date()): string {
  const moment = typeof now === 'function' ? now() : now
  const ms = moment instanceof Date ? moment.getTime() : Number(moment)
  const shifted = new Date(ms + SHANGHAI_OFFSET_SECONDS * 1000)
  shifted.setUTCDate(shifted.getUTCDate() - 1)
  return shifted.toISOString().slice(0, 10)
}

/** Inclusive window's expected point count. */
export function expectedSeriesLength(startTs: number, endTs: number): number {
  return Math.floor((Number(endTs) - Number(startTs)) / 86400) + 1
}

/** Common request wrapper: millisecond timestamp string + scene=7. */
export function commonRequestFields(finderId = '', now: () => number = Date.now): Record<string, unknown> {
  return {
    timestamp: String(now()),
    _log_finder_uin: '',
    _log_finder_id: finderId,
    rawKeyBuff: '',
    pluginSessionId: null,
    scene: 7,
    reqScene: 7,
  }
}

/** Seconds → millisecond timestamp string (official wrapper's timestamp form). */
export function toMillisTimestamp(seconds: unknown): string | null {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return null
  return String(Math.floor(value * 1000))
}

const LONG_ID_KEYS_SOURCE = '(objectId|exportId|objectNonce|finderUsername)'

/**
 * Parse JSON with ≥16-digit bare numeric ids quoted first (objectId is a string
 * upstream; old payloads with bare numbers would lose precision in JSON.parse).
 * @param text - raw JSON text.
 * @returns the parsed value, or null when unparseable.
 */
export function parseJsonPreservingIds(text: string): unknown {
  let candidate = text
  try {
    candidate = candidate.replace(
      new RegExp(`${LONG_ID_KEYS_SOURCE}"\\s*:\\s*(\\d{16,})`, 'gu'),
      '$1":"$2"',
    )
  } catch (error: unknown) {
    // 正则构造失败（理论不可达）时退回原文。
    void error
    candidate = text
  }
  try {
    return JSON.parse(candidate)
  } catch (error: unknown) {
    void error
    return null
  }
}

/** Whether the auth_data payload marks an invalid/absent session. */
export function isAuthSessionInvalid(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true
  const record = payload as { errCode?: unknown; data?: { finderUser?: unknown } }
  if (Number(record.errCode) !== 0) return true
  const user = record.data?.finderUser as { finderUsername?: unknown } | undefined
  return !user || typeof user !== 'object' || !user.finderUsername
}

/** One account profile read from auth_data. */
export interface AuthProfile {
  accountId: string
  nickname: string | null
  avatar: string | null
  fansCount: number | null
  feedsCount: number | null
  isMasterFinder: boolean | null
}

/**
 * Parse auth_data: a payload without finderUsername throws SessionInvalidError
 * (login detection and collect probing share the rule).
 * @param payload - the auth_data response payload.
 * @returns the profile.
 */
export function parseAuthData(payload: unknown): AuthProfile {
  if (isAuthSessionInvalid(payload)) {
    const message = payload && typeof payload === 'object' && typeof (payload as { errMsg?: unknown }).errMsg === 'string'
      ? String((payload as { errMsg: string }).errMsg)
      : 'auth_data_unavailable'
    throw new SessionInvalidError(message)
  }
  const user = (payload as { data: { finderUser: Record<string, unknown> } }).data.finderUser
  return {
    accountId: String(user.finderUsername),
    nickname: textOrNull(user.nickname),
    avatar: urlOrNull(user.headImgUrl),
    fansCount: intOrNull(user.fansCount),
    feedsCount: intOrNull(user.feedsCount),
    isMasterFinder: typeof user.isMasterFinder === 'boolean' ? user.isMasterFinder : null,
  }
}

/** One work row projected from post_list (missing fields stay null; NULL ≠ 0). */
export interface WorkItem {
  workId: string
  exportId: string | null
  title: string | null
  description: string | null
  coverUrl: string | null
  publishTime: string | null
  mediaType: number | null
  durationS: number | null
  width: number | null
  height: number | null
  visibility: string
  playCount: number | null
  likeCount: number | null
  favoriteCount: number | null
  commentCount: number | null
  forwardCount: number | null
  shareCount: number | null
  followCount: number | null
  wecomLinkClickCount: number | null
  wecomLinkClickUv: number | null
  wecomContactAddCount: number | null
  wecomContactAddUv: number | null
  ringsetCount: number | null
  statusCoverCount: number | null
  statusRefCount: number | null
  completionRatePct: number | null
  avgPlayDurationS: number | null
  fastFlipRatePct: number | null
  yesterdayPlayCount: number | null
  isOriginal: boolean | null
  [key: string]: unknown
}

function parsePostListItem(item: unknown): WorkItem | null {
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const workId = textOrNull(record.objectId)
  if (!workId) return null
  const desc = (record.desc && typeof record.desc === 'object' ? record.desc : {}) as Record<string, unknown>
  const media = (Array.isArray(desc.media) && desc.media[0] && typeof desc.media[0] === 'object' ? desc.media[0] : {}) as Record<string, unknown>
  const shortTitle = Array.isArray(desc.shortTitle) && desc.shortTitle[0] && typeof desc.shortTitle[0] === 'object'
    ? (desc.shortTitle[0] as { shortTitle?: unknown }).shortTitle
    : null
  const createTime = Number(record.createTime)
  const originalInfo = (record.originalInfo && typeof record.originalInfo === 'object' ? record.originalInfo : {}) as Record<string, unknown>
  return {
    workId,
    exportId: textOrNull(record.exportId),
    title: textOrNull(shortTitle),
    description: textOrNull(desc.description),
    // 封面只收 http(s) URL：官方该字段在部分账号上返回错误文本，不入库。
    coverUrl: urlOrNull(media.coverUrl),
    publishTime: Number.isFinite(createTime) && createTime > 0 ? new Date(createTime * 1000).toISOString() : null,
    mediaType: intOrNull(media.mediaType),
    durationS: intOrNull(media.videoPlayLen),
    width: intOrNull(media.width),
    height: intOrNull(media.height),
    visibility: visibilityOf(record),
    playCount: intOrNull(record.readCount),
    likeCount: intOrNull(record.likeCount),
    favoriteCount: intOrNull(record.favCount),
    commentCount: intOrNull(record.commentCount),
    forwardCount: intOrNull(record.forwardCount),
    shareCount: intOrNull(record.forwardAggregationCount),
    followCount: intOrNull(record.followCount),
    wecomLinkClickCount: intOrNull(record.wecomLinkClickCount),
    wecomLinkClickUv: intOrNull(record.wecomLinkClickUv),
    wecomContactAddCount: intOrNull(record.wecomContactAddCount),
    wecomContactAddUv: intOrNull(record.wecomContactAddUv),
    ringsetCount: intOrNull(record.ringsetCount),
    statusCoverCount: intOrNull(record.snscoverCount),
    statusRefCount: intOrNull(record.statusrefCount),
    completionRatePct: ratioPct(record.fullPlayRate),
    avgPlayDurationS: numberOrNull(record.avgPlayTimeSec),
    fastFlipRatePct: ratioPct(record.fastFlipRate),
    yesterdayPlayCount: intOrNull(record.yesterdayReadCount),
    isOriginal: boolOrNull(originalInfo.isDeclared),
  }
}

function visibilityOf(item: Record<string, unknown>): string {
  const disableInfo = (item.disableInfo && typeof item.disableInfo === 'object' ? item.disableInfo : {}) as Record<string, unknown>
  if (disableInfo.isDisabled === true) return 'disabled'
  const visibleType = intOrNull(item.visibleType)
  if (visibleType === null) return 'active'
  return visibleType === 0 ? 'active' : `visible_${String(visibleType)}`
}

/** One parsed post_list page. */
export interface PostListPage {
  works: WorkItem[]
  totalCount: number | null
  rawCount: number
}

/**
 * Parse one post_list page: totalCount is the expectation; objectId dedupe is
 * the collector's cross-page duty; session-invalid payloads throw.
 * @param payload - the page payload.
 * @returns works + totalCount + raw count.
 */
export function parsePostListPage(payload: unknown): PostListPage {
  if (!payload || typeof payload !== 'object') return { works: [], totalCount: null, rawCount: 0 }
  const record = payload as Record<string, unknown>
  const errCode = Number(record.errCode)
  if (errCode !== 0 && !Number.isNaN(errCode)) {
    const message = String(record.errMsg ?? '')
    if (/login|auth|session|登录/iu.test(message)) throw new SessionInvalidError(message)
    throw new ParseCodeError('VALIDATION_ERROR')
  }
  const data = (record.data && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>
  const list = Array.isArray(data.list) ? data.list : []
  const works = list.map(parsePostListItem).filter((item): item is WorkItem => item !== null)
  return { works, totalCount: intOrNull(data.totalCount), rawCount: list.length }
}

/** One work's retention curve. */
export interface FeedLostRate {
  videoDurationS: number | null
  maxLostRateSecond: number | null
  points: Array<{ second: number | null; ratePct: number | null }>
}

/** Parse get_feed_lost_rate (viewer retention). */
export function parseFeedLostRate(payload: unknown): FeedLostRate | null {
  const data = payload && typeof payload === 'object' && (payload as { data?: unknown }).data && typeof (payload as { data: unknown }).data === 'object'
    ? (payload as { data: Record<string, unknown> }).data
    : null
  if (!data) return null
  const items = Array.isArray(data.items) ? data.items : []
  const points = items
    .map(point => {
      const record = (point && typeof point === 'object' ? point : {}) as Record<string, unknown>
      return { second: intOrNull(record.sec), ratePct: ratioPct(record.rate) }
    })
    .filter(point => point.second !== null)
  return { videoDurationS: intOrNull(data.videoLen), maxLostRateSecond: intOrNull(data.maxLostRateSec), points }
}

/** §15.1.1 metric tiers. */
export const CORE_METRICS = ['browse', 'like', 'comment', 'forward', 'fav'] as const
export const EXTENDED_METRICS = ['ringset', 'snscover', 'statusref', 'forwardAggregation', 'follow', 'wecomLinkClick', 'wecomContactAdd'] as const

const METRIC_FIELD_MAP: Record<string, string> = {
  browse: 'daily_play_count',
  like: 'daily_like_count',
  comment: 'daily_comment_count',
  forward: 'daily_forward_count',
  fav: 'daily_favorite_count',
  forwardAggregation: 'daily_share_count',
  follow: 'daily_follow_count',
  ringset: 'daily_ringset_count',
  snscover: 'daily_status_cover_count',
  statusref: 'daily_status_ref_count',
  wecomLinkClick: 'daily_wecom_link_click_count',
  wecomContactAdd: 'daily_wecom_contact_add_count',
}

const SOURCE_TYPE_NAMES: Record<number, string> = {
  999: '全部', 3: '关注', 8: '朋友♡', 4: '推荐', 6: '分享', 16: '订阅号消息', 20: '主页', 25: '看一看', 15: 'PC微信', 0: '其他',
}

const SOURCE_KEY_MAP: Record<number, string> = {
  999: 'all', 3: 'follow', 8: 'friends', 4: 'recommend', 6: 'share', 16: 'subscription', 20: 'profile', 25: 'kansikan', 15: 'pc_wechat', 0: 'other',
}

/** dataByFanstype[fansType=1] group; null when the structure is missing. */
function pickDefaultFanstypeGroup(payload: unknown): Array<Record<string, unknown>> | null {
  const data = payload && typeof payload === 'object' && (payload as { data?: unknown }).data && typeof (payload as { data: unknown }).data === 'object'
    ? (payload as { data: Record<string, unknown> }).data
    : null
  const groups = data && Array.isArray(data.dataByFanstype) ? data.dataByFanstype : []
  const group = groups.find(item => Number((item as { fansType?: unknown })?.fansType) === 1) as Record<string, unknown> | undefined
  if (!group) return null
  const tabs = group.dataByTabtype
  return Array.isArray(tabs) ? tabs as Array<Record<string, unknown>> : typeof tabs === 'object' && tabs ? Object.values(tabs) as Array<Record<string, unknown>> : null
}

interface SourceRow {
  tabType: number
  series: Record<string, Array<unknown> | null>
}

function parseSourceRow(tab: unknown): SourceRow | null {
  if (!tab || typeof tab !== 'object') return null
  const record = tab as Record<string, unknown>
  const tabType = intOrNull(record.tabType)
  if (tabType === null) return null
  const data = (record.data && typeof record.data === 'object' ? record.data : {}) as Record<string, unknown>
  const series: Record<string, Array<unknown> | null> = {}
  for (const [metric, field] of Object.entries(METRIC_FIELD_MAP)) {
    void field
    series[metric] = Array.isArray(data[metric]) ? data[metric] as Array<unknown> : null
  }
  return { tabType, series }
}

/** One daily account-metric row (fields per METRIC_FIELD_MAP; dataGap per-day). */
export interface DailyMetricRow {
  day: string
  dataGap?: Record<string, { reason: string }>
  [key: string]: unknown
}

/** Parsed daily-series window. */
export interface DailySeries {
  rows: DailyMetricRow[]
  trafficSource: {
    window: { startDay: string; endDay: string }
    rows: Array<{ sourceType: number; sourceKey: string; name: string; playCount: number }>
    dataGap?: Record<string, unknown>
  }
}

/**
 * Parse a by-day window (normative §15.1.1): core metrics of the used tab must
 * match the window length exactly (TIME_SERIES_LENGTH_MISMATCH); extended
 * metrics degrade to per-day gaps; the 999 tab is preferred, missing 999 warns.
 * @param payload - the aggregate payload.
 * @param startTs - window start (epoch seconds, inclusive).
 * @param endTs - window end (epoch seconds, inclusive).
 * @returns rows + window-aggregated traffic source.
 */
export function parseDailySeries(payload: unknown, startTs: number, endTs: number): DailySeries {
  const tabs = pickDefaultFanstypeGroup(payload)
  // 「不限(fansType=1)」分组缺失是响应缺结构，用独立稳定码避免误导（P3-23）。
  if (!tabs) throw new ParseCodeError('LIST_INCOMPLETE')
  const length = expectedSeriesLength(startTs, endTs)
  if (length < 1) throw new ParseCodeError('INVALID_DAY_RANGE')
  const rows = tabs.map(parseSourceRow).filter((row): row is SourceRow => row !== null)
  if (!rows.length) throw new ParseCodeError('TIME_SERIES_LENGTH_MISMATCH')

  // 基础指标强校验只施加于实际入表的「全部(999)」行；冷门来源少返 1 天不判废。
  const allTab = rows.find(row => row.tabType === 999)
  const missingAllTab = !allTab
  const usedTab = allTab ?? rows[0] as SourceRow
  for (const metric of CORE_METRICS) {
    const series = usedTab.series[metric]
    if (!series || series.length !== length) throw new ParseCodeError('TIME_SERIES_LENGTH_MISMATCH')
  }

  const unknownSources: number[] = []
  const days: DailyMetricRow[] = []
  for (let index = 0; index < length; index += 1) {
    const dayTs = Number(startTs) + index * 86400
    const day = shanghaiDayFromTs(dayTs)
    const row: DailyMetricRow = { day }
    const dataGap: Record<string, { reason: string }> = {}
    for (const [metric, field] of Object.entries(METRIC_FIELD_MAP)) {
      const isCore = (CORE_METRICS as readonly string[]).includes(metric)
      const series = usedTab.series[metric]
      if (!isCore && (!series || series.length !== length)) {
        dataGap[field] = { reason: series && series.length !== length ? 'FIELD_LENGTH_MISMATCH' : 'not_exposed' }
        continue
      }
      const raw = (series as Array<unknown>)[index]
      const value = intOrNull(typeof raw === 'string' ? raw.trim() : raw)
      if (value === null) {
        dataGap[field] = { reason: 'not_exposed' }
        continue
      }
      row[field] = value
    }
    if (Object.keys(dataGap).length) row.dataGap = dataGap
    days.push(row)
  }

  const sourceRows: DailySeries['trafficSource']['rows'] = []
  for (const row of rows) {
    if (!SOURCE_TYPE_NAMES[row.tabType]) unknownSources.push(row.tabType)
    let total = 0
    const series = row.series.browse as Array<unknown> | null
    for (let index = 0; index < length; index += 1) {
      const raw = series !== null ? series[index] : undefined
      const value = intOrNull(typeof raw === 'string' ? raw.trim() : raw)
      // 缺失点跳过，不按 0 计入基数（P2-16）。
      if (value !== null) total += value
    }
    sourceRows.push({
      sourceType: row.tabType,
      sourceKey: SOURCE_KEY_MAP[row.tabType] ?? `unknown_${String(row.tabType)}`,
      name: SOURCE_TYPE_NAMES[row.tabType] ?? '其他',
      playCount: total,
    })
  }

  const trafficSource: DailySeries['trafficSource'] = {
    window: { startDay: shanghaiDayFromTs(Number(startTs)), endDay: shanghaiDayFromTs(Number(endTs)) },
    rows: sourceRows,
  }
  const trafficGap: Record<string, unknown> = {}
  if (missingAllTab) {
    trafficGap.source_tab_missing = { reason: 'not_exposed', usedTabType: usedTab.tabType }
  }
  if (unknownSources.length) trafficGap.unknown_source_type = unknownSources.map(Number)
  if (Object.keys(trafficGap).length) trafficSource.dataGap = trafficGap
  return { rows: days, trafficSource }
}

/** One fans-trend daily row. */
export interface FansTrendRow {
  day: string
  dataGap?: Record<string, { reason: string }>
  follower_add_count?: number
  follower_reduce_count?: number
  follower_net_count?: number
  follower_total_count?: number
  sourceTrend?: { rows: Array<{ sourceType: number; sourceKey: string; name: string; add: number }> }
  [key: string]: unknown
}

/** Parsed fans trend window. */
export interface FansTrend {
  daily: FansTrendRow[]
  sourceTrend: { rows: Array<{ sourceType: number; sourceKey: string; name: string; daily: Array<{ day: string; add: number }> }> } | null
}

const FANS_METRICS: Record<string, string> = {
  add: 'follower_add_count',
  reduce: 'follower_reduce_count',
  netAdd: 'follower_net_count',
  total: 'follower_total_count',
}

/**
 * Parse fans_trend: all four metrics are core-checked (any gap rejects the
 * window); fansDataByTabtype maps to source_trend (flat or wrapped forms both
 * accepted — P2-2).
 * @param payload - the fans_trend payload.
 * @param startTs - window start (seconds).
 * @param endTs - window end (seconds).
 * @returns daily rows + source trend.
 */
export function parseFansTrend(payload: unknown, startTs: number, endTs: number): FansTrend {
  const data = payload && typeof payload === 'object' && (payload as { data?: unknown }).data && typeof (payload as { data: unknown }).data === 'object'
    ? (payload as { data: Record<string, unknown> }).data
    : null
  if (!data) throw new ParseCodeError('TIME_SERIES_LENGTH_MISMATCH')
  const length = expectedSeriesLength(startTs, endTs)
  const series: Record<string, Array<unknown>> = {}
  for (const metric of Object.keys(FANS_METRICS)) {
    const values = Array.isArray(data[metric]) ? data[metric] as Array<unknown> : null
    if (!values || values.length !== length) throw new ParseCodeError('TIME_SERIES_LENGTH_MISMATCH')
    series[metric] = values
  }
  const daily: FansTrendRow[] = []
  for (let index = 0; index < length; index += 1) {
    const day = shanghaiDayFromTs(Number(startTs) + index * 86400)
    const row: FansTrendRow = { day }
    const dataGap: Record<string, { reason: string }> = {}
    for (const [metric, field] of Object.entries(FANS_METRICS)) {
      const points = series[metric] ?? []
      const value = intOrNull(String(points[index] ?? '').trim() || null)
      if (value === null) {
        dataGap[field] = { reason: 'not_exposed' }
        continue
      }
      row[field] = value
    }
    if (Object.keys(dataGap).length) row.dataGap = dataGap
    daily.push(row)
  }
  const sourceTrendRows: Array<{ sourceType: number; sourceKey: string; name: string; daily: Array<{ day: string; add: number }> }> = []
  const tabs = Array.isArray(data.fansDataByTabtype) ? data.fansDataByTabtype as Array<Record<string, unknown>> : []
  for (const tab of tabs) {
    if (!tab || typeof tab !== 'object') continue
    const tabType = intOrNull(tab.tabType)
    if (tabType === null) continue
    const dailyRows: Array<{ day: string; add: number }> = []
    const tabData = tab.data && typeof tab.data === 'object' ? tab.data as Record<string, unknown> : null
    const add = Array.isArray(tab.add) ? tab.add : (Array.isArray(tabData?.add) ? tabData.add as Array<unknown> : [])
    for (let index = 0; index < Math.min(add.length, length); index += 1) {
      const value = intOrNull(String(add[index] ?? '').trim() || null)
      if (value === null) continue
      dailyRows.push({ day: shanghaiDayFromTs(Number(startTs) + index * 86400), add: value })
    }
    sourceTrendRows.push({
      sourceType: tabType,
      sourceKey: SOURCE_KEY_MAP[tabType] ?? `unknown_${String(tabType)}`,
      name: SOURCE_TYPE_NAMES[tabType] ?? '其他',
      daily: dailyRows,
    })
  }
  return { daily, sourceTrend: sourceTrendRows.length ? { rows: sourceTrendRows } : null }
}

/** Parsed fans portrait (five aggregate dimensions; unknown dims land in dataGap). */
export interface FansPortrait {
  age: Array<{ key: string; label: string; count: number }> | null
  gender: Array<{ key: string; label: string; count: number }> | null
  province: Array<{ key: string; label: string; count: number }> | null
  city: Array<{ key: string; label: string; count: number }> | null
  device: Array<{ key: string; label: string; count: number }> | null
  dataGap: Record<string, unknown>
}

const PORTRAIT_NAME_MAP: Record<string, 'age' | 'gender' | 'province' | 'city' | 'device'> = {
  age_list: 'age',
  sex_list: 'gender',
  province_list: 'province',
  city_list: 'city',
  device_list: 'device',
}

/**
 * Parse the portrait: only the five aggregate dimensions enter storage; new
 * official dimensions are recorded as data_gap only (§5.8).
 * @param payload - the fans_portrait payload (data.respJson may be a JSON string).
 * @returns the parsed portrait.
 */
export function parseFansPortrait(payload: unknown): FansPortrait {
  const data = payload && typeof payload === 'object' && (payload as { data?: unknown }).data && typeof (payload as { data: unknown }).data === 'object'
    ? (payload as { data: Record<string, unknown> }).data
    : null
  const raw = data ? data.respJson : null
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    parsed = parseJsonPreservingIds(raw)
    if (parsed === null) {
      try {
        parsed = JSON.parse(raw)
      } catch (error: unknown) {
        // 二次解析失败保留 null。
        void error
        parsed = null
      }
    }
  }
  const list = parsed && typeof parsed === 'object' && Array.isArray((parsed as { metric_info_list?: unknown }).metric_info_list)
    ? (parsed as { metric_info_list: Array<unknown> }).metric_info_list
    : []
  const result: FansPortrait = {
    age: null as FansPortrait['age'],
    gender: null as FansPortrait['gender'],
    province: null as FansPortrait['province'],
    city: null as FansPortrait['city'],
    device: null as FansPortrait['device'],
    dataGap: {},
  }
  const unknown: string[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const dimension = PORTRAIT_NAME_MAP[String(record.name ?? '')]
    const values = Array.isArray(record.value) ? record.value : []
    const rows = values
      .map(entry => {
        const entryRecord = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
        return { key: textOrNull(entryRecord.dim), label: textOrNull(entryRecord.dim), count: intOrNull(entryRecord.value) }
      })
      .filter(row => row.key !== null && row.count !== null)
    if (!dimension) {
      if (record.name !== undefined && record.name !== null) unknown.push(String(record.name))
      continue
    }
    // 五个维度元素结构相同；dimension 是联合键，按元素结构统一赋值。
    if (rows.length) result[dimension] = rows as FansPortrait['age']
  }
  if (unknown.length) result.dataGap.fans_profile = { unknown_metric: unknown }
  return result
}

/** int passthrough: empty/non-numeric → null, never 0. */
export function intOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'boolean') return value ? 1 : 0
  const num = Number(String(value))
  return Number.isFinite(num) ? Math.trunc(num) : null
}

/** number passthrough: empty/non-numeric → null. */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** Fraction → 0..100 percent (fullPlayRate*100); missing/out-of-range → null. */
export function ratioPct(value: unknown): number | null {
  const num = numberOrNull(value)
  if (num === null) return null
  const pct = Math.round(num * 100 * 1e6) / 1e6
  return pct >= 0 && pct <= 100 ? pct : null
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()
  return text ? text : null
}

/** URL field: only absolute http(s) addresses (dirty cover texts stay out). */
export function urlOrNull(value: unknown): string | null {
  const text = textOrNull(value)
  if (!text) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null
  } catch (error: unknown) {
    void error
    return null
  }
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

// WxError 仅用于类型兼容（本文件以 ParseCodeError/SessionInvalidError 为主）。
void WxError
