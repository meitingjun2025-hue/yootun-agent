/**
 * 总览页：账号选择 + 时间窗（yesterday / last_7d / last_30d）→ account.overview
 * KPI、粉丝增长趋势折线、粉丝画像分布。数据严格按 tools 真实字段消费
 * （metrics.totals.daily_play_count / daily_like_count /
 * fans_trend.totals.follower_net_count / fans_profile envelope）；页面可用性
 * 以服务端 availability（account_metrics / fans_trend / fans_profile）为准，
 * 字段缺失时回退本地推导；账号/时间窗切换带请求代次守卫。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, ChartLegend, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { BarDistribution, TrendLineChart } from './charts.tsx'
import { formatCount, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  readFansProfile, readOverview, readOverviewAvailability,
  type FansProfileData, type OverviewAvailability, type OverviewData, type PortraitSlice,
} from './schema.ts'
import type { AccountRow } from './WorkbenchPage.tsx'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'partial'
type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d'
type Dimension = 'age' | 'gender' | 'province' | 'city' | 'device'
type Availability = 'ok' | 'partial' | 'no_data'

interface WindowTab { value: TimeWindow; label: string; id: string; panelId: string }
interface DimensionTab { value: Dimension; label: string; id: string; panelId: string }

export interface OverviewTabProps {
  t: Translate
  accounts: AccountRow[]
  activeAccountId: string
  onSelectAccount: (accountId: string) => void
}

/** 服务端 availability 取值 → 卡片状态；缺失（null）回退 hasData 推导。 */
function serverState(value: string | null, hasData: boolean, fetchError: boolean): LoadState {
  if (fetchError) return 'error'
  if (value === 'partial') return 'partial'
  if (value === 'no_data') return 'empty'
  if (value === 'ok') return hasData ? 'ready' : 'empty'
  // 字段缺失：按本地数据推导。
  return hasData ? 'ready' : 'empty'
}

/** 总览页组件。 */
export function OverviewTab(props: OverviewTabProps): ReactNode {
  const t = props.t
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('last_7d')
  const [dimension, setDimension] = useState<Dimension>('age')
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
      // 三个源分开定态：播放/点赞/作品数按 account_metrics，关注变化按 fans_trend。
      setOverviewState(serverState(server.accountMetrics, metricsHasData(next), false))
      setFollowState(serverState(server.fansTrend, followHasData(next), false))
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
      const data = readFansProfile(res)
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
  }, [])

  useEffect(() => {
    if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow)
  }, [props.activeAccountId, timeWindow, load])

  const retry = (): void => { if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow) }
  const account = props.accounts.find(row => row.accountId === props.activeAccountId) ?? null
  const pageAvailability = pageAvailabilityOf(availability, overviewError, profileError, overview, profile !== null)
  const totals = overview?.totals
  const trendHasData = (overview?.fansTrend.length ?? 0) > 0
  const trendPoints = (overview?.fansTrend ?? []).map(point => ({
    label: point.day,
    value: point.followerTotalCount,
    rows: [{ label: t('kpi.follow'), value: formatCount(point.followerNetCount) }],
  }))
  const slices: PortraitSlice[] = profile === null ? [] : profile[dimension] ?? []
  // 加载态优先：账号/时间窗切换后旧 availability 不再驱动图表呈现。
  const trendCardState = overviewState === 'loading'
    ? 'loading'
    : chartState(serverState(availability.fansTrend, trendHasData, overviewError), trendHasData)
  const portraitCardState = profileState === 'loading'
    ? 'loading'
    : chartState(serverState(availability.fansProfile, profile !== null, profileError), slices.length > 0)
  const windowTabs: readonly [WindowTab, ...WindowTab[]] = [
    { value: 'yesterday', label: t('overview.window.yesterday'), id: 'wx-win-yesterday', panelId: 'wx-panel-overview' },
    { value: 'last_7d', label: t('overview.window.last_7d'), id: 'wx-win-7d', panelId: 'wx-panel-overview' },
    { value: 'last_30d', label: t('overview.window.last_30d'), id: 'wx-win-30d', panelId: 'wx-panel-overview' },
  ]
  const dimensionTabs: readonly [DimensionTab, ...DimensionTab[]] = [
    { value: 'age', label: t('portrait.age'), id: 'wx-dim-age', panelId: 'wx-panel-overview' },
    { value: 'gender', label: t('portrait.gender'), id: 'wx-dim-gender', panelId: 'wx-panel-overview' },
    { value: 'province', label: t('portrait.province'), id: 'wx-dim-province', panelId: 'wx-panel-overview' },
    { value: 'city', label: t('portrait.city'), id: 'wx-dim-city', panelId: 'wx-panel-overview' },
    { value: 'device', label: t('portrait.device'), id: 'wx-dim-device', panelId: 'wx-panel-overview' },
  ]
  const windowLabel = t(`overview.window.${timeWindow}`)
  return (
    <div className={css.tabBody}>
      <div className={css.toolbar}>
        <AccountSelect
          t={t}
          accounts={props.accounts}
          activeAccountId={props.activeAccountId}
          onSelect={props.onSelectAccount}
        />
        <SegmentedTabs items={windowTabs} value={timeWindow} onChange={setTimeWindow} label={windowLabel} size='sm' />
        {/* 任一源仍在加载时不给结论性可用性（不得短暂伪成 no_data）。 */}
        {overviewState !== 'loading' && profileState !== 'loading' && (
          <span className={css.availability} data-kind={pageAvailability} role='status'>
            {t(`overview.availability.${pageAvailability}`)}
          </span>
        )}
      </div>
      <div className={css.kpis}>
        <KpiCard label={t('kpi.play')} value={formatCount(totals?.dailyPlayCount ?? null)}
          state={kpiState(overviewState, totals?.dailyPlayCount)}
          footnote={windowLabel} onRetry={retry} />
        <KpiCard label={t('kpi.like')} value={formatCount(totals?.dailyLikeCount ?? null)}
          state={kpiState(overviewState, totals?.dailyLikeCount)} footnote={windowLabel} />
        <KpiCard label={t('kpi.follow')} value={formatCount(totals?.followerNetCount ?? null)}
          state={kpiState(followState, totals?.followerNetCount)} footnote={windowLabel} />
        <KpiCard label={t('kpi.works')}
          value={formatCount(totals?.workCount ?? account?.feedCount ?? null)}
          state={kpiState(overviewState, totals?.workCount ?? account?.feedCount ?? null)}
          footnote={windowLabel} />
      </div>
      <div className={css.chartGrid}>
        <ChartFrame
          title={t('chart.fansTrend')}
          height={240}
          state={trendCardState}
          onRetry={retry}
          legend={<ChartLegend items={[{ id: 'fans-total', label: t('overview.fansTotal'), color: '--yt-chart-1' }]} />}
          footnote={t('overview.dataSource')}
        >
          {trendHasData && (
            <TrendLineChart points={trendPoints} seriesLabel={t('overview.fansTotal')} color='--yt-chart-1' />
          )}
        </ChartFrame>
        <ChartFrame
          title={t('chart.portrait')}
          height={240}
          state={portraitCardState}
          onRetry={retry}
          legend={<ChartLegend items={[{ id: 'portrait-fans', label: t('portrait.fans'), color: '--yt-chart-2' }]} />}
          footnote={t('overview.dataSource')}
        >
          {profile !== null && (
            <div className={css.portraitBody}>
              <SegmentedTabs
                items={dimensionTabs}
                value={dimension}
                onChange={setDimension}
                label={t('chart.portrait')}
                size='sm'
              />
              <BarDistribution
                slices={slices}
                otherLabel={t('portrait.other')}
                shareLabel={t('portrait.share')}
                color='--yt-chart-2'
                otherColor='--yt-chart-6'
              />
            </div>
          )}
        </ChartFrame>
      </div>
    </div>
  )
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
          aria-label={`${label}: ${current?.nickname ?? current?.accountId ?? ''}`}
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

/** KPI 总量是否有任一真实值（fansTrend 行也算数据；页面级回退推导用）。 */
function overviewHasData(overview: OverviewData | null): boolean {
  if (overview === null) return false
  return metricsHasData(overview) || followHasData(overview)
}

/** account_metrics 源是否有数据：播放 / 点赞 / 作品数任一非 null。 */
function metricsHasData(overview: OverviewData): boolean {
  const totals = overview.totals
  return totals.dailyPlayCount !== null || totals.dailyLikeCount !== null || totals.workCount !== null
}

/** fans_trend 源是否有数据：关注变化非 null 或趋势日行非空。 */
function followHasData(overview: OverviewData): boolean {
  return overview.totals.followerNetCount !== null || overview.fansTrend.length > 0
}

/**
 * 页面级 availability：以服务端三源为准——全部 ok（或源缺失且本地有数据）且
 * 无请求失败 → ok；全部 no_data → no_data；其余（任一 partial / 请求失败 /
 * ok 与 no_data 混合）→ partial。
 */
function pageAvailabilityOf(
  server: OverviewAvailability,
  overviewError: boolean,
  profileError: boolean,
  overview: OverviewData | null,
  profileLoaded: boolean,
): Availability {
  if (overviewError || profileError) return 'partial'
  const values = [
    server.accountMetrics ?? (overviewHasData(overview) ? 'ok' : 'no_data'),
    server.fansTrend ?? ((overview?.fansTrend.length ?? 0) > 0 ? 'ok' : 'no_data'),
    server.fansProfile ?? (profileLoaded ? 'ok' : 'no_data'),
  ]
  if (values.every(value => value === 'no_data')) return 'no_data'
  if (values.every(value => value === 'ok')) return 'ok'
  return 'partial'
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
