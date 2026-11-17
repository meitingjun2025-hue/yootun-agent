/**
 * 上传会话注册表：pick-file 创建会话（等待浏览器经原生 file input 选中的
 * 字节到达 uploadStart）；uploadStart 暂存、授权并后台直传；uploadStatus
 * 轮询进度；media 预览未完成会话的暂存字节。会话只以 uploadId 为通行证
 * ——本地路径从不存在，object key 与预签名 URL 永不进入条目可见面。
 * done/failed 结果保留 doneTtlMs 后清理；uploading 超过 orphanMs 中止；
 * destroy()（插件卸载）中止全部并删除暂存。
 * @module
 */
import { randomUUID } from 'node:crypto'
import type { StagedFile, StagingArea } from './staging.ts'
import type { UploadAuthorization } from './authorize.ts'

/** Session lifecycle states surfaced to pollers. */
export type UploadState = 'awaiting' | 'uploading' | 'done' | 'failed'

/** The poller-visible snapshot: no staged paths, no presigned URLs, no controllers. */
export interface UploadSnapshot {
  id: string
  name: string
  contentType: string
  size: number
  state: UploadState
  attempt: number
  bytesSent: number
  totalBytes: number
  /** Public URL, present only on `done`. */
  url?: string
  /** Stable public error code, present only on `failed`. */
  error?: string
}

/** Terminal patches applied through {@link UploadSession.settle}. */
export interface SettlePatch {
  url?: string
  errorCode?: string
}

/** One live upload session. */
export interface UploadSession {
  id: string
  kind: string
  name: string
  contentType: string
  size: number
  state: UploadState
  attempt: number
  bytesSent: number
  staged: StagedFile | undefined
  authorization: UploadAuthorization | undefined
  /** Public URL of a finished upload; secret URLs never live here. */
  publicUrl: string | undefined
  errorCode: string | undefined
  startedAt: number
  finishedAt: number | undefined
  /** Resolves when the session reaches `done` or `failed` (the tool waits on it). */
  completion: Promise<void>
  /** Idempotent terminal transition. */
  settle: (state: 'done' | 'failed', patch?: SettlePatch) => void
  controller: AbortController
  /** The in-flight upload pipeline (set by the route once the background run starts). */
  pipeline: Promise<void> | undefined
}

/** Registry options; timings are deployment-varying and injected. */
export interface SessionRegistryOptions {
  staging: StagingArea
  /** done/failed retention in ms (default 60s). */
  doneTtlMs?: number
  /** orphan uploading budget in ms (default 30min). */
  orphanMs?: number
  /** awaiting-session budget in ms — pick-file sessions never bound to bytes (default 10min). */
  awaitingMs?: number
  /** sweep interval in ms (default 30s; 0 disables). */
  sweepMs?: number
  /** id factory (test seam). */
  idFactory?: () => string
  /** clock (test seam). */
  now?: () => number
}

export const DEFAULT_DONE_TTL_MS = 60_000
export const DEFAULT_ORPHAN_MS = 30 * 60_000
export const DEFAULT_AWAITING_MS = 10 * 60_000
export const DEFAULT_SWEEP_MS = 30_000

/** One admitted in-flight request; `release` runs in the handler's finally. */
export interface Admission {
  /** Resolves when the request settles. */
  done: Promise<void>
  release: () => void
}

/** Bounded session registry for one plugin lifetime. */
export class UploadSessionRegistry {
  private readonly sessions = new Map<string, UploadSession>()
  private readonly staging: StagingArea
  private readonly doneTtlMs: number
  private readonly orphanMs: number
  private readonly awaitingMs: number
  private readonly sweepTimer: ReturnType<typeof setInterval> | undefined
  private readonly idFactory: () => string
  private readonly now: () => number
  private destroyed = false
  /** 已接受的在途请求（路由 handler 与工具 execute）：destroy 等它们全部 settle。 */
  private readonly admissions = new Set<Admission>()

  /**
   * @param options - staging area, budgets, and test seams.
   */
  constructor(options: SessionRegistryOptions) {
    this.staging = options.staging
    this.doneTtlMs = options.doneTtlMs ?? DEFAULT_DONE_TTL_MS
    this.orphanMs = options.orphanMs ?? DEFAULT_ORPHAN_MS
    this.awaitingMs = options.awaitingMs ?? DEFAULT_AWAITING_MS
    this.idFactory = options.idFactory ?? randomUUID
    this.now = options.now ?? (() => Date.now())
    const sweepMs = options.sweepMs ?? DEFAULT_SWEEP_MS
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          this.sweep()
        } catch (error: unknown) {
          // 清理失败不影响主流程；下一轮继续。
          void error
        }
      }, sweepMs)
      this.sweepTimer.unref?.()
    }
  }

  /**
   * Create an awaiting session (the pick-file surface). The browser then
   * streams the user-picked bytes to uploadStart against this id.
   * @param kind - pick kind (media/image/video).
   * @returns the session with metadata still empty until uploadStart binds them.
   */
  create(kind: string): UploadSession {
    const completion = Promise.withResolvers<void>()
    const session: UploadSession = {
      id: this.idFactory(),
      kind,
      name: '',
      contentType: '',
      size: 0,
      state: 'awaiting',
      attempt: 0,
      bytesSent: 0,
      staged: undefined,
      authorization: undefined,
      publicUrl: undefined,
      errorCode: undefined,
      startedAt: this.now(),
      finishedAt: undefined,
      completion: completion.promise,
      settle: (state, patch) => {
        if (session.state === 'done' || session.state === 'failed') return
        session.state = state
        session.finishedAt = this.now()
        if (patch?.url !== undefined) session.publicUrl = patch.url
        if (patch?.errorCode !== undefined) session.errorCode = patch.errorCode
        completion.resolve()
      },
      controller: new AbortController(),
      pipeline: undefined,
    }
    this.sessions.set(session.id, session)
    return session
  }

  /**
   * Admit one in-flight request (route handler or tool execute) into the
   * registry's lifecycle. `undefined` after {@link destroy}: the caller must
   * answer with a stable refusal (`uploader_not_configured`) without touching
   * sessions, staging, or the Workbench face.
   * @returns the admission whose `release` runs in the handler's finally, or `undefined` when closed.
   */
  beginRequest(): Admission | undefined {
    if (this.destroyed) return undefined
    const { promise: done, resolve } = Promise.withResolvers<void>()
    const admission: Admission = { done, release: () => undefined }
    // release 先把 admission 移出集合再 resolve：released 请求不得滞留在
    // set 里（uploadStatus 轮询是高频入口，滞留即无界累积）。
    admission.release = () => {
      if (!this.admissions.delete(admission)) return
      resolve()
    }
    this.admissions.add(admission)
    return admission
  }

  /** 在途（已准入未释放）请求数；诊断用只读快照。 */
  get activeRequestCount(): number {
    return this.admissions.size
  }

  /**
   * Get one live session by id for in-process pipeline use. The object
   * carries the staged path and the presigned authorization — never
   * serialize it, log it, or hand it across a boundary; surfaces use
   * {@link snapshot} instead.
   * @param id - the upload id.
   * @returns the live session, or undefined.
   */
  getLive(id: string): UploadSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Live session ids in creation order. Host pages use this to discover
   * pending uploads (e.g. a media_upload session waiting for the user).
   * @returns the ids.
   */
  ids(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * Poller-visible snapshot; strips internals and applies lazy expiry rules.
   * @param id - the upload id.
   * @returns the snapshot, or undefined once expired/unknown.
   */
  snapshot(id: string): UploadSnapshot | undefined {
    const session = this.sessions.get(id)
    if (session === undefined) return undefined
    const stamp = this.now()
    if (session.state === 'awaiting' && stamp - session.startedAt > this.awaitingMs) {
      this.settleFailed(session, 'upload_timeout')
    }
    if (session.state === 'uploading' && stamp - session.startedAt > this.orphanMs) {
      session.controller.abort()
      this.settleFailed(session, 'upload_timeout')
    }
    if ((session.state === 'done' || session.state === 'failed') && session.finishedAt !== undefined && stamp - session.finishedAt > this.doneTtlMs) {
      void this.staging.discard(session.staged)
      this.sessions.delete(id)
      return undefined
    }
    return {
      id: session.id,
      name: session.name,
      contentType: session.contentType,
      size: session.size,
      state: session.state,
      attempt: session.attempt,
      bytesSent: session.bytesSent,
      totalBytes: session.size,
      ...(session.state === 'done' && session.publicUrl !== undefined ? { url: session.publicUrl } : {}),
      ...(session.state === 'failed' && session.errorCode !== undefined ? { error: session.errorCode } : {}),
    }
  }

  /**
   * Settle one session as failed with a public code.
   * @param session - the session.
   * @param code - public error code.
   */
  settleFailed(session: UploadSession, code: string): void {
    session.errorCode = code
    session.settle('failed', { errorCode: code })
  }

  /**
   * Abort every live upload, wait for the in-flight pipelines to settle
   * (their catch paths drop the staged files), then drop every session.
   * Awaiting here is what makes the plugin's async disposal deterministic:
   * `staging.destroy()` afterwards never races a late `discard`.
   */
  /**
   * Abort every live upload, wait for the in-flight upload pipelines AND the
   * admitted in-flight requests (handlers may still be draining a request
   * body through `staging.stage` — awaiting their admissions keeps their
   * settle inside the disposal), then drop every session. Only after all of
   * that settle is it safe for the caller to run `staging.destroy()`.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return
    this.destroyed = true
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer)
    const pipelines: Array<Promise<unknown>> = []
    for (const session of this.sessions.values()) {
      if (session.state === 'uploading' || session.state === 'awaiting') {
        session.controller.abort()
        this.settleFailed(session, 'upload_cancelled')
      }
      if (session.pipeline !== undefined) pipelines.push(session.pipeline.catch(() => undefined))
    }
    await Promise.allSettled(pipelines)
    await Promise.allSettled([...this.admissions].map(admission => admission.done))
    this.admissions.clear()
    this.sessions.clear()
  }

  /** Periodic sweep applying the same expiry rules as snapshot(). */
  private sweep(): void {
    if (this.destroyed) return
    for (const id of [...this.sessions.keys()]) this.snapshot(id)
  }
}
