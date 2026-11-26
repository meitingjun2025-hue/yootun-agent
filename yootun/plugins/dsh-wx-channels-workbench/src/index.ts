/**
 * 视频号工作台插件：Host 半（`/api/desktop/yootun/wx-workbench` 同源路由 +
 * 系统 Chrome 扫码/采集状态机 + 本地 storage_state/profile 管理 + 经
 * `ctx.yootunWorkbench` 的按域放行调用）；client 半挂 root `main` 中央
 * 面板与 `sidebar.panellist` 入口。Cookie/storage_state/本地路径不进入响应、
 * 日志、tools 参数或审计。
 * @module @yootun/dsh-wx-channels-workbench
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@yootun/dsh-workbench-mcp'
import type { WxWorkbenchFace } from './ingest.ts'
import { createBatchCollectController } from './collect-all.ts'
import { buildRouteHandlers, createWxHostDeps, type WxHostDeps } from './handlers.ts'
import { disposeHostTasks } from './lifecycle.ts'
import { ROUTE_PATH, createRouteHandler } from './route.ts'
import { createCollectController, type CollectController } from './runner.ts'
import { browserStatus } from './chrome.ts'
import { stateRoot } from './state.ts'
import { recoverInterruptedRuns } from './runs.ts'
import type {} from './probe.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-wx-workbench'

/** Host services required before the route registers. */
export const inject = ['webServer', 'yootunWorkbench']

/** 插件配置：状态目录（缺省旧目录，env 已在 state.ts 处理）与批量并发度。 */
export interface Config {
  /** 状态根目录覆盖；空串走 `~/.dofe/...` 与 `WX_CHANNELS_OPERATION_STATE_DIR`。 */
  stateDir: string
  /** 批量采集并发度（阶段 2 worker 数；生效值 = min(本值, 探测通过账号数)）。 */
  batchConcurrency: number
}

type ConfigInput = Partial<{ stateDir: unknown; batchConcurrency: unknown }>

export const Config = z.object({
  /** 默认空串：沿用旧目录与 env 覆盖链。 */
  stateDir: z.string().default(''),
  /** 默认 3；1..5 整数，越界/非整数由 schema 拒绝（插件加载失败）。 */
  batchConcurrency: z.number().min(1).max(5).step(1).default(3),
}) as z<ConfigInput, Config>

/**
 * Register the same-origin route (POST only) with the action allowlist.
 * @param ctx - host plugin context.
 * @param config - loader-provided config.
 */
export function apply(ctx: Context, config: Config): void {
  const root = config.stateDir !== '' ? config.stateDir : stateRoot(process.env)
  const workbench: WxWorkbenchFace = ctx.yootunWorkbench
  const deps: WxHostDeps = createWxHostDeps({
    root,
    workbench,
    browserStatusFn: browserStatus,
    logger: { warn: (message: string) => { ctx.logger.warn(message) } },
  })

  // 任务登记表（deps 持有同一实例）：登录/采集/probe/promote/晚 factory 清理/
  // runs 写盘/批量整次 run 全部纳入，dispose 统一等 settle。
  const registry = deps.taskRegistry

  // 启动时标记 interrupted runs（崩溃恢复）；登记以便 dispose 等待完成。
  registry.track(recoverInterruptedRuns(root).catch((error: unknown) => {
    ctx.logger.warn('wx-workbench: runs.json recovery failed', error)
  }))

  // 单账号控制器（按账号 Map）：批量运行中页面发起被拒（钩子含 batchReserved
  // 预留窗），批量内部启动（fromBatch）放行；AbortController 登记
  // deps.collectSignals（cancel 与 dispose 复用同一 abort 链路）。
  let batch: ReturnType<typeof createBatchCollectController>
  const collect: CollectController = createCollectController(
    { workbench, root, chromeFactory: deps.chromeFactory, logger: deps.logger },
    {
      batchHasRunning: () => batch.running || deps.batchReserved,
      taskRegistry: registry,
      signals: deps.collectSignals,
    },
  )

  const batchController = createBatchCollectController({
    collect: {
      start: input => collect.start({
        accountId: input.accountId,
        fromBatch: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
      wait: accountId => collect.wait(accountId),
      hasRunning: () => collect.hasRunning(),
    },
    probe: async accountId => {
      const { probeAndReport } = await import('./probe.ts')
      return registry.runTracked(() => probeAndReport(workbench, accountId, root))
    },
    logger: deps.logger,
    trackRun: promise => { registry.track(promise) },
    concurrency: config.batchConcurrency,
  })
  batch = batchController
  deps.setBatch(batchController)

  // 卸载：route 拒绝新请求 → abort 全部登录/采集信号 → batch.stop → 等所有
  // 登记任务 settle（含晚 factory 清理与 runs 写盘）→ 清理 controllers。
  ctx.effect(() => async () => {
    await disposeHostTasks({ deps, batch })
  }, 'yootun-wx-workbench: dispose abort')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createRouteHandler(() => ctx.webServer.getOrigin(), buildRouteHandlers(deps, batchController, collect)),
    }),
    'yootun-wx-workbench: route',
  )
}

export { ROUTE_PATH, ACTION_SCHEMAS, createRouteHandler, validateActionArgs, permitted, MAX_BODY_BYTES, type ActionArgs, type ActionHandler } from './route.ts'
export { STABLE_ERROR_CODES, SERVER_ERROR_CODES, LOCAL_ERROR_CODES, WxError, safeCode, serverCodeOf, type StableErrorCode } from './errors.ts'
export * from './idempotency.ts'
export { stateRoot, paths, safeSegment, readAccounts, writeAccounts, getAccount, updateAccount, bumpSessionSeq, bumpSessionSeqWith, nextSessionSeq, ensureProfileDir, moveProfile, moveStorageState, saveStorageState, hasStorageState, clearLocalCredentials, type AccountRecord, type AccountsState, type StatePaths } from './state.ts'
export { browserStatus, resolveSystemChrome, chromeCandidates, LAUNCH_ARGS, ChromeMissingError, DriverMissingError, type BrowserStatus } from './chrome.ts'
export { checkCollectionReadiness, ensureRemoteAccount, runCollection, progressFromEvent, BATCH_SKIP_REASONS, DEFAULT_MAX_PAGES, createCollectController, type CollectResult, type CollectRecord, type CollectStartInput, type CollectControllerDeps, type CollectController } from './runner.ts'
export { createIngestClient, ingestCollectedData, resolveClientStatus, type IngestClient, type IngestAllResult } from './ingest.ts'
export { createBatchCollectController, type BatchStatus, type BatchItem, type BatchController } from './collect-all.ts'
export { createTaskRegistry, disposeHostTasks, type TaskRegistry } from './lifecycle.ts'
export { loginWithQrCode, waitForSessionCookie, waitStableIdentity, probeSession, refreshSessionState, promotePendingAccount, commitLoginIdentity, removeLocalAccount, isPendingAccountId, PENDING_ACCOUNT_PREFIX, launchChrome, SESSION_COOKIE_NAMES, type LoginResult, type ProbeResult, type RefreshedSession, type PromoteResult } from './session.ts'
export { reportSessionStatus, markSessionOk, markSessionExpired } from './probe.ts'
export { COLLECT_SINCE_DAY, PAGE_SIZE, MAX_PAGES, splitIngestBatches, planFansTrendWindow, collectWorkList, collectWorkDetail, collectAccountMetrics, collectFansTrend, collectFansPortrait, fetchAuthData } from './collector.ts'
export { parseAuthData, parsePostListPage, parseDailySeries, parseFansTrend, parseFansPortrait, parseJsonPreservingIds, latestCompletedDay, SessionInvalidError, type WorkItem } from './parse.ts'
export { createAttemptId, readRuns, updateRun, removeAccountRuns, recoverInterruptedRuns, type RunRecord } from './runs.ts'
export { withProfileLock, tryWithProfileLock, withProfileLocks, tryWithProfileLocks, isProfileLocked, profileLockWaiters, type ProfileLockAttempt } from './locks.ts'
export type { WxWorkbenchFace } from './ingest.ts'
