/**
 * 承接卡片的同源路由客户端：上传传输函数复制自小红书工作台
 * `src/client/api.ts` 的既有实现（uploadFetch / sendUploadBytes /
 * pollUploadStatus，P1 的 upload-experience-fixes 再做两份合并），新增
 * pendingUploads 与 cancelUpload。路径常量从包内 constants.ts 导入。
 * uploadFetch 保持「非 2xx 或非 JSON 返回 null」的口径；预签名 URL 与本地
 * 路径不进入本层。
 * @module
 */
import { PENDING_PATH, CANCEL_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH } from '../constants.ts'

/** uploadStart 头（media-upload routes.ts 契约）。 */
const UPLOAD_ID_HEADER = 'x-yootun-upload-id'
const FILENAME_HEADER = 'x-yootun-filename'
const CONTENT_TYPE_HEADER = 'x-yootun-content-type'
const SIZE_HEADER = 'x-yootun-size'

/** uploadStatus 快照（media-upload 契约投影；缺失字段由调用方容错）。 */
export interface UploadStatusSnapshot {
  status: 'waiting' | 'uploading' | 'done' | 'failed' | 'not_found'
  progress?: number | undefined
  bytesSent?: number | undefined
  bytesTotal?: number | undefined
  attempt?: number | undefined
  url?: string | undefined
  /** failed 终态的稳定错误码（承接卡片经词典映射展示）。 */
  error?: string | undefined
}

/** pending 路由投影的一个待处理上传会话（承接卡片的事实源）。 */
export interface PendingUploadSession {
  uploadId: string
  kind: string
  state: 'waiting' | 'uploading'
  progress: number
  createdAt: string
  /** 会话工具写入的调用标识；缺省时省略。 */
  context?: { sessionId?: string; toolCallId?: string }
}

/** uploadFetch：非 2xx/解析失败返回 null（调用方按暂态失败处理）。 */
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
 * uploadStart：把浏览器 File 的字节流推给宿主暂存（头携带元信息，本地路径
 * 不存在）。拒绝响应体里的稳定错误码随结果返回，供卡片映射失败原因。
 * @param input - 会话 uploadId 与调用方持有的 File。
 * @returns 受理结果；`ok: false` 时 `error` 携带宿主稳定码（可得时）。
 */
export async function sendUploadBytes(input: { uploadId: string; file: unknown }): Promise<{ ok: boolean; error?: string }> {
  if (!(typeof File === 'function' && input.file instanceof File)) return { ok: false }
  try {
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
    if (response.ok) return { ok: true }
    const payload: unknown = await response.json().catch(() => undefined)
    if (typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string') {
      return { ok: false, error: payload.error }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

/**
 * uploadStatus：进度轮询（waiting/uploading/done/failed/not_found + 受控字段）。
 * @param uploadId - the session id.
 * @returns the snapshot, or null on transport/HTTP failure（调用方计暂态失败）.
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
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  }
}

/** pending 响应里单个会话的字段收窄（wire 边界逐字段校验）。 */
function isPendingSession(value: unknown): value is PendingUploadSession {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.uploadId !== 'string' || entry.uploadId === '') return false
  if (typeof entry.kind !== 'string') return false
  if (entry.state !== 'waiting' && entry.state !== 'uploading') return false
  if (!Number.isFinite(Number(entry.progress))) return false
  if (typeof entry.createdAt !== 'string') return false
  return true
}

/**
 * pending：工具创建且仍在等待或上传中的会话投影（承接卡片轮询的事实源）。
 * 传输或 HTTP 失败与「没有待处理会话」分开返回：失败时调用方保留本地条目，
 * 不得把一次暂态失败当成服务端已清空。
 * @returns the sessions, `[]` when none is pending, or null on transport/HTTP failure or a malformed payload.
 */
export async function pendingUploads(): Promise<PendingUploadSession[] | null> {
  const payload = await uploadFetch(PENDING_PATH, { method: 'POST' })
  const sessions = payload?.sessions
  if (!Array.isArray(sessions)) return null
  return sessions.filter(isPendingSession)
}

/**
 * cancel：取消一个进行中的上传会话（宿主先把会话落 `user_cancelled` 终态
 * 再中止在途直传）。
 * @param uploadId - the session id.
 * @returns `cancelled`（已取消）／`not_running`（会话已是终态）／null（传输或 HTTP 失败）。
 */
export async function cancelUpload(uploadId: string): Promise<'cancelled' | 'not_running' | null> {
  const payload = await uploadFetch(CANCEL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId }),
  })
  if (payload === null) return null
  if (payload.cancelled === true) return 'cancelled'
  if (payload.reason === 'not_running') return 'not_running'
  return null
}
