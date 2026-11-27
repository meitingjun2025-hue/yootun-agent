/**
 * 页内图表 marks（ChartFrame 的 children）：单系列折线趋势（真实 y 轴刻度、
 * 缺口日虚线断开不补零、按日聚焦点 + tooltip）、横向分布条与性别环。柱线组合
 * 图（报表趋势）已上移共享包 `@yootun/dsh-client-report`（轴刻度文案函数
 * axisLabel 与本文件折线图共用，两处各持一份同构实现）。绘图只消费集中
 * `--yt-chart-*` 语义变量（ChartFrame 根部下发）；日期列可聚焦，focus 与
 * hover 同一 tooltip（§5.2/§5.3 键盘路径等价 hover）；分布行文本即键盘等价
 * 明细。
 * @module
 */
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartTooltip, type ChartTooltipRow } from '@yootun/dsh-client-ui-kit'
import type { DistRow, TrendPoint } from './schema.ts'
import css from './workbench.module.css'

const INT_FORMATS = new Map<string, Intl.NumberFormat>()
function formatInt(value: number, localeTag: string): string {
  let formatter = INT_FORMATS.get(localeTag)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(localeTag, { maximumFractionDigits: 0 })
    INT_FORMATS.set(localeTag, formatter)
  }
  return formatter.format(value)
}

/** 坐轴标签：大数值用 locale compact（zh 万/亿、en K/M），小跨度保留必要精度。 */
function axisLabel(value: number, span: number, localeTag: string): string {
  const abs = Math.abs(value)
  if (abs >= 10_000) return new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  if (span < 10) return new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(value)
  return String(Math.round(value))
}

/** 单系列折线一行（缺失 null 断线，不按 0 计）。 */
export interface LineRow {
  day: string
  value: number | null
}

/**
 * 单系列折线趋势：真实 y 轴 5 档刻度、x 轴自然日（MM-DD）；缺失日不画点；
 * 相邻有效日间隔 >1 天以虚线相连（缺口显式可见，不补零）；每个日期列是可
 * 聚焦的透明热区，focus/hover 弹出数值 tooltip。
 * @param props.rows - 顺序日行（缺失行 value=null）。
 * @param props.seriesLabel - tooltip / aria 里的系列名。
 * @param props.localeTag - 数值格式化 locale。
 * @param props.emptyText - 无任何有效值时的空态文案。
 * @param props.singleHint - 仅 1 个有效点时的提示文案。
 * @returns 绘图层元素。
 */
export function LineTrendChart(props: {
  rows: readonly LineRow[]
  seriesLabel: string
  localeTag: string
  emptyText: string
  singleHint: string
}): ReactNode {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const rows = props.rows
  // 实测宽度：固定 viewBox 被 width:100% 拉伸会让轴文字与点线整体放大（旧 trend-chart 同构）。
  const [measuredWidth, setMeasuredWidth] = useState(680)
  useEffect(() => {
    if (container === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      const next = entry === undefined ? 0 : Math.round(entry.contentRect.width)
      if (next >= 200) setMeasuredWidth(next)
    })
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [container])
  const width = Math.max(320, measuredWidth)
  const height = 190
  const padLeft = 46
  const padRight = 12
  const padTop = 12
  const padBottom = 24
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom
  const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0
  const xAt = (index: number): number => padLeft + index * stepX
  /** 横轴 5 等分刻度位（旧 axisLabels 同构；逐日标注在窄容器下会互相重叠）。 */
  const axisTickIndexes = rows.length <= 1
    ? [0]
    : [0, 1, 2, 3, 4].map(quarter => Math.floor((quarter * (rows.length - 1)) / 4))
  const activeIndex = hoverIndex ?? focusIndex
  const activeRow = activeIndex !== null ? rows[activeIndex] : undefined
  const rowCount = rows.length

  // hooks 必须先于任何提前返回（空态→有值切换时 hooks 数量变化会触发 React #310 崩溃）。
  useEffect(() => {
    setHoverIndex(null)
    setFocusIndex(null)
  }, [rowCount])

  useLayoutEffect(() => {
    const plotRect = container?.getBoundingClientRect()
    if (plotRect !== undefined && activeIndex !== null) {
      setAnchor({ x: (xAt(activeIndex) / width) * plotRect.width, y: 8 })
    }
  }, [activeIndex, container, rowCount])

  const valid = rows.filter(row => row.value !== null) as { day: string; value: number }[]
  if (valid.length === 0) {
    return <p className={css.chartEmpty}>{props.emptyText}</p>
  }
  const single = valid.length === 1
  const rawMin = Math.min(...valid.map(row => row.value))
  const rawMax = Math.max(...valid.map(row => row.value))
  const yMin = rawMin === rawMax ? Math.max(0, rawMin - 1) : rawMin
  const yMax = rawMin === rawMax ? rawMax + 1 : rawMax
  const yAt = (value: number): number => padTop + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight
  const span = yMax - yMin
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + (span * index) / 4)

  // 折线分段：相邻有效点成段；两点之间的缺口日（列间隔 >1）以虚线连接。
  const segments: { d: string; dashed: boolean }[] = []
  const validIndexes = rows.map((row, index) => row.value === null ? null : index)
    .filter((index): index is number => index !== null)
  for (let i = 1; i < validIndexes.length; i += 1) {
    const prev = validIndexes[i - 1] as number
    const current = validIndexes[i] as number
    const prevRow = rows[prev] as { day: string; value: number }
    const currentRow = rows[current] as { day: string; value: number }
    segments.push({
      d: `M${xAt(prev).toFixed(1)},${yAt(prevRow.value).toFixed(1)}L${xAt(current).toFixed(1)},${yAt(currentRow.value).toFixed(1)}`,
      dashed: current - prev > 1,
    })
  }

  const tooltipRows = (row: LineRow): ChartTooltipRow[] => [{
    label: props.seriesLabel,
    value: row.value === null ? '—' : formatInt(row.value, props.localeTag),
  }]

  return (
    <div ref={setContainer} className={css.plotLayer}>
      {single && <p className={css.chartInlineHint} role='status'>{props.singleHint}</p>}
      <svg className={css.axisSvg} viewBox={`0 0 ${width} ${height}`} aria-hidden='true'>
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={padLeft} x2={width - padRight}
              y1={yAt(tick).toFixed(1)} y2={yAt(tick).toFixed(1)}
              className={css.plotGrid}
            />
            <text x={padLeft - 8} y={(yAt(tick) + 3).toFixed(1)} textAnchor='end' className={css.axisText}>
              {axisLabel(tick, span, props.localeTag)}
            </text>
          </g>
        ))}
        {segments.map((segment, index) => (
          <path
            key={index}
            d={segment.d}
            fill='none'
            className={segment.dashed ? css.plotLineDashed : css.plotLine}
            style={{ stroke: 'var(--yt-chart-1)' }}
          />
        ))}
        <line
          x1={padLeft} y1={padTop + plotHeight} x2={width - padRight} y2={padTop + plotHeight}
          className={css.plotGrid}
        />
        {rows.map((row, index) => row.value === null ? null : (
          <circle key={row.day} cx={xAt(index).toFixed(1)} cy={yAt(row.value as number).toFixed(1)} r={3} className={css.plotDot} style={{ fill: 'var(--yt-chart-1)' }} />
        ))}
        {axisTickIndexes.map((index, tickIndex) => (
          <text
            key={rows[index]?.day ?? tickIndex}
            x={xAt(index).toFixed(1)} y={height - 8}
            textAnchor={tickIndex === 0 ? 'start' : tickIndex === axisTickIndexes.length - 1 ? 'end' : 'middle'}
            className={css.axisText}
          >
            {rows[index]?.day.slice(5) ?? ''}
          </text>
        ))}
      </svg>
      {activeRow !== undefined && (
        <span
          className={css.plotCrosshair}
          aria-hidden='true'
          style={{ left: `${(xAt(activeIndex as number) / width) * 100}%`, height: `${((height - padBottom) / height) * 100}%` }}
        />
      )}
      {rows.map((row, index) => (
        <button
          key={row.day}
          type='button'
          className={css.plotColumn}
          style={{ left: `${(xAt(index) / width) * 100}%` }}
          aria-label={`${row.day} ${props.seriesLabel} ${row.value === null ? '—' : formatInt(row.value, props.localeTag)}`}
          onFocus={() => { setFocusIndex(index) }}
          onBlur={() => { setFocusIndex(null) }}
          onMouseEnter={() => { setHoverIndex(index) }}
          onMouseLeave={() => { setHoverIndex(null) }}
        />
      ))}
      <ChartTooltip
        visible={activeRow !== undefined}
        point={anchor}
        title={activeRow !== undefined ? activeRow.day : ''}
        rows={activeRow !== undefined ? tooltipRows(activeRow) : []}
        container={container}
      />
    </div>
  )
}

/**
 * 横向分布条（前 N 行）：行即明细（名 + 占比可见，aria 同步）；缺失 pct 不
 * 画条。占比直接取服务端口径，不本地重算。
 * @param props.rows - 分布行。
 * @param props.format - 行标签格式化（性别/年龄等中文化由调用方完成）。
 * @param props.localeTag - 数值格式化 locale。
 * @returns 条形行列表。
 */
export function DistributionBars(props: {
  rows: readonly DistRow[]
  format: (key: string) => string
  localeTag: string
}): ReactNode {
  const rows = props.rows.slice(0, 3)
  const max = rows.reduce((acc, row) => Math.max(acc, row.pct ?? 0), 0) || 1
  return (
    <ul className={css.barList}>
      {rows.map(row => (
        <li key={row.key} className={css.barRow}>
          <Tooltip label={props.format(row.key)} onlyWhenClipped portal><span className={css.barLabel}>{props.format(row.key)}</span></Tooltip>
          <span className={css.barTrack}>
            {row.pct !== null && (
              <span className={css.barFill} style={{ width: `${Math.min(100, (row.pct / max) * 100)}%`, background: 'var(--yt-chart-2)' }} />
            )}
          </span>
          <span className={css.barCount}>{row.pct === null ? '—' : `${Math.round(row.pct * 10) / 10}%`}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * 性别环形图：SVG 描边环 + 中心总数；图例行「名 占比」即键盘等价明细；
 * 颜色按语义 key 固定（男 `--yt-chart-2`、女 `--yt-chart-negative`、其他
 * `--yt-chart-6`），不按数组下标取色。
 * @param props.rows - 性别分布行。
 * @param props.format - key 中文化函数。
 * @returns 环形 + 图例。
 */
export function GenderRing(props: { rows: readonly DistRow[]; format: (key: string) => string }): ReactNode {
  const rows = props.rows
  const total = rows.reduce((acc, row) => acc + (row.pct ?? 0), 0)
  const radius = 15.9155
  const circumference = 2 * Math.PI * radius
  let acc = 0
  const colorOf = (key: string): string => {
    if (key === 'male') return 'var(--yt-chart-2)'
    if (key === 'female') return 'var(--yt-chart-negative)'
    return 'var(--yt-chart-6)'
  }
  return (
    <div className={css.donutRow}>
      <svg className={css.donut} viewBox='0 0 40 40' aria-hidden='true'>
        <circle cx='20' cy='20' r={radius} fill='none' className={css.donutTrack} />
        {rows.map(row => {
          const start = total > 0 ? (acc / total) * circumference : 0
          const pct = row.pct ?? 0
          acc += pct
          const length = total > 0 ? (pct / total) * circumference : 0
          return (
            <circle
              key={row.key}
              cx='20' cy='20' r={radius}
              fill='none'
              className={css.donutSlice}
              stroke={colorOf(row.key)}
              strokeDasharray={`${length.toFixed(3)} ${(circumference - length).toFixed(3)}`}
              strokeDashoffset={(circumference / 4 - start).toFixed(3)}
            />
          )
        })}
      </svg>
      <ul className={css.donutLegend}>
        {rows.map(row => (
          <li key={row.key} className={css.donutLegendRow}>
            <span className={css.donutDot} style={{ background: colorOf(row.key) }} aria-hidden='true' />
            <span className={css.donutLegendText}>
              {props.format(row.key)} {row.pct === null ? '—' : `${Math.round(row.pct * 10) / 10}%`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * 账号趋势点 → 折线日行（30 天固定窗口：窗口锚点 = 最后一个有效点的自然日；
 * 窗口外历史日丢弃——clamp 会叠成一列点；窗口内缺失日 value=null 断线）。
 * @param points - 服务端趋势点。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns 30 行折线数据。
 */
export function accountTrendRows(points: readonly TrendPoint[]): LineRow[] {
  const valid = points
    .filter((point): point is { day: string; value: number } => point.value !== null)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const anchorRow = valid.at(-1)
  if (anchorRow === undefined) return []
  const byDay = new Map(points.map(point => [point.day, point.value]))
  const anchor = Date.parse(`${anchorRow.day}T00:00:00Z`)
  if (Number.isNaN(anchor)) return []
  const days = Array.from({ length: 30 }, (_, index) =>
    new Date(anchor - (29 - index) * 86_400_000).toISOString().slice(0, 10))
  return days.map(day => ({ day, value: byDay.get(day) ?? null }))
}

/**
 * 作品趋势点 → 7 天窗口折线日行（窗口锚点 = 最后有效点；发布前不画、缺失
 * 断线，不补零）。
 * @param points - work.trend 趋势点。
 * @param now - 当前毫秒时刻（测试注入）。
 * @returns 7 行折线数据。
 */
export function workTrendRows(points: readonly TrendPoint[]): LineRow[] {
  const valid = points
    .filter((point): point is { day: string; value: number } => point.value !== null)
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const anchorRow = valid.at(-1)
  if (anchorRow === undefined) return []
  const byDay = new Map(points.map(point => [point.day, point.value]))
  const anchor = Date.parse(`${anchorRow.day}T00:00:00Z`)
  if (Number.isNaN(anchor)) return []
  const days = Array.from({ length: 7 }, (_, index) =>
    new Date(anchor - (6 - index) * 86_400_000).toISOString().slice(0, 10))
  return days.map(day => ({ day, value: byDay.get(day) ?? null }))
}

/**
 * 实测容器宽度（旧插件 useMeasuredWidth 同构）：ResizeObserver 跟随容器宽度，
 * 忽略塌缩态（隐藏/折叠时的 0 宽）；无 ResizeObserver 的环境保持回退宽度。
 * SVG 按实测像素绘制，刻度与徽标字号不随容器缩放。
 * @param fallbackWidth - 首帧与不可测环境的宽度。
 * @returns 挂到容器上的 ref 回调与当前实测宽度。
 */
export function useMeasuredWidth(fallbackWidth: number): [(node: HTMLDivElement | null) => void, number] {
  const [node, setNode] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallbackWidth)
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      const nextWidth = entry === undefined ? 0 : Math.round(entry.contentRect.width)
      if (nextWidth >= 200) setWidth(nextWidth)
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [node])
  return [setNode, width]
}
