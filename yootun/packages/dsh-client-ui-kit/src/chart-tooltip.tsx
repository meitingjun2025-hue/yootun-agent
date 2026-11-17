/**
 * ChartTooltip：图表悬停/聚焦提示（分册规范 §五）。位置与翻转由纯逻辑
 * `placeTooltip` 决定，靠边自动翻转，不遮挡当前 mark；调用方在 mark 的
 * pointer/focus 事件里传入锚点坐标。
 * @module
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { placeTooltip } from './chart-logic.ts'
import type { YtChartColor } from './tokens.ts'
import css from './chart-tooltip.module.css'

/** One tooltip row: label + value, optional semantic series color. */
export interface ChartTooltipRow {
  label: string
  value: string
  /** Semantic palette key from the centralized chart tokens. */
  color?: YtChartColor
}

export interface ChartTooltipProps {
  /** Whether the tooltip is visible. */
  visible: boolean
  /** Anchor point in the plot container's coordinates. */
  point: { x: number; y: number }
  /** Tooltip title (e.g. the bucket label). */
  title: string
  /** Data rows. */
  rows: readonly ChartTooltipRow[]
  /** The plot container element the tooltip is positioned within. */
  container: HTMLElement | null
}

/**
 * Render the chart tooltip inside the plot container.
 * @param props.visible - visibility.
 * @param props.point - anchor coordinates.
 * @param props.title - tooltip title.
 * @param props.rows - data rows.
 * @param props.container - positioning container.
 * @returns the tooltip node, or null when hidden or unmeasured.
 */
export function ChartTooltip({ visible, point, title, rows, container }: ChartTooltipProps): ReactNode {
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<{ left: number; top: number; side: 'left' | 'right' } | undefined>(undefined)

  useLayoutEffect(() => {
    if (!visible || container === null) {
      setPlacement(undefined)
      return
    }
    const bubble = bubbleRef.current
    if (bubble === null) return
    const measured = bubble.getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    setPlacement(placeTooltip({
      point,
      bubble: { width: measured.width, height: measured.height },
      container: { width: containerRect.width, height: containerRect.height },
    }))
    // Rows 带内容签名：同行数不同文案宽度变化时也重测。
  }, [visible, point.x, point.y, rows.map(row => `${row.label}\u0000${row.value}`).join('\u0001'), title, container])

  if (!visible || container === null) return null
  return (
    <div
      ref={bubbleRef}
      role="status"
      className={css.bubble}
      data-side={placement?.side ?? 'right'}
      style={placement === undefined ? { visibility: 'hidden', left: 0, top: 0 } : { left: placement.left, top: placement.top }}
    >
      <span className={css.title}>{title}</span>
      {rows.map(row => (
        <span key={row.label} className={css.row}>
          {row.color !== undefined && <span aria-hidden="true" className={css.swatch} style={{ background: `var(${row.color})` }} />}
          <span className={css.rowLabel}>{row.label}</span>
          <span className={css.rowValue}>{row.value}</span>
        </span>
      ))}
    </div>
  )
}
