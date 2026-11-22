/**
 * 作品面板（账号作品页右侧，对齐旧工作台布局）：工具栏（采集本账号全部
 * primary / 负责人入口（未设置·新增 / 已设置·编辑）/ 刷新 / 导出 Excel
 * ghost+icon / 上次采集 / 全部时间作品数）→ runBanner 三色 → 采集进度三态
 * （role=status aria-busy）→ 高密度 12 列作品表格（列序冻结：作品名称/作品
 * 链接 sticky；10 数值列三态排序循环、缺失恒最后显示「—」不造 0；百分比
 * clamp；吸粉量红涨绿跌；已投流行 error-token 淡底 + Tag；行 Enter/双击开
 * 详情；链接白名单 douyin.com；封面图 + 时长角标）。
 * @module
 */
import { type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState } from '@yootun/dsh-client-ui-kit'
import {
  EMPTY, formatCount, formatDateTime, formatDuration, formatPercent, formatSeconds,
  nextWorkSort, reasonText, safeHttpUrl, safeWorkUrl, sortWorkRows, type Translate,
  type WorkSortKey, type WorkSortState,
} from './format.ts'
import css from './workbench.module.css'
import type { AccountRow, CollectView } from './WorkbenchPage.tsx'
import type { WorkRow } from './schema.ts'

type WorksLoadState = 'loading' | 'ready' | 'error' | 'partial'

/** 12 列定义（列序冻结；sortable = 10 个数值列）。 */
interface WorkColumn {
  labelKey: Parameters<Translate>[0]
  key: WorkSortKey | null
  sticky: boolean
  cell: (row: WorkRow, t: Translate, localeTag: string) => ReactNode
}

export interface WorksPanelProps {
  t: Translate
  localeTag: string
  accountId: string
  account: AccountRow | null
  works: WorkRow[]
  worksState: WorksLoadState
  worksSort: WorkSortState
  onSortChange: (next: WorkSortState) => void
  onRetryWorks: () => void
  collectBusy: boolean
  collectRecord: CollectView | null
  collectStartReason: string | null
  onStartCollect: (accountId: string) => void
  batchRunning: boolean
  browserBlocked: boolean
  refreshing: boolean
  refreshFailedParts: string[]
  onRefresh: () => void
  exporting: boolean
  onExport: () => void
  onOpenOwner: () => void
  onOpenWork: (accountId: string, row: WorkRow) => void
}

/** 刷新失败路 → 词典键。 */
const REFRESH_PART_KEYS = { works: 'works.refreshPart.works', accounts: 'works.refreshPart.accounts' } as const

/**
 * 采集进度三态文案（progress.phase：work / batch_done / collected）。
 * @param record - 采集运行投影。
 * @param t - 页面翻译函数。
 * @returns 进度文案。
 */
export function progressTextOf(record: CollectView | null, t: Translate): string {
  const progress = record?.progress ?? {}
  const phase = typeof progress.phase === 'string' ? progress.phase : ''
  if (phase === 'work') {
    return t('works.progress.collect', {
      index: numberOfOr(progress.index, 0),
      total: numberOfOr(progress.total, 0),
    })
  }
  if (phase === 'batch_done') {
    const succeeded = numberOfOr(progress.succeeded, 0)
    const failed = numberOfOr(progress.failed, 0)
    return t('works.progress.ingest', {
      batchNo: numberOfOr(progress.batchNo, 0),
      totalBatches: numberOfOr(progress.totalBatches, 0),
      succeeded,
      expected: succeeded + failed,
    })
  }
  if (phase === 'collected') return t('works.progress.list')
  return t('works.progress.fallback')
}

function numberOfOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 作品面板组件。 */
export function WorksPanel(props: WorksPanelProps): ReactNode {
  const t = props.t
  const running = props.collectBusy
  const collectHere = props.collectRecord !== null
    && (props.collectRecord.accountId === props.accountId || props.collectRecord.accountId === '')
  // runBanner 三色：failed 红 / partial 黄 / completed 绿（状态色 token 承担）。
  const runBanner = props.collectRecord !== null && !running && collectHere
    ? props.collectRecord.status
    : null
  const columns = buildColumns()
  const sort = props.worksSort
  const visibleWorks = sortWorkRows(props.works, sort, (row, key) => row[key])

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
          <Button variant='ghost' size='sm' disabled={props.accountId === ''} onClick={props.onOpenOwner}>
            {props.account?.ownerName != null && props.account.ownerName !== ''
              ? `${props.account.ownerName} · ${t('works.ownerEdit')}`
              : `${t('works.ownerNotSet')} · ${t('works.ownerAdd')}`}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            disabled={props.accountId === '' || props.refreshing || running}
            aria-busy={props.refreshing || undefined}
            onClick={props.onRefresh}
          >
            {props.refreshing ? t('works.refreshing') : t('works.refresh')}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            icon={<DownloadIcon />}
            disabled={props.accountId === '' || props.exporting || props.works.length === 0}
            aria-busy={props.exporting || undefined}
            title={props.works.length === 0 ? t('works.exportNoData') : undefined}
            onClick={props.onExport}
          >
            {props.exporting ? t('works.exporting') : t('works.exportExcel')}
          </Button>
          {props.account?.lastCollectedAt != null && (
            <span className={css.toolbarNote}>{t('works.lastCollected', { time: formatDateTime(props.account.lastCollectedAt) })}</span>
          )}
          {visibleWorks.length > 0 && (
            <span className={css.toolbarNote}>{t('works.workCountAllTime', { count: props.works.length })}</span>
          )}
        </div>
        {(runBanner !== null || running || props.collectStartReason !== null || props.refreshFailedParts.length > 0) && (
          <div
            className={css.toolbarStatus}
            role={props.collectStartReason !== null || runBanner === 'failed' ? 'alert' : 'status'}
            aria-live='polite'
            aria-busy={running || undefined}
          >
            {props.collectStartReason !== null && (
              <span className={css.reasonText}>{`${t('works.collectStartFailed')}：${reasonText(props.collectStartReason, t)}`}</span>
            )}
            {props.collectStartReason === null && runBanner !== null && (
              <span className={css.runBanner} data-tone={runBanner}>
                {runBanner === 'failed'
                  ? `${t('run.failed')}：${props.collectRecord?.error !== null && props.collectRecord !== null ? reasonText(props.collectRecord.error ?? '', t) : ''}`
                  : runBanner === 'partial' ? t('run.partial') : t('run.completed')}
              </span>
            )}
            {props.collectStartReason === null && running && collectHere && (
              <span>{progressTextOf(props.collectRecord, t)}</span>
            )}
            {props.refreshFailedParts.length > 0 && (
              <span>{t('works.refreshPartial', { parts: props.refreshFailedParts.map(part => t(REFRESH_PART_KEYS[part as keyof typeof REFRESH_PART_KEYS])).join('、') })}</span>
            )}
          </div>
        )}
      </div>
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
        <div className={css.tableWrap} role='region' aria-label={t('works.table.scrollLabel')} tabIndex={0}>
          <table className={css.workTable} aria-label={t('works.table.label')}>
            <thead>
              <tr>
                {columns.map(column => {
                  if (column.key === null) {
                    return <th key={column.labelKey} scope='col' className={column.sticky ? css.cellSticky : undefined}>{t(column.labelKey)}</th>
                  }
                  const active = sort.key === column.key
                  const direction = active ? sort.direction : 'default'
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
                        onClick={() => { props.onSortChange(nextWorkSort(sort, column.key as WorkSortKey)) }}
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
                const title = row.title ?? row.work_id
                return (
                  <tr
                    key={row.work_id}
                    tabIndex={0}
                    className={row.promoted ? css.rowPromoted : undefined}
                    aria-label={t('row.detailAria', { title })}
                    onDoubleClick={() => { props.onOpenWork(props.accountId, row) }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        props.onOpenWork(props.accountId, row)
                      }
                    }}
                  >
                    {columns.map(column => <td key={column.labelKey}>{column.cell(row, t, props.localeTag)}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </DataState>
    </div>
  )
}

/** 下载图标（14px 线性几何，currentColor 随 token）。 */
function DownloadIcon(): ReactNode {
  return (
    <svg width='14' height='14' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <path d='M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 12.5h10' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
  )
}

/** 吸粉量着色 span（红涨绿跌 token；0/缺失中性「—」）。 */
function FansGainCell(props: { value: number | null; localeTag: string }): ReactNode {
  const delta = props.value === null
    ? { text: EMPTY, tone: 'flat' as const }
    : props.value > 0
      ? { text: `+${formatCount(props.value, props.localeTag)}`, tone: 'up' as const }
      : props.value < 0
        ? { text: `-${formatCount(Math.abs(props.value), props.localeTag)}`, tone: 'down' as const }
        : { text: EMPTY, tone: 'flat' as const }
  if (delta.tone === 'flat') return <span>{delta.text}</span>
  return <span className={delta.tone === 'up' ? css.deltaUp : css.deltaDown}>{delta.text}</span>
}

/** 封面格：安全封面 + 时长角标；失败/缺失占位不发坏请求。 */
function CoverCell(props: { row: WorkRow }): ReactNode {
  const row = props.row
  const cover = safeHttpUrl(row.cover_url)
  const duration = row.duration_s === null ? null : formatDuration(row.duration_s * 1000)
  return (
    <span className={css.cover} aria-hidden={cover === null ? undefined : 'true'}>
      {cover !== null
        ? <img className={css.coverImg} src={cover} alt='' loading='lazy' referrerPolicy='no-referrer' />
        : '—'}
      {duration !== null && <span className={css.coverDuration}>{duration}</span>}
    </span>
  )
}

/** 12 列定义（数值格式化缺失恒「—」）。 */
function buildColumns(): WorkColumn[] {
  const num = (value: number | null): string => formatCount(value)
  return [
    {
      labelKey: 'col.title',
      key: null,
      sticky: true,
      cell: (row, t) => (
        <span className={css.workCell}>
          <CoverCell row={row} />
          <span className={css.workTitleCell} title={row.title ?? row.work_id}>{row.title ?? row.work_id}</span>
          {row.promoted && <Tag tone='danger'>{t('promotion.badge')}</Tag>}
        </span>
      ),
    },
    {
      labelKey: 'col.url',
      key: null,
      sticky: true,
      cell: row => {
        const href = safeWorkUrl(row.url)
        return href !== null
          ? (
            <a
              className={css.workLink}
              href={href}
              target='_blank'
              rel='noreferrer'
              onClick={event => event.stopPropagation()}
              onDoubleClick={event => event.stopPropagation()}
              onKeyDown={event => event.stopPropagation()}
            >
              {row.url}
            </a>
          )
          : <span>{row.url ?? EMPTY}</span>
      },
    },
    { labelKey: 'col.play', key: 'play_count', sticky: false, cell: row => num(row.play_count) },
    { labelKey: 'col.collect', key: 'collect_count', sticky: false, cell: row => num(row.collect_count) },
    { labelKey: 'col.like', key: 'like_count', sticky: false, cell: row => num(row.like_count) },
    { labelKey: 'col.comment', key: 'comment_count', sticky: false, cell: row => num(row.comment_count) },
    { labelKey: 'col.bounce2s', key: 'bounce_rate_2s_pct', sticky: false, cell: row => formatPercent(row.bounce_rate_2s_pct) },
    { labelKey: 'col.completion5s', key: 'completion_rate_5s_pct', sticky: false, cell: row => formatPercent(row.completion_rate_5s_pct) },
    { labelKey: 'col.completion', key: 'completion_rate_pct', sticky: false, cell: row => formatPercent(row.completion_rate_pct) },
    { labelKey: 'col.fansGain', key: 'fans_gain_count', sticky: false, cell: (row, _t, localeTag) => <FansGainCell value={row.fans_gain_count} localeTag={localeTag} /> },
    { labelKey: 'col.duration', key: 'avg_watch_duration_s', sticky: false, cell: (row, t) => formatSeconds(row.avg_watch_duration_s, t) },
    { labelKey: 'col.proportion', key: 'avg_view_proportion_pct', sticky: false, cell: row => formatPercent(row.avg_view_proportion_pct) },
  ]
}
