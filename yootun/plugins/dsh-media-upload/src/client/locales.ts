/**
 * media_upload 承接卡片 locale 词典：zh 为键集事实源，en 全量同步
 * （plugin-ui-ux §七；实施单 2.6 措辞）。键名沿用实施单：`handoff.picking`
 * 承载上传中进度文案。
 * @module
 */

/** 词典（键集事实源）。 */
export const zh = {
  'handoff.title': '上传请求',
  'handoff.requestRef': '请求编号 {id}',
  'handoff.hint': '智能体需要一份文件：请在下方选择，选好后自动上传',
  'handoff.pick': '选择文件',
  'handoff.picking': '正在上传 {progress}%',
  'handoff.done': '已上传',
  'handoff.cancel': '取消',
  'handoff.failed': '上传失败：{reason}',
  'handoff.retry': '重新选择',
  'handoff.dismiss': '关闭',
  'handoff.more': '另有 {count} 个上传请求',
  'handoff.reason.file_too_large': '文件超过大小上限',
  'handoff.reason.extension_not_allowed': '文件类型不支持',
  'handoff.reason.upload_timeout': '上传超时，请重试',
  'handoff.reason.default': '请重新选择文件',
} as const

/** 词典键全集（zh 为事实源）。 */
export type HandoffLocaleKey = keyof typeof zh

/** 英文词典（与 zh 键集全量成对）。 */
export const en: Record<HandoffLocaleKey, string> = {
  'handoff.title': 'Upload request',
  'handoff.requestRef': 'Request {id}',
  'handoff.hint': 'The assistant needs a file: pick one below and it uploads automatically',
  'handoff.pick': 'Choose file',
  'handoff.picking': 'Uploading {progress}%',
  'handoff.done': 'Uploaded',
  'handoff.cancel': 'Cancel',
  'handoff.failed': 'Upload failed: {reason}',
  'handoff.retry': 'Choose again',
  'handoff.dismiss': 'Dismiss',
  'handoff.more': '{count} more upload requests',
  'handoff.reason.file_too_large': 'File exceeds the size limit',
  'handoff.reason.extension_not_allowed': 'File type not supported',
  'handoff.reason.upload_timeout': 'Upload timed out, try again',
  'handoff.reason.default': 'Choose the file again',
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'yootun.mediaUpload'
