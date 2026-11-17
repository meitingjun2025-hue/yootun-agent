/**
 * OperationReceipts：操作回执列表（分册规范 §六/§一）。逐对象显示做了什么、
 * 目标、结果；只有真正产生数据修改的成功回合提供撤销位，失败回合给稳定
 * 错误说明；已撤销行冻结展示。
 * @module
 */
import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import css from './operation-receipts.module.css'

/** One receipt's outcome kind. */
export type ReceiptKind = 'success' | 'failed' | 'undone' | 'info'

/** One operation receipt row. */
export interface OperationReceipt {
  id: string
  kind: ReceiptKind
  /** What happened, localized (short; ≤ two sentences). */
  text: ReactNode
  /** The affected object's localized name, rendered after the text as a quiet span. */
  target?: ReactNode
  /** Undo affordance; only successful mutations may carry it. */
  undo?: { onUndo: () => void }
}

export interface OperationReceiptsProps {
  /** Receipts in display order (newest last). */
  receipts: readonly OperationReceipt[]
  /** Region heading; defaults to the localized "操作回执". */
  label?: ReactNode
}

/**
 * Render the receipts list.
 * @param props.receipts - receipt rows.
 * @param props.label - optional heading override.
 * @returns the receipts region; null when empty.
 */
export function OperationReceipts({ receipts, label }: OperationReceiptsProps): ReactNode {
  const t = useKitLocale()
  if (receipts.length === 0) return null
  return (
    <section className={css.region} aria-label={typeof label === 'string' ? label : t('receipts.title')}>
      {label ?? <span className={css.title}>{t('receipts.title')}</span>}
      <ul className={css.list}>
        {receipts.map((receipt) => {
          const kindKey = receipt.kind === 'success'
            ? 'receipts.kind.success'
            : receipt.kind === 'failed'
              ? 'receipts.kind.failed'
              : receipt.kind === 'undone'
                ? 'receipts.undone'
                : 'receipts.kind.info'
          const tone = receipt.kind === 'success'
            ? 'success'
            : receipt.kind === 'failed'
              ? 'danger'
              : receipt.kind === 'undone'
                ? 'neutral'
                : 'info'
          return (
            <li key={receipt.id} className={css.row} data-kind={receipt.kind}>
              <Tag tone={tone}>{t(kindKey)}</Tag>
              <span className={css.text}>{receipt.text}</span>
              {receipt.target !== undefined && <span className={css.target}>{receipt.target}</span>}
              {receipt.kind === 'success' && receipt.undo !== undefined && (
                <Button variant="ghost" size="sm" onClick={receipt.undo.onUndo}>{t('receipts.undo')}</Button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
