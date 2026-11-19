/**
 * 作品面板（作品数据页右侧）：作品工具栏（采集本账号全部 / 刷新 / 最近采集
 * 时间；采集进度在按钮下方就地呈现，不进顶部通知条）+ 已入库作品列表。
 * 列表 / 详情 / 摘要卡的完整布局在后续提交回正。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard } from '@yootun/dsh-client-ui-kit'
import { formatCount, formatDateTime, reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { latestCollectedAt } from './works-format.ts'
import { progressTextOf } from './collect-progress.ts'
import { RunQueryDialog } from './RunQueryDialog.tsx'
import type { AccountRow, SingleCollectRecord } from './WorkbenchPage.tsx'
import type { OverviewData, WorkRow } from './schema.ts'

/** 刷新失败路 → 词典键。 */
const REFRESH_PART_KEYS = { works: 'works.refreshPart.works', overview: 'works.refreshPart.overview', accounts: 'works.refreshPart.accounts' } as const

type WorksLoadState = 'loading' | 'ready' | 'error' | 'partial'

export interface WorksPanelProps {
  t: Translate
  localeTag: string
  accountId: string
  account: AccountRow | null
  works: WorkRow[]
  worksState: WorksLoadState
  onRetryWorks: () => void
  /** 固定 last_7d 的账号聚合（摘要卡数据源；当前提交仅驱动加载态占位）。 */
  summary: OverviewData | null
  summaryState: 'loading' | 'ready' | 'error'
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

/** 作品面板组件（骨架版）。 */
export function WorksPanel(props: WorksPanelProps): ReactNode {
  const t = props.t
  const [runOpen, setRunOpen] = useState(false)
  const running = props.collectBusy
  const collectHere = props.collectRecord !== null
    && (props.collectRecord.accountId === props.accountId || props.collectRecord.accountId === null)
  const statusText = running && collectHere
    ? progressTextOf(props.collectRecord?.progress, t)
    : props.refreshFailedParts.length > 0
      ? t('works.refreshPartial', { parts: props.refreshFailedParts.map(part => t(REFRESH_PART_KEYS[part as keyof typeof REFRESH_PART_KEYS])).join('、') })
      : null
  const latest = latestCollectedAt(props.works)
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
          <span className={css.toolbarNote}>{t('works.latestCollectedAt', { time: formatDateTime(latest) ?? '—' })}</span>
          <Button
            variant='outline'
            size='sm'
            onClick={() => { setRunOpen(true) }}
          >
            {t('collect.runLookup.title')}
          </Button>
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
      <DataCard
        title={t('works.title')}
        state={props.worksState === 'ready' ? (props.works.length > 0 ? 'ready' : 'empty') : props.worksState}
        onRetry={props.onRetryWorks}
      >
        <ul className={css.workList}>
          {props.works.map(row => (
            <li key={row.workId} className={css.workRow}>
              <span className={css.workTitle}>{row.title ?? row.workId}</span>
              <span className={css.workMeta}>
                {t('col.play')} {formatCount(row.playCount)}
                {' · '}
                {formatDateTime(row.publishTime) ?? '—'}
              </span>
            </li>
          ))}
        </ul>
      </DataCard>
      <RunQueryDialog t={t} open={runOpen} onClose={() => { setRunOpen(false) }} />
    </div>
  )
}
