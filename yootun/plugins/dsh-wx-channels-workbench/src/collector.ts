/**
 * 视频号助手采集引擎（移植旧 collector.js 全语义）：所有接口都在页面上下文
 * 通过同源 fetch 调用（浏览器自动携带登录态）；作品列表自 COLLECT_SINCE_DAY 起、
 * totalCount+objectId 去重完整性；单作品详情串行、180 天块；账号级三接口失败
 * 只记段落缺口；批次切分 20/3000/2300。
 * @module
 */
import type { DailyMetricRow, DailySeries, FansPortrait, FansTrend } from './parse.ts'
import { commonRequestFields, latestCompletedDay, parseAuthData, parseDailySeries, parseFansPortrait, parseFansTrend, parseFeedLostRate, parseJsonPreservingIds, parsePostListPage, SessionInvalidError, shanghaiDayFromTs, shanghaiDayStartTs, type WorkItem } from './parse.ts'

export const ASSISTANT_ORIGIN = 'https://channels.weixin.qq.com/'
export const AUTH_DATA_PATH = '/cgi-bin/mmfinderassistant-bin/auth/auth_data'
export const POST_LIST_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/post_list'
export const FEED_AGGREGATE_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/feed_aggreagate_data_by_tab_type'
export const FEED_LOST_RATE_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/get_feed_lost_rate'
export const NEW_POST_TOTAL_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/new_post_total_data'
export const FANS_TREND_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/fans_trend'
export const FANS_PORTRAIT_PATH = '/micro/statistic/cgi-bin/mmfinderassistant-bin/statistic/fans_portrait'

/** 采集起点（产品口径 2026-11-12 拍板）：作品列表与 fans_trend 均自该日起。 */
export const COLLECT_SINCE_DAY = '2026-01-01'
export const PAGE_SIZE = 100
export const MAX_PAGES = 50
export const PAGE_INTERVAL_MS = 600
export const DETAIL_INTERVAL_MS = 300
/** 单作品按日序列拆分窗口（§15.1.2.4）：老作品序列 >2300 行时按 180 天拆分。 */
export const DETAIL_BLOCK_DAYS = 180
/** 批次上限（§15.1.2）：works ≤20、sum(dailyMetrics) ≤3000、单作品 ≤2300 行。 */
export const MAX_BATCH_WORKS = 20
export const MAX_BATCH_DAILY_ROWS = 3000
export const MAX_SINGLE_WORK_DAILY_ROWS = 2300

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Minimal page surface the collector needs (Playwright Page subset). */
export interface CollectorPage {
  evaluate<R>(fn: (arg: { url: string; body: Record<string, unknown> }) => Promise<R>, arg: { url: string; body: Record<string, unknown> }): Promise<R>
}

/** 页面上下文同源 POST fetch（浏览器自动携带登录态与签名）。 */
export async function postJson(page: CollectorPage, url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; json: unknown }> {
  const raw = await page.evaluate(async (request: { url: string; body: Record<string, unknown> }) => {
    try {
      const response = await fetch(request.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request.body),
      })
      return { status: response.status, text: await response.text() }
    } catch (error) {
      return { status: 0, text: '', error: String(error && typeof error === 'object' && 'message' in error ? error.message : error) }
    }
  }, { url, body } as never)
  // 官方 CGI 成功语义含 200/201（auth_data 实测 201）。
  const record = raw && typeof raw === 'object' ? raw as { status?: number; text?: string } : null
  if (!record || (record.status !== 200 && record.status !== 201)) {
    return { ok: false, status: record?.status ?? 0, json: null }
  }
  const json = parseJsonPreservingIds(record.text ?? '')
  return { ok: json !== null, status: 200, json }
}

/** auth_data 探活并读取账号资料（finderId 空串用于登录后首次读取）。 */
export async function fetchAuthData(page: CollectorPage, finderId = '', now: () => number = Date.now): Promise<ReturnType<typeof parseAuthData>> {
  const body = commonRequestFields(finderId, now)
  const result = await postJson(page, AUTH_DATA_PATH, body)
  if (!result.ok) {
    if (result.status === 200) throw new SessionInvalidError('auth_data_invalid_json')
    throw new Error(`auth_data_http_${String(result.status)}`)
  }
  return parseAuthData(result.json)
}

/** collectWorkList 的结果（§5.3 完整性规则）。 */
export interface WorkListResult {
  works: WorkItem[]
  totalCount: number | null
  listComplete: boolean
  reason: string | null
  endDay: string
}

/**
 * 窗口内作品列表采集：窗口起点固定 COLLECT_SINCE_DAY（totalCount 为窗口内计数，
 * 完整性判据/结算语义不变）；totalCount + objectId 去重；超页防御；某页失败
 * 列表不完整，绝不按空列表结算。
 */
export async function collectWorkList(page: CollectorPage, options: {
  finderId: string
  pageSize?: number
  startDay?: string
  maxPages?: number
  intervalMs?: number
  retries?: number
  onPage?: ((event: { pageNumber: number; rawCount: number; added: number; collected: number }) => void) | undefined
  now?: () => number
  sleep?: ((ms: number) => Promise<void>) | undefined
}): Promise<WorkListResult> {
  const pageSize = options.pageSize ?? PAGE_SIZE
  const startDay = options.startDay ?? COLLECT_SINCE_DAY
  const maxPages = options.maxPages ?? MAX_PAGES
  const intervalMs = options.intervalMs ?? PAGE_INTERVAL_MS
  const retries = options.retries ?? 2
  const sleepImpl = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const endDay = latestCompletedDay(now)
  const endTs = shanghaiDayStartTs(endDay)
  const startTs = shanghaiDayStartTs(startDay)
  const collected: WorkItem[] = []
  const seen = new Set<string>()
  let totalCount: number | null = null
  let listComplete = false
  let reason: string | null = null
  let stalePage = false

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const body = {
      pageSize,
      currentPage: pageNumber,
      sort: 0,
      order: 0,
      startTime: startTs,
      endTime: endTs,
      ...commonRequestFields(options.finderId, now),
    }
    let result: { ok: boolean; status: number; json: unknown } | null = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      result = await postJson(page, POST_LIST_PATH, body)
      if (result.ok) break
      if (attempt < retries) await sleepImpl(Math.min(8000, 1000 * 2 ** attempt))
    }
    if (!result || !result.ok) {
      reason = result && result.status ? `page_http_${String(result.status)}` : 'page_request_failed'
      break
    }
    let parsed
    try {
      parsed = parsePostListPage(result.json)
    } catch (error) {
      if (error instanceof SessionInvalidError && collected.length) {
        (error as SessionInvalidError & { partialListWorks?: WorkItem[] }).partialListWorks = collected
      }
      throw error
    }
    if (totalCount === null) totalCount = parsed.totalCount
    // 超页防御：某页没有新增 objectId 时停止，不以「非空页」续翻。
    let added = 0
    for (const work of parsed.works) {
      if (seen.has(work.workId)) continue
      seen.add(work.workId)
      collected.push(work)
      added += 1
    }
    if (added === 0) {
      stalePage = true
      break
    }
    options.onPage?.({ pageNumber, rawCount: parsed.rawCount, added, collected: collected.length })
    if (totalCount !== null && collected.length >= totalCount) break
    // 官方短页不代表列表结束（totalCount 驱动续翻）；仅 totalCount 不可得时以短页兜底。
    if (totalCount === null && parsed.rawCount < pageSize) break
    if (pageNumber < maxPages) await sleepImpl(intervalMs)
  }

  if ((!stalePage && reason === null || stalePage) && totalCount !== null && collected.length >= totalCount) {
    listComplete = true
  } else if (reason === null) {
    reason = 'LIST_INCOMPLETE'
  }
  return { works: collected, totalCount, listComplete, reason, endDay }
}

/** 单作品详情：留存 + 按日聚合（发布日零点起；老作品按 180 天块拆分）。 */
export async function collectWorkDetail(page: CollectorPage, options: {
  finderId: string
  work: WorkItem
  retries?: number
  intervalMs?: number
  now?: () => number
  sleep?: ((ms: number) => Promise<void>) | undefined
}): Promise<{
  retentionTrend: ReturnType<typeof parseFeedLostRate>
  dailyMetrics: DailyMetricRow[]
  trafficSource: DailySeries['trafficSource'] | null
}> {
  const retries = options.retries ?? 1
  const intervalMs = options.intervalMs ?? DETAIL_INTERVAL_MS
  const sleepImpl = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const work = options.work
  const endDay = latestCompletedDay(now)
  const endTs = shanghaiDayStartTs(endDay)
  // startTs 必须用发布日零点（上海语义日；publishTime 是 UTC ISO，slice 会早一天）。
  const publishDayIso = work.publishTime
    ? shanghaiDayFromTs(Math.floor(new Date(work.publishTime).getTime() / 1000))
    : null
  const fallbackStart = shanghaiDayStartTs(endDay) - (DETAIL_BLOCK_DAYS - 1) * 86400
  const startTs = publishDayIso ? shanghaiDayStartTs(publishDayIso) : fallbackStart

  const totalDays = Math.floor((endTs - startTs) / 86400) + 1
  const blocks: Array<{ startTs: number; endTs: number }> = []
  if (totalDays <= DETAIL_BLOCK_DAYS) {
    blocks.push({ startTs, endTs })
  } else {
    let cursor = startTs
    while (cursor <= endTs) {
      const blockEnd = Math.min(cursor + (DETAIL_BLOCK_DAYS - 1) * 86400, endTs)
      blocks.push({ startTs: cursor, endTs: blockEnd })
      cursor = blockEnd + 86400
    }
  }

  const lostRate = await withRetry(() => postJson(page, FEED_LOST_RATE_PATH, {
    feedId: work.workId,
    ...commonRequestFields(options.finderId, now),
  }), retries, sleepImpl)
  const retention = lostRate.ok ? parseFeedLostRate(lostRate.json) : null

  const dailyMetrics: DailyMetricRow[] = []
  const blockSources: Array<DailySeries['trafficSource']> = []
  for (const block of blocks) {
    const result = await withRetry(() => postJson(page, FEED_AGGREGATE_PATH, {
      startTs: String(block.startTs),
      endTs: String(block.endTs),
      interval: 3,
      feedId: work.workId,
      ...commonRequestFields(options.finderId, now),
    }), retries, sleepImpl)
    if (!result.ok) {
      throw new Error(result.status ? `aggregate_http_${String(result.status)}` : 'aggregate_request_failed')
    }
    const parsed = parseDailySeries(result.json, block.startTs, block.endTs)
    dailyMetrics.push(...parsed.rows)
    blockSources.push(parsed.trafficSource)
    await sleepImpl(intervalMs)
  }
  // 作品级来源分布：单块直接用；多块按 sourceKey 合并 playCount 求和。
  let trafficSource: DailySeries['trafficSource'] | null = null
  if (blockSources.length === 1) {
    trafficSource = blockSources[0] ?? null
  } else if (blockSources.length > 1) {
    const merged = new Map<string, { sourceType: number; sourceKey: string; name: string; playCount: number }>()
    for (const source of blockSources) {
      for (const row of source?.rows ?? []) {
        const existing = merged.get(row.sourceKey)
        if (existing) existing.playCount += row.playCount
        else merged.set(row.sourceKey, { ...row })
      }
    }
    if (merged.size) {
      trafficSource = {
        window: { startDay: publishDayIso ?? shanghaiDayFromTs(startTs), endDay },
        rows: [...merged.values()],
      }
    }
  }
  // 日行级来源只挂最后一块的最后一行（避免约 315 行重复大 JSON）。
  if (dailyMetrics.length && blockSources.length) {
    const last = blockSources[blockSources.length - 1]
    const lastRow = dailyMetrics[dailyMetrics.length - 1]
    if (last !== undefined && lastRow !== undefined) lastRow.trafficSource = last
  }
  return { retentionTrend: retention, dailyMetrics, trafficSource }
}

/** 账号级全部视频聚合（初始回填按 180 天分块；日常至少近 30 天+昨日环比）。 */
export async function collectAccountMetrics(page: CollectorPage, options: {
  finderId: string
  startDay?: string | null
  endDay?: string | null
  retries?: number
  now?: () => number
  sleep?: ((ms: number) => Promise<void>) | undefined
}): Promise<{ startDay: string; endDay: string } & DailySeries> {
  const retries = options.retries ?? 1
  const sleepImpl = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const resolvedEnd = options.endDay ?? latestCompletedDay(now)
  const resolvedStart = options.startDay ?? dayOffset(resolvedEnd, -29)
  const startTs = shanghaiDayStartTs(resolvedStart)
  const endTs = shanghaiDayStartTs(resolvedEnd)
  const result = await withRetry(() => postJson(page, NEW_POST_TOTAL_PATH, {
    startTs: String(startTs),
    endTs: String(endTs),
    interval: 3,
    ...commonRequestFields(options.finderId, now),
  }), retries, sleepImpl)
  if (!result.ok) {
    throw new Error(result.status ? `account_metrics_http_${String(result.status)}` : 'account_metrics_request_failed')
  }
  const parsed = parseDailySeries(result.json, startTs, endTs)
  return { startDay: resolvedStart, endDay: resolvedEnd, ...parsed }
}

/** 账号级关注者增长（自 COLLECT_SINCE_DAY 起回填；超长窗口由调用方分块）。 */
export async function collectFansTrend(page: CollectorPage, options: {
  finderId: string
  startDay: string
  endDay: string
  retries?: number
  now?: () => number
  sleep?: ((ms: number) => Promise<void>) | undefined
}): Promise<{ startDay: string; endDay: string } & FansTrend> {
  const retries = options.retries ?? 1
  const sleepImpl = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const startTs = shanghaiDayStartTs(options.startDay)
  const endTs = shanghaiDayStartTs(options.endDay)
  const result = await withRetry(() => postJson(page, FANS_TREND_PATH, {
    startTs: String(startTs),
    endTs: String(endTs),
    interval: 3,
    ...commonRequestFields(options.finderId, now),
  }), retries, sleepImpl)
  if (!result.ok) {
    throw new Error(result.status ? `fans_trend_http_${String(result.status)}` : 'fans_trend_request_failed')
  }
  const parsed = parseFansTrend(result.json, startTs, endTs)
  return { startDay: options.startDay, endDay: options.endDay, ...parsed }
}

/**
 * fans_trend 回填窗口分块计划（闭区间、相邻块不重叠；全程上海语义日字符串推算）。
 * @returns the block plan ([] when start > end).
 */
export function planFansTrendWindow(options: {
  startDay?: string
  endDay: string
  blockDays?: number
  maxBlocks?: number
}): Array<{ startDay: string; endDay: string }> {
  const startDay = options.startDay ?? COLLECT_SINCE_DAY
  const endDay = options.endDay
  const blockDays = options.blockDays ?? DETAIL_BLOCK_DAYS
  const maxBlocks = options.maxBlocks ?? 200
  if (startDay > endDay) return []
  const blocks: Array<{ startDay: string; endDay: string }> = []
  let cursorDay = startDay
  let guard = 0
  while (cursorDay <= endDay) {
    guard += 1
    if (guard > maxBlocks) throw new Error('fans_trend_window_loop_guard')
    const blockEndTs = Math.min(
      shanghaiDayStartTs(cursorDay) + (blockDays - 1) * 86400,
      shanghaiDayStartTs(endDay),
    )
    const blockEnd = shanghaiDayFromTs(blockEndTs)
    blocks.push({ startDay: cursorDay, endDay: blockEnd })
    if (blockEnd >= endDay) break
    cursorDay = shanghaiDayFromTs(blockEndTs + 86400)
  }
  return blocks
}

/** 账号级关注者画像（当前时点快照，day=latestCompletedDay）。 */
export async function collectFansPortrait(page: CollectorPage, options: {
  finderId: string
  retries?: number
  now?: () => number
  sleep?: ((ms: number) => Promise<void>) | undefined
}): Promise<{ day: string } & FansPortrait> {
  const retries = options.retries ?? 1
  const sleepImpl = options.sleep ?? sleep
  const now = options.now ?? Date.now
  const result = await withRetry(() => postJson(page, FANS_PORTRAIT_PATH, commonRequestFields(options.finderId, now)), retries, sleepImpl)
  if (!result.ok) {
    throw new Error(result.status ? `fans_portrait_http_${String(result.status)}` : 'fans_portrait_request_failed')
  }
  const parsed = parseFansPortrait(result.json)
  return { day: latestCompletedDay(now), ...parsed }
}

/** 按上限切分作品批次：发布日旧→新、贪心装填、批次号连续递增、超长防御再拆。 */
export function splitIngestBatches(works: Array<WorkItem & { dailyMetrics?: unknown[] }>, options: {
  maxWorks?: number
  maxRows?: number
  maxSingle?: number
} = {}): Array<{ batchNo: number; works: Array<WorkItem & { dailyMetrics?: unknown[] }>; totalDailyMetricRows: number }> {
  const maxWorks = options.maxWorks ?? MAX_BATCH_WORKS
  const maxRows = options.maxRows ?? MAX_BATCH_DAILY_ROWS
  const maxSingle = options.maxSingle ?? MAX_SINGLE_WORK_DAILY_ROWS
  // 比较器满足反对称性（相等返回 0），排序稳定（P3-25）。
  const sorted = [...works].sort((a, b) => {
    const av = a.publishTime ?? ''
    const bv = b.publishTime ?? ''
    return av < bv ? -1 : av > bv ? 1 : 0
  })
  const batches: Array<{ batchNo: number; works: Array<WorkItem & { dailyMetrics?: unknown[] }>; totalDailyMetricRows: number }> = []
  let current: Array<WorkItem & { dailyMetrics?: unknown[] }> = []
  let currentRows = 0
  let batchNo = 0
  const flush = (): void => {
    if (!current.length) return
    batchNo += 1
    batches.push({ batchNo, works: current, totalDailyMetricRows: currentRows })
    current = []
    currentRows = 0
  }
  for (const work of sorted) {
    let daily = Array.isArray(work.dailyMetrics) ? work.dailyMetrics : []
    // 防御性再拆：超单作品上限的序列按块对半递拆。
    while (daily.length > maxSingle) {
      const head = daily.slice(0, maxSingle)
      daily = daily.slice(maxSingle)
      flush()
      batchNo += 1
      batches.push({ batchNo, works: [{ ...work, dailyMetrics: head }], totalDailyMetricRows: head.length })
    }
    const workPayload = { ...work, dailyMetrics: daily }
    const rows = daily.length
    if (current.length >= maxWorks || (currentRows + rows > maxRows && current.length)) flush()
    current.push(workPayload)
    currentRows += rows
  }
  flush()
  return batches
}

async function withRetry<T extends { ok: boolean }>(operation: () => Promise<T>, retries: number, sleepImpl: (ms: number) => Promise<void>): Promise<T> {
  let lastError: T | null = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await operation()
    if (result && result.ok) return result
    lastError = result
    if (attempt < retries) await sleepImpl(Math.min(4000, 800 * 2 ** attempt))
  }
  return lastError as T
}

function dayOffset(dayIso: string, offset: number): string {
  const ms = Date.parse(`${dayIso}T00:00:00+08:00`) + offset * 86400_000
  return new Date(ms).toISOString().slice(0, 10)
}

export type { WorkItem, DailyMetricRow, DailySeries, FansPortrait, FansTrend }
