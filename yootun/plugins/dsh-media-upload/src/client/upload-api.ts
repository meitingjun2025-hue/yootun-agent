/**
 * 承接卡片的同源路由客户端：上传传输统一走 kit（2.5：小红书与承接卡片唯一
 * 实现，`createUploadTransport` 以路由路径注入）；pending 与 cancel 是
 * media-upload 独有路由，仍在本文件实现。uploadFetch 保持「非 2xx 或非 JSON
 * 返回 null」的口径；预签名 URL 与本地路径不进入本层。
 * @module
 */
import { CANCEL_PATH, PICK_FILE_PATH, PENDING_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH } from '../constants.ts'
import { createUploadTransport, type UploadStatusSnapshot } from '@yootun/dsh-client-ui-kit/src/upload-transport.ts'

export type { UploadStatusSnapshot }

/** 上传传输（路由路径注入；小红书与承接卡片共用唯一实现）。 */
const transport = createUploadTransport({
  pick: PICK_FILE_PATH,
  start: UPLOAD_START_PATH,
  status: UPLOAD_STATUS_PATH,
})

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
 * uploadStart：把浏览器 File 的字节流推给宿主暂存（kit 传输的透传）。
 * @param input - 会话 uploadId 与调用方持有的 File。
 * @returns 受理结果；`ok: false` 时 `error` 携带宿主稳定码（可得时）。
 */
export async function sendUploadBytes(input: { uploadId: string; file: unknown }): Promise<{ ok: boolean; error?: string }> {
  return transport.sendBytes(input)
}

/**
 * uploadStatus：进度轮询（kit 传输的透传）。
 * @param uploadId - the session id.
 * @returns the snapshot, or null on transport/HTTP failure（调用方计暂态失败）.
 */
export async function pollUploadStatus(uploadId: string): Promise<UploadStatusSnapshot | null> {
  return transport.pollStatus(uploadId)
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

/** pending 响应里单个会话的字段投影（承接卡片的事实源）。 */
export interface PendingUploadSession {
  uploadId: string
  kind: string
  state: 'waiting' | 'uploading'
  progress: number
  createdAt: string
  /** 会话工具写入的调用标识；缺省时省略。 */
  context?: { sessionId?: string; toolCallId?: string }
}
