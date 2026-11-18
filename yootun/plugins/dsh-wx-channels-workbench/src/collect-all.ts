/**
 * 一键采集全部（批量控制器）：账号间严格串行、与单账号采集互斥、单账号失败
 * 继续下一个、partial 单列一类。stop() 后当前账号收到 abort、后续账号标
 * skipped(cancelled)，当前账号 settle 后才 finished。每轮 probe/collect 前
 * 检查 stopRequested。phase 在当前账号 settle 前为 stopping。
 * @module
 */
import { safeCode } from './errors.ts'
import { BATCH_SKIP_REASONS } from './runner.ts'
import type { CollectResult } from './runner.ts'

/** 批量单账号条目投影。 */
export interface BatchItem {
  accountId: string
  status: 'ready' | 'probing' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped' | 'cancelled'
  reason: string | null
  runId: string | null
  startedAt: string | null
  finishedAt: string | null
}

/** 批量状态投影（collectAll.status）。 */
export interface BatchStatus {
  ready: boolean
  phase: string
  batchId: string | null
  items: BatchItem[]
  total: number
  currentAccountIndex: number
  currentAccountId: string | null
  currentRunId: string | null
  startedAt: string | null
  finishedAt: string | null
  completedCount: number
  partialCount: number
  failedCount: number
  skippedCount: number
  summary: string | null
}

interface BatchState {
  batchId: string
  phase: 'probing' | 'collecting' | 'stopping' | 'finished'
  items: BatchItem[]
  currentAccountIndex: number
  currentAccountId: string | null
  currentRunId: string | null
  startedAt: string
  finishedAt: string | null
  summary: string | null
  stopRequested: boolean
  controller: AbortController
}

/** batch controller 的返回接口（含 stop）。 */
export interface BatchController {
  readonly status: BatchStatus
  readonly running: boolean
  start(accountIds: string[]): Promise<{ started: boolean; reason?: string; batchId?: string; accounts?: number }>
  run(): Promise<void>
  stop(): void
}

/**
 * Build the serial batch controller.
 * @param options.collect - single-account collect；收到 signal 用于中止。
 * @param options.probe - session probe returning sessionStatus/reason.
 * @param options.logger - optional warn logger.
 * @returns the controller with status/running/start/stop.
 */
export function createBatchCollectController(options: {
  collect: (input: { accountId: string; signal: AbortSignal | undefined; onProgress?: ((event: Record<string, unknown>) => void) | undefined }) => Promise<CollectResult>
  probe: (accountId: string) => Promise<{ sessionStatus: string; reason: string | null }>
  logger?: { warn(message: string): void } | undefined
  /** 整次 batch run promise 交给调用方任务登记；dispose 等待它。 */
  trackRun?: ((promise: Promise<void>) => void) | undefined
}): BatchController {
  let state: BatchState | null = null
  let stopRequested = false
  let currentController: AbortController | undefined

  const project = (): BatchStatus => {
    if (state === null) {
      return { ready: true, phase: 'ready', batchId: null, items: [], total: 0, currentAccountIndex: -1, currentAccountId: null, currentRunId: null, startedAt: null, finishedAt: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, summary: null }
    }
    const counts = { completed: 0, partial: 0, failed: 0, skipped: 0, cancelled: 0 }
    for (const item of state.items) {
      const key = item.status as keyof typeof counts
      if (key in counts) counts[key] += 1
    }
    return {
      ready: state.phase === 'finished',
      phase: state.phase,
      batchId: state.batchId,
      items: state.items,
      total: state.items.length,
      currentAccountIndex: state.currentAccountIndex,
      currentAccountId: state.currentAccountId,
      currentRunId: state.currentRunId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      completedCount: counts.completed,
      partialCount: counts.partial,
      failedCount: counts.failed,
      skippedCount: counts.skipped + counts.cancelled,
      summary: state.summary,
    }
  }

  return {
    get status() { return project() },
    get running() { return state !== null && state.phase !== 'finished' },

    async start(accountIds: string[]): Promise<{ started: boolean; reason?: string; batchId?: string; accounts?: number }> {
      if (state !== null && state.phase !== 'finished') return { started: false, reason: 'collect_busy' }
      stopRequested = false
      currentController = undefined
      const controller = new AbortController()
      state = {
        batchId: `batch-${String(Date.now())}`,
        phase: 'probing',
        items: accountIds.map(accountId => ({ accountId, status: 'ready', reason: null, runId: null, startedAt: null, finishedAt: null })),
        currentAccountIndex: -1,
        currentAccountId: null,
        currentRunId: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: null,
        stopRequested: false,
        controller,
      }
      // 必须挂 catch：未捕获 rejection 会让批量停在非终态。整次 run promise
      // 交给调用方登记（dispose 等待当前账号与全部后续账号收敛）。
      const runPromise = this.run().catch((error: unknown) => {
        const reason = safeCode(error)
        options.logger?.warn(`wx batch ${state?.batchId}: unhandled ${reason}`)
        if (state !== null) {
          for (const item of state.items) {
            if (item.status === 'ready' || item.status === 'probing' || item.status === 'running') {
              item.status = state.stopRequested ? 'cancelled' : 'failed'
              item.reason = reason
              item.finishedAt = new Date().toISOString()
            }
          }
          if (state.phase !== 'finished') {
            state.phase = 'finished'
            state.finishedAt = new Date().toISOString()
          }
        }
      })
      options.trackRun?.(runPromise)
      return { started: true, batchId: state.batchId, accounts: accountIds.length }
    },

    /**
     * Stop the batch: abort current run via controller, mark subsequent
     * ready/probing accounts as skipped(cancelled). Phase → stopping, then
     * finished after the current account settles.
     */
    stop(): void {
      if (state === null || state.phase === 'finished') return
      stopRequested = true
      state.stopRequested = true
      if (state.phase !== 'stopping') state.phase = 'stopping'
      currentController?.abort()
      for (let index = state.currentAccountIndex + 1; index < state.items.length; index += 1) {
        const item = state.items[index]
        if (item === undefined) continue
        if (item.status === 'ready' || item.status === 'probing') {
          item.status = 'skipped'
          item.reason = 'cancelled'
          item.finishedAt = new Date().toISOString()
        }
      }
    },

    async run(): Promise<void> {
      if (state === null) return
      try {
        for (let index = 0; index < state.items.length; index += 1) {
          // stop 后不得启动后续账号。
          if (stopRequested) {
            const item = state.items[index]
            if (item !== undefined && (item.status === 'ready' || item.status === 'probing')) {
              item.status = 'skipped'
              item.reason = 'cancelled'
              item.finishedAt = new Date().toISOString()
            }
            continue
          }
          const item = state.items[index]
          if (item === undefined) continue
          state.currentAccountIndex = index
          state.currentAccountId = item.accountId
          state.phase = 'probing'
          item.status = 'probing'
          item.startedAt = new Date().toISOString()

          // probe 前检查 stop。
          if (stopRequested) {
            item.status = 'skipped'
            item.reason = 'cancelled'
            item.finishedAt = new Date().toISOString()
            continue
          }

          let probeResult: { sessionStatus: string; reason: string | null }
          try {
            probeResult = await options.probe(item.accountId)
          } catch (error) {
            probeResult = { sessionStatus: 'unknown', reason: safeCode(error) }
          }

          // probe settle 后再查 stop。
          if (stopRequested) {
            item.status = 'skipped'
            item.reason = 'cancelled'
            item.finishedAt = new Date().toISOString()
            continue
          }

          if (probeResult.sessionStatus === 'expired') {
            item.status = 'skipped'
            item.reason = probeResult.reason !== null && BATCH_SKIP_REASONS.has(probeResult.reason) ? probeResult.reason : 'session_required'
            state.currentAccountId = null
            continue
          }
          if (probeResult.sessionStatus === 'unknown') {
            item.status = 'skipped'
            item.reason = 'probe_failed'
            state.currentAccountId = null
            continue
          }

          state.phase = 'collecting'
          item.status = 'running'

          // collect 前检查 stop。
          if (stopRequested) {
            item.status = 'skipped'
            item.reason = 'cancelled'
            item.finishedAt = new Date().toISOString()
            continue
          }

          // 为当前账号创建 AbortController，传给 collect。
          currentController = new AbortController()
          let result: CollectResult
          try {
            result = await options.collect({
              accountId: item.accountId,
              signal: currentController.signal,
            })
          } catch (error) {
            result = { status: 'failed', runId: null, reason: safeCode(error) }
          } finally {
            currentController = undefined
          }

          item.runId = result.runId
          if (stopRequested) {
            item.status = result.status === 'completed' || result.status === 'partial' ? result.status : 'cancelled'
          } else {
            item.status = result.status === 'completed' || result.status === 'partial' ? result.status : 'failed'
          }
          item.reason = item.status === 'failed' ? result.reason ?? 'collect_failed' : null
          item.finishedAt = new Date().toISOString()
          state.currentAccountId = null
        }
      } finally {
        if (state !== null) {
          const counts = { completed: 0, partial: 0, failed: 0, skipped: 0, cancelled: 0 }
          for (const item of state.items) {
            const key = item.status as keyof typeof counts
            if (key in counts) counts[key] += 1
          }
          state.summary = `completed=${String(counts.completed)} partial=${String(counts.partial)} failed=${String(counts.failed)} skipped=${String(counts.skipped)} cancelled=${String(counts.cancelled)}`
          // 全部 settle 后才 finished（stop 后 stopping 阶段在此收敛）。
          state.phase = 'finished'
          state.finishedAt = new Date().toISOString()
        }
      }
    },
  }
}
