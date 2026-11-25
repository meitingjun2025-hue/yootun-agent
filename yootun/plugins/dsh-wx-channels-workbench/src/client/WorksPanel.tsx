/**
 * 作品面板（作品数据页右侧，对齐旧工作台布局）：作品工具栏（采集本账号全部 /
 * 刷新 / 最近采集时间；采集进度与刷新提示在按钮下方就地呈现，不进顶部通知条）
 * → 5 张作品摘要卡（作品总数 / 近7日播放 / 近7日关注量 / 作品完播率 / 缺口作品）
 * → 高密度 13 列作品表格 + 底部分页（kit Pager，固定每页 10 条）。表头排序为
 * 服务端排序：点击发起新查询并回第 1 页（button + aria-sort；行 tabIndex=0，
 * 鼠标双击或行内 Enter 打开作品详情 Modal，焦点回归由官方 Modal 承担；详情
 * 乐观打开，行数据立即上屏，work.get 到达后增量替换）。完播率、缺口作品与
 * 最近采集时间读 works.list 随带的整账号聚合值，不在页面基于当页行计算。
 * @module
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState, KpiCard, Pager } from '@yootun/dsh-client-ui-kit'
import { formatCount, formatDateTime, formatPair, formatPct, formatSeconds, reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { nextSortState, type SortKey, type SortState } from './works-format.ts'
import type { TrendRow } from './charts.tsx'
import { progressTextOf } from './collect-progress.ts'
import { WorkCover } from './WorkCover.tsx'
import { WorkDetailModal } from './WorkDetailModal.tsx'
import { WORKS_PAGE_SIZE, type AccountRow, type SingleCollectRecord } from './WorkbenchPage.tsx'
import {
  readWorkDetail, readWorkTrend, type OverviewData, type WorkDetailData, type WorkRow,
} from './schema.ts'
import { hostAction } from './api.ts'

type WorksLoadState = 'loading' | 'ready' | 'error' | 'partial'

/** 表格列定义（对齐旧工作台 13 列；sortable 列在表头渲染排序按钮）。 */
interface WorkColumn {
  labelKey: Parameters<Translate>[0]
  key: SortKey | null
  sortable: boolean
  /** 行单元格渲染（title 仅用于 col.work 封面列等特殊列）。 */
  cell: (row: WorkRow) => ReactNode
}

export interface WorksPanelProps {
  t: Translate
  localeTag: string
  accountId: string
  account: AccountRow | null
  works: WorkRow[]
  worksState: WorksLoadState
  worksSort: SortState
  onSortChange: (next: SortState) => void
  /** 当前页（从 1 开始）。 */
  worksPage: number
  /** 服务端整账号总行数（Pager 总数）。 */
  worksTotal: number
  /** 服务端聚合：核心缺口作品数（整账号口径）。 */
  worksGapCount: number | null
  /** 服务端聚合：最近采集时间（整账号最大值）。 */
  worksLatestCollectedAt: string | null
  /** 服务端聚合：按播放加权的完播率。 */
  worksCompletionRate: number | null
  /** works 请求在途：表格 aria-busy 与 Pager busy。 */
  worksBusy: boolean
  onPageChange: (page: number) => void
  onRetryWorks: () => void
  /** 固定 last_7d 的账号聚合（摘要卡数据源；不随账号总览页时间窗变化）。 */
  summary: OverviewData | null
  summaryState: 'loading' | 'ready' | 'error'
  /** 同账号后台刷新摘要中：摘要卡淡化呈现（数据与骨架不整块替换）。 */
  summaryRefreshing: boolean
  onRetrySummary: () => void
  collectBusy: boolean
  collectRecord: SingleCollectRecord | null
  collectStartReason: string | null
  onStartCollect: (accountId: string) => void
  onCancelCollect: (accountId: string) => void
  /** 批量采集运行中：单账号采集按钮禁用（宿主互斥的提前反馈）。 */
  batchRunning: boolean
  refreshing: boolean
  refreshFailedParts: string[]
  onRefresh: () => void
  browserBlocked: boolean
}

/** 刷新失败路 → 词典键。 */
const REFRESH_PART_KEYS = { works: 'works.refreshPart.works', overview: 'works.refreshPart.overview', accounts: 'works.refreshPart.accounts' } as const

/** 作品面板组件。 */
export function WorksPanel(props: WorksPanelProps): ReactNode {
  const t = props.t
  const [detailRow, setDetailRow] = useState<WorkRow | null>(null)
  const [detail, setDetail] = useState<WorkDetailData | null>(null)
  const [trendPoints, setTrendPoints] = useState<TrendRow[]>([])
  /** `loading` = work.get / work.trend 在途（行数据乐观展示）；`ready` = 到达；`error` = 失败（保留行数据）。 */
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const detailSeqRef = useRef(0)

  const running = props.collectBusy
  const collectHere = props.collectRecord !== null
    && (props.collectRecord.accountId === props.accountId || props.collectRecord.accountId === null)
  const statusText = running && collectHere
    ? progressTextOf(props.collectRecord?.progress, t)
    : props.refreshFailedParts.length > 0
      ? t('works.refreshPartial', { parts: props.refreshFailedParts.map(part => t(REFRESH_PART_KEYS[part as keyof typeof REFRESH_PART_KEYS])).join('、') })
      : null
  const sort = props.worksSort
  // 行序即服务端排序结果（当页 10 条），页面不再本地重排。
  const visibleWorks = props.works

  const openDetail = useCallback((row: WorkRow): void => {
    // 乐观打开（对齐旧客户端）：行数据立即上屏（Modal 无整页骨架等待），
    // work.get / work.trend 到达后增量替换；详情/趋势共用一个代次，快速换行
    // 时旧响应整体作废。
    const seq = ++detailSeqRef.current
    const accountId = props.accountId
    setDetailRow(row)
    setDetail(null)
    // 趋势兜底数据同样换行清空：B 详情先到且无按日数据时，不得绘制 A 的曲线。
    setTrendPoints([])
    setDetailState('loading')
    try {
      void hostAction('work.get', { accountId, workId: row.workId }).then(res => {
        if (detailSeqRef.current !== seq) return
        // 到达即 ready：载荷无有效 work 时 Modal 保留行数据，区块按空态呈现
        // （旧客户端 `result.work || work` 兜底语义）。
        setDetail(readWorkDetail(res))
        setDetailState('ready')
      }).catch(() => {
        if (detailSeqRef.current !== seq) return
        setDetail(null)
        setDetailState('error')
      })
      void hostAction('work.trend', { accountId, workId: row.workId }).then(res => {
        if (detailSeqRef.current !== seq) return
        const trend = readWorkTrend(res)
        setTrendPoints(trend.points.map(point => ({
          day: point.day,
          values: { playCount: point.playCount, likeCount: point.likeCount },
        })))
      }).catch(() => {
        if (detailSeqRef.current !== seq) return
        setTrendPoints([])
      })
    } catch {
      // hostAction 同步抛错视为详情失败（请求未发出）。
      setDetail(null)
      setDetailState('error')
    }
  }, [props.accountId])

  const closeDetail = useCallback((): void => {
    detailSeqRef.current += 1
    setDetailRow(null)
    setDetail(null)
    setTrendPoints([])
    setDetailState('loading')
  }, [])

  const columns = buildColumns(t)

  const summaryCards = (
    <div className={`${css.summaryGrid} ${css.refreshDim}`} data-refreshing={props.summaryRefreshing || undefined}>
      <KpiCard
        label={t('summary.worksTotal')}
        value={formatCount(props.account?.feedCount ?? null)}
        footnote={t('summary.worksTotalHint')}
        state={props.account?.feedCount === null || props.account === null ? 'empty' : 'ready'}
      />
      <KpiCard
        label={t('summary.play7d')}
        value={formatCount(props.summary?.totals.playCount ?? null)}
        footnote={t('summary.play7dHint')}
        state={kpiStateOf(props.summaryState, props.summary?.totals.playCount ?? null)}
        onRetry={props.onRetrySummary}
      />
      <KpiCard
        label={t('summary.follow7d')}
        value={formatCount(props.summary?.totals.followCount ?? null)}
        footnote={t('summary.follow7dHint')}
        state={kpiStateOf(props.summaryState, props.summary?.totals.followCount ?? null)}
        onRetry={props.onRetrySummary}
      />
      <KpiCard
        label={t('summary.completion')}
        value={formatPct(props.worksCompletionRate)}
        footnote={t('summary.completionHint')}
        state={props.worksState === 'ready' ? (props.worksCompletionRate === null ? 'empty' : 'ready') : props.worksState}
      />
      <KpiCard
        label={t('summary.gapWorks')}
        value={formatCount(props.worksState === 'ready' || props.worksState === 'partial' ? props.worksGapCount : null)}
        footnote={props.worksGapCount !== null && props.worksGapCount > 0 ? t('summary.gapHint') : t('summary.gapComplete')}
        state={props.worksState === 'ready' || props.worksState === 'partial' ? 'ready' : props.worksState}
      />
    </div>
  )

  return (
    <div className={css.panelBody}>
      <div className={css.workToolbar}>
        <div className={css.workToolbarRow}>
          <Button
            variant='primary'
            size='sm'
            disabled={props.accountId === '' || running || props.batchRunning || props.browserBlocked}
            aria-busy={running || undefined}
            onClick={() => { props.onStartCollect(props.accountId) }}
          >
            {running && collectHere ? t('works.collecting') : t('works.collect')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={props.accountId === '' || props.refreshing || running}
            aria-busy={props.refreshing || undefined}
            onClick={props.onRefresh}
          >
            {props.refreshing ? t('works.refreshing') : t('works.refresh')}
          </Button>
          <span className={css.toolbarNote}>{t('works.latestCollectedAt', { time: formatDateTime(props.worksLatestCollectedAt) ?? '—' })}</span>
        </div>
        {(statusText !== null || running || props.collectStartReason !== null) && (
          <div
            className={css.toolbarStatus}
            role={props.collectStartReason !== null ? 'alert' : 'status'}
            aria-live='polite'
            aria-busy={running || undefined}
          >
            {props.collectStartReason !== null && (
              <>
                <span>{t('collect.startFailedReason')}</span>
                <span className={css.reasonText}>{reasonText(props.collectStartReason, t)}</span>
              </>
            )}
            {props.collectStartReason === null && statusText !== null && <span>{statusText}</span>}
            {running && collectHere && (
              <Button variant='ghost' size='sm' onClick={() => { props.onCancelCollect(props.accountId) }}>
                {t('works.cancel')}
              </Button>
            )}
          </div>
        )}
      </div>
      {summaryCards}
      <DataState
        state={props.worksState === 'ready' ? (visibleWorks.length > 0 ? 'ready' : 'empty') : props.worksState}
        shape='rows'
        onRetry={props.onRetryWorks}
        emptyAction={(
          <Button
            variant='primary'
            size='sm'
            disabled={props.accountId === '' || running || props.batchRunning || props.browserBlocked}
            onClick={() => { props.onStartCollect(props.accountId) }}
          >
            {t('works.collect')}
          </Button>
        )}
      >
        {/* 表格在固定高度区域内滚动；横向滚动只发生在表格内部（键盘可达滚动）。 */}
        <div className={css.tableWrap} role='region' aria-label={t('works.table.scrollLabel')} tabIndex={0}>
          <table className={css.workTable} aria-label={t('works.table.label')} aria-busy={props.worksBusy || undefined}>
            <thead>
              <tr>
                {columns.map(column => {
                  if (!column.sortable || column.key === null) {
                    return <th key={column.labelKey} scope='col'>{t(column.labelKey)}</th>
                  }
                  const active = sort.key === column.key
                  const direction = active ? sort.direction : null
                  return (
                    <th
                      key={column.labelKey}
                      scope='col'
                      aria-sort={direction === 'desc' ? 'descending' : direction === 'asc' ? 'ascending' : 'none'}
                    >
                      <button
                        type='button'
                        className={css.sortButton}
                        data-active={active || undefined}
                        aria-label={t('sort.aria', {
                          label: t(column.labelKey),
                          order: direction === 'desc' ? t('sort.desc') : direction === 'asc' ? t('sort.asc') : t('sort.default'),
                        })}
                        onClick={() => { props.onSortChange(nextSortState(sort, column.key as SortKey)) }}
                      >
                        <span className={css.sortText}>{t(column.labelKey)}</span>
                        <span className={css.sortArrow} aria-hidden='true'>
                          {direction === 'desc' ? '↓' : direction === 'asc' ? '↑' : '↕'}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visibleWorks.map(row => {
                const title = row.title ?? row.workId
                return (
                  <tr
                    key={row.workId}
                    tabIndex={0}
                    aria-label={t('row.detailAria', { title })}
                    onDoubleClick={() => { openDetail(row) }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        openDetail(row)
                      }
                    }}
                  >
                    {columns.map(column => (
                      <td key={column.labelKey}>{column.cell(row)}</td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {visibleWorks.length > 0 && (
          <Pager
            page={props.worksPage}
            pageSize={WORKS_PAGE_SIZE}
            total={props.worksTotal}
            onPage={props.onPageChange}
            busy={props.worksBusy}
          />
        )}
      </DataState>
      <WorkDetailModal
        t={t}
        localeTag={props.localeTag}
        row={detailRow}
        detail={detail}
        trendRows={trendPoints}
        detailState={detailState}
        onRetry={() => {
          if (detailRow !== null) openDetail(detailRow)
        }}
        onClose={closeDetail}
      />
    </div>
  )
}

/** 13 列定义（作品列 = 封面 + 标题；企微 / 通讯录 = 次数/人数组合；无操作列）。 */
function buildColumns(t: Translate): WorkColumn[] {
  const num = (value: number | null): string => formatCount(value)
  return [
    {
      labelKey: 'col.work',
      key: null,
      sortable: false,
      cell: row => (
        <div className={css.workCell}>
          <WorkCover key={`cover:${row.workId}:${row.coverUrl ?? ''}`} t={t} coverUrl={row.coverUrl} durationS={row.durationS} />
          <span className={css.workTitleCell} title={row.title ?? row.workId}>{row.title ?? row.workId}</span>
        </div>
      ),
    },
    { labelKey: 'col.publishTime', key: 'publish_time', sortable: true, cell: row => formatDateTime(row.publishTime) ?? '—' },
    { labelKey: 'col.completion', key: 'completion_rate_pct', sortable: true, cell: row => formatPct(row.completionRatePct) },
    { labelKey: 'col.avgDuration', key: 'avg_play_duration_s', sortable: true, cell: row => formatSeconds(row.avgPlayDurationS, t) },
    { labelKey: 'col.play', key: 'play_count', sortable: true, cell: row => num(row.playCount) },
    { labelKey: 'col.like', key: 'like_count', sortable: true, cell: row => num(row.likeCount) },
    { labelKey: 'col.favorite', key: 'favorite_count', sortable: true, cell: row => num(row.favoriteCount) },
    { labelKey: 'col.comment', key: 'comment_count', sortable: true, cell: row => num(row.commentCount) },
    { labelKey: 'col.share', key: 'share_count', sortable: true, cell: row => num(row.shareCount) },
    { labelKey: 'col.forward', key: 'forward_count', sortable: true, cell: row => num(row.forwardCount) },
    { labelKey: 'col.follow', key: 'follow_count', sortable: true, cell: row => num(row.followCount) },
    { labelKey: 'col.wecomClick', key: null, sortable: false, cell: row => formatPair(row.wecomLinkClickCount, row.wecomLinkClickUv) },
    { labelKey: 'col.contactAdd', key: null, sortable: false, cell: row => formatPair(row.wecomContactAddCount, row.wecomContactAddUv) },
  ]
}

/** KPI 卡状态：加载/错误优先，值缺失按 empty。 */
function kpiStateOf(summaryState: 'loading' | 'ready' | 'error', value: number | null): 'loading' | 'ready' | 'error' | 'empty' {
  if (summaryState === 'ready') return value === null ? 'empty' : 'ready'
  return summaryState
}
