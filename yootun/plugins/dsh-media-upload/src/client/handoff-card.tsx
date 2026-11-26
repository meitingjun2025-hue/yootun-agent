/**
 * 「上传请求」承接卡片（shell.overlay）：media_upload 会话工具创建的上传
 * 会话在这里出现，用户经原生 file input 选择文件，字节经既有 uploadStart
 * 路由回流宿主直传；卡片轮询 pending 路由发现会话（页面自己发起的 origin
 * page 上传不出现在 pending，不触发卡片）、按 uploadStatus 显示进度、经
 * cancel 路由取消。轮询只在挂载且页面可见时进行；pending 返回的会话集合
 * 是事实源，不在其中的在途条目立即移除。done 不展示 URL（URL 由工具返回
 * 模型）。
 * @module
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import { KIND_EXTENSIONS } from '../constants.ts'
import { cancelUpload, pendingUploads, pollUploadStatus, sendUploadBytes } from './upload-api.ts'
import type { HandoffLocaleKey } from './locales.ts'
import type { PendingUploadSession } from './upload-api.ts'
import css from './handoff.module.css'

/** Props of the handoff-card list (the `shell.overlay` entry). */
export interface HandoffCardProps {
  /** Translate a dictionary key of the mediaUpload namespace. */
  t: Translate<HandoffLocaleKey>
}

/** 一个卡片条目的本地状态机：picking → uploading → done ｜ failed。 */
interface HandoffItem {
  session: PendingUploadSession
  phase: 'picking' | 'uploading' | 'done' | 'failed'
  progress: number
  /** failed 阶段的宿主稳定错误码（经词典映射展示）。 */
  reason: string | undefined
}

/** pending 轮询节奏（毫秒）。 */
const PENDING_POLL_MS = 3000
/** uploadStatus 轮询节奏（毫秒）。 */
const STATUS_POLL_MS = 1000
/** done 卡片的收起延迟（毫秒）。 */
const DONE_REMOVE_MS = 2000
/** 同时展开的卡片上限，其余折叠计数。 */
const MAX_CARDS = 3

/**
 * 用服务端 pending 集合对账本地条目：服务端集合是事实源——不在其中的
 * picking/uploading 条目立即移除（宿主已取消或过期后卡片不残留）；本地已
 * 进入 uploading 的条目在 pending 仍含该 id 时保留本地进度视图；本地终态
 * 条目（done 等收起定时器、failed 等用户处置）不被对账移除。展示顺序跟随
 * 服务端（创建时间升序）。
 * @param current - the local items.
 * @param sessions - the server projection.
 * @returns the reconciled items in server order, terminal locals last.
 */
function reconcile(current: HandoffItem[], sessions: PendingUploadSession[]): HandoffItem[] {
  const serverIds = new Set(sessions.map(session => session.uploadId))
  const kept: HandoffItem[] = []
  for (const session of sessions) {
    const existing = current.find(item => item.session.uploadId === session.uploadId)
    kept.push(existing ?? { session, phase: 'picking', progress: 0, reason: undefined })
  }
  for (const item of current) {
    if (!serverIds.has(item.session.uploadId) && (item.phase === 'done' || item.phase === 'failed')) {
      kept.push(item)
    }
  }
  return kept
}

/** failed 稳定码 → 词典键（未列出的码一律落到缺省文案）。 */
function reasonKey(code: string | undefined): HandoffLocaleKey {
  if (code === 'file_too_large') return 'handoff.reason.file_too_large'
  if (code === 'extension_not_allowed') return 'handoff.reason.extension_not_allowed'
  if (code === 'upload_timeout') return 'handoff.reason.upload_timeout'
  if (code === 'uploader_not_configured') return 'reason.uploader_not_configured'
  if (code === 'storage_auth_failed') return 'reason.storage_auth_failed'
  return 'handoff.reason.default'
}

/** kind → 原生 file input 的 accept 值（宿主侧扩展名白名单同源）。 */
function acceptOf(kind: string): string {
  const extensions = KIND_EXTENSIONS[kind] ?? KIND_EXTENSIONS.media ?? []
  return extensions.map(extension => `.${extension}`).join(',')
}

/**
 * Render the upload-request handoff cards, or nothing while none is pending.
 * Polling runs only while mounted and the page is visible: pending every
 * 3s, uploadStatus every 1s for locally-uploading items; hidden stops the
 * pending chain (the status timer idles) and becoming visible fetches once
 * immediately. Unmount clears the timers and bumps the generation guard so
 * in-flight responses never write state.
 * @param props - the locale seat.
 * @returns the card list.
 */
export function HandoffCard({ t }: HandoffCardProps): ReactNode {
  const [items, setItems] = useState<HandoffItem[]>([])
  const itemsRef = useRef<HandoffItem[]>([])
  /** 代次守卫：卸载（cleanup 里 +1）后，在途请求与定时器不得再写状态。 */
  const generationRef = useRef(0)
  /** done 收起定时器，卸载时统一清除。 */
  const timersRef = useRef(new Set<number>())

  useEffect(() => {
    const gen = generationRef.current
    const alive = (): boolean => generationRef.current === gen
    let pendingTimer: number | undefined

    const patchItem = (uploadId: string, patch: (item: HandoffItem) => HandoffItem): void => {
      setItems(current => current.map(item => item.session.uploadId === uploadId ? patch(item) : item))
    }

    const removeItem = (uploadId: string): void => {
      setItems(current => current.filter(item => item.session.uploadId !== uploadId))
    }

    const scheduleRemove = (uploadId: string): void => {
      const timer = window.setTimeout(() => {
        timersRef.current.delete(timer)
        if (!alive()) return
        removeItem(uploadId)
      }, DONE_REMOVE_MS)
      timersRef.current.add(timer)
    }

    const fetchPending = async (): Promise<void> => {
      const sessions = await pendingUploads()
      if (!alive()) return
      // 暂态失败（传输 / 非 2xx / 载荷不合法）不等于服务端已清空：跳过对账，
      // 保留本地条目等下一轮；会话仍在等待的用户不会因为一次失败丢掉卡片。
      if (sessions !== null) setItems(current => reconcile(current, sessions))
    }

    const runPending = (): void => {
      void fetchPending().then(() => {
        if (!alive() || document.visibilityState !== 'visible') return
        pendingTimer = window.setTimeout(runPending, PENDING_POLL_MS)
      })
    }

    const pollStatuses = async (): Promise<void> => {
      // 逐条 await：单条失败不阻塞其余条目；每步后过代次守卫。
      for (const item of itemsRef.current) {
        if (item.phase !== 'uploading') continue
        const uploadId = item.session.uploadId
        const status = await pollUploadStatus(uploadId)
        if (!alive()) return
        if (status === null) continue
        if (status.status === 'done') {
          patchItem(uploadId, entry => entry.phase !== 'done' ? { ...entry, phase: 'done', progress: 100 } : entry)
          scheduleRemove(uploadId)
        } else if (status.status === 'failed' || status.status === 'not_found') {
          patchItem(uploadId, entry => entry.phase !== 'done' ? { ...entry, phase: 'failed', reason: status.error } : entry)
        } else if (Number.isFinite(status.progress)) {
          const progress = Math.max(0, Math.min(100, Math.floor(status.progress ?? 0)))
          patchItem(uploadId, entry => entry.phase === 'uploading' ? { ...entry, progress } : entry)
        }
      }
    }

    const statusTimer = window.setInterval(() => {
      // 隐藏期间不轮询：定时器保留但空转跳过。
      if (document.visibilityState !== 'visible') return
      void pollStatuses()
    }, STATUS_POLL_MS)

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        // 恢复可见立即拉一次，并重启 pending 节奏。
        if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)
        runPending()
        return
      }
      // 隐藏即停：不再安排下一轮 pending。
      if (pendingTimer !== undefined) {
        window.clearTimeout(pendingTimer)
        pendingTimer = undefined
      }
    }

    document.addEventListener('visibilitychange', onVisibility)
    if (document.visibilityState === 'visible') runPending()
    return () => {
      generationRef.current += 1
      document.removeEventListener('visibilitychange', onVisibility)
      if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)
      window.clearInterval(statusTimer)
      for (const timer of timersRef.current) window.clearTimeout(timer)
      timersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  /** 选中文件：本地先进 uploading，uploadStart 拒绝（大小/类型白名单）则按稳定码落 failed，会话仍 awaiting 可重选。 */
  const onFile = async (uploadId: string, file: File): Promise<void> => {
    const gen = generationRef.current
    setItems(current => current.map(item => item.session.uploadId === uploadId && (item.phase === 'picking' || item.phase === 'failed')
      ? { ...item, phase: 'uploading', progress: 0, reason: undefined }
      : item))
    const started = await sendUploadBytes({ uploadId, file })
    if (generationRef.current !== gen) return
    if (!started.ok) {
      setItems(current => current.map(item => item.session.uploadId === uploadId && item.phase === 'uploading'
        ? { ...item, phase: 'failed', reason: started.error }
        : item))
    }
  }

  /** 取消：成功（含 not_running）即移除卡片；请求失败自动重试一次，仍失败保留卡片等 pending 对账收敛。 */
  const onCancel = async (uploadId: string): Promise<void> => {
    const gen = generationRef.current
    const first = await cancelUpload(uploadId)
    if (generationRef.current !== gen) return
    if (first !== null) {
      setItems(current => current.filter(item => item.session.uploadId !== uploadId))
      return
    }
    const second = await cancelUpload(uploadId)
    if (generationRef.current !== gen) return
    if (second !== null) setItems(current => current.filter(item => item.session.uploadId !== uploadId))
  }

  const onDismiss = (uploadId: string): void => {
    setItems(current => current.filter(item => item.session.uploadId !== uploadId))
  }

  if (items.length === 0) return null
  const visible = items.slice(0, MAX_CARDS)
  const more = items.length - visible.length
  return (
    <div className={css.layer}>
      {visible.map(item => (
        <HandoffItemCard
          key={item.session.uploadId}
          item={item}
          t={t}
          onFile={onFile}
          onCancel={onCancel}
          onDismiss={onDismiss}
        />
      ))}
      {more > 0 ? <div className={css.more}>{t('handoff.more', { count: more })}</div> : null}
    </div>
  )
}

/** Props of one card. */
interface HandoffItemCardProps {
  item: HandoffItem
  t: Translate<HandoffLocaleKey>
  onFile: (uploadId: string, file: File) => Promise<void>
  onCancel: (uploadId: string) => Promise<void>
  onDismiss: (uploadId: string) => void
}

/**
 * Render one upload-request card: identity line, phase body, and its actions.
 * The element announces itself politely (role="status") without taking focus
 * or trapping Escape — the user either picks a file or cancels; the hidden
 * native file input is reached through its visible button.
 * @param props - the item, locale seat, and the three actions.
 * @returns the card.
 */
function HandoffItemCard({ item, t, onFile, onCancel, onDismiss }: HandoffItemCardProps): ReactNode {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const uploadId = item.session.uploadId
  const pick = (): void => { inputRef.current?.click() }
  return (
    <article className={css.card} role="status" aria-live="polite">
      <input
        ref={inputRef}
        type="file"
        accept={acceptOf(item.session.kind)}
        className={css.input}
        aria-hidden="true"
        tabIndex={-1}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void onFile(uploadId, file)
        }}
      />
      <header className={css.header}>
        <span className={css.title}>{t('handoff.title')}</span>
        <span className={css.session}>{t('handoff.requestRef', { id: uploadId.slice(0, 8) })}</span>
      </header>
      {item.phase === 'picking' ? <p className={css.hint}>{t('handoff.hint')}</p> : null}
      {item.phase === 'uploading' ? <p className={css.progress}>{t('handoff.picking', { progress: item.progress })}</p> : null}
      {item.phase === 'done' ? <p className={css.done}>{t('handoff.done')}</p> : null}
      {item.phase === 'failed' ? (
        <p className={css.failed}>{t('handoff.failed', { reason: t(reasonKey(item.reason)) })}</p>
      ) : null}
      <footer className={css.actions}>
        {item.phase === 'picking' ? <Button size="sm" variant="primary" onClick={pick}>{t('handoff.pick')}</Button> : null}
        {item.phase === 'failed' ? <Button size="sm" variant="primary" onClick={pick}>{t('handoff.retry')}</Button> : null}
        {item.phase === 'failed' ? <Button size="sm" onClick={() => onDismiss(uploadId)}>{t('handoff.dismiss')}</Button> : null}
        {item.phase === 'picking' || item.phase === 'uploading' ? (
          <Button size="sm" onClick={() => void onCancel(uploadId)}>{t('handoff.cancel')}</Button>
        ) : null}
      </footer>
    </article>
  )
}
