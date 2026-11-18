/**
 * 页内图表 marks（ChartFrame 的 children）：折线趋势与水平分布条。绘图只消费
 * 集中 `--yt-chart-*` 语义变量（ChartFrame 根部下发）；tooltip 经 kit
 * ChartTooltip 靠边翻转；数据点/分布行可聚焦，tooltip 在 focus 时同样出现
 * （§5.2/§5.3：键盘路径等价于 hover）。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { ChartTooltip, type ChartTooltipRow } from '@yootun/dsh-client-ui-kit'
import css from './workbench.module.css'

/** 折线一个数据点。 */
export interface TrendPoint {
  /** X 轴标签（日窗 YYYY-MM-DD）。 */
  label: string
  /** 主数值；null 画为断点，不按 0 计。 */
  value: number | null
  /** Tooltip 明细行（含单位与次指标）。 */
  rows: readonly ChartTooltipRow[]
}

/** 分布条一行。 */
export interface DistributionSlice {
  key: string
  label: string
  count: number
}

interface TooltipState {
  point: { x: number; y: number }
  title: string
  rows: readonly ChartTooltipRow[]
}

/** 容器内坐标的 tooltip 状态与显隐回调（hover 与 focus 共用）。 */
function usePlotTooltip(): {
  container: HTMLDivElement | null
  mountContainer: (element: HTMLDivElement | null) => void
  tooltip: TooltipState | undefined
  show(anchor: Element, title: string, rows: readonly ChartTooltipRow[]): void
  hide(): void
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [tooltip, setTooltip] = useState<TooltipState | undefined>(undefined)
  const show = (anchor: Element, title: string, rows: readonly ChartTooltipRow[]): void => {
    if (container === null) return
    const outer = container.getBoundingClientRect()
    const inner = anchor.getBoundingClientRect()
    setTooltip({
      point: { x: inner.left - outer.left + inner.width / 2, y: inner.top - outer.top },
      title,
      rows,
    })
  }
  const hide = (): void => setTooltip(undefined)
  return { container, mountContainer: setContainer, tooltip, show, hide }
}

/** 数值格式化：整数计数直排（tabular-nums 由 CSS 负责）。 */
function formatCount(value: number): string {
  return String(Math.round(value))
}

/** 折线 tooltip 行（主数值 + 可选次行）。 */
function pointRows(point: TrendPoint, seriesLabel: string): ChartTooltipRow[] {
  const primary: ChartTooltipRow = {
    label: seriesLabel,
    value: point.value === null ? '—' : formatCount(point.value),
  }
  return [primary, ...point.rows]
}

/**
 * 单系列折线趋势：0/25/50/75/最大值五档横网格，null 值断线不补 0；每个
 * 数据点是一个可聚焦的按钮层，focus/hover 都出 tooltip。
 * @param props.points - 顺序数据点。
 * @param props.seriesLabel - 图例/tooltip 里的系列名。
 * @param props.color - 集中类别变量名（如 `--yt-chart-1`）。
 * @returns 绘图层元素（配合绝对定位容器）。
 */
export function TrendLineChart(props: { points: readonly TrendPoint[]; seriesLabel: string; color: string }): ReactNode {
  const { container, mountContainer, tooltip, show, hide } = usePlotTooltip()
  const points = props.points
  const values = points.map(point => point.value).filter((value): value is number => value !== null)
  const max = values.length > 0 ? Math.max(...values) : 0
  const scaleMax = max > 0 ? max : 1
  const xOf = (index: number): number => points.length <= 1 ? 50 : (index / (points.length - 1)) * 100
  const yOf = (value: number): number => 100 - (value / scaleMax) * 100
  const segments: string[] = []
  let current: string[] = []
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '))
      current = []
      return
    }
    current.push(`${xOf(index).toFixed(2)},${yOf(point.value).toFixed(2)}`)
  })
  if (current.length > 1) segments.push(current.join(' '))
  const gridValues = [0, scaleMax * 0.25, scaleMax * 0.5, scaleMax * 0.75, scaleMax]
  return (
    <div ref={mountContainer} className={css.plotLayer}>
      <svg className={css.plotSvg} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {gridValues.map(value => (
          <line
            key={value}
            x1="0" x2="100"
            y1={yOf(value).toFixed(2)} y2={yOf(value).toFixed(2)}
            className={css.plotGrid}
          />
        ))}
        {segments.map((segment, index) => (
          <polyline
            key={index}
            points={segment}
            className={css.plotLine}
            style={{ stroke: `var(${props.color})` }}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {points.map((point, index) => (
        <button
          key={point.label}
          type="button"
          className={point.value === null ? `${css.plotDot} ${css.plotDotMissing}` : css.plotDot}
          style={{ left: `${xOf(index)}%`, top: `${point.value === null ? 4 : yOf(point.value)}%` }}
          aria-label={`${point.label}: ${point.value === null ? '—' : formatCount(point.value)}`}
          onFocus={event => show(event.currentTarget, point.label, pointRows(point, props.seriesLabel))}
          onBlur={hide}
          onMouseEnter={event => show(event.currentTarget, point.label, pointRows(point, props.seriesLabel))}
          onMouseLeave={hide}
        />
      ))}
      <ChartTooltip
        visible={tooltip !== undefined}
        point={tooltip?.point ?? { x: 0, y: 0 }}
        title={tooltip?.title ?? ''}
        rows={tooltip?.rows ?? []}
        container={container}
      />
    </div>
  )
}

const MAX_VISIBLE_SLICES = 5

/**
 * 水平分布条：前 5 行 + 其余合并为「其他」（§5.1 构成占比口径）；每行可见
 * 标签与计数，tooltip 补占比；行可聚焦（focus 即 tooltip）。
 * @param props.slices - 分布行（调用方已按计数降序）。
 * @param props.otherLabel - 合并行文案。
 * @param props.shareLabel - 占比行文案。
 * @param props.color - 主类别变量名。
 * @param props.otherColor - 合并行的类别变量名。
 * @returns 分布条列表。
 */
export function BarDistribution(props: {
  slices: readonly DistributionSlice[]
  otherLabel: string
  shareLabel: string
  color: string
  otherColor: string
}): ReactNode {
  const { container, mountContainer, tooltip, show, hide } = usePlotTooltip()
  const total = props.slices.reduce((sum, slice) => sum + slice.count, 0)
  const visible = props.slices.slice(0, MAX_VISIBLE_SLICES)
  const restCount = props.slices.slice(MAX_VISIBLE_SLICES).reduce((sum, slice) => sum + slice.count, 0)
  const rows = restCount > 0
    ? [...visible, { key: '__other__', label: props.otherLabel, count: restCount }]
    : visible
  const max = rows.reduce((peak, row) => Math.max(peak, row.count), 0) || 1
  return (
    <div ref={mountContainer} className={css.plotLayer}>
      <ul className={css.barList}>
        {rows.map((row, index) => {
          const share = total > 0 ? Math.round((row.count / total) * 100) : 0
          const isOther = index >= MAX_VISIBLE_SLICES
          return (
            <li
              key={row.key}
              className={css.barRow}
              tabIndex={0}
              aria-label={`${row.label}: ${formatCount(row.count)} (${props.shareLabel} ${share}%)`}
              onFocus={event => show(event.currentTarget, row.label, [
                { label: props.shareLabel, value: `${share}%` },
              ])}
              onBlur={hide}
              onMouseEnter={event => show(event.currentTarget, row.label, [
                { label: props.shareLabel, value: `${share}%` },
              ])}
              onMouseLeave={hide}
            >
              <span className={css.barLabel}>{row.label}</span>
              <span className={css.barTrack}>
                <span
                  className={css.barFill}
                  style={{
                    width: `${Math.max((row.count / max) * 100, 2)}%`,
                    background: `var(${isOther ? props.otherColor : props.color})`,
                  }}
                />
              </span>
              <span className={css.barCount}>{formatCount(row.count)}</span>
            </li>
          )
        })}
      </ul>
      <ChartTooltip
        visible={tooltip !== undefined}
        point={tooltip?.point ?? { x: 0, y: 0 }}
        title={tooltip?.title ?? ''}
        rows={tooltip?.rows ?? []}
        container={container}
      />
    </div>
  )
}
