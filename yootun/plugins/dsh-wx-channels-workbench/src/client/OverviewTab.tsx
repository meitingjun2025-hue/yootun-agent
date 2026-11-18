/**
 * 总览页：账号选择 + 时间窗（yesterday / last_7d / last_30d）→ account.overview
 * KPI、粉丝增长趋势折线、粉丝画像分布；availability 驱动 ok / partial / no_data
 * 标注。数据严格按 tools 真实字段消费（daily_play_count / daily_like_count /
 * follower_net_count / fans_profile envelope）。
 * @module
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, ChartLegend, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { BarDistribution, TrendLineChart } from './charts.tsx'
import { formatCount, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  readFansProfile, readOverview, type FansProfileData, type OverviewData, type PortraitSlice,
} from './schema.ts'
import type { AccountRow } from './WorkbenchPage.tsx'

type LoadState = 'loading' | 'ready' | 'empty' | 'error'
type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d'
type Dimension = 'age' | 'gender' | 'province' | 'city' | 'device'
type Availability = 'ok' | 'partial' | 'no_data'

interface WindowTab { value: TimeWindow; label: string; id: string; panelId: string }
interface DimensionTab { value: Dimension; label: string; id: string; panelId: string }
interface DimensionTab { value: Dimension; label: string; id: string; panelId: string }

export interface OverviewTabProps {
  t: Translate
  accounts: AccountRow[]
  activeAccountId: string
  onSelectAccount: (accountId: string) => void
}

/** 总览页组件。 */
export function OverviewTab(props: OverviewTabProps): ReactNode {
  const t = props.t
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('last_7d')
  const [dimension, setDimension] = useState<Dimension>('age')
  const [overview, setOverview] = useState<OverviewData | null>(null)
  const [overviewState, setOverviewState] = useState<LoadState>('loading')
  const [profile, setProfile] = useState<FansProfileData | null>(null)
  const [profileState, setProfileState] = useState<LoadState>('loading')

  const load = useCallback(async (accountId: string, win: TimeWindow): Promise<void> => {
    setOverviewState('loading')
    setProfileState('loading')
    try {
      const res = await hostAction('account.overview', { accountId, window: win })
      const next = readOverview(res)
      setOverview(next)
      setOverviewState(overviewHasData(next) ? 'ready' : 'empty')
    } catch {
      setOverview(null)
      setOverviewState('error')
    }
    try {
      const res = await hostAction('fans.profile.get', { accountId })
      const data = readFansProfile(res)
      setProfile(data)
      setProfileState(data === null ? 'empty' : 'ready')
    } catch {
      setProfile(null)
      setProfileState('error')
    }
  }, [])

  useEffect(() => {
    if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow)
  }, [props.activeAccountId, timeWindow, load])

  const retry = (): void => { if (props.activeAccountId !== '') void load(props.activeAccountId, timeWindow) }
  const account = props.accounts.find(row => row.accountId === props.activeAccountId) ?? null
  const availability = availabilityOf(overviewState, profileState, overview)
  const totals = overview?.totals
  const trendPoints = (overview?.fansTrend ?? []).map(point => ({
    label: point.day,
    value: point.followerTotalCount,
    rows: [{ label: t('kpi.follow'), value: formatCount(point.followerNetCount) }],
  }))
  const slices: PortraitSlice[] = profile === null ? [] : profile[dimension] ?? []
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
        <label className={css.fieldLabel}>
          <span className={css.fieldText}>{t('overview.accountLabel')}</span>
          <select
            className={css.accountSelect}
            value={props.activeAccountId}
            aria-label={t('overview.accountLabel')}
            onChange={event => { props.onSelectAccount(event.target.value) }}
          >
            {props.accounts.map(row => (
              <option key={row.accountId} value={row.accountId}>{row.nickname ?? row.accountId}</option>
            ))}
          </select>
        </label>
        <SegmentedTabs items={windowTabs} value={timeWindow} onChange={setTimeWindow} label={windowLabel} size='sm' />
        <span className={css.availability} data-kind={availability} role='status'>
          {t(`overview.availability.${availability}`)}
        </span>
      </div>
      <div className={css.kpis}>
        <KpiCard label={t('kpi.play')} value={formatCount(totals?.dailyPlayCount ?? null)}
          state={kpiState(overviewState, totals?.dailyPlayCount)} footnote={windowLabel} onRetry={retry} />
        <KpiCard label={t('kpi.like')} value={formatCount(totals?.dailyLikeCount ?? null)}
          state={kpiState(overviewState, totals?.dailyLikeCount)} footnote={windowLabel} />
        <KpiCard label={t('kpi.follow')} value={formatCount(totals?.followerNetCount ?? null)}
          state={kpiState(overviewState, totals?.followerNetCount)} footnote={windowLabel} />
        <KpiCard label={t('kpi.works')}
          value={formatCount(totals?.workCount ?? account?.feedCount ?? null)}
          state={kpiState(overviewState, totals?.workCount ?? account?.feedCount ?? null)}
          footnote={windowLabel} />
      </div>
      <div className={css.chartGrid}>
        <ChartFrame
          title={t('chart.fansTrend')}
          height={240}
          state={chartState(overviewState, overview?.fansTrend.length ?? 0)}
          onRetry={retry}
          legend={<ChartLegend items={[{ id: 'fans-total', label: t('overview.fansTotal'), color: '--yt-chart-1' }]} />}
          footnote={t('overview.dataSource')}
        >
          {trendPoints.length > 0 && (
            <TrendLineChart points={trendPoints} seriesLabel={t('overview.fansTotal')} color='--yt-chart-1' />
          )}
        </ChartFrame>
        <ChartFrame
          title={t('chart.portrait')}
          height={240}
          state={chartState(profileState, slices.length)}
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

/** KPI 总量是否有任一真实值（fansTrend 行也算数据）。 */
function overviewHasData(overview: OverviewData | null): boolean {
  if (overview === null) return false
  const totals = overview.totals
  return totals.dailyPlayCount !== null || totals.dailyLikeCount !== null
    || totals.followerNetCount !== null || totals.workCount !== null
    || overview.fansTrend.length > 0
}

/** availability：任一源 error → partial；总量与趋势全空 → no_data；否则 ok。 */
function availabilityOf(overviewState: LoadState, profileState: LoadState, overview: OverviewData | null): Availability {
  if (overviewState === 'error' || profileState === 'error') return 'partial'
  if (!overviewHasData(overview)) return 'no_data'
  return 'ok'
}

/** KPI 卡状态：值缺失按 empty，源错误按 error。 */
function kpiState(source: LoadState, value: number | null | undefined): 'ready' | 'empty' | 'error' {
  if (source === 'error') return 'error'
  return value === null || value === undefined ? 'empty' : 'ready'
}

/** 图表卡状态：源错误 → error；无数据 → empty。 */
function chartState(source: LoadState, count: number): 'loading' | 'ready' | 'empty' | 'error' {
  if (source === 'loading') return 'loading'
  if (source === 'error') return 'error'
  return count > 0 ? 'ready' : 'empty'
}
