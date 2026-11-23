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
import { type ReactNode } from 'react'
import { Button, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState, ytChartStyle } from '@yootun/dsh-client-ui-kit'
import {
  EMPTY, formatCount, formatDateTime, formatDuration, formatPercent, formatSeconds,
  gapFieldLabel, gapReasonText, genderLabel, formatAgeBucket, retentionStatus,
  retentionStatusKey, type Translate,
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
  const retentionGapReason = work.data_gap !== null && typeof work.data_gap.retention_trend === 'object' && work.data_gap.retention_trend !== null
    ? String((work.data_gap.retention_trend as Record<string, unknown>).reason ?? '')
    : ''
  const retention = retentionStatus(detail?.retentionCurrent ?? null, retentionGapReason === '' ? null : retentionGapReason, work.publish_time)
  const retentionKey = retentionStatusKey(retention)
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
            <p className={css.detailTitle}>{work.title ?? work.work_id}</p>
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
                        <li key={sourceRow.name} className={css.barRow}>
                          <span className={css.barLabel} title={sourceRow.name}>{sourceRow.name}</span>
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
              {retention === 'ok'
                ? <RetentionCurves points={detail?.retentionCurrent} />
                : retentionKey !== null
                  ? <p className={css.chartEmpty} role='status'>{t(retentionKey)}</p>
                  : null}
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
function RetentionCurves(props: { points: unknown }): ReactNode {
  const record = props.points
  if (record === null || typeof record !== 'object') return null
  const current = Array.isArray((record as { current?: unknown }).current) ? (record as { current: unknown[] }).current : []
  const similar = Array.isArray((record as { similar?: unknown }).similar) ? (record as { similar: unknown[] }).similar : []
  if (current.length === 0) return null
  const pointOf = (entry: unknown): { time: string; pct: number | null } | null => {
    if (typeof entry !== 'object' || entry === null) return null
    const row = entry as Record<string, unknown>
    // 曲线点形状 = {key: 时间(秒/MM:SS), value: 0..100}（parseRealtimeTrend /
    // buildTrendBlock 同族；真机 2026-11-23：读 time_s/pct 系字段恒空）。
    const time = typeof row.key === 'string' ? row.key : null
    if (time === null) return null
    const value = typeof row.value === 'number' ? row.value : null
    return { time, pct: value === null ? null : Math.max(0, Math.min(100, value)) }
  }
  const rows = current.map(pointOf).filter((point): point is { time: string; pct: number | null } => point !== null)
  const similarRows = similar.map(pointOf).filter((point): point is { time: string; pct: number | null } => point !== null)
  const similarByTime = new Map(similarRows.map(point => [point.time, point.pct]))
  const max = Math.max(1, ...rows.map(point => point.pct ?? 0))
  return (
    <ul className={css.barList}>
      {rows.map(point => (
        <li key={point.time} className={css.barRow}>
          <span className={css.barLabel}>{point.time}</span>
          <span className={css.barTrack}>
            {point.pct !== null && (
              <span className={css.barFill} style={{ width: `${Math.max((point.pct / max) * 100, 2)}%`, background: 'var(--yt-chart-1)' }} />
            )}
          </span>
          <span className={css.barCount}>
            {point.pct === null ? EMPTY : `${Math.round(point.pct * 10) / 10}%`}
            {similarByTime.has(point.time) && (
              <span className={css.barSub}> / {similarByTime.get(point.time) === null ? EMPTY : `${Math.round((similarByTime.get(point.time) as number) * 10) / 10}%`}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
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
