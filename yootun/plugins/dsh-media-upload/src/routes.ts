/**
 * 本地同源路由（分册 08 §6）：pick-file 创建会话、uploadStart 接收用户经
 * 浏览器原生 file input 选中的字节并启动授权直传、uploadStatus 轮询、
 * media 预览暂存字节（单区间 Range 支持）、pending 投影工具创建的待处理
 * 会话（承接卡片只读轮询）、cancel 取消进行中的会话。加固口径沿用旧插件
 * 并以 wx/xhs 同款信任判定收紧：loopback 远端 + 浏览器来源标记（Desktop
 * 转发双头缺失放行）、体上限、固定错误码；本地路径与预签名 URL 永不
 * 出现在任何响应。生产 deps 由插件入口注入；测试可用假授权与假 TOS 驱动。
 * @module
 */
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PICK_FILE_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH, MEDIA_PATH, PENDING_PATH, CANCEL_PATH, PICK_KINDS, KIND_EXTENSIONS, MEDIA_PREVIEW_MIME, ALLOWED_CONTENT_TYPES } from './constants.ts'
import { MediaUploadError, toPublicCode, type MediaUploadErrorCode } from './errors.ts'
import { extensionOf, normalizeMime } from './mime.ts'
import { runUpload } from './run-upload.ts'
import type { UploadSession } from './sessions.ts'
import type { UploaderDeps } from './deps.ts'

const ALLOWED_TYPES = ALLOWED_CONTENT_TYPES

/** 上传请求头里的会话通行证与元数据。 */
const UPLOAD_ID_HEADER = 'x-yootun-upload-id'
const FILENAME_HEADER = 'x-yootun-filename'
const CONTENT_TYPE_HEADER = 'x-yootun-content-type'
const SIZE_HEADER = 'x-yootun-size'

/**
 * Decode the filename request header. Node http decodes headers as latin1
 * while browser fetch encodes non-ASCII header values as UTF-8, so the
 * user's file name (Chinese names are the primary case) needs the explicit
 * re-decode.
 * @param value - raw header value.
 * @returns the decoded value, or undefined for empty input.
 */
function filenameHeaderValue(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined
  return Buffer.from(value, 'latin1').toString('utf8')
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** JSON 元数据体上限（bytes）。 */
const MAX_JSON_BODY_BYTES = 16 * 1024
/** uploadId 长度上限。 */
const MAX_UPLOAD_ID_LENGTH = 128
/** 文件名长度上限（浏览器侧名，仅用于展示与扩展名校验）。 */
const MAX_FILENAME_LENGTH = 255

/** One route handler signature (webServer register contract). */
export type UploadRouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

/** Route table entry consumed by the plugin entry. */
export interface UploadRoute {
  path: string
  handler: UploadRouteHandler
}

/**
 * Wait until the response settles: 'finish' (bytes flushed to the client) or
 * 'close' (the client connection died mid-flight — e.g. our own abort
 * destroyed the request socket). Admission release waits on this so a
 * disposal that awaits admissions also waits for the in-flight response.
 * @param res - the server response.
 * @returns a promise resolving once the response has settled.
 */
function responseSettled(res: ServerResponse): Promise<void> {
  return new Promise(resolve => {
    if (res.writableFinished || res.destroyed) {
      resolve()
      return
    }
    res.on('finish', resolve)
    res.on('close', resolve)
  })
}

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

/** 路由信任判定（对齐官方浏览器信任边界 api-request-trust，wx/xhs 模板同款）：
 * loopback 远端是基础防线，负责把请求绑定到本机；显式 `sec-fetch-site:
 * cross-site` 一律拒绝；显式 Origin 必须精确等于 expectedOrigin（字面 `null`、
 * 异源都拒绝），Origin 缺失不单独视为攻击——Windows Desktop 的 Electron main
 * 进程 `forwardWebRequest` 转发请求时会剥掉 Origin 与 Sec-Fetch-Site 两枚头，
 * 双头缺失是 Desktop 转发的合法形态，来源边界由 loopback 承担。
 * @param req - Node HTTP 请求。
 * @param expectedOrigin - 本 webServer 绑定的精确 origin。
 * @returns 是否放行。 */
export function permitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  return origin === undefined || origin === expectedOrigin
}

/**
 * media 预览独立校验：`<img>`/`<video>` 的媒体加载是 no-cors 请求，浏览器
 * 不带 Origin 头；要求 origin 严格相等会让每个预览请求 403。规则：loopback
 * 保留；sec-fetch-site ∈ {same-origin, undefined, none}；Origin 缺失放行。
 */
function mediaPermitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== expectedOrigin) return false
  return true
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_JSON_BODY_BYTES) throw new MediaUploadError('invalid_request', 'JSON body too large')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MediaUploadError('invalid_request', 'JSON body must be an object')
  }
  return parsed as Record<string, unknown>
}

/**
 * uploadStart 的主体（已在 admission 保护内执行）：校验元数据、同步占位
 * 会话、流式暂存、后台启动直传。暂存期间会话被中止/过期时，投影会话自身
 * 的稳定错误码（upload_cancelled / upload_timeout / session_not_found），
 * 底层 IO 错误（如暂存目录已被卸载清理）不得外泄为 upload_failed。
 * @param req - incoming request.
 * @param res - response.
 * @param deps - uploader wiring.
 * @param uploadId - the session id from the header.
 * @param filename - decoded filename from the header.
 * @param contentType - raw content-type header.
 * @param size - declared size from the header.
 * @returns nothing; the response is fully written here.
 */
async function handleUploadStartInner(
  req: IncomingMessage, res: ServerResponse, deps: UploaderDeps,
  uploadId: string, filename: string, contentType: string, size: number,
): Promise<void> {
  const declaredType = normalizeMime(contentType)
  const session = deps.registry.getLive(uploadId)
  // 同步占位：staging 在途期间会话已是 uploading，二次并发/重发的
  // uploadStart 在这里被拒（否则会重复授权、争写进度）。
  if (session === undefined || session.state !== 'awaiting' || session.staged !== undefined) {
    return finishJson(res, 400, { error: 'session_not_found' })
  }
  // 扩展名 + MIME 白名单双收口（授权前快速失败）。
  if (!ALLOWED_TYPES.has(declaredType) || !(KIND_EXTENSIONS[session.kind] ?? []).includes(extensionOf(filename))) {
    return finishJson(res, 400, { error: 'extension_not_allowed' })
  }
  if (size > deps.maxUploadBytes) return finishJson(res, 400, { error: 'file_too_large' })
  // Desktop forwardWebRequest 流式转发时 Chromium 剔除 content-length（fetch
  // forbidden header）→ chunked 传输无该头；缺失即跳过前置快检，实际字节数由
  // staging 兜底（流中超限中止 / 声明≠实际 file_changed / 落盘复核）。
  const declaredLength = req.headers['content-length'] === undefined ? size : Number(req.headers['content-length'])
  if (declaredLength !== size) return finishJson(res, 400, { error: 'invalid_request' })
  // 声明占用：先绑元数据再暂存；失败回滚到 failed 终态。
  session.name = filename
  session.contentType = declaredType
  session.size = size
  session.state = 'uploading'
  session.startedAt = Date.now()
  try {
    // 暂存可被会话中止驱动（dispose/过期/取消时销毁请求流，admission 等待有界）。
    const staged = await deps.staging.stage(req, size, declaredType, session.controller.signal)
    // 暂存在途发生取消/过期/卸载（终态先行）：丢弃暂存，不复活会话。
    if (session.state !== 'uploading') {
      await deps.staging.discard(staged)
      return finishJson(res, 400, { error: 'session_not_found' })
    }
    session.staged = staged
    // 管线挂到会话：registry.destroy 等它 settle，暂存清理不与卸载竞态。
    session.pipeline = runUpload(deps, session).catch(() => undefined)
    return finishJson(res, 200, { uploadId: session.id, name: session.name, size: session.size, contentType: session.contentType })
  } catch (error: unknown) {
    // 会话在暂存期间已进入终态（dispose/取消/过期）：投影会话自身的稳定码
    // （经函数读取，避免 TS 对 await 前状态字面量的窄化误判）。
    const liveState = (): UploadSession['state'] => session.state
    const code = liveState() === 'failed' && session.errorCode !== undefined
      ? session.errorCode as MediaUploadErrorCode
      : toPublicCode(error)
    if (liveState() !== 'failed') deps.registry.settleFailed(session, code)
    return finishJson(res, statusForCode(code), { error: code })
  }
}

/** 固定错误码 → HTTP 状态码（迁移旧映射）。 */
function statusForCode(code: string): number {
  switch (code) {
    case 'session_not_found':
    case 'invalid_request':
    case 'file_not_found':
    case 'file_changed':
    case 'file_too_large':
    case 'extension_not_allowed':
    case 'mime_mismatch':
      return 400
    case 'user_cancelled':
    case 'upload_cancelled':
      return 409
    case 'uploader_not_configured':
      return 503
    case 'upload_timeout':
      return 504
    case 'storage_auth_failed':
    case 'storage_unavailable':
    case 'upload_failed':
    case 'upload_authorization_invalid':
      return 502
    default:
      return 500
  }
}

/** 产出媒体预览响应（handler 等待流结束）。 */
async function pipeMedia(res: ServerResponse, session: UploadSession, range: { start: number; end: number } | undefined): Promise<void> {
  const staged = session.staged
  if (staged === undefined) {
    finishJson(res, 403, { error: 'session_not_found' })
    return
  }
  const mime = normalizeMime(session.contentType)
  if (!MEDIA_PREVIEW_MIME.has(mime)) {
    finishJson(res, 403, { error: 'forbidden' })
    return
  }
  const size = staged.size
  const baseHeaders: Record<string, string> = {
    'content-type': mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (range !== undefined) {
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${String(range.start)}-${String(range.end)}/${String(size)}`)
    res.setHeader('content-length', String(range.end - range.start + 1))
  } else {
    res.statusCode = 200
    res.setHeader('content-length', String(size))
  }
  for (const [key, value] of Object.entries(baseHeaders)) res.setHeader(key, value)
  const stream = createReadStream(staged.path, range !== undefined ? { start: range.start, end: range.end } : undefined)
  await new Promise<void>((resolve) => {
    const done = (): void => { resolve() }
    res.on('finish', done)
    res.on('close', done)
    stream.on('error', () => {
      if (!res.writableEnded) res.destroy()
      done()
    })
    stream.pipe(res)
  })
}

/** 解析单区间 Range 头；null=按全量，undefined=区间不可满足。 */
function parseSingleRange(header: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!Number.isFinite(size) || size <= 0) return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header ?? '').trim())
  if (match === null) return null
  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isInteger(suffix) || suffix <= 0) return null
    const length = Math.min(suffix, size)
    return { start: size - length, end: size - 1 }
  }
  const start = Number(rawStart)
  if (!Number.isInteger(start) || start < 0 || start >= size) return undefined
  let end = size - 1
  if (rawEnd !== '') {
    const parsed = Number(rawEnd)
    if (!Number.isInteger(parsed) || parsed < start) return undefined
    end = Math.min(parsed, size - 1)
  }
  return { start, end }
}

/**
 * Build the six uploader routes against one deps wiring.
 * @param deps - production or test wiring.
 * @returns the route table (registration order matters not).
 */
export function uploaderRoutes(deps: UploaderDeps): UploadRoute[] {
  return [
    {
      path: PICK_FILE_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 503, { error: 'uploader_not_configured' })
        try {
          let kind = 'media'
          if (req.headers['content-type'] !== undefined) {
            if (normalizeMime(req.headers['content-type']) !== 'application/json') {
              return finishJson(res, 415, { error: 'invalid_request' })
            }
            try {
              const body = await readJson(req)
              // 未知字段拒绝：pick-file 契约只有 kind。
              if (Object.keys(body).some(key => key !== 'kind')) {
                return finishJson(res, 400, { error: 'invalid_request' })
              }
              if (typeof body.kind === 'string') kind = body.kind
            } catch {
              return finishJson(res, 400, { error: 'invalid_request' })
            }
          }
          if (!PICK_KINDS.has(kind)) return finishJson(res, 400, { error: 'invalid_request' })
          const session = deps.registry.create(kind)
          return finishJson(res, 200, {
            uploadId: session.id,
            kind,
            accept: KIND_EXTENSIONS[kind] ?? [],
            maxBytes: deps.maxUploadBytes,
          })
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
    {
      path: UPLOAD_START_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 503, { error: 'uploader_not_configured' })
        try {
          const uploadId = headerValue(req, UPLOAD_ID_HEADER)
          const filename = filenameHeaderValue(headerValue(req, FILENAME_HEADER))
          const contentType = headerValue(req, CONTENT_TYPE_HEADER)
          const sizeRaw = headerValue(req, SIZE_HEADER)
          const size = Number(sizeRaw)
          if (uploadId === undefined || uploadId.length > MAX_UPLOAD_ID_LENGTH
            || filename === undefined || filename.length === 0 || filename.length > MAX_FILENAME_LENGTH
            || contentType === undefined
            || sizeRaw === undefined || !Number.isSafeInteger(size) || size <= 0) {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          return await handleUploadStartInner(req, res, deps, uploadId, filename, contentType, size)
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
    {
      path: UPLOAD_STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 503, { error: 'uploader_not_configured' })
        try {
          if (normalizeMime(req.headers['content-type']) !== 'application/json') {
            return finishJson(res, 415, { error: 'invalid_request' })
          }
          let uploadId = ''
          try {
            const body = await readJson(req)
            // 未知字段拒绝：uploadStatus 契约只有 uploadId。
            if (Object.keys(body).some(key => key !== 'uploadId')) {
              return finishJson(res, 400, { error: 'invalid_request' })
            }
            if (typeof body.uploadId === 'string') uploadId = body.uploadId
          } catch {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          if (uploadId === '' || uploadId.length > MAX_UPLOAD_ID_LENGTH) {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          const snapshot = deps.registry.snapshot(uploadId)
          if (snapshot === undefined) return finishJson(res, 200, { status: 'not_found' })
          return finishJson(res, 200, {
            status: snapshot.state === 'awaiting' ? 'waiting' : snapshot.state,
            progress: snapshot.totalBytes > 0
              ? Math.min(100, Math.floor((snapshot.bytesSent / snapshot.totalBytes) * 100))
              : 0,
            bytesSent: snapshot.bytesSent,
            bytesTotal: snapshot.totalBytes,
            attempt: snapshot.attempt,
            ...(snapshot.state === 'done' && snapshot.url !== undefined ? { url: snapshot.url, name: snapshot.name, size: snapshot.size } : {}),
            ...(snapshot.state === 'failed' && snapshot.error !== undefined ? { error: snapshot.error } : {}),
          })
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
    {
      path: MEDIA_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return finishJson(res, 405, { error: 'invalid_request' })
        if (!mediaPermitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 400, { error: 'invalid_request' })
        try {
          let uploadId = ''
          try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1')
            if (url.pathname !== MEDIA_PATH) return finishJson(res, 400, { error: 'invalid_request' })
            uploadId = url.searchParams.get('uploadId') ?? ''
          } catch {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          if (uploadId === '' || uploadId.length > MAX_UPLOAD_ID_LENGTH) {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          const session = deps.registry.getLive(uploadId)
          if (session === undefined || session.staged === undefined) {
            return finishJson(res, 403, { error: 'forbidden' })
          }
          const range = parseSingleRange(req.headers.range, session.staged.size)
          if (range === undefined) {
            res.statusCode = 416
            res.setHeader('content-range', `bytes */${String(session.staged.size)}`)
            res.setHeader('content-length', '0')
            res.setHeader('cache-control', 'no-store')
            res.setHeader('x-content-type-options', 'nosniff')
            res.end()
            return
          }
          return await pipeMedia(res, session, range ?? undefined)
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
    {
      path: PENDING_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 503, { error: 'uploader_not_configured' })
        try {
          // 只读路由：JSON 体可省略；有体时必须是对象且不含任何字段。
          if (req.headers['content-type'] !== undefined) {
            if (normalizeMime(req.headers['content-type']) !== 'application/json') {
              return finishJson(res, 415, { error: 'invalid_request' })
            }
            try {
              const body = await readJson(req)
              if (Object.keys(body).length > 0) {
                return finishJson(res, 400, { error: 'invalid_request' })
              }
            } catch {
              return finishJson(res, 400, { error: 'invalid_request' })
            }
          }
          return finishJson(res, 200, { sessions: deps.registry.pendingToolSessions() })
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
    {
      path: CANCEL_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        const admission = deps.registry.beginRequest()
        if (admission === undefined) return finishJson(res, 503, { error: 'uploader_not_configured' })
        try {
          if (normalizeMime(req.headers['content-type']) !== 'application/json') {
            return finishJson(res, 415, { error: 'invalid_request' })
          }
          let uploadId = ''
          try {
            const body = await readJson(req)
            // 未知字段拒绝：cancel 契约只有 uploadId。
            if (Object.keys(body).some(key => key !== 'uploadId')) {
              return finishJson(res, 400, { error: 'invalid_request' })
            }
            if (typeof body.uploadId === 'string') uploadId = body.uploadId
          } catch {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          if (uploadId === '' || uploadId.length > MAX_UPLOAD_ID_LENGTH) {
            return finishJson(res, 400, { error: 'invalid_request' })
          }
          const outcome = deps.registry.cancel(uploadId)
          if (outcome === 'not_found') return finishJson(res, 403, { error: 'session_not_found' })
          if (outcome === 'not_running') return finishJson(res, 200, { cancelled: false, reason: 'not_running' })
          return finishJson(res, 200, { cancelled: true })
        } finally {
          await responseSettled(res)
          admission.release()
        }
      },
    },
  ]
}
