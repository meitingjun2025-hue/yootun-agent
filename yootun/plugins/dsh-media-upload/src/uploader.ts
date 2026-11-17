/**
 * 预签名直传驱动：把暂存字节 PUT 到 authorize 下发的预签名 URL。进度经
 * 回调上报；只有瞬时传输失败（5xx/429 与网络异常）按同键整对象覆盖语义
 * 有界重试；401/403（授权失效）与其他 4xx 是确定性失败，不重试并按稳定码
 * 投影（storage_auth_failed / upload_failed）。授权 URL 只在宿主进程内
 * 使用，绝不日志化。
 * @module
 */
import { stagedByteStream, type StagedFile } from './staging.ts'
import { MediaUploadError } from './errors.ts'
import type { UploadAuthorization } from './authorize.ts'

/** Bounded PUT attempts: one original + two retries for transient failures only. */
const MAX_ATTEMPTS = 3

/** PUT retry backoff schedule (ms). */
const RETRY_DELAYS_MS: readonly number[] = [250, 1_000]

/** Whether a thrown cause may be retried (transient only). */
function retryable(error: unknown): boolean {
  if (error instanceof MediaUploadError) return error.code === 'storage_unavailable'
  return true
}

/** Progress callbacks for the registry. */
export interface UploadHandlers {
  onAttempt?: (attempt: number) => void
  onProgress?: (bytesSent: number, totalBytes: number) => void
}

/**
 * PUT the staged file to the presigned URL with progress and bounded retry.
 * @param staged - the validated staged file (re-fstat'd by the caller afterwards).
 * @param authorization - the validated presigned authorization.
 * @param signal - cancellation (session abort / plugin disposal).
 * @param handlers - progress and attempt callbacks.
 * @returns nothing; throws on final failure.
 * @throws {Error} transport failure after the retry budget, or abort.
 */
export async function putStagedFile(
  staged: StagedFile,
  authorization: UploadAuthorization,
  signal: AbortSignal,
  handlers: UploadHandlers = {},
): Promise<void> {
  let lastError: unknown = undefined
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    handlers.onAttempt?.(attempt)
    try {
      const sent = await putOnce(staged, authorization, signal, handlers)
      handlers.onProgress?.(sent, staged.size)
      return
    } catch (error: unknown) {
      lastError = error
      // 取消立即终止；确定性失败（401/403/其他 4xx）不重试。
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw error
      if (!retryable(error)) throw error
      if (attempt < MAX_ATTEMPTS) {
        await delay(RETRY_DELAYS_MS[attempt - 1] ?? 0, signal)
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('presigned PUT failed')
}

/** One PUT pass with byte-count progress. */
async function putOnce(
  staged: StagedFile,
  authorization: UploadAuthorization,
  signal: AbortSignal,
  handlers: UploadHandlers,
): Promise<number> {
  let sent = 0
  const source = stagedByteStream(staged.path)
  const counting = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength
      handlers.onProgress?.(sent, staged.size)
      controller.enqueue(chunk)
    },
  })
  const body = source.pipeThrough(counting)
  try {
    const response = await fetch(authorization.url, {
      method: 'PUT',
      body,
      headers: { ...authorization.headers },
      duplex: 'half',
      signal,
    } as RequestInit)
    if (!response.ok) {
      // 存储侧拒绝：按状态分类（正文绝不读取进内存，可能含内部细节）。
      if (response.status === 401 || response.status === 403) {
        throw new MediaUploadError('storage_auth_failed', 'presigned authorization rejected')
      }
      if (response.status >= 500 || response.status === 429 || response.status === 408) {
        throw new MediaUploadError('storage_unavailable', `storage transient failure ${String(response.status)}`)
      }
      throw new MediaUploadError('upload_failed', `presigned PUT failed with status ${String(response.status)}`)
    }
    // 消费响应体连接（S3 风格空体），保证连接释放。
    await response.arrayBuffer()
    return sent
  } catch (error: unknown) {
    // 失败/取消：显式中断读流，释放暂存文件句柄（fetch abort 的隐式取消之外兜底）。
    await source.cancel().catch(() => undefined)
    throw error
  }
}

/** Abortable delay between retries. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
