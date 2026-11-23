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
  retentionStatusKey, trafficSourceLabel, type RetentionStatus, type Translate,
} from './format.ts'
import css from './workbench.module.css'
import { DistributionBars, GenderRing, LineTrendChart, useMeasuredWidth, type LineRow } from './charts.tsx'
import { arrayOf, type WorkDetailView, type WorkRow } from './schema.ts'
import type { DouyinLocaleKey } from './locales.ts'

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
                retentionGapReason={dataGapReasonOf(work, 'retention_trend')}
                bounceGapReason={dataGapReasonOf(work, 'retention_bounce')}
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
/** 观看趋势曲线点（{key: "MM:SS" 或秒字符串, value: 0..100}）。 */
interface RtPoint {
  key: string
  value: number
}

/** 低谷区间（起止秒）。 */
interface RtValley {
  start: number
  end: number
}

/** "MM:SS" 时间 key（同类曲线按 key 定位时只认此格式，其余点位剔除不错位投影）。 */
const RT_MMSS = /^\d{1,2}:\d{2}$/u

const RT_HEIGHT = 168
const RT_PAD_X = 6
const RT_PAD_TOP = 16
/** 底部留白：X 轴刻度与低谷徽标都嵌在留白内，图卡总高与其他卡一致。 */
const RT_PAD_BOTTOM = 30
const RT_PLOT_BOTTOM = RT_HEIGHT - RT_PAD_BOTTOM - 8
const RT_TICK_Y = RT_HEIGHT - 26
const RT_BADGE_Y = 146
const RT_BADGE_TEXT_Y = 158
const RT_TIP_WIDTH = 132
const RT_TIP_HEIGHT = 74

/** 曲线归一（旧 validPoint 同构）：key 须为字符串、value 须为有限数；非法点剔除不入图。 */
function rtPointsOf(value: unknown): RtPoint[] {
  const rows: RtPoint[] = []
  for (const entry of arrayOf(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.key !== 'string' || typeof row.value !== 'number' || !Number.isFinite(row.value)) continue
    rows.push({ key: row.key, value: row.value })
  }
  return rows
}

/** 低谷区间归一：起止秒均为有限数才入图。 */
function rtValleysOf(value: unknown): RtValley[] {
  const rows: RtValley[] = []
  for (const entry of arrayOf(value)) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.start !== 'number' || typeof row.end !== 'number') continue
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end)) continue
    rows.push({ start: row.start, end: row.end })
  }
  return rows
}

/** 曲线块某字段（current / similar / valleys）；非对象块返回 undefined。 */
function rtFieldOf(block: unknown, field: string): unknown {
  return typeof block === 'object' && block !== null ? (block as Record<string, unknown>)[field] : undefined
}

/** 时间 key → 秒（"MM:SS" 或纯秒；无法解析按 0）。 */
function rtSeconds(key: string): number {
  const match = RT_MMSS.exec(key)
  return match !== null ? Number(match[1]) * 60 + Number(match[2]) : Number(key) || 0
}

/** 作品数据缺口某字段的 reason（data_gap[field].reason）；无缺口返回 null。 */
function dataGapReasonOf(work: WorkRow, field: string): string | null {
  const entry = work.data_gap === null ? undefined : work.data_gap[field]
  if (typeof entry !== 'object' || entry === null) return null
  const reason = (entry as Record<string, unknown>).reason
  return typeof reason === 'string' ? reason : null
}

/** 跳出视图缺口状态 → 词典键（与留存四态同构，文案为跳出专用）。 */
function bounceStatusKey(status: RetentionStatus): DouyinLocaleKey {
  if (status === 'request_failed') return 'detail.rt.bounceRequestFailed'
  if (status === 'not_exposed') return 'detail.rt.bounceNotExposed'
  if (status === 'not_ready') return 'detail.rt.bounceNotReady'
  return 'detail.rt.bounceNoData'
}

/**
 * 观看趋势（旧 RetentionTrend 同构）：留存分析 / 跳出分析双视图、当前作品实线 +
 * 同类作品虚线、低谷区间淡红带与轴下方红底白字徽标、悬停吸附浮层。留存视图 Y 轴
 * 固定 100/75/50/25，跳出视图 0..max 自适应。曲线取自主表 retention_trend /
 * retention_bounce 两列；缺口 reason 取自 data_gap 对应字段（四态与旧插件一致）。
 * @param props - 两条曲线原始值、各自缺口 reason、发布时间与翻译函数。
 * @returns 视图切换 + 曲线图 + 图例。
 */
function RetentionTrendView(props: {
  retentionTrend: unknown
  retentionBounce: unknown
  retentionGapReason: string | null
  bounceGapReason: string | null
  publishTime: string | null
  t: Translate
}): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<'retention' | 'bounce'>('retention')
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [setWrapNode, wrapWidth] = useMeasuredWidth(600)

  const status = retentionStatus(props.retentionTrend, props.retentionGapReason, props.publishTime)
  const bounceStatus = retentionStatus(props.retentionBounce, props.bounceGapReason, props.publishTime)
  const trend = props.retentionTrend
  const bounce = props.retentionBounce
  const current = rtPointsOf(rtFieldOf(trend, 'current'))
  if (status !== 'ok' || current.length === 0) {
    return (
      <p className={status === 'request_failed' ? css.formError : css.chartEmpty} role='status'>
        {t(retentionStatusKey(status) ?? 'retention.noData')}
      </p>
    )
  }
  const isBounce = tab === 'bounce'
  const bounceOk = bounceStatus === 'ok'

  const tabs = (
    <div className={css.rtTabs} role='group' aria-label={t('detail.rt.tabs')}>
      <button
        type='button'
        className={tab === 'retention' ? `${css.rtTab} ${css.rtTabActive}` : css.rtTab}
        aria-pressed={tab === 'retention'}
        onClick={() => { setTab('retention'); setHoverIndex(null) }}
      >
        {t('detail.rt.tabRetention')}
      </button>
      <button
        type='button'
        className={isBounce ? `${css.rtTab} ${css.rtTabActive}` : css.rtTab}
        aria-pressed={isBounce}
        onClick={() => { setTab('bounce'); setHoverIndex(null) }}
      >
        {t('detail.rt.tabBounce')}
      </button>
    </div>
  )
  // 跳出整体缺失/失败：切换按钮仍可用，图位呈现跳出的四态文案（独立状态）。
  if (isBounce && !bounceOk) {
    return (
      <div ref={setWrapNode}>
        {tabs}
        <p className={bounceStatus === 'request_failed' ? css.formError : css.chartEmpty} role='status'>
          {t(bounceStatusKey(bounceStatus))}
        </p>
      </div>
    )
  }

  const similar = rtPointsOf(rtFieldOf(trend, 'similar')).filter(point => RT_MMSS.test(point.key))
  const valleys = rtValleysOf(rtFieldOf(trend, 'valleys'))
  // 当前视图的曲线：留存视图读 retention_trend，跳出视图读 retention_bounce。
  const series = isBounce ? rtPointsOf(rtFieldOf(bounce, 'current')) : current
  const seriesSimilar = isBounce ? rtPointsOf(rtFieldOf(bounce, 'similar')).filter(point => RT_MMSS.test(point.key)) : similar

  const width = Math.max(320, wrapWidth)
  const plotTop = RT_PAD_TOP
  const plotBottom = RT_PLOT_BOTTOM
  const plotHeight = plotBottom - plotTop
  const round2 = (value: number): number => Math.round(value * 100) / 100
  const xOf = (index: number): number => round2(RT_PAD_X + (index / Math.max(1, series.length - 1)) * (width - RT_PAD_X * 2))
  // 时间轴总长取留存曲线末点（跳出与留存同接口同时轴）。
  const totalSeconds = Math.max(1, rtSeconds(current[current.length - 1]?.key ?? '0'))
  const xOfSeconds = (seconds: number): number => {
    const clamped = Math.min(totalSeconds, Math.max(0, seconds))
    return round2(RT_PAD_X + (clamped / totalSeconds) * (width - RT_PAD_X * 2))
  }
  const bounceValues = [...series, ...seriesSimilar].map(point => point.value)
  const bounceMax = isBounce && bounceValues.length > 0 ? Math.max(...bounceValues) : 0
  // 留存视图 Y 轴固定 100/75/50/25；跳出视图 0..max 自适应。
  const yOf = (value: number): number => round2(plotTop + (1 - Math.min(100, Math.max(0, value)) / 100) * plotHeight)
  const bounceYOf = (value: number): number => {
    const ratio = bounceMax > 0 ? Math.min(bounceMax, Math.max(0, value)) / bounceMax : 0
    return round2(plotTop + (1 - ratio) * plotHeight)
  }
  const yOfValue = isBounce ? bounceYOf : yOf

  // 当前曲线按采样序等分定位；同类曲线按自身时间 key 定位（防超长点堆到端点成伪曲线）。
  const linePoints = series.map((point, index) => `${xOf(index)},${yOfValue(point.value)}`).join(' ')
  const similarPoints = seriesSimilar.map(point => `${xOfSeconds(rtSeconds(point.key))},${yOfValue(point.value)}`).join(' ')
  const areaPoints = linePoints === '' ? '' : `${linePoints} ${xOf(series.length - 1)},${plotBottom} ${xOf(0)},${plotBottom}`
  const gridValues = isBounce ? [bounceMax, Math.round((bounceMax / 2) * 100) / 100, 0] : [100, 75, 50, 25]
  const gridYs = gridValues.map(yOfValue)
  const tickIndexes = series.length === 1
    ? [0]
    : [0, 1, 2, 3, 4].map(quarter => Math.round((quarter * (series.length - 1)) / 4))

  // 悬停浮层：鼠标 X 吸附最近采样点；同类点按时间秒差最小者就近匹配。
  const hoverPoint = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < series.length ? series[hoverIndex] : undefined
  const hoverNext = hoverIndex !== null && hoverIndex >= 0 ? series[hoverIndex + 1] : undefined
  let hoverSimilar: RtPoint | undefined
  if (hoverPoint !== undefined && seriesSimilar.length > 0) {
    const targetSeconds = rtSeconds(hoverPoint.key)
    hoverSimilar = [...seriesSimilar].sort((a, b) =>
      Math.abs(rtSeconds(a.key) - targetSeconds) - Math.abs(rtSeconds(b.key) - targetSeconds))[0]
  }
  const hoverX = hoverIndex !== null ? xOf(hoverIndex) : 0
  // 浮层跟随吸附点，右缘自动翻转防出界。
  const tipX = hoverX + RT_TIP_WIDTH + 12 > width - RT_PAD_X ? Math.max(RT_PAD_X, hoverX - RT_TIP_WIDTH - 12) : hoverX + 12
  const tipY = plotTop + 8
  const hoverTimeText = isBounce && hoverNext !== undefined && hoverPoint !== undefined
    ? `${hoverPoint.key}-${hoverNext.key}`
    : hoverPoint?.key ?? ''
  const hoverRowLabel = t(isBounce ? 'detail.rt.hoverBounce' : 'detail.rt.hoverRetention')

  const seriesFirst = series[0]
  const seriesLast = series[series.length - 1]
  const similarLast = seriesSimilar[seriesSimilar.length - 1]
  const ariaLabel = isBounce
    ? t('detail.rt.bounceAria', {
        current: seriesFirst === undefined ? '—' : formatPercent(seriesFirst.value),
        similar: seriesSimilar[0] === undefined ? '—' : formatPercent(seriesSimilar[0]?.value ?? 0),
      })
    : t('detail.rt.aria', {
        current: `${formatPercent(seriesFirst?.value ?? null)}→${formatPercent(seriesLast?.value ?? null)}`,
        similar: similarLast === undefined ? '—' : formatPercent(similarLast.value),
        valleys: String(valleys.length),
      })

  return (
    <div ref={setWrapNode}>
      {tabs}
      <svg
        className={css.rtSvg}
        viewBox={`0 0 ${width} ${RT_HEIGHT}`}
        role='img'
        aria-label={ariaLabel}
        onMouseMove={event => {
          if (series.length === 0) return
          const rect = event.currentTarget.getBoundingClientRect()
          const relX = ((event.clientX - rect.left) / rect.width) * width
          const scale = (width - RT_PAD_X * 2) / Math.max(1, series.length - 1)
          setHoverIndex(Math.max(0, Math.min(series.length - 1, Math.round((relX - RT_PAD_X) / scale))))
        }}
        onMouseLeave={() => { setHoverIndex(null) }}
      >
        {gridYs.map((gy, index) => (
          <line key={`grid-${index}`} className={css.rtGrid} x1={RT_PAD_X} y1={gy} x2={width - RT_PAD_X} y2={gy} />
        ))}
        {valleys.map((valley, index) => {
          const bandLeft = xOfSeconds(valley.start)
          const bandRight = xOfSeconds(valley.end)
          const centerX = Math.round((bandLeft + bandRight) / 2)
          return (
            <g key={`valley-${index}`}>
              <rect className={css.rtValleyBand} x={bandLeft} y={plotTop} width={Math.max(2, bandRight - bandLeft)} height={plotBottom - plotTop} />
              <rect className={css.rtValleyBadge} x={centerX - 24} y={RT_BADGE_Y} width={48} height={16} rx={3} />
              <text className={css.rtValleyBadgeText} x={centerX} y={RT_BADGE_TEXT_Y} textAnchor='middle'>{t('detail.rt.valleyBadge')}{index + 1}</text>
            </g>
          )
        })}
        {areaPoints !== '' && <polygon className={css.rtArea} points={areaPoints} />}
        {similarPoints !== '' && <polyline className={`${css.rtSeg} ${css.rtSegDashed}`} points={similarPoints} />}
        {linePoints !== '' && <polyline className={css.rtSeg} points={linePoints} />}
        {tickIndexes.map((index, tickIndex) => (
          <text
            key={`x-${tickIndex}`}
            className={css.rtAxisText}
            x={xOf(index)}
            y={RT_TICK_Y}
            textAnchor={tickIndex === 0 ? 'start' : tickIndex === tickIndexes.length - 1 ? 'end' : 'middle'}
          >
            {series[index]?.key ?? ''}
          </text>
        ))}
        {gridValues.map((value, index) => (
          <text key={`y-${index}`} className={css.rtAxisText} x={RT_PAD_X + 2} y={(gridYs[index] ?? 0) - 3}>{`${value}%`}</text>
        ))}
        {hoverPoint !== undefined && (
          <g>
            <line className={css.rtHoverLine} x1={hoverX} y1={plotTop} x2={hoverX} y2={plotBottom} />
            <circle className={css.rtHoverDot} cx={hoverX} cy={yOfValue(hoverPoint.value)} r={4} />
            {hoverSimilar !== undefined && (
              <circle className={css.rtHoverDotSimilar} cx={xOfSeconds(rtSeconds(hoverSimilar.key))} cy={yOfValue(hoverSimilar.value)} r={3.5} />
            )}
            <g>
              <rect className={css.rtTooltipBox} x={tipX} y={tipY} width={RT_TIP_WIDTH} height={RT_TIP_HEIGHT} rx={8} />
              <text className={css.rtTooltipTime} x={tipX + 12} y={tipY + 22}>{hoverTimeText}</text>
              <circle className={css.rtHoverDot} cx={tipX + 16} cy={tipY + 40} r={4} />
              <text className={css.rtTooltipLabel} x={tipX + 26} y={tipY + 44}>{hoverRowLabel}</text>
              <text className={css.rtTooltipValue} x={tipX + RT_TIP_WIDTH - 12} y={tipY + 44} textAnchor='end'>{formatPercent(hoverPoint.value)}</text>
              {hoverSimilar !== undefined && (
                <>
                  <circle className={css.rtHoverDotSimilar} cx={tipX + 16} cy={tipY + 60} r={4} />
                  <text className={css.rtTooltipLabel} x={tipX + 26} y={tipY + 64}>{t('detail.rt.legendSimilar')}</text>
                  <text className={css.rtTooltipValue} x={tipX + RT_TIP_WIDTH - 12} y={tipY + 64} textAnchor='end'>{formatPercent(hoverSimilar.value)}</text>
                </>
              )}
            </g>
          </g>
        )}
      </svg>
      <ul className={css.rtLegend}>
        <li><span className={css.rtSwatchCurrent} />{t(isBounce ? 'detail.rt.legendBounce' : 'detail.rt.legendCurrent')}</li>
        {similarPoints !== '' && <li><span className={css.rtSwatchSimilar} />{t(isBounce ? 'detail.rt.legendBounceSimilar' : 'detail.rt.legendSimilar')}</li>}
        {valleys.length > 0 && <li><span className={css.rtSwatchValley} />{t('detail.rt.legendValley')}</li>}
      </ul>
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
