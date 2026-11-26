/**
 * 暂存与字节校验：请求体流式落盘到私有临时目录（0600），随后做完整校验面
 * ——普通文件（fstat.isFile）、声明大小一致、MIME 魔数匹配、上传前后
 * TOCTOU（大小与 mtime 未变）。宿主从头到尾不持浏览器侧本地路径。
 * @module
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { bytesMatchDeclaration } from './mime.ts'
import { MediaUploadError } from './errors.ts'
import type { IncomingMessage } from 'node:http'

/** The validated staged file: everything the upload step needs, nothing sensitive beyond this process. */
export interface StagedFile {
  /** Absolute staged path; never returned to browsers, models, or logs. */
  path: string
  /** Verified byte count (equals the declared size). */
  size: number
  /** Snapshot for the post-upload TOCTOU re-check. */
  before: { size: number; mtimeMs: number }
}

/** Lead bytes to sniff (magic numbers need at most 12). */
const SNIFF_BYTES = 16

/** One staging area bound to a plugin lifetime. */
export class StagingArea {
  private dir: string | undefined
  /** Single-flight for the lazy mkdtemp: concurrent stage() calls share one directory. */
  private ensureTask: Promise<string> | undefined

  /**
   * Create the private staging directory lazily; concurrent callers await
   * one mkdtemp so no directory is orphaned by a later assignment.
   * @returns the directory path.
   */
  private ensureDir(): Promise<string> {
    if (this.dir !== undefined) return Promise.resolve(this.dir)
    this.ensureTask ??= mkdtemp(join(tmpdir(), `yootun-media-${String(process.pid)}-`)).then((dir) => {
      this.dir = dir
      return dir
    }).finally(() => {
      this.ensureTask = undefined
    })
    return this.ensureTask
  }

  /**
   * Stream a request body into a fresh 0600-mode file and run the byte-level
   * checks. Oversized bodies abort mid-stream; `signal` (the owning session's
   * controller) destroys the request stream on abort so a client that never
   * finishes its body cannot pin the staging step past disposal.
   * @param body - the HTTP request body.
   * @param declaredSize - the caller-declared byte count (content-length must agree).
   * @param declaredContentType - the registered Content-Type.
   * @param signal - owning session cancellation; destroys the body stream on abort.
   * @returns the validated staged file.
   * @throws {MediaUploadError} size/mime validations.
   */
  async stage(
    body: IncomingMessage,
    declaredSize: number,
    declaredContentType: string,
    signal?: AbortSignal | undefined,
  ): Promise<StagedFile> {
    if (signal?.aborted === true) throw new MediaUploadError('upload_cancelled', 'staging cancelled before start')
    const onAbort = (): void => { body.destroy() }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.stageInner(body, declaredSize, declaredContentType)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** The actual streaming body of {@link stage}. */
  private async stageInner(body: IncomingMessage, declaredSize: number, declaredContentType: string): Promise<StagedFile> {
    const dir = await this.ensureDir()
    const path = join(dir, `${randomUUID()}.staged`)
    let received = 0
    let head: Buffer = Buffer.alloc(0)
    const write = createWriteStream(path, { mode: 0o600 })
    try {
      for await (const chunk of body) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        received += bytes.byteLength
        if (received > declaredSize) throw new MediaUploadError('file_too_large', 'received bytes exceed the declared size')
        if (head.byteLength < SNIFF_BYTES) head = Buffer.concat([head, bytes]).subarray(0, Math.min(SNIFF_BYTES, received))
        if (!write.write(bytes)) {
          await new Promise<void>((resolve, reject) => {
            write.once('drain', resolve)
            write.once('error', reject)
          })
        }
      }
      write.end()
      await new Promise<void>((resolve, reject) => {
        write.once('finish', resolve)
        write.once('error', reject)
      })
    } catch (error: unknown) {
      write.destroy()
      await unlink(path).catch(() => undefined)
      throw error
    }
    if (received !== declaredSize) {
      await unlink(path).catch(() => undefined)
      throw new MediaUploadError('file_changed', `declared ${String(declaredSize)} bytes but received ${String(received)}`)
    }
    if (!bytesMatchDeclaration(declaredContentType, head)) {
      await unlink(path).catch(() => undefined)
      throw new MediaUploadError('mime_mismatch', 'byte-level type does not match the declared Content-Type')
    }
    // 普通文件 + TOCTOU 快照：上传前后各取一次 fstat。
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw new MediaUploadError('file_not_found', 'staged content is not a regular file')
      if (info.size !== declaredSize) throw new MediaUploadError('file_changed', 'staged size drifted from the declared size')
      return { path, size: info.size, before: { size: info.size, mtimeMs: info.mtimeMs } }
    } finally {
      await handle.close()
    }
  }

  /**
   * Post-upload TOCTOU re-check: the staged file must be byte-identical to
   * what was uploaded (size and mtime unchanged). The staged file is removed
   * afterwards either way.
   * @param staged - the staged file.
   * @returns nothing; throws when the file changed underneath the upload.
   * @throws {MediaUploadError} `file_changed`.
   */
  async verifyAfterUpload(staged: StagedFile): Promise<void> {
    try {
      const info = await stat(staged.path)
      if (info.size !== staged.before.size || info.mtimeMs !== staged.before.mtimeMs) {
        throw new MediaUploadError('file_changed', 'staged file changed during upload')
      }
    } finally {
      await rm(staged.path, { force: true }).catch(() => undefined)
    }
  }

  /**
   * Drop one staged file early (failed authorization, expiry, or disposal).
   * @param staged - the staged file to remove; undefined is a no-op.
   */
  async discard(staged: StagedFile | undefined): Promise<void> {
    if (staged === undefined) return
    await rm(staged.path, { force: true }).catch(() => undefined)
  }

  /** Remove the whole staging directory (plugin disposal). */
  async destroy(): Promise<void> {
    const dir = this.dir
    this.dir = undefined
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Open a staged file as a byte stream for the presigned PUT.
 * @param path - staged file path.
 * @returns a web ReadableStream of the file's bytes.
 */
export function stagedByteStream(path: string): ReadableStream<Uint8Array> {
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
}

/** 旧命名目录（无 pid 段）的保留窗口：修改时间早于 24 小时才清理。 */
const LEGACY_STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** `sweepStaleStagingDirs` 的注入面与结果。 */
export interface SweepStaleStagingOptions {
  /** 扫描的系统临时目录（缺省 `node:os` tmpdir）。 */
  tmpDir?: string
  /** 时钟接缝（测试注入；缺省 Date.now）。 */
  now?: () => number
  /** 进程存活判定接缝（测试注入；缺省 process.kill(pid, 0) 语义，见 2.3）。 */
  isAlive?: (pid: number) => boolean
  /** 清理失败告警（插件 logger；缺省不记录）。 */
  warn?: (message: string) => void
}

/** 清理结果：removed 为删除目录数，kept 为保留目录数。 */
export interface SweepStaleStagingResult {
  removed: number
  kept: number
}

/** `yootun-media-` 前缀（只处理本插件命名的目录）。 */
const STAGING_PREFIX = 'yootun-media-'

/** 缺省进程存活判定：kill(pid, 0) 成功或 EPERM 视为存活，ESRCH 视为不存在。 */
function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * 清理异常退出遗留的暂存目录（2.3，只处理系统临时目录下 `yootun-media-`
 * 前缀的目录）：带 pid 段的新命名目录按进程是否存活判定；旧命名（无 pid 段）
 * 目录按修改时间超过 24 小时判定。尽力而为：单项删除失败记一条告警并继续。
 * @param options - tmpDir / now / isAlive / warn 注入（测试与插件 logger）。
 * @returns removed / kept 计数。
 */
export async function sweepStaleStagingDirs(options: SweepStaleStagingOptions = {}): Promise<SweepStaleStagingResult> {
  const { readdir } = await import('node:fs/promises')
  const tmpDir = options.tmpDir ?? tmpdir()
  const now = options.now ?? Date.now
  const isAlive = options.isAlive ?? defaultProcessAlive
  let entries: string[]
  try {
    entries = await readdir(tmpDir)
  } catch (error: unknown) {
    options.warn?.(`staging sweep: cannot read tmp dir (${String((error as NodeJS.ErrnoException).code ?? error)})`)
    return { removed: 0, kept: 0 }
  }
  let removed = 0
  let kept = 0
  for (const name of entries) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const rest = name.slice(STAGING_PREFIX.length)
    const pidSegment = rest.match(/^(\d+)-/)
    let stale: boolean
    if (pidSegment !== null) {
      stale = !isAlive(Number(pidSegment[1]))
    } else {
      const mtime = await stat(join(tmpDir, name)).then((info) => info.mtimeMs, () => Number.NaN)
      stale = Number.isFinite(mtime) && now() - mtime > LEGACY_STAGING_MAX_AGE_MS
      if (!Number.isFinite(mtime)) stale = false
    }
    if (!stale) {
      kept += 1
      continue
    }
    try {
      await rm(join(tmpDir, name), { recursive: true, force: true })
      removed += 1
    } catch (error: unknown) {
      options.warn?.(`staging sweep: failed to remove ${name} (${String((error as NodeJS.ErrnoException).code ?? error)})`)
      kept += 1
    }
  }
  return { removed, kept }
}
