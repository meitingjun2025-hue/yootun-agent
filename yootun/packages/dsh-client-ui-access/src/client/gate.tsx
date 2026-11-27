/** 全屏激活门禁（分册 05 §3.3）：三态渲染（未知只遮罩、未授权卡片、已授权无层）、滚动锁、Tab 钳回、fail-closed；未知持续超 5 秒回落卡片；授权兜底清除历史 inert 残留。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessForm } from './form.tsx'
import { describeKeyConfigured, gatePhase, GATE_UNKNOWN_FALLBACK_MS, isAuthorized, timeoutScheduler, type AccessForms, type CredentialsFace, type AccessSettings } from './logic.ts'
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
 * 门禁。授权由 access section 快照与凭证状态合成，任一来源未就绪即为「未知」：
 * 只渲染 aria-hidden 遮罩层（无卡片、无动画、不抢焦点），持续超过
 * {@link GATE_UNKNOWN_FALLBACK_MS} 回落为卡片，授权回包让已回落的卡片立即消失；
 * Escape 不关闭——门禁是有意阻断，不可逃逸（分册 05 §5）。
 * @param props - 注入面。
 * @returns the gate（未知态只有遮罩层）, or null once authorized.
 */
export function AccessGate(props: GateProps): ReactNode {
  const { forms, credentials, t } = props
  const [configured, setConfigured] = useState<boolean | undefined>(undefined)
  const [fallbackElapsed, setFallbackElapsed] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  // section 未就绪（status !== 'ready'）时快照无值，判定按未知处理。
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

  // 未知持续超过 GATE_UNKNOWN_FALLBACK_MS 回落为卡片；回包离开未知态时清除
  // 计时并复位回落态（卸载由本 effect 的清理函数覆盖）。
  const unknown = authorized === undefined
  useEffect(() => {
    if (!unknown) {
      setFallbackElapsed(false)
      return undefined
    }
    const cancel = timeoutScheduler.schedule(GATE_UNKNOWN_FALLBACK_MS, () => { setFallbackElapsed(true) })
    return () => { cancel() }
  }, [unknown])
  const phase = gatePhase(authorized, fallbackElapsed)

  // 应用阻断跟随授权状态（未授权或未知遮罩）：阻断期间给 #root 设
  // aria-hidden（辅助技术读不到背景应用）并置 body overflow hidden。门禁不
  // 申请 root.inert：官方 onboarding loading 层会在启动瞬间捕获并恢复该属性，
  // 与门禁 fail-closed 锁并发时形成「授权解锁后被旧快照恢复为 true」的竞态；
  // 授权成立仍直接清除 inert，作为升级前版本残留的兜底。解除（authorized
  // 成立）即时移除 aria-hidden；门禁层全部卸载后的最终复位由 mountGate 的
  // disposer 统一处理（不按实例 previous 快照恢复——双门禁叠加时快照互相
  // 指向对方设置的值，恢复会把仍在阻断的门禁解锁）。
  const blocking = authorized !== true
  useEffect(() => {
    const root = document.getElementById('root')
    if (!blocking) {
      if (root !== null) {
        root.inert = false
        root.removeAttribute('aria-hidden')
      }
      document.body.style.overflow = ''
      return undefined
    }
    if (root !== null) root.setAttribute('aria-hidden', 'true')
    document.body.style.overflow = 'hidden'
    return undefined
  }, [blocking])

  useEffect(() => {
    if (phase !== 'card') return undefined
    // 首屏引导是模态卡片：卡片出现时聚焦首个可操作项，Tab 循环不逃出卡片。
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
  }, [phase])

  if (phase === 'open') return null
  if (phase === 'unknown') return <div className={css.gateGate} aria-hidden="true" />
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

/**
 * Mount the mandatory gate in its own React root appended to the document
 * body, locking scrolling while unauthorized; the fixed gate layer owns
 * pointer blocking and the card owns the focus trap. 宿主 root 与滚动锁申请
 * 都由本闭包持有（模块级可变状态归位）：连续挂载时第二次调用移除第一次的
 * 宿主节点，第一次的 disposer 只卸载自己创建的宿主（R3 语义）。
 * @param props - the gate's injected face.
 * @returns the disposer unmounting the gate and releasing the application.
 */
export function mountGate(props: GateProps): () => void {
  document.getElementById('yu-access-gate')?.remove()
  const host = document.createElement('div')
  host.id = 'yu-access-gate'
  document.body.appendChild(host)
  const gateRoot: Root = createRoot(host)
  gateRoot.render(<AccessGate {...props} />)
  return () => {
    // 阻断 effect 无清理函数：aria-hidden 与滚动锁的最终复位由本 disposer 在
    // 门禁层全部卸载后统一做——不无条件清 body overflow，双挂载时无条件复位
    // 会解除仍在阻断的另一个门禁的滚动锁。root.inert 复位保留为升级前残留的兜底。
    gateRoot.unmount()
    const root = document.getElementById('root')
    if (root !== null) root.inert = false
    host.remove()
    // aria-hidden 与滚动锁同一守卫口径：门禁层仍有挂载（双挂载时另一门禁还在
    // 阻断）时不解除，全部门禁卸载后才统一复位。
    if (document.getElementById('yu-access-gate') === null) {
      root?.removeAttribute('aria-hidden')
      document.body.style.overflow = ''
    }
  }
}
