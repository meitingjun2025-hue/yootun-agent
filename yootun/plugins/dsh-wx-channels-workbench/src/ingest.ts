/**
 * 分批入库编排（移植旧 ingest.js 全语义，工具面改经 `ctx.yootunWorkbench`）：
 * run_start（runId 设备端 UUID）→ run_set_list_meta → ingest_works（≤20/批、
 * ≤3000 日行/批，失败对象同号 :retry{n} 重投）→ 账号级三类 → run_finish；异常
 * run_cancel 兜底。幂等与恢复：runAttemptId 持久化复用；确定性错误不重试；
 * RUN_NOT_RUNNING/RUN_NOT_FOUND → 重建 run 并重发列表元信息。
 * @module
 */
import { randomUUID } from 'node:crypto'
import type { WorkItem } from './collector.ts'
import { splitIngestBatches } from './collector.ts'
import { serverCodeOf, WxError } from './errors.ts'
import {
  heartbeatIdempotencyKey, ingestAccountMetricsIdempotencyKey, ingestFansProfileIdempotencyKey,
  ingestFansTrendIdempotencyKey, ingestWorksIdempotencyKey, listMetaIdempotencyKey,
  runCancelIdempotencyKey, runFinishIdempotencyKey, runStartIdempotencyKey,
} from './idempotency.ts'
import { getAccount, updateAccount } from './state.ts'

/** workbench 调用面（结构化最小面；真实服务满足）。 */
export interface WxWorkbenchFace {
  callTool(caller: 'wx-workbench', domain: 'wx', name: string, args: unknown, signal?: AbortSignal): Promise<{ structuredContent: unknown; content: unknown }>
}

export const DEFAULT_RETRIES = 3
/** 带失败对象的批次同号重投次数（服务端删旧行真实重做）。 */
export const FAILED_BATCH_RETRIES = 2

/** 不退避重试的确定性错误（重试也不会变好）。 */
const DETERMINISTIC_ERRORS = new Set([
  'RUN_ACCOUNT_MISMATCH', 'RUN_LIST_META_REQUIRED', 'HEARTBEAT_SEQ_REGRESSED', 'INVALID_IDEMPOTENCY_KEY',
  'CONFIRMATION_REQUIRED', 'LOCAL_CLEARED_REQUIRED', 'VALIDATION_ERROR', 'ACCOUNT_NOT_FOUND',
  'ACCOUNT_NOT_ACCESSIBLE', 'UNAUTHORIZED', 'PAYLOAD_TOO_LARGE', 'INVALID_DAY_RANGE', 'RUN_COUNT_MISMATCH',
  'WX_TOOL_UNAVAILABLE', 'IDEMPOTENCY_KEY_REQUIRED',
])
/** 需要重建运行的错误：租约过期/被回收/运行不存在。 */
const RECOVERABLE_ERRORS = new Set(['RUN_NOT_RUNNING', 'RUN_NOT_FOUND'])

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** 从 Workbench 失败中取服务端稳定码（未登记码按 WX_TOOL_UNAVAILABLE 收敛）。 */
function stableCodeOf(error: unknown): string {
  const server = serverCodeOf(error)
  if (server !== undefined) return server
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'WX_TOOL_UNAVAILABLE'
}

/** 把 ToolCallOutcome 的 structuredContent 投影为业务对象（非对象 → 空对象）。 */
function payloadOf(outcome: { structuredContent: unknown }): Record<string, unknown> {
  return outcome.structuredContent && typeof outcome.structuredContent === 'object' && !Array.isArray(outcome.structuredContent)
    ? outcome.structuredContent as Record<string, unknown>
    : {}
}

/** 一次采集 run 的客户端（workbench 调用编排器）。 */
export interface IngestClient {
  startRun(options: { newAttempt?: boolean; signal?: AbortSignal | undefined }): Promise<{ run: Record<string, unknown>; reused: boolean; reclaimedRunId: string | null }>
  publishListMeta(options: { expectedWorkCount: number; listComplete: boolean; signal: AbortSignal | undefined }): Promise<Record<string, unknown>>
  ingestAll(works: Array<WorkItem & { dailyMetrics?: unknown[] }>, options: { observedCount?: number; signal: AbortSignal | undefined }): Promise<IngestAllResult>
  ingestAccountMetrics(payload: { startDay: string; endDay: string; rows: DailyMetricRowIn[]; trafficSource?: unknown; signal: AbortSignal | undefined }): Promise<Record<string, unknown>>
  ingestFansTrend(payload: { startDay: string; endDay: string; rows: FansTrendRowIn[]; sourceTrend?: unknown; signal: AbortSignal | undefined }): Promise<Record<string, unknown>>
  ingestFansProfile(payload: Record<string, unknown> & { day: string; signal: AbortSignal | undefined }): Promise<Record<string, unknown>>
  heartbeat(signal: AbortSignal | undefined): Promise<Record<string, unknown>>
  finish(options: { clientStatus?: string; clientCounts?: Record<string, number> | null; accountMetricStatus?: string; fansTrendStatus?: string; fansProfileStatus?: string; signal: AbortSignal | undefined }): Promise<Record<string, unknown>>
  cancel(signal: AbortSignal | undefined): Promise<Record<string, unknown>>
  recoverRun(signal: AbortSignal | undefined): Promise<void>
  readonly runId: string | null
  readonly heartbeatSeq: number
}

type DailyMetricRowIn = Record<string, unknown>
type FansTrendRowIn = Record<string, unknown>

/** ingestAll 结果。 */
export interface IngestAllResult {
  runId: string
  batches: Array<{ batchNo: number; status: string; replayed: boolean; failedObjects: unknown[] }>
  succeededWorkIds: string[]
  failedWorkIds: string[]
}

/**
 * Build the ingest client over the Workbench face.
 * @param options.workbench - the Workbench connector face.
 * @param options.accountId - account id.
 * @param options.root - state root（runAttemptId/runId/heartbeatSeq 持久化）.
 * @param options.retries - transient retry budget.
 * @param options.sleep - sleep injection.
 * @param options.logger - optional warn logger.
 * @returns the ingest client.
 */
export function createIngestClient(options: {
  workbench: WxWorkbenchFace
  accountId: string
  root?: string
  retries?: number
  sleep?: ((ms: number) => Promise<void>) | undefined
  logger?: { warn(message: string): void } | undefined
}): IngestClient {
  const accountId = options.accountId
  const root = options.root
  const retries = options.retries ?? DEFAULT_RETRIES
  const sleepImpl = options.sleep ?? sleep
  const logger = options.logger ?? null
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> =>
    payloadOf(await options.workbench.callTool('wx-workbench', 'wx', name, args, signal))

  let runId: string | null = null
  let runAttemptId: string | null = null
  let heartbeatSeq = 0
  let listMeta: { expectedWorkCount: number; listComplete: boolean } | null = null
  /** attempt → runId 同进程映射：同一「用户点击」内重试复用同一 runId。 */
  const runIdByAttempt = new Map<string, string>()

  async function loadAttempt(): Promise<string | null> {
    const record = await getAccount(options.accountId, root).catch(() => undefined)
    return record?.runAttemptId ?? null
  }

  async function persistAttempt(attemptId: string, newRunId: string, seq?: number): Promise<void> {
    const patch: Record<string, unknown> = { runAttemptId: attemptId, runId: newRunId }
    if (seq !== undefined) patch.heartbeatSeq = Number(seq)
    await updateAccount(options.accountId, patch, root)
  }

  /**
   * 建立（或复用）运行。runId 由设备端 UUID 生成；同账号已有未过期 running run
   * （不同 runId）时服务端返回现有 run（reused）。
   */
  async function startRun(runOptions: { newAttempt?: boolean; signal: AbortSignal | undefined }): Promise<{ run: Record<string, unknown>; reused: boolean; reclaimedRunId: string | null }> {
    const newAttempt = runOptions.newAttempt ?? false
    const signal = runOptions.signal
    let attemptId = newAttempt ? null : await loadAttempt()
    if (!attemptId) attemptId = randomUUID()
    runAttemptId = attemptId
    let nextRunId = runIdByAttempt.get(attemptId)
    if (!nextRunId || newAttempt) {
      nextRunId = randomUUID()
      runIdByAttempt.set(attemptId, nextRunId)
    }
    const result = await call('workbench_wx_collect_run_start', {
      accountId: accountId,
      runId: nextRunId,
      idempotencyKey: runStartIdempotencyKey(nextRunId),
    }, signal)
    const run = result.run && typeof result.run === 'object' ? result.run as Record<string, unknown> : {}
    runId = typeof run.run_id === 'string' ? run.run_id : nextRunId
    heartbeatSeq = Number(run.heartbeat_seq ?? 0)
    await persistAttempt(attemptId, runId, heartbeatSeq)
    listMeta = null
    return { run, reused: result.reused === true, reclaimedRunId: typeof result.reclaimedRunId === 'string' ? result.reclaimedRunId : null }
  }

  /** 分页结束后写入列表元信息（幂等键固定为 runId）。 */
  async function publishListMeta(options: { expectedWorkCount: number; listComplete: boolean; signal: AbortSignal | undefined }): Promise<Record<string, unknown>> {
    const expectedWorkCount = options.expectedWorkCount
    const complete = options.listComplete
    const signal = options.signal
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    const result = await call('workbench_wx_collect_run_set_list_meta', {
      runId,
      expectedWorkCount,
      listComplete: complete,
      idempotencyKey: listMetaIdempotencyKey(runId),
    }, signal)
    listMeta = { expectedWorkCount, listComplete: complete }
    return result
  }

  /** 心跳：序号单调递增并持久化（默认编排不调用，租约由 ingest 批次续期）。 */
  async function heartbeat(signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (runId === null || runAttemptId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    heartbeatSeq += 1
    await persistAttempt(runAttemptId, runId, heartbeatSeq)
    return call('workbench_wx_collect_run_heartbeat', {
      runId,
      heartbeatSeq,
      idempotencyKey: heartbeatIdempotencyKey(runId, heartbeatSeq),
    }, signal)
  }

  /**
   * 分批写入全部作品：切批后逐批重试；带失败对象批次同号 :retry{n} 重投；批次级
   * 传输失败不计入客户端 failed（否则 finish RUN_COUNT_MISMATCH 卡死 run）。
   */
  async function ingestAll(works: Array<WorkItem & { dailyMetrics?: unknown[] }>, options: { observedCount?: number; signal: AbortSignal | undefined }): Promise<IngestAllResult> {
    const observedCount = options.observedCount ?? works.length
    const signal = options.signal
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    const batches = splitIngestBatches(works)
    const succeeded = new Set<string>()
    const failed = new Set<string>()
    const batchResults: IngestAllResult['batches'] = []

    for (const batch of batches) {
      const { batchNo } = batch
      let result: Record<string, unknown> | null = null
      try {
        result = await withRetry(() => call('workbench_wx_collect_ingest_works', {
          runId,
          batchNo,
          works: batch.works,
          totalDailyMetricRows: batch.totalDailyMetricRows,
          observedCount,
          idempotencyKey: ingestWorksIdempotencyKey(runId as string, batchNo),
        }, signal), signal, `batch ${String(batchNo)}`, () => recoverRun(signal))
      } catch (error) {
        if (signal?.aborted === true) throw error
        batchResults.push({ batchNo, status: 'failed', replayed: false, failedObjects: [] })
        continue
      }
      let payload = result.batch && typeof result.batch === 'object' ? result.batch as Record<string, unknown> : {}
      for (let attempt = 1; attempt <= FAILED_BATCH_RETRIES; attempt += 1) {
        const failedNow = Array.isArray(payload.failed_objects) ? payload.failed_objects.length : 0
        if (!failedNow) break
        try {
          result = await withRetry(() => call('workbench_wx_collect_ingest_works', {
            runId,
            batchNo,
            works: batch.works,
            totalDailyMetricRows: batch.totalDailyMetricRows,
            observedCount,
            idempotencyKey: `${ingestWorksIdempotencyKey(runId as string, batchNo)}:retry${String(attempt)}`,
          }, signal), signal, `batch ${String(batchNo)} retry`, () => recoverRun(signal))
          payload = result.batch && typeof result.batch === 'object' ? result.batch as Record<string, unknown> : {}
        } catch (error: unknown) {
          // 重投失败：保留既有 failed_objects 结果。
          void error
          break
        }
      }
      for (const workId of Array.isArray(payload.succeeded_objects) ? payload.succeeded_objects as string[] : []) {
        succeeded.add(workId)
        failed.delete(workId)
      }
      for (const workId of Array.isArray(payload.failed_objects) ? payload.failed_objects as string[] : []) failed.add(workId)
      batchResults.push({
        batchNo,
        status: typeof payload.batch_status === 'string' ? payload.batch_status : 'succeeded',
        replayed: result.replayed === true,
        failedObjects: Array.isArray(payload.failed_objects) ? payload.failed_objects as unknown[] : [],
      })
    }

    return { runId: runId as string, batches: batchResults, succeededWorkIds: [...succeeded], failedWorkIds: [...failed] }
  }

  /** 账号级聚合入库：trafficSource 挂窗口末日行，其余行为 NULL。 */
  async function ingestAccountMetrics(payload: { startDay: string; endDay: string; rows: DailyMetricRowIn[]; trafficSource?: unknown; signal: AbortSignal | undefined }): Promise<Record<string, unknown>> {
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) return { replayed: false, skipped: 'no_rows' }
    let metrics = payload.rows
    const source = payload.trafficSource as { rows?: unknown[] } | undefined
    if (source && source.rows) {
      metrics = payload.rows.map((row, index) => (index === payload.rows.length - 1 ? { ...row, trafficSource: payload.trafficSource } : row))
    }
    return withRetry(() => call('workbench_wx_collect_ingest_account_metrics', {
      runId,
      startDay: payload.startDay,
      endDay: payload.endDay,
      metrics,
      idempotencyKey: ingestAccountMetricsIdempotencyKey(runId as string, payload.startDay, payload.endDay),
    }, payload.signal), payload.signal, 'ingest_account_metrics', () => recoverRun(payload.signal))
  }

  /** fans_trend 入库：sourceTrend 按日挂载。 */
  async function ingestFansTrend(payload: { startDay: string; endDay: string; rows: FansTrendRowIn[]; sourceTrend?: unknown; signal: AbortSignal | undefined }): Promise<Record<string, unknown>> {
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    if (!Array.isArray(payload.rows) || payload.rows.length === 0) return { replayed: false, skipped: 'no_rows' }
    const daily = attachFansSourceTrend(payload.rows, payload.sourceTrend)
    return withRetry(() => call('workbench_wx_collect_ingest_fans_trend', {
      runId,
      startDay: payload.startDay,
      endDay: payload.endDay,
      daily,
      idempotencyKey: ingestFansTrendIdempotencyKey(runId as string, payload.startDay, payload.endDay),
    }, payload.signal), payload.signal, 'ingest_fans_trend', () => recoverRun(payload.signal))
  }

  /** fans_profile 入库（day=latestCompletedDay）。 */
  async function ingestFansProfile(payload: Record<string, unknown> & { day: string; signal: AbortSignal | undefined }): Promise<Record<string, unknown>> {
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    if (!payload || !payload.day) return { replayed: false, skipped: 'no_payload' }
    return withRetry(() => call('workbench_wx_collect_ingest_fans_profile', {
      runId,
      day: payload.day,
      age: payload.age ?? undefined,
      gender: payload.gender ?? undefined,
      province: payload.province ?? undefined,
      city: payload.city ?? undefined,
      device: payload.device ?? undefined,
      dataGap: payload.dataGap && Object.keys(payload.dataGap as Record<string, unknown>).length ? payload.dataGap : undefined,
      idempotencyKey: ingestFansProfileIdempotencyKey(runId as string, payload.day),
    }, payload.signal), payload.signal, 'ingest_fans_profile', () => recoverRun(payload.signal))
  }

  /** 结束运行：clientCounts 嵌套；服务端按账本复核，不一致 RUN_COUNT_MISMATCH。 */
  async function finish(options: {
    clientStatus?: string
    clientCounts?: Record<string, number> | null
    accountMetricStatus?: string
    fansTrendStatus?: string
    fansProfileStatus?: string
    signal: AbortSignal | undefined
  }): Promise<Record<string, unknown>> {
    const { clientStatus = 'completed', clientCounts = null, accountMetricStatus = 'not_collected', fansTrendStatus = 'not_collected', fansProfileStatus = 'not_collected', signal } = options
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    const requestBody: Record<string, unknown> = {
      runId,
      clientStatus,
      accountMetricStatus,
      fansTrendStatus,
      fansProfileStatus,
      idempotencyKey: runFinishIdempotencyKey(runId),
    }
    if (clientCounts !== null && clientCounts !== undefined) requestBody.clientCounts = clientCounts
    return withRetry(() => call('workbench_wx_collect_run_finish', requestBody, signal), signal, 'run_finish', null)
  }

  /** 幂等终止（异常兜底）；此后可 startRun({ newAttempt: true })。 */
  async function cancel(signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
    if (runId === null) throw new WxError('WX_RUN_INTERRUPTED', 'run_not_started')
    return call('workbench_wx_collect_run_cancel', {
      runId,
      idempotencyKey: runCancelIdempotencyKey(runId),
    }, signal)
  }

  /** 租约过期/运行被回收后的恢复：新建 run 并重发列表元信息。 */
  async function recoverRun(signal: AbortSignal | undefined): Promise<void> {
    const previousMeta = listMeta
    await startRun({ newAttempt: true, signal })
    if (previousMeta) await publishListMeta({ ...previousMeta, signal })
  }

  async function withRetry(operation: () => Promise<Record<string, unknown>>, signal: AbortSignal | undefined, label: string, onRecover: (() => Promise<void>) | null): Promise<Record<string, unknown>> {
    let attempt = 0
    for (;;) {
      try {
        return await operation()
      } catch (error) {
        if (signal?.aborted === true) throw error
        const code = stableCodeOf(error)
        if (DETERMINISTIC_ERRORS.has(code)) throw error
        if (RECOVERABLE_ERRORS.has(code) && onRecover !== null) {
          attempt += 1
          if (attempt > retries) throw error
          logger?.warn(`wx ingest ${label}: ${code} → recovering run`)
          await onRecover()
          continue
        }
        attempt += 1
        if (attempt > retries) throw error
        const delay = Math.min(8000, 500 * 2 ** (attempt - 1))
        logger?.warn(`wx ingest ${label}: ${code} → retry ${String(attempt)} in ${String(delay)}ms`)
        await sleepImpl(delay)
      }
    }
  }

  return {
    startRun,
    publishListMeta,
    ingestAll,
    ingestAccountMetrics,
    ingestFansTrend,
    ingestFansProfile,
    heartbeat,
    finish,
    cancel,
    recoverRun,
    get runId() { return runId },
    get heartbeatSeq() { return heartbeatSeq },
  }
}

/** 一次完整采集的入库编排：run_start → meta → works → 账号级三类 → finish。 */
export async function ingestCollectedData(options: {
  client: IngestClient
  works: Array<WorkItem & { dailyMetrics?: unknown[] }>
  listComplete: boolean
  expectedWorkCount?: number
  newAttempt?: boolean
  onProgress?: ((event: Record<string, unknown>) => void) | undefined
  accountLevel?: {
    accountMetrics: { startDay: string; endDay: string; rows: DailyMetricRowIn[]; trafficSource?: unknown } | null
    fansTrend: { daily: FansTrendRowIn[]; sourceTrend?: unknown } | null
    fansProfile: Record<string, unknown> | null
  } | undefined
  signal: AbortSignal | undefined
}): Promise<{ runId: string; ingest: IngestAllResult | null; finish: Record<string, unknown> | null; error: string | null }> {
  const { client, signal } = options
  const emit = (event: Record<string, unknown>): void => { options.onProgress?.(event) }
  const expectedWorkCount = options.expectedWorkCount ?? options.works.length
  const started = await client.startRun({ newAttempt: options.newAttempt ?? true, signal })
  const runId = typeof started.run.run_id === 'string' ? started.run.run_id : ''
  // run_started 事件：消费方（runner）借此在 run_start 返回后立即持久化远端
  // runId——此后崩溃/取消，runs.json 都能关联远端 run。
  if (runId !== '') emit({ phase: 'run_started', runId })
  try {
    try {
      await client.publishListMeta({ expectedWorkCount, listComplete: options.listComplete, signal })
    } catch (error) {
      emit({ phase: 'list_meta_failed', error: stableCodeOf(error) })
      // 清理 cancel 不复用 caller signal（可能已 aborted）；connector 自身 timeout 兜底。
      try {
        await client.cancel(undefined)
      } catch (cleanupError: unknown) {
        void cleanupError
      }
      return { runId, ingest: null, finish: null, error: stableCodeOf(error) }
    }

    const ingest = options.works.length
      ? await client.ingestAll(options.works, { observedCount: expectedWorkCount, signal })
      : { runId, batches: [], succeededWorkIds: [], failedWorkIds: [] }
    // 批次进度补发：ingestAll 返回后按批各发一个 batch_done（总批数与
    // succeeded/failed 全局值在返回后才可知，故非实时逐批；空 works 无批次
    // 事件）。进度投影语义为「最后事件生效」，落盘结果与实时逐批一致。
    for (const batch of ingest.batches) {
      emit({
        phase: 'batch_done',
        batchNo: batch.batchNo,
        totalBatches: ingest.batches.length,
        succeeded: ingest.succeededWorkIds.length,
        failed: ingest.failedWorkIds.length,
        expected: expectedWorkCount,
      })
    }

    const segmentStatus = { accountMetricStatus: 'not_collected', fansTrendStatus: 'not_collected', fansProfileStatus: 'not_collected' }
    const accountLevel = options.accountLevel
    if (accountLevel) {
      const metrics = accountLevel.accountMetrics
      if (metrics && Array.isArray(metrics.rows) && metrics.rows.length) {
        try {
          await client.ingestAccountMetrics({ ...metrics, signal })
          segmentStatus.accountMetricStatus = 'completed'
        } catch (error) {
          segmentStatus.accountMetricStatus = 'failed'
          emit({ phase: 'segment_gap', segment: 'account_metrics', reason: stableCodeOf(error) })
        }
      }
      const trend = accountLevel.fansTrend
      if (trend && Array.isArray(trend.daily) && trend.daily.length) {
        const rowsByDay = [...trend.daily].sort((a, b) => (String(a.day) < String(b.day) ? -1 : String(a.day) > String(b.day) ? 1 : 0))
        const chunkSize = 30
        let failedChunks = 0
        for (let offset = 0; offset < rowsByDay.length; offset += chunkSize) {
          const chunk = rowsByDay.slice(offset, offset + chunkSize)
          try {
            await client.ingestFansTrend({
              startDay: String(chunk[0]?.day ?? ''),
              endDay: String(chunk[chunk.length - 1]?.day ?? ''),
              rows: chunk,
              sourceTrend: trend.sourceTrend ?? null,
              signal,
            })
          } catch (error) {
            failedChunks += 1
            emit({ phase: 'segment_gap', segment: 'fans_trend', reason: stableCodeOf(error) })
          }
        }
        segmentStatus.fansTrendStatus = failedChunks ? 'failed' : 'completed'
      }
      const portrait = accountLevel.fansProfile
      if (portrait && typeof portrait.day === 'string' && portrait.day !== '') {
        try {
          await client.ingestFansProfile({ ...portrait, day: portrait.day, signal })
          segmentStatus.fansProfileStatus = 'completed'
        } catch (error) {
          segmentStatus.fansProfileStatus = 'failed'
          emit({ phase: 'segment_gap', segment: 'fans_profile', reason: stableCodeOf(error) })
        }
      }
    }

    const clientStatus = resolveClientStatus({ listComplete: options.listComplete, expected: expectedWorkCount, ingest })
    // finish 前的收尾事件（消费方投影为 finishing 进度）。
    emit({ phase: 'finished' })
    const finish = await client.finish({
      clientStatus,
      clientCounts: {
        expectedWorkCount,
        succeededWorkCount: ingest.succeededWorkIds.length,
        failedWorkCount: ingest.failedWorkIds.length,
      },
      ...segmentStatus,
      signal,
    })
    return { runId, ingest, finish, error: null }
  } catch (error) {
    // 异常兜底：显式取消 run（独立 signal，不复用可能已 aborted 的 caller signal）。
    emit({ phase: 'run_cancel_on_error', error: stableCodeOf(error) })
    try { await client.cancel(undefined) } catch (cleanupError: unknown) { void cleanupError }
    throw error
  }
}

/** 客户端上报状态仅作参考：服务端以账本重算并复核计数。 */
export function resolveClientStatus(options: { listComplete: boolean; expected: number; ingest: { succeededWorkIds: string[]; failedWorkIds: string[] } }): string {
  const succeeded = new Set(options.ingest.succeededWorkIds).size
  if (!options.listComplete) return 'partial'
  if (succeeded === options.expected) return 'completed'
  if (options.expected > 0 && succeeded === 0) return 'failed'
  return 'partial'
}

/** 把来源趋势按日挂到 daily[].source_trend。 */
function attachFansSourceTrend(rows: FansTrendRowIn[], sourceTrend: unknown): FansTrendRowIn[] {
  const trendRows = sourceTrend && typeof sourceTrend === 'object' && Array.isArray((sourceTrend as { rows?: unknown }).rows)
    ? (sourceTrend as { rows: Array<Record<string, unknown>> }).rows
    : []
  if (!trendRows.length) return rows
  const byDay = new Map<string, unknown[]>()
  for (const row of trendRows) {
    for (const point of Array.isArray(row.daily) ? row.daily as Array<Record<string, unknown>> : []) {
      if (!point || !point.day) continue
      const list = byDay.get(String(point.day)) ?? []
      list.push({ sourceType: row.sourceType, sourceKey: row.sourceKey, name: row.name, add: point.add })
      byDay.set(String(point.day), list)
    }
  }
  return rows.map(row => {
    const items = byDay.get(String(row.day))
    return items && items.length ? { ...row, sourceTrend: { rows: items } } : row
  })
}
