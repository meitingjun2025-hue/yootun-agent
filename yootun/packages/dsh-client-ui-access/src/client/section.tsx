/** 设置页激活管理区块（分册 05 §3.4）：激活状态、更换 Key、移除 Key 三行。 */
import { useSyncExternalStore, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { AccessForm, type Translate } from './form.tsx'
import { describeKeyConfigured, isAuthorized, removeAccess, type AccessForms, type CredentialsFace, type AccessSettings } from './logic.ts'
import css from './access.module.css'

/** settings.section slot 注入的组件面。 */
export interface AccessSectionProps {
  forms: AccessForms
  credentials: CredentialsFace
  t: Translate
}

/**
 * 激活管理区块。收起态三行（分册 05 §3.4）；「更换 Key」展开门禁同款表单
 * （组件复用），「移除 Key」展开 in-place 确认区（warning + 确认/取消）。
 * @param props - 注入面。
 * @returns the section.
 */
export function AccessSection(props: AccessSectionProps): ReactNode {
  const { forms, credentials, t } = props
  const [editing, setEditing] = useState(false)
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const accessSnapshot = useSyncExternalStore(
    forms.access.subscribe.bind(forms.access), forms.access.getSnapshot.bind(forms.access), forms.access.getSnapshot.bind(forms.access),
  )
  const settings: AccessSettings | undefined = accessSnapshot.status === 'ready' ? accessSnapshot.value : undefined
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  useEffect(() => {
    let active = true
    // describeKeyConfigured 内置 fail-closed（seam 失败或 rejection → 未配置）。
    void describeKeyConfigured(props.credentials).then((value) => { if (active) setCredentialConfigured(value) })
    return () => { active = false }
  }, [props.credentials])
  const activated = isAuthorized(settings, credentialConfigured)

  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (!await removeAccess(forms, credentials)) {
        setError(t('removeError'))
        return
      }
      setCredentialConfigured(false)
      setConfirmingRemove(false)
      setEditing(false)
    } catch {
      setError(t('removeError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={css.section}>
      <h2 className={css.sectionTitle}>{t('nav')}</h2>
      <div className={css.row}>
        <span className={css.rowLabel}>{t('statusTitle')}</span>
        <span className={css.rowValue}>
          {activated && settings !== undefined ? t('statusActive', { model: settings.modelId }) : t('statusInactive')}
        </span>
      </div>
      {editing
        ? (
            <AccessForm
              forms={forms}
              credentials={credentials}
              t={t}
              onboarding={false}
              onConfigured={() => { setEditing(false) }}
            />
          )
        : (
            <>
              <div className={css.row}>
                <span className={css.rowLabel}>{t('changeKey')}</span>
                <Button size="sm" disabled={busy} onClick={() => { setEditing(true) }}>{t('changeKey')}</Button>
              </div>
              {confirmingRemove
                ? (
                    <div className={css.row}>
                      <span className={css.rowLabel} role="alert">{t('removeWarning')}</span>
                      <span className={css.actions}>
                        <Button size="sm" className={css.danger} disabled={busy} onClick={() => { void remove() }}>
                          {t('confirmRemove')}
                        </Button>
                        <Button size="sm" disabled={busy} onClick={() => { setConfirmingRemove(false) }}>
                          {t('cancel')}
                        </Button>
                      </span>
                    </div>
                  )
                : (
                    <div className={css.row}>
                      <span className={css.rowLabel}>{t('removeKey')}</span>
                      <Button size="sm" disabled={busy} onClick={() => { setConfirmingRemove(true) }}>{t('remove')}</Button>
                    </div>
                  )}
            </>
          )}
      {error.length > 0 ? <p className={css.notice} role="alert">{error}</p> : null}
    </section>
  )
}
