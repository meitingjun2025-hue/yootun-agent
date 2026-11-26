/**
 * 单账号采集编排（移植旧 runner.js 全语义 + 取消支持）：会话探测（本地实测
 * 优先）→ 远端账号自愈 → 无头系统 Chrome + storage_state → 身份复核（读不到
 * 即中止，串号防线）→ 列表（2026-01-01 起）→ 逐作品串行详情 → 账号级三接口 →
 * 入库编排 → markSessionOk；SessionInvalid 走过期收尾保留已采集数据。
 * @module
 */
import type { CollectorPage, WorkItem } from './collector.ts'
import { ASSISTANT_ORIGIN, collectAccountMetrics, collectFansPortrait, collectFansTrend, collectWorkDetail, collectWorkList, fetchAuthData, planFansTrendWindow } from './collector.ts'
import { safeCode, WxError } from './errors.ts'
import { createIngestClient, ingestCollectedData, resolveClientStatus } from './ingest.ts'
import type { WxWorkbenchFace } from './ingest.ts'
import { SessionInvalidError, shanghaiDayFromTs } from './parse.ts'
import { getAccount, hasStorageState, paths, stateRoot } from './state.ts'
import type { ProfileLocks } from '@yootun/dsh-workbench-host-kit'
import { createAttemptId, updateRun, type RunRecord } from './runs.ts'
import type { TaskRegistry } from './lifecycle.ts'
import { DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS, browserCloseTimeoutMessage, closeContext, launchWithTimeout } from './chrome.ts'
import { asCollectorPage, launchChrome, refreshSessionState, type ChromeFactory } from './session.ts'
import { markSessionExpired, markSessionOk, reportSessionStatus } from './probe.ts'
import { accountSaveIdempotencyKey } from './idempotency.ts'

export const DEFAULT_MAX_PAGES = 50
const OPEN_TIMEOUT_MS = 60_000
const IDENTITY_CHECK_ATTEMPTS = 3
const IDENTITY_CHECK_INTERVAL_MS = 800

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 批量 skipped 的合法原因（§8.5）；其余一律归 session_required。 */
export const BATCH_SKIP_REASONS = new Set([
  'session_required', 'storage_state_missing', 'pending_account', 'probe_failed', 'collect_busy',
  'no_session_cookie', 'auth_data_unavailable', 'account_mismatch',
])

/** 采集资格检查：本地记录存在、非 pending、storage_state 存在、当前无其他采集。 */
export async function checkCollectionReadiness(options: { accountId: string; root: string; busy?: boolean }): Promise<{ ready: boolean; reason: string | null }> {
  const record = await getAccount(options.accountId, options.root).catch(() => undefined)
  if (record === undefined) return { ready: false, reason: 'session_required' }
  if (String(options.accountId).startsWith('pending-')) return { ready: false, reason: 'pending_account' }
  if (!(await hasStorageState(options.accountId, options.root))) return { ready: false, reason: 'storage_state_missing' }
  if (options.busy === true) return { ready: false, reason: 'collect_busy' }
  return { ready: true, reason: null }
}

/** 远端账号自愈：登录期 account_save 可能失败；幂等 upsert，失败不阻断。 */
export async function ensureRemoteAccount(workbench: WxWorkbenchFace, accountId: string, options: { root: string; onProgress?: ((event: Record<string, unknown>) => void) | undefined }): Promise<{ ok: boolean; error: string | null }> {
  options.onProgress?.({ phase: 'account_sync' })
  try {
    const record = await getAccount(accountId, options.root).catch(() => undefined)
    const payload: Record<string, unknown> = {
      accountId,
      sessionRef: paths(options.root).vaultRef(accountId),
      idempotencyKey: accountSaveIdempotencyKey(accountId),
    }
    const nickname = record?.nickname
    if (nickname !== undefined && nickname !== null) payload.nickname = nickname
    const avatar = record?.avatar
    if (avatar !== undefined && avatar !== null) payload.avatar = avatar
    await workbench.callTool('wx-workbench', 'wx', 'workbench_wx_account_save', payload)
    return { ok: true, error: null }
  } catch (error) {
    options.onProgress?.({ phase: 'account_sync_failed', reason: safeCode(error) })
    return { ok: false, error: safeCode(error) }
  }
}

/** 采集前身份复核：auth_data 读不到/不一致即中止（串号防线，绝不放行）。 */
async function verifyCollectorIdentity(page: CollectorPage, accountId: string): Promise<string> {
  let lastReason = 'auth_data_unavailable'
  for (let attempt = 0; attempt < IDENTITY_CHECK_ATTEMPTS; attempt += 1) {
    try {
      const profile = await fetchAuthData(page)
      if (profile.accountId !== accountId) throw new SessionInvalidError('account_mismatch')
      return profile.accountId
    } catch (error) {
      if (error instanceof SessionInvalidError && error.reason === 'account_mismatch') throw error
      lastReason = safeCode(error)
      await sleep(IDENTITY_CHECK_INTERVAL_MS)
    }
  }
  throw new SessionInvalidError(lastReason)
}

/** runCollection 结果。 */
export interface CollectResult {
  status: string
  runId: string | null
  reason?: string | null
  works?: number
  finish?: Record<string, unknown> | null
}

/** 采集编排注入（workbench face / chrome factory 可注入测试）。 */
export interface RunnerDeps {
  workbench: WxWorkbenchFace
  chromeFactory?: ChromeFactory | undefined
  root: string
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
}

/**
 * 单账号采集全流程：全程持有账号 profile 锁——会话探测、Chrome launch、
 * page.goto、列表/详情/账号级采集与 context.close 都在使用账号 profile，
 * 锁必须覆盖整个使用期（而非仅 Chrome launch），同账号 probe/promote/remove
 * 才不会与采集并发打开或删除 profile。
 *
 * 取消语义：AbortSignal 中止浏览器链路后 run 显式 cancel，已入库批次保留
 * （服务端账本），本地投影 failed/cancelled；abort 后锁随 finally 释放。
 */
export async function runCollection(options: {
  workbench: WxWorkbenchFace
  accountId: string
  root?: string
  attemptId?: string
  chromeFactory?: ChromeFactory | undefined
  maxPages?: number
  newAttempt?: boolean
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  logger?: { warn(message: string): void } | undefined
  signal?: AbortSignal | undefined
  /** 账号 profile 锁实例（采集全程持锁）。 */
  locks: ProfileLocks
  /** 任务登记：runs.json 写盘（runId barrier/进度/终态）纳入 dispose 等待。 */
  taskRegistry?: TaskRegistry | undefined
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
}): Promise<CollectResult> {
  const root = options.root ?? stateRoot()
  // attemptId 是这次采集在 runs.json 的稳定 key：调用方（collect.start）传入
  // 以便内存态与持久化态引用同一条记录；未传入时在此生成。
  const attemptId = options.attemptId ?? createAttemptId(options.accountId)
  return options.locks.withProfileLock(options.accountId, () => runCollectionWithinProfileLock({ ...options, root, attemptId }))
}

/**
 * runCollection 的锁内实现：调用方必须已持有 accountId 的 profile 锁，因此
 * 这里直接调用无锁的 refreshSessionState（不得再经带锁的 probeAndReport，
 * 否则同账号嵌套锁死锁）。runs.json 的唯一写入方：running 记录在启动时创建，
 * progress 随事件合并，六条 return 路径（probe 失败/入库失败/成功/取消/
 * 会话失效/异常）全部落终态。
 */
async function runCollectionWithinProfileLock(options: {
  workbench: WxWorkbenchFace
  accountId: string
  root: string
  attemptId: string
  chromeFactory?: ChromeFactory | undefined
  maxPages?: number
  newAttempt?: boolean
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  logger?: { warn(message: string): void } | undefined
  signal?: AbortSignal | undefined
  taskRegistry?: TaskRegistry | undefined
  browserCloseTimeoutMs?: number | undefined
  launchTimeoutMs?: number | undefined
}): Promise<CollectResult> {
  const root = options.root
  const accountId = options.accountId
  const attemptId = options.attemptId
  const signal = options.signal
  const closeTimeoutMs = options.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS
  const launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  /** runs.json 写盘纳入 dispose 等待（registry 等待层吞 rejection，调用方各自处理）。 */
  const trackWrite = (write: Promise<unknown>): void => { options.taskRegistry?.track(write) }
  const emit = (event: Record<string, unknown>): void => {
    options.onProgress?.(event)
    // 进度落盘（白名单投影；fire-and-forget：updateRun 内部 root 队列串行不丢
    // 写，失败只告警）。run_persist_failed 由终态/runId 失败路径直接 emit，
    // 不再触发落盘（写失败的失败不递归）；runId 落盘走 ingest 的 onRunStart
    // barrier（await），不经此 fire-and-forget 路径。
    if (event.phase === 'run_persist_failed') return
    const progress = progressFromEvent(event)
    if (progress !== null) {
      trackWrite(updateRun(root, accountId, attemptId, { progress }).catch((error: unknown) => {
        options.logger?.warn(`wx runs.json progress update failed (${attemptId}): ${safeCode(error)}`)
      }))
    }
  }
  /** 终态落盘：失败必须可见（warn + run_persist_failed 进度事件），不影响已确定的 run 结果。 */
  const persistFinalRun = async (patch: { runId?: string | null; status: RunRecord['status']; error: string | null }): Promise<void> => {
    const write = updateRun(root, accountId, attemptId, { ...patch, finishedAt: new Date().toISOString() })
    trackWrite(write)
    try {
      await write
    } catch (error) {
      options.logger?.warn(`wx runs.json final state write failed (${attemptId}): ${safeCode(error)}`)
      options.onProgress?.({ phase: 'run_persist_failed', reason: safeCode(error) })
    }
  }
  /**
   * runId 落盘 barrier（ingest onRunStart）：await 返回前 ingest 不会进入
   * publishListMeta/ingest——run_start 后进程崩溃，runs.json 必已含 runId。
   * 写失败 warn + 进度事件可见，采集继续（不把未落盘伪装为成功）。
   */
  const persistRunId = async (runId: string): Promise<void> => {
    const write = updateRun(root, accountId, attemptId, { runId })
    trackWrite(write)
    try {
      await write
    } catch (error) {
      options.logger?.warn(`wx runs.json runId persist failed (${attemptId}): ${safeCode(error)}`)
      options.onProgress?.({ phase: 'run_persist_failed', reason: safeCode(error) })
    }
  }
  let context: import('playwright-core').BrowserContext | null = null
  try {
    // 1) 会话探测（本地实测优先）：远端状态只是展示参考，读不到不阻断。
    emit({ phase: 'probing', accountId: options.accountId })
    let floorSessionSeq = 0
    try {
      const remote = payloadOf(await options.workbench.callTool('wx-workbench', 'wx', 'workbench_wx_account_list', { accountId: options.accountId }))
      const rows = Array.isArray(remote.accounts) ? remote.accounts as Array<Record<string, unknown>> : []
      const row = rows.find(item => item.account_id === options.accountId)
      if (row !== undefined) floorSessionSeq = Number(row.session_seq ?? 0)
    } catch (error: unknown) {
      // 不阻断本地实测。
      void error
    }
    const session = await refreshSessionState({
      accountId: options.accountId,
      root,
      chromeFactory: options.chromeFactory,
      launchTimeoutMs,
      browserCloseTimeoutMs: closeTimeoutMs,
      onBrowserCloseTimeout: message => { options.logger?.warn(message) },
      trackCleanup: promise => { trackWrite(promise) },
    })
    await reportSessionStatus(options.workbench, options.accountId, session)
    if (session.sessionStatus !== 'ok') {
      const reason = session.sessionStatus === 'expired' ? 'session_expired' : 'probe_failed'
      await persistFinalRun({ status: 'failed', error: reason })
      return { status: 'failed', runId: null, reason }
    }

    // 1.5) 远端账号自愈（失败不阻断）。
    await ensureRemoteAccount(options.workbench, options.accountId, { root, onProgress: emit })
    if (signal?.aborted) throw new SessionInvalidError('cancelled')

    // 2) 无头系统 Chrome（独立 Profile + storage_state；外层已持账号 profile 锁，
    //    launch 只是全程临界区的第一段，不再单独包锁）。启动受 launchTimeoutMs
    //    预算；迟到成功的结果立即关闭（promise 登记任务表）。
    const profileDir = paths(root).profileDir(options.accountId)
    const factory = options.chromeFactory ?? launchChrome
    ;({ context } = await launchWithTimeout(() => factory({ headless: true, profileDir }), launchTimeoutMs, result => {
      const cleanup = closeContext(result.context, closeTimeoutMs, () => options.logger?.warn(browserCloseTimeoutMessage(accountId))).catch(() => undefined)
      trackWrite(cleanup)
      return cleanup
    }))
    const page = context.pages()[0] ?? await context.newPage()
    const surface = asCollectorPage(page)
    await page.goto(ASSISTANT_ORIGIN, { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT_MS })
    const finderId = await verifyCollectorIdentity(surface, accountId)
    // 3) 作品列表（finderId=accountId：页面身份已复核）。
    emit({ phase: 'list', accountId: options.accountId })
    let list: Awaited<ReturnType<typeof collectWorkList>>
    try {
      list = await collectWorkList(surface, {
        finderId,
        maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
        onPage: event => emit({ phase: 'list_page', ...event }),
      })
    } catch (error) {
      // 翻页中途会话失效：已采集作品照常入库结算 partial（P2-4）。
      const partial = (error as SessionInvalidError & { partialListWorks?: WorkItem[] }).partialListWorks
      if (error instanceof SessionInvalidError && Array.isArray(partial) && partial.length) {
        emit({ phase: 'list_partial_session_expired', works: partial.length })
        list = { works: partial, totalCount: null, listComplete: false, reason: error.reason || 'session_expired', endDay: '' }
      } else {
        throw error
      }
    }

    // 4) 逐作品串行详情（完全失败的作品本次不入库）。
    const enriched: Array<WorkItem & { dailyMetrics?: unknown[]; retentionTrend?: unknown; trafficSource?: unknown }> = []
    let detailFailed = 0
    for (let index = 0; index < list.works.length; index += 1) {
      if (signal?.aborted) throw new WxError('WX_TOOL_UNAVAILABLE', 'collect_cancelled')
      const base = list.works[index]
      if (base === undefined) continue
      const work: WorkItem & { dailyMetrics?: unknown[] } = { ...base, dailyMetrics: [] }
      try {
        const detail = await collectWorkDetail(surface, { finderId, work })
        work.dailyMetrics = detail.dailyMetrics
        if (detail.retentionTrend !== null) work.retentionTrend = detail.retentionTrend
        if (detail.trafficSource !== null) work.trafficSource = detail.trafficSource
        enriched.push(work)
      } catch (error) {
        detailFailed += 1
        emit({ phase: 'detail_gap', workId: work.workId, reason: safeCode(error) })
      }
      emit({ phase: 'details_progress', done: index + 1, total: list.works.length, detailFailed })
    }
    if (detailFailed) emit({ phase: 'details_failed_summary', detailFailed, ingested: enriched.length })

    // 5) 账号级三接口（失败记段落缺口，不阻断）。
    emit({ phase: 'account_level', accountId: options.accountId })
    const accountLevel: {
      accountMetrics: { startDay: string; endDay: string; rows: Record<string, unknown>[]; trafficSource?: unknown } | null
      fansTrend: { daily: Record<string, unknown>[]; sourceTrend?: unknown } | null
      fansProfile: Record<string, unknown> | null
    } = { accountMetrics: null, fansTrend: null, fansProfile: null }
    try {
      const metrics = await collectAccountMetrics(surface, { finderId })
      accountLevel.accountMetrics = { startDay: metrics.startDay, endDay: metrics.endDay, rows: metrics.rows, trafficSource: metrics.trafficSource }
    } catch (error) {
      emit({ phase: 'segment_gap', segment: 'account_metrics_collect', reason: safeCode(error) })
    }
    try {
      accountLevel.fansTrend = await collectFansTrendWindowed(surface, { finderId })
    } catch (error) {
      emit({ phase: 'segment_gap', segment: 'fans_trend_collect', reason: safeCode(error) })
    }
    try {
      const portrait = await collectFansPortrait(surface, { finderId })
      accountLevel.fansProfile = { ...portrait }
    } catch (error) {
      emit({ phase: 'segment_gap', segment: 'fans_profile_collect', reason: safeCode(error) })
    }

    // 6) 入库编排。
    const client = createIngestClient({ workbench: options.workbench, accountId: options.accountId, root, logger: options.logger })
    const result = await ingestCollectedData({
      client,
      works: enriched,
      listComplete: list.listComplete,
      expectedWorkCount: list.totalCount ?? enriched.length,
      newAttempt: options.newAttempt ?? true,
      // ingest 阶段事件必须经 emit（内存 + runs.json 同步）；直传
      // options.onProgress 会绕过落盘。onRunStart 是 runId 落盘 barrier。
      onProgress: emit,
      onRunStart: persistRunId,
      accountLevel,
      signal,
    })
    if (result.error !== null) {
      await persistFinalRun({ runId: result.runId, status: 'failed', error: result.error })
      return { status: 'failed', runId: result.runId, reason: result.error, works: enriched.length }
    }
    const okState = await markSessionOk({ accountId: options.accountId, root, floorSessionSeq })
    await reportSessionStatus(options.workbench, options.accountId, okState)
    const status = result.finish !== null && (result.finish as { run?: { status?: string } }).run
      ? (result.finish as { run: { status: string } }).run.status
      : resolveClientStatus({
          listComplete: list.listComplete,
          expected: list.totalCount ?? enriched.length,
          ingest: result.ingest ?? { succeededWorkIds: [], failedWorkIds: [] },
        })
    // 终态落盘：await 保证 handler 收尾时已持久；写失败经 warn + 进度事件可见，
    // 不覆盖已成功的采集结果。
    await persistFinalRun({ runId: result.runId, status: status as RunRecord['status'], error: null })
    return { status, runId: result.runId, finish: result.finish, works: enriched.length }
  } catch (error) {
    // 取消：远端补偿 run_cancel 用独立 cleanup signal（不复用已 aborted 的
    // caller signal——P1 connector 会在本地取消导致 tools/call 次数为 0）。
    if (signal?.aborted === true) {
      // 本地 record 里的 runId 是 startRun 持久化的本次远端 run——取消终态必须
      // 带上（restart 后可关联远端）；仅在有值时写入，避免覆盖 run_started 已
      // 落盘的 runId。
      let cancelledRunId: string | null = null
      try {
        const client = createIngestClient({ workbench: options.workbench, accountId: options.accountId, root })
        const record = await getAccount(options.accountId, root).catch(() => undefined)
        if (record?.runId !== undefined && record.runAttemptId !== undefined) {
          cancelledRunId = record.runId
          await client.startRun({ newAttempt: false })
          await client.cancel(undefined)
        }
      } catch (cleanupError: unknown) {
        // best-effort：取消失败不覆盖原始原因（本地仍投影 collect_cancelled）。
        void cleanupError
      }
      await persistFinalRun(cancelledRunId !== null
        ? { runId: cancelledRunId, status: 'cancelled', error: 'collect_cancelled' }
        : { status: 'cancelled', error: 'collect_cancelled' })
      return { status: 'failed', runId: null, reason: 'collect_cancelled' }
    }
    if (error instanceof SessionInvalidError) {
      const expired = await markSessionExpired({ accountId: options.accountId, root, reason: error.reason })
      await reportSessionStatus(options.workbench, options.accountId, expired)
      const reason = error.reason || 'session_expired'
      await persistFinalRun({ status: 'failed', error: reason })
      return { status: 'failed', runId: null, reason }
    }
    options.logger?.warn(`wx collect ${options.accountId}: ${safeCode(error)}`)
    const reason = safeCode(error)
    await persistFinalRun({ status: 'failed', error: reason })
    return { status: 'failed', runId: null, reason }
  } finally {
    if (context !== null) await closeContext(context, closeTimeoutMs, () => options.logger?.warn(browserCloseTimeoutMessage(accountId)))
  }
}

/** fans_trend 回填：自 COLLECT_SINCE_DAY 起按 180 天块串行拉取（上海语义日推算）。 */
export async function collectFansTrendWindowed(page: CollectorPage, options: {
  finderId: string
  startDay?: string | undefined
  now?: (() => number) | undefined
}): Promise<{ daily: Record<string, unknown>[]; sourceTrend?: unknown }> {
  const endDay = shanghaiDayFromTs(Math.floor((options.now ?? Date.now)() / 1000))
  const blocks = planFansTrendWindow({ ...(options.startDay !== undefined ? { startDay: options.startDay } : {}), endDay })
  const daily: Record<string, unknown>[] = []
  let sourceTrend: unknown = null
  for (const block of blocks) {
    const collected = await collectFansTrend(page, { finderId: options.finderId, startDay: block.startDay, endDay: block.endDay })
    daily.push(...collected.daily)
    if (collected.sourceTrend !== null) sourceTrend = collected.sourceTrend
  }
  return { daily, sourceTrend }
}

/** 进度事件 → collect.status 投影（白名单形状）。 */
export function progressFromEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const phase = event.phase
  switch (phase) {
    case 'probing':
    case 'account_sync':
    case 'list':
    case 'account_level':
      return { phase: String(phase) }
    case 'list_page':
      return { phase: 'list_page', page: event.pageNumber, collected: event.collected }
    case 'details_progress':
      return { phase: 'details', done: event.done, total: event.total, detailFailed: event.detailFailed }
    case 'batch_done':
      return { phase: 'ingest', batchNo: event.batchNo, totalBatches: event.totalBatches, succeeded: event.succeeded, failed: event.failed, expected: event.expected }
    case 'run_started':
      return { phase: 'run_started', runId: event.runId }
    case 'finished':
      return { phase: 'finishing' }
    case 'run_persist_failed':
      return { phase: 'run_persist_failed', reason: event.reason }
    default:
      return null
  }
}

function payloadOf(outcome: { structuredContent: unknown }): Record<string, unknown> {
  return outcome.structuredContent && typeof outcome.structuredContent === 'object' && !Array.isArray(outcome.structuredContent)
    ? outcome.structuredContent as Record<string, unknown>
    : {}
}

// ---- 单账号采集控制器（collect.start / 批量阶段 2 共用的进程内状态机）----

/** 单账号采集 run 记录（进程内按账号 Map 维护；页面经 collect.status 投影）。 */
export interface CollectRecord {
  accountId: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  startedAt: string
  finishedAt: string | null
  attemptId: string | null
  progress: Record<string, unknown> | null
  result: { runId: string | null; works: number } | null
  error: string | null
  /** 本次采集的 runCollection promise（wait 直接 await；不进投影）。 */
  task?: Promise<CollectResult>
}

/** 单账号控制器的启动入参。 */
export interface CollectStartInput {
  accountId: string
  /** 透传 runCollection（页面路径显式传布尔；批量内部走缺省 true）。 */
  newAttempt?: boolean
  /**
   * 批量控制器的内部启动：不做前置探测（阶段 1 已实测，runCollection 开头
   * 自带会话刷新），且不受批量互斥钩子拦截；页面发起的采集由 `batchHasRunning`
   * 钩子拒绝（collect_busy）。
   */
  fromBatch?: boolean
  /** 批次级信号：abort 转发到该账号的 AbortController（dispose/cancel 仍走 signals 表）。 */
  signal?: AbortSignal
  /**
   * 页面路径前置探测（同步等待）：就绪检查 + 会话实测上报。探测期间记录
   * progress.phase = 'probing'；不通过 → started:false 与原因，记录落终态。
   */
  probe?: (() => Promise<{ ok: boolean; reason: string | null }>) | undefined
  /** 启动前复查（探测通过后、runCollection 启动前）：返回拒绝 reason 或 null。 */
  beforeLaunch?: (() => string | null) | undefined
}

/** 单账号控制器的注入面（workbench face / chrome factory 可注入测试）。 */
export interface CollectControllerDeps {
  workbench: WxWorkbenchFace
  root: string
  /** 账号 profile 锁实例（采集全程持锁；随 deps 创建）。 */
  locks: ProfileLocks
  chromeFactory?: ChromeFactory | undefined
  logger?: { warn(message: string): void } | undefined
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number | undefined
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number | undefined
}

/** 单账号采集控制器（createCollectController 返回值）。 */
export interface CollectController {
  /** Start (or refuse) one account's collect run; the record stays queryable via `status`. */
  start(input: CollectStartInput): Promise<{ started: boolean; record: CollectRecord | null; reason?: string }>
  /** 该账号最近一条记录（运行中或终态）的投影；无记录为 null。 */
  status(accountId: string): Record<string, unknown> | null
  /** 首个运行中记录的投影；无运行中采集为 null。 */
  running(): Record<string, unknown> | null
  /** 运行中的账号（按启动顺序）。 */
  runningAccountIds(): string[]
  /** 是否有任一账号运行中。 */
  hasRunning(): boolean
  /**
   * 等待该账号的采集任务收敛并返回结果；记录不存在（未启动过）为 null。
   * @param accountId - 目标账号。
   */
  wait(accountId: string): Promise<CollectResult | null>
  /** 中止该账号的在途采集；返回是否确有在途任务被中止。 */
  cancel(accountId: string): boolean
}

/**
 * 单账号采集控制器：按账号 Map 维护运行中与最近终态记录（终态保留到下一次
 * 同账号启动时覆盖），同账号单飞（运行中再次 start → collect_busy）、账号
 * 之间互不阻塞。批量互斥经 `batchHasRunning` 钩子注入；AbortController 登记
 * `signals`（collect.cancel 与 dispose 复用同一 abort 链路）；采集任务（含
 * 终态写回）登记 `taskRegistry`（dispose 统一等待 settle）。
 * @param deps - runCollection 的公共依赖。
 * @param hooks - 批量互斥钩子、任务登记表与 AbortController 登记表。
 * @returns the controller with start/status/running/runningAccountIds/hasRunning/wait/cancel.
 */
export function createCollectController(deps: CollectControllerDeps, hooks: {
  batchHasRunning?: (() => boolean) | undefined
  taskRegistry?: TaskRegistry | undefined
  signals?: Map<string, AbortController> | undefined
} = {}): CollectController {
  const runs = new Map<string, CollectRecord>()
  const project = (record: CollectRecord): Record<string, unknown> => ({
    accountId: record.accountId,
    attemptId: record.attemptId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    progress: record.progress,
    result: record.result,
  })
  /** 启动 runCollection 并挂终态写回（与旧 collect.start handler 内的编排一致）。 */
  const launch = (record: CollectRecord, input: CollectStartInput, signal: AbortSignal): Promise<CollectResult> => {
    const accountId = record.accountId
    const attemptId = createAttemptId(accountId)
    record.attemptId = attemptId
    const task = runCollection({
      workbench: deps.workbench,
      accountId,
      root: deps.root,
      attemptId,
      locks: deps.locks,
      chromeFactory: deps.chromeFactory,
      newAttempt: input.newAttempt ?? true,
      onProgress: event => {
        const progress = progressFromEvent(event)
        if (progress !== null) record.progress = progress
      },
      logger: deps.logger,
      signal,
      taskRegistry: hooks.taskRegistry,
      ...(deps.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: deps.browserCloseTimeoutMs } : {}),
      ...(deps.launchTimeoutMs !== undefined ? { launchTimeoutMs: deps.launchTimeoutMs } : {}),
    })
    record.task = task
    hooks.taskRegistry?.track(task
      .then(result => {
        record.status = result.status === 'completed' || result.status === 'partial' ? result.status : result.reason === 'collect_cancelled' ? 'cancelled' : 'failed'
        record.error = record.status === 'failed' ? result.reason ?? 'collect_failed' : null
        record.result = { runId: result.runId, works: result.works ?? 0 }
        record.finishedAt = new Date().toISOString()
      })
      .catch((error: unknown) => {
        // 兜底终态（runner 自身已 catch 一切；此处只覆盖磁盘级穿透）。
        // 写失败再 warn：终态可见性不允许静默。写盘纳入登记表。
        record.status = 'failed'
        record.error = safeCode(error)
        record.finishedAt = new Date().toISOString()
        hooks.taskRegistry?.track(updateRun(deps.root, accountId, attemptId, { status: 'failed', finishedAt: new Date().toISOString(), error: record.error }).catch((persistError: unknown) => {
          deps.logger?.warn(`wx runs.json final state write failed (${attemptId}): ${safeCode(persistError)}`)
        }))
      }))
    return task
  }
  return {
    async start(input: CollectStartInput): Promise<{ started: boolean; record: CollectRecord | null; reason?: string }> {
      const accountId = input.accountId
      if (accountId === '') return { started: false, record: null, reason: 'account_id_required' }
      const existing = runs.get(accountId)
      if (existing !== undefined && existing.status === 'running') {
        return { started: false, record: existing, reason: 'collect_busy' }
      }
      if (input.fromBatch !== true && hooks.batchHasRunning?.() === true) {
        return { started: false, record: null, reason: 'collect_busy' }
      }
      // 重新启动覆盖旧终态记录；delete+set 让 Map 迭代序跟随本次启动顺序。
      runs.delete(accountId)
      const record: CollectRecord = {
        accountId,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        attemptId: null,
        // 页面路径在探测期间给页面一个确定的阶段投影；批量内部首个探测事件随即覆盖。
        progress: input.probe === undefined ? null : { phase: 'probing' },
        result: null,
        error: null,
      }
      runs.set(accountId, record)
      const controller = new AbortController()
      const signals = hooks.signals
      signals?.set(accountId, controller)
      const forwardBatchAbort = (): void => { controller.abort() }
      if (input.signal !== undefined) {
        if (input.signal.aborted) controller.abort()
        else input.signal.addEventListener('abort', forwardBatchAbort, { once: true })
      }
      const releaseSignal = (): void => {
        if (signals?.get(accountId) === controller) signals.delete(accountId)
        input.signal?.removeEventListener('abort', forwardBatchAbort)
      }
      // 批量内部启动：阶段 1 已实测，直接启动。
      if (input.probe === undefined) {
        const task = launch(record, input, controller.signal)
        void task.then(() => undefined, () => undefined).finally(releaseSignal)
        return { started: true, record }
      }
      // 页面路径：就绪检查 → 实测上报（同步等待）→ 启动前复查 → 启动。
      const probeResult = await input.probe().catch((error: unknown) => ({ ok: false, reason: safeCode(error) }))
      if (!probeResult.ok) {
        record.status = 'failed'
        record.error = probeResult.reason ?? 'probe_failed'
        record.finishedAt = new Date().toISOString()
        releaseSignal()
        return { started: false, record, reason: record.error }
      }
      // dispose 可能在探测期间完成（探测经 guard 登记被 dispose 等待）：启动前
      // 复查，避免「dispose 返回后采集才启动——abort 丢失且无人等待」。
      const blocked = input.beforeLaunch?.() ?? null
      if (blocked !== null) {
        record.status = 'failed'
        record.error = blocked
        record.finishedAt = new Date().toISOString()
        releaseSignal()
        return { started: false, record, reason: blocked }
      }
      if (controller.signal.aborted) {
        record.status = 'failed'
        record.error = 'collect_cancelled'
        record.finishedAt = new Date().toISOString()
        releaseSignal()
        return { started: false, record, reason: 'collect_cancelled' }
      }
      const task = launch(record, input, controller.signal)
      void task.then(() => undefined, () => undefined).finally(releaseSignal)
      return { started: true, record }
    },
    status(accountId: string): Record<string, unknown> | null {
      const record = runs.get(accountId)
      return record === undefined ? null : project(record)
    },
    running(): Record<string, unknown> | null {
      for (const record of runs.values()) {
        if (record.status === 'running') return project(record)
      }
      return null
    },
    runningAccountIds(): string[] {
      const ids: string[] = []
      for (const record of runs.values()) {
        if (record.status === 'running') ids.push(record.accountId)
      }
      return ids
    },
    hasRunning(): boolean {
      for (const record of runs.values()) {
        if (record.status === 'running') return true
      }
      return false
    },
    async wait(accountId: string): Promise<CollectResult | null> {
      const record = runs.get(accountId)
      if (record?.task === undefined) return null
      return await record.task.then(result => result, () => null)
    },
    cancel(accountId: string): boolean {
      const controller = hooks.signals?.get(accountId)
      if (controller === undefined) return false
      controller.abort()
      return true
    },
  }
}
