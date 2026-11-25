/**
 * 单账号采集编排（移植旧 runner.js 全语义 + 新仓库 AbortController/runs.json
 * 生命周期）：会话探测（设备端实测优先）→ 远端账号自愈 → 无头系统 Chrome +
 * storage_state（zh-CN / Asia/Shanghai）→ collectAccountWorksOn → 入库编排 →
 * ok 恢复上报（多设备 seq floor 对齐）→ 头像补写。SessionInvalid 走过期收尾
 * （部分成果入库保留、listComplete 强制 false、无作品不建 run）。批量控制器
 * 与单账号互斥（collect_busy）、串行、no_eligible_account。
 * @module
 */
import type { Page } from 'playwright-core'
import { safeCode, DouyinError } from './errors.ts'
import { accountSaveIdempotencyKey, sessionIdempotencyKey } from './idempotency.ts'
import { createIngestClient, ingestCollectedWorks } from './ingest.ts'
import { SessionInvalidError, type PartialCollected } from './parse.ts'
import { collectAccountWorksOn, collectSurfaceOf, WORK_PUBLISH_SINCE_REPORT } from './collector.ts'
import { getAccount, hasStorageState, paths, readAccounts, stateRoot, updateAccount, type AccountRecord } from './state.ts'
import { withProfileLock } from './locks.ts'
import { isPendingAccountId } from './session.ts'
import { createAttemptId, updateRun, type RunRecord } from './runs.ts'
import type { TaskRegistry } from './lifecycle.ts'
import { launchChromeSession, refreshSessionState, type ChromeFactory, type DouyinProfile, type RefreshedSession } from './session.ts'
import { bumpSessionSeqWith, nextSessionSeq } from './state.ts'

export const DEFAULT_MAX_PAGES = 1000
const OPEN_TIMEOUT_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Host 依赖注入（runner 侧；workbench caller + chrome factory 可注入测试）。 */
export interface RunnerDeps {
  callTool: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ structuredContent: unknown; content: unknown }>
  root: string
  chromeFactory?: ChromeFactory | undefined
  maxPages?: number
  logger?: { warn(message: string): void } | undefined
}

function payloadOf(outcome: { structuredContent: unknown }): Record<string, unknown> {
  return outcome.structuredContent && typeof outcome.structuredContent === 'object' && !Array.isArray(outcome.structuredContent)
    ? outcome.structuredContent as Record<string, unknown>
    : {}
}

/** 采集资格检查：本地 storage_state 存在（失效文件仍存在，有效性由设备端判定）。 */
export async function checkCollectionReadiness(options: { accountId: string; root: string }): Promise<{ ready: boolean; reason: string | null }> {
  const usable = await hasStorageState(options.accountId, options.root)
  return usable ? { ready: true, reason: null } : { ready: false, reason: 'session_required' }
}

/** 远端账号自愈：登录期 account_save 可能失败；幂等 upsert，失败不阻断。 */
export async function ensureRemoteAccount(deps: RunnerDeps, accountId: string, options: {
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  signal?: AbortSignal | undefined
} = {}): Promise<{ ok: boolean; error: string | null }> {
  options.onProgress?.({ phase: 'account_sync' })
  try {
    const record = await getAccount(accountId, deps.root).catch(() => undefined)
    const payload: Record<string, unknown> = {
      accountId,
      sessionRef: paths(deps.root).vaultRef(accountId),
      idempotencyKey: accountSaveIdempotencyKey(accountId),
    }
    if (typeof record?.nickname === 'string' && record.nickname !== '') payload.nickname = record.nickname
    if (typeof record?.fanCount === 'number' && Number.isFinite(record.fanCount)) payload.fanCount = record.fanCount
    await deps.callTool('workbench_douyin_account_save', payload, options.signal)
    return { ok: true, error: null }
  } catch (error) {
    const reason = safeCode(error)
    options.onProgress?.({ phase: 'account_sync_failed', error: reason })
    return { ok: false, error: reason }
  }
}

/** 会话状态上报（幂等键 = accountId+seq；applied:false 是稳定拒绝不抛错）。 */
export async function reportSessionStatus(deps: RunnerDeps, accountId: string, state: {
  sessionStatus: string
  sessionSeq: number
  checkedAt: string
  vaultRef: string
}, signal?: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
  try {
    const outcome = await deps.callTool('workbench_douyin_session_status_report', {
      accountId,
      sessionStatus: state.sessionStatus,
      sessionSeq: state.sessionSeq,
      checkedAt: state.checkedAt,
      sessionRef: state.vaultRef,
      idempotencyKey: sessionIdempotencyKey(accountId, state.sessionSeq),
    }, signal)
    const payload = payloadOf(outcome)
    if (payload.applied === false) {
      const reason = payload.reason === 'stale_report' ? 'stale_report' : 'session_report_rejected'
      return { ok: false, error: reason }
    }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: safeCode(error) }
  }
}

/** 会话标记 expired（不探测：status_code=8 是确定性证据）。 */
export async function markSessionExpired(options: { accountId: string; root: string; reason?: string }): Promise<RefreshedSession> {
  const seq = await nextSessionSeq(options.accountId, options.root)
  const { record } = await bumpSessionSeqWith(options.accountId, {
    sessionStatus: 'expired',
    sessionCheckedAt: new Date().toISOString(),
  }, seq - 1, options.root)
  return {
    sessionStatus: 'expired',
    reason: options.reason ?? 'session_invalid',
    sessionSeq: record.sessionSeq ?? seq,
    checkedAt: record.sessionCheckedAt ?? new Date().toISOString(),
    vaultRef: paths(options.root).vaultRef(options.accountId),
    accountId: options.accountId,
    profile: null,
  }
}

/** 会话拉回 ok（floor 对齐远端下限后再 +1，防多设备 stale 上报）。 */
export async function markSessionOk(options: { accountId: string; root: string; floorSessionSeq?: number }): Promise<RefreshedSession> {
  const seq = await nextSessionSeq(options.accountId, options.root)
  const floor = Math.max(seq - 1, options.floorSessionSeq ?? 0)
  const { record } = await bumpSessionSeqWith(options.accountId, {
    sessionStatus: 'ok',
    sessionCheckedAt: new Date().toISOString(),
  }, floor, options.root)
  return {
    sessionStatus: 'ok',
    reason: null,
    sessionSeq: record.sessionSeq ?? seq,
    checkedAt: record.sessionCheckedAt ?? new Date().toISOString(),
    vaultRef: paths(options.root).vaultRef(options.accountId),
    accountId: options.accountId,
    profile: null,
  }
}

/** reportSessionOkAfterCollect 的结果（skipped 带稳定原因，不改变采集结果）。 */
export interface SessionOkReport {
  reported: boolean
  skipped: string | null
  reason: string | null
}

/**
 * expired→ok 恢复上报（多设备修复）：身份门槛（页面 profile.accountId 必须
 * 一致）；远端账号缺失跳过；远端已 ok 不消耗新序号、仅本机对齐远端下限。
 */
export async function reportSessionOkAfterCollect(deps: RunnerDeps, accountId: string, options: {
  profile: DouyinProfile | null
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  signal?: AbortSignal | undefined
}): Promise<SessionOkReport> {
  const emit = options.onProgress
  // 身份门槛：只有采集页身份验证一致才允许 ok 上报（绝不放行串号）。
  if (options.profile === null || options.profile.accountId !== accountId) {
    emit?.({ phase: 'session_ok_report_skipped', reason: 'profile_unverified' })
    return { reported: false, skipped: 'profile_unverified', reason: null }
  }
  let remoteAccount: Record<string, unknown> | null = null
  let remoteSeq = 0
  try {
    const outcome = await deps.callTool('workbench_douyin_account_list', { accountId }, options.signal)
    const payload = payloadOf(outcome)
    const rows = Array.isArray(payload.accounts) ? payload.accounts as Record<string, unknown>[] : []
    remoteAccount = rows.find(row => row.account_id === accountId) ?? null
    remoteSeq = Number(remoteAccount?.session_seq ?? 0)
  } catch {
    remoteAccount = null
  }
  if (remoteAccount === null) {
    emit?.({ phase: 'session_ok_report_skipped', reason: 'remote_account_unavailable' })
    return { reported: false, skipped: 'remote_account_unavailable', reason: null }
  }
  const localRecord = await getAccount(accountId, deps.root).catch(() => undefined)
  const localSeq = Number(localRecord?.sessionSeq ?? 0)
  if (remoteAccount.session_status === 'ok') {
    // 远端已 ok：不消耗新 seq，仅本机对齐远端下限（already_ok）。
    if (remoteSeq > localSeq) {
      await updateAccount(accountId, { sessionSeq: remoteSeq, sessionCheckedAt: new Date().toISOString() }, deps.root)
    }
    emit?.({ phase: 'session_ok_report_skipped', reason: 'already_ok' })
    return { reported: false, skipped: 'already_ok', reason: null }
  }
  try {
    const state = await markSessionOk({ accountId, root: deps.root, floorSessionSeq: remoteSeq })
    const report = await reportSessionStatus(deps, accountId, state, options.signal)
    if (!report.ok) {
      emit?.({ phase: 'session_ok_report_rejected', reason: report.error })
      return { reported: false, skipped: null, reason: report.error }
    }
    emit?.({ phase: 'session_ok_reported' })
    return { reported: true, skipped: null, reason: null }
  } catch (error) {
    const reason = safeCode(error)
    emit?.({ phase: 'session_ok_report_failed', error: reason })
    return { reported: false, skipped: null, reason }
  }
}

/** 头像补写（本地缺失时；accountId 必须一致，五 reason 与旧口径一致）。 */
export async function saveDiscoveredAvatar(deps: RunnerDeps, accountId: string, profile: DouyinProfile | null, options: {
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  signal?: AbortSignal | undefined
} = {}): Promise<{ updated: boolean; reason: string | null }> {
  const emit = options.onProgress
  if (profile === null) return { updated: false, reason: 'profile_missing' }
  if (profile.accountId !== accountId) return { updated: false, reason: 'account_mismatch' }
  if (profile.avatar === null || profile.avatar === '') return { updated: false, reason: 'avatar_invalid' }
  const record = await getAccount(accountId, deps.root).catch(() => undefined)
  if (record !== undefined && typeof record.avatar === 'string' && record.avatar !== '') {
    return { updated: false, reason: 'avatar_exists' }
  }
  await updateAccount(accountId, { avatar: profile.avatar }, deps.root)
  try {
    await deps.callTool('workbench_douyin_account_save', {
      accountId,
      sessionRef: paths(deps.root).vaultRef(accountId),
      idempotencyKey: accountSaveIdempotencyKey(accountId),
      avatar: profile.avatar,
    }, options.signal)
    emit?.({ phase: 'avatar_saved' })
    return { updated: true, reason: null }
  } catch (error) {
    const reason = safeCode(error)
    emit?.({ phase: 'avatar_save_failed', reason })
    return { updated: false, reason }
  }
}

/** 单账号采集 run 的终态投影（旧 runner result 八字段 + 失败形态）。 */
export interface CollectResult {
  status: 'ready' | 'session_expired' | 'collect_failed' | 'ingest_failed'
  reason?: string | null
  runId?: string | null
  runStatus?: string | null
  listComplete?: boolean
  listReason?: string | null
  expectedWorkCount?: number
  publishSince?: string | null
  skippedBeforePublishSince?: number | null
  succeededWorkCount?: number
  failedWorkCount?: number
  workFailures?: { workId: string; reason: string }[]
  settlement?: unknown
  dashboard?: { dailyAccepted: number; gaps: { source: string; reason: string }[] }
  heartbeatSeq?: number
  sessionReported?: boolean
  sessionReportError?: string | null
}

/**
 * 编排结果 → 面板横幅三态（旧 client.js run 横幅语义）：编排 ready 但服务端
 * run 判 partial（settlement/缺口）或列表扫描不完整时绝不显示「采集完成」。
 * @param result - 单账号采集的终态结果。
 * @returns completed / partial / failed。
 */
export function collectOutcomeStatus(result: Pick<CollectResult, 'status' | 'runStatus' | 'listComplete'>): 'completed' | 'partial' | 'failed' {
  if (result.status !== 'ready') return 'failed'
  if (result.runStatus === 'failed') return 'failed'
  return result.runStatus === 'partial' || result.listComplete !== true ? 'partial' : 'completed'
}

/** runCollection 的注入（在 RunnerDeps 之上扩展）。 */
export interface RunOptions {
  accountId: string
  root?: string
  attemptId?: string
  maxPages?: number
  days?: number
  newAttempt?: boolean
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  signal?: AbortSignal | undefined
  taskRegistry?: TaskRegistry | undefined
  chromeFactory?: ChromeFactory | undefined
}

/**
 * 单账号采集全流程：全程持有账号 profile 锁；runs.json 记录 running→终态
 * 全生命周期（G-2）；abort 在每个 await 点检查提前退出，终态 cancelled。
 */
export async function runCollection(deps: RunnerDeps, options: RunOptions): Promise<CollectResult> {
  const root = options.root ?? stateRoot()
  const accountId = options.accountId
  const attemptId = options.attemptId ?? createAttemptId()
  return withProfileLock(accountId, () => runCollectionWithinProfileLock(deps, { ...options, root, attemptId }))
}

/** runCollection 的锁内实现（调用方必须已持有账号锁）。 */
async function runCollectionWithinProfileLock(deps: RunnerDeps, options: RunOptions & { root: string; attemptId: string }): Promise<CollectResult> {
  const { root, accountId, attemptId } = options
  const signal = options.signal
  // abort 检查走函数边界：try 块内的 const 收窄会延续进 catch（CFA），直接
  // 比较 signal?.aborted === true 会被判「不可达」。
  const aborted = (): boolean => signal?.aborted === true
  const emit = (event: Record<string, unknown>): void => {
    options.onProgress?.(event)
    // 进度落盘（fire-and-forget：root 队列串行不丢写，失败只告警）。
    const progress = progressFromEvent(event)
    if (progress !== null) {
      const write = updateRun(root, accountId, attemptId, { progress }).catch((error: unknown) => {
        deps.logger?.warn(`douyin runs.json progress update failed (${attemptId}): ${safeCode(error)}`)
      })
      options.taskRegistry?.track(write)
    }
  }
  /** 终态落盘（await 保证 handler 收尾时已持久；写失败 warn 可见）。 */
  const persistFinalRun = async (patch: { runId?: string | null; status: RunRecord['status']; error: string | null; publishSince?: string }): Promise<void> => {
    const write = updateRun(root, accountId, attemptId, { ...patch, finishedAt: new Date().toISOString() })
    options.taskRegistry?.track(write)
    try {
      await write
    } catch (error) {
      deps.logger?.warn(`douyin runs.json final state write failed (${attemptId}): ${safeCode(error)}`)
    }
  }
  /** runId 落盘 barrier（ingest persistence 接缝）。 */
  const persistAttempt = async (state: { runAttemptId: string; runId: string | null; heartbeatSeq: number }): Promise<void> => {
    const write = updateRun(root, accountId, attemptId, { runId: state.runId, publishSince: WORK_PUBLISH_SINCE_REPORT })
    options.taskRegistry?.track(write)
    try {
      await write
    } catch (error) {
      deps.logger?.warn(`douyin runs.json runId persist failed (${attemptId}): ${safeCode(error)}`)
      options.onProgress?.({ phase: 'run_persist_failed', reason: safeCode(error) })
    }
  }
  let page: Page | null = null
  let closeSession: (() => Promise<void>) | null = null
  try {
    // 0) 会话前置：storage_state 缺失不建 run（readiness reason 透出）。
    emit({ phase: 'probing' })
    const readiness = await checkCollectionReadiness({ accountId, root })
    if (!readiness.ready) {
      await persistFinalRun({ status: 'failed', error: readiness.reason ?? 'session_required' })
      return { status: 'collect_failed', reason: readiness.reason ?? 'session_required' }
    }
    // 1) 会话探测（本地实测优先；远端 floor 由 ok 恢复上报阶段自读）。
    const session = await refreshSessionState({ accountId, root, chromeFactory: options.chromeFactory })
    const report = await reportSessionStatus(deps, accountId, session, signal)
    if (!report.ok) emit({ phase: 'session_report_failed', error: report.error })
    if (session.sessionStatus !== 'ok') {
      const reason = session.sessionStatus === 'expired' ? 'session_expired' : 'probe_failed'
      await persistFinalRun({ status: 'failed', error: reason })
      return { status: 'collect_failed', reason }
    }

    // 2) 远端账号自愈（失败不阻断）。
    await ensureRemoteAccount(deps, accountId, { onProgress: emit, signal })
    if (aborted()) throw new DouyinError('collect_cancelled', 'collect_cancelled')

    // 3) 无头系统 Chrome + storage_state（采集专属 locale/timezone 与旧口径一致）。
    emit({ phase: 'session_open' })
    const factory = options.chromeFactory ?? launchChromeSession
    const launched = await factory({
      headless: true,
      profileDir: paths(root).profileDir(accountId),
      storageStatePath: paths(root).storageStatePath(accountId),
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    closeSession = launched.close
    page = launched.context.pages()[0] ?? await launched.context.newPage()
    void OPEN_TIMEOUT_MS

    // 4) 采集（publishSince 过滤在详情前；各阶段 SessionInvalid 挂部分成果）。
    let collected
    try {
      collected = await collectAccountWorksOn(collectSurfaceOf(page), {
        ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
        ...(options.days !== undefined ? { days: options.days } : {}),
        onProgress: info => emit({ phase: 'work', ...info }),
      })
    } catch (error) {
      if (error instanceof SessionInvalidError) {
        const outcome = await finishExpiredSession(deps, accountId, {
          partial: error.partialCollected ?? null,
          onProgress: emit,
          signal,
        })
        await persistFinalRun({ status: 'failed', error: 'session_invalid', publishSince: WORK_PUBLISH_SINCE_REPORT })
        return outcome
      }
      throw error
    }
    emit({
      phase: 'collected',
      listComplete: collected.listComplete,
      expectedWorkCount: collected.expectedWorkCount,
      ...(collected.listReason !== null ? { listReason: collected.listReason } : {}),
      failures: collected.failures.length,
      publishSince: collected.publishSince,
      skippedBeforePublishSince: collected.skippedBeforePublishSince,
      publishTimeMissing: collected.publishTimeMissing,
    })

    // 5) 范围不变量防御：发生过范围过滤却缺 publishSince → 确定性失败。
    if ((collected.skippedBeforePublishSince > 0 || collected.publishTimeMissing > 0) && collected.publishSince === null) {
      await persistFinalRun({ status: 'failed', error: 'publish_since_required' })
      return { status: 'collect_failed', reason: 'publish_since_required' }
    }

    // 6) 入库编排（batch 失败记缺口不阻断；list_meta 失败返回 ingest_failed）。
    emit({ phase: 'ingesting' })
    const client = createIngestClient({
      workbench: { callTool: async (tool, args, signal) => deps.callTool(tool, args, signal) },
      accountId,
      persistence: { persistAttempt },
      signal,
    })
    let ingestOutcome
    try {
      ingestOutcome = await ingestCollectedWorks({
        client,
        works: collected.works,
        listComplete: collected.listComplete,
        expectedWorkCount: collected.expectedWorkCount,
        publishSince: collected.publishSince,
        dashboard: {
          dashboardRows: collected.dashboard.dashboardRows,
          dashboardFansRows: collected.dashboard.dashboardFansRows,
          ...(collected.dashboard.fansProfile !== null ? { fansProfile: collected.dashboard.fansProfile } : {}),
          gaps: collected.dashboard.gaps,
        },
        newAttempt: options.newAttempt ?? true,
        onProgress: emit,
        signal,
      })
    } catch (error) {
      if (aborted()) throw new DouyinError('collect_cancelled', 'collect_cancelled')
      const reason = safeCode(error)
      await persistFinalRun({ runId: client.runId, status: 'failed', error: reason })
      return { status: 'ingest_failed', reason, runId: client.runId }
    }
    if (aborted()) throw new DouyinError('collect_cancelled', 'collect_cancelled')
    if (ingestOutcome.error !== null) {
      await persistFinalRun({ runId: ingestOutcome.runId, status: 'failed', error: ingestOutcome.error })
      return { status: 'ingest_failed', reason: ingestOutcome.error, runId: ingestOutcome.runId }
    }

    // 7) ok 恢复上报 + 头像补写（任何失败不改变采集/入库结果）。
    const okReport = await reportSessionOkAfterCollect(deps, accountId, { profile: collected.profile, onProgress: emit, signal })
    await saveDiscoveredAvatar(deps, accountId, collected.profile, { onProgress: emit, signal })

    const finishRun = (ingestOutcome.finish?.run ?? {}) as Record<string, unknown>
    const result: CollectResult = {
      status: 'ready',
      runId: ingestOutcome.runId,
      runStatus: typeof finishRun.status === 'string' ? finishRun.status : null,
      listComplete: collected.listComplete,
      listReason: collected.listReason,
      expectedWorkCount: collected.expectedWorkCount,
      publishSince: collected.publishSince,
      skippedBeforePublishSince: collected.skippedBeforePublishSince,
      succeededWorkCount: ingestOutcome.ingest?.succeededWorkIds.length ?? 0,
      failedWorkCount: ingestOutcome.ingest?.failedWorkIds.length ?? 0,
      workFailures: collected.failures,
      settlement: finishRun.settlement ?? null,
      dashboard: { dailyAccepted: ingestOutcome.dailyAccepted, gaps: collected.dashboard.gaps },
      sessionReported: okReport.reported,
    }
    await persistFinalRun({ runId: ingestOutcome.runId, status: (result.runStatus as RunRecord['status']) ?? 'completed', error: null, publishSince: WORK_PUBLISH_SINCE_REPORT })
    return result
  } catch (error) {
    // 取消（dispose/abort）：浏览器关闭，本地 run 标 cancelled（远端 run 交由
    // 服务端租约回收，G-1 不绑定 cancel action、编排内不调用 run_cancel）。
    if (aborted() || (error instanceof DouyinError && error.code === 'collect_cancelled')) {
      await persistFinalRun({ status: 'cancelled', error: 'collect_cancelled' })
      return { status: 'collect_failed', reason: 'collect_cancelled' }
    }
    if (error instanceof SessionInvalidError) {
      const outcome = await finishExpiredSession(deps, accountId, {
        partial: error.partialCollected ?? null,
        onProgress: emit,
        signal,
      })
      await persistFinalRun({ status: 'failed', error: 'session_invalid' })
      return { ...outcome }
    }
    const reason = safeCode(error)
    deps.logger?.warn(`douyin collect ${accountId}: ${reason}`)
    await persistFinalRun({ status: 'failed', error: reason })
    return { status: 'collect_failed', reason }
  } finally {
    if (closeSession !== null) await closeSession().catch(() => undefined)
  }
}

/**
 * 会话过期收尾（旧 finishExpiredSession 两分支）：公共 = markSessionExpired +
 * 尽力上报；分支 A（有部分成果）= 建 run → listComplete:false 强制声明 →
 * ingestAll → finish(clientStatus:'failed')；分支 B（无作品，列表阶段即过期）
 * = 不建 run（expected=0 无法诚实结算），只上报 expired。
 */
export async function finishExpiredSession(deps: RunnerDeps, accountId: string, options: {
  partial: PartialCollected | null
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  signal?: AbortSignal | undefined
}): Promise<CollectResult> {
  const emit = options.onProgress
  emit?.({ phase: 'session_expired' })
  const expired = await markSessionExpired({ accountId, root: deps.root })
  const report = await reportSessionStatus(deps, accountId, expired)
  const partial = options.partial
  if (partial === null || partial.works.length === 0) {
    return {
      status: 'session_expired',
      reason: 'session_invalid',
      runId: null,
      runStatus: null,
      listComplete: false,
      expectedWorkCount: 0,
      publishSince: WORK_PUBLISH_SINCE_REPORT,
      // 范围外跳过数只随部分成果透传（列表阶段即过期时未知 → null，不造 0）。
      skippedBeforePublishSince: partial?.skippedBeforePublishSince ?? null,
      succeededWorkCount: 0,
      failedWorkCount: 0,
      sessionReported: report.ok,
      sessionReportError: report.error,
    }
  }
  try {
    const client = createIngestClient({ workbench: { callTool: async (tool, args, signal) => deps.callTool(tool, args, signal) }, accountId, signal: options.signal })
    await client.startRun({ newAttempt: true })
    await client.publishListMeta({
      expectedWorkCount: partial.expectedWorkCount,
      // 被中断的采集绝不声明完整 → 服务端必结算 partial。
      listComplete: false,
      ...(partial.publishSince !== null ? { publishSince: partial.publishSince } : {}),
    })
    const ingest = await client.ingestAll(partial.works, { observedCount: partial.expectedWorkCount })
    const finish = await client.finish({
      clientStatus: 'failed',
      clientCounts: {
        expectedWorkCount: partial.expectedWorkCount,
        succeededWorkCount: ingest.succeededWorkIds.length,
        failedWorkCount: ingest.failedWorkIds.length,
      },
    })
    const finishRun = finish.run
    return {
      status: 'session_expired',
      reason: 'session_invalid',
      runId: client.runId,
      runStatus: typeof finishRun.status === 'string' ? finishRun.status : null,
      listComplete: false,
      expectedWorkCount: partial.expectedWorkCount,
      publishSince: partial.publishSince,
      skippedBeforePublishSince: partial.skippedBeforePublishSince ?? null,
      succeededWorkCount: ingest.succeededWorkIds.length,
      failedWorkCount: ingest.failedWorkIds.length,
      sessionReported: report.ok,
      sessionReportError: report.error,
    }
  } catch (error) {
    emit?.({ phase: 'session_expired_finish_failed', error: safeCode(error) })
    return {
      status: 'session_expired',
      reason: 'session_invalid',
      runId: null,
      listComplete: false,
      expectedWorkCount: partial.expectedWorkCount,
      publishSince: partial.publishSince,
      succeededWorkCount: 0,
      failedWorkCount: 0,
      sessionReported: report.ok,
      sessionReportError: report.error,
    }
  }
}

/** 进度事件 → collect.status 投影（白名单形状；非进度事件返回 null）。 */
export function progressFromEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  const phase = event.phase
  switch (phase) {
    case 'work':
      return { phase: 'work', workId: event.workId, index: event.index, total: event.total }
    case 'batch_done':
      return { phase: 'batch_done', batchNo: event.batchNo, totalBatches: event.totalBatches, succeeded: event.succeeded, failed: event.failed }
    case 'collected':
      return { phase: 'collected', expectedWorkCount: event.expectedWorkCount }
    case 'run_persist_failed':
      return { phase: 'run_persist_failed', reason: event.reason }
    default:
      return null
  }
}

// ---- 单账号与批量控制器（collect.start / collectAll.start 的进程内状态机）----

/** 单账号 run 记录（进程内；页面轮询 collect.status）。 */
export interface CollectRecord {
  accountId: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  startedAt: string
  finishedAt: string | null
  events: Record<string, unknown>[]
  result: CollectResult | null
  error: string | null
}

const EVENT_LIMIT = 200

/** 单账号采集控制器：同账号单飞幂等复用；事件环形裁剪。 */
export function createCollectController(deps: RunnerDeps, hooks: {
  batchHasRunning?: (() => boolean) | undefined
  taskRegistry?: TaskRegistry | undefined
} = {}) {
  const runs = new Map<string, CollectRecord>()
  const project = (record: CollectRecord): Record<string, unknown> => ({
    accountId: record.accountId,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    progress: lastProgress(record.events),
    result: record.result === null ? null : projectResult(record.result),
  })
  return {
    /** Start (or idempotently reuse) one account's collect run. */
    start(input: { accountId: string; options?: Partial<RunOptions> }): { started: boolean; record: CollectRecord | null; reason?: string } {
      const accountId = input.accountId
      if (accountId === '') return { started: false, record: null, reason: 'account_id_required' }
      const existing = runs.get(accountId)
      if (existing !== undefined && existing.status === 'running') {
        return { started: false, record: existing, reason: 'collect_busy' }
      }
      if (hooks.batchHasRunning?.() === true) {
        return { started: false, record: null, reason: 'collect_busy' }
      }
      const record: CollectRecord = {
        accountId,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        events: [],
        result: null,
        error: null,
      }
      runs.set(accountId, record)
      const onProgress = (event: Record<string, unknown>): void => {
        record.events.push({ at: Date.now(), ...event })
        if (record.events.length > EVENT_LIMIT) record.events.splice(0, record.events.length - EVENT_LIMIT)
        input.options?.onProgress?.(event)
      }
      const task = runCollection(deps, {
        accountId,
        root: deps.root,
        maxPages: input.options?.maxPages ?? deps.maxPages ?? DEFAULT_MAX_PAGES,
        newAttempt: true,
        ...(input.options?.attemptId !== undefined ? { attemptId: input.options.attemptId } : {}),
        ...(input.options?.signal !== undefined ? { signal: input.options.signal } : {}),
        ...(input.options?.chromeFactory !== undefined ? { chromeFactory: input.options.chromeFactory } : {}),
        onProgress,
        taskRegistry: hooks.taskRegistry,
      })
      hooks.taskRegistry?.track(task.then(() => undefined).catch(() => undefined))
      void task.then(result => {
        record.status = collectOutcomeStatus(result)
        record.result = result
        record.error = result.reason ?? null
      }).catch((error: unknown) => {
        record.status = 'failed'
        record.error = safeCode(error)
        deps.logger?.warn(`douyin collect ${accountId} crashed: ${safeCode(error)}`)
      }).finally(() => {
        record.finishedAt = new Date().toISOString()
      })
      return { started: true, record }
    },
    status(accountId: string): Record<string, unknown> | null {
      const record = runs.get(accountId)
      return record === undefined ? null : project(record)
    },
    /** 运行中的单账号采集投影（任意账号；页面挂载恢复的查询入口，无则 null）。 */
    running(): Record<string, unknown> | null {
      for (const record of runs.values()) {
        if (record.status === 'running') return project(record)
      }
      return null
    },
    async wait(accountId: string): Promise<CollectResult | null> {
      const record = runs.get(accountId)
      if (record === undefined) return null
      for (;;) {
        if (record.status !== 'running') return record.result
        await sleep(120)
      }
    },
    hasRunning(): boolean {
      for (const record of runs.values()) {
        if (record.status === 'running') return true
      }
      return false
    },
  }
}

/** 最近一条进度事件（phase ∈ work/batch_done/collected）。 */
export function lastProgress(events: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    const progress = progressFromEvent(event)
    if (progress !== null && progress.phase !== 'run_persist_failed') return progress
  }
  return null
}

/** 结果八字段子集（旧 project result 投影）。 */
function projectResult(result: CollectResult): Record<string, unknown> {
  return {
    runId: result.runId ?? null,
    runStatus: result.runStatus ?? null,
    listComplete: result.listComplete ?? null,
    expectedWorkCount: result.expectedWorkCount ?? null,
    publishSince: result.publishSince ?? null,
    skippedBeforePublishSince: result.skippedBeforePublishSince ?? null,
    succeededWorkCount: result.succeededWorkCount ?? null,
    failedWorkCount: result.failedWorkCount ?? null,
  }
}

// ---- 批量控制器 ----

/** 批量条目投影。 */
export interface BatchItem {
  accountId: string
  status: 'queued' | 'probing' | 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped'
  reason: string | null
  collect?: { status: string; error: string | null; result: Record<string, unknown> | null } | undefined
}

/** 批量状态投影（collectAll.status）。 */
export interface BatchStatus {
  batchId: string | null
  status: 'running' | 'completed' | 'partial' | 'failed' | null
  phase: 'probing' | 'collecting' | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  currentAccountId: string | null
  total: number
  runnableTotal: number
  runnableDone: number
  completedCount: number
  partialCount: number
  failedCount: number
  skippedCount: number
  probedCount: number
  items: BatchItem[]
}

interface BatchState {
  batchId: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  phase: 'probing' | 'collecting'
  startedAt: string
  finishedAt: string | null
  error: string | null
  currentAccountId: string | null
  items: BatchItem[]
  /** batch 级取消信号（dispose/采集取消贯穿 probe 与逐账号采集）。 */
  signal: AbortSignal | undefined
}

let batchSeq = 0

/**
 * 批量采集控制器（旧九条行为）：全局单飞幂等、与单账号互斥、稳定排序、
 * no_eligible_account、串行 probing→collecting、全拦截 batch failed、复用单
 * 账号控制器、结算三态。
 */
export function createBatchCollectController(options: {
  collect: {
    start(input: { accountId: string; options?: Partial<RunOptions> }): { started: boolean; record: CollectRecord | null; reason?: string }
    wait(accountId: string): Promise<CollectResult | null>
    hasRunning(): boolean
  }
  probe: (accountId: string, signal?: AbortSignal) => Promise<{ sessionStatus: string; reason: string | null }>
  logger?: { warn(message: string): void } | undefined
  /** 整次 batch run promise 交给调用方任务登记；dispose 等待它。 */
  trackRun?: ((promise: Promise<void>) => void) | undefined
}) {
  let state: BatchState | null = null
  const projectItems = (items: BatchItem[]): Record<string, unknown>[] => items.map(item => ({
    accountId: item.accountId,
    status: item.status,
    reason: item.reason,
    ...(item.collect !== undefined ? { collect: item.collect } : {}),
  }))
  const project = (): BatchStatus => {
    // 闭包内不保留 let 收窄：进入即快照。
    const snapshot = state
    if (snapshot === null) {
      return { batchId: null, status: null, phase: null, startedAt: null, finishedAt: null, error: null, currentAccountId: null, total: 0, runnableTotal: 0, runnableDone: 0, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, probedCount: 0, items: [] }
    }
    const count = (status: BatchItem['status']): number => snapshot.items.filter(item => item.status === status).length
    const skipped = count('skipped')
    const completed = count('completed')
    const partial = count('partial')
    const failed = count('failed')
    const probed = snapshot.items.filter(item => ['ready', 'running', 'completed', 'partial', 'failed'].includes(item.status)).length
    return {
      batchId: snapshot.batchId,
      status: snapshot.status,
      phase: snapshot.status === 'running' ? snapshot.phase : null,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      error: snapshot.error,
      currentAccountId: snapshot.currentAccountId,
      total: snapshot.items.length,
      runnableTotal: snapshot.items.length - skipped,
      runnableDone: completed + partial + failed,
      completedCount: completed,
      partialCount: partial,
      failedCount: failed,
      skippedCount: skipped,
      probedCount: probed,
      items: snapshot.items,
    }
  }
  return {
    get status(): BatchStatus { return project() },
    get running(): boolean { return state !== null && state.status === 'running' },
    hasRunning(): boolean { return this.running },

    /** Start one batch (single-flight; probes then collects serially). */
    start(accounts: Array<{ accountId: string; skipped: boolean; reason: string | null }>, startOptions?: { signal?: AbortSignal }): { started: boolean; batch?: BatchStatus; reason?: string; skipped?: Record<string, unknown>[]; runPromise?: Promise<void> } {
      if (state !== null && state.status === 'running') {
        return { started: false, reason: 'collect_busy', batch: project() }
      }
      if (options.collect.hasRunning()) return { started: false, reason: 'collect_busy' }
      const items: BatchItem[] = [...accounts]
        .sort((a, b) => a.accountId.localeCompare(b.accountId))
        .map(account => account.skipped
          ? { accountId: account.accountId, status: 'skipped', reason: account.reason ?? 'not_eligible' }
          : { accountId: account.accountId, status: 'queued', reason: null })
      const runnable = items.filter(item => item.status === 'queued')
      if (runnable.length === 0) {
        return { started: false, reason: 'no_eligible_account', skipped: projectItems(items) }
      }
      batchSeq += 1
      state = {
        batchId: `batch-${Date.now().toString(36)}-${String(batchSeq)}`,
        status: 'running',
        phase: 'probing',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        currentAccountId: null,
        items,
        signal: startOptions?.signal,
      }
      const run = this.run().catch((error: unknown) => {
        const reason = safeCode(error)
        options.logger?.warn(`douyin batch ${state?.batchId}: ${reason}`)
        if (state !== null) {
          state.error = reason
          for (const item of state.items) {
            if (item.status === 'queued' || item.status === 'probing' || item.status === 'running') {
              item.status = 'failed'
              item.reason = reason
            }
          }
          state.status = 'failed'
          state.finishedAt = new Date().toISOString()
        }
      })
      options.trackRun?.(run)
      return { started: true, batch: project(), runPromise: run }
    },

    async run(): Promise<void> {
      // let 捕获变量的收窄不跨 await：进入即快照到 const。
      const current = state
      if (current === null) return
      // batch 级取消检查（函数边界；abort 后剩余项稳定落失败、不再启动下一账号、
      // 不再发起任何 Workbench 写调用）。
      const cancelled = (): boolean => current.signal?.aborted === true
      const failRest = (reason: string): void => {
        for (const item of current.items) {
          if (item.status === 'queued' || item.status === 'probing' || item.status === 'running' || item.status === 'ready') {
            item.status = 'failed'
            item.reason = reason
          }
        }
      }
      try {
        // 阶段 1：串行 probing（缓存口径的 ok 只是上次探测结果，实测才诚实）。
        current.phase = 'probing'
        for (const item of current.items) {
          if (item.status !== 'queued') continue
          if (cancelled()) {
            item.status = 'failed'
            item.reason = 'collect_cancelled'
            continue
          }
          item.status = 'probing'
          let probeResult: { sessionStatus: string; reason: string | null }
          try {
            probeResult = await options.probe(item.accountId, current.signal)
          } catch (error) {
            probeResult = { sessionStatus: 'unknown', reason: safeCode(error) }
          }
          if (cancelled()) {
            item.status = 'failed'
            item.reason = 'collect_cancelled'
            continue
          }
          if (probeResult.sessionStatus === 'ok') {
            item.status = 'ready'
            item.reason = null
          } else {
            item.status = 'skipped'
            item.reason = probeResult.sessionStatus === 'expired' ? 'session_required' : 'probe_failed'
          }
        }
        if (cancelled()) {
          failRest('collect_cancelled')
          current.status = 'failed'
          current.error = 'collect_cancelled'
          return
        }
        const runnable = current.items.filter(item => item.status === 'ready')
        if (runnable.length === 0) {
          // 全部被探测拦截：绝不伪装完成。
          current.status = 'failed'
          current.error = 'no_eligible_account'
          return
        }
        // 阶段 2：严格串行 collecting（上一个账号完全结束才启动下一个）。
        current.phase = 'collecting'
        for (const item of runnable) {
          if (cancelled()) {
            item.status = 'failed'
            item.reason = 'collect_cancelled'
            continue
          }
          current.currentAccountId = item.accountId
          item.status = 'running'
          const started = options.collect.start({ accountId: item.accountId, options: { signal: current.signal } })
          if (!started.started || started.record === null) {
            item.status = 'failed'
            item.reason = started.reason ?? 'collect_failed'
            current.currentAccountId = null
            continue
          }
          const result = await options.collect.wait(item.accountId)
          // 与单账号同口径（collectOutcomeStatus）：部分失败绝不伪装成整体成功。
          const outcome = result !== null ? collectOutcomeStatus(result) : 'failed'
          item.collect = {
            status: outcome,
            error: result?.reason ?? null,
            result: result === null ? null : projectResult(result),
          }
          if (cancelled()) {
            item.status = 'failed'
            item.reason = 'collect_cancelled'
            current.currentAccountId = null
            continue
          }
          item.status = outcome
          item.reason = item.status === 'failed' ? result?.reason ?? 'collect_failed' : null
          current.currentAccountId = null
        }
        if (cancelled()) {
          failRest('collect_cancelled')
          current.status = 'failed'
          current.error = 'collect_cancelled'
          return
        }
      } finally {
        if (current.status === 'running') {
          const completed = current.items.filter(item => item.status === 'completed').length
          const partial = current.items.filter(item => item.status === 'partial').length
          const failed = current.items.filter(item => item.status === 'failed').length
          current.status = completed === 0 && partial === 0 ? 'failed' : failed > 0 || partial > 0 ? 'partial' : 'completed'
          current.finishedAt = new Date().toISOString()
        }
      }
    },
  }
}

/** 批量入口的候选筛选（缓存口径，纯本地：pending/非 ok/无凭证 → skipped）。 */
export async function batchCandidates(deps: RunnerDeps, signal?: AbortSignal): Promise<Array<{ accountId: string; skipped: boolean; reason: string | null }>> {
  const local = await readAccounts(deps.root)
  const result: Array<{ accountId: string; skipped: boolean; reason: string | null }> = []
  // abort 检查走函数边界（const 收窄不跨 await）。
  const aborted = (): boolean => signal?.aborted === true
  for (const record of Object.values(local.accounts)) {
    if (aborted()) throw new DouyinError('collect_cancelled', 'batch candidates aborted')
    if (isPendingAccountId(record.accountId)) {
      result.push({ accountId: record.accountId, skipped: true, reason: 'pending_account' })
      continue
    }
    if (record.sessionStatus !== 'ok') {
      result.push({ accountId: record.accountId, skipped: true, reason: 'session_required' })
      continue
    }
    if (!(await hasStorageState(record.accountId, deps.root))) {
      if (aborted()) throw new DouyinError('collect_cancelled', 'batch candidates aborted')
      result.push({ accountId: record.accountId, skipped: true, reason: 'storage_state_missing' })
      continue
    }
    if (aborted()) throw new DouyinError('collect_cancelled', 'batch candidates aborted')
    result.push({ accountId: record.accountId, skipped: false, reason: null })
  }
  return result
}

export type { AccountRecord }
