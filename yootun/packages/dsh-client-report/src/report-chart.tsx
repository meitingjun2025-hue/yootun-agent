/**
 * 报表趋势组合图（上移自抖音工作台 `charts.tsx` 的 `ReportComboChart`，装在
 * kit ChartFrame 的绘图区内）：播放增量柱（`--yt-chart-2`，末位最新一期深色
 * `--yt-chart-1`）+ 净增粉丝线（`--yt-chart-4`）；缺采柱不补零（留空刻度）、
 * 线 null 断开；每期整列可悬浮/聚焦（button 语义，Enter/Space 原生支持），
 * 弹 kit ChartTooltip 数值浮层（标题为日期，两行为柱、线系列值，缺采「—」，
 * 靠边自动翻转）并带完整数值 aria。轴刻度文案函数 {@linkcode axisLabel} 与
 * 折线图共用，各包自带一份。
 * @module
 */
import { useEffect, useState, type ReactNode } from 'react'
import { ChartTooltip } from '@yootun/dsh-client-ui-kit'
import { formatCount } from './format.ts'
import css from './report.module.css'

/** 坐轴标签：大数值用 locale compact（zh 万/亿、en K/M），小跨度保留必要精度。 */
function axisLabel(value: number, span: number, localeTag: string): string {
  const abs = Math.abs(value)
  if (abs >= 10_000) return new Intl.NumberFormat(localeTag, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  if (span < 10) return new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(value)
  return String(Math.round(value))
}

/**
 * 渲染报表趋势组合图。
 * @param props.days - 周期标签（日/周）。
 * @param props.bars - 柱值（null = 缺采）。
 * @param props.line - 线值（null = 缺采）。
 * @param props.barLabel - 柱系列名（图例与浮层行 label）。
 * @param props.lineLabel - 线系列名（图例与浮层行 label）。
 * @param props.localeTag - 数值格式化 locale。
 * @returns 组合图形。
 */
export function ReportComboChart(props: {
  days: readonly string[]
  bars: readonly (number | null)[]
  line: readonly (number | null)[]
  barLabel: string
  lineLabel: string
  localeTag: string
}): ReactNode {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)
  // 实测宽度（旧 trend-chart 同构）：固定 viewBox 被拉伸会让轴文字与点线整体放大。
  const [measuredWidth, setMeasuredWidth] = useState(1106)
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
  const height = 240
  const pad = { top: 16, right: 16, bottom: 28, left: 56 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const count = Math.max(props.days.length, props.bars.length, props.line.length)
  const slot = count > 0 ? plotWidth / count : plotWidth
  const barWidth = Math.max(8, Math.min(48, slot * 0.5))
  const barValues = props.bars.filter((value): value is number => value !== null)
  const barMax = barValues.length > 0 ? Math.max(...barValues) : 0
  const maxBar = barMax <= 0 ? 1 : niceMax(barValues)
  const lineValues = props.line.filter((value): value is number => value !== null)
  const lineBound = lineRange(lineValues)
  const yLine = (value: number): number => lineBound === null
    ? pad.top + plotHeight
    : pad.top + plotHeight - ((value - lineBound.min) / (lineBound.max - lineBound.min)) * plotHeight
  const gridRatios = [0, 0.25, 0.5, 0.75, 1]
  const lastBarIndex = props.bars.length - 1

  const lineSegments: { d: string }[] = []
  let current = ''
  props.line.forEach((value, index) => {
    if (value === null || lineBound === null) return
    current += `${current === '' ? 'M' : 'L'}${(pad.left + slot * index + slot / 2).toFixed(1)},${yLine(value).toFixed(1)}`
    const next = props.line[index + 1]
    if (next === null || next === undefined) {
      lineSegments.push({ d: current })
      current = ''
    }
  })
  if (current !== '') lineSegments.push({ d: current })

  const activeIndex = hoverIndex ?? focusIndex
  const cellText = (value: number | null | undefined): string => value === null || value === undefined ? '—' : formatCount(value, props.localeTag)

  return (
    <div ref={setContainer} className={css.plotLayer}>
    <svg className={css.comboSvg} viewBox={`0 0 ${width} ${height}`} role='img'>
      {gridRatios.map(ratio => {
        const y = pad.top + plotHeight - plotHeight * ratio
        const label = axisLabel(maxBar * ratio, maxBar, props.localeTag)
        return (
          <g key={ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className={css.plotGrid} />
            <text x={pad.left - 8} y={y + 4} textAnchor='end' className={css.axisText}>{label}</text>
          </g>
        )
      })}
      {props.bars.map((value, index) => {
        if (value === null) return null
        const barHeight = (value / maxBar) * plotHeight
        const x = pad.left + slot * index + (slot - barWidth) / 2
        return (
          <rect
            key={`bar-${index}`}
            x={x.toFixed(1)} y={(pad.top + plotHeight - barHeight).toFixed(1)}
            width={barWidth.toFixed(1)} height={barHeight.toFixed(1)} rx={3}
            className={index === lastBarIndex ? css.comboBarLast : css.comboBar}
          />
        )
      })}
      {lineBound !== null && lineSegments.map((segment, index) => (
        <path key={`line-${index}`} d={segment.d} fill='none' className={css.comboLine} />
      ))}
      {lineBound !== null && props.line.map((value, index) => value === null ? null : (
        <circle
          key={`dot-${index}`}
          cx={(pad.left + slot * index + slot / 2).toFixed(1)} cy={yLine(value).toFixed(1)} r={3.5}
          className={css.comboDot}
        />
      ))}
      {props.days.map((day, index) => (
        <text
          key={`day-${index}`}
          x={(pad.left + slot * index + slot / 2).toFixed(1)} y={height - 8}
          textAnchor='middle' className={css.axisText}
        >
          {day}
        </text>
      ))}
    </svg>
    {activeIndex !== null && (
      <span
        className={css.plotCrosshair}
        aria-hidden='true'
        style={{ left: `${((pad.left + slot * activeIndex + slot / 2) / width) * 100}%`, height: `${((height - pad.bottom) / height) * 100}%` }}
      />
    )}
    {props.days.map((day, index) => (
      <button
        key={day}
        type='button'
        className={css.comboColumn}
        style={{ left: `${((pad.left + slot * index) / width) * 100}%`, width: `${(slot / width) * 100}%` }}
        aria-label={`${day} ${props.lineLabel} ${cellText(props.line[index])}`}
        onFocus={() => { setFocusIndex(index) }}
        onBlur={() => { setFocusIndex(null) }}
        onMouseEnter={() => { setHoverIndex(index) }}
        onMouseLeave={() => { setHoverIndex(null) }}
      />
    ))}
    {activeIndex !== null && (
      // kit ChartTooltip：标题为日期，两行为柱、线系列值（缺采「—」）；位置与
      // 靠边翻转由 placeTooltip 决定，不遮挡当前列。
      <ChartTooltip
        visible
        point={{
          x: pad.left + slot * activeIndex + slot / 2,
          y: props.line[activeIndex] === null || props.line[activeIndex] === undefined || lineBound === null
            ? pad.top + plotHeight / 2
            : yLine(props.line[activeIndex] as number),
        }}
        title={props.days[activeIndex] ?? ''}
        rows={[
          { label: props.barLabel, value: cellText(props.bars[activeIndex]), color: '--yt-chart-2' },
          { label: props.lineLabel, value: props.line[activeIndex] === null || props.line[activeIndex] === undefined ? '—' : formatSignedCount(props.line[activeIndex] as number, props.localeTag), color: '--yt-chart-4' },
        ]}
        container={container}
      />
    )}
    </div>
  )
}

/** 带符号计数（净增粉丝类指标：正数带 +，负数保留 -）。 */
function formatSignedCount(value: number, localeTag: string): string {
  return value > 0 ? `+${formatCount(value, localeTag)}` : formatCount(value, localeTag)
}

/** 优雅刻度：max 取 1/2/5×10^k 向上取整；全 0 → 固定 1（退化）。 */
function niceMax(values: readonly number[]): number {
  const max = Math.max(...values.map(value => Number(value) || 0))
  if (max <= 0) return 1
  const exponent = Math.floor(Math.log10(max))
  const base = 10 ** exponent
  for (const factor of [1, 2, 5, 10]) {
    if (factor * base >= max) return factor * base
  }
  return 10 * base
}

/** 线纵轴范围：非空值 ±10% 余量；单点或 min==max → ±1 padding（退化）。 */
function lineRange(values: readonly number[]): { min: number; max: number } | null {
  if (values.length === 0) return null
  let min = Math.min(...values)
  let max = Math.max(...values)
  if (min === max) {
    min -= 1
    max += 1
  } else {
    const pad = (max - min) * 0.1
    min -= pad
    max += pad
  }
  return { min, max }
}
