/**
 * Host API 客户端：页面只访问本地同源路由（`/api/desktop/yootun/xhs-workbench`
 * 与 `@yootun/dsh-media-upload` 的 `/_dsh/uploader/*` 四路由，D-2），不直连任何
 * 远端地址；错误只透出稳定 reason；预签名 URL 与本地路径不进入本层。
 * @module
 */
import type { UploadStatusSnapshot } from '../upload-machine.ts'

export const HOST_PATH = '/api/desktop/yootun/xhs-workbench'

/** media-upload 同源路由（D-2：上传四组语义 1:1 落在该路由组）。 */
export const UPLOAD_PICK_PATH = '/_dsh/uploader/pick-file'
export const UPLOAD_START_PATH = '/_dsh/uploader/uploadStart'
export const UPLOAD_STATUS_PATH = '/_dsh/uploader/uploadStatus'

/** Host 响应的通用形状（旧路由契约：ready/started/created/error）。 */
export interface HostResponse extends Record<string, unknown> {
  status: string
  reason?: string | undefined
}

/**
 * POST one action to the local Host.
 * @param action - whitelisted action name.
 * @param args - action arguments (schema-checked by the Host).
 * @returns the Host payload; throws the stable `reason` on error envelopes.
 */
export async function hostAction(action: string, args: Record<string, unknown> = {}): Promise<HostResponse & Record<string, unknown>> {
  const response = await fetch(HOST_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action, ...args }),
  })
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object') throw new Error('xhs_operation_request_failed')
  const record = payload as HostResponse & Record<string, unknown>
  if (record.status === 'error') throw new Error(record.reason ?? 'xhs_operation_request_failed')
  return record
}

/** uploadStart 头（media-upload routes.ts 契约）。 */
const UPLOAD_ID_HEADER = 'x-yootun-upload-id'
const FILENAME_HEADER = 'x-yootun-filename'
const CONTENT_TYPE_HEADER = 'x-yootun-content-type'
const SIZE_HEADER = 'x-yootun-size'

/** uploadFetch：非 2xx/解析失败返回 null（machine 归一为稳定失败）。 */
async function uploadFetch(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, { credentials: 'same-origin', redirect: 'error', ...init })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * pick-file：创建上传会话（uploadId/accept/maxBytes）。
 * @param kind - 素材组（image/video）。
 * @returns the session info, or null on any failure (machine 归一).
 */
export async function startUploadSession(kind: 'image' | 'video'): Promise<{ uploadId: string; accept: string[]; maxBytes: number } | null> {
  const payload = await uploadFetch(UPLOAD_PICK_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  })
  if (payload === null || typeof payload.uploadId !== 'string' || payload.uploadId === '') return null
  const maxBytes = Number(payload.maxBytes)
  return {
    uploadId: payload.uploadId,
    accept: Array.isArray(payload.accept) ? payload.accept.map(String) : [],
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Number.POSITIVE_INFINITY,
  }
}

/**
 * uploadStart：把浏览器 File 的字节流推给宿主暂存（头携带元信息，本地路径不存在）。
 * @param input - 会话 uploadId 与调用方持有的 File。
 * @returns true when accepted.
 */
export async function sendUploadBytes(input: { uploadId: string; file: unknown }): Promise<boolean> {
  if (!(typeof File === 'function' && input.file instanceof File)) return false
  const response = await fetch(UPLOAD_START_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: {
      [UPLOAD_ID_HEADER]: input.uploadId,
      [FILENAME_HEADER]: input.file.name,
      [CONTENT_TYPE_HEADER]: input.file.type || 'application/octet-stream',
      [SIZE_HEADER]: String(input.file.size),
    },
    body: input.file,
  })
  return response.ok
}

/**
 * uploadStatus：进度轮询（waiting/uploading/done/failed/not_found + 受控字段）。
 * @param uploadId - the session id.
 * @returns the snapshot, or null on transport/HTTP failure (machine 计暂态失败).
 */
export async function pollUploadStatus(uploadId: string): Promise<UploadStatusSnapshot | null> {
  const payload = await uploadFetch(UPLOAD_STATUS_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  })
  if (payload === null) return null
  const status = payload.status
  if (status !== 'waiting' && status !== 'uploading' && status !== 'done' && status !== 'failed' && status !== 'not_found') return null
  return {
    status,
    ...(Number.isFinite(Number(payload.progress)) ? { progress: Number(payload.progress) } : {}),
    ...(Number.isFinite(Number(payload.bytesSent)) ? { bytesSent: Number(payload.bytesSent) } : {}),
    ...(Number.isFinite(Number(payload.bytesTotal)) ? { bytesTotal: Number(payload.bytesTotal) } : {}),
    ...(Number.isFinite(Number(payload.attempt)) ? { attempt: Number(payload.attempt) } : {}),
    ...(typeof payload.url === 'string' ? { url: payload.url } : {}),
  }
}
