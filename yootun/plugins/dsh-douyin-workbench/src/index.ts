/**
 * yootun 抖音工作台插件（D1：Host 半骨架）——`/api/desktop/yootun/douyin-workbench`
 * 同源路由 + action 契约（56 项冻结，D1 仅 browser.status 实现）+ 本地
 * accounts.json 状态基础 + 系统 Chrome 状态探测 + 经 Workbench MCP 的
 * douyin/viral 分组调用通道与 dispose 收口。登录/采集/作品/排期/素材/报表业务
 * action 不在本阶段（D2+ 按分册 15 演进）；不插入 yootun bundle；不创建
 * client 半。Cookie/storage_state/本地路径不进入响应、日志、tools 参数或审计。
 * @module @yootun/dsh-douyin-workbench
 */
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@yootun/dsh-workbench-mcp'
import { browserStatus } from './chrome.ts'
import { DouyinError } from './errors.ts'
import { createTaskRegistry, disposeHostTasks, type TaskRegistry } from './lifecycle.ts'
import { ROUTE_PATH, createRouteHandler, type ActionHandler, type ActionArgs, type RouteRequest, type RouteResponse } from './route.ts'
import { stateRoot } from './state.ts'
import { createWorkbenchCaller, type WorkbenchFace } from './workbench.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-douyin-workbench'

/** Host services required before the route registers. */
export const inject = ['webServer', 'yootunWorkbench']

/** 插件配置：状态目录（缺省旧目录，env 已在 state.ts 处理）。 */
export interface Config {
  /** 状态根目录覆盖；空串走 `~/.dofe/...` 与 `DOUYIN_OPERATION_STATE_DIR`。 */
  stateDir: string
}

type ConfigInput = Partial<{ stateDir: unknown }>

export const Config = z.object({
  /** 默认空串：沿用旧目录与 env 覆盖链。 */
  stateDir: z.string().default(''),
}) as z<ConfigInput, Config>

/** Host 侧共享依赖（handlers、测试注入与 dispose 共用同一实例）。 */
export interface DouyinHostDeps {
  /** 状态根目录（解析后的绝对路径）。 */
  root: string
  /** Workbench MCP 调用通道（douyin-workbench caller）。 */
  workbench: ReturnType<typeof createWorkbenchCaller>
  /** 浏览器能力自检（测试注入，不启动真实 Chrome）。 */
  browserStatusFn: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  /** 诊断日志（只记 action/稳定码，不记路径或凭证）。 */
  logger: { warn: (message: string, error?: unknown) => void }
  /** dispose 置位后 route handler 以 `plugin_disposing` 拒绝新 action。 */
  disposing: boolean
  /** 长任务信号表（D2+ 登录/采集经 registerSignal 登记）。 */
  signals: Map<string, AbortController>
  /** 任务注册表（dispose 等全部 settle）。 */
  taskRegistry: TaskRegistry
}

/**
 * Register a long-task abort signal for later phases (login/collect).
 * @param deps - host deps holding the signal table.
 * @param key - task key (per account or per run).
 * @returns the controller; the caller owns firing and cleanup.
 */
export function registerSignal(deps: DouyinHostDeps, key: string): AbortController {
  const existing = deps.signals.get(key)
  if (existing !== undefined) return existing
  const controller = new AbortController()
  deps.signals.set(key, controller)
  return controller
}

/**
 * Build the D1 route handlers. `browser.status` is the only implemented
 * action；allowlist 内其余 55 项缺席即 unknown_action（fail loud）。
 * @param deps - host deps.
 * @returns the action handler table consumed by the route.
 */
export function buildRouteHandlers(deps: DouyinHostDeps): Record<string, ActionHandler> {
  return {
    'browser.status': async (_args: ActionArgs) => {
      if (deps.disposing) throw new DouyinError('plugin_disposing', 'plugin is disposing')
      const status = await deps.browserStatusFn()
      // 只回布尔、平台与稳定提示；不回传 chromePath 等设备路径（分册 15 §7）。
      return { status: 'ready', chromeAvailable: status.chromeAvailable, driverAvailable: status.driverAvailable, platform: status.platform, hint: status.hint }
    },
  }
}

/**
 * Assemble the host deps for one root (test seam: inject fake browser status).
 * @param options.root - state root directory.
 * @param options.workbenchFace - the shared Workbench MCP connector.
 * @param options.browserStatusFn - browser capability probe (defaults to real probe).
 * @param options.logger - diagnostic logger.
 * @returns the deps instance shared by handlers, route and dispose.
 */
export function createDouyinHostDeps(options: {
  root: string
  workbenchFace: WorkbenchFace
  browserStatusFn?: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  logger?: { warn: (message: string, error?: unknown) => void }
}): DouyinHostDeps {
  return {
    root: options.root,
    workbench: createWorkbenchCaller(options.workbenchFace),
    browserStatusFn: options.browserStatusFn ?? (() => browserStatus()),
    logger: options.logger ?? { warn: () => undefined },
    disposing: false,
    signals: new Map(),
    taskRegistry: createTaskRegistry(),
  }
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
export { stateRoot, paths, safeSegment, STATE_VERSION, STATE_DIR_ENV, readAccounts, writeAccounts, getAccount, updateAccount, nextSessionSeq, ensureProfileDir, moveProfile, moveStorageState, hasStorageState, clearLocalCredentials, type AccountRecord, type AccountsState, type StatePaths } from './state.ts'
export { browserStatus, resolveSystemChrome, chromeCandidates, loadPlaywrightDriver, LAUNCH_ARGS, ChromeMissingError, DriverMissingError } from './chrome.ts'
export { DOUYIN_CALLER, createWorkbenchCaller, type WorkbenchFace } from './workbench.ts'
export { createTaskRegistry, disposeHostTasks, type TaskRegistry } from './lifecycle.ts'
