/**
 * 统一错误模型（迁移旧插件语义）：工具结果与 HTTP 响应只允许出现本表码值；
 * 底层原因经 toPublicCode 归一化，内部细节（本地路径、签名、Authorization、
 * 堆栈、预签名 URL）不进入对外结果。
 * @module
 */

/** 对外固定错误码（工具结果与 HTTP 错误响应的唯一合法取值）。 */
export const ERROR_CODES = Object.freeze([
  'uploader_not_configured',
  'session_not_found',
  'forbidden',
  'invalid_request',
  'user_cancelled',
  'extension_not_allowed',
  'mime_mismatch',
  'file_not_found',
  'file_too_large',
  'file_changed',
  'upload_timeout',
  'upload_cancelled',
  'upload_authorization_invalid',
  'storage_auth_failed',
  'storage_unavailable',
  'upload_failed',
])

export type MediaUploadErrorCode = typeof ERROR_CODES[number]

/** Coded error for internal control flow; only its code ever surfaces. */
export class MediaUploadError extends Error {
  /** Stable public code from {@link ERROR_CODES}. */
  readonly code: MediaUploadErrorCode

  /**
   * @param code - public code.
   * @param message - diagnostic text for logs (never returned to callers).
   */
  constructor(code: MediaUploadErrorCode, message: string) {
    super(message)
    this.name = 'MediaUploadError'
    this.code = code
  }
}

/**
 * Normalize any thrown cause into a public code (conservative fallback).
 * @param cause - anything thrown.
 * @returns one of {@link ERROR_CODES}.
 */
export function toPublicCode(cause: unknown): MediaUploadErrorCode {
  if (cause instanceof MediaUploadError) return cause.code
  const name = cause instanceof Error ? cause.name : undefined
  const code = (cause as { code?: unknown } | null)?.code
  if (name === 'AbortError' || code === 'ABORT_ERR' || name === 'TimeoutError') return 'upload_cancelled'
  return 'upload_failed'
}

/** 服务端 authorize 稳定错误码 → 插件公开错误码（迁移旧映射）。 */
const SERVER_CODE_MAP: ReadonlyArray<readonly [string, MediaUploadErrorCode]> = Object.freeze([
  ['UPLOAD_SIZE_EXCEEDED', 'file_too_large'],
  ['UPLOAD_TYPE_NOT_ALLOWED', 'extension_not_allowed'],
  ['UNAUTHORIZED', 'storage_auth_failed'],
  ['STORAGE_AUTH_FAILED', 'storage_auth_failed'],
  ['STORAGE_UNAVAILABLE', 'storage_unavailable'],
  ['VALIDATION_ERROR', 'upload_failed'],
] as const)

/**
 * Map a Workbench business failure to a public code from the server's stable
 * envelope code. The Tools contract nests it at `error.code`
 * (`{ error: { code, message, retryable, requestId } }`); a bare top-level
 * `code` is accepted for tolerance. Free text is never scanned.
 * @param structuredContent - the server error envelope.
 * @returns the mapped public code.
 */
export function mapServerErrorCode(structuredContent: unknown): MediaUploadErrorCode {
  if (typeof structuredContent === 'object' && structuredContent !== null) {
    const record = structuredContent as { code?: unknown; error?: { code?: unknown } }
    const nested = typeof record.error === 'object' && record.error !== null ? record.error.code : undefined
    const code = typeof nested === 'string' && nested !== '' ? nested : record.code
    if (typeof code === 'string') {
      for (const [serverCode, publicCode] of SERVER_CODE_MAP) {
        if (serverCode === code) return publicCode
      }
    }
  }
  return 'upload_authorization_invalid'
}
