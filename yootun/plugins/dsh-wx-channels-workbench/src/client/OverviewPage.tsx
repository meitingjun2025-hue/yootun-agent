/**
 * 账号总览页（多账号数据汇总）：筛选条（账号 / 时间窗含自定义起止 / 排序 /
 * 会话状态，chips 可清除）→ 全部视频指标 10 卡 → 账号表现表（跨账号对比，行
 * 点击 / Enter 选中）→ 关注者总数趋势（跟随窗口，末日锚补足 7 天）| 增长指标
 * 4 卡 → 关注者画像（全部账号空态，单账号五维）。全部账号与单账号两种模式走
 * 同一数据通路（overview.accounts：全部不传 accountIds、单账号传
 * accountIds=[x]）；画像仅单账号模式拉取（fans.profile.get）。缺失不补 0；
 * 筛选键缓存（切回即时渲染 + 后台刷新）+ 请求代次与筛选键双重守卫；自定义
 * 日期空值不提交、越界纠偏只触发一次请求。
 * @module
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ChartFrame, ChartLegend, DataCard, DataState, FilterBar, FilterMenu, KpiCard,
} from '@yootun/dsh-client-ui-kit'
import type { FilterChip } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { formatCount, formatDateTime, formatDelta, shiftDay, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  readAccountsOverview, readFansProfile,
  type AccountsOverviewData, type AccountsOverviewRow, type AccountsOverviewTotals,
  type FansProfileData, type PortraitSlice,
} from './schema.ts'
import { ColumnChart, DonutChart, LineTrendChart, RankBars, type TrendRow } from './charts.tsx'
import { recentDays } from './works-format.ts'
import type { AccountRow } from './WorkbenchPage.tsx'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'partial'
/** 画像区状态（A.5：hidden = 全部账号模式不拉取画像）。 */
type ProfileState = 'loading' | 'ready' | 'empty' | 'error' | 'hidden'

export type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d' | 'custom'
export type OverviewSort = 'play' | 'like' | 'net_fans' | 'followers' | 'works'

/** 总览筛选态（页面级持有，切 tab 保留；B.3）。 */
export interface OverviewFilters {
  accountId: string
  window: TimeWindow
  /** null = 尚未初始化（首次切 custom 时填昨日）；'' = 用户清空（不提交）。 */
  customFrom: string | null
  customTo: string | null
  sort: OverviewSort
  sessionStatus: '' | 'ok' | 'expired'
}

/** 缺省筛选：全部账号 / last_7d / 按播放量 / 不过滤会话状态。 */
export const DEFAULT_OVERVIEW_FILTERS: OverviewFilters = {
  accountId: '', window: 'last_7d', customFrom: null, customTo: null, sort: 'play', sessionStatus: '',
}

export interface OverviewPageProps {
  t: Translate
  localeTag: string
  accounts: AccountRow[]
  filters: OverviewFilters
  onFiltersChange: (filters: OverviewFilters) => void
}

/** 全部视频指标固定 10 卡定义（labelKey + AccountsOverviewTotals 同名投影）。 */
const METRIC_CARDS: readonly { labelKey: Parameters<Translate>[0]; field: keyof AccountsOverviewTotals; footnoteKey?: Parameters<Translate>[0] }[] = [
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

/** 缓存条目上限（超出按插入顺序淘汰；A.6）。 */
const CACHE_LIMIT = 32

/** 筛选键（缓存键与竞态守卫共用；六段字符串，非 custom 时日期为空串）。 */
function filterKeyOf(filters: OverviewFilters): string {
  return [
    filters.accountId, filters.window, filters.customFrom ?? '', filters.customTo ?? '',
    filters.sort, filters.sessionStatus,
  ].join('|')
}

/** 筛选态 → host action 请求参数（A.3）：日期仅 custom 且两端齐备时透传。 */
function requestArgsOf(filters: OverviewFilters): Record<string, unknown> {
  const args: Record<string, unknown> = { window: filters.window, sort: filters.sort }
  if (filters.accountId !== '') args.accountId = filters.accountId
  if (filters.window === 'custom' && filters.customFrom !== null && filters.customTo !== null
    && filters.customFrom !== '' && filters.customTo !== '') {
    args.fromDay = filters.customFrom
    args.toDay = filters.customTo
  }
  if (filters.sessionStatus !== '') args.sessionStatus = filters.sessionStatus
  return args
}

/** custom 窗口两端是否齐备（任一为空不发请求，保留上次渲染数据）。 */
function customRangeComplete(filters: OverviewFilters): boolean {
  return filters.window !== 'custom'
    || (filters.customFrom !== null && filters.customTo !== null
      && filters.customFrom !== '' && filters.customTo !== '')
}

/** 汇总响应 → 页面状态（A.5：partial 有值为 partial；no_data / 空集为 empty）。 */
function overviewStateOf(data: AccountsOverviewData): LoadState {
  const { summary } = data
  if (summary.accountCount === 0) return 'empty'
  const metrics = summary.availability.accountMetrics
  const fans = summary.availability.fansTrend
  if (metrics === 'no_data' && fans === 'no_data') return 'empty'
  if (metrics === 'partial' || fans === 'partial') return 'partial'
  return 'ready'
}

/** 服务端 availability 取值 → 卡片状态（与旧单账号口径一致）。 */
function serverState(value: string | null, hasData: boolean, fetchError: boolean): LoadState {
  if (fetchError) return 'error'
  if (value === 'partial') return hasData ? 'partial' : 'empty'
  if (value === 'no_data') return 'empty'
  if (value === 'ok') return hasData ? 'ready' : 'empty'
  return hasData ? 'ready' : 'empty'
}

/** KPI 卡状态：加载/错误优先；partial 有值按 ready 直排，缺失按 empty。 */
function kpiState(cardState: LoadState, value: number | null | undefined): LoadState {
  if (cardState === 'ready' || cardState === 'partial') return value === null || value === undefined ? 'empty' : 'ready'
  return cardState
}

/** 图表卡状态：partial 有数据按 ready 呈现，空态归 empty。 */
function chartState(state: LoadState, hasData: boolean): LoadState {
  if (state === 'partial') return hasData ? 'ready' : 'empty'
  if (state === 'ready') return hasData ? 'ready' : 'empty'
  return state
}

/** 省市分布取 Top 5（按人数降序；长尾不渲染成无限列表）。 */
function topSlices(slices: PortraitSlice[] | null): PortraitSlice[] {
  if (slices === null) return []
  return [...slices].sort((left, right) => right.count - left.count).slice(0, 5)
}

/** 维度完整总数（占比分母：长尾截断后 share 仍按全量计算）。 */
function dimensionTotal(slices: PortraitSlice[]): number {
  return slices.reduce((sum, slice) => sum + slice.count, 0)
}

/** 取两日中较早者（字典序即日期序；空值让位）。 */
function minDay(left: string | null, right: string): string {
  return left !== null && left !== '' && left < right ? left : right
}

/** 账号总览页组件。 */
export function OverviewPage(props: OverviewPageProps): ReactNode {
  const t = props.t
  const filters = props.filters
  const [data, setData] = useState<AccountsOverviewData | null>(null)
  const [overviewState, setOverviewState] = useState<LoadState>('loading')
  const [profile, setProfile] = useState<FansProfileData | null>(null)
  const [profileState, setProfileState] = useState<ProfileState>('hidden')
  const [refreshing, setRefreshing] = useState(false)
  const seqRef = useRef(0)
  /** 发起请求时的筛选键：响应回来时筛选键已变即丢弃（A→B→A 快速切换防回写）。 */
  const requestKeyRef = useRef('')
  /** 筛选键 → 最近真实响应（切回即时渲染 + 后台刷新；仅内存）。 */
  const cacheRef = useRef(new Map<string, AccountsOverviewData>())
  /** 账号集合签名：新增 / 删除账号即视为缓存失效（A.6）。 */
  const accountsKeyRef = useRef('')
  const accountsKey = props.accounts.map(row => row.accountId).join(',')
  if (accountsKeyRef.current !== accountsKey) {
    accountsKeyRef.current = accountsKey
    cacheRef.current.clear()
  }

  const load = useCallback(async (current: OverviewFilters): Promise<void> => {
    const key = filterKeyOf(current)
    // custom 两端不齐备：不发请求，保留上次渲染（A.3 / B.6）。
    if (!customRangeComplete(current)) return
    const seq = ++seqRef.current
    requestKeyRef.current = key
    const cached = cacheRef.current.get(key)
    if (cached !== undefined) {
      // 同筛选键缓存命中：即时渲染缓存值（ready），后台刷新期间淡化。
      setData(cached)
      setOverviewState(overviewStateOf(cached))
      setRefreshing(true)
    } else {
      // 无缓存：清空已渲染值进 loading（旧筛选数值不得在新筛选名下展示）。
      setData(null)
      setOverviewState('loading')
    }
    const single = current.accountId !== ''
    setProfileState(single ? 'loading' : 'hidden')
    if (!single) setProfile(null)
    try {
      const res = await hostAction('overview.accounts', requestArgsOf(current))
      if (seqRef.current !== seq || requestKeyRef.current !== key) return
      const next = readAccountsOverview(res)
      cacheRef.current.set(key, next)
      while (cacheRef.current.size > CACHE_LIMIT) {
        const oldest = cacheRef.current.keys().next().value
        if (oldest === undefined) break
        cacheRef.current.delete(oldest)
      }
      setData(next)
      setOverviewState(overviewStateOf(next))
    } catch (error: unknown) {
      if (seqRef.current !== seq || requestKeyRef.current !== key) return
      // 失败丢已渲染值进 error，不保留陈旧数据（ACCOUNT_NOT_ACCESSIBLE 等同）。
      setData(null)
      setOverviewState('error')
    }
    if (!single) {
      setRefreshing(false)
      return
    }
    try {
      const res = await hostAction('fans.profile.get', { accountId: current.accountId })
      if (seqRef.current !== seq || requestKeyRef.current !== key) return
      const nextProfile = readFansProfile(res, t)
      setProfile(nextProfile)
      setProfileState(nextProfile !== null ? 'ready' : 'empty')
    } catch {
      if (seqRef.current !== seq || requestKeyRef.current !== key) return
      setProfile(null)
      setProfileState('error')
    } finally {
      if (seqRef.current === seq) setRefreshing(false)
    }
  }, [t])

  useEffect(() => {
    void load(filters)
  }, [filters, load])

  /** 单次筛选更新入口（联动纠偏在此完成，保证一次 setState 一次请求）。 */
  const updateFilters = useCallback((next: OverviewFilters): void => {
    props.onFiltersChange(next)
  }, [props])

  /** 会话状态筛选联动（B.3）：新状态与当前账号不符 → 账号重置为全部。 */
  const changeSessionStatus = useCallback((sessionStatus: OverviewFilters['sessionStatus']): void => {
    if (sessionStatus === '' || filters.accountId === '') {
      updateFilters({ ...filters, sessionStatus })
      return
    }
    const current = props.accounts.find(row => row.accountId === filters.accountId)
    const matches = current?.sessionStatus === sessionStatus
    updateFilters(matches ? { ...filters, sessionStatus } : { ...filters, accountId: '', sessionStatus })
  }, [filters, props.accounts, updateFilters])

  /** 账号筛选联动（B.3）：选中账号的会话状态与当前筛选不符 → 状态重置为全部。 */
  const changeAccountId = useCallback((accountId: string): void => {
    if (accountId === '' || filters.sessionStatus === '') {
      updateFilters({ ...filters, accountId })
      return
    }
    const picked = props.accounts.find(row => row.accountId === accountId)
    const matches = picked?.sessionStatus === filters.sessionStatus
    updateFilters(matches ? { ...filters, accountId } : { ...filters, accountId, sessionStatus: '' })
  }, [filters, props.accounts, updateFilters])

  /** 表格行选中（B.5）：账号筛选同步，会话状态不符重置（单次 setState）。 */
  const selectAccountFromRow = useCallback((row: AccountsOverviewRow): void => {
    changeAccountId(row.accountId)
  }, [changeAccountId])

  /** 自定义日期修改（B.3 联动）：越界纠偏 + 空值不提交，单次 setState。 */
  const applyCustomRange = useCallback((key: 'customFrom' | 'customTo', value: string): void => {
    if (value === '') {
      // 清空：受控值记为空串但不提交（不发请求），直到两端都合法才发。
      updateFilters({ ...filters, [key]: '' })
      return
    }
    if (key === 'customFrom') {
      // 修改起始致 from > to → 截止跟随为新起始。
      const customTo = filters.customTo !== null && filters.customTo !== '' && value > filters.customTo ? value : filters.customTo
      updateFilters({ ...filters, customFrom: value, customTo })
      return
    }
    // 修改截止致 to < from → 起始跟随为新截止。
    const customFrom = filters.customFrom !== null && filters.customFrom !== '' && value < filters.customFrom ? value : filters.customFrom
    updateFilters({ ...filters, customTo: value, customFrom })
  }, [filters, updateFilters])

  /** 时间窗切换（B.3）：custom 首次进入补昨日初值；切回枚举保留已填值。 */
  const changeWindow = useCallback((window: TimeWindow): void => {
    if (window !== 'custom') {
      updateFilters({ ...filters, window })
      return
    }
    const yesterday = recentDays(1)[0] ?? ''
    const customFrom = filters.customFrom === null || filters.customFrom === '' ? yesterday : filters.customFrom
    const customTo = filters.customTo === null || filters.customTo === '' ? yesterday : filters.customTo
    updateFilters({ ...filters, window, customFrom, customTo })
  }, [filters, updateFilters])

  const retry = (): void => { void load(filters) }
  const yesterday = recentDays(1)[0] ?? ''
  const windowLabel = filters.window === 'custom'
    ? t('overview.range.custom', { from: filters.customFrom ?? '', to: filters.customTo ?? '' })
    : t(`overview.window.${filters.window}` as 'overview.window.yesterday')

  const summary = data?.summary ?? null
  const singleRow = filters.accountId !== ''
    ? data?.rows.find(row => row.accountId === filters.accountId) ?? null
    : null
  // ① 10 卡数据源：单账号取该账号行 totals，全部账号取 summary.totals。
  const totals: AccountsOverviewTotals | null = singleRow !== null
    ? singleRow.totals
    : summary === null || summary.accountCount === 0 ? null : summary.totals
  const metricsAvailability = singleRow !== null
    ? singleRow.availability.accountMetrics
    : summary?.availability.accountMetrics ?? null
  const metricsHasData = totals !== null
    && (totals.playCount !== null || totals.likeCount !== null || totals.workCount !== null)
  const metricsState = overviewState === 'loading'
    ? 'loading'
    : overviewState === 'error'
      ? 'error'
      : serverState(metricsAvailability, metricsHasData, false)
  // ③ 4 卡数据源：单账号取该账号行，全部账号取 summary。
  const fansTotals = singleRow !== null ? singleRow.fansTotals : summary?.fansTotals ?? null
  const followerTotalCount = singleRow !== null ? singleRow.followerTotalCount : summary?.followerTotalCount ?? null
  const fansAvailability = singleRow !== null ? singleRow.availability.fansTrend : summary?.availability.fansTrend ?? null
  const fansHasData = fansTotals !== null
    && (fansTotals.netCount !== null || fansTotals.addCount !== null || fansTotals.reduceCount !== null || followerTotalCount !== null)
  const fansCardsState = overviewState === 'loading'
    ? 'loading'
    : overviewState === 'error'
      ? 'error'
      : serverState(fansAvailability, fansHasData, false)

  // ③ 趋势：按 summary.trendWindow 逐日对齐（不再固定近 7 天）；缺失日 null 断线。
  const trendStart = summary?.trendWindow.startDay ?? null
  const trendEnd = summary?.trendWindow.endDay ?? null
  const trendRows: TrendRow[] = useMemo(() => {
    if (trendStart === null || trendEnd === null) return []
    const rows: TrendRow[] = []
    let day = trendStart
    let guard = 0
    while (day <= trendEnd && guard < 100) {
      const point = summary?.trendDaily.find(row => row.day === day)
      rows.push({ day, values: { total: point?.followerTotalCount ?? null } })
      day = shiftDay(day, 1)
      guard += 1
    }
    return rows
  }, [summary])
  const trendHasData = trendRows.some(row => row.values.total !== null)
  const trendLabel = trendStart !== null && trendEnd !== null
    ? `${trendStart.slice(5)} – ${trendEnd.slice(5)}`
    : t('overview.window.last_7d')
  const trendAvailability = fansAvailability
  const trendPartial = fansAvailability === 'partial' && trendHasData
  const trendState = overviewState === 'loading'
    ? 'loading'
    : overviewState === 'error'
      ? 'error'
      : chartState(serverState(trendAvailability, trendHasData, false), trendHasData)

  // chips（B.3）：时间窗恒显示；账号 / 排序 / 会话状态按偏离缺省显示。
  const chips: FilterChip[] = []
  if (filters.accountId !== '') {
    const picked = props.accounts.find(row => row.accountId === filters.accountId)
    chips.push({
      id: 'account',
      label: t('overview.chip.account', { value: picked?.nickname ?? filters.accountId }),
      onClear: () => { changeAccountId('') },
    })
  }
  chips.push({
    id: 'window',
    label: t('overview.chip.window', { value: windowLabel }),
    onClear: () => {
      // 清除时间窗 chip → 回 last_7d 且清空自定义日期。
      updateFilters({ ...filters, window: 'last_7d', customFrom: null, customTo: null })
    },
  })
  if (filters.sort !== 'play') {
    chips.push({
      id: 'sort',
      label: t('overview.chip.sort', { value: t(`overview.sort.${filters.sort}` as 'overview.sort.play') }),
      onClear: () => { updateFilters({ ...filters, sort: 'play' }) },
    })
  }
  if (filters.sessionStatus !== '') {
    chips.push({
      id: 'session',
      label: t('overview.chip.session', { value: t(`overview.tag.session${filters.sessionStatus === 'ok' ? 'Ok' : 'Expired'}` as 'overview.tag.sessionOk') }),
      onClear: () => { changeSessionStatus('') },
    })
  }

  const accountItems = [
    { id: '', label: t('overview.filter.account.all') },
    ...props.accounts
      .filter(row => !row.isPending && row.deleteState !== 'remote_deleted')
      .map(row => ({ id: row.accountId, label: row.nickname ?? row.accountId })),
  ]
  const accountLabel = t('overview.filter.account')
  const windowItems = [
    { id: 'yesterday', label: t('overview.window.yesterday') },
    { id: 'last_7d', label: t('overview.window.last_7d') },
    { id: 'last_30d', label: t('overview.window.last_30d') },
    { id: 'custom', label: t('overview.window.custom') },
  ]
  const sortLabel = t('overview.filter.sort')
  const sortItems = (['play', 'like', 'net_fans', 'followers', 'works'] as const).map(id => ({
    id,
    label: t(`overview.sort.${id}` as 'overview.sort.play'),
  }))
  const sessionLabel = t('overview.filter.session')
  const sessionItems = [
    { id: '', label: t('overview.filter.session.all') },
    { id: 'ok', label: t('overview.tag.sessionOk') },
    { id: 'expired', label: t('overview.tag.sessionExpired') },
  ]
  const locale = props.localeTag
  const metricsHeading = singleRow !== null
    ? t('overview.section.singleAccount', { window: windowLabel })
    : t('overview.section.accountsCount', { count: summary?.accountTotal ?? data?.rows.length ?? 0 })
  const rows = data?.rows ?? []
  const noDataRowTag = (row: AccountsOverviewRow): boolean =>
    row.availability.accountMetrics === 'no_data' && row.availability.fansTrend === 'no_data'
  const netTone = (tone: 'up' | 'down' | 'flat'): string | undefined =>
    tone === 'up' ? css.deltaUp : tone === 'down' ? css.deltaDown : undefined
  const portraitAria = (title: string, count: number): string => t('portrait.aria', { title, count })
  const barAria = (name: string, count: number, share: number): string => t('portrait.barAria', { name, count, share })
  const columnAria = (name: string, count: number, share: number): string => t('portrait.columnAria', { name, count, share })

  return (
    <div className={css.overviewBody}>
      <FilterBar
        chips={chips}
        onClearAll={() => { props.onFiltersChange({ ...DEFAULT_OVERVIEW_FILTERS }) }}
      >
        <FilterMenu
          label={accountLabel}
          visibleLabel={accountLabel}
          currentLabel={filters.accountId === ''
            ? t('overview.filter.account.all')
            : props.accounts.find(row => row.accountId === filters.accountId)?.nickname ?? filters.accountId}
          items={accountItems}
          selectedId={filters.accountId}
          onSelect={changeAccountId}
        />
        <FilterMenu
          label={t('overview.filter.window')}
          visibleLabel={t('overview.filter.window')}
          currentLabel={windowLabel}
          items={windowItems}
          selectedId={filters.window}
          onSelect={id => { changeWindow(id as TimeWindow) }}
        />
        {filters.window === 'custom' && (
          <span className={css.customRange}>
            <input
              type='date'
              className={css.dateInput}
              aria-label={t('overview.filter.customFrom')}
              value={filters.customFrom ?? ''}
              max={minDay(filters.customTo, yesterday)}
              onChange={event => { applyCustomRange('customFrom', event.target.value) }}
            />
            <span className={css.customRangeDash} aria-hidden='true'>-</span>
            <input
              type='date'
              className={css.dateInput}
              aria-label={t('overview.filter.customTo')}
              value={filters.customTo ?? ''}
              min={filters.customFrom ?? undefined}
              max={yesterday}
              onChange={event => { applyCustomRange('customTo', event.target.value) }}
            />
          </span>
        )}
        <FilterMenu
          label={sortLabel}
          visibleLabel={sortLabel}
          currentLabel={t(`overview.sort.${filters.sort}` as 'overview.sort.play')}
          items={sortItems}
          selectedId={filters.sort}
          onSelect={id => { updateFilters({ ...filters, sort: id as OverviewSort }) }}
        />
        <FilterMenu
          label={sessionLabel}
          visibleLabel={sessionLabel}
          currentLabel={filters.sessionStatus === ''
            ? t('overview.filter.session.all')
            : t(`overview.tag.session${filters.sessionStatus === 'ok' ? 'Ok' : 'Expired'}` as 'overview.tag.sessionOk')}
          items={sessionItems}
          selectedId={filters.sessionStatus}
          onSelect={id => { changeSessionStatus(id as OverviewFilters['sessionStatus']) }}
        />
      </FilterBar>
      {/* ① 全部视频指标（固定 10 卡）。 */}
      <DataState
        state={metricsState === 'ready' || metricsState === 'partial' || metricsState === 'empty' ? 'ready' : metricsState}
        shape='block'
        onRetry={retry}
      >
        <section className={css.tabBody} aria-label={t('overview.section.metrics')}>
          <DataCard
            title={t('overview.section.metrics')}
            description={metricsHeading}
            state='ready'
            footnote={t('overview.dataSource')}
          >
            <div className={css.refreshDim} data-refreshing={refreshing || undefined}>
              <div className={css.kpiGrid}>
                {METRIC_CARDS.map(card => {
                  const value = totals === null ? null : totals[card.field]
                  return (
                    <KpiCard
                      key={card.labelKey}
                      label={t(card.labelKey)}
                      value={formatCount(value)}
                      footnote={card.footnoteKey !== undefined ? t(card.footnoteKey) : metricsHeading}
                      state={kpiState(metricsState, value)}
                      onRetry={retry}
                    />
                  )
                })}
              </div>
              {metricsState === 'empty' && (
                <p className={css.sidebarHint} role='status'>{t('overview.metricsNoData')}</p>
              )}
              {metricsState === 'partial' && (
                <p className={css.sidebarHint} role='status'>{t('overview.metricsPartial')}</p>
              )}
            </div>
          </DataCard>
        </section>
      </DataState>
      {/* ② 账号表现表（服务端已按 sort 排序；行点击 / Enter 选中账号）。 */}
      <DataCard
        title={t('overview.section.accounts')}
        description={t('overview.section.accountsCount', { count: summary?.accountCount ?? rows.length })}
        state='ready'
        footnote={t('overview.followersSumNote')}
      >
        {rows.length === 0 ? (
          <p className={css.sidebarHint}>{overviewState === 'loading' ? t('state.loading') : t('overview.empty.noAccounts')}</p>
        ) : (
          <div className={`${css.tableWrap} ${css.stickyFirstCols}`} role='region' aria-label={t('overview.section.accounts')} tabIndex={0}>
            <table className={css.accountTable} aria-label={t('overview.section.accounts')}>
              <thead>
                <tr>
                  <th scope='col' className={css.num}>{t('overview.col.rank')}</th>
                  <th scope='col'>{t('overview.col.account')}</th>
                  <th scope='col'><span className={css.num}>{t('overview.col.followers')}</span></th>
                  <th scope='col'><span className={css.num}>{t('overview.col.netFans')}</span></th>
                  <th scope='col'><span className={css.num}>{t('col.play')}</span></th>
                  <th scope='col'><span className={css.num}>{t('col.like')}</span></th>
                  <th scope='col'><span className={css.num}>{t('col.comment')}</span></th>
                  <th scope='col'><span className={css.num}>{t('col.share')}</span></th>
                  <th scope='col'><span className={css.num}>{t('overview.col.works')}</span></th>
                  <th scope='col'><span className={css.num}>{t('overview.col.lastCollected')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const selected = row.accountId === filters.accountId
                  const sessionTag = row.sessionStatus === 'ok'
                    ? { label: t('overview.tag.sessionOk'), tone: 'neutral' as const }
                    : row.sessionStatus === 'expired'
                      ? { label: t('overview.tag.sessionExpired'), tone: 'danger' as const }
                      : null
                  const net = formatDelta(row.fansTotals.netCount, locale)
                  return (
                    <tr
                      key={row.accountId}
                      tabIndex={0}
                      aria-selected={selected || undefined}
                      aria-current={selected || undefined}
                      aria-label={t('overview.row.selectAria', { name: row.nickname ?? row.accountId })}
                      className={selected ? css.rowSelected : undefined}
                      onClick={() => { selectAccountFromRow(row) }}
                      onKeyDown={event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          selectAccountFromRow(row)
                        }
                      }}
                    >
                      <td className={css.num}>{index + 1}</td>
                      <td>
                        <span className={css.accountCell}>
                          <span aria-hidden='true'>{(row.nickname ?? row.accountId).slice(0, 1)}</span>
                          <span>{row.nickname ?? row.accountId}</span>
                          {sessionTag !== null && <Tag tone={sessionTag.tone}>{sessionTag.label}</Tag>}
                          {noDataRowTag(row) && <Tag tone='warning'>{t('overview.row.noData')}</Tag>}
                        </span>
                      </td>
                      <td className={css.num}>{formatCount(row.followerTotalCount)}</td>
                      <td className={css.num}><span className={netTone(net.tone)}>{net.text}</span></td>
                      <td className={css.num}>{formatCount(row.totals.playCount)}</td>
                      <td className={css.num}>{formatCount(row.totals.likeCount)}</td>
                      <td className={css.num}>{formatCount(row.totals.commentCount)}</td>
                      <td className={css.num}>{formatCount(row.totals.shareCount)}</td>
                      <td className={css.num}>{formatCount(row.totals.workCount ?? row.feedCount)}</td>
                      <td className={css.num}>{formatDateTime(row.lastCollectedAt) ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </DataCard>
      {/* ③ 关注者总数趋势 | 增长指标 4 卡（≥1120 双列）。 */}
      <div className={css.growthGrid}>
        <ChartFrame
          title={`${t('chart.fansTrend')}（${trendLabel}）`}
          ariaLabel={t('chart.fansTrendAria')}
          height='fit'
          state={trendState}
          onRetry={retry}
          legend={<ChartLegend items={[{ id: 'fans-total', label: t('chart.fansSeries'), color: '--yt-chart-1' }]} />}
          footnote={trendPartial ? `${t('overview.dataSource')} · ${t('overview.metricsPartial')}` : t('overview.dataSource')}
        >
          {trendHasData && (
            <div className={css.refreshDim} data-refreshing={refreshing || undefined}>
              <LineTrendChart
                rows={trendRows}
                series={[{ key: 'total', label: t('chart.fansSeries'), color: '--yt-chart-1' }]}
                locale={locale}
                trendEmpty={t('chart.trendEmpty')}
              />
            </div>
          )}
        </ChartFrame>
        <DataCard title={t('overview.section.growthCards')} state='ready' footnote={windowLabel}>
          <div className={css.refreshDim} data-refreshing={refreshing || undefined}>
            <div className={css.kpiGrid4}>
              <KpiCard
                label={t('fans.net')}
                value={<span className={netTone(formatDelta(fansTotals?.netCount ?? null, locale).tone)}>{formatDelta(fansTotals?.netCount ?? null, locale).text}</span>}
                state={kpiState(fansCardsState, fansTotals?.netCount ?? null)}
                onRetry={retry}
              />
              <KpiCard label={t('fans.add')} value={formatCount(fansTotals?.addCount ?? null)} state={kpiState(fansCardsState, fansTotals?.addCount ?? null)} onRetry={retry} />
              <KpiCard label={t('fans.reduce')} value={formatCount(fansTotals?.reduceCount ?? null)} state={kpiState(fansCardsState, fansTotals?.reduceCount ?? null)} onRetry={retry} />
              <KpiCard label={t('fans.total')} value={formatCount(followerTotalCount)} state={kpiState(fansCardsState, followerTotalCount)} onRetry={retry} />
            </div>
          </div>
        </DataCard>
      </div>
      {/* ④ 关注者画像：全部账号空态；单账号五维（逻辑同旧单账号页）。 */}
      <DataCard
        title={t('overview.section.portrait')}
        description={profile?.day !== null && profile?.day !== undefined ? t('overview.portraitAsOf', { day: profile.day }) : t('overview.portraitAsOfCurrent')}
        state={profileState === 'ready' || profileState === 'empty' ? 'ready' : profileState === 'hidden' ? 'ready' : profileState}
      >
        {filters.accountId === '' ? (
          <p className={css.sidebarHint}>{t('overview.portrait.pickAccount')}</p>
        ) : profile !== null && (
          <div className={css.refreshDim} data-refreshing={refreshing || undefined}>
            <div className={css.portraitGrid}>
              <PortraitCard title={t('portrait.gender')}>
                {profile.gender !== null
                  ? <DonutChart slices={profile.gender} locale={locale} totalLabel={t('portrait.total')} title={t('portrait.gender')} aria={portraitAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard title={t('portrait.device')}>
                {profile.device !== null
                  ? <DonutChart slices={profile.device} locale={locale} totalLabel={t('portrait.total')} title={t('portrait.device')} aria={portraitAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard title={t('portrait.age')}>
                {profile.age !== null
                  ? <ColumnChart slices={profile.age} locale={locale} aria={columnAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
            </div>
            <div className={css.portraitGrid2}>
              <PortraitCard
                title={t('portrait.province')}
                {...(profile.province !== null ? { note: t('portrait.topNote', { top: Math.min(5, profile.province.length), total: profile.province.length }) } : {})}
              >
                {profile.province !== null
                  ? <RankBars slices={topSlices(profile.province)} total={dimensionTotal(profile.province)} locale={locale} aria={barAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
              <PortraitCard
                title={t('portrait.city')}
                {...(profile.city !== null ? { note: t('portrait.topNote', { top: Math.min(5, profile.city.length), total: profile.city.length }) } : {})}
              >
                {profile.city !== null
                  ? <RankBars slices={topSlices(profile.city)} total={dimensionTotal(profile.city)} locale={locale} aria={barAria} />
                  : <MissingDimension t={t} />}
              </PortraitCard>
            </div>
          </div>
        )}
      </DataCard>
    </div>
  )
}

/** 单维画像卡：标题行（小标题 + 截断说明）+ 图形或维度缺失文案。 */
function PortraitCard(props: { title: string; note?: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.portraitCard}>
      <span className={css.portraitCardTitleRow}>
        <span className={css.portraitCardTitle}>{props.title}</span>
        {props.note !== undefined && <span className={css.portraitCardNote}>{props.note}</span>}
      </span>
      {props.children}
    </div>
  )
}

/** 单维度缺失文案（真实缺失，不渲染空分布）。 */
function MissingDimension(props: { t: Translate }): ReactNode {
  return <p className={css.chartEmpty}>{props.t('portrait.dimMissing')}</p>
}
