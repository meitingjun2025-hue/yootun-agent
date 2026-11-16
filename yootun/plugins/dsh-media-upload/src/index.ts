/**
 * yootun 媒体上传插件（纯 Host）：`/_dsh/uploader/*` 同源路由与
 * `media_upload` 会话工具。选文件由页面用浏览器原生 file input 完成，字节
 * 经同源路由回流宿主暂存；授权经 Workbench 面
 * `workbench_tos_upload_authorize`（只传 filename/contentType/size）；直传
 * 使用预签名 PUT，授权 URL 只在宿主内使用。插件不持有 TOS 凭证/桶/地域/
 * endpoint；本地路径与 object key 从不存在于对外结果。
 * @module @yootun/dsh-media-upload
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tools'
import { StagingArea } from './staging.ts'
import { UploadSessionRegistry } from './sessions.ts'
import { uploaderRoutes } from './routes.ts'
import { registerMediaUploadTool } from './tool.ts'
import type { UploaderDeps } from './deps.ts'

export { PICK_FILE_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH, MEDIA_PATH, TOOL_NAME, AUTHORIZE_TOOL_NAME } from './constants.ts'
export { validateAuthorizationResponse, isForbiddenPublicHost, type UploadAuthorization, type AuthorizeValidationOverrides } from './authorize.ts'
export { ERROR_CODES, toPublicCode, mapServerErrorCode, type MediaUploadErrorCode } from './errors.ts'
export { bytesMatchDeclaration, sniffContentType, guessContentType, extensionOf } from './mime.ts'
export { UploadSessionRegistry, type UploadSnapshot, type UploadSession } from './sessions.ts'
export { StagingArea, type StagedFile } from './staging.ts'
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
  config: { maxUploadBytes: number },
  logger?: { warn(message: string): void } | undefined,
  registry?: UploadSessionRegistry | undefined,
): { deps: UploaderDeps; registry: UploadSessionRegistry; staging: StagingArea } {
  const staging = new StagingArea()
  const owned = registry ?? new UploadSessionRegistry({ staging })
  const deps: UploaderDeps = {
    getExpectedOrigin,
    registry: owned,
    staging,
    workbench,
    maxUploadBytes: config.maxUploadBytes,
    logger,
  }
  return { deps, registry: owned, staging }
}
export { runUpload } from './run-upload.ts'
export { registerMediaUploadTool } from './tool.ts'

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
  const staging = new StagingArea()
  // awaiting 预算与工具人工回环预算同源（§6 会话在未绑定字节前的有效等待）。
  const registry = new UploadSessionRegistry({ staging, awaitingMs: config.toolTimeoutMs })
  const { deps } = createUploaderState(
    () => ctx.webServer.getOrigin(),
    ctx.yootunWorkbench,
    config,
    { warn: (message: string) => { ctx.logger.warn(message) } },
    registry,
  )
  applyUploaderWiring(ctx, deps, config.toolTimeoutMs)
  ctx.effect(() => () => {
    registry.destroy()
    void staging.destroy()
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
