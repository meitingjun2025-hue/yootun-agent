/**
 * 账号总览页（全宽三段，隐藏账号侧栏；布局对齐旧工作台）：当前账号选择器
 * （有可用账号即始终显示，不因单账号隐藏）→ 全部视频指标（固定 10 卡，时间窗
 * 可切）→ 关注者增长 | 关注者增长指标（趋势固定近 7 天，不随总览时间窗截断；
 * 指标固定 4 卡）→ 关注者画像（五维同屏，无维度 tab；性别 / 设备环形图，年龄
 * 柱状图，省市按人数降序 Top 5）。数据严格按 tools 真实字段消费
 * （metrics.totals.daily_* / fans_trend.totals + followerTotalCount /
 * fans_profile envelope）；页面可用性以服务端 availability 为准，缺失不补 0；
 * 账号 / 时间窗切换带请求代次守卫。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, ChartLegend, DataCard, DataState, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { formatCount, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  overviewFansHaveData, overviewTotalsHaveData, readFansProfile, readOverview, readOverviewAvailability,
  type FansProfileData, type OverviewAvailability, type OverviewData, type PortraitSlice,
} from './schema.ts'
import { ColumnChart, DonutChart, LineTrendChart, RankBars, type TrendRow } from './charts.tsx'
import { recentDays } from './works-format.ts'
import type { AccountRow } from './WorkbenchPage.tsx'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'partial'
type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d'
type Availability = 'ok' | 'partial' | 'no_data'

interface WindowTab { value: TimeWindow; label: string; id: string; panelId: string }

export interface OverviewPageProps {
  t: Translate
  localeTag: string
  accounts: AccountRow[]
  activeAccountId: string
  onSelectAccount: (accountId: string) => void
  /** 固定 last_7d 摘要（页面级拉取；关注者趋势固定 7 天口径的数据源）。 */
  summary: OverviewData | null
  summaryState: 'loading' | 'ready' | 'error'
  onRetrySummary: () => void
}

/** 服务端 availability 取值 → 卡片状态；缺失（null）回退 hasData 推导。 */
function serverState(value: string | null, hasData: boolean, fetchError: boolean): LoadState {
  if (fetchError) return 'error'
  if (value === 'partial') return 'partial'
  if (value === 'no_data') return 'empty'
  if (value === 'ok') return hasData ? 'ready' : 'empty'
  return hasData ? 'ready' : 'empty'
}

/** 全部视频指标固定 10 卡定义（labelKey，字段取 totals 同名投影）。 */
const METRIC_CARDS: readonly { labelKey: Parameters<Translate>[0]; field: keyof OverviewData['totals']; footnoteKey?: Parameters<Translate>[0] }[] = [
  { labelKey: 'col.play', field: 'playCount' },
  { labelKey: 'col.like', field: 'likeCount' },
  { labelKey: 'col.favorite', field: 'favoriteCount' },
  { labelKey: 'col.comment', field: 'commentCount' },
  { labelKey: 'col.share', field: 'shareCount' },
  { labelKey: 'col.forward', field: 'forwardCount' },
  { labelKey: 'col.follow', field: 'followCount', footnoteKey: 'metric.followHint' },
  { labelKey: 'metric.ringset', field: 'ringsetCount' },
  { labelKey: 'metric.statusRef', field: 'statusRefCount' },
  { labelKey: 'metric.statusCover', field: 'statusCoverCount' },
]

/** 关注者增长指标固定 4 卡定义（labelKey + fans_trend 取值函数）。 */
function fansCardValues(data: OverviewData | null): readonly { labelKey: Parameters<Translate>[0]; value: number | null }[] {
  return [
    { labelKey: 'fans.net', value: data?.fansTotals.netCount ?? null },
    { labelKey: 'fans.add', value: data?.fansTotals.addCount ?? null },
    { labelKey: 'fans.reduce', value: data?.fansTotals.reduceCount ?? null },
    { labelKey: 'fans.total', value: data?.followerTotalCount ?? null },
  ]
}

/** 省市分布取 Top 5（按人数降序；长尾不渲染成无限列表）。 */
function topSlices(slices: PortraitSlice[] | null): PortraitSlice[] {
  if (slices === null) return []
  return [...slices].sort((left, right) => right.count - left.count).slice(0, 5)
}

/** 账号总览页组件。 */
export function OverviewPage(props: OverviewPageProps): ReactNode {
  const t = props.t
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('last_7d')
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [availability, setAvailability] = useState<OverviewAvailability>({ accountMetrics: null, fansTrend: null, fansProfile: null })
  const [overviewError, setOverviewError] = useState(false)
  const [profile, setProfile] = useState<FansProfileData | null>(null)
  const [profileError, setProfileError] = useState(false)
  const [overviewState, setOverviewState] = useState<LoadState>('loading')
  const [followState, setFollowState] = useState<LoadState>('loading')
  const [profileState, setProfileState] = useState<LoadState>('loading')
  const loadSeqRef = useRef(0)

  const load = useCallback(async (accountId: string, win: TimeWindow): Promise<void> => {
    // 请求代次守卫：账号/时间窗快速切换时旧响应不得覆盖新选择。
    const seq = ++loadSeqRef.current
    setOverviewState('loading')
    setProfileState('loading')
    // 本次 run 的服务端 availability（overview 载荷携带，供画像卡复用）。
    let server: OverviewAvailability = { accountMetrics: null, fansTrend: null, fansProfile: null }
    try {
      const res = await hostAction('account.overview', { accountId, window: win })
      if (loadSeqRef.current !== seq) return
      const next = readOverview(res)
      server = readOverviewAvailability(res)
      setOverview(next)
      setAvailability(server)
      setOverviewError(false)
      // 两个源分开定态：视频指标按 account_metrics，关注变化按 fans_trend。
      setOverviewState(serverState(server.accountMetrics, overviewTotalsHaveData(next.totals), false))
      setFollowState(serverState(server.fansTrend, overviewFansHaveData(next), false))
    } catch {
      if (loadSeqRef.current !== seq) return
      setOverview(null)
      setAvailability({ accountMetrics: null, fansTrend: null, fansProfile: null })
      setOverviewError(true)
      setOverviewState('error')
      setFollowState('error')
    }
    try {
      const res = await hostAction('fans.profile.get', { accountId })
      if (loadSeqRef.current !== seq) return
      const data = readFansProfile(res, t)
      setProfile(data)
      setProfileError(false)
      // 画像源的 availability 在 account.overview 载荷上；缺失回退本地推导。
      setProfileState(serverState(
        server.fansProfile ?? (data !== null ? 'ok' : 'no_data'),
        data !== null,
        false,
      ))
    } catch {
      if (loadSeqRef.current !== seq) return
      setProfile(null)
      setProfileError(true)
      setProfileState('error')
    }
  }, [t])

  useEffect(() => {
    if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow)
  }, [props.activeAccountId, timeWindow, load])

  const retry = (): void => { if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow) }
  const pageAvailability = pageAvailabilityOf(availability, overviewError, profileError, overview, profile !== null)
  const totals = overview?.totals
  const trendHasData = (props.summary?.fansTrend.length ?? 0) > 0
  // 关注者趋势固定近 7 天：x 轴固定上海最近 7 个已完成日，缺失日断线不造 0。
  const trendRows: TrendRow[] = recentDays(7).map(day => {
    const point = props.summary?.fansTrend.find(row => row.day === day)
    return { day, values: { total: point?.followerTotalCount ?? null } }
  })
  // 加载态优先：切账号 / 切窗口后旧 availability 不再驱动图表呈现。
  const trendCardState = props.summaryState === 'loading'
    ? 'loading'
    : props.summaryState === 'error'
      ? 'error'
      : trendHasData ? 'ready' : 'empty'
  const portraitHasAny = profile !== null
  const portraitCardState = profileState === 'loading'
    ? 'loading'
    : chartState(serverState(availability.fansProfile, portraitHasAny, profileError), portraitHasAny)
  const windowTabs: readonly [WindowTab, ...WindowTab[]] = [
    { value: 'yesterday', label: t('overview.window.yesterday'), id: 'wx-win-yesterday', panelId: 'wx-panel-overview' },
    { value: 'last_7d', label: t('overview.window.last_7d'), id: 'wx-win-7d', panelId: 'wx-panel-overview' },
    { value: 'last_30d', label: t('overview.window.last_30d'), id: 'wx-win-30d', panelId: 'wx-panel-overview' },
  ]
  const windowLabel = t(`overview.window.${timeWindow}` as 'overview.window.yesterday')
  const locale = props.localeTag
  const portraitAria = (title: string, count: number): string => t('portrait.aria', { title, count })
  const barAria = (name: string, count: number, share: number): string => t('portrait.barAria', { name, count, share })
  const columnAria = (name: string, count: number, share: number): string => t('portrait.columnAria', { name, count, share })
  return (
    <div className={css.overviewBody}>
      {/* 当前账号选择器：有可用账号即始终显示，切账号只让三段数据进加载态。 */}
      {props.accounts.length > 0 && (
        <div className={css.toolbar}>
          <AccountSelect
            t={t}
            accounts={props.accounts}
            activeAccountId={props.activeAccountId}
            onSelect={props.onSelectAccount}
          />
          {/* 任一源仍在加载时不给结论性可用性（不得短暂伪成 no_data）。 */}
          {overviewState !== 'loading' && profileState !== 'loading' && (
            <span className={css.availability} data-kind={pageAvailability} role='status'>
              {t(`overview.availability.${pageAvailability}` as 'overview.availability.ok')}
            </span>
          )}
        </div>
      )}
      <DataState
        state={overviewState === 'ready' || overviewState === 'partial' || overviewState === 'empty' ? 'ready' : overviewState}
        shape='block'
        onRetry={retry}
      >
        {/* 第一段：全部视频指标（固定 10 卡，时间窗在标题行右侧）。 */}
        <section className={css.tabBody} aria-label={t('overview.section.metrics')}>
          <DataCard
            title={t('overview.section.metrics')}
            actions={<SegmentedTabs items={windowTabs} value={timeWindow} onChange={setTimeWindow} label={windowLabel} size='sm' />}
            state='ready'
          >
            <div className={css.kpiGrid}>
              {METRIC_CARDS.map(card => {
                const value = totals === undefined || totals === null ? null : totals[card.field]
                return (
                  <KpiCard
                    key={card.labelKey}
                    label={t(card.labelKey)}
                    value={formatCount(value)}
                    footnote={card.footnoteKey !== undefined ? t(card.footnoteKey) : windowLabel}
                    state={kpiState(overviewState, value)}
                    onRetry={retry}
                  />
                )
              })}
            </div>
            {availability.accountMetrics === 'no_data' && (
              <p className={css.sidebarHint} role='status'>{t('overview.metricsNoData')}</p>
            )}
          </DataCard>
        </section>
      </DataState>
      {/* 第二段：关注者增长 | 关注者增长指标（左右双卡；≥880 双列）。 */}
      <div className={css.growthGrid}>
        <ChartFrame
          title={t('chart.fansTrend')}
          ariaLabel={t('chart.fansTrendAria')}
          height={240}
          state={trendCardState}
          onRetry={props.onRetrySummary}
          legend={<ChartLegend items={[{ id: 'fans-total', label: t('chart.fansSeries'), color: '--yt-chart-1' }]} />}
          footnote={t('overview.dataSource')}
        >
          {trendHasData && (
            <LineTrendChart
              rows={trendRows}
              series={[{ key: 'total', label: t('chart.fansSeries'), color: '--yt-chart-1' }]}
              locale={locale}
              trendEmpty={t('chart.trendEmpty')}
            />
          )}
        </ChartFrame>
        <DataCard title={t('overview.section.growthCards')} state='ready' footnote={windowLabel}>
          <div className={css.kpiGrid4}>
            {fansCardValues(overview).map(card => (
              <KpiCard
                key={card.labelKey}
                label={t(card.labelKey)}
                value={formatCount(card.value)}
                state={kpiState(followState, card.value)}
                onRetry={retry}
              />
            ))}
          </div>
        </DataCard>
      </div>
      {/* 第三段：关注者画像（五维同屏，无维度 tab）。 */}
      <DataCard
        title={t('overview.section.portrait')}
        description={profile?.day !== null && profile?.day !== undefined ? t('overview.portraitAsOf', { day: profile.day }) : t('overview.portraitAsOfCurrent')}
        state={portraitCardState}
        onRetry={retry}
      >
        {portraitHasAny && profile !== null && (
          <>
            <div className={css.portraitGrid}>
              <PortraitCard title={t('portrait.gender')} fallback={t('portrait.dimMissing')}>
                {profile.gender !== null
                  ? <DonutChart slices={profile.gender} locale={locale} totalLabel={t('portrait.total')} title={t('portrait.gender')} aria={portraitAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard title={t('portrait.device')} fallback={t('portrait.dimMissing')}>
                {profile.device !== null
                  ? <DonutChart slices={profile.device} locale={locale} totalLabel={t('portrait.total')} title={t('portrait.device')} aria={portraitAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard title={t('portrait.age')} fallback={t('portrait.dimMissing')}>
                {profile.age !== null
                  ? <ColumnChart slices={profile.age} locale={locale} aria={columnAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
            </div>
            <div className={css.portraitGrid2}>
              <PortraitCard title={t('portrait.province')} fallback={t('portrait.dimMissing')}>
                {profile.province !== null
                  ? <RankBars slices={topSlices(profile.province)} locale={locale} aria={barAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard title={t('portrait.city')} fallback={t('portrait.dimMissing')}>
                {profile.city !== null
                  ? <RankBars slices={topSlices(profile.city)} locale={locale} aria={barAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
            </div>
          </>
        )}
      </DataCard>
    </div>
  )
}

/** 单维画像卡：小标题 + 图形或维度缺失文案。 */
function PortraitCard(props: { title: string; fallback: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.portraitCard}>
      <span className={css.portraitCardTitle}>{props.title}</span>
      {props.children}
    </div>
  )
}

/** 单维度缺失文案（真实缺失，不渲染空分布）。 */
function MissingDimension(props: { t: Translate }): ReactNode {
  return <p className={css.chartEmpty}>{props.t('portrait.dimMissing')}</p>
}

/** 账号选择：官方 Menu 单选（当前项 check），触发钮显示当前账号。 */
function AccountSelect(props: { t: Translate; accounts: AccountRow[]; activeAccountId: string; onSelect: (accountId: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const current = props.accounts.find(row => row.accountId === props.activeAccountId) ?? null
  const label = props.t('overview.accountLabel')
  return (
    <Menu
      open={open}
      anchor={(
        <Button
          variant='outline'
          size='sm'
          aria-haspopup='menu'
          aria-expanded={open}
          aria-label={`${props.t('overview.accountSwitch')}: ${current?.nickname ?? current?.accountId ?? ''}`}
          onClick={() => { setOpen(value => !value) }}
        >
          {current?.nickname ?? current?.accountId ?? label}
        </Button>
      )}
      items={props.accounts.map(row => ({ id: row.accountId, label: row.nickname ?? row.accountId }))}
      selectedId={props.activeAccountId === '' ? undefined : props.activeAccountId}
      onSelect={accountId => {
        setOpen(false)
        props.onSelect(accountId)
      }}
      onClose={() => { setOpen(false) }}
    />
  )
}

/** KPI 卡状态：加载/错误/服务端源状态优先，值缺失按 empty。 */
function kpiState(cardState: LoadState, value: number | null | undefined): LoadState {
  if (cardState === 'ready') return value === null || value === undefined ? 'empty' : 'ready'
  return cardState
}

/** 图表卡状态：partial 直通（DataState 呈现警告条 + 数据），空态归 empty。 */
function chartState(state: LoadState, hasData: boolean): LoadState {
  if (state === 'partial') return hasData ? 'partial' : 'empty'
  if (state === 'ready') return hasData ? 'ready' : 'empty'
  return state
}

/** 页面级 availability：以服务端三源为准，混合或失败按 partial（其余归纳）。 */
function pageAvailabilityOf(
  server: OverviewAvailability,
  overviewError: boolean,
  profileError: boolean,
  overview: OverviewData | null,
  profileLoaded: boolean,
): Availability {
  if (overviewError || profileError) return 'partial'
  const values = [
    server.accountMetrics ?? ((overview !== null && overviewTotalsHaveData(overview.totals)) ? 'ok' : 'no_data'),
    server.fansTrend ?? ((overview?.fansTrend.length ?? 0) > 0 ? 'ok' : 'no_data'),
    server.fansProfile ?? (profileLoaded ? 'ok' : 'no_data'),
  ]
  if (values.every(value => value === 'no_data')) return 'no_data'
  if (values.every(value => value === 'ok')) return 'ok'
  return 'partial'
}
