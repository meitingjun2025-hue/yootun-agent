/**
 * AssistantDock：插件助手 Dock（分册规范 §六）。宽容器（≥1120px）为右侧
 * 固定面板并压缩内容区；窄容器为右侧浮层（遮罩 + Escape 关闭，焦点由调用方
 * 归还触发按钮）。解剖：Header（模型 chip + 状态 + 操作）、上下文条、消息流
 * （回执嵌在回答内）、建议、composer（Enter 发送 / Shift+Enter 换行 / IME
 * 守卫 / Stop）。同一时刻只允许一个请求，草稿由调用方持久化。
 * @module
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button, StateDot, observeComposition } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import { composerKeyAction, sendDisabledReason, shouldStickToBottom } from './composer-logic.ts'
import css from './assistant-dock.module.css'

/** Assistant availability; `unavailable` disables the composer with a reason. */
export type AssistantStatus = 'live' | 'loading' | 'unavailable'

/** One removable context reference chip. */
export interface AssistantContextChip {
  id: string
  /** Localized chip label (truncated display; the Host holds the full context). */
  label: string
  onRemove: () => void
}

/** One message in the stream. */
export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  /** Message body node (caller renders receipts inline for assistant turns). */
  content: ReactNode
}

/** Composer textarea height limits (§六: auto-grow from one row up to 140px). */
const COMPOSER_MIN_PX = 28
const COMPOSER_MAX_PX = 140

export interface AssistantDockProps {
  /** Whether the dock is open; callers own the toggle state. */
  open: boolean
  /** Close request (Escape, mask click, close button); callers restore trigger focus. */
  onClose: () => void
  /** Assistant availability. */
  status: AssistantStatus
  /** Model chip content (e.g. 「默认模型 · deepseek-v4-flash」); caller-owned copy. */
  modelChip?: ReactNode
  /** Current context reference chips. */
  context?: readonly AssistantContextChip[]
  /** Conversation messages in order. */
  messages?: readonly AssistantMessage[]
  /** Suggestion prompts; the caller trims per §6.1 (four on the empty state, two during a conversation). */
  suggestions?: readonly string[]
  /** Suggestion click handler. */
  onSuggest?: (prompt: string) => void
  /** Clears the conversation; callers confirm before invoking. */
  onClear?: () => void
  /** Composer draft value. */
  draft: string
  /** Draft change handler. */
  onDraftChange: (value: string) => void
  /** Whether a request is in flight (Send becomes Stop). */
  busy: boolean
  /** Send handler; invoked only when the composer is enabled. */
  onSend: () => void
  /** Stop handler for the in-flight request. */
  onStop: () => void
  /** Why the model is unusable when `status` is `unavailable`; selects the disabled-reason copy. */
  unavailableReason?: 'model' | 'unauthorized'
}

/**
 * Render the assistant dock. Placement follows the page container width:
 * ≥1120px renders as a side panel (the content region compresses), narrower
 * widths render as a right overlay with a mask. Escape and mask clicks only
 * request close; the caller returns focus to the trigger button.
 * @param props - dock state and handlers.
 * @returns the dock node, or null when closed.
 */
export function AssistantDock(props: AssistantDockProps): ReactNode {
  const t = useKitLocale()
  const { open, onClose, status, modelChip, context, messages, suggestions, onSuggest, onClear, draft, onDraftChange, busy, onSend, onStop, unavailableReason } = props
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const streamRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLElement>(null)
  const composition = useRef<{ guards(event: KeyboardEvent): boolean; dispose(): void } | undefined>(undefined)

  // The composition observer lives per open lifetime; its guards() covers the
  // IME closing Enter that fires after compositionend.
  useEffect(() => {
    if (!open) return undefined
    composition.current = observeComposition(document)
    return () => {
      composition.current?.dispose()
      composition.current = undefined
    }
  }, [open])

  // Auto-scroll follows new content only when the user is already near the
  // bottom; scrolled-up readers are never pulled back.
  useLayoutEffect(() => {
    const stream = streamRef.current
    if (stream === null || !shouldStickToBottom(stream)) return
    stream.scrollTop = stream.scrollHeight
  }, [messages, open])

  // Escape closes the dock only when it belongs to the dock: the event
  // originates inside it, or the dock is currently the overlay placement
  // (computed `position: fixed`). Side-panel mode never steals Escape from
  // the rest of the page (search boxes, IME cancels). Drafts are caller-owned
  // state and never deleted by closing.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // IME 组词期/收尾键的 Escape 属于输入法（取消组词），不关 Dock。
      if (composition.current?.guards(event) === true || event.isComposing) return
      const dock = dockRef.current
      if (dock === null) return
      const inside = event.target instanceof Node && dock.contains(event.target)
      const overlay = inside ? false : getComputedStyle(dock).position === 'fixed'
      if (!inside && !overlay) return
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // Auto-grow: one row up to 140px, then internal scrolling.
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (composer === null) return
    composer.style.height = 'auto'
    composer.style.height = `${Math.min(COMPOSER_MAX_PX, Math.max(COMPOSER_MIN_PX, composer.scrollHeight))}px`
  }, [draft, open])

  if (!open) return null

  const empty = draft.trim() === ''
  const disabled = sendDisabledReason({
    busy,
    modelAvailable: status !== 'unavailable',
    unauthorized: unavailableReason === 'unauthorized',
    empty,
  })
  const canSend = disabled === undefined
  const statusLabel = t(`dock.status.${status}`)
  const sendDisabledTitle = disabled === undefined ? undefined : t(`dock.sendDisabled.${disabled}`)

  return (
    <div className={css.layer}>
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <aside ref={dockRef} className={css.dock} role="complementary" aria-label={t('dock.title')}>
        <header className={css.head}>
          <div className={css.headRow}>
            <span className={css.title}>{t('dock.title')}</span>
            <span className={css.status}>
              <StateDot state={status === 'live' ? 'done' : status === 'loading' ? 'ongoing' : 'idle'} size={10} />
              <span>{statusLabel}</span>
            </span>
          </div>
          <div className={css.headRow}>
            {modelChip !== undefined && <span className={css.modelChip}>{modelChip}</span>}
            <span className={css.headActions}>
              {onClear !== undefined && <Button variant="ghost" size="sm" onClick={onClear}>{t('dock.clear')}</Button>}
              <Button variant="ghost" size="sm" onClick={onClose}>{t('dock.close')}</Button>
            </span>
          </div>
        </header>
        {context !== undefined && context.length > 0 && (
          <div className={css.contextStrip}>
            {context.map(chip => (
              <span key={chip.id} className={css.contextChip}>
                <span className={css.contextLabel}>{chip.label}</span>
                <button
                  type="button"
                  className={css.contextRemove}
                  aria-label={t('dock.context.remove', { context: chip.label })}
                  onClick={chip.onRemove}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={css.stream} ref={streamRef}>
          {suggestions !== undefined && suggestions.length > 0 && (
            <div className={css.suggestions}>
              <span className={css.suggestTitle}>{t('dock.suggestTitle')}</span>
              {suggestions.map(prompt => (
                <Button key={prompt} variant="outline" size="sm" className={css.suggestion} onClick={() => onSuggest?.(prompt)}>
                  {prompt}
                </Button>
              ))}
            </div>
          )}
          {messages?.map(message => (
            <div key={message.id} className={message.role === 'user' ? css.userMessage : css.assistantMessage}>
              {message.content}
            </div>
          ))}
        </div>
        <div className={css.composer}>
          <textarea
            ref={composerRef}
            className={css.input}
            rows={1}
            value={draft}
            placeholder={t('dock.placeholder')}
            aria-label={t('dock.placeholder')}
            disabled={status === 'unavailable'}
            onChange={event => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              const action = composerKeyAction({
                key: event.key,
                shiftKey: event.shiftKey,
                compositionGuarded: composition.current?.guards(event.nativeEvent) === true,
                canSend,
              })
              if (action.kind === 'send') {
                event.preventDefault()
                onSend()
              }
            }}
          />
          {busy
            ? <Button variant="primary" size="sm" onClick={onStop}>{t('dock.stop')}</Button>
            : (
              <Button
                variant="primary"
                size="sm"
                disabled={!canSend}
                title={sendDisabledTitle}
                onClick={onSend}
              >
                {t('dock.send')}
              </Button>
            )}
        </div>
      </aside>
    </div>
  )
}
