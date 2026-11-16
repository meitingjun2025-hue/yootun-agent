/**
 * yootun 媒体上传插件（纯 Host）：`/_dsh/uploader/*` 同源路由与
 * `media_upload` 会话工具。上传经 Workbench 面 `workbench_tos_upload_authorize`
 * 授权后预签名直传；插件不持有 TOS 凭证、不回传本地路径与 object key。
 * 上传状态机随本批次交付。
 * @module @yootun/dsh-media-upload
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'yootun-media-upload'

/** Host services required before the routes and the tool register. */
export const inject = ['webServer', 'tools', 'yootunWorkbench']

/**
 * Register the uploader routes and the media_upload session tool.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  void ctx
}
