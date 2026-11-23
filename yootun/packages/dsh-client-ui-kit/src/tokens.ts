/**
 * yootun 语义变量集中定义（分册规范 §1.1）：图表类别色与数据状态色只在这里
 * 声明一次，取值全部映射官方 `--dsw-static-*` 色板与 alias token；组件样式只
 * 消费 `--yt-*` 变量名，不散落字面色值。色彩不承载唯一信息，图例/标签必须可读。
 * @module
 */

import type { CSSProperties } from 'react'

/** The centralized semantic chart palette; every value maps an official token. */
export const YT_CHART_VARS = {
  '--yt-chart-1': 'var(--dsw-static-deepseek-500)',
  '--yt-chart-2': 'var(--dsw-static-blue-400)',
  '--yt-chart-3': 'var(--dsw-static-green-500)',
  '--yt-chart-4': 'var(--dsw-static-amber-500)',
  '--yt-chart-5': 'var(--dsw-static-deepseek-300)',
  '--yt-chart-6': 'var(--dsw-static-neutral-400)',
  '--yt-chart-positive': 'var(--dsw-static-green-500)',
  '--yt-chart-negative': 'var(--dsw-static-amber-600)',
  '--yt-dist-1': 'var(--dsw-static-amber-500)',
  '--yt-dist-2': 'var(--dsw-static-blue-400)',
  '--yt-dist-3': 'var(--dsw-static-violet-400)',
  '--yt-chart-grid': 'var(--dsw-alias-border-l2)',
  '--yt-chart-mark-text': 'var(--dsw-alias-label-secondary)',
} as const

/** A chart series color chosen from the centralized semantic palette. */
export type YtChartColor = keyof typeof YT_CHART_VARS

/** The style object chart-bearing components spread onto their container root. */
export const ytChartStyle = { ...YT_CHART_VARS } as CSSProperties
