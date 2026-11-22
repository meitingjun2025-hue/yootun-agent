/**
 * 创作者中心采集引擎（移植旧 collector.js 全语义）：所有接口都在页面上下文
 * 同源 fetch/响应拦截（页面自动生成 msToken/a_bogus，宿主绝不直连抖音）；
 * publish_time 过滤发生在任何详情采集之前；publish_time 缺失不入库且
 * listComplete=false；低播放 10001 记缺口不是错误；大盘三连失败隔离只记 gap。
 * @module
 */
import type { Page } from 'playwright-core'
import {
  clampText, decidePagination, dedupeWorks, firstUrl, isSessionExpiredPayload, mergeDashboardRows,
  parseDashboardMetrics, parseFansSummary, parseItemCompare, parseItemMetricsTrend, parseItemMget,
  parseItemSummarize, parsePlaySource, parsePortrait, parseProgressAnalysis, parseJsonPreservingIds,
  parseRealtimeTrend, parseSearchKeywords, parseWordCloud, parseWorkListPage, pct, resolveClientStatus,
  round2, shanghaiTodayIso, SessionInvalidError, toInt, toNumber, buildWorkPayload, firstPresent,
  type AudiencePortrait, type CompareMetrics, type HotwordResult, type PartialCollected,
  type PlaySourceRow, type PlayTrendPoint, type ProgressAnalysis,
  type RealtimeTrend, type SearchKeywordRow, type SummarizeRow, type WorkItem, type WorkPayload,
} from './parse.ts'
import { CREATOR_ORIGIN, type DouyinProfile } from './session.ts'

/** 采集请求页面面（Playwright Page 的结构化子集；直接满足，无类型断言）。 */
export interface DouyinCollectPage {
  goto(url: string, options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  evaluate(script: (arg: CollectorFetchArg) => Promise<CollectorFetchOutcome>, arg: CollectorFetchArg): Promise<CollectorFetchOutcome>
  on(event: 'response', listener: (response: CollectorResponse) => void): unknown
  off(event: 'response', listener: (response: CollectorResponse) => void): unknown
  click(selector: string, options?: { timeout?: number }): Promise<void>
  $(selector: string): Promise<{ textContent(): Promise<string | null>; click(options?: { timeout?: number }): Promise<void> } | null>
  $$(selector: string): Promise<Array<{ textContent(): Promise<string | null>; click(options?: { timeout?: number }): Promise<void> }>>
}

/** 采集请求页面面（Playwright Page 的结构化子集；直接满足，无类型断言）。 */
export interface DouyinCollectPage {
  goto(url: string, options?: { waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle'; timeout?: number }): Promise<unknown>
  waitForTimeout(ms: number): Promise<void>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  evaluate(script: (arg: CollectorFetchArg) => Promise<CollectorFetchOutcome>, arg: CollectorFetchArg): Promise<CollectorFetchOutcome>
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

/** 页面上下文同源 fetch（页面自动带签名与登录态）。 */
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

/** fetchJson：要求 200；解析失败 error=invalid_json。 */
async function fetchJson(page: DouyinCollectPage, arg: CollectorFetchArg): Promise<{ ok: boolean; status: number; json: unknown; error: string | null }> {
  const outcome = await evaluateJsonFetch(page, arg)
  if (outcome.status !== 200) return { ok: false, status: outcome.status, json: null, error: `page_http_${String(outcome.status)}` }
  const json = parseJsonPreservingIds(outcome.text)
  if (json === null) return { ok: false, status: outcome.status, json: null, error: 'invalid_json' }
  return { ok: true, status: outcome.status, json, error: null }
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
 * listComplete=false，绝不按空列表假成功）。
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
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_LIMIT) {
    throw new Error('max_pages_out_of_range')
  }
  const intervalMs = options.intervalMs ?? PAGE_INTERVAL_MS
  const retries = options.retries ?? 2
  const works: WorkItem[] = []
  const pages: WorkListResult['pages'] = []
  let cursor = '0'
  let listComplete = true
  let reason: string | null = null
  let error: string | null = null
  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const url = `${WORK_LIST_PATH}?scene=star_atlas&device_platform=android&aid=1128&status=0&count=${String(pageSize)}&max_cursor=${encodeURIComponent(cursor)}`
    let json: unknown = null
    let pageOk = false
    let pageError: string | null = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const outcome = await fetchJson(page, { url })
      if (outcome.ok) {
        json = outcome.json
        pageOk = true
        pageError = null
        break
      }
      pageError = outcome.error
      await sleep(Math.min(8000, 1000 * 2 ** attempt))
    }
    if (!pageOk) {
      listComplete = false
      reason = 'page_request_failed'
      error = pageError
      break
    }
    let parsed
    try {
      parsed = parseWorkListPage(json)
    } catch (error) {
      if (error instanceof SessionInvalidError && works.length > 0) error.partialListWorks = works
      throw error
    }
    works.push(...parsed.works)
    pages.push({ pageNumber, cursor, count: parsed.rawCount, hasMore: parsed.hasMore })
    options.onPage?.({ pageNumber, count: parsed.rawCount, hasMore: parsed.hasMore, collected: works.length })
    const decision = decidePagination(parsed, pageNumber, maxPages, cursor)
    if (!decision.continue) {
      if (decision.reason !== null) {
        listComplete = false
        reason = decision.reason
      }
      break
    }
    cursor = decision.nextCursor ?? cursor
    await sleep(intervalMs)
  }
  return { works: dedupeWorks(works), listComplete, pages, reason, error, cursor }
}

/** 批量分析（30 天窗口；三接口独立降级，仅 status_code=8 传播）。 */
export interface ItemAnalysisBundle {
  window: { startDate: string; endDate: string }
  performance: Map<string, Record<string, number | null>>
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

export async function collectItemAnalysis(page: DouyinCollectPage, options: { days?: number } = {}): Promise<ItemAnalysisBundle> {
  const days = options.days ?? 30
  const end = new Date()
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000)
  const window = { startDate: yyyymmdd(start), endDate: yyyymmdd(end) }
  const genres = [...ITEM_GENRES]
  const bundle: ItemAnalysisBundle = { window, performance: new Map(), performanceError: null, overview: null, overviewError: null }
  let verticals: unknown[] = []
  try {
    const vertical = await fetchJson(page, { url: `${ITEM_ANALYSIS_BASE}/involved_vertical?start_date=${window.startDate}&end_date=${window.endDate}` })
    if (vertical.ok) {
      const payload = (vertical.json && typeof vertical.json === 'object' ? vertical.json : {}) as Record<string, unknown>
      verticals = Array.isArray(payload.primary_verticals) ? payload.primary_verticals as unknown[] : []
    } else {
      bundle.overviewError = 'overview_failed'
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
  }
  try {
    const performance = await fetchJson(page, {
      url: `${ITEM_ANALYSIS_BASE}/item_performance`,
      body: { start_date: window.startDate, end_date: window.endDate, genres, primary_verticals: verticals, metric_type: 1 },
    })
    if (performance.ok) {
      const payload = (performance.json && typeof performance.json === 'object' ? performance.json : {}) as Record<string, unknown>
      const rows = Array.isArray(payload.item_performance_list) ? payload.item_performance_list as unknown[] : []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        const record = row as Record<string, unknown>
        const id = record.item_id !== undefined && record.item_id !== null ? String(record.item_id) : null
        if (id === null) continue
        bundle.performance.set(id, {
          play_count: toNumber(record.play_count),
          avg_watch_duration_s: round2(record.average_play_duration),
          completion_rate_5s_pct: pct(record.completion_rate_5s),
          bounce_rate_2s_pct: pct(record.bounce_rate_2s),
        })
      }
    } else {
      bundle.performanceError = 'item_performance_failed'
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bundle.performanceError = 'item_performance_failed'
  }
  try {
    const overview = await fetchJson(page, {
      url: `${ITEM_ANALYSIS_BASE}/overview`,
      body: { start_date: window.startDate, end_date: window.endDate, genres, primary_verticals: verticals },
    })
    if (overview.ok) bundle.overview = overview.json
    else bundle.overviewError = 'overview_failed'
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bundle.overviewError = 'overview_failed'
  }
  return bundle
}

/** 详情拦截片段（url.includes 匹配；每 key 只收第一份）。 */
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
  mget: Map<string, Record<string, number | null>>
  summarize: Map<string, SummarizeRow>
  metricsTrend: PlayTrendPoint[] | null
  metricsTrendGap: string | null
  retention: RealtimeTrend | null
  retentionGap: string | null
  bounce: RealtimeTrend | null
  bounceGap: string | null
}

/** 导航到详情页（3 次重试；不重试会雪崩——一次抖动打断后续所有 goto）。 */
async function gotoWorkDetail(page: DouyinCollectPage, workId: string): Promise<void> {
  const url = workDetailUrl(workId)
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      return
    } catch (error) {
      lastError = error
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
      await sleep(500 * 2 ** (attempt - 1))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`goto_failed_${workId}`)
}

/** 点击匹配文本的叶子元素（无子节点的 div/span/button/a/li）。 */
async function clickByText(page: DouyinCollectPage, text: string): Promise<boolean> {
  const candidates = await page.$$('[data-e2e], div, span, button, a, li')
  for (const element of candidates) {
    const content = (await element.textContent().catch(() => null))?.trim() ?? ''
    if (content !== text) continue
    await element.click({ timeout: 2000 }).catch(() => undefined)
    return true
  }
  return false
}

/** 单稿详情采集（拦截优先 + 页面内 fetch 兜底；低播放 10001 记缺口）。 */
export async function collectWorkDetail(page: DouyinCollectPage, options: {
  work: WorkItem
  onTarget?: ((key: string) => void) | undefined
  now?: () => number
}): Promise<WorkDetailBundle> {
  const { work } = options
  const id = work.workId
  const captured: Record<string, unknown> = {}
  const seen: string[] = []
  const listener: DetailListener = response => {
    const url = response.url()
    for (const [key, fragment] of Object.entries(DETAIL_TARGETS)) {
      if (captured[key] !== undefined) continue
      if (!url.includes(fragment)) continue
      seen.push(key)
      options.onTarget?.(key)
      void response.text().then(text => {
        const json = parseJsonPreservingIds(text)
        if (json !== null) captured[key] = json
      }).catch(() => undefined)
      break
    }
  }
  page.on('response', listener)
  const bundle: WorkDetailBundle = {
    endpointsSeen: seen,
    compare: null,
    source: null,
    portrait: null,
    search: null,
    progress: null,
    mget: new Map(),
    summarize: new Map(),
    metricsTrend: null,
    metricsTrendGap: null,
    retention: null,
    retentionGap: null,
    bounce: null,
    bounceGap: null,
  }
  try {
    await gotoWorkDetail(page, id)
    await page.waitForTimeout(3000)
    const clickedTraffic = await clickByText(page, '流量分析')
    const clickedAudience = await clickByText(page, '观众分析')
    if (clickedTraffic || clickedAudience) await page.waitForTimeout(1500)
    await page.waitForTimeout(1500)

    /** 拦截漏取时的同源 fetch 兜底。 */
    const fallback = async (key: string, url: string, target: (json: unknown) => void): Promise<void> => {
      if (captured[key] !== undefined) return
      const outcome = await fetchJson(page, { url })
      if (outcome.ok) {
        target(outcome.json)
        options.onTarget?.(`${key}:fallback`)
      }
    }
    await fallback('compare', `${ITEM_COMPARE_PATH}?item_id=${encodeURIComponent(id)}&selected_metric_count=2`, json => { bundle.compare = parseItemCompare(json) })
    await fallback('source', `${PLAY_SOURCE_PATH}?item_id=${encodeURIComponent(id)}`, json => { bundle.source = parsePlaySource(json) })
    await fallback('progress', `${PROGRESS_PATH}?item_id=${encodeURIComponent(id)}`, json => { bundle.progress = parseProgressAnalysis(json) })
    await fallback('search', `${SEARCH_KEYWORD_PATH}?item_id=${encodeURIComponent(id)}`, json => { bundle.search = parseSearchKeywords(json) })
    await fallback('portrait', `${PORTRAIT_PATH}?item_id=${encodeURIComponent(id)}`, json => { bundle.portrait = parsePortrait(json) })
    await fallback('mget', `${ITEM_MGET_PATH}?ids=${encodeURIComponent(id)}&fields=${ITEM_MGET_FIELDS}`, json => { bundle.mget = parseItemMget(json) })
    await fallback('summarize', `${ITEM_SUMMARIZE_PATH}?item_id=${encodeURIComponent(id)}`, json => { bundle.summarize = parseItemSummarize(json) })

    // compare：拦截结果在兜底未覆盖时解析；10001/10005 记缺口不阻塞。
    if (captured['compare'] !== undefined) bundle.compare = parseItemCompare(captured['compare'])
    if (captured['source'] !== undefined) bundle.source = parsePlaySource(captured['source'])
    if (captured['progress'] !== undefined) bundle.progress = parseProgressAnalysis(captured['progress'])
    if (captured['search'] !== undefined) bundle.search = parseSearchKeywords(captured['search'])
    if (captured['portrait'] !== undefined) bundle.portrait = parsePortrait(captured['portrait'])
    if (captured['mget'] !== undefined) bundle.mget = parseItemMget(captured['mget'])
    if (captured['summarize'] !== undefined) bundle.summarize = parseItemSummarize(captured['summarize'])

    // metrics_trend 直取（详情页自发的「新增/每小时」口径不可用，1026 方案）。
    try {
      const trend = await fetchJson(page, { url: `${ITEM_METRICS_TREND_PATH}?item_id=${encodeURIComponent(id)}&trend_type=2&time_unit=1&metrics_group=0%2C1%2C3&metrics=view_count` })
      if (!trend.ok) bundle.metricsTrendGap = 'request_failed'
      else {
        bundle.metricsTrend = parseItemMetricsTrend(trend.json, shanghaiTodayIso(options.now))
        if (bundle.metricsTrend === null) bundle.metricsTrendGap = 'not_exposed'
      }
    } catch (error) {
      if (error instanceof SessionInvalidError) throw error
      bundle.metricsTrendGap = 'request_failed'
    }
    // 留存 / 跳出（1104 方案）。
    for (const [analysisType, field] of [[1, 'retention'] as const, [7, 'bounce'] as const] as const) {
      try {
        const outcome = await fetchJson(page, { url: `${RETENTION_PATH}?item_id=${encodeURIComponent(id)}&analysis_type=${String(analysisType)}` })
        if (!outcome.ok) {
          bundle[field === 'retention' ? 'retentionGap' : 'bounceGap'] = 'request_failed'
        } else {
          const trend = parseRealtimeTrend(outcome.json)
          if (field === 'retention') bundle.retention = trend
          else bundle.bounce = trend
          if (trend === null) bundle[field === 'retention' ? 'retentionGap' : 'bounceGap'] = 'not_exposed'
        }
      } catch (error) {
        if (error instanceof SessionInvalidError) throw error
        bundle[field === 'retention' ? 'retentionGap' : 'bounceGap'] = 'request_failed'
      }
    }
    return bundle
  } finally {
    page.off('response', listener)
  }
}

/** 热词三态（unavailable 服务端保留旧集合；ok 空数组=有效清空）。 */
export async function collectHotword(page: DouyinCollectPage, workId: string): Promise<HotwordResult> {
  try {
    const outcome = await fetchJson(page, { url: `${WORD_CLOUD_PATH}?item_id=${encodeURIComponent(workId)}&mcn_type=0` })
    if (!outcome.ok) return { status: 'unavailable', statusCode: null, words: [], error: outcome.error ?? 'request_failed' }
    return parseWordCloud(outcome.json)
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    return { status: 'unavailable', statusCode: null, words: [], error: 'request_failed' }
  }
}

/** 账号资料（会话判定第二处；accountId 缺失返回 null）。 */
export async function collectAccountProfile(page: DouyinCollectPage): Promise<DouyinProfile | null> {
  const outcome = await collectorPageProbe(page)
  return outcome
}

/** collector 内部用的资料读取（复用 session 的同源 user/info 投影）。 */
async function collectorPageProbe(page: DouyinCollectPage): Promise<DouyinProfile | null> {
  const outcome = await evaluateJsonFetch(page, { url: CREATOR_ORIGIN.replace(/\/$/u, '') + USER_INFO_PATH })
  if (outcome.status !== 200) return null
  const json = parseJsonPreservingIds(outcome.text)
  if (json === null) {
    if (isSessionExpiredPayload(json)) throw new SessionInvalidError(8)
    return null
  }
  if (isSessionExpiredPayload(json)) throw new SessionInvalidError(8)
  const payload = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  const user = (payload.user ?? payload.data ?? payload) as Record<string, unknown>
  const accountIdRaw = firstPresent(user.sec_uid, user.uid, user.user_id)
  const accountId = accountIdRaw === undefined ? null : String(accountIdRaw).trim()
  if (accountId === null || accountId === '') return null
  return {
    accountId,
    nickname: clampText(firstPresent(user.nickname, user.name, user.nick_name), 128),
    avatar: firstUrl(firstPresent(user.avatar_uri, user.avatar_url, user.avatarUrl, user.avatar)),
    fanCount: toNumber(firstPresent(user.follower_count, user.fans_count)),
  }
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

/** 账号大盘三连（dashboard / dashboard_fans / fans_summary）。 */
export async function collectDashboard(page: DouyinCollectPage, options: { recentDays?: number } = {}): Promise<DashboardBundle> {
  const recentDays = options.recentDays ?? DASHBOARD_RECENT_DAYS
  const todayIso = shanghaiTodayIso()
  const bundle: DashboardBundle = { dashboardRows: [], dashboardFansRows: [], fansProfile: null, gaps: [] }
  const load = async (source: 'dashboard' | 'dashboard_fans' | 'fans_profile', url: string): Promise<unknown | null> => {
    const outcome = await fetchJson(page, { url })
    if (!outcome.ok) {
      bundle.gaps.push({ source, reason: outcome.status > 0 ? `http_${String(outcome.status)}` : 'request_failed' })
      return null
    }
    if (isSessionExpiredPayload(outcome.json)) throw new SessionInvalidError(8)
    return outcome.json
  }
  try {
    const dashboard = await load('dashboard', `${DASHBOARD_PATH}?recent_days=${String(recentDays)}`)
    if (dashboard !== null) {
      bundle.dashboardRows = dropFutureRows(parseDashboardMetrics(dashboard), todayIso)
      if (bundle.dashboardRows.length === 0) bundle.gaps.push({ source: 'dashboard', reason: 'not_exposed' })
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bundle.gaps.push({ source: 'dashboard', reason: 'parse_failed' })
  }
  try {
    const fans = await load('dashboard_fans', `${DASHBOARD_FANS_PATH}?recent_days=${String(recentDays)}`)
    if (fans !== null) {
      bundle.dashboardFansRows = dropFutureRows(parseDashboardMetrics(fans), todayIso)
      if (bundle.dashboardFansRows.length === 0) bundle.gaps.push({ source: 'dashboard_fans', reason: 'not_exposed' })
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bundle.gaps.push({ source: 'dashboard_fans', reason: 'parse_failed' })
  }
  try {
    const profile = await load('fans_profile', FANS_SUMMARY_PATH)
    if (profile !== null) {
      bundle.fansProfile = parseFansSummary(profile)
      if (bundle.fansProfile === null) bundle.gaps.push({ source: 'fans_profile', reason: 'not_exposed' })
    }
  } catch (error) {
    if (error instanceof SessionInvalidError) throw error
    bundle.gaps.push({ source: 'fans_profile', reason: 'parse_failed' })
  }
  return bundle
}

/** collectAccountWorks 的产物。 */
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
 * 资料 → 批量分析 → 逐稿详情+热词+合并 → 大盘三连）。会话失效在各阶段抛
 * SessionInvalidError 并挂 partialCollected（已完成的载荷带范围声明保留）。
 */
export async function collectAccountWorksOn(surface: DouyinCollectPage, options: {
  maxPages?: number
  days?: number
  onProgress?: ((info: Record<string, unknown>) => void) | undefined
  now?: () => number
} = {}): Promise<AccountWorksResult> {
  const now = options.now ?? Date.now
  const observedAt = new Date(now()).toISOString()
  await surface.goto(WORK_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const list = await collectWorkList(surface, {
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    onPage: event => options.onProgress?.({ phase: 'list_page', ...event }),
  })
  const scoped = filterWorksByPublishSince(list.works)
  const publishTimeMissing = scoped.publishTimeMissing
  let listComplete = list.listComplete
  let listReason = list.reason
  if (publishTimeMissing > 0) {
    listComplete = false
    listReason = listReason ?? 'publish_time_missing'
  }
  const expectedWorkCount = scoped.works.length
  if (expectedWorkCount > MAX_EXPECTED_WORK_COUNT) throw new Error('expected_work_count_out_of_range')
  /** 各阶段会话失效的部分成果（带范围声明）。 */
  const partial = (works: Record<string, unknown>[]): PartialCollected => ({
    works,
    listComplete: false,
    expectedWorkCount,
    publishSince: WORK_PUBLISH_SINCE_REPORT,
  })
  let profile: DouyinProfile | null
  try {
    profile = await collectAccountProfile(surface)
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      error.partialCollected = partial([])
      throw error
    }
    profile = null
  }
  let itemAnalysis: ItemAnalysisBundle | null = null
  try {
    itemAnalysis = await collectItemAnalysis(surface, { ...(options.days !== undefined ? { days: options.days } : {}) })
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      error.partialCollected = partial([])
      throw error
    }
    itemAnalysis = null
  }
  const works: WorkPayload[] = []
  const failures: { workId: string; reason: string }[] = []
  for (let index = 0; index < scoped.works.length; index += 1) {
    const work = scoped.works[index]
    if (work === undefined) continue
    options.onProgress?.({ phase: 'work', workId: work.workId, index: index + 1, total: scoped.works.length })
    try {
      const detail = await collectWorkDetail(surface, { work, now })
      const hotword = await collectHotword(surface, work.workId)
      works.push(buildWorkPayload({
        work,
        performance: itemAnalysis?.performance ?? new Map(),
        compare: detail.compare,
        compareGap: detail.compare?.gapReason ?? null,
        source: detail.source,
        portrait: detail.portrait,
        search: detail.search,
        progress: detail.progress,
        retention: detail.retention,
        retentionGap: detail.retentionGap,
        bounce: detail.bounce,
        bounceGap: detail.bounceGap,
        mget: detail.mget,
        summarize: detail.summarize,
        hotword,
        metricsTrend: detail.metricsTrend,
        metricsTrendGap: detail.metricsTrendGap,
        observedAt,
      }))
    } catch (error) {
      if (error instanceof SessionInvalidError) {
        error.partialCollected = partial(works)
        throw error
      }
      failures.push({ workId: work.workId, reason: safeParseReason(error) })
    }
  }
  let dashboard: DashboardBundle
  try {
    dashboard = await collectDashboard(surface)
  } catch (error) {
    if (error instanceof SessionInvalidError) {
      error.partialCollected = partial(works)
      throw error
    }
    dashboard = { dashboardRows: [], dashboardFansRows: [], fansProfile: null, gaps: [{ source: 'dashboard', reason: safeParseReason(error) }] }
  }
  return {
    works,
    failures,
    pages: list.pages,
    listComplete,
    listReason,
    expectedWorkCount,
    publishSince: WORK_PUBLISH_SINCE_REPORT,
    skippedBeforePublishSince: scoped.skippedBeforePublishSince,
    publishTimeMissing,
    profile,
    dashboard,
    itemAnalysis,
  }
}

/** 稳定 parse 原因（error.code 或 name 前 64 字符）。 */
export function safeParseReason(error: unknown): string {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && code !== '') return code.slice(0, 64)
  const name = error instanceof Error ? error.name : 'parse_failed'
  return name.slice(0, 64)
}

export { resolveClientStatus, pct, round2, toInt, clampText, firstUrl }
