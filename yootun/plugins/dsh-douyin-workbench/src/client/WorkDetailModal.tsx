/**
 * 作品详情 Modal（宽档 720；对齐旧弹层区块顺序冻结）：头部（封面/标题/
 * 发布时间·私密 Tag/最近采集/投流操作区 = 已投流 pill + 添加/更新 primary）
 * → 核心指标 8 卡 → 投流数据区（仅存在时 4 卡）→ 播放量趋势 7 天（缺口断线
 * 不补零）→ 流量与留存（流量来源分布条 + 观看趋势四状态：请求失败/未提供/
 * 未满 24h/暂无）→ 受众画像（性别环 token 色/年龄/地域/城市级别）→ 搜索词
 * 与热词 Tag → 数据缺口（五类 reason 文案）。跨账号显式携带 accountId；
 * Escape/焦点回归由官方 Modal 承担。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState, ytChartStyle } from '@yootun/dsh-client-ui-kit'
import {
  EMPTY, formatCount, formatDateTime, formatDuration, formatPercent, formatSeconds,
  gapFieldLabel, gapReasonText, genderLabel, formatAgeBucket, retentionStatus,
  retentionStatusKey, trafficSourceLabel, type Translate,
} from './format.ts'
import css from './workbench.module.css'
import { DistributionBars, GenderRing, LineTrendChart, type LineRow } from './charts.tsx'
import type { WorkDetailView, WorkRow } from './schema.ts'

/** 投流弹层打开数据（预填服务端字符串值）。 */
export interface PromotionModalData {
  accountId: string
  workId: string
  workTitle: string
  recordId: string | null
  playCount: string
  costAmount: string
  fansCount: string
  durationHours: string
}

export interface WorkDetailModalProps {
  t: Translate
  localeTag: string
  /** 打开目标（行数据乐观展示基准；跨账号下钻显式携带 accountId）。 */
  target: { accountId: string; row: WorkRow } | null
  detail: WorkDetailView | null
  detailState: 'loading' | 'ready' | 'error'
  trend: LineRow[]
  onRetry: () => void
  onClose: () => void
  onOpenPromotion: (data: PromotionModalData) => void
}

/** 作品详情 Modal 组件。 */
export function WorkDetailModal(props: WorkDetailModalProps): ReactNode {
  const t = props.t
  const target = props.target
  const arrived = props.detailState === 'ready' && props.detail !== null
  // 乐观基准：行数据始终可渲染；work.get 到达且携带有效 work 时替换。
  const work = arrived && props.detail?.work !== null && props.detail !== null
    ? props.detail.work
    : target?.row ?? null
  const detail = arrived ? props.detail : null
  if (target === null || work === null) return null
  const promotion = detail?.promotion ?? null
  const trendRows = props.trend.length > 0 ? props.trend : []
  const gaps = work.data_gap !== null ? Object.entries(work.data_gap) : []
  const duration = work.duration_s === null ? null : formatDuration(work.duration_s * 1000)

  const openPromotion = (): void => {
    props.onOpenPromotion({
      accountId: target.accountId,
      workId: work.work_id,
      workTitle: work.title ?? work.work_id,
      recordId: promotion !== null && promotion.id !== '' ? promotion.id : null,
      playCount: promotion?.playCount ?? '',
      costAmount: promotion?.costAmount ?? '',
      fansCount: promotion?.fansCount ?? '',
      durationHours: promotion?.durationHours ?? '',
    })
  }

  const coreCards: { label: string; value: ReactNode }[] = [
    { label: t('col.play'), value: formatCount(work.play_count) },
    { label: t('col.like'), value: formatCount(work.like_count) },
    { label: t('col.comment'), value: formatCount(work.comment_count) },
    { label: t('col.collect'), value: formatCount(work.collect_count) },
    { label: t('col.completion'), value: formatPercent(work.completion_rate_pct) },
    { label: t('col.bounce2s'), value: formatPercent(work.bounce_rate_2s_pct) },
    { label: t('col.fansGain'), value: fanGainNode(work.fans_gain_count, props.localeTag) },
    { label: t('col.duration'), value: formatSeconds(work.avg_watch_duration_s, t) },
  ]
  const promotionCards = promotion !== null
    ? [
        { label: t('promo.playCount'), value: formatCount(numberOfText(promotion.playCount)) },
        { label: t('promo.cost'), value: moneyText(promotion.costAmount) },
        { label: t('promo.fans'), value: formatCount(numberOfText(promotion.fansCount)) },
        { label: t('promo.hours'), value: hoursText(promotion.durationHours, t) },
      ]
    : []

  return (
    <Modal
      open={target !== null}
      onClose={props.onClose}
      title={work.title ?? work.work_id}
      closeLabel={t('work.close')}
      className={css.detailDialog as string}
      contentClassName={css.detailContent as string}
    >
      <div className={css.detailBody} style={ytChartStyle}>
        <div className={css.detailGrid}>
          <span className={`${css.cover} ${css.coverLarge}`} aria-hidden='true'>
            {work.cover_url !== null
              ? <img className={css.coverImg} src={work.cover_url} alt='' loading='lazy' referrerPolicy='no-referrer' />
              : t('cover.fallback')}
            {duration !== null && <span className={css.coverDuration}>{duration}</span>}
          </span>
          <div className={css.detailMeta}>
            <p className={css.detailMetaLine}>
              {t('detail.publishTime', { time: formatDateTime(work.publish_time) })}
              {work.visibility === 'not_in_list' && <Tag tone='warning'>{t('detail.private')}</Tag>}
            </p>
            <p className={css.detailMetaLine}>{t('detail.latestCollected', { time: formatDateTime(work.latest_collected_at) })}</p>
            <div className={css.detailPromoActions}>
              {promotion !== null && <Tag tone='danger'>{t('promotion.badge')}</Tag>}
              <Button variant='primary' size='sm' data-modal-autofocus='' onClick={openPromotion}>
                {promotion !== null ? t('detail.promotion.update') : t('detail.promotion.add')}
              </Button>
            </div>
          </div>
        </div>
        <section className={css.detailSection} aria-label={t('detail.section.core')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.core')}</h4>
          <div className={css.metricGrid}>
            {coreCards.map(card => (
              <div key={card.label} className={css.metricCard}>
                <span className={css.metricLabel}>{card.label}</span>
                <strong className={css.metricValue}>{card.value}</strong>
              </div>
            ))}
          </div>
        </section>
        {promotion !== null && (
          <section className={css.detailSection} aria-label={t('detail.section.promotion')}>
            <h4 className={css.detailSectionTitle}>{t('detail.section.promotion')}</h4>
            <div className={css.metricGrid}>
              {promotionCards.map(card => (
                <div key={card.label} className={css.metricCard}>
                  <span className={css.metricLabel}>{card.label}</span>
                  <strong className={css.metricValue}>{card.value}</strong>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className={css.detailSection} aria-label={t('detail.section.trend')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.trend')}</h4>
          {arrived
            ? (
              <LineTrendChart
                rows={trendRows}
                seriesLabel={t('col.play')}
                localeTag={props.localeTag}
                emptyText={t('trend.empty')}
                singleHint={t('trend.singleHint')}
              />
            )
            : <DataState state={props.detailState} shape='chart' onRetry={props.onRetry} />}
        </section>
        <section className={css.detailSection} aria-label={t('detail.section.traffic')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.traffic')}</h4>
          <div className={css.twoColumn}>
            <div className={css.detailSubBlock} aria-label={t('detail.traffic')}>
              <h5 className={css.detailSubTitle}>{t('detail.traffic')}</h5>
              <DataState state={arrived ? 'ready' : props.detailState} shape='rows' onRetry={props.onRetry}>
                {arrived && detail !== null && detail.trafficRows.length > 0
                  ? (
                    <ul className={css.barList}>
                      {detail.trafficRows.map(sourceRow => (
                        <li key={sourceRow.sourceKey} className={css.barRow}>
                          <span className={css.barLabel} title={trafficSourceLabel(sourceRow.sourceKey, sourceRow.label, t)}>{trafficSourceLabel(sourceRow.sourceKey, sourceRow.label, t)}</span>
                          <span className={css.barTrack}>
                            {sourceRow.value !== null && (
                              <span className={css.barFill} style={{ width: `${Math.min(100, (sourceRow.value / Math.max(1, ...detail.trafficRows.map(item => item.value ?? 0))) * 100)}%`, background: 'var(--yt-chart-2)' }} />
                            )}
                          </span>
                          <span className={css.barCount}>{sourceRow.value === null ? EMPTY : `${Math.round(sourceRow.value * 10) / 10}%`}</span>
                        </li>
                      ))}
                    </ul>
                  )
                  : arrived ? <p className={css.chartEmpty}>{t('traffic.noData')}</p> : null}
              </DataState>
            </div>
            <div className={css.detailSubBlock} aria-label={t('detail.retention')}>
              <h5 className={css.detailSubTitle}>{t('detail.retention')}</h5>
              <RetentionTrendView
                retentionTrend={detail?.retentionCurrent ?? null}
                retentionBounce={detail?.retentionBounce ?? null}
                publishTime={work.publish_time}
                t={t}
              />
            </div>
          </div>
        </section>
        <section className={css.detailSection} aria-label={t('detail.section.audience')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.audience')}</h4>
          <div className={css.audienceGrid}>
            <AudienceCard title={t('detail.gender')}>
              {detail?.audience.gender != null && detail !== null
                ? <GenderRing rows={detail.audience.gender} format={key => genderLabel(key, t)} />
                : <MissingDimension t={t} />}
            </AudienceCard>
            <AudienceCard title={t('detail.age')}>
              {detail?.audience.age != null && detail !== null
                ? <DistributionBars rows={detail.audience.age} format={key => formatAgeBucket(key, t)} localeTag={props.localeTag} />
                : <MissingDimension t={t} />}
            </AudienceCard>
            <AudienceCard title={t('detail.province')}>
              {detail?.audience.province != null && detail !== null
                ? <DistributionBars rows={detail.audience.province} format={key => key} localeTag={props.localeTag} />
                : <MissingDimension t={t} />}
            </AudienceCard>
            <AudienceCard title={t('detail.cityLevel')}>
              {detail?.audience.city_level != null && detail !== null
                ? <DistributionBars rows={detail.audience.city_level} format={key => key} localeTag={props.localeTag} />
                : <MissingDimension t={t} />}
            </AudienceCard>
          </div>
        </section>
        <section className={css.detailSection} aria-label={t('detail.section.words')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.words')}</h4>
          <div className={css.twoColumn}>
            <div className={css.detailSubBlock}>
              <h5 className={css.detailSubTitle}>{t('detail.searchKeywords')}</h5>
              <div className={css.tagList}>
                {detail !== null && detail.searchKeywords.length > 0
                  ? detail.searchKeywords.map(word => <Tag key={word}>{word}</Tag>)
                  : <span className={css.chartEmpty}>{t('detail.noSearch')}</span>}
              </div>
            </div>
            <div className={css.detailSubBlock}>
              <h5 className={css.detailSubTitle}>{t('detail.hotwords')}</h5>
              <div className={css.tagList}>
                {detail !== null && detail.hotwords.length > 0
                  ? detail.hotwords.map(word => <Tag key={word}>{word}</Tag>)
                  : <span className={css.chartEmpty}>{t('detail.noHotword')}</span>}
              </div>
            </div>
          </div>
        </section>
        <section className={css.detailSection} aria-label={t('detail.section.gaps')}>
          <h4 className={css.detailSectionTitle}>{t('detail.section.gaps')}</h4>
          {gaps.length > 0
            ? (
              <ul className={css.gapList}>
                {gaps.map(([field, info]) => {
                  const reason = typeof info === 'object' && info !== null && 'reason' in info
                    ? String((info as Record<string, unknown>).reason ?? '')
                    : ''
                  return <li key={field} className={css.gapBadge}>{`${gapFieldLabel(field, t)} · ${gapReasonText(reason, t)}`}</li>
                })}
              </ul>
            )
            : <span className={css.gapBadge}>{t('detail.noGaps')}</span>}
        </section>
      </div>
    </Modal>
  )
}

/** 观看趋势双曲线（current 主线；similar 辅线；文本即等价明细）。 */
/** 观看趋势曲线点。 */
interface RtPoint { key: string; value: number }

/** 归一曲线（剔除非法点）。 */
function rtPointsOf(value: unknown): RtPoint[] {
  if (!Array.isArray(value)) return []
  const rows: RtPoint[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const key = typeof row.key === 'string' && row.key !== '' ? row.key : null
    const val = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null
    if (key === null || val === null) continue
    rows.push({ key, value: Math.max(0, Math.min(100, val)) })
  }
  return rows
}

const RT_WIDTH = 680
const RT_HEIGHT = 168
const RT_PAD_X = 36
const RT_PAD_TOP = 12
const RT_PAD_BOTTOM = 26

/** 时间 key → 秒（"MM:SS" 或纯秒）。 */
function rtSeconds(key: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(key)
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number(key) || 0
}

/**
 * 观看趋势（旧 RetentionTrend 移植）：留存/跳出双 Tab + 双曲线（当前作品实线、
 * 同类作品虚线）+ 低谷区间粉带与徽标 + 悬停吸附浮层；Y 轴留存固定 100/75/50/25、
 * 跳出 0..max 自适应。数据取自主表 retention_trend 与 retention_bounce 列。
 */
function RetentionTrendView(props: {
  retentionTrend: unknown
  retentionBounce: unknown
  publishTime: string | null
  t: Translate
}): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<'retention' | 'bounce'>('retention')
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const trend = props.retentionTrend !== null && typeof props.retentionTrend === 'object'
    ? (props.retentionTrend as { current?: unknown; similar?: unknown; valleys?: unknown })
    : null
  const bounce = props.retentionBounce !== null && typeof props.retentionBounce === 'object'
    ? (props.retentionBounce as { current?: unknown; similar?: unknown; valleys?: unknown })
    : null
  const status = retentionStatus(trend, null, props.publishTime)
  if (status !== 'ok') {
    return <p className={css.chartEmpty} role='status'>{t(retentionStatusKey(status) ?? 'retention.noData')}</p>
  }
  const current = rtPointsOf(trend?.current)
  const similar = rtPointsOf(trend?.similar)
  const valleys = Array.isArray(trend?.valleys)
    ? (trend?.valleys as unknown[]).map(v => {
        if (typeof v !== 'object' || v === null) return null
        const row = v as Record<string, unknown>
        const start = typeof row.start === 'number' ? row.start : null
        const end = typeof row.end === 'number' ? row.end : null
        return start !== null && end !== null ? { start, end } : null
      }).filter((v): v is { start: number; end: number } => v !== null)
    : []
  const bounceCurrent = rtPointsOf(bounce?.current)
  const bounceSimilar = rtPointsOf(bounce?.similar)
  const bounceOk = bounceCurrent.length > 0
  const isBounce = tab === 'bounce'

  const hoverSource = isBounce ? bounceCurrent : current
  const hoverSimilarSource = isBounce ? bounceSimilar : similar
  const xOf = (index: number): number =>
    Math.round((RT_PAD_X + (index / Math.max(1, hoverSource.length - 1)) * (RT_WIDTH - RT_PAD_X * 2)) * 100) / 100
  const totalSeconds = Math.max(1, rtSeconds(hoverSource[hoverSource.length - 1]?.key ?? '0'))
  const xOfSeconds = (seconds: number): number =>
    Math.round((RT_PAD_X + (Math.min(totalSeconds, Math.max(0, seconds)) / totalSeconds) * (RT_WIDTH - RT_PAD_X * 2)) * 100) / 100
  const bounceMax = Math.max(1, ...bounceCurrent.map(point => point.value))
  const yOf = (value: number): number => {
    const clamped = Math.min(100, Math.max(0, value))
    return isBounce
      ? RT_PAD_TOP + (1 - clamped / bounceMax) * (RT_HEIGHT - RT_PAD_TOP - RT_PAD_BOTTOM)
      : RT_PAD_TOP + (1 - clamped / 100) * (RT_HEIGHT - RT_PAD_TOP - RT_PAD_BOTTOM)
  }
  const polylineOf = (rows: RtPoint[]): string => rows.map((point, index) => `${xOf(isBounce ? index : index)},${yOf(point.value)}`).join(' ')
  const tickIndexes = hoverSource.length === 1
    ? [0]
    : [0, 1, 2, 3, 4].map(quarter => Math.round((quarter * (hoverSource.length - 1)) / 4))
  const hoverPoint: RtPoint | null = hoverIndex !== null && hoverIndex < hoverSource.length
    ? hoverSource[hoverIndex] ?? null
    : null
  let hoverSimilarPoint: RtPoint | null = null
  if (hoverPoint !== null && hoverSimilarSource.length > 0) {
    const targetSeconds = rtSeconds(hoverPoint.key)
    hoverSimilarPoint = [...hoverSimilarSource].sort((a, b) =>
      Math.abs(rtSeconds(a.key) - targetSeconds) - Math.abs(rtSeconds(b.key) - targetSeconds))[0] ?? null
  }
  const hoverX = hoverPoint !== null ? xOf(hoverIndex ?? 0) : 0
  const tipWidth = 132
  const tipX = hoverPoint !== null
    ? (hoverX + tipWidth + 12 > RT_WIDTH - RT_PAD_X ? Math.max(RT_PAD_X, hoverX - tipWidth - 12) : hoverX + 12)
    : 0
  const tipY = RT_PAD_TOP + 8

  const ariaCurrent = hoverSource.length > 0 ? `${Math.round((hoverSource[0]?.value ?? 0) * 10) / 10}%→${Math.round((hoverSource[hoverSource.length - 1]?.value ?? 0) * 10) / 10}%` : '—'

  return (
    <div>
      <div className={css.rtTabs} role='tablist' aria-label={t('detail.rt.tabs')}>
        <button type='button' className={`${css.rtTab} ${tab === 'retention' ? css.rtTabActive : ''}`} aria-pressed={tab === 'retention'} onClick={() => { setTab('retention'); setHoverIndex(null) }}>
          {t('detail.rt.tabRetention')}
        </button>
        <button type='button' className={`${css.rtTab} ${isBounce ? css.rtTabActive : ''}`} aria-pressed={isBounce} onClick={() => { setTab('bounce'); setHoverIndex(null) }}>
          {t('detail.rt.tabBounce')}
        </button>
      </div>
      {isBounce && !bounceOk
        ? <p className={css.chartEmpty} role='status'>{t('analysis.dataInsufficient')}</p>
        : (
          <>
            <svg
              className={css.rtSvg}
              viewBox={`0 0 ${RT_WIDTH} ${RT_HEIGHT}`}
              role='img'
              aria-label={t('detail.rt.aria', { current: ariaCurrent, valleys: String(valleys.length) })}
              onMouseMove={event => {
                if (!hoverSource.length) return
                const rect = event.currentTarget.getBoundingClientRect()
                const relX = ((event.clientX - rect.left) / rect.width) * RT_WIDTH
                const scale = (RT_WIDTH - RT_PAD_X * 2) / Math.max(1, hoverSource.length - 1)
                setHoverIndex(Math.max(0, Math.min(hoverSource.length - 1, Math.round((relX - RT_PAD_X) / scale))))
              }}
              onMouseLeave={() => { setHoverIndex(null) }}
            >
              {[0, 1, 2, 3].map((_, index) => {
                const gy = RT_PAD_TOP + ((RT_HEIGHT - RT_PAD_TOP - RT_PAD_BOTTOM) * index) / 3
                return <line key={`grid-${index}`} x1={RT_PAD_X} y1={gy} x2={RT_WIDTH - RT_PAD_X} y2={gy} stroke='var(--yt-chart-grid)' />
              })}
              {valleys.map((valley, index) => {
                const bandLeft = xOfSeconds(valley.start)
                const centerX = (xOfSeconds(valley.start) + xOfSeconds(valley.end)) / 2
                return (
                  <g key={`valley-${index}`}>
                    <rect x={bandLeft} y={RT_PAD_TOP} width={Math.max(2, xOfSeconds(valley.end) - bandLeft)} height={RT_HEIGHT - RT_PAD_TOP - RT_PAD_BOTTOM} fill='color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent)' />
                    <rect x={centerX - 24} y={RT_HEIGHT - RT_PAD_BOTTOM - 4} width={48} height={16} rx={3} fill='var(--dsw-alias-state-error-primary)' />
                    <text x={centerX} y={RT_HEIGHT - RT_PAD_BOTTOM + 8} textAnchor='middle' fontSize='11' fill='var(--dsw-alias-label-primary)'>{t('detail.rt.valleyBadge')}{index + 1}</text>
                  </g>
                )
              })}
              {current.length > 1 && !isBounce && (
                <polygon points={`${current.map((point, index) => `${xOf(index)},${yOf(point.value)}`).join(' ')} ${xOf(current.length - 1)},${RT_HEIGHT - RT_PAD_BOTTOM} ${xOf(0)},${RT_HEIGHT - RT_PAD_BOTTOM}`} fill='var(--yt-chart-grid)' opacity={0.5} />
              )}
              {!isBounce && similar.length > 1 && (
                <polyline points={similar.map((point, index) => `${xOf(index)},${yOf(point.value)}`).join(' ')} fill='none' stroke='var(--dsw-alias-label-secondary)' strokeWidth={1.5} strokeDasharray='5 4' />
              )}
              {isBounce && bounceSimilar.length > 1 && (
                <polyline points={bounceSimilar.map((point, index) => `${xOf(index)},${yOf(point.value)}`).join(' ')} fill='none' stroke='var(--dsw-alias-label-secondary)' strokeWidth={1.5} strokeDasharray='5 4' />
              )}
              <polyline points={polylineOf(hoverSource)} fill='none' stroke='var(--dsw-alias-label-primary)' strokeWidth={1.8} />
              {tickIndexes.map((index, tickIndex) => (
                <text key={`x-${tickIndex}`} x={xOf(index)} y={RT_HEIGHT - 10} textAnchor={tickIndex === 0 ? 'start' : tickIndex === tickIndexes.length - 1 ? 'end' : 'middle'} fontSize='11' fill='var(--dsw-alias-label-secondary)'>
                  {(hoverSource[index] ?? { key: '' }).key}
                </text>
              ))}
              {(isBounce ? [bounceMax, Math.round((bounceMax / 2) * 100) / 100, 0] : [100, 75, 50, 25]).map((value, index) => {
                const gy = RT_PAD_TOP + ((RT_HEIGHT - RT_PAD_TOP - RT_PAD_BOTTOM) * index) / 3
                return <text key={`y-${index}`} x={RT_PAD_X - 6} y={gy - 3} textAnchor='end' fontSize='11' fill='var(--dsw-alias-label-secondary)'>{`${Math.round(value * 10) / 10}%`}</text>
              })}
              {hoverPoint !== null && (
                <g>
                  <line x1={hoverX} y1={RT_PAD_TOP} x2={hoverX} y2={RT_HEIGHT - RT_PAD_BOTTOM} stroke='var(--dsw-alias-label-tertiary)' strokeDasharray='3 3' />
                  <circle cx={hoverX} cy={yOf(hoverPoint.value)} r={4} fill='var(--yt-chart-1)' />
                  {hoverSimilarPoint !== null && (
                    <circle cx={xOfSeconds(rtSeconds(hoverSimilarPoint.key))} cy={yOf(hoverSimilarPoint.value)} r={3.5} fill='var(--dsw-alias-label-secondary)' />
                  )}
                  <g>
                    <rect x={tipX} y={tipY} width={132} height={74} rx={8} fill='var(--dsw-alias-bg-layer-1)' stroke='var(--dsw-alias-border-l1)' />
                    <text x={tipX + 12} y={tipY + 22} fontSize='12' fill='var(--dsw-alias-label-secondary)'>{hoverPoint.key}</text>
                    <circle cx={tipX + 16} cy={tipY + 40} r={4} fill='var(--yt-chart-1)' />
                    <text x={tipX + 26} y={tipY + 44} fontSize='12' fill='var(--dsw-alias-label-secondary)'>{t('detail.rt.legendCurrent')}</text>
                    <text x={tipX + 120} y={tipY + 44} textAnchor='end' fontSize='12' fill='var(--dsw-alias-label-primary)'>{`${Math.round(hoverPoint.value * 10) / 10}%`}</text>
                    {hoverSimilarPoint !== null && (
                      <>
                        <circle cx={tipX + 16} cy={tipY + 60} r={3.5} fill='var(--dsw-alias-label-secondary)' />
                        <text x={tipX + 26} y={tipY + 64} fontSize='12' fill='var(--dsw-alias-label-secondary)'>{t('detail.rt.legendSimilar')}</text>
                        <text x={tipX + 120} y={tipY + 64} textAnchor='end' fontSize='12' fill='var(--dsw-alias-label-primary)'>{`${Math.round(hoverSimilarPoint.value * 10) / 10}%`}</text>
                      </>
                    )}
                  </g>
                </g>
              )}
            </svg>
            <ul className={css.rtLegend}>
              <li><span className={css.rtSwatchCurrent} />{isBounce ? t('detail.rt.legendBounce') : t('detail.rt.legendCurrent')}</li>
              {hoverSimilarSource.length > 0 && <li><span className={css.rtSwatchSimilar} />{t('detail.rt.legendSimilar')}</li>}
              {valleys.length > 0 && <li><span className={css.rtSwatchValley} />{t('detail.rt.legendValley')}</li>}
            </ul>
          </>
        )}
    </div>
  )
}

/** 单维画像卡。 */
function AudienceCard(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.audienceCard}>
      <span className={css.audienceCardTitle}>{props.title}</span>
      {props.children}
    </div>
  )
}

/** 维度缺失文案（真实缺失，不渲染空分布）。 */
function MissingDimension(props: { t: Translate }): ReactNode {
  return <p className={css.chartEmpty}>{props.t('analysis.dataInsufficient')}</p>
}

/** 吸粉量节点（红涨绿跌 token）。 */
function fanGainNode(value: number | null, localeTag: string): ReactNode {
  if (value === null || value === 0) return <span>{EMPTY}</span>
  const text = value > 0 ? `+${formatCount(value, localeTag)}` : `-${formatCount(Math.abs(value), localeTag)}`
  return <span className={value > 0 ? css.deltaUp : css.deltaDown}>{text}</span>
}

/** 服务端字符串数值读取（缺失 null 不造 0）。 */
function numberOfText(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** 金额两位小数千分位。 */
function moneyText(value: string | null): string {
  const num = numberOfText(value)
  return num === null ? EMPTY : `¥${num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')}`
}

/** 时长两位小数 + 单位。 */
function hoursText(value: string | null, t: Translate): string {
  const num = numberOfText(value)
  return num === null ? EMPTY : `${num.toFixed(2)}${t('unit.hours')}`
}
