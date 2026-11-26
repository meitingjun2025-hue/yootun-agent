/**
 * yootun 抖音工作台插件——`/api/desktop/yootun/douyin-workbench` 同源路由 +
 * action 契约（57 项冻结）+ 本地状态/登录/采集编排 + 经 Workbench MCP 的
 * douyin/viral 分组调用通道（按域放行）与 dispose 收口。D2–D8 各批
 * Host action 与 client 面板（src/client，7 个顶级 Tab 工作台）已全量交付；
 * 插件随 D9 集成批次插入 yootun bundle。Cookie/storage_state/本地路径不进
 * 响应、日志、tools 参数或审计。
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

/** 插件配置：状态目录（缺省旧目录，env 已在 state.ts 处理）、批量并发度与生命周期时间预算。 */
export interface Config {
  /** 状态根目录覆盖；空串走 `~/.dofe/...` 与 `DOUYIN_OPERATION_STATE_DIR`。 */
  stateDir: string
  /** 采集默认页预算（1..1000；页面可按次覆盖）。 */
  maxPages: number
  /** 批量采集并发度（1..5；阶段 2 同时采集的账号数上限）。 */
  batchConcurrency: number
  /** 卸载时间预算毫秒（1000..120000；dispose 等登记任务 settle 的上限）。 */
  disposeBudgetMs: number
  /** 浏览器关闭超时毫秒（1000..60000；context.close 挂起时的放弃点）。 */
  browserCloseTimeoutMs: number
  /** Chrome 启动超时毫秒（1000..180000；采集/探测/登录/发布共用）。 */
  launchTimeoutMs: number
}

type ConfigInput = Partial<{ stateDir: unknown; maxPages: unknown; batchConcurrency: unknown; disposeBudgetMs: unknown; browserCloseTimeoutMs: unknown; launchTimeoutMs: unknown }>

export const Config = z.object({
  /** 默认空串：沿用旧目录与 env 覆盖链。 */
  stateDir: z.string().default(''),
  /** 旧插件 DEFAULT_MAX_PAGES = 1000（消费侧截整）。 */
  maxPages: z.number().min(1).max(1000).default(1000),
  /** 批量并发度：整数 1..5，缺省 3；非整数/越界/非数字由 schema 拒绝（加载失败）。 */
  batchConcurrency: z.number().min(1).max(5).step(1).default(3),
  /** 卸载预算：整数 1000..120000，缺省 20000；越界即加载失败。 */
  disposeBudgetMs: z.number().min(1000).max(120000).step(1).default(20000),
  /** 关闭预算：整数 1000..60000，缺省 8000；越界即加载失败。 */
  browserCloseTimeoutMs: z.number().min(1000).max(60000).step(1).default(8000),
  /** 启动预算：整数 1000..180000，缺省 60000；越界即加载失败。 */
  launchTimeoutMs: z.number().min(1000).max(180000).step(1).default(60000),
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
 * Build the route handlers (57 项全量；browser.status、登录/采集链与各数据域链)。
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
    browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
    launchTimeoutMs: deps.launchTimeoutMs,
  }
  const collect = createCollectController(runnerDeps, {
    taskRegistry: deps.taskRegistry,
    // 批量运行中拒绝单账号启动（collect_busy）；闭包晚于 batch 赋值求值。
    batchHasRunning: () => batch.hasRunning(),
  })
  const batch = createBatchCollectController({
    collect,
    // probe 回调 = 本地实测 + 尽力上报（旧 deps.batchController 口径；batch
    // signal 贯穿探测与上报，dispose 可取消）。
    probe: async (accountId, signal) => {
      const session = await refreshSessionState({
        accountId,
        root: deps.root,
        chromeFactory: deps.chromeFactory,
        signal,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      })
      const report = await reportSessionStatus(runnerDeps, accountId, session, signal)
      void report
      return { sessionStatus: session.sessionStatus, reason: session.reason }
    },
    concurrency: deps.batchConcurrency,
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
 * @param options.batchConcurrency - batch collect concurrency (1..5).
 * @param options.disposeBudgetMs - dispose wait budget (Config.disposeBudgetMs).
 * @param options.browserCloseTimeoutMs - browser close budget (Config.browserCloseTimeoutMs).
 * @param options.launchTimeoutMs - Chrome launch budget (Config.launchTimeoutMs).
 * @returns the deps instance shared by handlers, route and dispose.
 */
export function createDouyinHostDeps(options: {
  root: string
  workbenchFace: WorkbenchFace
  browserStatusFn?: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  logger?: { warn: (message: string, error?: unknown) => void }
  chromeFactory?: ChromeFactory
  maxPages?: number
  /** 批量采集并发度（缺省 3；Config.batchConcurrency 透传）。 */
  batchConcurrency?: number
  /** 卸载预算毫秒（缺省 20000；Config.disposeBudgetMs 透传）。 */
  disposeBudgetMs?: number
  /** 关闭预算毫秒（缺省 8000；Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number
  /** 启动预算毫秒（缺省 60000；Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number
  /** G-2 启动恢复接缝（缺省 recoverInterruptedRuns；测试注入受控实现）。 */
  recovery?: import('./handlers.ts').StartupRecovery
  /** pending 提升接缝（测试注入；生产缺省 promotePendingAccount）。 */
  promote?: import('./handlers.ts').DouyinHandlerDeps['promote']
}): DouyinHandlerDeps {
  return createHandlerDeps({
    root: options.root,
    face: options.workbenchFace,
    browserStatusFn: options.browserStatusFn ?? (() => browserStatus()),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    ...(options.chromeFactory !== undefined ? { chromeFactory: options.chromeFactory } : {}),
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.batchConcurrency !== undefined ? { batchConcurrency: options.batchConcurrency } : {}),
    ...(options.disposeBudgetMs !== undefined ? { disposeBudgetMs: options.disposeBudgetMs } : {}),
    ...(options.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: options.browserCloseTimeoutMs } : {}),
    ...(options.launchTimeoutMs !== undefined ? { launchTimeoutMs: options.launchTimeoutMs } : {}),
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
    ...(options.promote !== undefined ? { promote: options.promote } : {}),
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
    batchConcurrency: config.batchConcurrency,
    disposeBudgetMs: config.disposeBudgetMs,
    browserCloseTimeoutMs: config.browserCloseTimeoutMs,
    launchTimeoutMs: config.launchTimeoutMs,
  })

  // 卸载收口：route 拒绝新请求（plugin_disposing）→ abort 全部登记信号 →
  // 等所有登记任务 settle 至多 disposeBudgetMs（耗尽告警后照常收口，挂起任务
  // 的 finally 随其 settle 照常执行）→ 清理信号表（分册 08 生命周期口径）。
  ctx.effect(() => async () => {
    await disposeHostTasks({ deps }, { disposeBudgetMs: deps.disposeBudgetMs, warn: message => { ctx.logger.warn(message) } })
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
export { browserStatus, resolveSystemChrome, chromeCandidates, loadPlaywrightDriver, LAUNCH_ARGS, ChromeMissingError, DriverMissingError, BrowserLaunchTimeoutError, closeContext, launchWithTimeout, browserCloseTimeoutMessage, DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS } from './chrome.ts'
export { DOUYIN_CALLER, createWorkbenchCaller, type WorkbenchFace } from './workbench.ts'
export { createTaskRegistry, disposeHostTasks, DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry, type AwaitSettledOutcome } from './lifecycle.ts'
export { normalizeAvatarUrl, MAX_AVATAR_URL_LENGTH } from './avatar.ts'
export { attemptUuid, sessionIdempotencyKey, accountSaveIdempotencyKey, accountRemoveIdempotencyKey, runStartIdempotencyKey, listMetaIdempotencyKey, heartbeatIdempotencyKey, ingestBatchIdempotencyKey, ingestDailyIdempotencyKey, runFinishIdempotencyKey } from './idempotency.ts'
export { CREATOR_ORIGIN, USER_INFO_PATH, SESSION_COOKIE_NAMES, PENDING_ACCOUNT_PREFIX, isPendingAccountId, launchChromeSession, loginWithQrCode, probeSession, promotePendingAccount, refreshSessionState, removeLocalAccount, commitLoginIdentity, waitForSessionCookie, readAccountProfile, type ChromeFactory, type DouyinProfile, type LoginResult, type ProbeResult, type PromoteResult, type RefreshedSession, type BrowserCloseBudget } from './session.ts'
export { withProfileLock, tryWithProfileLock, withProfileLocks, tryWithProfileLocks, isProfileLocked } from './locks.ts'
export { runsFilePath, createAttemptId, readRuns, updateRun, recoverInterruptedRuns, removeAccountRuns, runInRootQueue, type RunRecord } from './runs.ts'
export { createCollectController, createBatchCollectController, batchCandidates, checkCollectionReadiness, ensureRemoteAccount, reportSessionStatus, markSessionOk, markSessionExpired, reportSessionOkAfterCollect, saveDiscoveredAvatar, runCollection, finishExpiredSession, progressFromEvent, lastProgress, type CollectResult, type BatchStatus, type BatchItem, type RunnerDeps } from './runner.ts'
export { createIngestClient, ingestCollectedWorks, BATCH_SIZE, DETERMINISTIC_ERRORS, RECOVERABLE_ERRORS, type IngestClient, type IngestOutcome } from './ingest.ts'
export * as collector from './collector.ts'
export * as parse from './parse.ts'
export { buildDouyinHandlers, completeLoginAfterSuccess, createHandlerDeps, projectAccounts, resolveAccountAlias, resolveAccountId, type DouyinHandlerDeps, type LoginRun, type ResolveAccountOutcome, type StartupRecovery } from './handlers.ts'
