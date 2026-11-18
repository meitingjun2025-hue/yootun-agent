/**
 * 作品页：works.list（服务端排序 + publishedFrom/publishedTo 上海已完成自然日
 * 窗口）+ 标题搜索（客户端）+ 行按钮 → work.get 详情 + work.trend 趋势折线
 * （顶层 snapshots）。长标题 ellipsis 且 aria-label 保留完整可访问名称；行有
 * 键盘路径（原生 button），打开详情后焦点移到详情标题；账号/排序/详情切换带
 * 请求代次守卫。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, ChartLegend, DataCard, FilterBar } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { TrendLineChart } from './charts.tsx'
import { formatCount, formatDateTime, shanghaiCompletedDay, type Translate } from './format.ts'
import css from './workbench.module.css'
import { readWorkDetail, readWorkRows, readWorkTrend, type WorkRow, type WorkTrendData } from './schema.ts'

type LoadState = 'loading' | 'ready' | 'empty' | 'error' | 'partial'
type SortKey = 'publish_time' | 'play_count'
type WindowKey = 'all' | 'yesterday' | 'last_7d' | 'last_30d'

interface SortTab { value: SortKey; label: string; id: string; panelId: string }
interface WindowTab { value: WindowKey; label: string; id: string; panelId: string }

export interface WorksTabProps {
  t: Translate
  activeAccountId: string
}

/** 时间窗 → 上海已完成自然日的 [from, to]（all 不传）；窗口含 yesterday。 */
function windowRange(win: Exclude<WindowKey, 'all'>): { publishedFrom: string; publishedTo: string } {
  return {
    publishedFrom: shanghaiCompletedDay(win === 'yesterday' ? 1 : win === 'last_7d' ? 7 : 30),
    publishedTo: shanghaiCompletedDay(1),
  }
}

/** 作品页组件。 */
export function WorksTab(props: WorksTabProps): ReactNode {
  const t = props.t
  const [sort, setSort] = useState<SortKey>('publish_time')
  const [win, setWin] = useState<WindowKey>('all')
  const [search, setSearch] = useState('')
  const [works, setWorks] = useState<WorkRow[]>([])
  const [worksState, setWorksState] = useState<LoadState>('loading')
  const [detail, setDetail] = useState<WorkRow | null>(null)
  const [detailWorkId, setDetailWorkId] = useState<string | null>(null)
  const [detailState, setDetailState] = useState<LoadState>('ready')
  const [trend, setTrend] = useState<WorkTrendData | null>(null)
  const [trendState, setTrendState] = useState<LoadState>('loading')
  const listSeqRef = useRef(0)
  const detailSeqRef = useRef(0)
  const detailHeadingRef = useRef<HTMLHeadingElement>(null)
  const worksRowsRef = useRef<WorkRow[]>([])

  const loadWorks = useCallback(async (accountId: string, sortKey: SortKey, winKey: WindowKey): Promise<void> => {
    // 请求代次守卫：账号/排序/时间窗快速切换时旧响应不得覆盖新选择。
    const seq = ++listSeqRef.current
    setWorksState('loading')
    try {
      const res = await hostAction('works.list', {
        accountId,
        sort: sortKey,
        order: 'desc',
        ...(winKey === 'all' ? {} : windowRange(winKey)),
      })
      if (listSeqRef.current !== seq) return
      const rows = readWorkRows(res)
      worksRowsRef.current = rows
      setWorks(rows)
      setWorksState('ready')
    } catch {
      if (listSeqRef.current !== seq) return
      // 失败列表保留已加载数据：有旧行呈现 partial（列表 + 警告条 + 重试），否则标准 error 态。
      setWorksState(worksRowsRef.current.length > 0 ? 'partial' : 'error')
    }
  }, [])

  useEffect(() => {
    if (props.activeAccountId !== '') void loadWorks(props.activeAccountId, sort, win)
  }, [props.activeAccountId, sort, win, loadWorks])

  const openDetail = useCallback(async (accountId: string, workId: string): Promise<void> => {
    // 详情/趋势共用一个代次：快速换行时旧响应整体作废。
    const seq = ++detailSeqRef.current
    setDetailWorkId(workId)
    setDetailState('loading')
    setTrendState('loading')
    setDetail(null)
    setTrend(null)
    try {
      const res = await hostAction('work.get', { accountId, workId })
      if (detailSeqRef.current !== seq) return
      const row = readWorkDetail(res)
      setDetail(row)
      setDetailState(row === null ? 'empty' : 'ready')
    } catch {
      if (detailSeqRef.current !== seq) return
      setDetail(null)
      setDetailState('error')
    }
    try {
      const res = await hostAction('work.trend', { accountId, workId })
      if (detailSeqRef.current !== seq) return
      setTrend(readWorkTrend(res))
      setTrendState('ready')
    } catch {
      if (detailSeqRef.current !== seq) return
      setTrend(null)
      setTrendState('error')
    }
    if (detailSeqRef.current === seq) detailHeadingRef.current?.focus()
  }, [])

  const closeDetail = useCallback((): void => {
    detailSeqRef.current += 1
    setDetail(null)
    setDetailWorkId(null)
    setTrend(null)
    setDetailState('ready')
    setTrendState('loading')
  }, [])

  const needle = search.trim().toLowerCase()
  const filtered = needle === ''
    ? works
    : works.filter(row => (row.title ?? '').toLowerCase().includes(needle))
  const sortTabs: readonly [SortTab, ...SortTab[]] = [
    { value: 'publish_time', label: t('works.sort.desc'), id: 'wx-sort-time', panelId: 'wx-panel-works' },
    { value: 'play_count', label: t('works.sort.play'), id: 'wx-sort-play', panelId: 'wx-panel-works' },
  ]
  const windowTabs: readonly [WindowTab, ...WindowTab[]] = [
    { value: 'all', label: t('works.filter.all'), id: 'wx-wfilter-all', panelId: 'wx-panel-works' },
    { value: 'yesterday', label: t('works.filter.yesterday'), id: 'wx-wfilter-yesterday', panelId: 'wx-panel-works' },
    { value: 'last_7d', label: t('works.filter.last_7d'), id: 'wx-wfilter-7d', panelId: 'wx-panel-works' },
    { value: 'last_30d', label: t('works.filter.last_30d'), id: 'wx-wfilter-30d', panelId: 'wx-panel-works' },
  ]
  return (
    <div className={css.tabBody}>
      <FilterBar
        search={{ value: search, placeholder: t('works.searchPlaceholder'), onChange: setSearch }}
        onClearAll={() => { setWin('all'); setSearch('') }}
      >
        <SegmentedTabs items={sortTabs} value={sort} onChange={setSort} label={t('works.title')} size='sm' />
        <SegmentedTabs items={windowTabs} value={win} onChange={setWin} label={t('works.filter.all')} size='sm' />
        <span className={css.availability} role='status'>{t('works.count', { count: filtered.length })}</span>
      </FilterBar>
      <DataCard
        title={t('works.title')}
        state={worksState === 'ready' ? (filtered.length > 0 ? 'ready' : 'empty') : worksState}
        onRetry={() => { if (props.activeAccountId !== '') void loadWorks(props.activeAccountId, sort, win) }}
        actions={worksState === 'partial' ? (
          <Button variant='outline' size='sm' onClick={() => { if (props.activeAccountId !== '') void loadWorks(props.activeAccountId, sort, win) }}>
            {t('state.retry')}
          </Button>
        ) : undefined}
      >
        {(worksState === 'ready' || worksState === 'partial') && filtered.length > 0 && (
          <ul className={css.workList}>
            {filtered.map(row => {
              const title = row.title ?? row.workId
              return (
                <li key={row.workId}>
                  <button
                    type='button'
                    className={css.workRowButton}
                    aria-label={title}
                    onClick={() => { void openDetail(props.activeAccountId, row.workId) }}
                  >
                    <span className={css.workTitle}>{title}</span>
                    <span className={css.workMeta}>
                      {t('work.playCount')} {formatCount(row.playCount)}
                      {' · '}
                      {t('work.likeCount')} {formatCount(row.likeCount)}
                      {row.publishTime !== null && ` · ${formatDateTime(row.publishTime) ?? row.publishTime}`}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </DataCard>
      {detailWorkId !== null && (
        <DataCard
          title={t('works.detail')}
          state={detailState}
          onRetry={() => { void openDetail(props.activeAccountId, detailWorkId) }}
          actions={detail !== null ? (
            <button type='button' className={css.linkButton} onClick={closeDetail}>{t('work.close')}</button>
          ) : undefined}
        >
          {detail !== null && (
            <div className={css.detailBody}>
              <h3 ref={detailHeadingRef} className={css.detailTitle} tabIndex={-1}>{detail.title ?? detail.workId}</h3>
              <dl className={css.metaGrid}>
                <div className={css.metaItem}>
                  <dt className={css.metaTerm}>{t('work.playCount')}</dt>
                  <dd className={css.metaValue}>{formatCount(detail.playCount)}</dd>
                </div>
                <div className={css.metaItem}>
                  <dt className={css.metaTerm}>{t('work.likeCount')}</dt>
                  <dd className={css.metaValue}>{formatCount(detail.likeCount)}</dd>
                </div>
                <div className={css.metaItem}>
                  <dt className={css.metaTerm}>{t('work.publishTime')}</dt>
                  <dd className={css.metaValue}>{formatDateTime(detail.publishTime) ?? '—'}</dd>
                </div>
              </dl>
            </div>
          )}
        </DataCard>
      )}
      {detailWorkId !== null && (
        <ChartFrame
          title={t('works.trend')}
          height={220}
          state={trendState === 'loading' ? 'loading' : trendState === 'error' ? 'error' : (trend?.points.length ?? 0) > 0 ? 'ready' : 'empty'}
          onRetry={() => { void openDetail(props.activeAccountId, detailWorkId) }}
          legend={<ChartLegend items={[{ id: 'work-play', label: t('kpi.play'), color: '--yt-chart-1' }]} />}
          footnote={t('overview.dataSource')}
        >
          {trend !== null && trend.points.length > 0 && (
            <TrendLineChart
              points={trend.points.map(point => ({
                label: point.day,
                value: point.playCount,
                rows: [{ label: t('kpi.like'), value: formatCount(point.likeCount) }],
              }))}
              seriesLabel={t('kpi.play')}
              color='--yt-chart-1'
            />
          )}
        </ChartFrame>
      )}
    </div>
  )
}
