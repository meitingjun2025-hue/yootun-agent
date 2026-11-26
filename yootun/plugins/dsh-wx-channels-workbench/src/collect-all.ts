/**
 * 一键采集全部（批量控制器）：阶段 1 逐个账号串行探测（口径不变）；阶段 2
 * worker 队列按并发度采集 ready 账号——第 k 个 worker 首取前错峰等待、批内
 * 风控熔断（信号达到阈值即暂停剩余账号）。与单账号采集互斥、单账号失败继续
 * 取号、partial 单列一类。stop() 后在途账号收到 abort 并按 collect_cancelled
 * 结算、没有 worker 再取新账号，全部 settle 后 finished；phase 在全部 settle
 * 前为 stopping。
 * @module
 */
import { safeCode } from './errors.ts'
import { BATCH_SKIP_REASONS } from './runner.ts'
import type { CollectResult } from './runner.ts'

/** 批量采集并发缺省值（Config.batchConcurrency 未传时的运行时兜底）。 */
const DEFAULT_BATCH_CONCURRENCY = 3
/** worker 启动错峰：第 k 个 worker 首取前等待 k ×（基数 + rand×跨度）毫秒。 */
const BATCH_STAGGER_BASE_MS = 3_000
const BATCH_STAGGER_SPREAD_MS = 5_000
/** 相邻取号间隔上限（rand×跨度毫秒）。 */
const BATCH_TAKE_GAP_MS = 3_000
/** 批内熔断阈值：同批风控信号达到该数量即暂停剩余账号。 */
const BATCH_RISK_PAUSE_THRESHOLD = 2

/** 可被 signal 立即打断的等待（取号间隔接缝）：批次取消时提前返回。 */
const interruptibleSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal?.aborted === true) { resolve(); return }
  const wake = (): void => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', wake)
    resolve()
  }
  const timer = setTimeout(wake, ms)
  signal?.addEventListener('abort', wake, { once: true })
})

/** 批量单账号条目投影。 */
export interface BatchItem {
  accountId: string
  status: 'ready' | 'probing' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped'
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
  /** 运行中的账号（按启动顺序；终态后为空数组）。 */
  runningAccountIds: string[]
  /** 生效并发度 = min(配置并发度, 阶段 1 通过的账号数)；未启动过的空状态为 0。 */
  concurrency: number
  /** 批次级原因：risk_paused / collect_cancelled / no_eligible_account；正常终态为 null。 */
  error: string | null
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
  runningAccountIds: string[]
  concurrency: number
  error: string | null
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
  start(accountIds: string[]): Promise<{ started: boolean; reason?: string; batchId?: string; accounts?: number; runPromise?: Promise<void> }>
  run(): Promise<void>
  stop(): void
}

/**
 * Build the concurrent batch controller: serial probes first, then a worker
 * queue over the ready accounts.
 * @param options.collect - single-account collect controller facade；批量内部
 *   启动带 `fromBatch: true`（不受批量互斥拦截），`signal` 用于中止在途账号。
 * @param options.probe - session probe returning sessionStatus/reason.
 * @param options.logger - optional warn logger.
 * @param options.trackRun - 整次 batch run promise 交给调用方任务登记；dispose 等待它。
 * @param options.concurrency - 阶段 2 worker 数（Config.batchConcurrency；缺省 3）。
 * @param options.rand - 随机数接缝（返回 [0,1)；错峰与取号间隔抖动；测试注入定值）。
 * @param options.sleep - 等待接缝（毫秒；可被批次 signal 打断；测试注入零等待）。
 * @returns the controller with status/running/start/stop.
 */
export function createBatchCollectController(options: {
  collect: {
    start(input: { accountId: string; signal?: AbortSignal; fromBatch?: boolean }): Promise<{ started: boolean; reason?: string }>
    wait(accountId: string): Promise<CollectResult | null>
    hasRunning(): boolean
  }
  probe: (accountId: string) => Promise<{ sessionStatus: string; reason: string | null }>
  logger?: { warn(message: string): void } | undefined
  trackRun?: ((promise: Promise<void>) => void) | undefined
  concurrency?: number | undefined
  rand?: (() => number) | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
}): BatchController {
  let state: BatchState | null = null

  const project = (): BatchStatus => {
    if (state === null) {
      return {
        ready: true, phase: 'ready', batchId: null, items: [], total: 0, currentAccountIndex: -1,
        currentAccountId: null, currentRunId: null, runningAccountIds: [], concurrency: 0, error: null,
        startedAt: null, finishedAt: null, completedCount: 0, partialCount: 0, failedCount: 0,
        skippedCount: 0, summary: null,
      }
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
      runningAccountIds: state.runningAccountIds,
      concurrency: state.concurrency,
      error: state.error,
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

    async start(accountIds: string[]): Promise<{ started: boolean; reason?: string; batchId?: string; accounts?: number; runPromise?: Promise<void> }> {
      if (state !== null && state.phase !== 'finished') return { started: false, reason: 'collect_busy' }
      const controller = new AbortController()
      state = {
        batchId: `batch-${String(Date.now())}`,
        phase: 'probing',
        // items 按 accountId 排序：阶段 1 探测与阶段 2 取号顺序由此确定（附录 A.2）。
        items: [...accountIds].sort((a, b) => a.localeCompare(b)).map(accountId => ({ accountId, status: 'ready', reason: null, runId: null, startedAt: null, finishedAt: null })),
        currentAccountIndex: -1,
        currentAccountId: null,
        currentRunId: null,
        runningAccountIds: [],
        concurrency: 0,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        summary: null,
        stopRequested: false,
        controller,
      }
      // 必须挂 catch：未捕获 rejection 会让批量停在非终态。整次 run promise
      // 交给调用方登记（dispose 等待全部在途账号与取号等待收敛）。
      const runPromise = this.run().catch((error: unknown) => {
        const reason = safeCode(error)
        options.logger?.warn(`wx batch ${state?.batchId}: unhandled ${reason}`)
        if (state !== null) {
          for (const item of state.items) {
            if (item.status === 'ready' || item.status === 'probing' || item.status === 'running') {
              item.status = 'failed'
              item.reason = reason
              item.finishedAt = new Date().toISOString()
            }
          }
          state.runningAccountIds = []
          state.currentAccountId = null
          state.error = reason
          if (state.phase !== 'finished') {
            state.phase = 'finished'
            state.finishedAt = new Date().toISOString()
          }
        }
      })
      options.trackRun?.(runPromise)
      return { started: true, batchId: state.batchId, accounts: accountIds.length, runPromise }
    },

    /**
     * Stop the batch: abort in-flight accounts via the batch signal; waiting
     * workers stop taking new accounts and every not-yet-started item settles
     * failed/collect_cancelled once the workers join. Phase → stopping, then
     * finished after all accounts settle.
     */
    stop(): void {
      if (state === null || state.phase === 'finished') return
      state.stopRequested = true
      if (state.phase !== 'stopping') state.phase = 'stopping'
      state.controller.abort()
    },

    async run(): Promise<void> {
      // let 捕获变量的收窄不跨 await：进入即快照到 const。
      const current = state
      if (current === null) return
      const cancelled = (): boolean => current.stopRequested || current.controller.signal.aborted
      const failItem = (item: BatchItem, reason: string): void => {
        item.status = 'failed'
        item.reason = reason
        item.finishedAt = new Date().toISOString()
      }
      const failRest = (reason: string): void => {
        for (const item of current.items) {
          if (item.status === 'ready' || item.status === 'probing') failItem(item, reason)
        }
      }
      try {
        // 阶段 1：逐个账号串行探测（实测 + 上报口径不变）。
        current.phase = 'probing'
        for (let index = 0; index < current.items.length; index += 1) {
          const item = current.items[index]
          if (item === undefined || item.status !== 'ready') continue
          if (cancelled()) { failItem(item, 'collect_cancelled'); continue }
          current.currentAccountIndex = index
          item.status = 'probing'
          item.startedAt = new Date().toISOString()

          let probeResult: { sessionStatus: string; reason: string | null }
          try {
            probeResult = await options.probe(item.accountId)
          } catch (error) {
            probeResult = { sessionStatus: 'unknown', reason: safeCode(error) }
          }

          // probe settle 后再查取消：取消条目不再消费探测结果。
          if (cancelled()) { failItem(item, 'collect_cancelled'); continue }
          if (probeResult.sessionStatus === 'expired') {
            item.status = 'skipped'
            item.reason = probeResult.reason !== null && BATCH_SKIP_REASONS.has(probeResult.reason) ? probeResult.reason : 'session_required'
            item.finishedAt = new Date().toISOString()
            continue
          }
          if (probeResult.sessionStatus === 'unknown') {
            item.status = 'skipped'
            item.reason = 'probe_failed'
            item.finishedAt = new Date().toISOString()
            continue
          }
          // 实测通过：进入待取号集合（阶段 2 worker 从这里并发取号）。
          item.status = 'ready'
          item.reason = null
        }
        if (cancelled()) {
          failRest('collect_cancelled')
          current.error = 'collect_cancelled'
          return
        }
        const runnable = current.items.filter(item => item.status === 'ready')
        if (runnable.length === 0) {
          // 全部被探测拦截：绝不伪装完成。
          current.error = 'no_eligible_account'
          return
        }

        // 阶段 2：受控并发 collecting（worker 队列共享取号游标；同账号仍单飞）。
        current.phase = 'collecting'
        const concurrency = Math.max(1, options.concurrency ?? DEFAULT_BATCH_CONCURRENCY)
        const workerCount = Math.min(concurrency, runnable.length)
        current.concurrency = workerCount
        const rand = options.rand ?? Math.random
        const sleepFor = options.sleep ?? interruptibleSleep
        let nextIndex = 0
        let riskSignals = 0
        let paused = false
        const updateCurrentAccount = (): void => {
          current.currentAccountId = current.runningAccountIds[0] ?? null
        }
        const releaseRunning = (accountId: string): void => {
          const at = current.runningAccountIds.indexOf(accountId)
          if (at >= 0) current.runningAccountIds.splice(at, 1)
          updateCurrentAccount()
        }
        // 风控信号：探测通过后采集途中会话失效（runCollection 失败原因承载）。
        const isRiskSignal = (result: CollectResult | null): boolean =>
          result !== null && result.status === 'failed' && (result.reason === 'session_expired' || result.reason === 'probe_failed')
        const pauseRest = (): void => {
          current.error = 'risk_paused'
          const pausedAt = new Date().toISOString()
          for (const item of runnable) {
            if (item.status === 'ready') {
              item.status = 'skipped'
              item.reason = 'risk_paused'
              item.finishedAt = pausedAt
            }
          }
        }
        const runWorker = async (workerIndex: number): Promise<void> => {
          let firstTake = true
          for (;;) {
            if (paused || cancelled() || nextIndex >= runnable.length) return
            // 启动错峰：首取 workerIndex × 随机 3–8 秒，其后取号间隔随机 0–3 秒；
            // 等待可被批次 signal 立即打断。
            const delay = firstTake
              ? workerIndex * (BATCH_STAGGER_BASE_MS + rand() * BATCH_STAGGER_SPREAD_MS)
              : rand() * BATCH_TAKE_GAP_MS
            firstTake = false
            await sleepFor(delay, current.controller.signal)
            if (paused || cancelled() || nextIndex >= runnable.length) return
            const item = runnable[nextIndex]
            if (item === undefined) return
            nextIndex += 1
            item.status = 'running'
            current.runningAccountIds.push(item.accountId)
            updateCurrentAccount()
            const started = await options.collect.start({ accountId: item.accountId, signal: current.controller.signal, fromBatch: true })
            if (!started.started) {
              failItem(item, started.reason ?? 'collect_failed')
              releaseRunning(item.accountId)
              continue
            }
            const result = await options.collect.wait(item.accountId)
            // 与单账号同口径：部分失败绝不伪装成整体成功；取消在途条目
            // failed / collect_cancelled（与抖音同口径）。
            const outcome = result !== null && (result.status === 'completed' || result.status === 'partial') ? result.status : 'failed'
            item.runId = result?.runId ?? null
            if (cancelled()) {
              failItem(item, 'collect_cancelled')
            } else {
              item.status = outcome
              item.reason = outcome === 'failed' ? result?.reason ?? 'collect_failed' : null
              item.finishedAt = new Date().toISOString()
            }
            releaseRunning(item.accountId)
            // 取消导致的失败不计入风控信号；阈值达到即熔断，已运行账号正常结束。
            if (!cancelled() && isRiskSignal(result)) {
              riskSignals += 1
              if (riskSignals >= BATCH_RISK_PAUSE_THRESHOLD && !paused) {
                paused = true
                pauseRest()
              }
            }
          }
        }
        const workers: Promise<void>[] = []
        for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) workers.push(runWorker(workerIndex))
        await Promise.all(workers)
        if (cancelled()) {
          failRest('collect_cancelled')
          current.error = 'collect_cancelled'
          return
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
