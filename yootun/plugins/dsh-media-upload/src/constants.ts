/**
 * 上传插件的固定面（分册 08 §6）：本地同源路由名、媒体 MIME 白名单、
 * 会话档位。TOS AK/SK、bucket、region、endpoint、object key 一律不出现在
 * 本插件——授权与公网 URL 全部来自 Workbench 面的 authorize 工具。
 * @module
 */

/** 本地同源路由（沿用旧 dsh-yootun-tos-upload 的路径名）。 */
export const PICK_FILE_PATH = '/_dsh/uploader/pick-file'
export const UPLOAD_START_PATH = '/_dsh/uploader/uploadStart'
export const UPLOAD_STATUS_PATH = '/_dsh/uploader/uploadStatus'
export const MEDIA_PATH = '/_dsh/uploader/media'
/** 承接卡片只读轮询：工具创建且仍在等待或上传中的会话投影。 */
export const PENDING_PATH = '/_dsh/uploader/pending'
/** 承接卡片取消：会话先落 user_cancelled 终态再中止在途直传。 */
export const CANCEL_PATH = '/_dsh/uploader/cancel'

/** Workbench 面 authorize 工具名（唯一授权入口）。 */
export const AUTHORIZE_TOOL_NAME = 'workbench_tos_upload_authorize'

/** 会话工具名。 */
export const TOOL_NAME = 'media_upload'

/** 允许上传的 MIME（与 Tools 服务端 tos_upload_authorize 白名单对齐）。 */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime',
])

/** media 预览路由允许回流的 MIME（同白名单；无 SVG 等注入面）。 */
export const MEDIA_PREVIEW_MIME: ReadonlySet<string> = ALLOWED_CONTENT_TYPES

/** 文件档位 → 扩展名过滤器（浏览器 input accept 值由调用方组装）。 */
export const PICK_KINDS: ReadonlySet<string> = new Set(['media', 'image', 'video'])

/** 每档位的扩展名白名单（宿主侧强校验，不只依赖 UI 过滤）。 */
export const KIND_EXTENSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  image: ['jpg', 'jpeg', 'png', 'webp'],
  video: ['mp4', 'mov'],
  media: ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'],
})
