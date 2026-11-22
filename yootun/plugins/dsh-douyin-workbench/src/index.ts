/**
 * yootun 抖音工作台插件——`/api/desktop/yootun/douyin-workbench` 同源路由 +
 * action 契约（56 项冻结）+ 本地状态/登录/采集编排 + 经 Workbench MCP 的
 * douyin/viral 分组调用通道与 dispose 收口。D2–D5 已交付：Host 33 个 action
 * 与 client 半（src/client，7 Tab 工作台）；D6–D8（breakdown/material/gene
 * 共 23 项）未实现，allowlist 内缺席即 unknown_action。插件未插入 yootun
 * bundle（client 入口接入属后续批次）。Cookie/storage_state/本地路径不进
 * 入响应、日志、tools 参数或审计。
 * @module @yootun/dsh-douyin-workbench
 */
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@yootun/dsh-workbench-mcp'
import { browserStatus } from './chrome.ts'
import { buildDouyinHandlers, createHandlerDeps, type DouyinHandlerDeps } from './handlers.ts'
import { disposeHostTasks } from './lifecycle.ts'
import { ROUTE_PATH, createRouteHandler, type RouteRequest, type RouteResponse } from './route.ts'
import { createBatchCollectController, createCollectController, reportSessionStatus } from './runner.ts'
import { refreshSessionState, type ChromeFactory } from './session.ts'
import { stateRoot } from './state.ts'
import { type WorkbenchFace } from './workbench.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-douyin-workbench'

/** Host services required before the route registers. */
export const inject = ['webServer', 'yootunWorkbench']

/** 插件配置：状态目录（缺省旧目录，env 已在 state.ts 处理）。 */
export interface Config {
  /** 状态根目录覆盖；空串走 `~/.dofe/...` 与 `DOUYIN_OPERATION_STATE_DIR`。 */
  stateDir: string
  /** 采集默认页预算（1..1000；页面可按次覆盖）。 */
  maxPages: number
}

type ConfigInput = Partial<{ stateDir: unknown; maxPages: unknown }>

export const Config = z.object({
  /** 默认空串：沿用旧目录与 env 覆盖链。 */
  stateDir: z.string().default(''),
  /** 旧插件 DEFAULT_MAX_PAGES = 1000（消费侧截整）。 */
  maxPages: z.number().min(1).max(1000).default(1000),
}) as z<ConfigInput, Config>

/**
 * Register a long-task abort signal for later phases (login/collect).
 * @param deps - handler deps holding the signal table.
 * @param key - task key (per account or per run).
 * @returns the controller; the caller owns firing and cleanup.
 */
export function registerSignal(deps: DouyinHandlerDeps, key: string): AbortController {
  const existing = deps.signals.get(key)
  if (existing !== undefined) return existing
  const controller = new AbortController()
  deps.signals.set(key, controller)
  return controller
}

/**
 * Build the route handlers (D2 面 11 项；browser.status 与登录/采集链)。
 * @param deps - handler deps.
 * @returns the action handler table consumed by the route.
 */
export function buildRouteHandlers(deps: DouyinHandlerDeps): Record<string, import('./route.ts').ActionHandler> {
  const runnerDeps = {
    callTool: deps.callTool,
    root: deps.root,
    chromeFactory: deps.chromeFactory,
    maxPages: deps.maxPages,
    logger: { warn: (message: string) => { deps.logger.warn(message) } },
  }
  const collect = createCollectController(runnerDeps, { taskRegistry: deps.taskRegistry })
  const batch = createBatchCollectController({
    collect,
    // probe 回调 = 本地实测 + 尽力上报（旧 deps.batchController 口径）。
    probe: async accountId => {
      const session = await refreshSessionState({ accountId, root: deps.root, chromeFactory: deps.chromeFactory })
      const report = await reportSessionStatus(runnerDeps, accountId, session)
      void report
      return { sessionStatus: session.sessionStatus, reason: session.reason }
    },
    logger: { warn: (message: string) => { deps.logger.warn(message) } },
    trackRun: promise => { deps.taskRegistry.track(promise) },
  })
  return buildDouyinHandlers(deps, { collect, batch })
}

/**
 * Assemble the handler deps for one root (test seam: inject fake browser status).
 * @param options.root - state root directory.
 * @param options.face - the shared Workbench MCP connector.
 * @param options.browserStatusFn - browser capability probe (defaults to real probe).
 * @param options.logger - diagnostic logger.
 * @param options.chromeFactory - Chrome launcher seam (tests).
 * @param options.maxPages - default collect page budget.
 * @returns the deps instance shared by handlers, route and dispose.
 */
export function createDouyinHostDeps(options: {
  root: string
  workbenchFace: WorkbenchFace
  browserStatusFn?: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  logger?: { warn: (message: string, error?: unknown) => void }
  chromeFactory?: ChromeFactory
  maxPages?: number
  /** G-2 启动恢复接缝（缺省 recoverInterruptedRuns；测试注入受控实现）。 */
  recovery?: import('./handlers.ts').StartupRecovery
}): DouyinHandlerDeps {
  return createHandlerDeps({
    root: options.root,
    face: options.workbenchFace,
    browserStatusFn: options.browserStatusFn ?? (() => browserStatus()),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.chromeFactory !== undefined ? { chromeFactory: options.chromeFactory } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  })
}

/**
 * 结构化宿主上下文（本插件实际消费的 Context 子集；真实 Cordis Context 结构
 * 兼容，测试夹具直接满足本接口，不再需要类型断言）。
 */
export interface DouyinHostContext {
  /** 诊断日志（只记 action/稳定码，不记路径或凭证）。 */
  logger: { warn(message: string, error?: unknown): void }
  /** 同源 webServer（路由登记与 origin 读取）。 */
  webServer: {
    /** Register one exact-path route; returns its disposer. */
    register(input: { kind: 'exact'; path: string; handler: (req: RouteRequest, res: RouteResponse) => Promise<void> }): { dispose(): void }
    /** The exact origin the webServer bound. */
    getOrigin(): string
  }
  /** 共享 Workbench MCP 连接器（douyin-workbench caller 通道）。 */
  yootunWorkbench: WorkbenchFace
  /** Register one effect; returns a disposer consumed on dispose. */
  effect(fn: () => unknown, name?: string): unknown
}

/**
 * Register the same-origin route (POST only) with the action allowlist.
 * @param ctx - host plugin context.
 * @param config - loader-provided config.
 */
export function apply(ctx: DouyinHostContext, config: Config): void {
  const root = config.stateDir !== '' ? config.stateDir : stateRoot(process.env)
  const deps = createDouyinHostDeps({
    root,
    workbenchFace: ctx.yootunWorkbench,
    logger: { warn: (message: string, error?: unknown) => { ctx.logger.warn(message, error) } },
    maxPages: config.maxPages,
  })

  // 卸载收口：route 拒绝新请求（plugin_disposing）→ abort 全部登记信号 →
  // 等所有登记任务 settle → 清理信号表（分册 08 生命周期口径）。
  ctx.effect(() => async () => {
    await disposeHostTasks({ deps })
  }, 'yootun-douyin-workbench: dispose')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createRouteHandler(() => ctx.webServer.getOrigin(), buildRouteHandlers(deps)),
    }),
    'yootun-douyin-workbench: route',
  )
}

export { ROUTE_PATH, ACTION_SCHEMAS, ACTION_TOOL_MAP, createRouteHandler, validateActionArgs, permitted, MAX_BODY_BYTES, type ActionSchema, type ActionArgs, type ActionHandler, type ActionToolBinding, type HandlerPayload, type FieldKind } from './route.ts'
export { STABLE_ERROR_CODES, SERVER_ERROR_CODES, SERVER_DOUYIN_ERROR_CODES, SERVER_VIRAL_ERROR_CODES, SERVER_COMMON_ERROR_CODES, LOCAL_ERROR_CODES, DouyinError, safeCode, isStableCode, serverCodeOf, type StableErrorCode } from './errors.ts'
export { stateRoot, paths, safeSegment, STATE_VERSION, STATE_DIR_ENV, readAccounts, writeAccounts, getAccount, updateAccount, nextSessionSeq, bumpSessionSeqWith, ensureProfileDir, moveProfile, moveStorageState, saveStorageState, hasStorageState, clearLocalCredentials, type AccountRecord, type AccountsState, type StatePaths, type StorageStateSource } from './state.ts'
export { browserStatus, resolveSystemChrome, chromeCandidates, loadPlaywrightDriver, LAUNCH_ARGS, ChromeMissingError, DriverMissingError } from './chrome.ts'
export { DOUYIN_CALLER, createWorkbenchCaller, type WorkbenchFace } from './workbench.ts'
export { createTaskRegistry, disposeHostTasks, type TaskRegistry } from './lifecycle.ts'
export { normalizeAvatarUrl, MAX_AVATAR_URL_LENGTH } from './avatar.ts'
export { attemptUuid, sessionIdempotencyKey, accountSaveIdempotencyKey, accountRemoveIdempotencyKey, runStartIdempotencyKey, listMetaIdempotencyKey, heartbeatIdempotencyKey, ingestBatchIdempotencyKey, ingestDailyIdempotencyKey, runFinishIdempotencyKey } from './idempotency.ts'
export { CREATOR_ORIGIN, USER_INFO_PATH, SESSION_COOKIE_NAMES, PENDING_ACCOUNT_PREFIX, isPendingAccountId, launchChromeSession, loginWithQrCode, probeSession, promotePendingAccount, refreshSessionState, removeLocalAccount, commitLoginIdentity, waitForSessionCookie, readAccountProfile, type ChromeFactory, type DouyinProfile, type LoginResult, type ProbeResult, type PromoteResult, type RefreshedSession } from './session.ts'
export { withProfileLock, tryWithProfileLock, withProfileLocks, tryWithProfileLocks, isProfileLocked } from './locks.ts'
export { runsFilePath, createAttemptId, readRuns, updateRun, recoverInterruptedRuns, removeAccountRuns, runInRootQueue, type RunRecord } from './runs.ts'
export { createCollectController, createBatchCollectController, batchCandidates, checkCollectionReadiness, ensureRemoteAccount, reportSessionStatus, markSessionOk, markSessionExpired, reportSessionOkAfterCollect, saveDiscoveredAvatar, runCollection, finishExpiredSession, progressFromEvent, lastProgress, type CollectResult, type BatchStatus, type BatchItem, type RunnerDeps } from './runner.ts'
export { createIngestClient, ingestCollectedWorks, BATCH_SIZE, DETERMINISTIC_ERRORS, RECOVERABLE_ERRORS, type IngestClient, type IngestOutcome } from './ingest.ts'
export * as collector from './collector.ts'
export * as parse from './parse.ts'
export { buildDouyinHandlers, completeLoginAfterSuccess, createHandlerDeps, projectAccounts, resolveAccountAlias, resolveAccountId, type DouyinHandlerDeps, type LoginRun, type ResolveAccountOutcome, type StartupRecovery } from './handlers.ts'
