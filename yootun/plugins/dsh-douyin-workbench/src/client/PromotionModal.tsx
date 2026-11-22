/**
 * 投流数据弹层（Modal 表单，6 字段）：所属账号只读 / 视频只读 / 投流播放量
 * （整数 ≥0）/ 消耗金额（两位小数 ≤999999999999.99）/ 粉丝量（整数 ≥0）/
 * 实际投放时长（>0 两位小数）；校验分键文案、预填服务端字符串值；recordId
 * 变化由父层以挂载 key 强制重挂载（stale 恢复换入最新记录时预填才会取新值）；
 * PROMOTION_ALREADY_EXISTS 自动重拉转更新（stale 中性提示 role=status）；
 * 保存 primary / 取消 ghost。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './format.ts'
import css from './workbench.module.css'

/** 非负金额/时长文本格式（整数或 1–2 位小数，与 Host decimal 契约同口径）。 */
const DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/
/** 量级上限（与 DB NUMERIC(14,2)/(8,2) 与 tools DTO 同口径）。 */
const COST_MAX = 999_999_999_999.99
const HOURS_MAX = 999_999.99

/** 校验错误键（分键文案）。 */
export type PromotionInvalidKey =
  | 'promotion.playRequired' | 'promotion.playInvalid'
  | 'promotion.costRequired' | 'promotion.costInvalid'
  | 'promotion.fansRequired' | 'promotion.fansInvalid'
  | 'promotion.hoursRequired' | 'promotion.hoursInvalid'

/**
 * 逐项校验：必填缺失与非法分键；返回文案键或 null。
 * @param values - 四个可编辑字段的表单值。
 * @returns 校验错误键或 null。
 */
export function validatePromotionForm(values: { playCount: string; costAmount: string; fansCount: string; durationHours: string }): PromotionInvalidKey | null {
  const play = values.playCount.trim()
  if (play === '') return 'promotion.playRequired'
  const playNum = Number(play)
  if (!Number.isInteger(playNum) || playNum < 0) return 'promotion.playInvalid'
  const cost = values.costAmount.trim()
  if (cost === '') return 'promotion.costRequired'
  if (!DECIMAL_PATTERN.test(cost) || Number(cost) > COST_MAX) return 'promotion.costInvalid'
  const fans = values.fansCount.trim()
  if (fans === '') return 'promotion.fansRequired'
  const fansNum = Number(fans)
  if (!Number.isInteger(fansNum) || fansNum < 0) return 'promotion.fansInvalid'
  const hours = values.durationHours.trim()
  if (hours === '') return 'promotion.hoursRequired'
  if (!DECIMAL_PATTERN.test(hours) || Number(hours) <= 0 || Number(hours) > HOURS_MAX) return 'promotion.hoursInvalid'
  return null
}

export interface PromotionModalProps {
  t: Translate
  /** 打开数据（recordId 非空 = 更新；staleRecovered = stale-add 自动恢复）。 */
  modal: {
    accountId: string
    accountName: string
    workId: string
    workTitle: string
    recordId: string | null
    playCount: string
    costAmount: string
    fansCount: string
    durationHours: string
    staleRecovered: boolean
  }
  saving: boolean
  /** 保存（页面执行 work.promotion.save；返回失败原因或 null）。 */
  onConfirm: (input: {
    accountId: string
    workId: string
    recordId: number | null
    playCount: number
    costAmount: string
    fansCount: number
    durationHours: string
  }) => Promise<string | null>
  onClose: () => void
}

/** 投流数据弹层组件。 */
export function PromotionModal(props: PromotionModalProps): ReactNode {
  const t = props.t
  const [playCount, setPlayCount] = useState(props.modal.playCount)
  const [costAmount, setCostAmount] = useState(props.modal.costAmount)
  const [fansCount, setFansCount] = useState(props.modal.fansCount)
  const [durationHours, setDurationHours] = useState(props.modal.durationHours)
  const [invalid, setInvalid] = useState<PromotionInvalidKey | null>(null)
  const [errorReason, setErrorReason] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (props.saving) return
    const invalidKey = validatePromotionForm({ playCount, costAmount, fansCount, durationHours })
    if (invalidKey !== null) {
      setInvalid(invalidKey)
      return
    }
    const reason = await props.onConfirm({
      accountId: props.modal.accountId,
      workId: props.modal.workId,
      recordId: props.modal.recordId !== null && props.modal.recordId !== '' ? Number(props.modal.recordId) : null,
      playCount: Number(playCount.trim()),
      costAmount: costAmount.trim(),
      fansCount: Number(fansCount.trim()),
      durationHours: durationHours.trim(),
    })
    if (reason !== null) setErrorReason(reason)
  }

  const numericField = (labelKey: Parameters<Translate>[0], value: string, setter: (next: string) => void, attrs: { min: number; step: number; autofocus?: boolean }): ReactNode => (
    <label className={css.formField}>
      <span className={css.formLabel}>{t(labelKey)}</span>
      <Input
        type='number'
        value={value}
        min={attrs.min}
        step={attrs.step}
        disabled={props.saving}
        {...(attrs.autofocus === true ? { 'data-modal-autofocus': '' } : {})}
        onChange={event => {
          setter(event.target.value)
          setInvalid(null)
          setErrorReason(null)
        }}
      />
    </label>
  )

  return (
    <Modal
      open
      onClose={() => { if (!props.saving) props.onClose() }}
      title={t('promotion.modalTitle')}
      closeLabel={t('dialog.close')}
      footer={(
        <>
          <Button variant='ghost' size='sm' disabled={props.saving} onClick={props.onClose}>{t('owner.cancel')}</Button>
          <Button variant='primary' size='sm' disabled={props.saving} aria-busy={props.saving || undefined} onClick={() => { void submit() }}>
            {props.saving ? t('owner.saving') : t('owner.save')}
          </Button>
        </>
      )}
    >
      <form
        className={css.formBody}
        onSubmit={event => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className={css.formField}>
          <span className={css.formLabel}>{t('promotion.account')}</span>
          <Input value={props.modal.accountName} readOnly aria-readonly='true' />
        </label>
        <label className={css.formField}>
          <span className={css.formLabel}>{t('promotion.work')}</span>
          <Input value={props.modal.workTitle} readOnly aria-readonly='true' />
        </label>
        {numericField('promotion.field.play', playCount, setPlayCount, { min: 0, step: 1, autofocus: true })}
        {numericField('promotion.field.cost', costAmount, setCostAmount, { min: 0, step: 0.01 })}
        {numericField('promotion.field.fans', fansCount, setFansCount, { min: 0, step: 1 })}
        {numericField('promotion.field.hours', durationHours, setDurationHours, { min: 0.01, step: 0.01 })}
        {props.modal.staleRecovered && <p className={css.formNotice} role='status'>{t('promotion.staleNotice')}</p>}
        {invalid !== null && <p className={css.formError} role='alert'>{t(invalid)}</p>}
        {invalid === null && errorReason !== null && <p className={css.formError} role='alert'>{promotionErrorText(errorReason, t)}</p>}
      </form>
    </Modal>
  )
}

/** 投流错误码 → 词典键。 */
const PROMOTION_ERROR_KEYS: Readonly<Record<string, 'promotion.error.notFound' | 'promotion.error.accountNotFound' | 'promotion.error.workNotFound' | 'promotion.error.saveFailed' | 'promotion.error.alreadyExists'>> = {
  PROMOTION_ALREADY_EXISTS: 'promotion.error.alreadyExists',
  PROMOTION_NOT_FOUND: 'promotion.error.notFound',
  ACCOUNT_NOT_FOUND: 'promotion.error.accountNotFound',
  WORK_NOT_FOUND: 'promotion.error.workNotFound',
  PROMOTION_FIELD_REQUIRED: 'promotion.error.saveFailed',
  PROMOTION_VALUE_INVALID: 'promotion.error.saveFailed',
  INVALID_IDEMPOTENCY_KEY: 'promotion.error.saveFailed',
  IDEMPOTENCY_CONFLICT: 'promotion.error.saveFailed',
  VALIDATION_ERROR: 'promotion.error.saveFailed',
}

/** 投流错误码 → 文案。 */
function promotionErrorText(reason: string, t: Translate): string {
  const key = PROMOTION_ERROR_KEYS[reason]
  return key !== undefined ? t(key) : t('promotion.error.saveFailed')
}
