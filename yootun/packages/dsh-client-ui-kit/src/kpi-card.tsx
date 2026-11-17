/**
 * KpiCard：关键指标卡（分册规范 §五）。数值 20–24px tabular-nums，标签
 * 12–13px，附时间范围或分母说明；变化量只做方向语义（正/负/平），文案与
 * 数值由调用方给 locale 格式化结果。四态经 DataState 呈现（loading 为数值
 * 骨架、empty/error 为卡内提示），disabled 整卡降权。
 * @module
 */
import type { ReactNode } from 'react'
import { DataState, type DataStateKind } from './data-state.tsx'
import { useKitLocale } from './kit-locale.ts'
import css from './kpi-card.module.css'

/** Delta direction; color never carries the meaning alone. */
export type KpiDeltaDirection = 'up' | 'down' | 'flat'

export interface KpiCardProps {
  /** Metric label (caller-owned copy). */
  label: ReactNode
  /** Formatted value (caller formats via locale formatters). */
  value: ReactNode
  /** Change annotation. */
  delta?: {
    direction: KpiDeltaDirection
    /** Formatted change text, e.g. "+12%" (caller-owned). */
    text: ReactNode
  }
  /** Time range or denominator note. */
  footnote?: ReactNode
  /** Data state; `ready` renders the value directly. */
  state?: DataStateKind
  /** Retry handler forwarded to the `error` state. */
  onRetry?: () => void
  /** Renders dimmed and non-interactive when the metric is unavailable. */
  disabled?: boolean
}

/**
 * Render one KPI tile.
 * @param props.label - metric label.
 * @param props.value - formatted value.
 * @param props.delta - change annotation.
 * @param props.footnote - range or denominator note.
 * @param props.state - data state (default `ready`).
 * @param props.onRetry - error retry.
 * @param props.disabled - dim the tile when the metric is unavailable.
 * @returns the KPI element.
 */
export function KpiCard({ label, value, delta, footnote, state = 'ready', onRetry, disabled = false }: KpiCardProps): ReactNode {
  const t = useKitLocale()
  const deltaLabel = delta === undefined ? undefined : t(`kpi.delta.${delta.direction}`)
  return (
    <section className={css.card} aria-disabled={disabled || undefined} data-disabled={disabled || undefined}>
      <span className={css.label}>{label}</span>
      <DataState state={state} shape="value" onRetry={onRetry}>
        <span className={css.value}>{value}</span>
      </DataState>
      {delta !== undefined && state === 'ready' && (
        <span className={`${css.delta} ${css[delta.direction]}`}>
          <span className={css.deltaArrow} aria-hidden="true">
            {delta.direction === 'up' ? '↑' : delta.direction === 'down' ? '↓' : '→'}
          </span>
          {delta.text}
          <span className={css.srOnly}>{deltaLabel}</span>
        </span>
      )}
      {footnote !== undefined && <span className={css.footnote}>{footnote}</span>}
    </section>
  )
}
