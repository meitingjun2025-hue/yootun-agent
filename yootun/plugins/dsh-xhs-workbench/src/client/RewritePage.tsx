/**
 * 爆款仿写页（12 册 §3；旧 client.js Overlay 仿写区重译）：左栏 素材区（图片/
 * 视频 子 tab + 缩略列表 + 主题/文案方向/理解视频开关）+ 对标区 + 提交行；
 * 右栏 文案内容区按任务五态切换（空态/生成中/已生成/失败/已取消）。上传经
 * media-upload 同源路由（D-2）；提交只拦截当前素材组；上传失败不丢表单。
 * 发布面板随 X6 批次接入（本批占位，不新增顶级导航）。
 * @module
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostAction, pollUploadStatus, sendUploadBytes, startUploadSession } from './api.ts'
import { composeFullText, formatBytes, machineErrorText, stepLabel, toXhsPlainText, failureHint, type Translate } from './format.ts'
import css from './workbench.module.css'
import { createTaskMachine, type TaskMachine, type TaskVersion } from './task-machine.ts'
import { createUploadManager, type UploadAsset } from '../upload-machine.ts'
import { EditableResult, type EditedCopy } from './EditableResult.tsx'
import { PublishPanel } from './PublishPanel.tsx'

/** 图片素材组上限（D-4 定案：功能对齐旧插件 = 9）。 */
const MAX_IMAGES = 9

/** 模块级任务/上传状态跨页面开关保留（旧 overlay 单例同型：关闭页面停止轮询、
 * 重新打开继续查询）。监听集合驱动 useSyncExternalStore。 */
class RefCounted<T> {
  private readonly listeners = new Set<() => void>()
  constructor(private value: T) {}

  get(): T {
    return this.value
  }

  set(value: T): void {
    this.value = value
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

const taskMachineHolder = new RefCounted<TaskMachine | null>(null)
const uploadVersion = new RefCounted<number>(0)
const uploadHolder = new RefCounted<ReturnType<typeof createUploadManager> | null>(null)

function getTaskMachine(): TaskMachine {
  const existing = taskMachineHolder.get()
  if (existing !== null) return existing
  const machine = createTaskMachine({
    createTask: async input => {
      const res = await hostAction('task.create', { ...input })
      if (res.status !== 'created' || typeof res.taskId !== 'string') throw new Error('create_failed_no_task')
      return { taskId: res.taskId, taskStatus: typeof res.taskStatus === 'string' ? res.taskStatus : 'queued' }
    },
    queryStatus: async taskId => {
      const res = await hostAction('task.status', { taskId })
      return {
        taskStatus: String(res.taskStatus ?? 'unknown'),
        currentStep: typeof res.currentStep === 'string' ? res.currentStep : undefined,
        nextStep: typeof res.nextStep === 'string' ? res.nextStep : undefined,
        errorCode: typeof res.errorCode === 'string' ? res.errorCode : undefined,
        errorMessage: typeof res.errorMessage === 'string' ? res.errorMessage : undefined,
      }
    },
    queryResult: async taskId => {
      const res = await hostAction('task.result', { taskId })
      return { versions: Array.isArray(res.versions) ? res.versions as TaskVersion[] : [] }
    },
    cancelTask: async (taskId, idempotencyKey) => {
      await hostAction('task.cancel', { taskId, idempotencyKey })
      return undefined
    },
    onChange: () => { taskMachineHolder.set(taskMachineHolder.get()) },
  })
  taskMachineHolder.set(machine)
  return machine
}

function getUploadManager(): ReturnType<typeof createUploadManager> {
  const existing = uploadHolder.get()
  if (existing !== null) return existing
  const manager = createUploadManager({
    startSession: startUploadSession,
    sendBytes: sendUploadBytes,
    pollStatus: ({ uploadId }) => pollUploadStatus(uploadId),
    onChange: () => { uploadVersion.set(uploadVersion.get() + 1) },
  })
  uploadHolder.set(manager)
  return manager
}

function newIdempotencyKey(): string {
  if (globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `xhs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export interface RewritePageProps {
  t: Translate
}

/**
 * Render the rewrite page (素材区 + 对标区 | 文案内容区).
 * @param props - page translator.
 * @returns the page node.
 */
export function RewritePage(props: RewritePageProps): ReactNode {
  const t = props.t
  const [mediaTab, setMediaTab] = useState<'images' | 'video'>('images')
  const upload = getUploadManager()
  const [, setUploadTick] = useState(0)
  useEffect(() => uploadVersion.subscribe(() => { setUploadTick(tick => tick + 1) }), [])
  const machine = getTaskMachine()
  const machineState = useSyncExternalStore(
    taskMachineHolder.subscribe,
    () => machine.get(),
    () => machine.get(),
  )
  const imageInputRef = useRef<HTMLInputElement>(null)
  const videoInputRef = useRef<HTMLInputElement>(null)
  const [uploadError, setUploadError] = useState('')
  const [theme, setTheme] = useState('')
  const [direction, setDirection] = useState('')
  const [understandVideo, setUnderstandVideo] = useState(false)
  const [refNote, setRefNote] = useState('')
  const [refAccount, setRefAccount] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [confirmingRegen, setConfirmingRegen] = useState(false)
  const [edited, setEdited] = useState<EditedCopy | null>(null)
  const [copyState, setCopyState] = useState('')
  const { task, versions, error, failure } = machineState
  const taskStatus = task?.taskStatus ?? 'idle'
  const isTerminal = taskStatus === 'succeeded' || taskStatus === 'failed' || taskStatus === 'cancelled'
  const processing = task !== null && !isTerminal
  const canCancel = task !== null && !isTerminal

  // 发布面板账号来源：与账号管理页同一本地投影（只取会话有效账号）。
  const [publishAccounts, setPublishAccounts] = useState<Array<{ accountId: string; nickname: string | null }>>([])
  useEffect(() => {
    if (taskStatus !== 'succeeded') return
    void hostAction('accounts.list').then(res => {
      const rows = Array.isArray(res.accounts) ? res.accounts as Array<{ accountId: string; nickname: string | null; sessionStatus: string }> : []
      setPublishAccounts(rows.filter(row => row.sessionStatus === 'ok'))
    }).catch(() => { setPublishAccounts([]) })
  }, [taskStatus])

  const imageAssets = upload.list('image')
  const videoAsset = upload.list('video')[0] ?? null

  // 页面开关：挂载恢复轮询、卸载停止轮询（任务与上传都不取消，状态存模块级
  // 单例，重新进入页面 resume 继续）。
  useEffect(() => {
    void machine.resume()
    upload.resume()
    return () => {
      machine.stop()
      upload.stopAll()
      setConfirmingCancel(false)
    }
  }, [machine, upload])

  // 单版编辑态：随任务切换（重新生成）以最新结果重新初始化。
  useEffect(() => {
    if (versions === null || versions.length === 0 || task === null) return
    if (edited !== null && edited.taskId === task.taskId) return
    const first = versions[0]
    if (first === undefined) return
    setEdited({ taskId: task.taskId, title: first.title, body: toXhsPlainText(first.body), tags: [...first.tags], saved: false })
  }, [versions, task, edited])

  const pickAndUpload = async (kind: 'image' | 'video'): Promise<void> => {
    setUploadError('')
    const input = kind === 'image' ? imageInputRef.current : videoInputRef.current
    input?.click()
  }

  const onFilesChosen = async (kind: 'image' | 'video', fileList: FileList | null): Promise<void> => {
    if (fileList === null || fileList.length === 0) return
    if (kind === 'image') {
      // 竞态保护：对话框选择期间列表可能已被补满；超出上限的文件静默丢弃。
      const remaining = MAX_IMAGES - upload.list('image').length
      const files = [...fileList].slice(0, Math.max(0, remaining))
      for (const file of files) {
        await upload.start({
          kind: 'image', name: file.name, size: file.size, mime: file.type,
          previewUrl: URL.createObjectURL(file), file,
        })
      }
      if (files.length === 0) setUploadError(t('material.uploadFailed'))
    } else {
      // 视频重选 = 覆盖同一素材：先停掉旧视频的轮询再启动新上传。
      const previous = upload.list('video')[0]
      if (previous !== undefined) upload.remove(previous.id)
      const file = fileList[0]
      if (file !== undefined) {
        await upload.start({
          kind: 'video', name: file.name, size: file.size, mime: file.type,
          previewUrl: URL.createObjectURL(file), file,
        })
      }
    }
  }

  const removeAsset = (asset: UploadAsset): void => {
    upload.remove(asset.id)
  }

  const submittingGroup = mediaTab === 'images' ? imageAssets : (videoAsset !== null ? [videoAsset] : [])
  const hasMaterial = submittingGroup.length > 0
  const uploadingInGroup = submittingGroup.some(asset => asset.status === 'uploading')

  const onSubmit = async (): Promise<void> => {
    if (busy || processing) return
    // 拦截范围 = 本次提交所用素材组（当前 tab 对应的 images/video），不跨 tab 拦截。
    if (!hasMaterial) return
    if (uploadingInGroup) {
      setUploadError(t('material.uploadingBlock'))
      return
    }
    // url 齐全校验：failed/无 url 的素材不允许进入创建任务。
    if (submittingGroup.some(asset => asset.status !== 'uploaded' || asset.url === null)) {
      setUploadError(t('material.uploadFailed'))
      return
    }
    setUploadError('')
    setBusy(true)
    try {
      await machine.submit({
        mediaType: mediaTab,
        idempotencyKey: newIdempotencyKey(),
        ...(theme.trim() !== '' ? { theme: theme.trim() } : {}),
        ...(direction.trim() !== '' ? { direction: direction.trim() } : {}),
        ...(refNote.trim() !== '' ? { refNote: refNote.trim() } : {}),
        ...(refAccount.trim() !== '' ? { refAccount: refAccount.trim() } : {}),
        ...(mediaTab === 'images' ? { imageUrls: submittingGroup.map(asset => asset.url).filter((url): url is string => url !== null) } : { videoUrl: videoAsset?.url ?? '', videoUnderstanding: understandVideo }),
      })
    } finally {
      setBusy(false)
    }
  }

  const cancelCurrent = async (): Promise<void> => {
    if (busy || !canCancel) return
    setConfirmingCancel(false)
    setBusy(true)
    try {
      // 取消复用任务实例保存的原幂等键（machine 内部复用）。
      await machine.requestCancel()
    } finally {
      setBusy(false)
    }
  }

  // 重新生成：覆盖前确认（已定案），以当前表单内容重新创建任务（新幂等键）。
  const onRegenerate = async (): Promise<void> => {
    if (busy || processing) return
    setConfirmingRegen(false)
    await onSubmit()
  }

  const onCopyAll = async (): Promise<void> => {
    if (edited === null) return
    let ok = false
    try {
      await navigator.clipboard.writeText(composeFullText(edited))
      ok = true
    } catch {
      ok = false
    }
    setCopyState(ok ? 'copied' : 'failed')
    window.setTimeout(() => { setCopyState('') }, 2000)
  }

  const assetThumb = (asset: UploadAsset): ReactNode => (
    <figure className={css.thumb} key={asset.id}>
      <img className={css.thumbMedia} src={asset.localPreviewUrl} alt={asset.name} />
      {asset.kind === 'video' && <span className={css.thumbVideoBadge}>{t('material.videoBadge')}</span>}
      {asset.status === 'failed' && <div className={css.thumbError} role='alert'>{t('material.uploadFailed')}</div>}
      {asset.status === 'uploading' && (
        <div className={css.thumbProgress}>
          <span className={css.progressText}>
            <span>{asset.progress}%{asset.attempt > 0 ? ` · ${t('material.retrying')}` : ''}</span>
            {asset.bytesTotal > 0 && (
              <span>{t('material.uploadedBytes', { written: formatBytes(asset.bytesWritten) || '0 B', total: formatBytes(asset.bytesTotal) })}</span>
            )}
          </span>
          <span className={css.progressTrack}>
            <span className={css.progressFill} style={{ width: `${asset.progress}%` }} />
          </span>
        </div>
      )}
      <button
        type='button'
        className={css.thumbRemove}
        aria-label={t('material.remove')}
        onClick={() => { removeAsset(asset) }}
      >
        ×
      </button>
    </figure>
  )

  const left = (
    <div className={css.leftColumn}>
      <section className={css.section} aria-label={t('material.title')}>
        <h2 className={css.sectionTitle}>{t('material.title')}</h2>
        <div className={css.mediaTabs}>
          <SegmentedControl
            id='xhs-material-tab'
            value={mediaTab}
            label={t('material.title')}
            options={[
              { value: 'images', label: t('material.tab.images') },
              { value: 'video', label: t('material.tab.video') },
            ]}
            onChange={next => {
              // 切 tab 清文案方向（旧口径：图片/视频互切重置方向）。
              if (next !== mediaTab) setDirection('')
              setMediaTab(next)
            }}
          />
        </div>
        <div className={css.mediaGrid}>
          {mediaTab === 'images'
            ? (
                <>
                  {imageAssets.map(assetThumb)}
                  {imageAssets.length < MAX_IMAGES && (
                    <button
                      type='button'
                      className={css.addField}
                      aria-label={t('material.addImage')}
                      onClick={() => { void pickAndUpload('image') }}
                    >
                      +
                    </button>
                  )}
                </>
              )
            : (
                videoAsset !== null
                  ? assetThumb(videoAsset)
                  : (
                      <button
                        type='button'
                        className={css.addField}
                        aria-label={t('material.addVideo')}
                        onClick={() => { void pickAndUpload('video') }}
                      >
                        +
                      </button>
                    )
              )}
        </div>
        <input
          ref={imageInputRef}
          type='file'
          accept='image/*'
          multiple
          hidden
          aria-hidden='true'
          onChange={event => {
            void onFilesChosen('image', event.target.files)
            event.target.value = ''
          }}
        />
        <input
          ref={videoInputRef}
          type='file'
          accept='video/*'
          hidden
          aria-hidden='true'
          onChange={event => {
            void onFilesChosen('video', event.target.files)
            event.target.value = ''
          }}
        />
        {mediaTab === 'images' && <p className={css.hint}>{t('material.imageHint', { count: imageAssets.length })}</p>}
        {uploadError !== '' && <p className={css.errorText} role='alert'>{uploadError}</p>}
        {mediaTab === 'video' && (
          <div className={css.fieldRow}>
            <Switch
              checked={understandVideo}
              label={t('material.understandVideo')}
              onChange={setUnderstandVideo}
            />
            <p className={css.switchHint}>
              {understandVideo ? t('material.understandVideoHintOn') : t('material.understandVideoHintOff')}
            </p>
          </div>
        )}
        <div className={css.fieldRow}>
          <label className={css.fieldLabel} htmlFor='xhs-theme'>{t('material.theme')}</label>
          <Input
            id='xhs-theme'
            type='text'
            value={theme}
            maxLength={500}
            placeholder={t('material.themePlaceholder')}
            aria-label={t('material.theme')}
            onChange={event => { setTheme(event.target.value) }}
          />
        </div>
        <div className={css.fieldRow}>
          <label className={css.fieldLabel} htmlFor='xhs-direction'>{t('material.direction')}</label>
          <Input
            id='xhs-direction'
            type='text'
            value={direction}
            maxLength={500}
            placeholder={t('material.directionPlaceholder')}
            aria-label={t('material.direction')}
            onChange={event => { setDirection(event.target.value) }}
          />
        </div>
      </section>
      <section className={css.section} aria-label={t('reference.title')}>
        <h2 className={css.sectionTitle}>{t('reference.title')}</h2>
        <div className={css.fieldRow}>
          <label className={css.fieldLabel} htmlFor='xhs-ref-note'>{t('reference.note')}</label>
          <Input
            id='xhs-ref-note'
            type='text'
            value={refNote}
            maxLength={2048}
            placeholder={t('reference.notePlaceholder')}
            aria-label={t('reference.note')}
            onChange={event => { setRefNote(event.target.value) }}
          />
        </div>
        <div className={css.fieldRow}>
          <label className={css.fieldLabel} htmlFor='xhs-ref-account'>{t('reference.account')}</label>
          <Input
            id='xhs-ref-account'
            type='text'
            value={refAccount}
            maxLength={200}
            placeholder={t('reference.accountPlaceholder')}
            aria-label={t('reference.account')}
            onChange={event => { setRefAccount(event.target.value) }}
          />
        </div>
      </section>
      <div className={css.actionRow}>
        {/* 素材组内 uploading 时按钮可点但置灰并提示（旧 aria-disabled 口径，不阻断点击）。 */}
        <Button
          variant='primary'
          className={uploadingInGroup ? css.submitWait : undefined}
          aria-disabled={uploadingInGroup || !hasMaterial || undefined}
          disabled={busy || processing || (!hasMaterial && !uploadingInGroup)}
          onClick={() => { void onSubmit() }}
        >
          {busy || processing ? t('action.submitting') : t('action.submit')}
        </Button>
        <Button
          variant='ghost'
          disabled={!canCancel || busy}
          onClick={() => { setConfirmingCancel(true) }}
        >
          {t('action.cancelTask')}
        </Button>
      </div>
    </div>
  )

  const hintForFailure = taskStatus === 'failed' && failure !== null ? failureHint(failure.errorCode, failure.errorMessage, t) : ''

  let right: ReactNode
  if (taskStatus === 'succeeded' && versions !== null && versions.length > 0 && edited !== null) {
    right = (
      <>
        {/* key 随任务切换：重新生成后重置编辑卡内部状态（正文模式/标签草稿）。 */}
        <EditableResult
          key={edited.taskId}
          version={versions[0] as TaskVersion}
          edited={edited}
          onEditedChange={next => { setEdited({ ...next, saved: false }) }}
          t={t}
        />
        <div className={css.resultActions}>
          <Button
            variant='ghost'
            disabled={busy || !hasMaterial || uploadingInGroup}
            aria-disabled={uploadingInGroup || undefined}
            onClick={() => { setConfirmingRegen(true) }}
          >
            {t('action.regenerate')}
          </Button>
          <Button variant='ghost' onClick={() => { void onCopyAll() }}>
            {copyState === 'copied' ? t('action.copiedAll') : copyState === 'failed' ? t('action.copyAllFailed') : t('action.copyAll')}
          </Button>
          <Button variant='primary' onClick={() => { setEdited({ ...edited, saved: true }) }}>
            {edited.saved ? t('action.savedEdit') : t('action.saveEdit')}
          </Button>
        </div>
        {/* 发布面板（发布降级版）：按当前素材类型直达图文/视频发布页。 */}
        <PublishPanel accounts={publishAccounts} target={mediaTab === 'video' ? 'video' : 'image'} t={t} />
      </>
    )
  } else if (error !== '') {
    const machineText = machineErrorText(error, t)
    right = (
      <div className={css.stateBlock} role='alert'>
        <p className={css.stateErrorText}>{machineText !== '' ? machineText : t('error.default')}</p>
        {hintForFailure !== '' && <p>{hintForFailure}</p>}
        {taskStatus === 'failed' && failure !== null && failure.step !== '' && (
          <p className={css.stepLine}>{t('result.failedStep')} · {stepLabel(failure.step, t)}</p>
        )}
        <p className={css.hint}>{t('result.failedHint')}</p>
      </div>
    )
  } else if (processing) {
    right = (
      <div className={css.stateBlock} role='status'>
        <p>{t('result.processing')}</p>
        {task?.currentStep !== undefined && task.currentStep !== '' && (
          <p className={css.stepLine}>{t('result.stepLabel')} · {stepLabel(task.currentStep, t)}</p>
        )}
      </div>
    )
  } else {
    right = (
      <div className={css.stateBlock} role='status'>
        <p>{t('result.empty')}</p>
      </div>
    )
  }

  return (
    <div className={css.rewriteLayout}>
      {left}
      <div className={css.rightColumn} aria-label={t('result.title')}>
        <h2 className={css.rightTitle}>{t('result.title')}</h2>
        {right}
      </div>
      <Modal
        open={confirmingCancel}
        onClose={() => { setConfirmingCancel(false) }}
        title={t('action.cancelTask')}
        closeLabel={t('action.confirmNo')}
      >
        <p className={css.confirmText}>{t('action.cancelConfirm')}</p>
        <div className={css.actionRow}>
          <Button variant='primary' onClick={() => { void cancelCurrent() }}>{t('action.confirmYes')}</Button>
          <Button variant='ghost' onClick={() => { setConfirmingCancel(false) }}>{t('action.confirmNo')}</Button>
        </div>
      </Modal>
      <Modal
        open={confirmingRegen}
        onClose={() => { setConfirmingRegen(false) }}
        title={t('action.regenerate')}
        closeLabel={t('action.confirmNo')}
      >
        <p className={css.confirmText}>{t('action.regenerateConfirm')}</p>
        <div className={css.actionRow}>
          <Button variant='primary' onClick={() => { void onRegenerate() }}>{t('action.confirmYes')}</Button>
          <Button variant='ghost' onClick={() => { setConfirmingRegen(false) }}>{t('action.confirmNo')}</Button>
        </div>
      </Modal>
    </div>
  )
}
