/**
 * 创作者中心采集引擎（与旧 dsh-yootun-douyin-operation/collector.js 逐字段对齐）：
 * 所有接口都在页面上下文同源 fetch/响应拦截（页面自动生成 msToken/a_bogus，
 * 宿主绝不直连抖音）；publish_time 过滤发生在任何详情采集之前；publish_time
 * 缺失不入库且 listComplete=false；低播放 10001 记缺口不是错误；会话失效在各
 * 阶段挂部分成果（已采集作品入库保留）；大盘三连失败隔离只记 gap。
 * @module
 */
import type { Page } from 'playwright-core'
import {
  decidePagination, dedupeWorks, isSessionExpiredPayload, mergeDashboardRows,
  parseDashboardMetrics, parseFansSummary, parseItemCompare, parseItemMetricsTrend, parseItemMget,
  parseItemPerformance, parseItemSummarize, parsePlaySource, parsePortrait, parseProgressAnalysis,
  parseJsonPreservingIds, parseRealtimeTrend, parseSearchKeywords, parseWordCloud, parseWorkListPage,
  shanghaiTodayIso, LOW_PLAY_STATUS_CODE, SESSION_EXPIRED_STATUS_CODE, SessionInvalidError, toInt,
  buildWorkPayload,
  type AudiencePortrait, type CompareMetrics, type HotwordResult,
  type MgetRow, type PerformanceRow, type PlaySourceRow, type PlayTrendPoint,
  type ProgressAnalysis, type RealtimeTrend, type SearchKeywordRow, type SummarizeRow, type WorkItem,
  type WorkListPage, type WorkPayload,
} from './parse.ts'
import { normalizeAvatarUrl } from './avatar.ts'
import { CREATOR_ORIGIN, type DouyinProfile } from './session.ts'

export { resolveClientStatus, pct, round2, toInt, clampText, firstUrl } from './parse.ts'

/** 采集请求页面面（Playwright Page 的结构化子集；直接满足，无类型断言）。 */
export interface DouyinCollectPage {
  goto(url: string, options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  evaluate(script: (arg: CollectorFetchArg) => Promise<CollectorFetchOutcome>, arg: CollectorFetchArg): Promise<CollectorFetchOutcome>
  /** DOM 查询专用 evaluate（页面上下文同步函数；clickByText 叶子匹配用）。 */
  evaluateDom(script: (arg: string) => boolean, arg: string): Promise<boolean>
  on(event: 'response', listener: (response: CollectorResponse) => void): unknown
  off(event: 'response', listener: (response: CollectorResponse) => void): unknown
  click(selector: string, options?: { timeout?: number }): Promise<void>
  $(selector: string): Promise<{ textContent(): Promise<string | null>; click(options?: { timeout?: number }): Promise<void> } | null>
  $$(selector: string): Promise<Array<{ textContent(): Promise<string | null>; click(options?: { timeout?: number }): Promise<void> }>>
}

/** 响应拦截面（Playwright Response 的结构化子集）。 */
export interface CollectorResponse {
  url(): string
  text(): Promise<string>
}

/** 页面上下文 fetch 的参数与统一结果。 */
export interface CollectorFetchArg {
  url: string
  body?: Record<string, unknown> | undefined
}
export interface CollectorFetchOutcome {
  status: number
  text: string
  error?: string | undefined
}

/** 作品列表请求路径（GET，cursor 翻页）。 */
export const WORK_LIST_PATH = '/janus/douyin/creator/pc/work_list'
/** 单稿分析基路径（item_performance / involved_vertical / overview）。 */
export const ITEM_ANALYSIS_BASE = '/janus/douyin/creator/data/item_analysis'
/** item_compare（低播放判定）。 */
export const ITEM_COMPARE_PATH = '/janus/douyin/creator/data/diagnose/item_compare'
/** 流量来源。 */
export const PLAY_SOURCE_PATH = '/janus/douyin/creator/data/item/play/source'
/** 进度分析（必须带 /janus/douyin/creator 前缀，缺前缀被 SPA 兜底路由接住）。 */
export const PROGRESS_PATH = '/janus/douyin/creator/bff/data/progress/analysis/v2'
/** 搜索词。 */
export const SEARCH_KEYWORD_PATH = '/janus/douyin/creator/data/item_analysis/search/keyword'
/** 观众画像。 */
export const PORTRAIT_PATH = '/janus/douyin/creator/data/fans/item/portrait'
/** 评论热词。 */
export const WORD_CLOUD_PATH = '/aweme/v1/creator/data/item/wordCloud/'
/** 用户资料（会话判定第二处）。 */
export const USER_INFO_PATH = '/web/api/media/user/info/'
/** item mget（复数字段批量）。 */
export const ITEM_MGET_PATH = '/web/api/creator/item/mget'
export const ITEM_MGET_FIELDS = 'metrics,review,play_info,dou_plus,integrated_incentive,item_status,recommend_info'
/** 播放趋势（1026 方案主动直取累计口径）。 */
export const ITEM_METRICS_TREND_PATH = '/janus/douyin/creator/data/item_analysis/metrics_trend'
/** 留存/跳出（analysis_type=1/7）。 */
export const RETENTION_PATH = '/janus/douyin/creator/data/realtime/analysis/data_center'
/** 完播/吸粉 summarize。 */
export const ITEM_SUMMARIZE_PATH = '/web/api/creator/data/item/summarize/'
/** 账号大盘。 */
export const DASHBOARD_PATH = '/janus/douyin/creator/data/overview/dashboard'
export const DASHBOARD_FANS_PATH = '/janus/douyin/creator/data/overview/dashboard/fans'
export const FANS_SUMMARY_PATH = '/janus/douyin/creator/bff/data/fans/summary/v2'
export const DASHBOARD_RECENT_DAYS = 30

/** 作品管理页与详情页 URL。 */
export const WORK_MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage'
export const workDetailUrl = (workId: string): string => `https://creator.douyin.com/creator-micro/work-management/work-detail/${workId}`

export const DEFAULT_PAGE_SIZE = 12
export const MAX_PAGES_LIMIT = 1000
export const PAGE_INTERVAL_MS = 1000
/** expectedWorkCount 服务端 schema 上限；超限在展开详情之前确定性中止。 */
export const MAX_EXPECTED_WORK_COUNT = 10_000
export const ITEM_GENRES = [1, 2, 3, 4, 5, 8] as const

/** 采集范围（1117 方案）：过滤用上海语义；上报用服务端钉死的等值 UTC 字面量。 */
export const WORK_PUBLISH_SINCE_ISO = '2026-06-01T00:00:00+08:00'
export const WORK_PUBLISH_SINCE_REPORT = '2026-05-31T16:00:00Z'
export const WORK_PUBLISH_SINCE_MS = Date.parse(WORK_PUBLISH_SINCE_ISO)

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Wrap a real Playwright Page into the collect surface（闭包逐方法转发，无类型
 * 断言——Page 的重载面对结构化接口不直接可赋值，闭包转发保持精确类型）。
 */
export function collectSurfaceOf(page: Page): DouyinCollectPage {
  return {
    goto: (url, options) => page.goto(url, options),
    waitForTimeout: ms => page.waitForTimeout(ms),
    waitForLoadState: (state, options) => page.waitForLoadState(state ?? 'load', options),
    evaluate: (script, arg) => page.evaluate(script, arg),
    evaluateDom: (script, arg) => page.evaluate(script, arg),
    on: (event, listener) => { page.on(event, listener) },
    off: (event, listener) => { page.off(event, listener) },
    click: (selector, options) => page.click(selector, options),
    $: selector => page.$(selector),
    $$: selector => page.$$(selector),
  }
}

/**
 * publish_time 过滤（过滤发生在详情采集前）：publish_time 非 string 或解析
 * NaN → publishTimeMissing++ 且不入库（不猜日期、不静默丢为范围外）；ms <
 * sinceMs → skippedBeforePublishSince++；其余保留。
 */
export function filterWorksByPublishSince(works: WorkItem[], options: { sinceMs?: number } = {}): {
  works: WorkItem[]
  skippedBeforePublishSince: number
  publishTimeMissing: number
} {
  const sinceMs = options.sinceMs ?? WORK_PUBLISH_SINCE_MS
  const kept: WorkItem[] = []
  let skipped = 0
  let missing = 0
  for (const work of works) {
    if (typeof work.publishTime !== 'string' || Number.isNaN(Date.parse(work.publishTime))) {
      missing += 1
      continue
    }
    if (Date.parse(work.publishTime) < sinceMs) {
      skipped += 1
      continue
    }
    kept.push(work)
  }
  return { works: kept, skippedBeforePublishSince: skipped, publishTimeMissing: missing }
}

/** 页面上下文同源 fetch（页面自动带签名与登录态）；返回文本以便精度安全解析。 */
export async function evaluateJsonFetch(page: DouyinCollectPage, arg: CollectorFetchArg): Promise<CollectorFetchOutcome> {
  return page.evaluate(async (request: CollectorFetchArg) => {
    try {
      const response = await fetch(request.url, request.body === undefined
        ? { credentials: 'same-origin' }
        : {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
          })
      return { status: response.status, text: await response.text() }
    } catch (error: unknown) {
      return { status: 0, text: '', error: String(error) }
    }
  }, arg)
}

/** fetchJson：要求 200；解析失败 error=invalid_json（旧 fetchJson 全语义）。 */
async function fetchJson(page: DouyinCollectPage, arg: CollectorFetchArg): Promise<{ ok: boolean; status: number; json: unknown; error: string | null }> {
  const raw = await evaluateJsonFetch(page, arg)
  if (raw.status !== 200) {
    return { ok: false, status: raw.status, json: null, error: raw.error ?? null }
  }
  const json = parseJsonPreservingIds(raw.text)
  return { ok: json !== null, status: 200, json, error: json === null ? 'invalid_json' : null }
}

/** collectWorkList 的结果（五种不完整判定）。 */
export interface WorkListResult {
  works: WorkItem[]
  listComplete: boolean
  pages: { pageNumber: number; cursor: string; count: number; hasMore: boolean }[]
  reason: string | null
  error: string | null
  cursor: string | null
}

/**
 * 作品列表分页（12/页，cursor 翻页，每页至多 3 次退避重试；某页失败即
 * listComplete=false，绝不按空列表假成功；翻页中途会话失效时已采集作品挂在
 * SessionInvalidError.partialListWorks 上带出）。
 */
export async function collectWorkList(page: DouyinCollectPage, options: {
  pageSize?: number
  maxPages?: number
  intervalMs?: number
  retries?: number
  onPage?: ((event: { pageNumber: number; count: number; hasMore: boolean; collected: number }) => void) | undefined
} = {}): Promise<WorkListResult> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = options.maxPages ?? MAX_PAGES_LIMIT
  if (!(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= MAX_PAGES_LIMIT)) {
    throw new Error('max_pages_out_of_range')
  }
  const intervalMs = options.intervalMs ?? PAGE_INTERVAL_MS
  const retries = options.retries ?? 2
  const collected: WorkItem[] = []
  const pages: WorkListResult['pages'] = []
  let cursor: string | number = 0
  let listComplete = false
  let reason: string | null = null
  let error: string | null = null

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = `${WORK_LIST_PATH}?scene=star_atlas&device_platform=android&aid=1128&status=0&count=${String(pageSize)}&max_cursor=${String(cursor)}`
    let result: Awaited<ReturnType<typeof fetchJson>> | null = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      result = await fetchJson(page, { url })
      if (result.ok) break
      if (attempt < retries) await sleep(Math.min(8000, 1000 * 2 ** attempt))
    }
    if (result === null || !result.ok) {
      // 某页失败：指数退避后仍失败 → 列表不完整，绝不按空列表结算。
      reason = 'page_request_failed'
      error = result !== null && result.status !== 0 ? `page_http_${String(result.status)}` : 'page_request_failed'
      break
    }
    // HTTP 200 + status_code:8（会话失效）在 parseWorkListPage 内抛 SessionInvalidError：
    // 翻页中途过期时，前几页已采集作品挂在错误上带出，由过期收尾入库保留；
    // 直接向上传播（不退避重试、不继续下一页）。
    let parsed: WorkListPage
    try {
      parsed = parseWorkListPage(result.json)
    } catch (error) {
      if (error instanceof SessionInvalidError && collected.length > 0) error.partialListWorks = collected
      throw error
    }
    collected.push(...parsed.works)
    pages.push({ pageNumber, cursor: String(cursor), count: parsed.rawCount, hasMore: parsed.hasMore })
    options.onPage?.({ pageNumber, count: parsed.rawCount, hasMore: parsed.hasMore, collected: collected.length })

    const decision = decidePagination(parsed, cursor, pageNumber, maxPages)
    if (decision.stop) {
      listComplete = decision.listComplete
      reason = decision.reason
      break
    }
    // stop=false 已由 decidePagination 保证游标非空且前进；?? 仅作类型收窄。
    cursor = parsed.nextCursor ?? cursor
    await sleep(intervalMs)
  }

  return { works: dedupeWorks(collected), listComplete, pages, reason, error, cursor: String(cursor) }
}

/** 批量分析三连的产物（involved_vertical → item_performance / overview）。 */
export interface ItemAnalysisBundle {
  window: { startDate: string; endDate: string }
  primaryVerticals: unknown[]
  performance: Map<string, PerformanceRow>
  performanceError: string | null
  overview: unknown
  overviewError: string | null
}

function yyyymmdd(date: Date): string {
  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * 批量作品分析：involved_vertical → overview / item_performance（metric_type=1）。
 * 三接口各自判会话失效（status_code=8 即抛 SessionInvalidError）；普通失败按
 * performanceError/overviewError 降级，不阻断。
 */
export async function collectItemAnalysis(page: DouyinCollectPage, options: {
  days?: number
  now?: () => Date
  genres?: number[]
} = {}): Promise<ItemAnalysisBundle> {
  const days = options.days ?? 30
  const now = options.now ?? (() => new Date())
  const genres = options.genres ?? [...ITEM_GENRES]
  const end = now()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const startDate = yyyymmdd(start)
  const endDate = yyyymmdd(end)
  const vertical = await fetchJson(page, { url: `${ITEM_ANALYSIS_BASE}/involved_vertical?start_date=${startDate}&end_date=${endDate}` })
  if (vertical.ok && isSessionExpiredPayload(vertical.json)) {
    throw new SessionInvalidError(toInt(sessionStatusCodeOf(vertical.json)) ?? SESSION_EXPIRED_STATUS_CODE)
  }
  const primaryVerticals = vertical.ok && Array.isArray((vertical.json as { primary_verticals?: unknown }).primary_verticals)
    ? (vertical.json as { primary_verticals: unknown[] }).primary_verticals
    : []
  const performance = await fetchJson(page, {
    url: `${ITEM_ANALYSIS_BASE}/item_performance`,
    body: { start_date: startDate, end_date: endDate, genres, primary_verticals: primaryVerticals, metric_type: 1 },
  })
  if (performance.ok && isSessionExpiredPayload(performance.json)) {
    throw new SessionInvalidError(toInt(sessionStatusCodeOf(performance.json)) ?? SESSION_EXPIRED_STATUS_CODE)
  }
  const overview = await fetchJson(page, {
    url: `${ITEM_ANALYSIS_BASE}/overview`,
    body: { start_date: startDate, end_date: endDate, genres, primary_verticals: primaryVerticals },
  })
  if (overview.ok && isSessionExpiredPayload(overview.json)) {
    throw new SessionInvalidError(toInt(sessionStatusCodeOf(overview.json)) ?? SESSION_EXPIRED_STATUS_CODE)
  }
  return {
    window: { startDate, endDate },
    primaryVerticals,
    performance: performance.ok ? parseItemPerformance(performance.json) : new Map(),
    performanceError: performance.ok ? null : 'item_performance_failed',
    overview: overview.ok ? overview.json : null,
    overviewError: overview.ok ? null : 'overview_failed',
  }
}

/** 会话失效载荷里的业务状态码（isSessionExpiredPayload 已判定为 8）。 */
function sessionStatusCodeOf(json: unknown): unknown {
  return (json as { status_code?: unknown }).status_code
}

/** 详情拦截片段（url.includes 匹配；每 key 只收第一份成功解析的响应）。 */
const DETAIL_TARGETS: Record<string, string> = {
  compare: '/data/diagnose/item_compare',
  source: '/data/item/play/source',
  progress: '/bff/data/progress/analysis/v2',
  search: '/data/item_analysis/search/keyword',
  portrait: '/data/fans/item/portrait',
  mget: '/web/api/creator/item/mget',
  summarize: '/data/item/summarize/',
}

type DetailListener = (response: CollectorResponse) => void

/** collectWorkDetail 的产物。 */
export interface WorkDetailBundle {
  endpointsSeen: string[]
  compare: CompareMetrics | null
  source: PlaySourceRow[] | null
  portrait: AudiencePortrait | null
  search: SearchKeywordRow[] | null
  progress: ProgressAnalysis | null
  mget: Map<string, MgetRow> | null
  summarize: Map<string, SummarizeRow> | null
  metricsTrend: PlayTrendPoint[] | null
  metricsTrendGap: string | null
  retention: RealtimeTrend | null
  retentionGap: string | null
  bounce: RealtimeTrend | null
  bounceGap: string | null
}

/**
 * 导航到详情页（3 次退避重试）。真网络 + 单页应用下 `goto` 会因网络抖动或客户端
 * 路由抢占瞬时失败；不重试会让上一次未结束的导航打断后续所有 goto（雪崩）。
 */
async function gotoWorkDetail(page: DouyinCollectPage, workId: string, timeoutMs: number, attempts = 3): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(workDetailUrl(workId), { waitUntil: 'domcontentloaded', timeout: timeoutMs })
      return
    } catch (error) {
      lastError = error
      if (attempt >= attempts) break
      // 尽力等待上一次导航收尾；已经停在错误页时这里会立刻返回，不会阻塞。
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
      }
      await sleep(500 * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

/** 点击匹配文本的叶子元素（children.length === 0，避免命中容器后点击无效）。 */
async function clickByText(page: DouyinCollectPage, text: string): Promise<boolean> {
  try {
    const clicked = await page.evaluateDom(needle => {
      const nodes = [...document.querySelectorAll('div,span,button,a,li')]
      const target = nodes.find(node => node.children.length === 0 && (node.textContent || '').trim() === needle)
      if (target === undefined) return false
      ;(target as HTMLElement).click()
      return true
    }, text)
    return Boolean(clicked)
  } catch {
    // 页面上下文执行失败（导航中/已关闭）等价于未点到：兜底 fetch 会补齐数据。
    return false
  }
}

/** 单稿通道采集：优先响应拦截，缺失项用页面内 fetch 兜底。 */
export async function collectWorkDetail(page: DouyinCollectPage, options: {
  work: WorkItem
  timeoutMs?: number
  onTarget?: ((key: string) => void) | undefined
  now?: () => number
}): Promise<WorkDetailBundle> {
  const timeoutMs = options.timeoutMs ?? 25_000
  const workId = options.work.workId
  const captured: Record<string, unknown> = {}
  const listener: DetailListener = response => {
    const url = response.url()
    for (const [key, fragment] of Object.entries(DETAIL_TARGETS)) {
      if (!url.includes(fragment) || captured[key] !== undefined) continue
      void response.text().then(text => {
        const json = parseJsonPreservingIds(text)
        if (json !== null) {
          captured[key] = json
          options.onTarget?.(key)
        }
      }).catch(() => undefined)
    }
  }
  page.on('response', listener)
  try {
    await gotoWorkDetail(page, workId, timeoutMs)
    await page.waitForTimeout(3000)
    for (const label of ['流量分析', '观众分析']) {
      const clicked = await clickByText(page, label)
      if (clicked) await page.waitForTimeout(1500)
    }
    await page.waitForTimeout(1500)
  } finally {
    page.off('response', listener)
  }

  // 页面内 fetch 兜底：拦截漏取（低播放/未点开 tab）时补齐。
  const fallback = {
    compare: `${ITEM_COMPARE_PATH}?item_id=${workId}&selected_metric_count=2`,
    source: `${PLAY_SOURCE_PATH}?item_id=${workId}`,
    progress: `${PROGRESS_PATH}?item_id=${workId}`,
    search: `${SEARCH_KEYWORD_PATH}?item_id=${workId}`,
    portrait: `${PORTRAIT_PATH}?item_id=${workId}`,
    mget: `${ITEM_MGET_PATH}?ids=${workId}&fields=${ITEM_MGET_FIELDS}`,
    summarize: `${ITEM_SUMMARIZE_PATH}?item_id=${workId}`,
  }
  for (const [key, path] of Object.entries(fallback)) {
    if (captured[key] !== undefined) continue
    const result = await fetchJson(page, { url: path })
    if (result.ok) {
      captured[key] = result.json
      options.onTarget?.(`${key}:fallback`)
    }
  }
  const compare = captured.compare ?? null
  const compareParsed = parseItemCompare(compare)
  if (compare !== null && isSessionExpiredPayload(compare)) {
    throw new SessionInvalidError(toInt(sessionStatusCodeOf(compare)) ?? SESSION_EXPIRED_STATUS_CODE)
  }
  if (compareParsed.lowPlay && compareParsed.statusCode === LOW_PLAY_STATUS_CODE) {
    // 低播放：记录原因，不抛错，不阻塞该作品其余字段。
    compareParsed.gapReason = 'below_min_view'
  } else if (compare === null) {
    // 拦截和页面内 fetch 都没拿到：这是通道失败，不是抖音声明低播放。
    compareParsed.gapReason = 'request_failed'
  }

  // 官方按日累计（最近 7 个已完成日）主动直取，不进页面拦截——详情页自己发的
  // metrics_trend 是"新增/每小时"等展示组合，拦截会拿到错误口径；固定 trend_type=2
  // （累计）+ time_unit=1（天）+ view_count。失败只记缺口，不阻塞作品其余字段；
  // status_code=8 仍按会话失效传播。
  let metricsTrend: PlayTrendPoint[] | null = null
  let metricsTrendGap: string | null = null
  try {
    const trendUrl = `${ITEM_METRICS_TREND_PATH}?item_id=${workId}&trend_type=2&time_unit=1&metrics_group=0%2C1%2C3&metrics=view_count`
    const trendResult = await fetchJson(page, { url: trendUrl })
    if (!trendResult.ok) {
      metricsTrendGap = 'request_failed'
    } else {
      metricsTrend = parseItemMetricsTrend(trendResult.json, shanghaiTodayIso(options.now))
      if (metricsTrend === null) metricsTrendGap = 'not_exposed'
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    metricsTrendGap = 'request_failed'
  }
  // 上海今天及以后的点丢弃（数据未出/占位口径不可信），与 dashboard dropFuture 同口径。
  if (metricsTrend !== null) {
    const todayIso = shanghaiTodayIso(options.now)
    metricsTrend = metricsTrend.filter(point => point.day < todayIso)
    if (metricsTrend.length === 0) {
      metricsTrend = null
      metricsTrendGap = 'not_exposed'
    }
  }
  // 观看趋势直取（analysis_type=1 留存 / 7 跳出，同接口同结构）：失败只记
  // request_failed 缺口，不阻塞其余字段；status_code=8 仍按会话失效传播。
  let retention: RealtimeTrend | null = null
  let retentionGap: string | null = null
  try {
    const retentionUrl = `${RETENTION_PATH}?item_id=${workId}&analysis_type=1`
    const retentionResult = await fetchJson(page, { url: retentionUrl })
    if (!retentionResult.ok) {
      retentionGap = 'request_failed'
    } else {
      retention = parseRealtimeTrend(retentionResult.json)
      if (retention === null) retentionGap = 'not_exposed'
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    retentionGap = 'request_failed'
  }
  let bounce: RealtimeTrend | null = null
  let bounceGap: string | null = null
  try {
    const bounceUrl = `${RETENTION_PATH}?item_id=${workId}&analysis_type=7`
    const bounceResult = await fetchJson(page, { url: bounceUrl })
    if (!bounceResult.ok) {
      bounceGap = 'request_failed'
    } else {
      bounce = parseRealtimeTrend(bounceResult.json)
      if (bounce === null) bounceGap = 'not_exposed'
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bounceGap = 'request_failed'
  }
  return {
    endpointsSeen: Object.keys(DETAIL_TARGETS).filter(key => captured[key] !== undefined),
    compare: compareParsed,
    source: captured.source !== undefined ? parsePlaySource(captured.source) : null,
    portrait: captured.portrait !== undefined ? parsePortrait(captured.portrait) : null,
    search: captured.search !== undefined ? parseSearchKeywords(captured.search) : null,
    progress: captured.progress !== undefined ? parseProgressAnalysis(captured.progress) : null,
    mget: captured.mget !== undefined ? parseItemMget(captured.mget) : null,
    summarize: captured.summarize !== undefined ? parseItemSummarize(captured.summarize) : null,
    metricsTrend,
    metricsTrendGap,
    retention,
    retentionGap,
    bounce,
    bounceGap,
  }
}

/** 评论热词：成功（含空数组）与请求失败严格区分。 */
export async function collectHotword(page: DouyinCollectPage, workId: string): Promise<HotwordResult> {
  const result = await fetchJson(page, { url: `${WORD_CLOUD_PATH}?item_id=${workId}&mcn_type=0` })
  if (!result.ok) return { status: 'unavailable', statusCode: null, words: [], error: result.error || 'request_failed' }
  return parseWordCloud(result.json)
}

/**
 * 账号资料（昵称/粉丝数/头像），页面同源 fetch。
 *
 * HTTP 200 + `status_code: 8`（业务层会话失效）必须抛 SessionInvalidError：
 * user/info 是采集链路的第二处会话判定点（第一处是作品列表）；静默返回 null
 * 会把过期会话伪装成"资料缺失"继续跑详情批次。非会话错误原样上抛，不吞。
 */
export async function collectAccountProfile(page: DouyinCollectPage): Promise<DouyinProfile | null> {
  const result = await fetchJson(page, { url: CREATOR_ORIGIN.replace(/\/$/u, '') + USER_INFO_PATH })
  if (result.ok && isSessionExpiredPayload(result.json)) {
    throw new SessionInvalidError()
  }
  if (!result.ok || !result.json || typeof result.json !== 'object') return null
  const payload = result.json as Record<string, unknown>
  const user = payload.user || payload.data || payload
  if (!user || typeof user !== 'object') return null
  const record = user as Record<string, unknown>
  const accountId = String(record.sec_uid || record.uid || record.user_id || '').trim()
  if (accountId === '') return null
  const nickname = record.nickname || record.name || null
  return {
    accountId,
    nickname: typeof nickname === 'string' ? nickname : null,
    // avatar_uri 可能是 {uri,url_list} 图集对象：经统一标准化后只透出合法 http(s) 字符串。
    // 候选清单与 session.readAccountProfile 保持一致（同输入同输出）。
    avatar: normalizeAvatarUrl(presentValue(record.avatar_uri, record.avatar_url, record.avatarUrl, record.avatar)),
    fanCount: Number(record.follower_count ?? record.fans_count ?? Number.NaN) || null,
  }
}

/** 第一个非 undefined/null 值（资料候选链；'' 不跳过，与旧 collector 一致）。 */
function presentValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value
  }
  return null
}

/** 大盘三连产物（失败隔离：任一失败只记 gap）。 */
export interface DashboardBundle {
  dashboardRows: Record<string, unknown>[]
  dashboardFansRows: Record<string, unknown>[]
  fansProfile: unknown
  gaps: { source: string; reason: string }[]
}

/** 大盘两源浅合并结果（ingest daily 投递形状）。 */
export function mergeDailyRows(bundle: Pick<DashboardBundle, 'dashboardRows' | 'dashboardFansRows'>): Record<string, unknown>[] {
  return mergeDashboardRows(bundle.dashboardRows, bundle.dashboardFansRows)
}

/** 上海今天之后的 dashboard 行整行丢弃（占位/异常大值，真机 E2E 教训）。 */
function dropFutureRows(rows: Record<string, unknown>[], todayIso: string): Record<string, unknown>[] {
  return rows.filter(row => typeof row.day === 'string' && row.day < todayIso)
}

/**
 * 账号大盘三连（dashboard / dashboard/fans / fans/summary/v2）。
 *
 * 三个请求各自独立 try：任一失败只记 gap，不抛出、不阻断作品入库与 run 结算
 * （失败隔离）。唯一例外是会话失效（HTTP 200 + status_code:8）：三个接口共用
 * 同一登录态，任一判定过期都立即抛 SessionInvalidError 走既有过期链路。
 */
export async function collectDashboard(page: DouyinCollectPage, options: { recentDays?: number } = {}): Promise<DashboardBundle> {
  const recentDays = options.recentDays ?? DASHBOARD_RECENT_DAYS
  const gaps: { source: string; reason: string }[] = []
  const note = (source: string, reason: string): void => { gaps.push({ source, reason }) }

  const load = async (source: string, url: string): Promise<unknown | null> => {
    const result = await fetchJson(page, { url })
    if (!result.ok) {
      note(source, result.status !== 0 ? `http_${String(result.status)}` : 'request_failed')
      return null
    }
    if (isSessionExpiredPayload(result.json)) {
      throw new SessionInvalidError(toInt(sessionStatusCodeOf(result.json)) ?? SESSION_EXPIRED_STATUS_CODE)
    }
    return result.json
  }

  // 上海"今天"（数据未出：后台每日 10 点更新前一日数据）。今天及未来的 trends
  // 点是接口占位/异常大值，必须在采集侧整行丢弃。
  const todayIso = shanghaiTodayIso()
  let dashboardRows: Record<string, unknown>[] = []
  let dashboardFansRows: Record<string, unknown>[] = []
  let fansProfile: unknown = null

  try {
    const json = await load('dashboard', `${DASHBOARD_PATH}?recent_days=${String(recentDays)}`)
    dashboardRows = json !== null ? dropFutureRows(parseDashboardMetrics(json), todayIso) : []
    // 响应到达但零指标行（如 status_code=5 拒绝/降级空 metrics）：显式记缺口。
    if (json !== null && dashboardRows.length === 0) note('dashboard', 'not_exposed')
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    note('dashboard', safeParseReason(error))
  }

  try {
    const json = await load('dashboard_fans', `${DASHBOARD_FANS_PATH}?recent_days=${String(recentDays)}`)
    dashboardFansRows = json !== null ? dropFutureRows(parseDashboardMetrics(json), todayIso) : []
    if (json !== null && dashboardFansRows.length === 0) note('dashboard_fans', 'not_exposed')
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    note('dashboard_fans', safeParseReason(error))
  }

  try {
    const json = await load('fans_summary', FANS_SUMMARY_PATH)
    if (json !== null) {
      fansProfile = parseFansSummary(json)
      if (fansProfile === null) note('fans_summary', 'not_exposed')
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    note('fans_summary', safeParseReason(error))
  }

  return { dashboardRows, dashboardFansRows, fansProfile, gaps }
}

/** 稳定 parse 原因（error.code 或 name 前 64 字符，兜底 parse_failed）。 */
export function safeParseReason(error: unknown): string {
  if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  if (error !== null && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return ((error as { name: string }).name).slice(0, 64)
  }
  return 'parse_failed'
}

/** 稳定单作品失败原因（error.code 或 name 前 64 字符，兜底 work_collect_failed）。 */
function safeReason(error: unknown): string {
  if (error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code
  }
  if (error !== null && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string') {
    return ((error as { name: string }).name).slice(0, 64)
  }
  return 'work_collect_failed'
}

/** collectAccountWorksOn 的产物。 */
export interface AccountWorksResult {
  works: WorkPayload[]
  failures: { workId: string; reason: string }[]
  pages: WorkListResult['pages']
  listComplete: boolean
  listReason: string | null
  expectedWorkCount: number
  publishSince: string
  skippedBeforePublishSince: number
  publishTimeMissing: number
  profile: DouyinProfile | null
  dashboard: DashboardBundle
  itemAnalysis: ItemAnalysisBundle | null
}

/**
 * 单账号采集总编排（goto 作品管理 → 列表 → publishSince 过滤 → 超限检查 →
 * 资料 → 批量分析 → 逐稿详情+热词+合并 → 大盘三连）。
 *
 * 会话失效在各阶段抛 SessionInvalidError 并挂 partialCollected：列表阶段保留
 * 已采集页的范围内作品（详情字段全 null）；资料/批量分析阶段保留全部范围内
 * 作品；详情/大盘阶段保留已完成载荷。非会话错误：资料阶段上抛，批量分析降级
 * 为空 Map，单作品失败只记该作品。
 */
export async function collectAccountWorksOn(surface: DouyinCollectPage, options: {
  maxPages?: number
  days?: number
  onProgress?: ((info: Record<string, unknown>) => void) | undefined
  now?: () => number
  detailOptions?: { timeoutMs?: number } | undefined
  workListOptions?: { intervalMs?: number; retries?: number; pageSize?: number } | undefined
} = {}): Promise<AccountWorksResult> {
  const now = options.now ?? Date.now
  const observedAt = new Date(now()).toISOString()
  await surface.goto(WORK_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  let list: WorkListResult
  try {
    list = await collectWorkList(surface, {
      ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
      ...(options.workListOptions ?? {}),
      onPage: event => options.onProgress?.({ phase: 'list_page', ...event }),
    })
  } catch (error) {
    // 翻页中途会话失效：前几页已采集作品不能丢——正规化为入库载荷挂错误上。
    // 部分成果只保留范围内作品（缺失 publish_time 同样不保留）。
    if (error instanceof SessionInvalidError && Array.isArray(error.partialListWorks)
        && error.partialListWorks.length > 0) {
      const partialScoped = filterWorksByPublishSince(error.partialListWorks)
      error.partialListWorks = partialScoped.works
      error.partialCollected = {
        works: partialScoped.works.map(work => scopelessPayload(work, observedAt)),
        listComplete: false,
        expectedWorkCount: partialScoped.works.length,
        publishSince: WORK_PUBLISH_SINCE_REPORT,
      }
    }
    throw error
  }
  // 范围过滤：发生在任何详情采集之前；混合新旧作品页只保留范围内作品。
  const scoped = filterWorksByPublishSince(list.works)
  // publish_time 缺失 → 本轮列表完整性不可证明，绝不按 listComplete=true 结算。
  // listReason 语义：缺失只把"本会健康完成"的轮次改为 publish_time_missing；
  // 翻页本就失败时保留更关键的既有根因。
  const publishTimeMissing = scoped.publishTimeMissing > 0
  const listComplete = publishTimeMissing ? false : list.listComplete
  const listReason = publishTimeMissing
    ? (list.listComplete ? 'publish_time_missing' : (list.reason ?? 'publish_time_missing'))
    : list.reason
  const expectedWorkCount = scoped.works.length
  if (expectedWorkCount > MAX_EXPECTED_WORK_COUNT) {
    // 超出 tools 侧 expectedWorkCount 上限（范围内数量）：此时无论怎么采集都不可能
    // 诚实结算完成，因此在展开逐稿详情（耗时最长的一段）之前就中止。
    throw new Error('expected_work_count_out_of_range')
  }
  let profile: DouyinProfile | null
  try {
    profile = await collectAccountProfile(surface)
  } catch (error) {
    // 会话失效：已完成的列表成果不能随栈帧丢弃——正规化为入库载荷挂在错误上，
    // 过期收尾据此入库保留。非会话错误原样上抛（资料缺失不静默降级）。
    if (error instanceof SessionInvalidError) {
      error.partialCollected = {
        works: scoped.works.map(work => scopelessPayload(work, observedAt)),
        listComplete,
        expectedWorkCount: scoped.works.length,
        publishSince: WORK_PUBLISH_SINCE_REPORT,
      }
    }
    throw error
  }

  let performance = new Map<string, PerformanceRow>()
  let itemAnalysis: ItemAnalysisBundle | null = null
  try {
    itemAnalysis = await collectItemAnalysis(surface, { ...(options.days !== undefined ? { days: options.days } : {}) })
    performance = itemAnalysis.performance
  } catch (error) {
    // 批量分析普通失败仍降级为缺口；但会话失效必须上抛，且保留已完成列表，
    // 防止"status_code=8 后继续逐稿采集"或丢弃已采集列表造成假成功/数据丢失。
    if (error instanceof SessionInvalidError) {
      error.partialCollected = {
        works: scoped.works.map(work => scopelessPayload(work, observedAt)),
        listComplete,
        expectedWorkCount: scoped.works.length,
        publishSince: WORK_PUBLISH_SINCE_REPORT,
      }
      throw error
    }
    itemAnalysis = null
    performance = new Map()
  }

  const payloads: WorkPayload[] = []
  const failures: { workId: string; reason: string }[] = []
  let index = 0
  for (const work of scoped.works) {
    index += 1
    options.onProgress?.({ phase: 'work', workId: work.workId, index, total: scoped.works.length })
    try {
      const detail = await collectWorkDetail(surface, { work, ...(options.detailOptions ?? {}), now })
      const hotword = await collectHotword(surface, work.workId)
      payloads.push(buildWorkPayload({
        work,
        performance: performance.get(work.workId) ?? null,
        compare: detail.compare,
        source: detail.source,
        portrait: detail.portrait,
        search: detail.search,
        progress: detail.progress,
        mget: detail.mget,
        summarize: detail.summarize,
        hotword,
        metricsTrend: detail.metricsTrend,
        metricsTrendGap: detail.metricsTrendGap,
        retention: detail.retention,
        retentionGap: detail.retentionGap,
        bounce: detail.bounce,
        bounceGap: detail.bounceGap,
        observedAt,
      }))
    } catch (error) {
      // 会话失效：立即中止本轮（不继续后续作品批次、不当作单作品失败），
      // 已完成的详情载荷挂在错误上，由过期收尾入库保留。
      if (error instanceof SessionInvalidError) {
        error.partialCollected = {
          works: payloads,
          listComplete,
          expectedWorkCount: scoped.works.length,
          publishSince: WORK_PUBLISH_SINCE_REPORT,
        }
        throw error
      }
      // 单作品失败只记录该作品，不阻塞其余作品。
      failures.push({ workId: work.workId, reason: safeReason(error) })
    }
  }

  // 账号大盘三连：作品链路完成后在同一页面上下文顺带采集。失败隔离——三请求
  // 各自记 gap、绝不阻断作品载荷与 run 结算；唯一例外是会话失效：上抛并挂
  // 已完成的详情载荷，走既有过期收尾链路。
  let dashboard: DashboardBundle = { dashboardRows: [], dashboardFansRows: [], fansProfile: null, gaps: [] }
  try {
    dashboard = await collectDashboard(surface)
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      error.partialCollected = {
        works: payloads,
        listComplete,
        expectedWorkCount: scoped.works.length,
        publishSince: WORK_PUBLISH_SINCE_REPORT,
      }
      throw error
    }
    dashboard.gaps.push({ source: 'dashboard', reason: safeReason(error) })
  }

  return {
    works: payloads,
    failures,
    pages: list.pages,
    listComplete,
    listReason,
    expectedWorkCount,
    // 诊断性范围信息：只含范围起点与纯计数，绝不含范围外作品 ID、标题或其他
    // 原始列表内容。
    publishSince: WORK_PUBLISH_SINCE_REPORT,
    skippedBeforePublishSince: scoped.skippedBeforePublishSince,
    publishTimeMissing: scoped.publishTimeMissing,
    profile,
    dashboard,
    itemAnalysis,
  }
}

/** 详情全 null 的范围内作品载荷（会话失效部分成果的正规化形态）。 */
function scopelessPayload(work: WorkItem, observedAt: string): WorkPayload {
  return buildWorkPayload({
    work,
    performance: null,
    compare: null,
    source: null,
    portrait: null,
    search: null,
    progress: null,
    retention: null,
    retentionGap: null,
    bounce: null,
    bounceGap: null,
    mget: null,
    summarize: null,
    hotword: null,
    metricsTrend: null,
    metricsTrendGap: null,
    observedAt,
  })
}
