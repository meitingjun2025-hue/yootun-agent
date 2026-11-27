/**
 * 报表 HTML 导出的序列化（上移自抖音工作台 `ReportPage.tsx`，产出不变）：
 * 自包含单文件（token 解析内联 + details 全展开 + 语义类名 dyr-*）。源码层
 * 零字面色值——颜色在运行时经 {@linkcode resolveToken} 解析内联，未解析回退
 * CSS 系统色。
 * @module
 */
import { formatCount, formatDateTime, shiftDay } from './format.ts'
import { periodTitle } from './report-detail.tsx'
import type { ReportDetail } from './schema.ts'
import type { ReportTranslate } from './locales.ts'

/** token 解析（导出内联；未解析回退 CSS 系统色，不落字面色值）。 */
function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return `var(${name},${fallback})`
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? `var(${name},${fallback})` : value
}

/**
 * 序列化自包含单文件 HTML（details 全展开 + token 内联 + 语义类名 dyr-*）。
 * @param detail - 详情投影。
 * @param t - 报表词典翻译函数。
 * @param locale - 当前语言（数值格式化口径）。
 * @returns HTML 文本。
 */
export function serializeReportHtml(detail: ReportDetail, t: ReportTranslate, locale: 'zh' | 'en'): string {
  const data = detail.data
  const lines: string[] = []
  const esc = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  const tokenStyle = [
    `:root{--dyr-text:${resolveToken('--dsw-alias-label-primary', 'canvastext')};`,
    `--dyr-muted:${resolveToken('--dsw-alias-label-secondary', 'graytext')};`,
    `--dyr-bg:${resolveToken('--dsw-alias-bg-layer-1', 'canvas')};`,
    `--dyr-border:${resolveToken('--dsw-alias-border-l2', 'graytext')};`,
    `--dyr-accent:${resolveToken('--dsw-alias-border-selected', 'highlight')};`,
    `--dyr-up:${resolveToken('--dsw-alias-state-error-primary', 'mark')};`,
    `--dyr-down:${resolveToken('--dsw-alias-state-success-primary', 'field')};}`,
  ].join('')
  const sheet = `${tokenStyle}
.dyr{font:13px/1.7 system-ui,sans-serif;color:var(--dyr-text);background:var(--dyr-bg);max-width:1106px;margin:0 auto;padding:24px}
.dyr h2{margin:0 0 8px;font-size:18px}
.dyr h3{margin:24px 0 10px;font-size:15px}
.dyr dl{margin:0 0 12px}.dyr dt{font-weight:600;display:inline}.dyr dt::after{content:'：'}
.dyr dd{display:inline;margin:0 16px 0 0}
.dyr table{border-collapse:collapse;width:100%;margin-bottom:8px}
.dyr th,.dyr td{border:1px solid var(--dyr-border);padding:6px 10px;text-align:start;font-variant-numeric:tabular-nums}
.dyr th{color:var(--dyr-muted);font-weight:400}
.dyr .up{color:var(--dyr-up)}.dyr .down{color:var(--dyr-down)}
.dyr details[open] summary{font-weight:600}
@media print{.dyr{padding:0}}`
  lines.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">', `<title>${esc(periodTitle(detail, t))}</title>`, `<style>${sheet}</style></head><body><div class="dyr">`)
  lines.push(`<h2>${esc(periodTitle(detail, t))}</h2>`)
  if (data !== null) {
    const coverage = data.coverage
    lines.push(`<dl>`)
    lines.push(`<dt>${esc(t('report.header.generatedAt', { time: formatDateTime(data.generatedAt ?? detail.finishedAt), count: formatCount(coverage?.totalAccounts ?? null, locale) }))}</dt>`)
    lines.push(`<dt>${esc(t('report.header.interaction'))}</dt><dd>${esc(t('report.header.interactionText'))}</dd>`)
    lines.push(`<dt>${esc(t('report.header.note'))}</dt><dd>${esc(t('report.header.noteText'))}</dd></dl>`)
    lines.push('<h3>KPI</h3><table><tbody>')
    for (const metric of data.coreMetrics) {
      const change = metric.changePct === null ? '' : `<span class="${metric.changePct > 0 ? 'up' : metric.changePct < 0 ? 'down' : ''}">${metric.changePct > 0 ? '▲' : metric.changePct < 0 ? '▼' : ''}${Math.abs(metric.changePct).toFixed(1)}%</span>`
      lines.push(`<tr><th>${esc(metric.label ?? metric.key)}</th><td>${metric.available ? esc(formatCount(metric.value, locale)) : '—'} ${change}</td></tr>`)
    }
    lines.push('</tbody></table>')
    lines.push(`<h3>${esc(esc(detail.reportType === 'weekly' ? t('report.trend.weekly') : t('report.trend.daily')))}</h3><table><tbody>`)
    data.trendSeries.days.forEach((day, index) => {
      const bar = data.trendSeries.bars[index] ?? null
      const linePoint = data.trendSeries.line[index] ?? null
      lines.push(`<tr><th>${esc(day)}</th><td>${bar === null ? '—*' : esc(formatCount(bar, locale))}</td><td>${linePoint === null ? '—*' : esc(formatCount(linePoint, locale))}</td></tr>`)
    })
    lines.push('</tbody></table>')
    lines.push(`<h3>${esc(detail.reportType === 'weekly' ? t('report.accounts.weekly', { from: detail.periodStart ?? '', to: shiftDay(detail.periodEnd ?? '', -1) }) : t('report.accounts.daily', { day: detail.periodStart ?? '' }))}</h3>`)
    lines.push('<table><thead><tr>')
    for (const label of [t('report.col.account'), t('report.col.owner'), t('report.col.fans'), t('report.col.plays'), t('report.col.netFans'), t('report.col.publishes'), t('report.col.likes'), t('report.col.comments'), t('report.col.shares')]) {
      lines.push(`<th>${esc(label)}</th>`)
    }
    lines.push('</tr></thead><tbody>')
    for (const row of data.accounts) {
      const cells = [
        esc(row.nickname ?? row.accountId),
        esc(row.ownerName ?? '—'),
        formatCount(row.fanCount, locale),
        ...(['plays', 'netFans', 'publishes', 'likes', 'comments', 'shares'] as const).map(key => {
          const value = row.metrics[key]
          return row.eachAvailable && value !== null ? formatCount(value, locale) : '—*'
        }),
      ]
      lines.push(`<tr>${cells.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    }
    lines.push('</tbody></table>')
    if (detail.ai !== null) {
      lines.push(`<h3>${esc(t('report.ai.title'))}</h3>`)
      if (detail.ai.summary !== null) lines.push(`<p>${esc(detail.ai.summary)}</p>`)
      const sections: [string, { title: string | null; detail: string | null; evidence: string | null }[]][] = [
        [t('report.ai.facts'), detail.ai.facts],
        [t('report.ai.inferences'), detail.ai.inferences],
        [t('report.ai.recommendations'), detail.ai.recommendations],
      ]
      for (const [title, items] of sections) {
        lines.push(`<details open><summary>${esc(title)}</summary>`)
        for (const item of items) {
          lines.push(`<p><strong>${esc(item.title ?? '')}</strong></p>`)
          if (item.detail !== null) lines.push(`<p>${esc(item.detail)}</p>`)
          if (item.evidence !== null) lines.push(`<p>${esc(t('report.ai.evidence', { text: item.evidence }))}</p>`)
        }
        lines.push('</details>')
      }
    }
  }
  lines.push('</div></body></html>')
  return lines.join('')
}
