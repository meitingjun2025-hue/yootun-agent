/**
 * 本地同源路由（分册 08 §6）：pick-file 创建会话、uploadStart 接收用户经
 * 浏览器原生 file input 选中的字节并启动授权直传、uploadStatus 轮询、
 * media 预览暂存字节（单区间 Range 支持）。加固口径沿用旧插件：loopback +
 * 同源 fetch 元数据校验、体上限、固定错误码；本地路径与预签名 URL 永不
 * 出现在任何响应。生产 deps 由插件入口注入；测试可用假授权与假 TOS 驱动。
 * @module
 */
import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PICK_FILE_PATH, UPLOAD_START_PATH, UPLOAD_STATUS_PATH, MEDIA_PATH, PICK_KINDS, KIND_EXTENSIONS, MEDIA_PREVIEW_MIME, ALLOWED_CONTENT_TYPES } from './constants.ts'
import { MediaUploadError, toPublicCode } from './errors.ts'
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

function finishJson(res: ServerResponse, statusCode: number, value: object): void {
  res.statusCode = statusCode
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

/** 同源校验：loopback 由 webServer 层强制，这里再独立核一次（深度防御）。 */
export function permitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  return loopback
    && req.headers.origin === expectedOrigin
    && (req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin')
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
    case 'picker_unavailable':
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
 * Build the four uploader routes against one deps wiring.
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
        let kind = 'media'
        if (req.headers['content-type'] !== undefined) {
          if (normalizeMime(req.headers['content-type']) !== 'application/json') {
            return finishJson(res, 415, { error: 'invalid_request' })
          }
          try {
            const body = await readJson(req)
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
      },
    },
    {
      path: UPLOAD_START_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
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
        const declaredLength = Number(req.headers['content-length'] ?? '-1')
        if (declaredLength !== size) return finishJson(res, 400, { error: 'invalid_request' })
        // 声明占用：先绑元数据再暂存；失败回滚到 failed 终态。
        session.name = filename
        session.contentType = declaredType
        session.size = size
        session.state = 'uploading'
        session.startedAt = Date.now()
        try {
          const staged = await deps.staging.stage(req, size, declaredType)
          // 暂存在途发生取消/过期/卸载（终态先行）：丢弃暂存，不复活会话。
          if (session.state !== 'uploading') {
            await deps.staging.discard(staged)
            return finishJson(res, 400, { error: 'session_not_found' })
          }
          session.staged = staged
          void runUpload(deps, session).catch(() => undefined)
          return finishJson(res, 200, { uploadId: session.id, name: session.name, size: session.size, contentType: session.contentType })
        } catch (error: unknown) {
          const code = toPublicCode(error)
          deps.registry.settleFailed(session, code)
          return finishJson(res, statusForCode(code), { error: code })
        }
      },
    },
    {
      path: UPLOAD_STATUS_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') return finishJson(res, 405, { error: 'invalid_request' })
        if (!permitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
        if (normalizeMime(req.headers['content-type']) !== 'application/json') {
          return finishJson(res, 415, { error: 'invalid_request' })
        }
        let uploadId = ''
        try {
          const body = await readJson(req)
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
      },
    },
    {
      path: MEDIA_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET') return finishJson(res, 405, { error: 'invalid_request' })
        if (!mediaPermitted(req, deps.getExpectedOrigin())) return finishJson(res, 403, { error: 'forbidden' })
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
        return pipeMedia(res, session, range ?? undefined)
      },
    },
  ]
}
