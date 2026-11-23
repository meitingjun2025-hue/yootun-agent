/**
 * 采集解析层（与旧 dsh-yootun-douyin-operation/parse.js 逐字段对齐）：19 位
 * aweme_id 先取文本→对 ≥16 位数字加引号再 JSON.parse（float64 舍入防线）；
 * HTTP 200 + `status_code: 8` 是业务层会话失效，列表/大盘/粉丝画像/趋势解析器
 * 必须抛 SessionInvalidError（防按空列表假成功），单稿详情端点解析为空/缺口由
 * collector 对 item_compare 的判定统一抛出；数值换算无 -0；百分比 0..1 →
 * 0..100 定义域守卫（越界记缺口不造值）；四种缺口语义 not_exposed /
 * below_min_view / request_failed / no_data 不可互换。
 * @module
 */

/** 会话失效业务码（HTTP 200 + status_code 8）。 */
export const SESSION_EXPIRED_STATUS_CODE = 8

/** 抖音单稿对比的最低观看门槛（`view count less than min view count`）。 */
export const LOW_PLAY_STATUS_CODE = 10001

/** 抖音单稿对比的历史作品数门槛（`past item count less than min count`）。 */
export const PAST_ITEM_COUNT_STATUS_CODE = 10005

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

  constructor(statusCode: number = SESSION_EXPIRED_STATUS_CODE, reason = 'session_invalid') {
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
  /** 范围外跳过数（列表阶段失效时未知，缺省由收尾按 null 上报）。 */
  skippedBeforePublishSince?: number
}

/** HTTP 200 响应体是否为业务层会话失效（status_code 经 toInt 后判 8）。 */
export function isSessionExpiredPayload(json: unknown): boolean {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return false
  return toInt((json as { status_code?: unknown }).status_code) === SESSION_EXPIRED_STATUS_CODE
}

/**
 * 严格数值转换：缺失（null/undefined/''/布尔）返回 null，不伪造成 0。
 *
 * dataGap 语义的基础：接口没给的字段必须落成 null（缺口），而不是 0（会被
 * UI 当成真实数据展示）。`-0` 收敛为 0：宿主 snapshotJsonValue 的无损 JSON
 * 校验拒绝 -0，而 `Number('-0')`、`Math.trunc(-0.2)` 都会产生 -0。
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return num === 0 ? 0 : num
}

/**
 * 0..1 比例 → 百分比（2 位小数）。经 toNumber 判缺；越出 0..1 定义域返回 null。
 *
 * 服务端所有 `*_pct` 字段都有 ge=0, le=100 硬约束，异常比率若透传会让整批
 * 入库被拒；越界视为本次未暴露（缺口），其余字段的入库不受影响。
 */
export function pct(value: unknown): number | null {
  const num = toNumber(value)
  if (num === null || num < 0 || num > 1) return null
  return Math.round(num * 100 * 100) / 100
}

/**
 * 数值取 2 位小数；经 toNumber 判缺；负数返回 null。
 *
 * 仅用于时长类字段（duration_s / avg_watch_duration_s），语义上非负；负值是
 * 抖音侧数据异常，落 null 记缺口，避免服务端 ge=0 拒批。
 */
export function round2(value: unknown): number | null {
  const num = toNumber(value)
  if (num === null || num < 0) return null
  return Math.round(num * 100) / 100
}

/** 截断整数；经 toNumber 判缺；`-0` 收敛为 0（Math.trunc(-0.2) === -0）。 */
export function toInt(value: unknown): number | null {
  const num = toNumber(value)
  if (num === null) return null
  const truncated = Math.trunc(num)
  return truncated === 0 ? 0 : truncated
}

/**
 * 按 schema 边界收敛文本：超长字段截断（而不是让整批入库被校验拒绝）；
 * null/undefined 与空串返回 null；不 trim（原始值原样入库）。
 */
export function clampText(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (text === '') return null
  return text.length > max ? text.slice(0, max) : text
}

/** 从 `{url_list: [...]}` 或字符串取第一个 URL。 */
export function firstUrl(node: unknown): string | null {
  if (!node) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim() : null
  if (Array.isArray(node)) return firstUrl(node[0])
  if (typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  return firstUrl(record.url_list || record.urlList || record.url)
}

/** 第一个非 null/undefined/'' 的值（缺失链语义与旧 parse.js 一致）。 */
export function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

/** 对象守卫（非对象返回 null，调用方走兜底链）。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/**
 * Quote integer literals with ≥16 digits **outside JSON strings** so
 * JSON.parse keeps them as strings（19 位 aweme_id 裸数字会被 float64 舍入）。
 * String-aware：字符串值内部（含转义嵌套 JSON）的长数字原样保留——对正文
 * 里的长数字加引号会写出嵌套引号，直接破坏 JSON。
 * @param text - raw response text.
 * @returns quoted text safe for JSON.parse.
 */
export function quoteLongNumbers(text: string): string {
  let out = ''
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index] ?? ''
    if (inString) {
      if (char === '\\') {
        out += char + (text[index + 1] ?? '')
        index += 2
        continue
      }
      if (char === '"') inString = false
      out += char
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char >= '0' && char <= '9') {
      const prev = index > 0 ? text[index - 1] ?? '' : ''
      if (/[0-9A-Za-z_.\-+]/u.test(prev)) {
        out += char
        index += 1
        continue
      }
      let end = index
      while (end < text.length && (text[end] ?? '') >= '0' && (text[end] ?? '') <= '9') end += 1
      const digits = text.slice(index, end)
      const next = end < text.length ? text[end] ?? '' : ''
      const terminates = next === '' || /[,}\]\s]/u.test(next)
      out += digits.length >= 16 && terminates ? `"${digits}"` : digits
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

/** 作品列表项（设备端采集层的白名单形状；入库前经 buildWorkPayload 投影）。 */
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

/**
 * 作品列表元素 → canonical 作品字段。
 *
 * 映射：`aweme_id→workId`、`desc→title`、`create_time→publishTime`、
 * `statistics.*→counts`、`video.duration(ms)→durationSeconds`、
 * `video.cover.url_list[0]→cover`、`status.is_private→isPrivate`。
 * 页面 Web 模式响应键是大写 `Cover`/`Statistics`/`Status`（2026-10-15 实测），
 * 与小写键同 uri/同值，候选顺序小写在前。
 */
function normalizeWork(raw: unknown): WorkItem | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const stats = recordOf(record.statistics) || recordOf(record.Statistics) || {}
  const video = recordOf(record.video) || recordOf(record.Video) || {}
  const status = recordOf(record.status) || recordOf(record.Status) || {}
  const workId = firstPresent(record.aweme_id, record.awemeId, record.item_id, record.id)
  if (!workId) return null
  const createTime = toInt(firstPresent(record.create_time, record.createTime))
  const durationMs = toInt(firstPresent(video.duration, record.duration))
  return {
    workId: String(workId),
    title: clampText(firstPresent(record.desc, record.Description, record.title), 1024),
    url: clampText(`https://www.douyin.com/video/${String(workId)}`, 2048),
    publishTime: createTime === null ? null : new Date(createTime * 1000).toISOString(),
    playCount: toInt(firstPresent(stats.play_count, stats.playCount)),
    likeCount: toInt(firstPresent(stats.digg_count, stats.diggCount)),
    commentCount: toInt(firstPresent(stats.comment_count, stats.commentCount)),
    collectCount: toInt(firstPresent(stats.collect_count, stats.collectCount)),
    shareCount: toInt(firstPresent(stats.share_count, stats.shareCount)),
    danmakuCount: toInt(firstPresent(stats.danmaku_count, stats.danmakuCount)),
    durationSeconds: durationMs === null ? null : round2(durationMs / 1000),
    cover: firstUrl(firstPresent(video.cover, record.Cover, record.cover)),
    isPrivate: status.is_private === true || status.isPrivate === true,
  }
}

/** unknown[] → 对象行数组守卫（非对象/数组项行级剔除）。 */
export function objectsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const rows: Record<string, unknown>[] = []
  for (const item of value) {
    const record = recordOf(item)
    if (record !== null) rows.push(record)
  }
  return rows
}

/** nullable 变体（字段缺失语义返回 null 而非 []）。 */
export function objectsOrNullOf(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) ? objectsOf(value) : null
}

/** 单页解析结果。 */
export interface WorkListPage {
  works: WorkItem[]
  hasMore: boolean
  nextCursor: string | null
  rawCount: number
}

/**
 * 列表单页解析：status_code=8 抛会话失效（绝不解析成空列表假成功）；
 * aweme_list 归一（无效行丢弃，rawCount 按原始列表长度）。
 * @param json - parsed response.
 * @returns the page projection.
 * @throws {SessionInvalidError} the deterministic session-expired marker.
 */
export function parseWorkListPage(json: unknown): WorkListPage {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  if (isSessionExpiredPayload(payload)) throw new SessionInvalidError(toInt(payload.status_code) ?? SESSION_EXPIRED_STATUS_CODE)
  const list = Array.isArray(payload.aweme_list) ? payload.aweme_list : []
  const works: WorkItem[] = []
  for (const raw of list) {
    const normalized = normalizeWork(raw)
    if (normalized !== null) works.push(normalized)
  }
  const nextCursor = firstPresent(payload.max_cursor, payload.cursor)
  return {
    works,
    hasMore: payload.has_more === true,
    nextCursor: nextCursor === null ? null : String(nextCursor),
    rawCount: list.length,
  }
}

/** 翻页终止判定结果：stop 时 listComplete/reason 说明完整性（旧 decidePagination 全语义）。 */
export interface PaginationDecision {
  stop: boolean
  listComplete: boolean
  reason: string
}

/**
 * 判断是否需要停止翻页，并给出是否"完整结束"。
 *
 * 终止/不完整规则：`has_more=false` 且当前页已处理 → 完整；`has_more=true` +
 * 空页 → 不完整；下一页游标为空或与当前相同 → 不完整；达到 maxPages → 不完整。
 */
export function decidePagination(page: WorkListPage, cursor: string | number, pageNumber: number, maxPages: number): PaginationDecision {
  if (!page.hasMore) return { stop: true, listComplete: true, reason: 'has_more_false' }
  if (page.rawCount === 0) return { stop: true, listComplete: false, reason: 'empty_page_with_more' }
  if (page.nextCursor === null || page.nextCursor === '' || String(page.nextCursor) === String(cursor)) {
    return { stop: true, listComplete: false, reason: 'cursor_not_advancing' }
  }
  if (pageNumber >= maxPages) return { stop: true, listComplete: false, reason: 'max_pages_reached' }
  return { stop: false, listComplete: false, reason: 'continue' }
}

/** 跨页按 workId 去重（保留首次出现顺序）。 */
export function dedupeWorks(works: WorkItem[]): WorkItem[] {
  const seen = new Set<string>()
  const out: WorkItem[] = []
  for (const work of works) {
    if (seen.has(work.workId)) continue
    seen.add(work.workId)
    out.push(work)
  }
  return out
}

/** 批量作品分析 item_performance 单行（早期留存指标 + 封面）。 */
export interface PerformanceRow {
  play_count: number | null
  avg_watch_duration_s: number | null
  completion_rate_5s_pct: number | null
  bounce_rate_2s_pct: number | null
  cover_url: string | null
}

/** 批量作品分析 `item_performance` → Map(workId → 早期留存指标)。 */
export function parseItemPerformance(json: unknown): Map<string, PerformanceRow> {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const items = Array.isArray(payload.items) ? payload.items : []
  const map = new Map<string, PerformanceRow>()
  for (const item of items) {
    const record = recordOf(item)
    if (record === null) continue
    const workId = firstPresent(record.item_id, record.itemId)
    if (!workId) continue
    map.set(String(workId), {
      play_count: toInt(record.play_count),
      avg_watch_duration_s: round2(record.average_play_duration),
      completion_rate_5s_pct: pct(record.completion_rate_5s),
      bounce_rate_2s_pct: pct(record.bounce_rate_2s),
      cover_url: firstUrl(record.cover),
    })
  }
  return map
}

/** 单稿分析 `item_compare` 解析结果（低播放三态 gapReason）。 */
export interface CompareMetrics {
  statusCode: number | null
  lowPlay: boolean
  hasMetrics: boolean
  /** 缺口原因：below_min_view / past_item_below_min_count / not_exposed / null（有指标）。 */
  gapReason: string | null
  statusMessage: string | null
  metrics: {
    play_count: number | null
    avg_watch_duration_s: number | null
    completion_rate_pct: number | null
    completion_rate_5s_pct: number | null
    bounce_rate_2s_pct: number | null
    avg_view_proportion_pct: number | null
    cover_click_rate_pct: number | null
    follower_play_ratio_pct: number | null
  }
  engagement_rates: {
    like_rate: number | null
    comment_rate: number | null
    share_rate: number | null
    favorite_rate: number | null
  }
}

/**
 * 单稿分析 `item_compare`：读 `item.metrics`（2026-10-15 实测契约）。
 *
 * 缺口区分抖音的三种拒绝/未暴露形态：10001 是当前观看门槛，10005 是历史作品数
 * 门槛（仍解析 item.metrics，有则用）；成功但无指标才是 not_exposed。请求未发出
 * 时采集层改标 request_failed。会话失效（status_code=8）由 collector 判定抛出，
 * 本函数按缺口语义解析。
 */
export function parseItemCompare(json: unknown): CompareMetrics {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const statusCode = toInt(payload.status_code)
  const metrics = payload.item !== null && typeof payload.item === 'object'
    ? (payload.item as Record<string, unknown>).metrics
    : null
  const metricsRecord = metrics !== null && typeof metrics === 'object' ? metrics as Record<string, unknown> : {}
  const hasMetrics = Object.keys(metricsRecord).length > 0
  const lowPlay = statusCode === LOW_PLAY_STATUS_CODE
  const gapReason = lowPlay
    ? 'below_min_view'
    : statusCode === PAST_ITEM_COUNT_STATUS_CODE
      ? 'past_item_below_min_count'
      : hasMetrics ? null : 'not_exposed'
  return {
    statusCode,
    lowPlay,
    hasMetrics,
    gapReason,
    statusMessage: typeof payload.status_msg === 'string' ? payload.status_msg : null,
    metrics: {
      play_count: toInt(metricsRecord.view_count),
      avg_watch_duration_s: round2(metricsRecord.avg_view_second),
      completion_rate_pct: pct(metricsRecord.completion_rate),
      completion_rate_5s_pct: pct(metricsRecord.completion_rate_5s),
      bounce_rate_2s_pct: pct(metricsRecord.bounce_rate_2s),
      avg_view_proportion_pct: pct(metricsRecord.avg_view_proportion),
      cover_click_rate_pct: pct(metricsRecord.cover_click_rate),
      follower_play_ratio_pct: pct(metricsRecord.fan_view_proportion),
    },
    engagement_rates: {
      like_rate: pct(metricsRecord.like_rate),
      comment_rate: pct(metricsRecord.comment_rate),
      share_rate: pct(metricsRecord.share_rate),
      favorite_rate: pct(metricsRecord.favorite_rate),
    },
  }
}

/** 流量来源 key → 中文标签（未知 key 原样透出为 null，不编造）。 */
export const SOURCE_LABELS: Record<string, string> = {
  homepage_hot: '推荐(首页推荐)',
  follow: '关注',
  homepage: '个人主页',
  search: '搜索',
  message: '私信/分享',
  familiar: '朋友/熟人',
  nearby: '同城',
  other: '其他',
}

/** 流量来源条目（契约行 {source_key, source_label, share_pct}，按占比降序）。 */
export interface PlaySourceRow {
  source_key: string | null
  source_label: string | null
  share_pct: number
}

/**
 * 流量来源 `play/source`：[{source_key, source_label, share_pct}]，按占比降序。
 *
 * 来源自带非空且不等于原始 key 的 label 时优先保留；已知 key 用 SOURCE_LABELS
 * 映射；未知 key 的 label 置 null。响应里没有 `play_source` 数组 → 返回 null
 * （本次未暴露），空数组会被当作"已采集但无数据"，把缺口伪造成真实值。
 */
export function parsePlaySource(json: unknown): PlaySourceRow[] | null {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  if (!Array.isArray(payload.play_source)) return null
  const rows: PlaySourceRow[] = []
  for (const item of payload.play_source) {
    const record = recordOf(item)
    if (record === null) continue
    const key = firstPresent(record.key, record.source_key)
    const share = pct(record.value)
    if (!key || share === null) continue
    const provided = typeof record.source_label === 'string' ? record.source_label.trim() : ''
    const label = provided !== '' && provided !== String(key)
      ? clampText(provided, 128)
      : SOURCE_LABELS[String(key)] ?? null
    rows.push({
      source_key: clampText(key, 64),
      source_label: label,
      share_pct: share,
    })
  }
  return rows.sort((a, b) => b.share_pct - a.share_pct)
}

/** 画像分布行（key 为抖音侧展示分桶原样透传，pct 为百分数）。 */
export interface PortraitRow {
  key: string | null
  pct: number
}

/** 观众画像四类分布（province 截前 8，其余全量）。 */
export interface AudiencePortrait {
  gender: PortraitRow[]
  age: PortraitRow[]
  province: PortraitRow[]
  city_level: PortraitRow[]
}

/** 观众画像 `fans/item/portrait`：四类 `ratio_list`，各按占比降序；地域取前 8。 */
export function parsePortrait(json: unknown): AudiencePortrait | null {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const hasAnyBlock = ['gender', 'age', 'province', 'city_level'].some(name => {
    const node = recordOf(payload[name])
    return node !== null && Array.isArray(node.ratio_list)
  })
  if (!hasAnyBlock) return null
  const block = (name: string): PortraitRow[] => {
    const node = recordOf(payload[name])
    const list = node !== null && Array.isArray(node.ratio_list) ? node.ratio_list : []
    const rows: PortraitRow[] = []
    for (const item of list) {
      const record = recordOf(item)
      if (record === null) continue
      const key = firstPresent(record.key, record.name)
      const share = pct(record.value)
      if (!key || share === null) continue
      rows.push({ key: clampText(key, 64), pct: share })
    }
    return rows.sort((a, b) => b.pct - a.pct)
  }
  const provinces = block('province')
  return {
    gender: block('gender'),
    age: block('age'),
    province: provinces.slice(0, 8),
    city_level: block('city_level'),
  }
}

/** 搜索词行（percent 本身是百分数，原样透出夹 0..100，降序）。 */
export interface SearchKeywordRow {
  keyword: string | null
  percent: number
}

/**
 * 搜索词 `item_analysis/search/keyword`：`show_from[]` → [{keyword, percent}]。
 *
 * `show_from` 存在但为空是有效数据（该作品确无搜索词）；字段缺失则返回 null
 * （缺口）。percent 缺失/非数值的行剔除。
 */
export function parseSearchKeywords(json: unknown): SearchKeywordRow[] | null {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  if (!Array.isArray(payload.show_from)) return null
  const rows: SearchKeywordRow[] = []
  for (const item of payload.show_from) {
    const record = recordOf(item)
    if (record === null) continue
    const keyword = firstPresent(record.keyword, record.word)
    const percent = toNumber(record.percent)
    if (!keyword) continue
    if (percent === null) continue
    // 抖音该字段本身以百分数返回，原样透出（不二次放大），并夹在契约允许范围内。
    rows.push({
      keyword: clampText(keyword, 128),
      percent: Math.min(100, Math.max(0, Math.round(percent * 100) / 100)),
    })
  }
  return rows.sort((a, b) => b.percent - a.percent)
}

/** 进度分析曲线点（契约行 {key, value}：key 为播放秒，value 0..100）。 */
export interface ProgressCurveRow {
  key: string | null
  value: number
}

/** 进度分析曲线（empty 标记入库前必须剥离）。 */
export interface ProgressAnalysis {
  dragBackward: ProgressCurveRow[]
  dragForward: ProgressCurveRow[]
  /** 端点可达且契约正确但确无数据（两曲线空且 video_data=null）；入库剥离。 */
  empty: boolean
}

/**
 * 进度分析 `progress/analysis/v2`：jump_backward/jump_forward → 拖回/拖前曲线。
 *
 * 端点可达但该作品确实没有任何进度数据时 `empty=true`（两条空曲线 +
 * video_data=null）——与"根本没取到"必须区分，调用方据此记 `no_data` 缺口。
 * `empty` 只在解析层内部传递，入库前必须剥离。
 */
export function parseProgressAnalysis(json: unknown): ProgressAnalysis | null {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  if (!Array.isArray(payload.jump_backward) && !Array.isArray(payload.jump_forward)) return null
  const curve = (points: unknown): ProgressCurveRow[] => {
    const list = Array.isArray(points) ? points : []
    const rows: ProgressCurveRow[] = []
    for (const item of list) {
      const record = recordOf(item)
      if (record === null) continue
      const key = firstPresent(record.key, record.second)
      const value = pct(record.value)
      if (key === null || value === null) continue
      rows.push({ key: clampText(key, 32), value })
    }
    return rows
  }
  const dragBack = curve(payload.jump_backward)
  const dragForward = curve(payload.jump_forward)
  const videoData = payload.video_data !== null && typeof payload.video_data === 'object' ? payload.video_data : null
  return {
    dragBackward: dragBack,
    dragForward: dragForward,
    empty: dragBack.length === 0 && dragForward.length === 0 && videoData === null,
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
    const record = recordOf(item)
    if (record === null) continue
    const key = clampText(record.key, 32)
    const num = Number(record.value)
    if (key === null || !Number.isFinite(num) || num < 0 || num > 1) continue
    const value = Math.min(100, Math.max(0, Math.round(num * 100 * 100) / 100))
    rows.push({ key, value })
    if (rows.length >= TREND_MAX_POINTS) break
  }
  return rows
}

/** 低谷区间：`valley_list` 可能是数组，也可能是 `{"1"|"2"|"3": [{start, end}]}`
 * 分组对象（实测原始契约）；start/end 为字符串秒，转非负整数、end<start 交换。 */
function parseValleys(raw: unknown): { start: number; end: number }[] {
  const groups: { start: number; end: number }[] = []
  const lists = Array.isArray(raw)
    ? [raw]
    : (raw !== null && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : [])
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const record = recordOf(item)
      if (record === null) continue
      const start = toInt(record.start)
      const end = toInt(record.end)
      if (start === null || end === null || start < 0 || end < 0) continue
      groups.push(start <= end ? { start, end } : { start: end, end: start })
      if (groups.length >= VALLEY_MAX_GROUPS) break
    }
    if (groups.length >= VALLEY_MAX_GROUPS) break
  }
  return groups
}

/**
 * 观看趋势 `realtime/analysis/data_center` 解析（analysis_type=1 留存 / 7 跳出）。
 *
 * `key` 为 "MM:SS" 字符串按原样透传；value 0..1 → ×100 存百分数，越界行级剔除；
 * 会话失效抛 SessionInvalidError；顶层无 analysis_trend 结构 → null。
 */
export function parseRealtimeTrend(json: unknown): RealtimeTrend | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const trend = payload.analysis_trend !== null && typeof payload.analysis_trend === 'object'
    ? payload.analysis_trend as Record<string, unknown>
    : null
  if (trend === null) return null
  // 实测原始契约为 current_item / similar_author；current / similar 为历史 fixture
  // 形态，两个集合都接受。
  const current = parseTrendCurve(firstPresent(trend.current_item, trend.current))
  const similar = parseTrendCurve(firstPresent(trend.similar_author, trend.similar))
  // valley_list 在实测响应中位于顶层，历史 fixture 放在 analysis_trend 内，两处都接受。
  const valleys = parseValleys(firstPresent(payload.valley_list, trend.valley_list))
  return { current, similar, valleys, empty: current.length === 0 && similar.length === 0 }
}

/** item mget 单行（item.metrics 投影；Map 按 id 取，拦截可能命中多作品批量请求）。 */
export interface MgetRow {
  danmaku_count: number | null
  play_count: number | null
  avg_watch_duration_s: number | null
  completion_rate_pct: number | null
  completion_rate_5s_pct: number | null
  bounce_rate_2s_pct: number | null
  avg_view_proportion_pct: number | null
  cover_click_rate_pct: number | null
  follower_play_ratio_pct: number | null
}

/**
 * 单稿指标 `item/mget`：读 `items[].metrics.*`，补齐列表 `statistics` 未暴露的
 * 计数类指标（danmaku_count）与 item_compare 缺失时的兜底指标。
 *
 * 返回 Map 而不是只取 items[0]：`ids` 是复数，拦截到的响应可能是多作品批量
 * 请求，盲取首元素会把别的作品的指标记到当前作品上。
 */
export function parseItemMget(json: unknown): Map<string, MgetRow> {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const list = Array.isArray(payload.items) ? payload.items : []
  const rows = new Map<string, MgetRow>()
  for (const item of list) {
    const record = recordOf(item)
    if (record === null) continue
    const id = firstPresent(record.id, record.item_id, record.aweme_id)
    if (id === null) continue
    const metrics = recordOf(record.metrics) ?? {}
    rows.set(String(id), {
      danmaku_count: toInt(firstPresent(metrics.danmaku_count, metrics.danmakuCount)),
      play_count: toInt(metrics.view_count),
      avg_watch_duration_s: round2(metrics.avg_view_second),
      completion_rate_pct: pct(metrics.completion_rate),
      completion_rate_5s_pct: pct(metrics.completion_rate_5s),
      bounce_rate_2s_pct: pct(metrics.bounce_rate_2s),
      avg_view_proportion_pct: pct(metrics.avg_view_proportion),
      cover_click_rate_pct: pct(metrics.cover_click_rate),
      follower_play_ratio_pct: pct(metrics.fan_view_proportion),
    })
  }
  return rows
}

/** item summarize 单行（完播率与吸粉量独立判缺）。 */
export interface SummarizeRow {
  completion_rate_pct: number | null
  fans_gain_count: number | null
}

/**
 * 作品总览 `item/summarize`：`summarize_data.play_finish_ratio`（0..1 比例）与
 * `new_fans_count`（吸粉量）独立判缺，任一存在即建行，缺失方记 null，绝不因
 * 一个字段缺失而丢掉另一个。
 */
export function parseItemSummarize(json: unknown): Map<string, SummarizeRow> {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const list = Array.isArray(payload.item_list) ? payload.item_list : []
  const rows = new Map<string, SummarizeRow>()
  for (const item of list) {
    const record = recordOf(item)
    if (record === null) continue
    const id = firstPresent(record.aweme_id, record.item_id, record.id)
    const summary = recordOf(record.summarize_data) ?? {}
    const completionRate = pct(summary.play_finish_ratio)
    const fansGainCount = toInt(summary.new_fans_count)
    if (id === null || (completionRate === null && fansGainCount === null)) continue
    rows.set(String(id), {
      completion_rate_pct: completionRate,
      fans_gain_count: fansGainCount === null || fansGainCount < 0 ? null : fansGainCount,
    })
  }
  return rows
}

/** 热词三态（status_code===0 才是 ok；unavailable 保留旧集合）。 */
export interface HotwordResult {
  status: 'ok' | 'unavailable'
  statusCode: number | null
  words: { word: string | null; rank: number | null; raw_score: string | null }[]
  error?: string | undefined
}

/**
 * 评论热词 `wordCloud`：区分"成功但为空"与"请求失败"。
 *
 * `status_code==0` → ok（words 可能为空 → 服务端清空当前集合）；空对象或非零
 * 状态码 → unavailable（服务端保留旧集合并记 data_gap）。
 */
export function parseWordCloud(json: unknown): HotwordResult {
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const statusCode = toInt(payload.status_code)
  if (Object.keys(payload).length === 0) {
    return { status: 'unavailable', statusCode, words: [] }
  }
  if (statusCode !== 0) return { status: 'unavailable', statusCode, words: [] }
  const list = Array.isArray(payload.word_cloud_list) ? payload.word_cloud_list : []
  const words: HotwordResult['words'] = []
  for (const item of list) {
    const record = recordOf(item)
    if (record === null) continue
    const word = firstPresent(record.word, record.text)
    if (!word) continue
    const rank = toInt(record.rank)
    words.push({
      word: clampText(word, 128),
      rank: rank === null ? null : Math.max(0, rank),
      raw_score: clampText(record.score, 64),
    })
  }
  return { status: 'ok', statusCode, words }
}

/** 播放趋势点（metrics_trend 直取 view_count 累计口径，最近 7 个完成日）。 */
export interface PlayTrendPoint {
  day: string
  playCount: number
}

/**
 * 单作品官方按日累计趋势：`trend_map.view_count['0']` 累计+按天响应解析。
 *
 * `value` 是 6 位小数字符串；`date_time` 取前 10 位为 day（round-trip 校验挡
 * 形状合规非法日期）；day ≥ todayIso 的点在解析层丢弃（数据未出）；非零业务码/
 * 结构异常/零点位 → null（调用方记缺口）。截取最近 7 个已完成日，兜住服务端
 * max_length=7。
 */
export function parseItemMetricsTrend(json: unknown, todayIso: string): PlayTrendPoint[] | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const statusCode = toNumber(payload.status_code)
  if (statusCode !== null && statusCode !== 0) return null
  const trendMap = recordOf(payload.trend_map)
  const viewGroup = trendMap === null ? null : recordOf(trendMap.view_count)
  const rows = viewGroup === null ? null : objectsOrNullOf(viewGroup['0'])
  if (rows === null) return null
  const points: PlayTrendPoint[] = []
  for (const record of rows) {
    const dayRaw = typeof record.date_time === 'string' ? record.date_time.slice(0, 10) : null
    if (dayRaw === null || !/^\d{4}-\d{2}-\d{2}$/u.test(dayRaw)) continue
    // 形状合规非法日期（2026-13-45）行级剔除：先 NaN 判定，Invalid Date 的
    // toISOString 会抛 RangeError；NaN 通过后再 round-trip 挡 2 月 30 日这类
    // roll-over，二者都必须跳过该点而不是让整条趋势记 request_failed。
    const timestamp = Date.parse(`${dayRaw}T00:00:00Z`)
    if (Number.isNaN(timestamp)) continue
    const roundTrip = new Date(timestamp).toISOString().slice(0, 10)
    if (roundTrip !== dayRaw) continue
    if (dayRaw >= todayIso) continue
    const value = Number(record.value)
    if (!Number.isFinite(value) || value < 0) continue
    points.push({ day: dayRaw, playCount: Math.round(value) })
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return points.slice(-7).length > 0 ? points.slice(-7) : null
}

/** 大盘比率指标集合（0..1 原值，入库 ×100）。 */
export const DASHBOARD_RATIO_METRICS = new Set(['cover_click_ratio', 'completion_rate_5s', 'bounce_rate_2s'])

/** 大盘指标列映射（english_metric_name → 服务端 DouyinAccountDailyItem snake 列；
 * share_count→share_cnt 是唯一不对称项）。 */
const DASHBOARD_COLUMN_BY_METRIC: Record<string, string> = {
  play_cnt: 'play_cnt',
  digg_cnt: 'digg_cnt',
  share_count: 'share_cnt',
  comment_cnt: 'comment_cnt',
  net_fans_cnt: 'net_fans_cnt',
  cancel_fans_cnt: 'cancel_fans_cnt',
  cover_click_ratio: 'cover_click_ratio_pct',
  homepage_view_cnt: 'homepage_view_cnt',
  publish_cnt: 'publish_cnt',
  completion_rate_5s: 'completion_rate_5s_pct',
  bounce_rate_2s: 'bounce_rate_2s_pct',
  avg_view_second: 'avg_view_second',
  total_fans_cnt: 'total_fans_cnt',
  new_fans_cnt: 'new_fans_cnt',
  home_view_fans_cnt: 'home_view_fans_cnt',
}

/**
 * `"20261008"` → `"2026-10-08"`；非法日期（含 2 月 30 日这类 roll-over）返回 null。
 *
 * round-trip 校验：`Date.parse('2026-02-30T00:00:00Z')` 是 roll-over 而非 NaN，
 * 必须回读比对。畸形日期若透传，服务端 pydantic 在整个 payload 校验层失败，
 * ≤30 天回填整批全丢。
 */
export function dashboardDay(value: unknown): string | null {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(text)
  if (match === null) return null
  const [, year, month, day] = match
  const timestamp = Date.parse(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(timestamp)) return null
  const roundTrip = new Date(timestamp)
  const dayNumber = Number(day)
  if (
    roundTrip.getUTCFullYear() !== Number(year)
    || roundTrip.getUTCMonth() + 1 !== Number(month)
    || roundTrip.getUTCDate() !== dayNumber
  ) return null
  return `${year}-${month}-${day}`
}

/**
 * 非比率指标值守卫：计数列 ge=0（net_fans_cnt 可负）、avg_view_second 非负秒；
 * 超出 float64 可信精度（2**53）一律列缺省。畸形值返回 undefined（列缺省），
 * 绝不透传——否则服务端整 payload 校验失败，回填整批丢失。
 */
export function dashboardMetricValue(english: string, value: unknown): number | undefined {
  const num = toNumber(value)
  if (num === null) return undefined
  if (english === 'avg_view_second') {
    const seconds = round2(num)
    return seconds === null ? undefined : seconds
  }
  const integer = toInt(num)
  if (integer === null) return undefined
  if (integer > Number.MAX_SAFE_INTEGER || integer < -Number.MAX_SAFE_INTEGER) return undefined
  if (english === 'net_fans_cnt') return integer
  return integer < 0 ? undefined : integer
}

/**
 * 大盘解析（dashboard 与 dashboard/fans 同构响应共用）：`metrics[].trends[]` →
 * 按日合并行（snake 列名直投服务端 DouyinAccountDailyItem）。缺失 metric 整组
 * 缺省；比率 0..1 → ×100（2 位小数）；同日同列先出现者保留；按 day 升序；
 * 会话失效抛 SessionInvalidError。
 */
export function parseDashboardMetrics(json: unknown): Record<string, unknown>[] {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const metrics = Array.isArray(payload.metrics) ? payload.metrics : []
  const byDay = new Map<string, Record<string, unknown>>()
  for (const metric of metrics) {
    const metricRecord = recordOf(metric)
    if (metricRecord === null) continue
    const english = typeof metricRecord.english_metric_name === 'string' ? metricRecord.english_metric_name : null
    const column = english !== null ? DASHBOARD_COLUMN_BY_METRIC[english] : undefined
    if (english === null || column === undefined) continue
    const ratio = DASHBOARD_RATIO_METRICS.has(english)
    const trends = Array.isArray(metricRecord.trends) ? metricRecord.trends : []
    for (const point of trends) {
      const pointRecord = recordOf(point)
      if (pointRecord === null) continue
      const day = dashboardDay(pointRecord.date_time)
      if (day === null) continue
      const value = ratio ? pct(pointRecord.value) : dashboardMetricValue(english, pointRecord.value)
      if (value === null || value === undefined) continue
      const row = byDay.get(day) ?? { day }
      if (row[column] === undefined) row[column] = value
      byDay.set(day, row)
    }
  }
  return [...byDay.values()].sort((a, b) => (String(a.day) < String(b.day) ? -1 : String(a.day) > String(b.day) ? 1 : 0))
}

/** 粉丝画像单类分布行。 */
export interface FansSummaryRow {
  label: string | null
  count: number
}

/** 账号粉丝画像六类分布（snake 键，直投服务端 DouyinFansProfilePayload strict 子块）。 */
export interface FansSummary {
  active_levels: FansSummaryRow[] | null
  active_time_range: FansSummaryRow[] | null
  age_distribution: FansSummaryRow[] | null
  city_distribution: FansSummaryRow[] | null
  device_distribution: FansSummaryRow[] | null
  interest_distribution: FansSummaryRow[] | null
}

/**
 * 账号粉丝画像 `bff/data/fans/summary/v2`：顶层 `active_levels` /
 * `active_time_range` / `age_distribution` / `city_distribution` /
 * `device_brand_distribution` / `fans_interest_distribution` 六类（每类 ≤64 行，
 * count<0 行剔除；四邻键按服务端键名投影 device/interest）。
 *
 * 隐私边界：`contribution_billboard_7` / `interaction_billboard_7/30` 是用户榜单
 * （第三方用户昵称/sec_uid/头像/互动分）——不读取、不透传、不入库，本函数物理上
 * 不触碰这些键。会话失效抛 SessionInvalidError；六类全缺 → null。
 */
export function parseFansSummary(json: unknown): FansSummary | null {
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(SESSION_EXPIRED_STATUS_CODE)
  const payload = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {}
  const distribution = (key: string): FansSummaryRow[] | null => {
    const list = Array.isArray(payload[key]) ? payload[key] : []
    const rows: FansSummaryRow[] = []
    for (const item of list) {
      const record = recordOf(item)
      if (record === null) continue
      const label = firstPresent(record.label, record.name)
      const count = toInt(record.count)
      if (label === null || label === '' || count === null || count < 0) continue
      rows.push({ label: clampText(label, 128), count })
    }
    // 服务端 schema 每类分布 max_length=64：异常超限截断而不是让整批 daily 校验拒绝。
    return rows.length > 0 ? rows.slice(0, 64) : null
  }
  const result: FansSummary = {
    active_levels: distribution('active_levels'),
    active_time_range: distribution('active_time_range'),
    age_distribution: distribution('age_distribution'),
    city_distribution: distribution('city_distribution'),
    device_distribution: distribution('device_brand_distribution'),
    interest_distribution: distribution('fans_interest_distribution'),
  }
  const hasAny = Object.values(result).some(value => value !== null)
  return hasAny ? result : null
}

/** buildWorkPayload 的组合输入（collector 各端点的解析产物）。 */
export interface WorkPayloadInput {
  work: WorkItem
  /** 本作品在批量分析中的一行（无则 null）。 */
  performance: PerformanceRow | null
  compare: CompareMetrics | null
  source: PlaySourceRow[] | null
  portrait: AudiencePortrait | null
  search: SearchKeywordRow[] | null
  progress: ProgressAnalysis | null
  retention: RealtimeTrend | null
  retentionGap: string | null
  bounce: RealtimeTrend | null
  bounceGap: string | null
  mget: Map<string, MgetRow> | null
  summarize: Map<string, SummarizeRow> | null
  hotword: HotwordResult | null
  metricsTrend: PlayTrendPoint[] | null
  metricsTrendGap: string | null
  observedAt: string
}

/** 服务端作品载荷（ingest_batch works[] 条目的冻结契约投影 + data_gap）。 */
export interface WorkPayload extends Record<string, unknown> {
  work_id: string
  title: string | null
  url: string | null
  publish_time: string | null
  is_private: boolean
  play_count: number | null
  like_count: number | null
  comment_count: number | null
  collect_count: number | null
  share_count: number | null
  danmaku_count: number | null
  fans_gain_count: number | null
  completion_rate_pct: number | null
  completion_rate_5s_pct: number | null
  bounce_rate_2s_pct: number | null
  avg_watch_duration_s: number | null
  avg_view_proportion_pct: number | null
  cover_click_rate_pct: number | null
  follower_play_ratio_pct: number | null
  engagement_rates: { like_rate: number | null; comment_rate: number | null; share_rate: number | null; favorite_rate: number | null } | null
  traffic_source: PlaySourceRow[] | null
  audience: Record<string, unknown> | null
  search_keywords: SearchKeywordRow[] | null
  progress_analysis: { drag_back_curve: ProgressCurveRow[]; drag_forward_curve: ProgressCurveRow[] } | null
  retention_trend: Record<string, unknown> | null
  retention_bounce: Record<string, unknown> | null
  hotword: Record<string, unknown>
  play_trend_daily: { day: string; play_count: number }[] | null
  cover_url: string | null
  data_gap: Record<string, { reason: string; at: string }> | null
}

/**
 * 把列表/批量/单稿三路数据合并为入库载荷（canonical 键 + data_gap）。
 *
 * 合并顺序 compare → mget → performance/summarize → 列表值；本次未取到的字段
 * 一律 null 并记 `data_gap[field] = { reason, at }`，reason 取 not_exposed
 * （接口未返回）或具体原因（below_min_view / past_item_below_min_count /
 * request_failed / no_data）。
 */
export function buildWorkPayload(input: WorkPayloadInput): WorkPayload {
  const { work } = input
  const gaps: Record<string, { reason: string; at: string }> = {}
  const mark = (field: string, reason: string): void => {
    gaps[field] = { reason, at: input.observedAt }
  }
  const from = <T,>(value: T | null | undefined, field: string, reason = 'not_exposed'): T | null => {
    if (value === null || value === undefined) {
      mark(field, reason)
      return null
    }
    return value
  }
  const firstNonNull = <T,>(...values: Array<T | null | undefined>): T | null => {
    for (const value of values) {
      if (value !== null && value !== undefined) return value
    }
    return null
  }

  const perf: Partial<PerformanceRow> = input.performance ?? {}
  const cmp = input.compare !== null ? input.compare.metrics : null
  const engagement = input.compare !== null ? input.compare.engagement_rates : null
  // 单稿缺口原因由采集层严格标注：10001 是抖音最低播放门槛；10005 是历史作品数
  // 门槛；请求成功但无指标是 not_exposed；拦截与兜底都未取到是 request_failed。
  const lowPlayReason = input.compare !== null
    ? (input.compare.gapReason || (input.compare.lowPlay ? 'below_min_view' : 'not_exposed'))
    : 'not_exposed'
  // 进度分析：只有取到非空曲线才算有值。取到但为空 → no_data；完全没取到 →
  // not_exposed。empty 是解析器的内部分隔标记，剥离后入库。
  const progressValue = input.progress !== null && !input.progress.empty
    ? { drag_back_curve: input.progress.dragBackward, drag_forward_curve: input.progress.dragForward }
    : null
  // 观看趋势：与 progress_analysis 同构的三值语义——取到且两条曲线任一非空才算
  // 有值；取到但全空 → no_data；没取到 → not_exposed；请求失败 → request_failed
  // （retentionGap/bounceGap 由 collector 标注）。入库结构只保留 current/similar/
  // valleys 三键（canonical 契约）。
  const retentionValue = input.retention !== null && !input.retention.empty && (input.retention.current.length > 0 || input.retention.similar.length > 0)
    ? { current: input.retention.current, similar: input.retention.similar, valleys: input.retention.valleys }
    : null
  const retentionGapReason = input.retentionGap || (input.retention !== null ? 'no_data' : 'not_exposed')
  if (retentionValue === null) mark('retention_trend', retentionGapReason)
  const bounceValue = input.bounce !== null && !input.bounce.empty && (input.bounce.current.length > 0 || input.bounce.similar.length > 0)
    ? { current: input.bounce.current, similar: input.bounce.similar, valleys: input.bounce.valleys }
    : null
  const bounceGapReason = input.bounceGap || (input.bounce !== null ? 'no_data' : 'not_exposed')
  if (bounceValue === null) mark('retention_bounce', bounceGapReason)
  // 单稿指标按 workId 取值：拦截到的批量响应里可能没有本条作品。
  const mgetRow = input.mget !== null ? input.mget.get(work.workId) ?? null : null
  const summaryRow = input.summarize !== null ? input.summarize.get(work.workId) ?? null : null
  // 官方按日累计回填点位（≤7 个已完成日）。取不到记缺口（可观测），不影响其余
  // 字段；服务端只回填尚无快照行的历史日，绝不覆盖既有行。
  const playTrendDaily = Array.isArray(input.metricsTrend) && input.metricsTrend.length > 0
    ? input.metricsTrend.map(point => ({ day: point.day, play_count: point.playCount }))
    : null
  if (playTrendDaily === null) mark('play_trend_daily', input.metricsTrendGap || 'not_exposed')

  const payload: WorkPayload = {
    work_id: work.workId,
    title: from(work.title, 'title'),
    url: from(work.url, 'url'),
    publish_time: from(work.publishTime, 'publish_time'),
    cover_url: from(work.cover, 'cover_url'),
    fans_gain_count: from(summaryRow !== null ? summaryRow.fans_gain_count : null, 'fans_gain_count'),
    play_count: from(firstNonNull(cmp?.play_count, mgetRow?.play_count, perf.play_count, work.playCount), 'play_count'),
    like_count: from(work.likeCount, 'like_count'),
    comment_count: from(work.commentCount, 'comment_count'),
    collect_count: from(work.collectCount, 'collect_count'),
    share_count: from(work.shareCount, 'share_count'),
    danmaku_count: from(firstNonNull(mgetRow?.danmaku_count, work.danmakuCount), 'danmaku_count'),
    bounce_rate_2s_pct: from(firstNonNull(cmp?.bounce_rate_2s_pct, mgetRow?.bounce_rate_2s_pct, perf.bounce_rate_2s_pct), 'bounce_rate_2s_pct', lowPlayReason),
    completion_rate_5s_pct: from(firstNonNull(cmp?.completion_rate_5s_pct, mgetRow?.completion_rate_5s_pct, perf.completion_rate_5s_pct), 'completion_rate_5s_pct', lowPlayReason),
    completion_rate_pct: from(firstNonNull(cmp?.completion_rate_pct, summaryRow?.completion_rate_pct, mgetRow?.completion_rate_pct), 'completion_rate_pct', lowPlayReason),
    avg_watch_duration_s: from(firstNonNull(cmp?.avg_watch_duration_s, mgetRow?.avg_watch_duration_s, perf.avg_watch_duration_s), 'avg_watch_duration_s', lowPlayReason),
    avg_view_proportion_pct: from(firstNonNull(cmp?.avg_view_proportion_pct, mgetRow?.avg_view_proportion_pct), 'avg_view_proportion_pct', lowPlayReason),
    cover_click_rate_pct: from(firstNonNull(cmp?.cover_click_rate_pct, mgetRow?.cover_click_rate_pct), 'cover_click_rate_pct', lowPlayReason),
    follower_play_ratio_pct: from(firstNonNull(cmp?.follower_play_ratio_pct, mgetRow?.follower_play_ratio_pct), 'follower_play_ratio_pct', lowPlayReason),
    traffic_source: from(input.source, 'traffic_source'),
    search_keywords: from(input.search, 'search_keywords'),
    progress_analysis: from(progressValue, 'progress_analysis', input.progress !== null ? 'no_data' : 'not_exposed'),
    retention_trend: from(retentionValue, 'retention_trend', retentionGapReason),
    retention_bounce: from(bounceValue, 'retention_bounce', bounceGapReason),
    engagement_rates: from(engagement, 'engagement_rates'),
    audience: input.portrait !== null
      ? { gender: input.portrait.gender, age: input.portrait.age, province: input.portrait.province, city_level: input.portrait.city_level }
      : from(null, 'audience'),
    hotword: input.hotword !== null && input.hotword.status === 'ok'
      ? { source: 'tab', status: 'ok', words: input.hotword.words }
      : { source: 'tab', status: 'unavailable', words: [] },
    play_trend_daily: playTrendDaily,
    is_private: work.isPrivate === true,
    data_gap: null,
  }
  payload.data_gap = Object.keys(gaps).length > 0 ? gaps : null
  return payload
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
