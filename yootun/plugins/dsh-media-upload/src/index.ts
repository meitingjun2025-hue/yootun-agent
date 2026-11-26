/**
 * yootun 媒体上传插件（Host 半 + client 半）：`/_dsh/uploader/*` 同源路由与
 * `media_upload` 会话工具；client 半在 shell.overlay 注册「上传请求」承接
 * 卡片，轮询 pending 路由发现工具创建的会话、经原生 file input 选文件、
 * uploadStart 回流字节、uploadStatus 显示进度、cancel 路由取消。选文件由
 * 页面用浏览器原生 file input 完成，字节经同源路由回流宿主暂存；授权经
 * Workbench 面 `workbench_tos_upload_authorize`（只传
 * filename/contentType/size）；直传使用预签名 PUT，授权 URL 只在宿主内
 * 使用。插件不持有 TOS 凭证/桶/地域/endpoint；本地路径与 object key 从不
 * 存在于对外结果。
 * @module @yootun/dsh-media-upload
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { StagingArea, sweepStaleStagingDirs } from './staging.ts'
import { UploadSessionRegistry } from './sessions.ts'
import { uploaderRoutes } from './routes.ts'
import { registerMediaUploadTool } from './tool.ts'
import type { UploaderDeps } from './deps.ts'

export { PICK_FILE_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH, MEDIA_PATH, PENDING_PATH, CANCEL_PATH, TOOL_NAME, AUTHORIZE_TOOL_NAME } from './constants.ts'
export { validateAuthorizationResponse, isForbiddenPublicHost, type UploadAuthorization, type AuthorizeValidationOverrides } from './authorize.ts'
export { ERROR_CODES, toPublicCode, mapServerErrorCode, type MediaUploadErrorCode } from './errors.ts'
export { bytesMatchDeclaration, sniffContentType, guessContentType, extensionOf } from './mime.ts'
export {
  UploadSessionRegistry,
  type UploadSnapshot,
  type UploadSession,
  type UploadSessionOrigin,
  type UploadSessionContext,
  type PendingToolSession,
} from './sessions.ts'
export { StagingArea, sweepStaleStagingDirs, type StagedFile, type SweepStaleStagingOptions, type SweepStaleStagingResult } from './staging.ts'
export { uploaderRoutes, type UploadRoute, type UploadRouteHandler } from './routes.ts'
export type { UploaderDeps } from './deps.ts'

/**
 * Assemble the uploader state (staging area + session registry + wiring).
 * Split from `apply` so the Host wiring and tests share one construction path.
 * @param getExpectedOrigin - origin provider (request-time read).
 * @param workbench - the Workbench connector face.
 * @param config - limits.
 * @param logger - optional logger.
 * @returns the wiring plus the live registry/staging handles.
 */
export function createUploaderState(
  getExpectedOrigin: () => string,
  workbench: UploaderDeps['workbench'],
  config: { maxUploadBytes: number; awaitingMs?: number | undefined },
  logger?: { warn(message: string): void } | undefined,
): { deps: UploaderDeps; registry: UploadSessionRegistry; staging: StagingArea } {
  // 单一构建路径：staging 与 registry 在这里配对生成，路由暂存与卸载清理
  // 关闭同一个实例（历史上曾因双实例导致卸载删错对象、暂存目录泄漏）。
  const staging = new StagingArea()
  const registry = new UploadSessionRegistry({
    staging,
    ...(config.awaitingMs !== undefined ? { awaitingMs: config.awaitingMs } : {}),
  })
  const deps: UploaderDeps = {
    getExpectedOrigin,
    registry,
    staging,
    workbench,
    maxUploadBytes: config.maxUploadBytes,
    logger,
  }
  return { deps, registry, staging }
}
export { runUpload } from './run-upload.ts'
export { MEDIA_UPLOAD_OUTPUT_SCHEMA, registerMediaUploadTool } from './tool.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-media-upload'

/** Host services required before the routes and the tool register. */
export const inject = ['webServer', 'tools', 'yootunWorkbench']

/** 插件配置：只承载非敏感运行参数（限额与人工回环预算）。 */
export interface Config {
  /** 单文件大小上限（字节），缺省 500MB，硬上限 2GB。 */
  maxUploadBytes: number
  /** media_upload 人工回环预算（毫秒），缺省 30 分钟，硬上限 60 分钟。 */
  toolTimeoutMs: number
}

type ConfigInput = Partial<{ maxUploadBytes: unknown; toolTimeoutMs: unknown }>

const DEFAULT_MAX_UPLOAD_BYTES = 500 * 1024 * 1024
const MAX_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
const DEFAULT_TOOL_TIMEOUT_MS = 30 * 60_000
const MAX_TOOL_TIMEOUT_MS = 60 * 60_000

export const Config = z.object({
  maxUploadBytes: z.number().step(1).min(1).max(MAX_MAX_UPLOAD_BYTES).default(DEFAULT_MAX_UPLOAD_BYTES),
  toolTimeoutMs: z.number().step(1).min(1).max(MAX_TOOL_TIMEOUT_MS).default(DEFAULT_TOOL_TIMEOUT_MS),
}) as z<ConfigInput, Config>

/**
 * Register the uploader routes and the media_upload session tool.
 * @param ctx - host plugin context.
 * @param config - loader-provided limits.
 */
export function apply(ctx: Context, config: Config): void {
  const { deps, registry, staging } = createUploaderState(
    () => ctx.webServer.getOrigin(),
    ctx.yootunWorkbench,
    // awaiting 预算与工具人工回环预算同源（§6 会话在未绑定字节前的有效等待）。
    { maxUploadBytes: config.maxUploadBytes, awaitingMs: config.toolTimeoutMs },
    { warn: (message: string) => { ctx.logger.warn(message) } },
  )
  applyUploaderWiring(ctx, deps, config.toolTimeoutMs)
  // 启动清理：异常退出遗留的暂存目录（2.3，尽力而为不阻断路由注册）；
  // 清理 promise 由卸载路径等待结束。
  const stagingSweep = sweepStaleStagingDirs({ warn: (message: string) => { ctx.logger.warn(message) } })
  // 卸载：await registry.destroy（abort 全部会话并等在途管线 settle、
  // 暂存文件落盘删除完成），再 await staging.destroy 删除目录——返回
  // Promise 让 fiber 卸载 await 它（异步 cleanup 等待语义），rm -rf 不与
  // 在途 discard 竞态；卸载同时等待启动清理结束。
  ctx.effect(() => async () => {
    await registry.destroy()
    await staging.destroy()
    await stagingSweep.catch(() => undefined)
  }, 'yootun-media-upload: disposal')
}

/**
 * Wire the routes and the session tool against caller-supplied state.
 * `apply` composes this with the production state; tests substitute their own
 * deps (fake authorize / fake TOS) through the same path.
 * @param ctx - host plugin context (effect registrations ride its fiber).
 * @param deps - uploader wiring.
 * @param toolTimeoutMs - media_upload human-loop budget.
 */
export function applyUploaderWiring(ctx: Context, deps: UploaderDeps, toolTimeoutMs: number): void {
  for (const route of uploaderRoutes(deps)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      `yootun-media-upload: ${route.path}`,
    )
  }
  ctx.effect(() => registerMediaUploadTool(ctx, deps, toolTimeoutMs), 'yootun-media-upload: media_upload tool')
}
