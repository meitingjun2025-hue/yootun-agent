/**
 * 报表详情正文（上移自抖音工作台 `ReportPage.tsx`，结构与文案不变）：报表头
 * meta（对比基准/KPI 口径/互动口径/作品口径/标注说明 + QualityBar）+ KPI 行
 * （涨红跌绿 ▲▼ + 上期值 + 无对比基准 flat）+ 趋势图（柱+线，缺采断开不补
 * 零，末位深色）+ 账号表（「—*」无快照口径；数据不带负责人时不渲染该列）+
 * 作品卡（按插件声明的 {@link ReportWorkLayout} 渲染主行/次要行/进度条，平台
 * 特有内容经 `renderWorkExtra` 注入）+ 异常列表 + AI 洞察三列（事实/推断/建议
 * + 展开完整依据 details）+ 数据不足态（信号清单 + 重新生成）。
 * @module
 */
import type { ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard } from '@yootun/dsh-client-ui-kit'
import { formatCount, formatDateTime, formatPercent, shiftDay } from './format.ts'
import css from './report.module.css'
import { ReportComboChart } from './report-chart.tsx'
import type { ReportTranslate } from './locales.ts'
import type { ReportDetail, ReportWork } from './schema.ts'
import type { ReportWorkLayout } from './report-page.tsx'

/** 周期标题（周报 end-1 闭区间；列表行、详情标题与导出共用同一口径）。 */
export function periodTitle(period: { reportType: string; periodStart: string | null; periodEnd: string | null }, t: ReportTranslate): string {
  const start = period.periodStart ?? ''
  if (period.reportType === 'weekly') {
    return `${t('report.weekly')} · ${start} ~ ${shiftDay(period.periodEnd ?? '', -1)}`
  }
  return `${t('report.daily')} · ${start}`
}

/** 缺采原因文案。 */
export function missingReasonText(reason: string | null, t: ReportTranslate): string {
  if (reason === 'session_expired') return t('report.missing.session_expired')
  if (reason === 'not_collected') return t('report.missing.not_collected')
  if (reason === 'no_data') return t('report.missing.no_data')
  return reason ?? t('report.missing.no_data')
}

/**
 * 渲染报表详情正文。
 * @param props.detail - 详情投影。
 * @param props.t - 报表词典翻译函数。
 * @param props.locale - 当前语言（数值格式化口径）。
 * @param props.errorText - 稳定码到文案（生成失败态的错误段落）。
 * @param props.work - 作品卡的指标布局（插件声明）。
 * @param props.renderWorkExtra - 作品卡扩展区；不传不渲染扩展内容。
 * @param props.onRegenerate - 「重新生成」入口（数据不足态的指引按钮）。
 * @returns 详情正文元素。
 */
export function ReportDetailBody(props: {
  detail: ReportDetail
  t: ReportTranslate
  locale: 'zh' | 'en'
  errorText: (code: string | null) => string
  work: ReportWorkLayout
  renderWorkExtra?: ((work: ReportWork) => ReactNode) | undefined
  onRegenerate: () => void
}): ReactNode {
  const t = props.t
  const detail = props.detail
  const weekly = detail.reportType === 'weekly'
  if (detail.status === 'insufficient') {
    const coverage = detail.data?.coverage ?? null
    const signals = coverage?.signals ?? { dailyRows: null, workSnapshotRows: null, fansProfileRows: null, periodWorks: null }
    const dailyMissing = coverage?.insufficientReason === 'daily_missing'
      || (signals.dailyRows === 0 && ((signals.workSnapshotRows ?? 0) > 0 || (signals.periodWorks ?? 0) > 0))
    return (
      <div className={css.reportInsufficient} role='status'>
        <p>{dailyMissing ? t('report.insufficient.daily') : t('report.insufficient.all')}</p>
        <ul className={css.signalList}>
          {([
            ['dailyRows', t('report.insufficient.dailyRows')],
            ['workSnapshotRows', t('report.insufficient.workSnapshotRows')],
            ['fansProfileRows', t('report.insufficient.fansProfileRows')],
            ['periodWorks', t('report.insufficient.periodWorks')],
          ] as const).map(([key, label]) => (
            <li key={key}>{t('report.insufficient.rows', { count: formatCount(signals[key] ?? null, props.locale) })} · {label}</li>
          ))}
        </ul>
        <Button variant='primary' size='sm' onClick={props.onRegenerate}>{t('report.regenerate')}</Button>
      </div>
    )
  }
  if (detail.data === null) {
    if (detail.status === 'pending' || detail.status === 'running') {
      return (
        <div className={css.reportWaiting} role='status'>
          <p className={css.emptyState}>{t('report.waitingTitle')}</p>
          <p className={css.inlineHint}>{t('report.waitingHint')}</p>
        </div>
      )
    }
    return (
      <div className={css.emptyState} role='status'>
        <p>{t('report.noContent')}</p>
        {detail.status === 'failed' && detail.errorCode !== null && (
          <p className={css.formError} role='alert'>{props.errorText(detail.errorCode)}</p>
        )}
      </div>
    )
  }
  const data = detail.data
  const coverage = data.coverage
  const start = detail.periodStart ?? ''
  const endText = weekly ? shiftDay(detail.periodEnd ?? '', -1) : ''
  const baseLine = weekly
    ? t('report.header.baseWeekly', { from: shiftDay(start, -7), to: shiftDay(start, -1) })
    : t('report.header.baseDaily', { day: shiftDay(start, -1) })
  // 负责人列随数据有无渲染：全部账号行都没有 ownerName 时不渲染该列（抖音
  // 数据带该字段，9 列不变；无负责人数据的投影为 8 列）。
  const hasOwnerColumn = data.accounts.some(row => row.ownerName !== null)
  return (
    <div className={css.reportBody}>
      <DataCard title={periodTitle(detail, t)} state='ready' footnote={t('report.header.generatedAt', { time: formatDateTime(data.generatedAt ?? detail.finishedAt), count: formatCount(coverage?.totalAccounts ?? null, props.locale) })}>
        <dl className={css.metaList}>
          <div className={css.metaRow}><dt>{t('report.header.base')}</dt><dd>{baseLine}</dd></div>
          <div className={css.metaRow}>
            <dt>{t('report.header.kpi')}</dt>
            <dd>{weekly ? t('report.header.kpiWeekly', { from: start, to: endText }) : t('report.header.kpiDaily', { day: start })}</dd>
          </div>
          <div className={css.metaRow}><dt>{t('report.header.interaction')}</dt><dd>{t('report.header.interactionText')}</dd></div>
          <div className={css.metaRow}><dt>{t('report.header.works')}</dt><dd>{t('report.header.worksText')}</dd></div>
          <div className={css.metaRow}><dt>{t('report.header.note')}</dt><dd>{t('report.header.noteText')}</dd></div>
        </dl>
        {coverage !== null && (
          <p className={css.qualityBar}>
            <span>{t('report.quality.covered', { covered: formatCount(coverage.coveredAccounts, props.locale), total: formatCount(coverage.totalAccounts, props.locale) })}</span>
            <span>{t('report.quality.lastCollected', { time: formatDateTime(coverage.lastCollectedAt) })}</span>
            {coverage.missingAccounts.length > 0 && (
              <span className={css.qualityMissing}>
                {t('report.quality.missing', {
                  list: coverage.missingAccounts
                    .map(item => `${item.nickname ?? item.accountId}（${missingReasonText(item.reason, t)}）`)
                    .join('、'),
                })}
              </span>
            )}
          </p>
        )}
      </DataCard>

      <div className={css.kpiRow}>
        {data.coreMetrics.map(metric => (
          <div key={metric.key} className={css.kpiTile}>
            <span className={css.metricLabel}>{metric.label ?? metric.key}</span>
            <strong className={css.kpiValue}>{metric.available ? (metric.key === 'interactionRate' ? formatPercent(metric.value) : formatCount(metric.value, props.locale)) : '—'}</strong>
            {metric.changePct !== null
              ? (
                <span className={`${css.kpiChange} ${metric.changePct > 0 ? css.deltaUp : metric.changePct < 0 ? css.deltaDown : ''}`}>
                  {`${weekly ? t('report.change.weekly') : t('report.change.daily')} ${metric.changePct > 0 ? '▲' : metric.changePct < 0 ? '▼' : ''}${Math.abs(metric.changePct).toFixed(1)}%`}
                  {metric.prevValue !== null ? ` · ${t('report.change.prev', { value: formatCount(metric.prevValue, props.locale) })}` : ''}
                </span>
              )
              : <span className={css.metricFootnote}>{`${weekly ? t('report.change.weekly') : t('report.change.daily')} ${t('report.change.noBase')}`}</span>}
            {metric.note !== null && <span className={css.metricFootnote}>{metric.note}</span>}
          </div>
        ))}
      </div>

      <div className={css.reportSection}>
      <DataCard title={weekly ? t('report.trend.weekly') : t('report.trend.daily')} state='ready' footnote={t('report.trend.gapText')}>
        <ReportComboChart
          days={data.trendSeries.days}
          bars={data.trendSeries.bars}
          line={data.trendSeries.line}
          barLabel={weekly ? t('report.trend.barWeekly') : t('report.trend.barDaily')}
          lineLabel={t('report.trend.lineNote')}
          tooltipLabel={t('report.trend.lineTip')}
          localeTag={props.locale}
        />
        <p className={css.inlineHint}>{`${t('report.trend.barNote')}：${weekly ? t('report.trend.barWeekly') : t('report.trend.barDaily')} · ${t('report.trend.lineNote')}：${weekly ? t('report.trend.lineWeekly') : t('report.trend.lineDaily')}`}</p>
      </DataCard>
      </div>

      <div className={css.reportSection}>
      <DataCard title={weekly ? t('report.accounts.weekly', { from: start, to: endText }) : t('report.accounts.daily', { day: start })} state='ready'>
        <div className={css.tableWrap} role='region' aria-label={t('report.col.account')} tabIndex={0}>
          <table className={css.dataTable} aria-label={t('report.col.account')}>
            <thead>
              <tr>
                {[t('report.col.account'), ...(hasOwnerColumn ? [t('report.col.owner')] : []), t('report.col.fans'), t('report.col.plays'),
                  t('report.col.netFans'), t('report.col.publishes'), t('report.col.likes'), t('report.col.comments'), t('report.col.shares')].map(label => <th key={label} scope='col'>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.accounts.map(row => (
                <tr key={row.accountId}>
                  <td className={`${css.cellMain} ${css.reportAccountName}`}>
                    {row.nickname ?? row.accountId}
                    {row.sessionStatus === 'expired' && <Tag tone='warning'>{t('report.mark.expired')}</Tag>}
                    {row.marks.map(mark => <span key={mark} className={css.reportMark}>{mark}</span>)}
                  </td>
                  {hasOwnerColumn && <td>{row.ownerName ?? '—'}</td>}
                  <td className={css.cellNum}>{formatCount(row.fanCount, props.locale)}</td>
                  {(['plays', 'netFans', 'publishes', 'likes', 'comments', 'shares'] as const).map(key => {
                    const value = row.metrics[key]
                    const missing = !row.eachAvailable || value === null
                    if (key === 'netFans' && !missing && value !== 0) {
                      return (
                        <td key={key} className={css.cellNum}>
                          <span className={value > 0 ? css.deltaUp : css.deltaDown}>
                            {`${value > 0 ? '+' : '−'}${formatCount(Math.abs(value as number), props.locale)}`}
                          </span>
                        </td>
                      )
                    }
                    return <td key={key} className={css.cellNum}>{missing ? '—*' : formatCount(value, props.locale)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataCard>
      </div>

      <div className={css.reportSection}>
      <DataCard
        title={weekly
          ? t('report.works.weekly', { count: data.works.length })
          : t('report.works.daily', { day: start, count: data.works.length })}
        state='ready'
      >
        {(data.worksOmittedCount ?? 0) > 0 && (
          <p className={css.inlineHint}>{t('report.works.omitted', { count: data.worksOmittedCount ?? 0, shown: data.works.length })}</p>
        )}
        {data.works.length === 0
          ? <p className={css.inlineHint}>{t('report.works.empty')}</p>
          : (
            <div className={css.workCards}>
              {data.works.map(work => <WorkCard key={work.workId} work={work} t={t} locale={props.locale} layout={props.work} renderExtra={props.renderWorkExtra} />)}
            </div>
          )}
      </DataCard>
      </div>

      {data.anomalies.length > 0 && (
        <DataCard title={t('report.anomaly.gap')} state='ready'>
          <ul className={css.alertList}>
            {data.anomalies.map((anomaly, index) => (
              <li key={index} className={css.alertItem} data-tone={anomaly.type === 'data_gap' ? 'gap' : 'business'}>
                <Tag tone={anomaly.type === 'data_gap' ? 'warning' : 'danger'}>
                  {anomaly.type === 'data_gap' ? t('report.anomaly.gap') : t('report.anomaly.business')}
                </Tag>
                <span>{anomaly.message ?? ''}</span>
              </li>
            ))}
          </ul>
        </DataCard>
      )}

      {detail.ai !== null && (
        <DataCard title={t('report.ai.title')} state='ready' description={detail.ai.summary ?? undefined}>
          <div className={css.insightGrid}>
            <section className={css.insightCol} data-tone='fact'>
              <h4>{t('report.ai.facts')}</h4>
              <ul className={css.insightList}>
                {detail.ai.facts.map((item, index) => <li key={index}>{item.title ?? ''}</li>)}
              </ul>
              <InsightDetails items={detail.ai.facts} t={t} />
              {detail.ai.limitations.length > 0 && (
                <details className={css.aiDetails} open>
                  <summary>{t('report.ai.limits')}</summary>
                  {detail.ai.limitations.map((limit, index) => <p key={index} className={css.inlineHint}>{limit}</p>)}
                </details>
              )}
            </section>
            <section className={css.insightCol} data-tone='infer'>
              <h4>{t('report.ai.inferences')}</h4>
              <ul className={css.insightList}>
                {detail.ai.inferences.map((item, index) => (
                  <li key={index}>
                    <span>{item.title ?? ''}</span>
                    <Tag tone={item.confidence === 'high' ? 'danger' : item.confidence === 'medium' ? 'warning' : 'neutral'}>
                      {item.confidence === 'high' ? t('report.ai.gradeHigh') : item.confidence === 'medium' ? t('report.ai.gradeMedium') : t('report.ai.gradeLow')}
                    </Tag>
                  </li>
                ))}
              </ul>
              <InsightDetails items={detail.ai.inferences} t={t} />
            </section>
            <section className={css.insightCol} data-tone='advice'>
              <h4>{t('report.ai.recommendations')}</h4>
              <ul className={css.insightList}>
                {detail.ai.recommendations.map((item, index) => (
                  <li key={index}>
                    <span>{item.title ?? ''}</span>
                    <Tag tone={item.priority === 'high' ? 'danger' : item.priority === 'medium' ? 'warning' : 'neutral'}>
                      {item.priority === 'high' ? t('report.ai.gradeHigh') : item.priority === 'medium' ? t('report.ai.gradeMedium') : t('report.ai.gradeLow')}
                    </Tag>
                  </li>
                ))}
              </ul>
              <InsightDetails items={detail.ai.recommendations} t={t} />
            </section>
          </div>
        </DataCard>
      )}
    </div>
  )
}

/** 次要指标值格式化（kind 由插件声明；秒数保留一位小数、缺失「—」）。 */
function secondaryValue(kind: 'count' | 'percent' | 'seconds', value: number | null, locale: 'zh' | 'en'): string {
  if (kind === 'count') return formatCount(value, locale)
  if (kind === 'percent') return formatPercent(value)
  return value === null ? '—' : String(Math.round(value * 10) / 10)
}

/**
 * 渲染单张作品卡：主行 4 计数、次要指标行（label + 空格 + 格式化值；秒数以
 * `s` 结尾，缺失整段显示「—」）、可选进度条与扩展区。次要行与进度条的文案
 * 与迁移前词典模板替换逐字一致。
 */
function WorkCard(props: {
  work: ReportWork
  t: ReportTranslate
  locale: 'zh' | 'en'
  layout: ReportWorkLayout
  renderExtra?: ((work: ReportWork) => ReactNode) | undefined
}): ReactNode {
  const { work, t, locale, layout } = props
  const progressValue = layout.progress === undefined ? null : work.metrics[layout.progress.key] ?? null
  return (
    <article className={css.workCard}>
      <header className={css.workCardHead}>
        <strong className={css.workCardTitle}>{work.title ?? work.workId}</strong>
        {work.isHot && <Tag tone='danger'>{t('report.work.hot')}</Tag>}
        <span className={css.workCardAccount}>{work.nickname ?? work.accountId ?? ''}</span>
      </header>
      <dl className={css.workCardMetrics}>
        {layout.primary.map(metric => (
          <div key={metric.key}><dt>{metric.label}</dt><dd>{formatCount(work.metrics[metric.key] ?? null, locale)}</dd></div>
        ))}
      </dl>
      <p className={css.workCardSecondary}>
        {layout.secondary.map(metric => {
          const value = work.metrics[metric.key] ?? null
          const formatted = secondaryValue(metric.kind, value, locale)
          const text = metric.kind === 'seconds'
            ? (value === null ? `—` : `${metric.label} ${formatted}s`)
            : `${metric.label} ${formatted}`
          return <span key={metric.key}>{text}</span>
        })}
      </p>
      {layout.progress !== undefined && progressValue !== null && (
        <span
          className={css.progressTrack}
          role='img'
          aria-label={`${layout.progress.label} ${formatPercent(progressValue)}`}
        >
          <span className={css.progressFill} style={{ width: `${Math.max(0, Math.min(100, progressValue))}%` }} />
        </span>
      )}
      {props.renderExtra?.(work)}
    </article>
  )
}

/** 洞察折叠依据（页面 details；导出全展开）。 */
function InsightDetails(props: {
  items: { title: string | null; detail: string | null; evidence: string | null }[]
  t: ReportTranslate
}): ReactNode {
  if (props.items.length === 0) return null
  return (
    <details className={css.aiDetails}>
      <summary>{props.t('report.ai.more')}</summary>
      {props.items.map((item, index) => (
        <div key={index} className={css.insightMoreItem}>
          <strong>{item.title ?? ''}</strong>
          {item.detail !== null && <p>{item.detail}</p>}
          {item.evidence !== null && <p className={css.inlineHint}>{props.t('report.ai.evidence', { text: item.evidence })}</p>}
        </div>
      ))}
    </details>
  )
}
