/**
 * 素材上传状态机（迁移旧 client.js createUploadManager 全行为，transport 适配
 * `@yootun/dsh-media-upload` 既有同源路由，D-2）：per-asset 管理「已选即预览 +
 * 进度轮询 + 终态」。
 *
 * 新链路（media-upload 契约，本地路径从不存在）：pick-file 创建会话（uploadId/
 * accept/maxBytes）→ 浏览器 file input 选中的字节经 uploadStart（头携带
 * filename/content-type/size，请求体为字节流）暂存并后台直传 → uploadStatus
 * 轮询（waiting/uploading/done/failed + progress/bytesSent/attempt）→ done 携带
 * 公网 URL。预览 URL 由调用方提供（浏览器 objectURL），machine 不触碰本地路径。
 *
 * 行为等价（test/upload-machine.test.mjs 全量移植）：done → uploaded（保留
 * receivedDone 防竞态）；failed → failed；not_found 仅当「从未收到过 done」才置
 * failed（P2 兜底）；暂态轮询失败连续超限（maxPollErrors）置 failed；remove/
 * stopAll 停对应轮询（宿主侧上传继续，resume 可追上进度）；hasUploading(kind)
 * 供「开始生成」按素材组拦截（不跨 tab）；attempt 递增供「重试中」展示。
 * @module
 */

/** pick-file 会话信息（media-upload 契约）。 */
export interface UploadSessionInfo {
  uploadId: string
  accept: string[]
  maxBytes: number
}

/** uploadStatus 快照（media-upload 契约投影；缺失字段由 machine 容错）。 */
export interface UploadStatusSnapshot {
  status: 'waiting' | 'uploading' | 'done' | 'failed'
  progress?: number
  bytesSent?: number
  bytesTotal?: number
  attempt?: number
  url?: string
  error?: string
}

/** 一次上传请求入参（file 由调用方持有并传给 sendBytes，machine 不解读）。 */
export interface UploadAssetInput {
  kind: 'image' | 'video'
  name: string
  size: number
  mime: string
  /** 浏览器侧预览 URL（objectURL）；仅存内存，不落日志。 */
  previewUrl: string
  file: unknown
}

/** machine 维护的单素材状态（字段名对齐旧 client.js，client 半直接消费）。 */
export interface UploadAsset {
  id: string
  kind: 'image' | 'video'
  name: string
  size: number
  mime: string
  status: 'uploading' | 'uploaded' | 'failed'
  attempt: number
  progress: number
  bytesWritten: number
  bytesTotal: number
  url: string | null
  error: string
  receivedDone: boolean
  pollErrors: number
  uploadId: string | null
  localPreviewUrl: string
  file: unknown
}

/** machine 注入面（测试以假路由应答替换）。 */
export interface UploadMachinePorts {
  /** pick-file：创建上传会话；失败（网络/非 2xx）返回 null 或抛错。 */
  startSession(kind: 'image' | 'video'): Promise<UploadSessionInfo | null>
  /** uploadStart：字节流推送；接受返回 true，失败返回 false 或抛错。 */
  sendBytes(input: { uploadId: string; file: unknown }): Promise<boolean>
  /** uploadStatus：进度轮询；传输层/HTTP 失败返回 null 或抛错。 */
  pollStatus(input: { uploadId: string }): Promise<UploadStatusSnapshot | null>
  /** 轮询间隔（旧 350ms）。 */
  intervalMs?: number
  /** 连续暂态轮询失败上限（旧 10）。 */
  maxPollErrors?: number
  schedule?: ((fn: () => void) => unknown) | undefined
  clearSchedule?: ((id: unknown) => void) | undefined
  onChange?: (() => void) | undefined
  idFactory?: (() => string) | undefined
}

export interface UploadMachine {
  start(input: UploadAssetInput): Promise<UploadAsset>
  remove(id: string): void
  stopAll(): void
  resume(): void
  get(id: string): UploadAsset | null
  list(kind: 'image' | 'video'): UploadAsset[]
  hasUploading(kind: 'image' | 'video'): boolean
  readonly size: number
}

function progressPercent(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
}

/**
 * Create the per-asset upload machine.
 * @param ports - injected transport seams and timers.
 * @returns the machine.
 */
export function createUploadManager(ports: UploadMachinePorts): UploadMachine {
  const intervalMs = ports.intervalMs ?? 350
  const maxPollErrors = ports.maxPollErrors ?? 10
  const schedule = ports.schedule ?? ((fn: () => void) => setTimeout(fn, intervalMs))
  const clearSchedule = ports.clearSchedule ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout))

  /** @type {Map<string, UploadAsset>} assetId -> 素材对象 */
  const assets = new Map<string, UploadAsset>()
  /** @type {Map<string, unknown>} assetId -> 轮询定时器 */
  const timers = new Map<string, unknown>()
  // 面板关闭（stopAll）后置位：挡住 in-flight 轮询回调把轮询「复活」。
  let suspended = false
  let seq = 0
  const nextId = (): string => {
    if (typeof ports.idFactory === 'function') return ports.idFactory()
    seq += 1
    return `asset-${seq}-${Math.random().toString(36).slice(2, 8)}`
  }

  const emit = (): void => ports.onChange?.()
  const list = (kind: 'image' | 'video'): UploadAsset[] => [...assets.values()].filter(asset => asset.kind === kind)
  const hasUploading = (kind: 'image' | 'video'): boolean => list(kind).some(asset => asset.status === 'uploading')

  function schedulePoll(id: string, uploadId: string): void {
    if (suspended) return
    // intervalMs 属于默认 schedule 实现；注入的 schedule 自带节奏（测试假定时器）。
    const timer = schedule(async () => {
      timers.delete(id)
      const asset = assets.get(id)
      // 已移除/覆盖/终结/换 uploadId：停止本轮轮询。
      if (asset === undefined || asset.uploadId !== uploadId || asset.status !== 'uploading') return
      let status: UploadStatusSnapshot | null = null
      try {
        status = await ports.pollStatus({ uploadId })
      } catch {
        status = null
      }
      // 面板在请求在途期间被关闭：丢弃本次结果，resume 后会重新轮询取回终态。
      if (suspended) return
      const current = assets.get(id)
      if (current === undefined || current.uploadId !== uploadId || current.status !== 'uploading') return
      if (status === null) {
        // 传输层/HTTP 层失败：可能为暂态，连续超限才置 failed，避免永久空转。
        current.pollErrors = (current.pollErrors ?? 0) + 1
        if (current.pollErrors > maxPollErrors) {
          current.status = 'failed'
          current.error = 'uploadFailed'
          emit()
          return
        }
        emit()
        schedulePoll(id, uploadId)
        return
      }
      current.pollErrors = 0
      if (status.status === 'waiting' || status.status === 'uploading') {
        // waiting（字节已受理、宿主尚未开传）按 uploading 口径展示，进度照快照。
        current.attempt = Number.isFinite(status.attempt) ? status.attempt as number : 0
        current.bytesWritten = status.bytesSent ?? 0
        current.bytesTotal = status.bytesTotal ?? current.size ?? 0
        current.progress = progressPercent(status.progress)
        emit()
        schedulePoll(id, uploadId)
        return
      }
      if (status.status === 'done') {
        current.status = 'uploaded'
        current.url = typeof status.url === 'string' ? status.url : null
        current.receivedDone = true
        current.progress = 100
        emit()
        return
      }
      if (status.status === 'failed') {
        current.status = 'failed'
        current.error = 'uploadFailed'
        emit()
        return
      }
      // not_found：仅当从未收到过 done 才置 failed；此前收到过 done 则忽略（P2）。
      if (current.receivedDone !== true) {
        current.status = 'failed'
        current.error = 'uploadFailed'
        emit()
      }
    })
    timers.set(id, timer)
  }

  async function start(input: UploadAssetInput): Promise<UploadAsset> {
    const id = nextId()
    const asset: UploadAsset = {
      id,
      kind: input.kind,
      name: input.name ?? '',
      size: input.size ?? 0,
      mime: input.mime ?? '',
      status: 'uploading',
      attempt: 0,
      progress: 0,
      bytesWritten: 0,
      bytesTotal: input.size ?? 0,
      url: null,
      error: '',
      receivedDone: false,
      pollErrors: 0,
      uploadId: null,
      localPreviewUrl: input.previewUrl,
      file: input.file,
    }
    assets.set(id, asset)
    emit()
    // 建会话（pick-file）：网络层/解析层异常与返回 null 同归一置 failed，避免素材
    // 停在 uploading 却无轮询、异常向上冒泡（旧 startUpload 兜底同型）。
    let session: UploadSessionInfo | null = null
    try {
      session = await ports.startSession(input.kind)
    } catch {
      session = null
    }
    const registered = assets.get(id)
    if (registered === undefined) return asset
    if (session === null) {
      registered.status = 'failed'
      registered.error = 'uploadFailed'
      emit()
      return asset
    }
    registered.uploadId = session.uploadId
    registered.bytesTotal = registered.size
    // 本地预检：超限直接 failed（宿主侧 maxBytes 仍兜底，双层一致）。
    if (registered.size > session.maxBytes) {
      registered.status = 'failed'
      registered.error = 'uploadFailed'
      emit()
      return asset
    }
    let accepted = false
    try {
      accepted = await ports.sendBytes({ uploadId: session.uploadId, file: input.file })
    } catch {
      accepted = false
    }
    const afterSend = assets.get(id)
    if (afterSend === undefined) return asset
    if (accepted !== true) {
      // uploadStart 快速失败（校验/授权/未登记）：素材置 failed，可移除重选。
      afterSend.status = 'failed'
      afterSend.error = 'uploadFailed'
      emit()
      return asset
    }
    emit()
    schedulePoll(id, session.uploadId)
    return asset
  }

  function remove(id: string): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      clearSchedule(timer)
      timers.delete(id)
    }
    if (assets.delete(id)) emit()
  }

  /** 关闭面板：停止全部轮询（宿主侧上传继续，重开面板 resume 可追上进度）。 */
  function stopAll(): void {
    suspended = true
    for (const timer of timers.values()) clearSchedule(timer)
    timers.clear()
  }

  /** 重开面板：为仍在 uploading 且已有 uploadId 的素材恢复轮询。 */
  function resume(): void {
    suspended = false
    for (const asset of assets.values()) {
      if (asset.status === 'uploading' && asset.uploadId !== null && !timers.has(asset.id)) {
        schedulePoll(asset.id, asset.uploadId)
      }
    }
  }

  return {
    start,
    remove,
    stopAll,
    resume,
    get: id => assets.get(id) ?? null,
    list,
    hasUploading,
    get size(): number { return assets.size },
  }
}
