/**
 * ChartFrame：图表卡骨架（分册规范 §五）。标题写成业务问题，绘图区交给
 * 调用方的 SVG/CSS marks（本库不引入图表运行时），图例与脚注为插槽；
 * 四态经 DataState 呈现且 loading 骨架与图形同形。容器根部下发集中
 * `--yt-chart-*` 语义变量。
 * @module
 */
import type { ReactNode } from 'react'
import { DataState, type DataStateKind } from './data-state.tsx'
import { clampChartHeight } from './chart-logic.ts'
import { ytChartStyle } from './tokens.ts'
import css from './chart-frame.module.css'

export interface ChartFrameProps {
  /** Question-style chart title (caller-owned copy). */
  title: ReactNode
  /** Localized accessible name for the plot group; defaults to the title text when it is a string. */
  ariaLabel?: string
  /** Plot height in px; clamped to the 180–320px band from the layout spec. */
  height?: number
  /** Data state of the plotted series. */
  state?: DataStateKind
  /** Retry handler forwarded to the `error` state. */
  onRetry?: () => void
  /** Legend slot (ChartLegend). */
  legend?: ReactNode
  /** SVG/CSS marks. */
  children?: ReactNode
  /** Footnote: data source, timezone, sampling, update time. */
  footnote?: ReactNode
  /** Loading skeleton silhouette for this chart's final shape. */
  skeleton?: 'chart' | 'rows'
}

/**
 * Render the chart card around caller-owned marks.
 * @param props.title - question-style title.
 * @param props.ariaLabel - accessible plot-group name.
 * @param props.height - plot height (default 240).
 * @param props.state - data state (default `ready`).
 * @param props.onRetry - error retry.
 * @param props.legend - legend node.
 * @param props.children - marks.
 * @param props.footnote - footnote row.
 * @param props.skeleton - loading silhouette (default `chart`).
 * @returns the chart card element.
 */
export function ChartFrame({ title, ariaLabel, height, state = 'ready', onRetry, legend, children, footnote, skeleton = 'chart' }: ChartFrameProps): ReactNode {
  const plotHeight = clampChartHeight(height)
  const label = ariaLabel ?? (typeof title === 'string' ? title : undefined)
  // §5.2：绘图组必须有 localized accessible name；非字符串标题必须显式给名。
  if (label === undefined) {
    throw new Error('ChartFrame: a non-string title requires an explicit localized ariaLabel')
  }
  return (
    <section className={css.card} style={ytChartStyle}>
      <div className={css.head}>
        <h2 className={css.title}>{title}</h2>
        {legend}
      </div>
      <div
        role="group"
        aria-label={label}
        className={css.plot}
        style={{ height: `${plotHeight}px` }}
      >
        <DataState state={state} shape={skeleton} onRetry={onRetry}>{children}</DataState>
      </div>
      {footnote !== undefined && <div className={css.footnote}>{footnote}</div>}
    </section>
  )
}
