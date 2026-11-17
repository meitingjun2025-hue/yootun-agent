/**
 * ChartLegend：可交互图例（分册规范 §五）。图例不是一排色块：可高亮/隔离
 * 系列，键盘可达（原生 button + aria-pressed），隐藏系列时保持占位顺序。
 * @module
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import type { YtChartColor } from './tokens.ts'
import css from './chart-legend.module.css'

/** One legend entry bound to a series. */
export interface ChartLegendItem {
  /** Stable series id. */
  id: string
  /** Localized series label. */
  label: string
  /** Semantic palette key from the centralized chart tokens. */
  color: YtChartColor
  /** Optional aggregate value rendered after the label (caller-formatted). */
  value?: string
}

export interface ChartLegendProps {
  /** Legend entries. */
  items: readonly ChartLegendItem[]
  /** Ids currently hidden from the plot. */
  hiddenIds?: ReadonlySet<string>
  /** Toggles one series' visibility; omit to render read-only swatches. */
  onToggle?: (id: string) => void
}

/**
 * Render the chart legend.
 * @param props.items - series entries.
 * @param props.hiddenIds - currently hidden series.
 * @param props.onToggle - visibility toggle; absence renders read-only.
 * @returns the legend element.
 */
export function ChartLegend({ items, hiddenIds, onToggle }: ChartLegendProps): ReactNode {
  const t = useKitLocale()
  return (
    <div className={css.legend} role={onToggle === undefined ? undefined : 'group'} aria-label={t('chart.legendLabel')}>
      {items.map((item) => {
        const hidden = hiddenIds?.has(item.id) === true
        const body = (
          <>
            <span aria-hidden="true" className={css.swatch} style={{ background: `var(${item.color})` }} />
            <span className={hidden ? css.labelHidden : css.label}>{item.label}</span>
            {item.value !== undefined && <span className={css.value}>{item.value}</span>}
          </>
        )
        if (onToggle === undefined) {
          return (
            <span key={item.id} className={css.item}>
              {body}
            </span>
          )
        }
        return (
          <Button
            key={item.id}
            variant="ghost"
            size="sm"
            className={css.toggle}
            aria-pressed={!hidden}
            aria-label={hidden ? t('legend.toggleOff', { series: item.label }) : t('legend.toggleOn', { series: item.label })}
            onClick={() => onToggle(item.id)}
          >
            {body}
          </Button>
        )
      })}
    </div>
  )
}
