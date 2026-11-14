/** 激活表单：key 维护 + 模型加载选择（分册 03 决策点 8 范围），门禁与设置区块共用。移除流程独立在设置区块（分册 05 §3.4 三行结构）。 */
import { useRef, useState } from 'react'
import { Button, Input, Menu, Switch, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { GatewayModel } from '../route.ts'
import { validateAndLoadModels, saveActivation, type AccessForms, type CredentialsFace } from './logic.ts'
import css from './access.module.css'
import type { AccessLocaleKey } from './locales.ts'

/** 词典访问面（locale.bind 返回形态的最小声明）。 */
export type Translate = (key: AccessLocaleKey, values?: Record<string, string>) => string

/** 表单两处宿主共有的行为面。 */
export interface AccessFormProps {
  forms: AccessForms
  credentials: CredentialsFace
  t: Translate
  /** 门禁态：首屏聚焦并显示帮助；设置区块态不显示。 */
  onboarding: boolean
  /** 激活成功回调（门禁用它刷新授权判定，设置区块用它收起表单）。 */
  onConfigured?: () => void
}

/**
 * 激活表单。失败信息 in-place 呈现（role="alert"）；提交中禁用全部控件；
 * Enter 触发模型加载，主按钮触发验证与顺序写入。
 * @param props - 行为面与注入。
 * @returns the form.
 */
export function AccessForm(props: AccessFormProps) {
  const { forms, credentials, t, onboarding } = props
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [models, setModels] = useState<readonly GatewayModel[]>([])
  const [modelId, setModelId] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [loading, setLoading] = useState(false)
  const loadingRef = useRef(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const interactionBusy = busy || loading

  const loadModels = async (): Promise<void> => {
    const entered = key.trim()
    if (entered.length === 0 || loadingRef.current || busyRef.current) return
    loadingRef.current = true
    setLoading(true)
    setError('')
    try {
      const { models: found, reason } = await validateAndLoadModels(entered)
      if (found.length === 0) {
        setModels([])
        setModelId('')
        setError(reason === 'tenant_mismatch' ? t('tenantMismatch') : reason === 'tenant_unavailable' ? t('tenantUnavailable') : t('modelError'))
        return
      }
      setModels(found)
      setModelId(found[0]?.id ?? '')
    } catch {
      setModels([])
      setModelId('')
      setError(t('modelError'))
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }

  const save = async (): Promise<void> => {
    const entered = key.trim()
    if (busyRef.current || loadingRef.current || entered.length === 0 || modelId.length === 0 || models.length === 0) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      const verdict = await validateAndLoadModels(entered)
      if (verdict.models.length === 0) {
        setError(verdict.reason === 'tenant_mismatch' ? t('tenantMismatch') : verdict.reason === 'tenant_unavailable' ? t('tenantUnavailable') : t('invalid'))
        return
      }
      const selected = verdict.models.find(model => model.id === modelId) ?? verdict.models[0]
      if (selected === undefined) {
        setError(t('invalid'))
        return
      }
      if (!await saveActivation(forms, credentials, entered, selected.id)) {
        setError(t('saveError'))
        return
      }
      setKey('')
      setModels([])
      setModelId('')
      props.onConfigured?.()
    } catch {
      setError(t('saveError'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const selectedItem = models.find(model => model.id === modelId)
  const menuItems = models.map(model => ({ id: model.id, label: model.name === model.id ? model.id : `${model.name} (${model.id})` }))
  const selectorTrigger = useRef<HTMLButtonElement>(null)

  return (
    <div className={css.form} aria-busy={interactionBusy}>
      <div className={css.field}>
        <div className={css.labelRow}>
          <label htmlFor="yu-access-key">{t('key')}</label>
          <span className={css.visibility}>
            <Switch checked={showKey} onChange={setShowKey} label={t(showKey ? 'hideKey' : 'showKey')} disabled={interactionBusy} />
            {t(showKey ? 'hideKey' : 'showKey')}
          </span>
        </div>
        <Input
          id="yu-access-key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          autoFocus={onboarding}
          value={key}
          disabled={interactionBusy}
          placeholder={t('keyPlaceholder')}
          onChange={(event) => {
            setKey(event.currentTarget.value)
            setModels([])
            setModelId('')
            setError('')
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') void loadModels() }}
        />
        <div className={css.actions}>
          <Button size="sm" disabled={interactionBusy || key.trim().length === 0} onClick={() => { void loadModels() }}>
            {loading ? t('loading') : t('load')}
          </Button>
          {models.length > 0 ? <p className={css.status} role="status">{t('modelsLoaded', { count: String(models.length) })}</p> : null}
        </div>
      </div>
      <div className={css.field}>
        <label id="yu-access-model-label" htmlFor="yu-access-model">{t('model')}</label>
        <Menu
          open={menuOpen && !interactionBusy && models.length > 0}
          onClose={() => { setMenuOpen(false) }}
          items={menuItems}
          selectedId={modelId}
          onSelect={(id) => {
            selectorTrigger.current?.focus({ preventScroll: true })
            setMenuOpen(false)
            setModelId(id)
          }}
          portal
          autoFocus
          minWidthFromAnchor
          anchor={(
            <button
              ref={selectorTrigger}
              id="yu-access-model"
              type="button"
              className={css.selector}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-labelledby={`yu-access-model-label yu-access-model-value`}
              disabled={interactionBusy || models.length === 0}
              onClick={() => { setMenuOpen(value => !value) }}
            >
              <span id="yu-access-model-value" className={css.selectorLabel}>
                {selectedItem === undefined ? t('modelPlaceholder') : selectedItem.name === selectedItem.id ? selectedItem.id : `${selectedItem.name} (${selectedItem.id})`}
              </span>
              <IconChevronDownOutlineRegular className={css.chevron} />
            </button>
          )}
        />
      </div>
      {onboarding ? <p className={css.help}>{t('help')}</p> : null}
      {error.length > 0 ? <p className={css.notice} role="alert">{error}</p> : null}
      <div className={css.actions}>
        <Button
          size="md"
          variant="primary"
          disabled={interactionBusy || key.trim().length === 0 || modelId.length === 0 || models.length === 0}
          onClick={() => { void save() }}
        >
          {busy ? t('saving') : t('submit')}
        </Button>
      </div>
    </div>
  )
}
