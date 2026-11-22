/**
 * 采集解析层（移植旧 parse.js 全语义）：19 位 aweme_id 先取文本→对 ≥16 位数字
 * 加引号再 JSON.parse（float64 舍入防线）；HTTP 200 + `status_code: 8` 是业务层
 * 会话失效，解析层必须抛 SessionInvalidError（防旧实现按空列表假成功）；数值
 * 换算无 -0；百分比 0..1 → 0..100 定义域守卫（越界记缺口不造值）；四种缺口
 * 语义 not_exposed / below_min_view / request_failed / no_data 不可互换。
 * @module
 */

/** 会话失效业务码（HTTP 200 + status_code 8）。 */
export const SESSION_EXPIRED_STATUS_CODE = 8

/** 业务层会话失效（确定性证据；采集立即中止并上报 expired）。 */
export class SessionInvalidError extends Error {
  /** Stable reason（local stable codes 之内的细分原因）。 */
  readonly code = 'session_invalid'
  /** 服务端业务状态码（恒 8）。 */
  readonly statusCode: number
  /** 细分原因（account_mismatch 等可行动文案可达）。 */
  readonly reason: string
  /** 采集层挂载的部分成果（过期收尾入库保留）。 */
  partialCollected?: PartialCollected
  /** 列表阶段失效时带出的已采集作品（scope 内已过滤）。 */
  partialListWorks?: WorkItem[]

  constructor(statusCode: number, reason = 'session_invalid') {
    super(`session_invalid (status_code ${String(statusCode)})`)
    this.name = 'SessionInvalidError'
    this.statusCode = statusCode
    this.reason = reason
  }
}

/** 过期收尾的部分成果包（载荷形状，入库保留）。 */
export interface PartialCollected {
  works: Record<string, unknown>[]
  listComplete: boolean
  expectedWorkCount: number
  publishSince: string | null
}

/** Whether one response payload carries the deterministic session-expired marker. */
export function isSessionExpiredPayload(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  return (json as { status_code?: unknown }).status_code === SESSION_EXPIRED_STATUS_CODE
}

/** null/undefined/''/boolean → null；非有限 → null；`-0` 收敛为 0。 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return num === 0 ? 0 : num
}

/** 0..1 → 0..100 两位小数；越界返回 null（缺口，服务端 ge=0,le=100 会整批拒绝）。 */
export function pct(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 1) return null
  return Math.round(num * 100 * 100) / 100
}

/** 时长类秒值：负数 → null；两位小数；`-0` 收敛。 */
export function round2(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return null
  const rounded = Math.round(num * 100) / 100
  return rounded === 0 ? 0 : rounded
}

/** Math.trunc；`-0` 收敛为 0。 */
export function toInt(value: unknown): number | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  const truncated = Math.trunc(num)
  return truncated === 0 ? 0 : truncated
}

/** 文本夹取（上限截断；空串归 null）。 */
export function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  return text.slice(0, max)
}

/** url_list / urlList / url 递归取首个字符串。 */
export function firstUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() !== '' ? value.trim() : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstUrl(item)
      if (found !== null) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['url_list', 'urlList', 'url']) {
      if (key in record) {
        const found = firstUrl(record[key])
        if (found !== null) return found
      }
    }
  }
  return null
}

/**
 * Quote standalone integer literals with ≥16 digits so JSON.parse keeps them
 * as strings（19 位 aweme_id 裸数字会被 float64 舍入）。
 * @param text - raw response text.
 * @returns quoted text safe for JSON.parse.
 */
export function quoteLongNumbers(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index] ?? ''
    if (char >= '0' && char <= '9') {
      let end = index
      while (end < text.length && (text[end] ?? '') >= '0' && (text[end] ?? '') <= '9') end += 1
      const digits = text.slice(index, end)
      const prev = index > 0 ? text[index - 1] ?? '' : ''
      const next = end < text.length ? text[end] ?? '' : ''
      const prevOk = prev === '' || !/[0-9A-Za-z_.\-+]/u.test(prev)
      const nextOk = next === '' || /[,}\]\s]/u.test(next)
      if (digits.length >= 16 && prevOk && nextOk) out += `"${digits}"`
      else out += digits
      index = end
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** parseJsonPreservingIds：先加引号再 JSON.parse，失败返回 null。 */
export function parseJsonPreservingIds(text: string): unknown {
  try {
    return JSON.parse(quoteLongNumbers(text))
  } catch {
    return null
  }
}

/** 上海语义日（YYYY-MM-DD；toLocaleDateString sv-SE 形态）。 */
export function shanghaiDayFromTs(tsSeconds: number): string {
  return new Date(tsSeconds * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

/** 上海今天（采集侧 dropFuture 用）。 */
export function shanghaiTodayIso(now: () => number = Date.now): string {
  return shanghaiDayFromTs(Math.floor(now() / 1000))
}

/** 作品列表项（设备端采集层的白名单形状）。 */
export interface WorkItem {
  workId: string
  title: string | null
  url: string | null
  publishTime: string | null
  playCount: number | null
  likeCount: number | null
  commentCount: number | null
  collectCount: number | null
  shareCount: number | null
  danmakuCount: number | null
  durationSeconds: number | null
  cover: string | null
  isPrivate: boolean
}

/** 列表单项归一（旧 normalizeWork：字段兜底链 + 无 -0 + 秒换算）。 */
function normalizeWork(raw: Record<string, unknown>): WorkItem | null {
  const workId = toNumberOrString(firstPresent(raw.aweme_id, raw.awemeId, raw.item_id, raw.id))
  if (workId === null) return null
  const statistics = (raw.statistics && typeof raw.statistics === 'object' ? raw.statistics : {}) as Record<string, unknown>
  const video = (raw.video && typeof raw.video === 'object' ? raw.video : {}) as Record<string, unknown>
  const status = (raw.status && typeof raw.status === 'object' ? raw.status : {}) as Record<string, unknown>
  const createSeconds = toNumber(raw.create_time)
  return {
    workId,
    title: clampText(firstPresent(raw.desc, raw.Description, raw.title), 1024),
    url: clampText(`https://www.douyin.com/video/${workId}`, 2048),
    publishTime: createSeconds !== null ? new Date(createSeconds * 1000).toISOString() : null,
    playCount: toNumber(statistics.play_count),
    likeCount: toNumber(statistics.digg_count),
    commentCount: toNumber(statistics.comment_count),
    collectCount: toNumber(statistics.collect_count),
    shareCount: toNumber(statistics.share_count),
    danmakuCount: toNumber(statistics.danmaku_count),
    durationSeconds: toNumber(video.duration) === null ? null : round2((toNumber(video.duration) ?? 0) / 1000),
    cover: firstUrl(firstPresent(video.cover, raw.Cover, raw.cover)),
    isPrivate: status.is_private === true,
  }
}

/** 数字或字符串 ID 归一（aweme_id 可能以字符串下发）。 */
function toNumberOrString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  const num = toNumber(value)
  return num !== null ? String(num) : null
}

/** 第一个非 undefined/null 值。 */
export function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

/** 单页解析结果。 */
export interface WorkListPage {
  works: WorkItem[]
  hasMore: boolean
  nextCursor: string | null
  rawCount: number
}

/**
 * 列表单页解析：status_code=8 抛会话失效；aweme_list 归一（无效行丢弃）。
 * @param json - parsed response.
 * @returns the page projection.
 * @throws {SessionInvalidError} the deterministic session-expired marker.
 */
export function parseWorkListPage(json: unknown): WorkListPage {
  if (isSessionExpiredPayload(json)) {
    throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  }
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const rawList = Array.isArray(payload.aweme_list) ? payload.aweme_list as unknown[] : []
  const works: WorkItem[] = []
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const normalized = normalizeWork(item as Record<string, unknown>)
    if (normalized !== null) works.push(normalized)
  }
  const cursor = firstPresent(payload.max_cursor, payload.cursor)
  return {
    works,
    hasMore: payload.has_more === true,
    nextCursor: cursor === undefined ? null : String(cursor),
    rawCount: rawList.length,
  }
}

/** 翻页终止判定（五种不完整之一；cursor 停滞即不健康终止）。 */
export function decidePagination(page: WorkListPage, pageNumber: number, maxPages: number, currentCursor: string): { continue: boolean; nextCursor: string | null; reason: string | null } {
  if (!page.hasMore) return { continue: false, nextCursor: null, reason: null }
  if (page.works.length === 0) return { continue: false, nextCursor: null, reason: 'empty_page_with_more' }
  if (page.nextCursor === null || page.nextCursor === '' || page.nextCursor === currentCursor) {
    return { continue: false, nextCursor: null, reason: 'cursor_not_advancing' }
  }
  if (pageNumber >= maxPages) return { continue: false, nextCursor: null, reason: 'max_pages_reached' }
  return { continue: true, nextCursor: page.nextCursor, reason: null }
}

/** 跨页去重（按 workId，保留首现顺序）。 */
export function dedupeWorks(works: WorkItem[]): WorkItem[] {
  const seen = new Set<string>()
  const kept: WorkItem[] = []
  for (const work of works) {
    if (seen.has(work.workId)) continue
    seen.add(work.workId)
    kept.push(work)
  }
  return kept
}

/** item_compare 解析（低播放三态 gapReason）。 */
export interface CompareMetrics {
  statusCode: number | null
  gapReason: string | null
  metrics: {
    playCount: number | null
    avgWatchDuration: number | null
    completionRate: number | null
    completionRate5s: number | null
    bounceRate2s: number | null
    avgViewProportion: number | null
    coverClickRate: number | null
    followerPlayRatio: number | null
    likeRate: number | null
    commentRate: number | null
    shareRate: number | null
    favoriteRate: number | null
  } | null
  statusMessage: string | null
}

const LOW_PLAY_STATUS_CODE = 10001
const PAST_ITEM_THRESHOLD_STATUS_CODE = 10005

export function parseItemCompare(json: unknown): CompareMetrics {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const statusCode = toNumber(payload.status_code)
  const lowPlay = statusCode === LOW_PLAY_STATUS_CODE
  if (lowPlay) return { statusCode, gapReason: 'below_min_view', metrics: null, statusMessage: clampText(payload.status_msg, 256) }
  if (statusCode === PAST_ITEM_THRESHOLD_STATUS_CODE) {
    return { statusCode, gapReason: 'past_item_below_min_count', metrics: null, statusMessage: clampText(payload.status_msg, 256) }
  }
  const data = (payload.item_data ?? payload.data) as Record<string, unknown> | undefined
  const metricsRaw = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const hasMetrics = Object.keys(metricsRaw).length > 0
  if (!hasMetrics) {
    return { statusCode, gapReason: statusCode !== null && statusCode !== 0 ? 'not_exposed' : 'not_exposed', metrics: null, statusMessage: clampText(payload.status_msg, 256) }
  }
  return {
    statusCode,
    gapReason: null,
    statusMessage: clampText(payload.status_msg, 256),
    metrics: {
      playCount: toNumber(metricsRaw.view_count),
      avgWatchDuration: round2(toNumber(metricsRaw.avg_view_second)),
      completionRate: pct(metricsRaw.completion_rate),
      completionRate5s: pct(metricsRaw.completion_rate_5s),
      bounceRate2s: pct(metricsRaw.bounce_rate_2s),
      avgViewProportion: pct(metricsRaw.avg_view_proportion),
      coverClickRate: pct(metricsRaw.cover_click_rate),
      followerPlayRatio: pct(metricsRaw.fan_view_proportion),
      likeRate: pct(metricsRaw.like_rate),
      commentRate: pct(metricsRaw.comment_rate),
      shareRate: pct(metricsRaw.share_rate),
      favoriteRate: pct(metricsRaw.favorite_rate),
    },
  }
}

const SOURCE_LABELS: Record<string, string> = {
  recommended_homepage: '推荐(首页推荐)',
  personal_profile: '个人主页',
  friend_page: '朋友',
  acquaintance_feed: '熟人',
  follow_feed: '关注',
  search: '搜索',
  im: '私信',
  share: '分享',
  nearby: '同城',
  other: '其他',
}

/** 流量来源行（share_pct 降序）。 */
export interface PlaySourceRow {
  sourceKey: string
  sourceLabel: string | null
  sharePct: number | null
}

export function parsePlaySource(json: unknown): PlaySourceRow[] | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const rows = Array.isArray(payload.play_source) ? payload.play_source as unknown[] : null
  if (rows === null) return null
  const parsed: PlaySourceRow[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = clampText(record.source_key, 64)
    if (key === null) continue
    const labelRaw = clampText(record.source_label, 128)
    parsed.push({
      sourceKey: key,
      sourceLabel: labelRaw !== null && labelRaw !== key ? labelRaw : SOURCE_LABELS[key] ?? null,
      sharePct: pct(record.share_pct),
    })
  }
  return parsed.sort((a, b) => (b.sharePct ?? 0) - (a.sharePct ?? 0))
}

/** 画像分布行。 */
export interface PortraitRow {
  key: string
  pct: number | null
}

export interface AudiencePortrait {
  gender: PortraitRow[] | null
  age: PortraitRow[] | null
  province: PortraitRow[] | null
  cityLevel: PortraitRow[] | null
}

function parseRatioRows(raw: unknown, max = Infinity): PortraitRow[] | null {
  if (!Array.isArray(raw)) return null
  const rows: PortraitRow[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = clampText(record.key, 64)
    if (key === null) continue
    rows.push({ key, pct: pct(record.ratio) })
    if (rows.length >= max) break
  }
  return rows.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
}

export function parsePortrait(json: unknown): AudiencePortrait | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const gender = parseRatioRows(payload.gender)
  const age = parseRatioRows(payload.age)
  const province = parseRatioRows(payload.province, 8)
  const cityLevel = parseRatioRows(payload.city_level)
  const portrait: AudiencePortrait = { gender, age, province, cityLevel }
  if (portrait.gender === null && portrait.age === null && portrait.province === null && portrait.cityLevel === null) return null
  return portrait
}

/** 搜索词行（percent 本身是百分数，原样透出夹 0..100，降序）。 */
export interface SearchKeywordRow {
  keyword: string
  percent: number | null
}

export function parseSearchKeywords(json: unknown): SearchKeywordRow[] | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const rows = Array.isArray(payload.show_from) ? payload.show_from as unknown[] : null
  if (rows === null) return null
  const parsed: SearchKeywordRow[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const keyword = clampText(record.keyword, 128)
    if (keyword === null) continue
    const num = Number(record.percent)
    const percent = Number.isFinite(num) ? Math.min(100, Math.max(0, num)) : null
    parsed.push({ keyword, percent: percent === null ? null : Math.round(percent * 100) / 100 })
  }
  return parsed.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
}

/** 进度分析曲线（empty 标记入库前必须剥离）。 */
export interface ProgressAnalysis {
  jumpBackward: { key: string; value: number | null }[] | null
  jumpForward: { key: string; value: number | null }[] | null
  videoData: unknown
  empty: boolean
}

function parseCurveRows(raw: unknown): { key: string; value: number | null }[] | null {
  if (!Array.isArray(raw)) return null
  const rows: { key: string; value: number | null }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = clampText(record.key, 32)
    if (key === null) continue
    rows.push({ key, value: pct(record.value) })
  }
  return rows
}

export function parseProgressAnalysis(json: unknown): ProgressAnalysis | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const jumpBackward = parseCurveRows(payload.jump_backward)
  const jumpForward = parseCurveRows(payload.jump_forward)
  if (jumpBackward === null && jumpForward === null) return null
  const videoData = payload.video_data ?? null
  return {
    jumpBackward,
    jumpForward,
    videoData,
    empty: (jumpBackward === null || jumpBackward.length === 0) && (jumpForward === null || jumpForward.length === 0) && videoData === null,
  }
}

/** 留存/跳出趋势（曲线 ≤1800 点、valley ≤16 段、empty 标记）。 */
export interface RealtimeTrend {
  current: { key: string; value: number }[]
  similar: { key: string; value: number }[]
  valleys: { start: number; end: number }[]
  empty: boolean
}

const TREND_MAX_POINTS = 1800
const VALLEY_MAX_GROUPS = 16

function parseTrendCurve(raw: unknown): { key: string; value: number }[] {
  if (!Array.isArray(raw)) return []
  const rows: { key: string; value: number }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const key = clampText(record.key, 32)
    const num = Number(record.value)
    if (key === null || !Number.isFinite(num) || num < 0 || num > 1) continue
    const value = Math.min(100, Math.max(0, Math.round(num * 100 * 100) / 100))
    rows.push({ key, value })
    if (rows.length >= TREND_MAX_POINTS) break
  }
  return rows
}

function parseValleys(raw: unknown): { start: number; end: number }[] {
  if (!Array.isArray(raw)) return []
  const groups: { start: number; end: number }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const start = toNumber(record.start)
    const end = toNumber(record.end)
    if (start === null || end === null || start < 0 || end < 0) continue
    groups.push(start <= end ? { start, end } : { start: end, end: start })
    if (groups.length >= VALLEY_MAX_GROUPS) break
  }
  return groups
}

export function parseRealtimeTrend(json: unknown): RealtimeTrend | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const trend = (payload.analysis_trend && typeof payload.analysis_trend === 'object' ? payload.analysis_trend : null) as Record<string, unknown> | null
  if (trend === null) return null
  const current = parseTrendCurve(trend.current)
  const similar = parseTrendCurve(trend.similar)
  const valleys = parseValleys(trend.valley_list)
  return { current, similar, valleys, empty: current.length === 0 && similar.length === 0 }
}

/** item mget 行（Map 按 id 取，拦截可能命中多作品批量请求）。 */
export function parseItemMget(json: unknown): Map<string, Record<string, number | null>> {
  const result = new Map<string, Record<string, number | null>>()
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const items = Array.isArray(payload.items) ? payload.items as unknown[] : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = toNumberOrString(firstPresent(record.item_id, record.aweme_id, record.id))
    if (id === null) continue
    result.set(id, {
      danmakuCount: toNumber(record.danmaku_count),
      playCount: toNumber(firstPresent(record.play_count, record.view_count)),
      avgWatchDuration: round2(toNumber(record.avg_view_second)),
      completionRate: pct(record.completion_rate),
      completionRate5s: pct(record.completion_rate_5s),
      bounceRate2s: pct(record.bounce_rate_2s),
      avgViewProportion: pct(record.avg_view_proportion),
      coverClickRate: pct(record.cover_click_rate),
      followerPlayRatio: pct(firstPresent(record.fan_view_proportion, record.follower_play_ratio)),
    })
  }
  return result
}

/** item summarize 行（两字段独立判缺）。 */
export interface SummarizeRow {
  completionRate: number | null
  fansGainCount: number | null
}

export function parseItemSummarize(json: unknown): Map<string, SummarizeRow> {
  const result = new Map<string, SummarizeRow>()
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const items = Array.isArray(payload.item_list) ? payload.item_list as unknown[] : []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = toNumberOrString(firstPresent(record.item_id, record.aweme_id, record.id))
    if (id === null) continue
    const completionRate = pct(record.play_finish_ratio)
    const fansGain = toInt(record.new_fans_count)
    if (completionRate === null && fansGain === null) continue
    result.set(id, { completionRate, fansGainCount: fansGain !== null && fansGain < 0 ? null : fansGain })
  }
  return result
}

/** 热词三态（status_code===0 才是 ok；unavailable 保留旧集合）。 */
export interface HotwordResult {
  status: 'ok' | 'unavailable'
  statusCode: number | null
  words: { word: string; rank: number | null; rawScore: string | null }[]
  error?: string | undefined
}

export function parseWordCloud(json: unknown): HotwordResult {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const statusCode = toNumber(payload.status_code)
  if (statusCode !== 0) return { status: 'unavailable', statusCode, words: [] }
  const rows = Array.isArray(payload.word_cloud_list) ? payload.word_cloud_list as unknown[] : Array.isArray(payload.data) ? payload.data as unknown[] : []
  const words: HotwordResult['words'] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const word = clampText(firstPresent(record.word, record.keyword), 128)
    if (word === null) continue
    const rank = toInt(record.rank)
    words.push({ word, rank: rank !== null && rank >= 0 ? rank : null, rawScore: clampText(record.raw_score, 64) })
  }
  return { status: 'ok', statusCode, words }
}

/** 播放趋势点（metrics_trend 直取 view_count 累计口径，最近 7 个完成日）。 */
export interface PlayTrendPoint {
  day: string
  playCount: number
}

export function parseItemMetricsTrend(json: unknown, todayIso: string): PlayTrendPoint[] | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const statusCode = toNumber(payload.status_code)
  if (statusCode !== null && statusCode !== 0) return null
  const trendMap = (payload.trend_map && typeof payload.trend_map === 'object' ? payload.trend_map : null) as Record<string, unknown> | null
  const viewGroup = (trendMap?.view_count && typeof trendMap.view_count === 'object' ? trendMap.view_count : null) as Record<string, unknown> | null
  const rows = Array.isArray(viewGroup?.['0']) ? viewGroup['0'] as unknown[] : null
  if (rows === null) return null
  const points: PlayTrendPoint[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const dayRaw = typeof record.date_time === 'string' ? record.date_time.slice(0, 10) : null
    if (dayRaw === null || !/^\d{4}-\d{2}-\d{2}$/u.test(dayRaw)) continue
    // 形状合规非法日期（2026-13-45）round-trip 双校验。
    const roundTrip = new Date(`${dayRaw}T00:00:00Z`).toISOString().slice(0, 10)
    if (roundTrip !== dayRaw) continue
    if (dayRaw >= todayIso) continue
    const value = typeof record.value === 'string' ? Number(record.value) : Number(record.value)
    if (!Number.isFinite(value) || value < 0) continue
    points.push({ day: dayRaw, playCount: Math.round(value) })
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return points.slice(-7).length > 0 ? points.slice(-7) : null
}

/** 大盘 13+2 指标列映射（english_metric_name → canonical 列）。 */
const DASHBOARD_RATIO_METRICS = new Set(['cover_click_ratio', 'completion_rate_5s', 'bounce_rate_2s'])
const DASHBOARD_COLUMNS: Record<string, string> = {
  play_cnt: 'play_count',
  digg_cnt: 'like_count',
  share_count: 'share_count',
  comment_cnt: 'comment_count',
  net_fans_cnt: 'net_fans_count',
  cancel_fans_cnt: 'cancel_fans_count',
  cover_click_ratio: 'cover_click_ratio_pct',
  homepage_view_cnt: 'homepage_view_count',
  publish_cnt: 'publish_count',
  completion_rate_5s: 'completion_rate_5s_pct',
  bounce_rate_2s: 'bounce_rate_2s_pct',
  avg_view_second: 'avg_view_second',
  total_fans_cnt: 'total_fans_count',
  new_fans_cnt: 'new_fans_count',
  home_view_fans_cnt: 'home_view_fans_count',
}

/** 大盘单值（负值/超界 → undefined 列缺省；net_fans 允许负）。 */
function dashboardMetricValue(metric: string, raw: unknown): number | undefined {
  if (metric === 'avg_view_second') {
    const value = round2(raw)
    return value === null ? undefined : value
  }
  const value = toInt(raw)
  if (value === null || Math.abs(value) > Number.MAX_SAFE_INTEGER) return undefined
  if (value < 0 && metric !== 'net_fans_cnt') return undefined
  return value
}

function dashboardDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
  if (match === null) return null
  const iso = `${match[1]}-${match[2]}-${match[3]}`
  const roundTrip = new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10)
  return roundTrip === iso ? iso : null
}

/**
 * 大盘解析（dashboard 与 dashboard/fans 共用同构实现）：metrics[].english_metric_name
 * → trends[] 展开为按日行；同日同指标重复保留先出现值；按 day 升序。
 */
export function parseDashboardMetrics(json: unknown): Record<string, unknown>[] {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const metrics = Array.isArray(payload.metrics) ? payload.metrics as unknown[] : []
  const byDay = new Map<string, Record<string, unknown>>()
  for (const metricRow of metrics) {
    if (!metricRow || typeof metricRow !== 'object') continue
    const record = metricRow as Record<string, unknown>
    const english = typeof record.english_metric_name === 'string' ? record.english_metric_name : null
    const column = english !== null ? DASHBOARD_COLUMNS[english] : undefined
    if (column === undefined) continue
    const trends = Array.isArray(record.trends) ? record.trends as unknown[] : []
    for (const trend of trends) {
      if (!trend || typeof trend !== 'object') continue
      const trendRecord = trend as Record<string, unknown>
      const day = dashboardDay(trendRecord.date ?? trendRecord.day)
      if (day === null) continue
      const isRatio = english !== null && DASHBOARD_RATIO_METRICS.has(english)
      const value = isRatio ? pct(trendRecord.value) : dashboardMetricValue(english ?? '', trendRecord.value)
      if (value === undefined || value === null) continue
      const row = byDay.get(day) ?? { day }
      if (!(column in row)) row[column] = value
      byDay.set(day, row)
    }
  }
  return [...byDay.values()].sort((a, b) => (String(a.day) < String(b.day) ? -1 : String(a.day) > String(b.day) ? 1 : 0))
}

/** 粉丝画像六类分布（每类 ≤64 行；隐私榜单物理不触碰）。 */
export interface FansSummary {
  activeLevels: { label: string; count: number }[] | null
  activeTimeRange: { label: string; count: number }[] | null
  ageDistribution: { label: string; count: number }[] | null
  cityDistribution: { label: string; count: number }[] | null
  deviceDistribution: { label: string; count: number }[] | null
  interestDistribution: { label: string; count: number }[] | null
}

function parseSummaryRows(raw: unknown, key: string): { label: string; count: number }[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rows = (raw as Record<string, unknown>)[key]
  if (!Array.isArray(rows)) return null
  const parsed: { label: string; count: number }[] = []
  for (const item of rows) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const label = clampText(record.name ?? record.label, 128)
    const count = toInt(record.value ?? record.count)
    if (label === null || count === null || count < 0) continue
    parsed.push({ label, count })
    if (parsed.length >= 64) break
  }
  return parsed.length > 0 ? parsed : null
}

export function parseFansSummary(json: unknown): FansSummary | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>
  const summary: FansSummary = {
    activeLevels: parseSummaryRows(data.active_level_distribution ?? data.active_levels, 'list'),
    activeTimeRange: parseSummaryRows(data.active_time_distribution ?? data.active_time_range, 'list'),
    ageDistribution: parseSummaryRows(data.age_distribution, 'list'),
    cityDistribution: parseSummaryRows(data.city_distribution, 'list'),
    deviceDistribution: parseSummaryRows(data.device_brand_distribution ?? data.device_distribution, 'list'),
    interestDistribution: parseSummaryRows(data.fans_interest_distribution ?? data.interest_distribution, 'list'),
  }
  const hasAny = Object.values(summary).some(value => value !== null)
  return hasAny ? summary : null
}

/** buildWorkPayload 的组合输入（collector 各端点的解析产物）。 */
export interface WorkPayloadInput {
  work: WorkItem
  performance: Map<string, Record<string, number | null>>
  compare: CompareMetrics | null
  compareGap: string | null
  source: PlaySourceRow[] | null
  portrait: AudiencePortrait | null
  search: SearchKeywordRow[] | null
  progress: ProgressAnalysis | null
  retention: RealtimeTrend | null
  retentionGap: string | null
  bounce: RealtimeTrend | null
  bounceGap: string | null
  mget: Map<string, Record<string, number | null>>
  summarize: Map<string, SummarizeRow>
  hotword: HotwordResult | null
  metricsTrend: PlayTrendPoint[] | null
  metricsTrendGap: string | null
  observedAt: string
}

/** 服务端作品载荷（ingest_batch works[] 条目的白名单投影 + dataGap）。 */
export interface WorkPayload extends Record<string, unknown> {
  work_id: string
  title: string | null
  url: string | null
  publish_time: string | null
  is_private: boolean
  latest_collected_at: string
  play_count: number | null
  like_count: number | null
  comment_count: number | null
  collect_count: number | null
  share_count: number | null
  danmaku_count: number | null
  fans_gain_count: number | null
  duration_s: number | null
  completion_rate_pct: number | null
  completion_rate_5s_pct: number | null
  bounce_rate_2s_pct: number | null
  avg_watch_duration_s: number | null
  avg_view_proportion_pct: number | null
  cover_click_rate_pct: number | null
  follower_play_ratio_pct: number | null
  like_rate_pct: number | null
  comment_rate_pct: number | null
  share_rate_pct: number | null
  favorite_rate_pct: number | null
  play_source: PlaySourceRow[] | null
  audience: Record<string, unknown> | null
  search_keywords: SearchKeywordRow[] | null
  progress_analysis: Record<string, unknown> | null
  retention_trend: Record<string, unknown> | null
  retention_bounce: Record<string, unknown> | null
  hotword: Record<string, unknown>
  play_trend_daily: PlayTrendPoint[] | null
  cover_url: string | null
  data_gap: Record<string, { reason: string; at: string }> | null
}

const GAP_REASONS = new Set(['not_exposed', 'below_min_view', 'request_failed', 'no_data', 'past_item_below_min_count'])

/**
 * buildWorkPayload 三路合并：compare → mget → performance（或 summarize/work
 * 列表值），缺口一律 null + dataGap[field]={reason, at}；低播放缺口 reason 用
 * compare 的 gapReason（below_min_view / past_item_below_min_count），不得把
 * request_failed/not_exposed 混成低播放。
 */
export function buildWorkPayload(input: WorkPayloadInput): WorkPayload {
  const { work } = input
  const gaps: Record<string, { reason: string; at: string }> = {}
  const mark = (field: string, reason: string): void => {
    if (!GAP_REASONS.has(reason)) reason = 'not_exposed'
    gaps[field] = { reason, at: input.observedAt }
  }
  const firstNonNull = <T,>(...values: T[]): T | null => {
    for (const value of values) {
      if (value !== null && value !== undefined) return value
    }
    return null
  }
  const mget = input.mget.get(work.workId)
  const performance = input.performance.get(work.workId)
  const summarize = input.summarize.get(work.workId)
  const compareMetrics = input.compare?.metrics ?? null
  const lowPlayReason = input.compare !== null
    ? input.compare.gapReason ?? 'not_exposed'
    : 'not_exposed'
  const from = (value: number | null | undefined, field: string, reason = 'not_exposed'): number | null => {
    if (value !== null && value !== undefined) return value
    mark(field, reason)
    return null
  }
  const payload: WorkPayload = {
    work_id: work.workId,
    title: work.title,
    url: work.url,
    publish_time: work.publishTime,
    is_private: work.isPrivate,
    latest_collected_at: input.observedAt,
    play_count: from(firstNonNull(compareMetrics?.playCount, mget?.playCount, performance?.playCount, work.playCount), 'play_count', lowPlayReason),
    like_count: from(work.likeCount, 'like_count'),
    comment_count: from(work.commentCount, 'comment_count'),
    collect_count: from(work.collectCount, 'collect_count'),
    share_count: from(work.shareCount, 'share_count'),
    danmaku_count: from(firstNonNull(mget?.danmakuCount, work.danmakuCount), 'danmaku_count'),
    fans_gain_count: from(summarize?.fansGainCount ?? null, 'fans_gain_count'),
    duration_s: from(work.durationSeconds, 'duration_s'),
    completion_rate_pct: from(firstNonNull(compareMetrics?.completionRate, summarize?.completionRate, mget?.completionRate), 'completion_rate_pct', lowPlayReason),
    completion_rate_5s_pct: from(firstNonNull(compareMetrics?.completionRate5s, mget?.completionRate5s, performance?.completion_rate_5s_pct), 'completion_rate_5s_pct', lowPlayReason),
    bounce_rate_2s_pct: from(firstNonNull(compareMetrics?.bounceRate2s, mget?.bounceRate2s, performance?.bounce_rate_2s_pct), 'bounce_rate_2s_pct', lowPlayReason),
    avg_watch_duration_s: from(firstNonNull(compareMetrics?.avgWatchDuration, mget?.avgWatchDuration, performance?.avg_watch_duration_s), 'avg_watch_duration_s', lowPlayReason),
    avg_view_proportion_pct: from(firstNonNull(compareMetrics?.avgViewProportion, mget?.avgViewProportion), 'avg_view_proportion_pct', lowPlayReason),
    cover_click_rate_pct: from(firstNonNull(compareMetrics?.coverClickRate, mget?.coverClickRate), 'cover_click_rate_pct', lowPlayReason),
    follower_play_ratio_pct: from(firstNonNull(compareMetrics?.followerPlayRatio, mget?.followerPlayRatio), 'follower_play_ratio_pct', lowPlayReason),
    like_rate_pct: from(compareMetrics?.likeRate ?? null, 'like_rate_pct'),
    comment_rate_pct: from(compareMetrics?.commentRate ?? null, 'comment_rate_pct'),
    share_rate_pct: from(compareMetrics?.shareRate ?? null, 'share_rate_pct'),
    favorite_rate_pct: from(compareMetrics?.favoriteRate ?? null, 'favorite_rate_pct'),
    play_source: input.source,
    audience: input.portrait === null
      ? (mark('audience', 'not_exposed'), null)
      : { gender: input.portrait.gender, age: input.portrait.age, province: input.portrait.province, city_level: input.portrait.cityLevel },
    search_keywords: input.search,
    progress_analysis: input.progress === null
      ? (mark('progress_analysis', 'not_exposed'), null)
      : input.progress.empty
        ? (mark('progress_analysis', 'no_data'), null)
        : { jump_backward: input.progress.jumpBackward, jump_forward: input.progress.jumpForward, video_data: input.progress.videoData },
    retention_trend: buildTrendBlock(input.retention, input.retentionGap, 'retention_trend', mark),
    retention_bounce: buildTrendBlock(input.bounce, input.bounceGap, 'retention_bounce', mark),
    hotword: input.hotword === null
      ? { source: 'tab', status: 'unavailable', words: [] }
      : input.hotword.status === 'ok'
        ? { source: 'tab', status: 'ok', words: input.hotword.words }
        : { source: 'tab', status: 'unavailable', words: [] },
    play_trend_daily: input.metricsTrend === null
      ? (mark('play_trend_daily', input.metricsTrendGap ?? 'not_exposed'), null)
      : input.metricsTrend,
    cover_url: work.cover,
    data_gap: null,
  }
  payload.data_gap = Object.keys(gaps).length > 0 ? gaps : null
  return payload
}

/** 留存/跳出块：取到非空曲线才有值；取到但空 → no_data；没取到 → 缺口。 */
function buildTrendBlock(
  trend: RealtimeTrend | null,
  gap: string | null,
  field: string,
  mark: (field: string, reason: string) => void,
): Record<string, unknown> | null {
  if (trend === null) {
    mark(field, gap ?? 'not_exposed')
    return null
  }
  if (trend.empty) {
    mark(field, 'no_data')
    return null
  }
  return { current: trend.current, similar: trend.similar, valleys: trend.valleys }
}

/** 大盘两源浅合并（主表指标优先，同日同列后合并方不覆盖），按 day 升序。 */
export function mergeDashboardRows(
  dashboardRows: Record<string, unknown>[],
  fansRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const byDay = new Map<string, Record<string, unknown>>()
  const mergeRow = (row: Record<string, unknown>): void => {
    const day = String(row.day ?? '')
    if (day === '') return
    const existing = byDay.get(day) ?? { day }
    for (const [key, value] of Object.entries(row)) {
      if (key === 'day') continue
      if (value === undefined || value === null || value === '') continue
      if (!(key in existing)) existing[key] = value
    }
    byDay.set(day, existing)
  }
  for (const row of dashboardRows) mergeRow(row)
  for (const row of fansRows) mergeRow(row)
  return [...byDay.values()].sort((a, b) => (String(a.day) < String(b.day) ? -1 : String(a.day) > String(b.day) ? 1 : 0))
}

/** 客户端结算状态（服务端按账本重算，仅参考）。 */
export function resolveClientStatus(options: {
  listComplete: boolean
  expected: number
  succeeded: number
  failed: number
}): 'completed' | 'partial' | 'failed' {
  if (!options.listComplete) return 'partial'
  if (options.succeeded === options.expected) return 'completed'
  if (options.expected > 0 && options.succeeded === 0) return 'failed'
  return 'partial'
}
