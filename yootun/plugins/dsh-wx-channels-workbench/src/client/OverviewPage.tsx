/**
 * 账号总览页（全宽，无账号侧栏）：当前账号选择器 + 数据区。数据严格按 tools
 * 真实字段消费（metrics.totals.daily_* / fans_trend.totals / fans_profile
 * envelope）；页面可用性以服务端 availability 为准，字段缺失回退本地推导；
 * 账号 / 时间窗切换带请求代次守卫。三段布局（全部视频指标 / 关注者增长 /
 * 关注者画像）在后续提交回正。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, ChartLegend, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { formatCount, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  overviewFansHaveData, overviewTotalsHaveData, readFansProfile, readOverview, readOverviewAvailability,
  type FansProfileData, type OverviewAvailability, type OverviewData, type PortraitSlice,
} from './schema.ts'
import { LineTrendChart, type TrendRow } from './charts.tsx'
import { recentDays } from './works-format.ts'
import type { AccountRow } from './WorkbenchPage.tsx'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'partial'
type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d'
type Dimension = 'age' | 'gender' | 'province' | 'city' | 'device'
type Availability = 'ok' | 'partial' | 'no_data'

interface WindowTab { value: TimeWindow; label: string; id: string; panelId: string }
interface DimensionTab { value: Dimension; label: string; id: string; panelId: string }

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

/** 账号总览页组件（骨架版）。 */
export function OverviewPage(props: OverviewPageProps): ReactNode {
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
  const account = props.accounts.find(row => row.accountId === props.activeAccountId) ?? null
  const pageAvailability = pageAvailabilityOf(availability, overviewError, profileError, overview, profile !== null)
  const totals = overview?.totals
  const trendHasData = (props.summary?.fansTrend.length ?? 0) > 0
  const trendRows: TrendRow[] = recentDays(7).map(day => {
    const point = props.summary?.fansTrend.find(row => row.day === day)
    return { day, values: { total: point?.followerTotalCount ?? null } }
  })
  const slices: PortraitSlice[] = profile === null ? [] : profile[dimension] ?? []
  // 加载态优先：账号/时间窗切换后旧 availability 不再驱动图表呈现。
  const trendCardState = props.summaryState === 'loading'
    ? 'loading'
    : props.summaryState === 'error'
      ? 'error'
      : trendHasData ? 'ready' : 'empty'
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
  const windowLabel = t(`overview.window.${timeWindow}` as 'overview.window.yesterday')
  return (
    <div className={css.tabBody}>
      <div className={css.toolbar}>
        <AccountSelect
          t={t}
          accounts={props.accounts}
          activeAccountId={props.activeAccountId}
          onSelect={props.onSelectAccount}
        />
        <MenulessWindowTabs tabs={windowTabs} value={timeWindow} onChange={setTimeWindow} label={windowLabel} />
        {/* 任一源仍在加载时不给结论性可用性（不得短暂伪成 no_data）。 */}
        {overviewState !== 'loading' && profileState !== 'loading' && (
          <span className={css.availability} data-kind={pageAvailability} role='status'>
            {t(`overview.availability.${pageAvailability}` as 'overview.availability.ok')}
          </span>
        )}
      </div>
      <div className={css.kpis}>
        <KpiCard label={t('col.play')} value={formatCount(totals?.playCount ?? null)}
          state={kpiState(overviewState, totals?.playCount)} footnote={windowLabel} onRetry={retry} />
        <KpiCard label={t('col.like')} value={formatCount(totals?.likeCount ?? null)}
          state={kpiState(overviewState, totals?.likeCount)} footnote={windowLabel} />
        <KpiCard label={t('fans.net')} value={formatCount(overview?.fansTotals.netCount ?? null)}
          state={kpiState(followState, overview?.fansTotals.netCount)} footnote={windowLabel} />
        <KpiCard label={t('summary.worksTotal')}
          value={formatCount(totals?.workCount ?? account?.feedCount ?? null)}
          state={kpiState(overviewState, totals?.workCount ?? account?.feedCount ?? null)}
          footnote={windowLabel} />
      </div>
      <div className={css.chartGrid}>
        <ChartFrame
          title={t('chart.fansTrend')}
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
              locale={props.localeTag}
              trendEmpty={t('chart.trendEmpty')}
            />
          )}
        </ChartFrame>
        <ChartFrame
          title={t('portrait.age')}
          height={240}
          state={portraitCardState}
          onRetry={retry}
          legend={<ChartLegend items={[{ id: 'portrait-fans', label: t('portrait.total'), color: '--yt-chart-2' }]} />}
          footnote={t('overview.dataSource')}
        >
          {profile !== null && (
            <div className={css.portraitBody}>
              <DimensionTabs tabs={dimensionTabs} value={dimension} onChange={setDimension} label={t('portrait.age')} />
              <BarList slices={slices} />
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

/** 时间窗切换（骨架版临时形态；后续提交移到「全部视频指标」标题行）。 */
function MenulessWindowTabs(props: { tabs: readonly [WindowTab, ...WindowTab[]]; value: TimeWindow; onChange: (value: TimeWindow) => void; label: string }): ReactNode {
  return <SegmentedTabs items={props.tabs} value={props.value} onChange={props.onChange} label={props.label} size='sm' />
}

/** 画像维度切换（骨架版临时形态；后续提交改五维同屏）。 */
function DimensionTabs(props: { tabs: readonly [DimensionTab, ...DimensionTab[]]; value: Dimension; onChange: (value: Dimension) => void; label: string }): ReactNode {
  return <SegmentedTabs items={props.tabs} value={props.value} onChange={props.onChange} label={props.label} size='sm' />
}

/** 骨架版画像分布：按计数降序的简表（后续提交替换为环形/柱状/Top5）。 */
function BarList(props: { slices: readonly PortraitSlice[] }): ReactNode {
  const rows = [...props.slices].sort((left, right) => right.count - left.count)
  return (
    <ul className={css.barList}>
      {rows.map(row => (
        <li key={row.key} className={css.barRow} tabIndex={0} aria-label={`${row.label}: ${row.count}`}>
          <span className={css.barLabel}>{row.label}</span>
          <span className={css.barTrack}>
            <span className={css.barFill} style={{ width: '2%', background: 'var(--yt-chart-2)' }} />
          </span>
          <span className={css.barCount}>{formatCount(row.count)}</span>
        </li>
      ))}
    </ul>
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
