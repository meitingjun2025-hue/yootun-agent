/**
 * 页内图表 marks（ChartFrame 的 children）：多系列折线趋势（真实 y 轴刻度、
 * 缺失断线、按日聚焦点 + tooltip）、环形图（中心总人数 + 图例即等价明细）、
 * 柱状分布（柱顶百分比）、Top-N 横向条形。绘图只消费集中 `--yt-chart-*` 语义
 * 变量（ChartFrame 根部下发）；折线日期点可聚焦，tooltip 在 focus 时同样出现
 * （§5.2/§5.3：键盘路径等价于 hover）；分布行文本即键盘等价明细。
 * @module
 */
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { ChartTooltip, type ChartTooltipRow, type YtChartColor } from '@yootun/dsh-client-ui-kit'
import type { PortraitSlice } from './schema.ts'
import css from './workbench.module.css'

/** 折线一个系列定义。 */
export interface TrendSeries {
  /** 行记录里的数值键。 */
  key: string
  /** 图例 / tooltip 里的系列名。 */
  label: string
  /** 集中类别变量名（如 `--yt-chart-1`）。 */
  color: YtChartColor
}

/** 折线一行：day 标签 + 各系列数值（null 断线，不按 0 计）。 */
export interface TrendRow {
  day: string
  values: Record<string, number | null>
}

/** locale 整数千分位格式化（模块级缓存，按 locale 复用）。 */
const INT_FORMATS = new Map<string, Intl.NumberFormat>()
function formatInt(value: number, locale: string): string {
  let formatter = INT_FORMATS.get(locale)
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
    INT_FORMATS.set(locale, formatter)
  }
  return formatter.format(value)
}

/** 坐轴标签：大数值用 locale compact（zh 万/亿、en K/M），小跨度保留必要精度。 */
function axisLabel(value: number, span: number, locale: string): string {
  const abs = Math.abs(value)
  if (abs >= 10_000) return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  if (span < 10) return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
  return String(Math.round(value))
}

/**
 * 多系列折线趋势：统一真实 y 轴刻度（5 档横网格 + 左侧数值标签）、x 轴为行
 * 给出的自然日（MM-DD）；缺失值断线（不跨缺口连线、不造 0）；每个日期列是
 * 一个可聚焦的透明热区，focus/hover 都在当日 x 位置画一根贯穿绘图区的竖虚线
 * 并弹出全系列 tooltip（虚线止于日期带上方，不遮日期文字）。focus 与 hover
 * 是两个独立来源：任一路结束都回落到另一路的指示，键盘焦点指示不因鼠标划过
 * 而消失。主系列（首项）最后绘制、压在最上层。
 * @param props.rows - 顺序日行（已按最近 N 日补齐）。
 * @param props.series - 系列定义（首项为主系列）。
 * @param props.locale - 数值格式化的 locale 标签。
 * @param props.trendEmpty - 无任何有效值时的空态文案。
 * @returns 绘图层元素（配合绝对定位容器）。
 */
export function LineTrendChart(props: {
  rows: readonly TrendRow[]
  series: readonly TrendSeries[]
  locale: string
  trendEmpty: string
}): ReactNode {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  /** hover 与 focus 分开记录：activeIndex = hover 优先，其次 focus。 */
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  /** 激活列的 tooltip 锚点（容器 CSS 像素坐标；由 viewBox 坐标等比换算）。 */
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const rows = props.rows
  const series = props.series
  const width = 680
  const height = 210
  const padLeft = 46
  const padRight = 12
  const padTop = 12
  const padBottom = 24
  const plotWidth = width - padLeft - padRight
  const plotHeight = height - padTop - padBottom
  const stepX = rows.length > 1 ? plotWidth / (rows.length - 1) : 0
  const xAt = (index: number): number => padLeft + index * stepX
  const activeIndex = hoverIndex ?? focusIndex
  const activeRow = activeIndex !== null ? rows[activeIndex] : undefined

  const values: number[] = []
  for (const line of series) {
    for (const row of rows) {
      const value = row.values[line.key]
      if (value !== null && value !== undefined) values.push(value)
    }
  }
  if (values.length === 0) {
    return <p className={css.chartEmpty}>{props.trendEmpty}</p>
  }
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const yMin = rawMin === rawMax ? Math.max(0, rawMin - 1) : rawMin
  const yMax = rawMin === rawMax ? rawMax + 1 : rawMax
  const yAt = (value: number): number => padTop + plotHeight - ((value - yMin) / (yMax - yMin)) * plotHeight
  const span = yMax - yMin
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + (span * index) / 4)
  const locale = props.locale

  const dayTooltipRows = (row: TrendRow): ChartTooltipRow[] =>
    series.map(line => ({
      label: line.label,
      value: row.values[line.key] === null || row.values[line.key] === undefined
        ? '—'
        : formatInt(row.values[line.key] as number, locale),
      color: line.color,
    }))

  // 行数变化后旧索引可能越界 / 错位（数据刷新换行）：重置两路激活态。
  const rowCount = rows.length
  useEffect(() => {
    setHoverIndex(null)
    setFocusIndex(null)
  }, [rowCount])

  // 激活列变化时按 viewBox → 容器的等比缩放重算 tooltip 锚点。
  useLayoutEffect(() => {
    const plotRect = container?.getBoundingClientRect()
    if (plotRect !== undefined && activeIndex !== null) {
      setAnchor({ x: (xAt(activeIndex) / width) * plotRect.width, y: 8 })
    }
    // xAt 随 rows.length 变化；anchor 只依赖激活列与容器宽度。
  }, [activeIndex, container, rowCount])

  return (
    <div ref={setContainer} className={css.plotLayer}>
      <svg className={css.axisSvg} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={padLeft} x2={width - padRight}
              y1={yAt(tick).toFixed(1)} y2={yAt(tick).toFixed(1)}
              className={css.plotGrid}
            />
            <text
              x={padLeft - 8} y={(yAt(tick) + 3).toFixed(1)}
              textAnchor="end" className={css.axisText}
            >
              {axisLabel(tick, span, locale)}
            </text>
          </g>
        ))}
        {[...series].reverse().map(line => {
          let d = ''
          let segmentOpen = false
          rows.forEach((row, index) => {
            const value = row.values[line.key]
            if (value === null || value === undefined) {
              segmentOpen = false
              return
            }
            d += `${segmentOpen ? 'L' : 'M'}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`
            segmentOpen = true
          })
          if (d === '') return null
          return (
            <path
              key={line.key}
              d={d}
              fill="none"
              className={css.plotLine}
              style={{ stroke: `var(${line.color})` }}
            />
          )
        })}
        <line
          x1={padLeft} y1={padTop + plotHeight} x2={width - padRight} y2={padTop + plotHeight}
          className={css.plotGrid}
        />
        {rows.map((row, index) => (
          <text
            key={row.day}
            x={xAt(index).toFixed(1)} y={height - 8}
            textAnchor="middle" className={css.axisText}
          >
            {row.day.slice(5)}
          </text>
        ))}
      </svg>
      {activeRow !== undefined && (
        // 竖虚线只贯穿数值绘图区：止于日期带上方，不遮挡 x 轴日期文字。
        <span
          className={css.plotCrosshair}
          aria-hidden="true"
          style={{
            left: `${(xAt(activeIndex as number) / width) * 100}%`,
            height: `${((height - padBottom) / height) * 100}%`,
          }}
        />
      )}
      {rows.map((row, index) => (
        <button
          key={row.day}
          type="button"
          className={css.plotColumn}
          style={{ left: `${(xAt(index) / width) * 100}%` }}
          aria-label={dayAria(row, series, locale)}
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
        rows={activeRow !== undefined ? dayTooltipRows(activeRow) : []}
        container={container}
      />
    </div>
  )
}

/** 日期点 aria：day + 各系列「名 值」，缺失为 —。 */
function dayAria(row: TrendRow, series: readonly TrendSeries[], locale: string): string {
  const parts = series.map(line => {
    const value = row.values[line.key]
    return `${line.label} ${value === null || value === undefined ? '—' : formatInt(value, locale)}`
  })
  return `${row.day} ${parts.join(', ')}`
}

/** 语义类别色序列（环形按序取色）。 */
const SLICE_COLORS: readonly YtChartColor[] = ['--yt-chart-1', '--yt-chart-2', '--yt-chart-3', '--yt-chart-4', '--yt-chart-5', '--yt-chart-6']

/** 未知编码行固定中性档。 */
function isUnknownKey(key: string): boolean {
  return key === 'unknow' || key === 'unknown'
}

function sliceColor(index: number, key: string): YtChartColor {
  return isUnknownKey(key) ? '--yt-chart-6' : SLICE_COLORS[index % SLICE_COLORS.length] ?? '--yt-chart-6'
}

/**
 * 环形分布图：SVG 描边环 + 中心总人数；图例行本身可见「名 人数 · 占比」，
 * 即键盘等价明细（§5.2）。缺失维度由调用方呈现空态，不传空 slices。
 * @param props.slices - 分布行（调用方定序）。
 * @param props.locale - 数值格式化的 locale 标签。
 * @param props.totalLabel - 中心标签（总人数）。
 * @param props.title - 图表标题（aria 组装用）。
 * @param props.aria - localized「{title}：共 {count} 人」组装函数。
 * @returns 环形 + 图例。
 */
export function DonutChart(props: {
  slices: readonly PortraitSlice[]
  locale: string
  totalLabel: string
  title: string
  aria: (title: string, count: number) => string
}): ReactNode {
  const slices = props.slices
  const total = slices.reduce((sum, slice) => sum + slice.count, 0)
  const radius = 15.9155
  const circumference = 2 * Math.PI * radius
  let acc = 0
  const segments = slices.map((slice, index) => {
    const start = total > 0 ? (acc / total) * circumference : 0
    acc += slice.count
    const length = total > 0 ? (slice.count / total) * circumference : 0
    return {
      slice,
      dash: `${length.toFixed(3)} ${(circumference - length).toFixed(3)}`,
      offset: (circumference / 4 - start).toFixed(3),
      color: sliceColor(index, slice.key),
    }
  })
  return (
    <div className={css.donutRow} role="img" aria-label={props.aria(props.title, total)}>
      <svg className={css.donut} viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="20" cy="20" r={radius} fill="none" className={css.donutTrack} />
        {segments.map(segment => (
          <circle
            key={segment.slice.key}
            cx="20" cy="20" r={radius}
            fill="none"
            className={css.donutSlice}
            stroke={`var(${segment.color})`}
            strokeDasharray={segment.dash}
            strokeDashoffset={segment.offset}
          />
        ))}
        <text x="20" y="19" textAnchor="middle" className={css.donutTotal}>{formatInt(total, props.locale)}</text>
        <text x="20" y="26" textAnchor="middle" className={css.donutTotalLabel}>{props.totalLabel}</text>
      </svg>
      <ul className={css.donutLegend}>
        {slices.map((slice, index) => {
          const share = total > 0 ? Math.round((slice.count / total) * 100) : null
          return (
            <li key={slice.key} className={css.donutLegendRow}>
              <span className={css.donutDot} style={{ background: `var(${sliceColor(index, slice.key)})` }} aria-hidden="true" />
              <span className={css.donutLegendText}>
                {share === null
                  ? `${slice.label} ${formatInt(slice.count, props.locale)}`
                  : `${slice.label} ${formatInt(slice.count, props.locale)} · ${share}%`}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * 柱状分布（年龄维度）：柱顶百分比、柱下标签；每列可聚焦并带完整 aria
 * （人数 + 占比），可见文本即等价明细。
 * @param props.slices - 分布行（官方年龄桶固定顺序）。
 * @param props.locale - 数值格式化的 locale 标签。
 * @param props.aria - localized「{name}：{count} 人，占比 {share}%」组装函数。
 * @returns 柱状分布。
 */
export function ColumnChart(props: {
  slices: readonly PortraitSlice[]
  locale: string
  aria: (name: string, count: number, share: number) => string
}): ReactNode {
  const total = props.slices.reduce((sum, slice) => sum + slice.count, 0)
  const max = Math.max(1, ...props.slices.map(slice => slice.count))
  return (
    <ul className={css.columnChart}>
      {props.slices.map(slice => {
        const share = total > 0 ? Math.round((slice.count / total) * 100) : 0
        return (
          <li
            key={slice.key}
            className={css.columnItem}
            tabIndex={0}
            aria-label={props.aria(slice.label, slice.count, share)}
          >
            <span className={css.columnValue}>{total > 0 ? `${share}%` : '—'}</span>
            <span className={css.columnBarTrack}>
              <span className={css.columnBar} style={{ height: `${Math.max(8, Math.round((slice.count / max) * 100))}%` }} />
            </span>
            <span className={css.columnLabel}>{slice.label}</span>
            <span className={css.columnCount}>{formatInt(slice.count, props.locale)}</span>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Top-N 横向条形（省份 / 城市）：行即明细（名 + 计数可见，aria 带占比）；
 * 长尾由调用方截断（只传 Top 5），不渲染合并行。占比分母是调用方给的维度
 * 完整总数（`total`），不用 Top N 局部分母——截断后的 share 仍对全量成立。
 * @param props.slices - 已降序截断的分布行。
 * @param props.total - 该维度完整总数（含未展示的长尾）。
 * @param props.locale - 数值格式化的 locale 标签。
 * @param props.aria - localized「{name}：{count} 人，占比 {share}%」组装函数。
 * @returns 条形行列表。
 */
export function RankBars(props: {
  slices: readonly PortraitSlice[]
  total: number
  locale: string
  aria: (name: string, count: number, share: number) => string
}): ReactNode {
  const max = Math.max(1, ...props.slices.map(slice => slice.count))
  return (
    <ul className={css.barList}>
      {props.slices.map(slice => {
        const share = props.total > 0 ? Math.round((slice.count / props.total) * 100) : 0
        return (
          <li
            key={slice.key}
            className={css.barRow}
            tabIndex={0}
            aria-label={props.aria(slice.label, slice.count, share)}
          >
            <span className={css.barLabel}>{slice.label}</span>
            <span className={css.barTrack}>
              <span className={css.barFill} style={{ width: `${Math.max((slice.count / max) * 100, 2)}%`, background: 'var(--yt-chart-2)' }} />
            </span>
            <span className={css.barCount}>{formatInt(slice.count, props.locale)}</span>
          </li>
        )
      })}
    </ul>
  )
}
