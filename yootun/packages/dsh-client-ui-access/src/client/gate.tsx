/** 全屏激活门禁（分册 05 §3.3）：旧阻断语义全保留（root.inert + 滚动锁、Tab 钳回、fail-closed），视觉走官方 Modal 材质。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessForm } from './form.tsx'
import { blockApplicationRoot, describeKeyConfigured, isAuthorized, type AccessForms, type CredentialsFace, type AccessSettings } from './logic.ts'
import { BRAND_EYEBROW } from './locales.ts'
import { BRAND_MARK_URL } from './brand-mark.ts'
import css from './access.module.css'
import type { Translate } from './form.tsx'

/** 门禁宿主注入面：三个设置表单 + 凭证 seam + 词典。 */
export interface GateProps {
  forms: AccessForms
  credentials: CredentialsFace
  t: Translate
}

/**
 * 门禁卡片。授权由 access section 快照与凭证状态合成，任一来源不可用即维持
 * 阻断；Escape 不关闭——门禁是有意阻断，不可逃逸（分册 05 §5）。
 * @param props - 注入面。
 * @returns the gate, or null once authorized.
 */
export function AccessGate(props: GateProps): ReactNode {
  const { forms, credentials, t } = props
  const [configured, setConfigured] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  // fail-closed：section 未就绪（status !== 'ready'）时快照无值，判定维持未授权。
  const accessSnapshot = useSyncExternalStore(
    forms.access.subscribe.bind(forms.access), forms.access.getSnapshot.bind(forms.access), forms.access.getSnapshot.bind(forms.access),
  )
  const settings: AccessSettings | undefined = accessSnapshot.status === 'ready' ? accessSnapshot.value : undefined

  useEffect(() => {
    let active = true
    void describeKeyConfigured(credentials).then((value) => { if (active) setConfigured(value) })
    return () => { active = false }
  }, [credentials])

  const authorized = isAuthorized(settings, configured)

  // 应用阻断跟随授权状态：授权成立释放；撤销授权（设置页移除 Key 回门禁态）
  // 重新申请。mountGate 已预申请一次（消除首帧闪烁），effect 首跑保持现状。
  useEffect(() => {
    if (authorized) {
      if (releaseApplication !== undefined) {
        releaseApplication()
        releaseApplication = undefined
      }
      return
    }
    if (releaseApplication === undefined) releaseApplication = blockApplicationRoot()
  }, [authorized])

  useEffect(() => {
    if (authorized) return undefined
    // 首屏引导是模态卡片：进入时聚焦首个可操作项，Tab 循环不逃出卡片。
    const focusable = (): HTMLElement[] => Array.from(
      cardRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])') ?? [],
    ).filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
    const focusFrame = requestAnimationFrame(() => {
      const first = focusable()[0]
      ;(cardRef.current?.querySelector<HTMLElement>('#yu-access-key') ?? first ?? cardRef.current)?.focus?.()
    })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined) {
        event.preventDefault()
        cardRef.current?.focus?.()
      } else if ((event.shiftKey && document.activeElement === first)
        || (!event.shiftKey && document.activeElement === last)
        || (cardRef.current !== null && !cardRef.current.contains(document.activeElement))) {
        event.preventDefault()
        ;(event.shiftKey ? last : first)?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [authorized])

  if (authorized) return null
  return (
    <div className={css.gate}>
      <section
        ref={cardRef}
        className={css.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="yu-access-title"
        aria-describedby="yu-access-intro"
        tabIndex={-1}
      >
        <header className={css.header}>
          <img src={BRAND_MARK_URL} width={48} height={48} className={css.mark} alt="" />
          <div>
            {BRAND_EYEBROW.length > 0 ? <p className={css.eyebrow}>{BRAND_EYEBROW}</p> : null}
            <h2 id="yu-access-title" className={css.title}>{t('title')}</h2>
            <p id="yu-access-intro" className={css.intro}>{t('intro')}</p>
          </div>
        </header>
        <AccessForm
          forms={forms}
          credentials={credentials}
          t={t}
          onboarding
          onConfigured={() => { void describeKeyConfigured(credentials).then(setConfigured) }}
        />
      </section>
    </div>
  )
}

let gateRoot: Root | undefined
let releaseApplication: (() => void) | undefined

/**
 * Mount the mandatory gate in its own React root appended to the document
 * body, inerting the application root while unauthorized (旧
 * installMandatoryGate 语义).
 * @param props - the gate's injected face.
 * @returns the disposer unmounting the gate and releasing the application.
 */
export function mountGate(props: GateProps): () => void {
  document.getElementById('yu-access-gate')?.remove()
  const host = document.createElement('div')
  host.id = 'yu-access-gate'
  document.body.appendChild(host)
  releaseApplication = blockApplicationRoot()
  gateRoot = createRoot(host)
  gateRoot.render(<AccessGate {...props} />)
  return () => {
    gateRoot?.unmount()
    gateRoot = undefined
    releaseApplication?.()
    releaseApplication = undefined
    host.remove()
  }
}
