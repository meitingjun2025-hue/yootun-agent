/**
 * 作品详情 Modal（官方 Modal 基底 + 详情复合布局；对齐旧客户端的乐观打开）：
 * 双击立即用列表行数据渲染头部与核心指标（无整页骨架等待），work.get /
 * work.trend 在途时来源分布 / 观众留存 / 按日趋势各分区呈现轻量加载行，到达
 * 后替换为完整详情，失败保留行数据并给分区级重试。头部一行 = 封面 + 元信息
 * （ID / 发布时间 / 最近采集）→ 核心指标卡铺满 → 来源分布 | 观众留存左右双卡
 * → 按日数据近 7 天多指标趋势 → 数据缺口。Escape / 遮罩关闭与焦点回归由官方
 * Modal 承担。
 * @module
 */
import { type ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartLegend, DataState, KpiCard, ytChartStyle, type YtChartColor } from '@yootun/dsh-client-ui-kit'
import { formatCount, formatDateTime, formatPct, formatSeconds, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  CORE_GAP_FIELDS, gapFieldKey, type TrafficRow, type WorkDetailData, type WorkRow,
} from './schema.ts'
import { dailyTrendRows, sortTrafficRowsByValue } from './works-format.ts'
import { LineTrendChart, type TrendRow } from './charts.tsx'
import { WorkCover } from './WorkCover.tsx'

/** 按日趋势七系列（播放主系列压顶；色值全部来自集中 `--yt-chart-*` token）。 */
const DAILY_SERIES: readonly {
  key: keyof Omit<WorkDetailData['dailyRows'][number], 'day'>
  labelKey: Parameters<Translate>[0]
  color: YtChartColor
}[] = [
  { key: 'playCount', labelKey: 'col.play', color: '--yt-chart-1' },
  { key: 'likeCount', labelKey: 'col.like', color: '--yt-chart-2' },
  { key: 'favoriteCount', labelKey: 'col.favorite', color: '--yt-chart-5' },
  { key: 'commentCount', labelKey: 'col.comment', color: '--yt-chart-negative' },
  { key: 'shareCount', labelKey: 'col.share', color: '--yt-chart-4' },
  { key: 'forwardCount', labelKey: 'col.forward', color: '--yt-chart-6' },
  { key: 'followCount', labelKey: 'col.follow', color: '--yt-chart-3' },
]

export interface WorkDetailModalProps {
  t: Translate
  localeTag: string
  /** 触发行的作品行（乐观渲染基准：详情在途 / 失败时兜底展示）。 */
  row: WorkRow | null
  /** work.get 的完整详情（含 traffic_source / retention_trend / daily_metrics）。 */
  detail: WorkDetailData | null
  /** work.trend 顶层 snapshots 的补充主线（仅详情无按日数据时使用）。 */
  trendRows: TrendRow[]
  /** `loading` = 补充数据在途（乐观展示）；`ready` = 到达；`error` = 在途失败（保留行数据）。 */
  detailState: 'loading' | 'ready' | 'error'
  onRetry: () => void
  onClose: () => void
}

/** 作品详情 Modal 组件。 */
export function WorkDetailModal(props: WorkDetailModalProps): ReactNode {
  const t = props.t
  const row = props.row
  const detail = props.detail
  const detailState = props.detailState
  // 乐观基准：列表行数据始终可渲染（openDetail 以行打开，row 不为 null）；
  // work.get 到达且携带有效 work 时替换为详情版本。
  const arrived = detailState === 'ready'
  const work: WorkRow | null = arrived && detail !== null && detail.work !== null ? detail.work : row
  const dailyRows = arrived && detail !== null && detail.dailyRows.length > 0
    ? detail.dailyRows
    : arrived && props.trendRows.length > 0
      ? props.trendRows.map(day => ({
          day: day.day,
          playCount: day.values.playCount ?? null,
          likeCount: day.values.likeCount ?? null,
          favoriteCount: null,
          commentCount: null,
          shareCount: null,
          forwardCount: null,
          followCount: null,
        }))
      : []
  const trendData = work !== null ? dailyTrendRows(dailyRows, work.publishTime) : []
  const trendHasAny = trendData.some(line => DAILY_SERIES.some(series => line[series.key] !== null))
  const gaps = work !== null && work.dataGap !== null
    ? Object.entries(work.dataGap).filter(([field]) => CORE_GAP_FIELDS.has(field))
    : []
  return (
    <Modal
      open={row !== null}
      onClose={props.onClose}
      title={work?.title ?? work?.workId ?? t('works.detail')}
      closeLabel={t('work.close')}
      description={t('works.detailSubtitle')}
      className={css.detailDialog as string}
      contentClassName={css.detailContent as string}
    >
      {work !== null && (
        // Modal 经 portal 挂在 document.body 下，不继承页面根的集中图表变量；
        // 详情内的进度条与趋势线消费 --yt-chart-*，必须在自身根部重新下发。
        <div className={css.detailBody} style={ytChartStyle}>
          <div className={css.detailGrid}>
            <WorkCover
              key={`detail-cover:${work.workId}:${work.coverUrl ?? ''}`}
              t={t}
              coverUrl={work.coverUrl}
              durationS={work.durationS}
              size='large'
            />
            <div className={css.detailMeta}>
              <p className={css.detailMetaLine}>{t('detail.workId', { id: work.workId })}</p>
              <p className={css.detailMetaLine}>{t('detail.publishTime', { time: formatDateTime(work.publishTime) ?? '—' })}</p>
              <p className={css.detailMetaLine}>{t('detail.latestCollected', { time: formatDateTime(work.latestCollectedAt) ?? '—' })}</p>
            </div>
          </div>
          <div className={css.metricGrid}>
            <KpiCard label={t('col.completion')} value={formatPct(work.completionRatePct)} />
            <KpiCard label={t('col.avgDuration')} value={formatSeconds(work.avgPlayDurationS, t)} />
            <KpiCard label={t('col.play')} value={formatCount(work.playCount)} />
            <KpiCard label={t('col.like')} value={formatCount(work.likeCount)} />
            <KpiCard label={t('col.favorite')} value={formatCount(work.favoriteCount)} />
            <KpiCard label={t('col.comment')} value={formatCount(work.commentCount)} />
            <KpiCard label={t('col.share')} value={formatCount(work.shareCount)} />
            <KpiCard label={t('col.forward')} value={formatCount(work.forwardCount)} />
            <KpiCard label={t('col.follow')} value={formatCount(work.followCount)} />
            <KpiCard label={t('detail.metric.wecomClickCount')} value={formatCount(work.wecomLinkClickCount)} />
            <KpiCard label={t('detail.metric.wecomClickUv')} value={formatCount(work.wecomLinkClickUv)} />
            <KpiCard label={t('detail.metric.contactAddCount')} value={formatCount(work.wecomContactAddCount)} />
            <KpiCard label={t('detail.metric.contactAddUv')} value={formatCount(work.wecomContactAddUv)} />
          </div>
          <div className={css.twoColumn}>
            <section className={css.detailSection} aria-label={t('detail.traffic')}>
              <h4 className={css.detailSectionTitle}>{t('detail.traffic')}</h4>
              <DataState state={arrived ? 'ready' : detailState} shape='block' onRetry={props.onRetry}>
                {arrived && detail !== null && detail.trafficRows.length > 0
                  ? <TrafficBars t={t} rows={detail.trafficRows} />
                  : arrived
                    ? <p className={css.chartEmpty}>{t('detail.trafficEmpty')}</p>
                    : null}
              </DataState>
            </section>
            <section className={css.detailSection} aria-label={t('detail.retention')}>
              <h4 className={css.detailSectionTitle}>{t('detail.retention')}</h4>
              <DataState state={arrived ? 'ready' : detailState} shape='block' onRetry={props.onRetry}>
                {arrived && detail !== null && detail.retentionPoints.length > 0
                  ? <RetentionBars points={detail.retentionPoints} />
                  : arrived
                    ? <p className={css.chartEmpty}>{t('detail.retentionEmpty')}</p>
                    : null}
              </DataState>
            </section>
          </div>
          <section className={css.detailSection} aria-label={t('detail.daily')}>
            <h4 className={css.detailSectionTitle}>{t('detail.daily')}</h4>
            {arrived ? (
              trendHasAny
                ? (
                    <>
                      <ChartLegend items={DAILY_SERIES.map(series => ({ id: series.key, label: t(series.labelKey), color: series.color }))} />
                      <LineTrendChart
                        rows={trendData.map(line => ({
                          day: line.day,
                          values: {
                            playCount: line.playCount,
                            likeCount: line.likeCount,
                            favoriteCount: line.favoriteCount,
                            commentCount: line.commentCount,
                            shareCount: line.shareCount,
                            forwardCount: line.forwardCount,
                            followCount: line.followCount,
                          },
                        }))}
                        series={DAILY_SERIES.map(series => ({ key: series.key, label: t(series.labelKey), color: series.color }))}
                        locale={props.localeTag}
                        trendEmpty={t('detail.dailyEmpty')}
                      />
                    </>
                  )
                : <p className={css.chartEmpty}>{t('detail.dailyEmpty')}</p>
            ) : (
              <DataState state={detailState} shape='block' onRetry={props.onRetry} />
            )}
          </section>
          <section className={css.detailSection} aria-label={t('detail.gaps')}>
            <h4 className={css.detailSectionTitle}>{t('detail.gaps')}</h4>
            {gaps.length > 0
              ? (
                  <div className={css.gapList}>
                    {gaps.map(([field, gap]) => {
                      const reason = typeof gap === 'object' && gap !== null && 'reason' in gap
                        ? String((gap as Record<string, unknown>).reason ?? '')
                        : ''
                      const labelKey = gapFieldKey(field)
                      return (
                        <span key={field} className={css.gapBadge}>
                          {`${labelKey === null ? field : t(labelKey)} · ${gapReasonText(reason, t)}`}
                        </span>
                      )
                    })}
                  </div>
                )
              : <span className={css.gapBadge}>{t('detail.noGaps')}</span>}
          </section>
        </div>
      )}
    </Modal>
  )
}

/** 来源分布条形：按播放量降序（缺失沉底），缺失行数值显示占位。 */
function TrafficBars(props: { t: Translate; rows: TrafficRow[] }): ReactNode {
  const rows = sortTrafficRowsByValue(props.rows)
  const max = Math.max(1, ...rows.map(row => row.value ?? 0))
  return (
    <ul className={css.barList}>
      {rows.map(row => (
        <li key={row.name} className={css.barRow}>
          <span className={css.barLabel} title={row.name}>{row.name}</span>
          <span className={css.barTrack}>
            {row.value !== null && (
              <span className={css.barFill} style={{ width: `${Math.max((row.value / max) * 100, 2)}%`, background: 'var(--yt-chart-2)' }} />
            )}
          </span>
          <span className={css.barCount}>{formatCount(row.value)}</span>
        </li>
      ))}
    </ul>
  )
}

/** 留存条形：秒标签 + 整数百分比（缺失保留占位）。 */
function RetentionBars(props: { points: readonly { second: number; ratePct: number | null }[] }): ReactNode {
  const max = 100
  return (
    <ul className={css.barList}>
      {props.points.map(point => (
        <li key={point.second} className={css.barRow}>
          <span className={css.barLabel}>{`${point.second}s`}</span>
          <span className={css.barTrack}>
            {point.ratePct !== null && (
              <span className={css.barFill} style={{ width: `${Math.max((point.ratePct / max) * 100, 2)}%`, background: 'var(--yt-chart-1)' }} />
            )}
          </span>
          <span className={css.barCount}>{point.ratePct === null ? '—' : `${point.ratePct}%`}</span>
        </li>
      ))}
    </ul>
  )
}

/** 缺口 reason → 文案；未知 reason 原样透出（稳定码自解释）。 */
function gapReasonText(reason: string, t: Translate): string {
  switch (reason) {
    case 'not_exposed': return t('gap.reason.not_exposed')
    case 'FIELD_LENGTH_MISMATCH': return t('gap.reason.FIELD_LENGTH_MISMATCH')
    case 'TIME_SERIES_LENGTH_MISMATCH': return t('gap.reason.TIME_SERIES_LENGTH_MISMATCH')
    case 'unknown_source_type': return t('gap.reason.unknown_source_type')
    case '': return t('gap.reason.not_exposed')
    default: return reason
  }
}
