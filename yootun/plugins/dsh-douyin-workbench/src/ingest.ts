/**
 * Workbench 入库客户端（移植旧 ingest.js 全语义）：run_start→set_list_meta→
 * 分批 ingest_batch→ingest_daily→run_finish 的幂等键与参数形状冻结；确定性
 * 错误不重试；RUN_NOT_RUNNING/RUN_NOT_FOUND 重建 run 重发 listMeta（≤3 次）；
 * 其余指数退避 min(8000, 500·2^(n-1)) ≤3 次。list_meta 失败不得进入结算
 * （服务端 RUN_LIST_META_REQUIRED 会拒绝）；daily 失败只记事件不影响结算；
 * V1 编排不启用周期性心跳（租约续期依赖每批 ingest_batch 写入）。G-1：
 * run_cancel 在本编排内无调用点（采集取消只经 AbortController/dispose）。
 * @module
 */
import {
  attemptUuid, heartbeatIdempotencyKey, ingestBatchIdempotencyKey, ingestDailyIdempotencyKey,
  listMetaIdempotencyKey, runFinishIdempotencyKey, runStartIdempotencyKey,
} from './idempotency.ts'
import { safeCode } from './errors.ts'
import { mergeDashboardRows, resolveClientStatus } from './parse.ts'

/** 批次大小与档位（服务端 schema 上限）。 */
export const BATCH_SIZE = 50
export const MAX_BATCH_NO = 100_000
export const DEFAULT_RETRIES = 3

/** 确定性错误：不退避重试（零副作用/契约拒绝）。 */
export const DETERMINISTIC_ERRORS = new Set([
  'RUN_ACCOUNT_MISMATCH', 'RUN_LIST_META_REQUIRED', 'HEARTBEAT_SEQ_REGRESSED', 'INVALID_IDEMPOTENCY_KEY',
  'CONFIRMATION_REQUIRED', 'VALIDATION_ERROR', 'ACCOUNT_NOT_FOUND', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE',
  'DOUYIN_TOOL_UNAVAILABLE', 'PUBLISH_SINCE_MISMATCH',
])

/** 可恢复错误：重建 run（新 attempt + 重发 listMeta）后可重试。 */
export const RECOVERABLE_ERRORS = new Set(['RUN_NOT_RUNNING', 'RUN_NOT_FOUND'])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Workbench face 的结构化子集（测试注入面）。 */
export interface IngestWorkbench {
  callTool(tool: string, args: Record<string, unknown>): Promise<{ structuredContent: unknown; content: unknown }>
}

/** ingest 进度事件（phase 白名单投影）。 */
export type IngestEvent = Record<string, unknown>

/** 客户端持久化 attempt 的接缝（runs.json 写盘由调用方注入；runId barrier）。 */
export interface AttemptPersistence {
  /** Persist {runAttemptId, runId, heartbeatSeq}（runId 落盘 barrier；fail loud 由调用方决定）。 */
  persistAttempt(state: { runAttemptId: string; runId: string | null; heartbeatSeq: number }): Promise<void>
}

/** Workbench 服务端载荷读取（structuredContent 的对象投影）。 */
function payloadOf(outcome: { structuredContent: unknown }): Record<string, unknown> {
  return outcome.structuredContent && typeof outcome.structuredContent === 'object' && !Array.isArray(outcome.structuredContent)
    ? outcome.structuredContent as Record<string, unknown>
    : {}
}

/** ingest 客户端（run 级状态机 + 重试 + 事件）。 */
export interface IngestClient {
  readonly runId: string | null
  readonly heartbeatSeq: number
  setProgress(onProgress: ((event: IngestEvent) => void) | undefined): void
  startRun(options: { newAttempt: boolean }): Promise<{ runId: string; reused: boolean }>
  publishListMeta(meta: { expectedWorkCount: number; listComplete: boolean; publishSince?: string | undefined }): Promise<void>
  heartbeat(): Promise<void>
  ingestAll(works: Record<string, unknown>[], options?: { observedCount?: number }): Promise<IngestBatchResult>
  ingestDaily(daily: Record<string, unknown>[], options?: { fansProfile?: unknown }): Promise<{ replayed: boolean; dailyAccepted: number; skipped?: string }>
  finish(options: { clientStatus: string; clientCounts?: { expectedWorkCount: number; succeededWorkCount: number; failedWorkCount: number } | null }): Promise<{ run: Record<string, unknown>; replayed: boolean }>
  cancel(): Promise<void>
}

/** 分批入库结果。 */
export interface IngestBatchResult {
  batchLog: { batchNo: number; status: 'succeeded' | 'failed'; error: string | null }[]
  succeededWorkIds: string[]
  failedWorkIds: string[]
  replayedAny: boolean
}

/**
 * Build the ingest client bound to one account's collect run.
 * @param options.workbench - the Workbench caller seam.
 * @param options.accountId - the collecting account.
 * @param options.attemptId - initial run attempt id（newAttempt=false 时复用）.
 * @param options.persistence - runs.json 写盘接缝（runId barrier）.
 * @param options.batchSize - batch size（1..50）.
 * @param options.retries - retry budget per operation.
 * @returns the ingest client.
 * @throws when batchSize is out of range (`batch_size_out_of_range`).
 */
export function createIngestClient(options: {
  workbench: IngestWorkbench
  accountId: string
  attemptId?: string
  persistence?: AttemptPersistence | undefined
  batchSize?: number
  retries?: number
}): IngestClient {
  const batchSize = options.batchSize ?? BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50) {
    throw new Error('batch_size_out_of_range')
  }
  const retries = options.retries ?? DEFAULT_RETRIES
  const accountId = options.accountId
  let runAttemptId = options.attemptId ?? attemptUuid()
  let runId: string | null = null
  let heartbeatSeq = 0
  let listMeta: { expectedWorkCount: number; listComplete: boolean; publishSince?: string | undefined } | null = null
  let onProgress: ((event: IngestEvent) => void) | undefined
  const emit = (event: IngestEvent): void => { onProgress?.(event) }
  const persist = async (): Promise<void> => {
    await options.persistence?.persistAttempt({ runAttemptId, runId, heartbeatSeq })
  }

  /** 一次工具调用的错误分类读出（stable code 由 errors.safeCode 收敛后进入）。 */
  const classify = (error: unknown): string => safeCode(error)

  /** withRetry：确定性直接抛；可恢复走 onRecover；其余指数退避；全部 ≤retries。 */
  const withRetry = async <T>(operation: () => Promise<T>, hooks: { onRecover?: (() => Promise<void>) | undefined } = {}): Promise<T> => {
    let attempt = 0
    for (;;) {
      try {
        return await operation()
      } catch (error) {
        const code = classify(error)
        if (DETERMINISTIC_ERRORS.has(code)) throw error
        if (RECOVERABLE_ERRORS.has(code) && hooks.onRecover !== undefined) {
          attempt += 1
          if (attempt > retries) throw error
          await hooks.onRecover()
          continue
        }
        attempt += 1
        if (attempt > retries) throw error
        await sleep(Math.min(8000, 500 * 2 ** (attempt - 1)))
      }
    }
  }

  const client: IngestClient = {
    get runId(): string | null { return runId },
    get heartbeatSeq(): number { return heartbeatSeq },
    setProgress(handler) { onProgress = handler },

    async startRun({ newAttempt }) {
      if (newAttempt) runAttemptId = attemptUuid()
      const idempotencyKey = runStartIdempotencyKey(runAttemptId)
      const outcome = await options.workbench.callTool('workbench_douyin_collect_run_start', { accountId, idempotencyKey })
      const payload = payloadOf(outcome)
      const run = (payload.run && typeof payload.run === 'object' ? payload.run : {}) as Record<string, unknown>
      const newRunId = typeof run.run_id === 'string' ? run.run_id : null
      if (newRunId === null) throw new Error('run_start_missing_run_id')
      const reused = runId === newRunId
      const reclaimedRunId = runId !== null && runId !== newRunId ? runId : null
      runId = newRunId
      const lastSeq = Number(run.last_heartbeat_seq ?? 0)
      heartbeatSeq = Number.isFinite(lastSeq) && lastSeq > 0 ? lastSeq : 0
      listMeta = null
      await persist()
      emit({ phase: 'run_started', runId, reused, ...(reclaimedRunId !== null ? { reclaimedRunId } : {}) })
      return { runId, reused }
    },

    async publishListMeta(meta) {
      if (runId === null) throw new Error('run_not_started')
      listMeta = meta
      const args: Record<string, unknown> = {
        runId,
        expectedWorkCount: meta.expectedWorkCount,
        listComplete: meta.listComplete,
        idempotencyKey: listMetaIdempotencyKey(runId),
      }
      // publishSince 仅真值时携带（undefined 属性会被宿主整调用拒绝）。
      if (meta.publishSince !== undefined && meta.publishSince !== null && meta.publishSince !== '') args.publishSince = meta.publishSince
      await withRetry(() => options.workbench.callTool('workbench_douyin_collect_run_set_list_meta', args))
      emit({ phase: 'list_meta', expectedWorkCount: meta.expectedWorkCount, listComplete: meta.listComplete, ...(meta.publishSince !== undefined ? { publishSince: meta.publishSince } : {}) })
    },

    async heartbeat() {
      if (runId === null) throw new Error('run_not_started')
      heartbeatSeq += 1
      await persist()
      await options.workbench.callTool('workbench_douyin_collect_run_heartbeat', {
        runId,
        heartbeatSeq,
        idempotencyKey: heartbeatIdempotencyKey(runId, heartbeatSeq),
      })
    },

    async ingestAll(works, batchOptions = {}) {
      if (runId === null) throw new Error('run_not_started')
      const batchLog: IngestBatchResult['batchLog'] = []
      const succeededWorkIds: string[] = []
      const failedWorkIds: string[] = []
      let replayedAny = false
      const totalBatches = Math.max(1, Math.ceil(works.length / batchSize))
      for (let offset = 0, batchNo = 1; offset < works.length || (works.length === 0 && batchNo === 1); offset += batchSize, batchNo += 1) {
        if (batchNo > MAX_BATCH_NO) throw new Error('batch_no_out_of_range')
        const slice = works.slice(offset, offset + batchSize)
        if (slice.length === 0) break
        const attempt = async (): Promise<void> => {
          const outcome = await options.workbench.callTool('workbench_douyin_collect_ingest_batch', {
            runId,
            accountId,
            batchNo,
            works: slice,
            idempotencyKey: ingestBatchIdempotencyKey(runId ?? '', batchNo),
          })
          const payload = payloadOf(outcome)
          const batch = (payload.batch && typeof payload.batch === 'object' ? payload.batch : {}) as Record<string, unknown>
          const succeeded = Array.isArray(batch.succeeded_work_ids) ? batch.succeeded_work_ids.map(String) : []
          const failed = Array.isArray(batch.failed_work_ids) ? batch.failed_work_ids.map(String) : []
          succeededWorkIds.push(...succeeded)
          failedWorkIds.push(...failed)
          if (payload.replayed === true) replayedAny = true
          batchLog.push({ batchNo, status: 'succeeded', error: null })
          emit({
            phase: 'batch_done', batchNo, totalBatches,
            succeeded: succeededWorkIds.length, failed: failedWorkIds.length,
            expected: batchOptions.observedCount ?? works.length,
          })
        }
        try {
          await withRetry(attempt, {
            onRecover: async () => {
              await client.startRun({ newAttempt: true })
              if (listMeta !== null) await client.publishListMeta(listMeta)
              emit({ phase: 'run_recovered', runId })
            },
          })
        } catch (error) {
          // 单批最终失败：记录后继续后续批（单批失败由服务端账本记 failed）。
          batchLog.push({ batchNo, status: 'failed', error: safeCode(error) })
          failedWorkIds.push(...slice.map(work => String(work.work_id ?? '')))
          emit({ phase: 'batch_failed', batchNo, reason: safeCode(error) })
        }
      }
      return { batchLog, succeededWorkIds, failedWorkIds, replayedAny }
    },

    async ingestDaily(daily, dailyOptions = {}) {
      if (runId === null) throw new Error('run_not_started')
      if (daily.length === 0) return { replayed: false, dailyAccepted: 0, skipped: 'no_daily_rows' }
      const args: Record<string, unknown> = {
        runId,
        accountId,
        daily,
        idempotencyKey: ingestDailyIdempotencyKey(runId),
      }
      // fansProfile 仅对象时携带。
      if (dailyOptions.fansProfile !== undefined && dailyOptions.fansProfile !== null && typeof dailyOptions.fansProfile === 'object') {
        args.fansProfile = dailyOptions.fansProfile
      }
      await withRetry(() => options.workbench.callTool('workbench_douyin_collect_ingest_daily', args))
      emit({ phase: 'daily_ingested', dailyAccepted: daily.length })
      return { replayed: false, dailyAccepted: daily.length }
    },

    async finish({ clientStatus, clientCounts }) {
      if (runId === null) throw new Error('run_not_started')
      const args: Record<string, unknown> = { runId, clientStatus, idempotencyKey: runFinishIdempotencyKey(runId) }
      if (clientCounts !== undefined && clientCounts !== null) args.clientCounts = clientCounts
      const outcome = await withRetry(() => options.workbench.callTool('workbench_douyin_collect_run_finish', args))
      const payload = payloadOf(outcome)
      const run = (payload.run && typeof payload.run === 'object' ? payload.run : {}) as Record<string, unknown>
      emit({ phase: 'finished', status: run.status ?? null, replayed: payload.replayed === true })
      return { run, replayed: payload.replayed === true }
    },

    async cancel() {
      if (runId === null) throw new Error('run_not_started')
      // G-1：编排内无调用点；保留幂等终止通道语义（键模板冻结）。
      await options.workbench.callTool('workbench_douyin_collect_run_cancel', {
        runId,
        idempotencyKey: `douyin:run_cancel:${runId}`,
      })
      emit({ phase: 'cancelled', runId })
    },
  }
  return client
}

/** ingestCollectedWorks 的注入。 */
export interface IngestDeps {
  client: IngestClient
  works: WorkPayloadLike[]
  listComplete: boolean
  expectedWorkCount: number
  publishSince: string | null
  dashboard: { dashboardRows: Record<string, unknown>[]; dashboardFansRows: Record<string, unknown>[]; fansProfile?: unknown; gaps?: { source: string; reason: string }[] }
  newAttempt?: boolean
  onProgress?: ((event: IngestEvent) => void) | undefined
  signal?: AbortSignal | undefined
}

/** 作品载荷的最小形状（parse.ts WorkPayload 的结构化子集）。 */
export interface WorkPayloadLike extends Record<string, unknown> {
  work_id: string
}

/** ingestCollectedWorks 的结果。 */
export interface IngestOutcome {
  runId: string | null
  ingest: IngestBatchResult | null
  finish: { run: Record<string, unknown>; replayed: boolean } | null
  dailyAccepted: number
  error: string | null
}

/**
 * 总入库编排：startRun → list_meta（失败即返回不进入结算）→ 分批 → daily
 * （失败/无行只记事件）→ finish。signal 中止抛错由调用方按取消收尾。
 */
export async function ingestCollectedWorks(deps: IngestDeps): Promise<IngestOutcome> {
  const client = deps.client
  client.setProgress(deps.onProgress)
  const started = await client.startRun({ newAttempt: deps.newAttempt ?? true })
  try {
    await client.publishListMeta({
      expectedWorkCount: deps.expectedWorkCount,
      listComplete: deps.listComplete,
      ...(deps.publishSince !== null && deps.publishSince !== '' ? { publishSince: deps.publishSince } : {}),
    })
  } catch (error) {
    // list_meta 失败不得进入结算（服务端 RUN_LIST_META_REQUIRED 会拒绝）。
    emitSafe(deps.onProgress, { phase: 'list_meta_failed', error: safeCode(error) })
    return { runId: started.runId, ingest: null, finish: null, dailyAccepted: 0, error: 'list_meta_failed' }
  }
  const ingest = deps.works.length > 0
    ? await client.ingestAll(deps.works, { observedCount: deps.expectedWorkCount })
    : { batchLog: [], succeededWorkIds: [], failedWorkIds: [], replayedAny: false }
  let dailyAccepted = 0
  const dailyRows = mergeDashboardRows(deps.dashboard.dashboardRows, deps.dashboard.dashboardFansRows)
  if (dailyRows.length > 0) {
    try {
      const outcome = await client.ingestDaily(dailyRows, { fansProfile: deps.dashboard.fansProfile })
      dailyAccepted = outcome.dailyAccepted
    } catch (error) {
      // daily 失败只记事件，不改变 clientStatus 与 run 终态。
      emitSafe(deps.onProgress, { phase: 'dashboard_gap', reason: safeCode(error) })
    }
  } else if ((deps.dashboard.gaps?.length ?? 0) > 0 || deps.dashboard.fansProfile !== undefined && deps.dashboard.fansProfile !== null) {
    emitSafe(deps.onProgress, { phase: 'dashboard_gap', reason: deps.dashboard.gaps?.map(gap => gap.reason).join(',') ?? 'fans_profile_without_daily' })
  }
  const succeeded = ingest.succeededWorkIds.length
  const failed = ingest.failedWorkIds.length
  const clientStatus = resolveClientStatus({
    listComplete: deps.listComplete,
    expected: deps.expectedWorkCount,
    succeeded,
    failed,
  })
  const finish = await client.finish({
    clientStatus,
    clientCounts: { expectedWorkCount: deps.expectedWorkCount, succeededWorkCount: succeeded, failedWorkCount: failed },
  })
  return { runId: started.runId, ingest, finish, dailyAccepted, error: null }
}

/** 旁路发射（onProgress 可能缺省）。 */
function emitSafe(onProgress: ((event: IngestEvent) => void) | undefined, event: IngestEvent): void {
  onProgress?.(event)
}
