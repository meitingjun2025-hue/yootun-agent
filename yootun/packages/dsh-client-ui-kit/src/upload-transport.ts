/**
 * media-upload 同源路由的上传传输（小红书与承接卡片共用唯一实现，2.5）：
 * pick-file 建会话、uploadStart 推字节、uploadStatus 轮询。传输失败一律
 * 返回 `null`（会话/快照）或 `ok: false`（字节受理），由调用方归一为稳定
 * 失败；预签名 URL 与本地路径不进入本层。
 * @module
 */

/** 四个路由路径常量（消费方各自声明，注入本面）。 */
export interface UploadTransportPaths {
  /** pick-file 路由。 */
  pick: string
  /** uploadStart 路由。 */
  start: string
  /** uploadStatus 路由。 */
  status: string
}

/** pick-file 会话信息（uploadId/accept/maxBytes）。 */
export interface UploadSessionInfo {
  uploadId: string
  accept: string[]
  maxBytes: number
}

/** uploadStatus 快照（waiting/uploading/done/failed/not_found + 受控字段）。 */
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

/** uploadStart 头（media-upload routes.ts 契约）。 */
const UPLOAD_ID_HEADER = 'x-yootun-upload-id'
const FILENAME_HEADER = 'x-yootun-filename'
const CONTENT_TYPE_HEADER = 'x-yootun-content-type'
const SIZE_HEADER = 'x-yootun-size'

/**
 * Create the shared upload transport bound to route paths. 请求方法、头与
 * 返回值形态与小红书工作台的原实现一致：非 2xx 与非 JSON 返回 `null`。
 * @param paths - 四个路由路径中的三组（pick/start/status）。
 * @returns the transport functions.
 */
export function createUploadTransport(paths: UploadTransportPaths): {
  startSession(kind: 'image' | 'video'): Promise<UploadSessionInfo | null>
  sendBytes(input: { uploadId: string; file: unknown }): Promise<{ ok: boolean; error?: string }>
  pollStatus(uploadId: string): Promise<UploadStatusSnapshot | null>
} {
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

  return {
    /** pick-file：创建上传会话（uploadId/accept/maxBytes）。 */
    async startSession(kind: 'image' | 'video'): Promise<UploadSessionInfo | null> {
      const payload = await uploadFetch(paths.pick, {
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
    },

    /**
     * uploadStart：把浏览器 File 的字节流推给宿主暂存（头携带元信息，本地
     * 路径不存在）。拒绝响应体里的稳定错误码随结果返回，供卡片映射失败原因。
     */
    async sendBytes(input: { uploadId: string; file: unknown }): Promise<{ ok: boolean; error?: string }> {
      if (!(typeof File === 'function' && input.file instanceof File)) return { ok: false }
      try {
        const response = await fetch(paths.start, {
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
    },

    /** uploadStatus：进度轮询（waiting/uploading/done/failed/not_found + 受控字段）。 */
    async pollStatus(uploadId: string): Promise<UploadStatusSnapshot | null> {
      const payload = await uploadFetch(paths.status, {
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
    },
  }
}
