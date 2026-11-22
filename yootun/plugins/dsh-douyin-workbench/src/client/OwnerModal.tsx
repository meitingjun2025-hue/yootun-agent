/**
 * 负责人弹层（Modal 表单）：账号名称只读 + 负责人输入（≤128，trim 后空拒绝）
 * + 保存 primary / 取消 ghost；错误 role=alert；保存中不关闭（onClose 由页面
 * 在保存中短路）。保存成功由页面投影更新账号列表与总览筛选选项（去重中文
 * 排序「全部」恒首；失联清空）。焦点回归由官方 Modal 承担。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { domainErrorText, type Translate } from './format.ts'
import css from './workbench.module.css'

/** 负责人错误码 → 词典键（未登记码走通用保存失败）。 */
const OWNER_ERROR_KEYS: Readonly<Record<string, 'owner.error.required' | 'owner.error.invalid' | 'owner.error.accountNotFound' | 'owner.error.saveFailed'>> = {
  OWNER_NAME_REQUIRED: 'owner.error.required',
  OWNER_NAME_INVALID: 'owner.error.invalid',
  ACCOUNT_NOT_FOUND: 'owner.error.accountNotFound',
  INVALID_IDEMPOTENCY_KEY: 'owner.error.saveFailed',
  IDEMPOTENCY_CONFLICT: 'owner.error.saveFailed',
  VALIDATION_ERROR: 'owner.error.invalid',
}

export interface OwnerModalProps {
  t: Translate
  /** 打开数据（账号 + 当前负责人预填）。 */
  modal: { accountId: string; accountName: string; ownerName: string }
  saving: boolean
  /** 保存（页面执行 account.owner.set；返回失败原因或 null）。 */
  onConfirm: (input: { accountId: string; ownerName: string }) => Promise<string | null>
  onClose: () => void
}

/** 负责人弹层组件。 */
export function OwnerModal(props: OwnerModalProps): ReactNode {
  const t = props.t
  const [ownerName, setOwnerName] = useState(props.modal.ownerName)
  const [errorReason, setErrorReason] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (props.saving) return
    const trimmed = ownerName.trim()
    if (trimmed === '') {
      setErrorReason('OWNER_NAME_REQUIRED')
      return
    }
    if (trimmed.length > 128) {
      setErrorReason('OWNER_NAME_INVALID')
      return
    }
    const reason = await props.onConfirm({ accountId: props.modal.accountId, ownerName: trimmed })
    if (reason !== null) setErrorReason(reason)
  }

  return (
    <Modal
      open
      onClose={() => { if (!props.saving) props.onClose() }}
      title={t('owner.modalTitle')}
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
          <span className={css.formLabel}>{t('owner.account')}</span>
          <Input value={props.modal.accountName} readOnly aria-readonly='true' />
        </label>
        <label className={css.formField}>
          <span className={css.formLabel}>{t('owner.field')}</span>
          <Input
            value={ownerName}
            maxLength={128}
            disabled={props.saving}
            data-modal-autofocus=''
            onChange={event => {
              setOwnerName(event.target.value)
              setErrorReason(null)
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
          />
        </label>
        {errorReason !== null && (
          <p className={css.formError} role='alert'>{ownerErrorText(errorReason, t)}</p>
        )}
      </form>
    </Modal>
  )
}

/** 负责人错误码 → 文案。 */
function ownerErrorText(reason: string, t: Translate): string {
  const key = OWNER_ERROR_KEYS[reason]
  return key !== undefined ? t(key) : domainErrorText('schedule', reason, t)
}
