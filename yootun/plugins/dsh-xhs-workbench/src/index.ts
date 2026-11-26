/**
 * 小红书工作台插件（X1+X2 批次：Host 半）——`/api/desktop/yootun/xhs-workbench`
 * 同源路由 + 系统 Chrome 扫码/采集状态机 + 本地 storage_state/profile/快照管理。
 * Cookie/storage_state/本地路径不进入响应、日志、tools 参数或审计；task/hotboard
 * 等 Workbench 面调用随 X4/X5 批次接入。client 半（root `main` 中央面板与
 * `sidebar.panellist` 入口）随 X4 起批次接入。
 * @module @yootun/dsh-xhs-workbench
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@yootun/dsh-workbench-mcp'
import { browserStatus } from './chrome.ts'
import { buildRouteHandlers, createXhsHostDeps, type XhsHostDeps } from './handlers.ts'
import { disposeHostTasks } from './lifecycle.ts'
import { ROUTE_PATH, createRouteHandler } from './route.ts'
import { stateRoot } from './state.ts'
import type { XhsWorkbenchFace } from './workbench.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-xhs-workbench'

/** Host services required before the route registers. */
export const inject = ['webServer', 'yootunWorkbench']

/** 插件配置：状态目录（缺省旧目录，env 已在 state.ts 处理）与生命周期时间预算。 */
export interface Config {
  /** 状态根目录覆盖；空串走 `~/.dofe/...` 与 `XHS_OPERATION_STATE_DIR`。 */
  stateDir: string
  /** 卸载时间预算毫秒（1000..120000；dispose 等登记任务 settle 的上限）。 */
  disposeBudgetMs: number
  /** 浏览器关闭超时毫秒（1000..60000；context.close 挂起时的放弃点）。 */
  browserCloseTimeoutMs: number
  /** Chrome 启动超时毫秒（1000..180000；采集/探测/登录/发布共用）。 */
  launchTimeoutMs: number
}

type ConfigInput = Partial<{ stateDir: unknown; disposeBudgetMs: unknown; browserCloseTimeoutMs: unknown; launchTimeoutMs: unknown }>

export const Config = z.object({
  /** 默认空串：沿用旧目录与 env 覆盖链。 */
  stateDir: z.string().default(''),
  /** 卸载预算：整数 1000..120000，缺省 20000；越界即加载失败。 */
  disposeBudgetMs: z.number().min(1000).max(120000).step(1).default(20000),
  /** 关闭预算：整数 1000..60000，缺省 8000；越界即加载失败。 */
  browserCloseTimeoutMs: z.number().min(1000).max(60000).step(1).default(8000),
  /** 启动预算：整数 1000..180000，缺省 60000；越界即加载失败。 */
  launchTimeoutMs: z.number().min(1000).max(180000).step(1).default(60000),
}) as z<ConfigInput, Config>

/**
 * Register the same-origin route (POST only) with the action allowlist.
 * @param ctx - host plugin context.
 * @param config - loader-provided config.
 */
export function apply(ctx: Context, config: Config): void {
  const root = config.stateDir !== '' ? config.stateDir : stateRoot(process.env)
  const workbench: XhsWorkbenchFace = ctx.yootunWorkbench
  const deps: XhsHostDeps = createXhsHostDeps({
    root,
    workbench,
    browserStatusFn: () => browserStatus(),
    logger: { warn: (message: string) => { ctx.logger.warn(message) } },
    disposeBudgetMs: config.disposeBudgetMs,
    browserCloseTimeoutMs: config.browserCloseTimeoutMs,
    launchTimeoutMs: config.launchTimeoutMs,
  })

  // 卸载：route 拒绝新请求 → abort 全部登录/探测/采集信号 → 等所有登记任务
  // settle 至多 disposeBudgetMs（含晚 factory 清理与发布打开；耗尽告警后照常
  // 收口，挂起任务的 finally 随其 settle 照常执行）→ 清理 controllers。
  ctx.effect(() => async () => {
    await disposeHostTasks({ deps }, { disposeBudgetMs: deps.disposeBudgetMs, warn: message => { ctx.logger.warn(message) } })
  }, 'yootun-xhs-workbench: dispose abort')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createRouteHandler(() => ctx.webServer.getOrigin(), buildRouteHandlers(deps)),
    }),
    'yootun-xhs-workbench: route',
  )
}

export { ROUTE_PATH, ACTION_SCHEMAS, createRouteHandler, validateActionArgs, permitted, MAX_BODY_BYTES, type ActionArgs, type ActionHandler } from './route.ts'
export { STABLE_ERROR_CODES, SERVER_ERROR_CODES, SERVER_TASK_ERROR_CODES, SERVER_HOTBOARD_ERROR_CODES, LOCAL_ERROR_CODES, XhsError, safeCode, serverCodeOf, type StableErrorCode } from './errors.ts'
export { stateRoot, paths, safeSegment, readAccounts, writeAccounts, getAccount, updateAccount, nextSessionSeq, ensureProfileDir, moveProfile, moveStorageState, saveStorageState, hasStorageState, clearLocalCredentials, saveSnapshot, latestSnapshot, STATE_VERSION, STATE_DIR_ENV, type AccountRecord, type AccountsState, type StatePaths, type CollectSnapshot, type SnapshotNote } from './state.ts'
export { browserStatus, resolveSystemChrome, chromeCandidates, launchChrome, LAUNCH_ARGS, ChromeMissingError, DriverMissingError, BrowserLaunchTimeoutError, closeContext, launchWithTimeout, browserCloseTimeoutMessage, DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS, type BrowserStatus, type ChromeFactory, type ChromeLaunch } from './chrome.ts'
export { buildRouteHandlers, createXhsHostDeps, projectHotboardWrite, type XhsHostDeps, type LoginRun, type CollectRun, type PublishRun } from './handlers.ts'
export type { XhsWorkbenchFace } from './workbench.ts'
export { createTaskRegistry, disposeHostTasks, DEFAULT_DISPOSE_BUDGET_MS, type TaskRegistry, type AwaitSettledOutcome } from './lifecycle.ts'
export { acquireProfileLock, withProfileLock, tryWithProfileLock, withProfileLocks, tryWithProfileLocks, isProfileLocked, profileLockWaiters, type ProfileLockAttempt, type ProfileLockRelease } from './locks.ts'
export { loginWithQrCode, waitForSessionCookie, probeSession, confirmSessionOnPage, removeLocalAccount, isPendingAccountId, detectCaptcha, readAccountProfile, readAccountProfileWithRetry, PENDING_ACCOUNT_PREFIX, SESSION_COOKIE_NAMES, CREATOR_ORIGIN, LOGIN_URL, LOGIN_TIMEOUT_MS, PROBE_TIMEOUT_MS, type LoginResult, type ProbeResult, type RemoveLocalResult, type AccountProfile, type CookieWaitResult, type XhsPage, type XhsBrowserContext, type BrowserCloseBudget } from './session.ts'
export { publishDraft, publishUrl, PublishError, PUBLISH_URL_BASE, OPEN_TIMEOUT_MS, type PublishDraftResult } from './publisher.ts'
export { collectNotes, mapNote, parsePostedPage, summarizeSnapshot, CollectError, NOTE_MANAGER_URL, POSTED_PATH, DEFAULT_MAX_PAGES, PAGE_INTERVAL_MS, type CollectResult, type PostedPage } from './collector.ts'
export { createAccountsMachine, createAccountsMachineWithHost, type AccountsMachine, type AccountsSnapshot, type AccountRow, type LoginState, type CollectState, type AccountsNotice } from './client/accounts-machine.ts'
export { createUploadManager, type UploadMachine, type UploadAsset, type UploadAssetInput, type UploadMachinePorts, type UploadSessionInfo, type UploadStatusSnapshot } from './upload-machine.ts'
