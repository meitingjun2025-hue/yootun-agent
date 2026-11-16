/**
 * DataCard：数据卡片（分册规范 §三/§四）。R20 官方卡片材质；标题行含说明与
 * 右侧操作；四态经 DataState 呈现，error 保留卡片骨架不整页替换。
 * @module
 */
import type { ReactNode } from 'react'
import { DataState, type DataStateKind } from './data-state.tsx'
import css from './data-card.module.css'

export interface DataCardProps {
  /** Card title (question-style or object name; caller-owned copy). */
  title: ReactNode
  /** Description or time range under the title. */
  description?: ReactNode
  /** Title-row actions (right aligned). */
  actions?: ReactNode
  /** Data state; `ready` renders children directly. */
  state?: DataStateKind
  /** Retry handler forwarded to the `error` state. */
  onRetry?: () => void
  /** Card body. */
  children?: ReactNode
  /** Footnote row (data source, timezone, update time). */
  footnote?: ReactNode
}

/**
 * Render one data card.
 * @param props.title - card title.
 * @param props.description - secondary line.
 * @param props.actions - title-row actions.
 * @param props.state - data state (default `ready`).
 * @param props.onRetry - error retry.
 * @param props.children - card body.
 * @param props.footnote - footnote row.
 * @returns the card element.
 */
export function DataCard({ title, description, actions, state = 'ready', onRetry, children, footnote }: DataCardProps): ReactNode {
  return (
    <section className={css.card} data-state={state}>
      <div className={css.head}>
        <div className={css.titleGroup}>
          <h2 className={css.title}>{title}</h2>
          {description !== undefined && <span className={css.description}>{description}</span>}
        </div>
        {actions !== undefined && <div className={css.actions}>{actions}</div>}
      </div>
      <div className={css.body}>
        <DataState state={state} shape="block" onRetry={onRetry}>{children}</DataState>
      </div>
      {footnote !== undefined && <div className={css.footnote}>{footnote}</div>}
    </section>
  )
}
