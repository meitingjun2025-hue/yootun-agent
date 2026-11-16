/**
 * 暂存与字节校验：请求体流式落盘到私有临时目录（0600），随后做完整校验面
 * ——普通文件（fstat.isFile）、声明大小一致、MIME 魔数匹配、上传前后
 * TOCTOU（大小与 mtime 未变）。宿主从头到尾不持浏览器侧本地路径。
 * @module
 */
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, rm, unlink, stat } from 'node:fs/promises'
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
    this.ensureTask ??= mkdtemp(join(tmpdir(), 'yootun-media-')).then((dir) => {
      this.dir = dir
      return dir
    }).finally(() => {
      this.ensureTask = undefined
    })
    return this.ensureTask
  }

  /**
   * Stream a request body into a fresh 0600-mode file and run the byte-level
   * checks. Oversized bodies abort mid-stream.
   * @param body - the HTTP request body.
   * @param declaredSize - the caller-declared byte count (content-length must agree).
   * @param declaredContentType - the registered Content-Type.
   * @returns the validated staged file.
   * @throws {MediaUploadError} size/mime validations.
   */
  async stage(body: IncomingMessage, declaredSize: number, declaredContentType: string): Promise<StagedFile> {
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
