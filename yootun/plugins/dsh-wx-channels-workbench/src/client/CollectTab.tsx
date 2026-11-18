/**
 * 采集页：单账号 collect.start/status/cancel、全账号 collectAll.start/status/
 * cancel、run.get 查询。展示 attemptId / runId / phase / 批次进度；started:false
 * 的稳定 reason 可见；cancelled / interrupted / failed 状态可见；「当前任务」
 * （内存实时态）与「上次运行」（runs.json 终态投影 lastRun）分卡呈现；run.get
 * 按 tools 真实形状（`{ run, batches }`）渲染并区分「未找到」与「查询失败」。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { formatCount, formatDateTime, reasonText, type Translate } from './format.ts'
import { type WxLocaleKey } from './locales.ts'
import css from './workbench.module.css'
import { readRunView, type RunView } from './schema.ts'

interface CollectRecord {
  accountId?: string
  attemptId?: string | null
  status?: string
  startedAt?: string | null
  finishedAt?: string | null
  error?: string | null
  progress?: Record<string, unknown>
  result?: Record<string, unknown> | null
}

interface LastRunRecord {
  accountId?: string
  attemptId?: string
  runId?: string | null
  status?: string
  startedAt?: string
  finishedAt?: string | null
  error?: string | null
}

/** collectAll.status 投影（逐字段读取，不整包断言）。 */
interface BatchStatusData {
  ready: boolean
  phase: string | null
  total: number | null
  currentAccountId: string | null
  completedCount: number | null
  partialCount: number | null
  failedCount: number | null
  skippedCount: number | null
}

/** run.get 查询结果状态：idle / busy / 命中 / 未命中 / 失败（稳定 reason）。 */
type RunLookupState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'hit'; run: RunView }
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: string }

export interface CollectTabProps {
  t: Translate
  activeAccountId: string
}

const POLL_MS = 2000

/** 稳定码集合：命中这个集合的查询失败按「未找到」呈现，其余按失败呈现。 */
const RUN_NOT_FOUND_CODES = new Set(['RUN_NOT_FOUND', 'RUN_ACCOUNT_MISMATCH'])

/** collectAll.status 载荷 → 逐字段投影（未知形态字段为 null，不整包 cast）。 */
function readBatchStatus(payload: Record<string, unknown>): BatchStatusData {
  return {
    ready: payload.ready === true,
    phase: typeof payload.phase === 'string' ? payload.phase : null,
    total: typeof payload.total === 'number' && Number.isFinite(payload.total) ? payload.total : null,
    currentAccountId: typeof payload.currentAccountId === 'string' ? payload.currentAccountId : null,
    completedCount: typeof payload.completedCount === 'number' && Number.isFinite(payload.completedCount) ? payload.completedCount : null,
    partialCount: typeof payload.partialCount === 'number' && Number.isFinite(payload.partialCount) ? payload.partialCount : null,
    failedCount: typeof payload.failedCount === 'number' && Number.isFinite(payload.failedCount) ? payload.failedCount : null,
    skippedCount: typeof payload.skippedCount === 'number' && Number.isFinite(payload.skippedCount) ? payload.skippedCount : null,
  }
}

/** 采集页组件。 */
export function CollectTab(props: CollectTabProps): ReactNode {
  const t = props.t
  const [record, setRecord] = useState<CollectRecord | null>(null)
  const [lastRun, setLastRun] = useState<LastRunRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [batch, setBatch] = useState<BatchStatusData | null>(null)
  const [batchReady, setBatchReady] = useState(true)
  const [startReason, setStartReason] = useState<string | null>(null)
  const [runQuery, setRunQuery] = useState('')
  const [runLookup, setRunLookup] = useState<RunLookupState>({ kind: 'idle' })
  const collectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const runLookupSeqRef = useRef(0)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const res = await hostAction('collect.status', {})
    setRecord(res.collect !== null && typeof res.collect === 'object' ? res.collect as CollectRecord : null)
    setBusy(res.busy === true)
    setLastRun(res.lastRun !== null && typeof res.lastRun === 'object' ? res.lastRun as LastRunRecord : null)
  }, [])

  const refreshBatch = useCallback(async (): Promise<void> => {
    const res = await hostAction('collectAll.status', {})
    setBatch(readBatchStatus(res))
    setBatchReady(res.ready === true)
  }, [])

  useEffect(() => {
    void refreshStatus().catch(() => { setStartReason('WX_TOOL_UNAVAILABLE') })
    void refreshBatch().catch(() => undefined)
    return () => {
      if (collectPollRef.current !== null) { clearInterval(collectPollRef.current); collectPollRef.current = null }
      if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
    }
  }, [refreshStatus, refreshBatch])

  const startCollect = useCallback(async (): Promise<void> => {
    setStartReason(null)
    try {
      const res = await hostAction('collect.start', { accountId: props.activeAccountId })
      if (res.started !== true) {
        // started:false 不进入轮询、不置 running：只呈现稳定 reason。
        setStartReason(typeof res.reason === 'string' ? res.reason : 'unknown')
        await refreshStatus().catch(() => undefined)
        return
      }
      if (collectPollRef.current !== null) clearInterval(collectPollRef.current)
      collectPollRef.current = setInterval(() => {
        void hostAction('collect.status', {}).then(statusRes => {
          setRecord(statusRes.collect !== null && typeof statusRes.collect === 'object' ? statusRes.collect as CollectRecord : null)
          setBusy(statusRes.busy === true)
          if (statusRes.busy !== true && collectPollRef.current !== null) {
            clearInterval(collectPollRef.current)
            collectPollRef.current = null
          }
        }).catch(() => undefined)
      }, POLL_MS)
    } catch (error) {
      setStartReason(error instanceof Error ? error.message : 'unknown')
    }
  }, [props.activeAccountId, refreshStatus])

  const cancelCollect = useCallback(async (): Promise<void> => {
    await hostAction('collect.cancel', { accountId: props.activeAccountId }).catch(() => undefined)
  }, [props.activeAccountId])

  const startBatch = useCallback(async (): Promise<void> => {
    setStartReason(null)
    try {
      const res = await hostAction('collectAll.start', {})
      if (res.started !== true) {
        setStartReason(typeof res.reason === 'string' ? res.reason : 'unknown')
        return
      }
      if (batchPollRef.current !== null) clearInterval(batchPollRef.current)
      batchPollRef.current = setInterval(() => {
        void hostAction('collectAll.status', {}).then(batchRes => {
          setBatch(readBatchStatus(batchRes))
          const ready = batchRes.ready === true
          setBatchReady(ready)
          if (ready && batchPollRef.current !== null) {
            clearInterval(batchPollRef.current)
            batchPollRef.current = null
          }
        }).catch(() => undefined)
      }, POLL_MS)
    } catch (error) {
      setStartReason(error instanceof Error ? error.message : 'unknown')
    }
  }, [])

  const cancelBatch = useCallback(async (): Promise<void> => {
    await hostAction('collectAll.cancel', {}).catch(() => undefined)
  }, [])

  const lookupRun = useCallback(async (): Promise<void> => {
    const runId = runQuery.trim()
    if (runId === '') return
    // 请求代次守卫：快速连续查询时旧响应不得覆盖新结果。
    const seq = ++runLookupSeqRef.current
    setRunLookup({ kind: 'busy' })
    try {
      const res = await hostAction('run.get', { runId })
      if (runLookupSeqRef.current !== seq) return
      const run = readRunView(res)
      // 无 run 对象（含 RUN_NOT_FOUND 之外的空载荷）同样按未命中呈现。
      setRunLookup(run === null ? { kind: 'not_found' } : { kind: 'hit', run })
    } catch (error) {
      if (runLookupSeqRef.current !== seq) return
      const reason = error instanceof Error ? error.message : 'unknown'
      // RUN_NOT_FOUND / RUN_ACCOUNT_MISMATCH 是确定性的「无此运行」；其余
      // （网络 / 服务失败）必须以失败态呈现，不得伪装成未找到。
      setRunLookup(RUN_NOT_FOUND_CODES.has(reason) ? { kind: 'not_found' } : { kind: 'failed', reason })
    }
  }, [runQuery])

  const batchCounts = batch === null ? null : [
    t('collect.batch.completed', { count: batch.completedCount ?? 0 }),
    t('collect.batch.partial', { count: batch.partialCount ?? 0 }),
    t('collect.batch.failed', { count: batch.failedCount ?? 0 }),
    t('collect.batch.skipped', { count: batch.skippedCount ?? 0 }),
  ].join(' · ')
  return (
    <div className={css.tabBody}>
      {startReason !== null && (
        <div className={css.reasonBanner} role='alert'>
          <span>{t('collect.startFailedReason')}</span>
          <span className={css.reasonText}>{reasonText(startReason, t)}</span>
        </div>
      )}
      <div className={css.collectControls}>
        <Button variant='primary' size='sm' disabled={props.activeAccountId === '' || busy}
          onClick={() => { void startCollect() }}>
          {t('collect.start')}
        </Button>
        <Button variant='ghost' size='sm' disabled={props.activeAccountId === '' || !busy}
          onClick={() => { void cancelCollect() }}>
          {t('collect.cancel')}
        </Button>
        <Button variant='ghost' size='sm' disabled={batchReady === false}
          onClick={() => { void startBatch() }}>
          {t('collect.collectAll')}
        </Button>
        <Button variant='ghost' size='sm' disabled={batchReady !== false}
          onClick={() => { void cancelBatch() }}>
          {t('collect.cancel')}
        </Button>
      </div>
      <DataCard title={t('collect.record')} description={record?.accountId} state='ready'
        actions={<Button variant='ghost' size='sm' onClick={() => { void refreshStatus().catch(() => undefined) }}>{t('header.refresh')}</Button>}>
        {record === null
          ? <p className={css.collectStatus}>{t('collect.noCurrent')}</p>
          : <RunFields
              t={t}
              attemptId={record.attemptId ?? null}
              runId={runIdOf(record)}
              status={record.status ?? null}
              startedAt={record.startedAt ?? null}
              finishedAt={record.finishedAt ?? null}
              error={record.error ?? null}
              worksCount={worksOf(record)}
              progress={record.progress}
            />}
      </DataCard>
      <DataCard title={t('collect.lastRun')} description={lastRun?.accountId} state='ready'>
        {lastRun === null
          ? <p className={css.collectStatus}>{t('collect.noLastRun')}</p>
          : <RunFields
              t={t}
              attemptId={lastRun.attemptId ?? null}
              runId={lastRun.runId ?? null}
              status={lastRun.status ?? null}
              startedAt={lastRun.startedAt ?? null}
              finishedAt={lastRun.finishedAt ?? null}
              error={lastRun.error ?? null}
              worksCount={null}
              progress={undefined}
            />}
      </DataCard>
      <DataCard title={t('collect.collectAll')} state='ready'>
        {batch === null
          ? <p className={css.collectStatus}>{t('collect.noCurrent')}</p>
          : <div className={css.collectStatus}>
              <p>{`${t('collect.label.status')}: ${batchReady ? t('collect.status.completed') : phaseDisplay(batch.phase ?? undefined, t) ?? '—'}`}</p>
              <p>{`${t('collect.batch.current')}: ${batch.currentAccountId ?? '—'} · ${t('collect.batch.total', { total: batch.total ?? 0 })}`}</p>
              <p>{batchCounts}</p>
            </div>}
      </DataCard>
      <DataCard title={t('collect.runLookup.title')} state='ready'>
        <div className={css.runLookup}>
          <Input
            type='text'
            value={runQuery}
            placeholder={t('collect.runLookup.placeholder')}
            aria-label={t('collect.runLookup.placeholder')}
            onChange={event => { setRunQuery(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void lookupRun() }}
          />
          <Button variant='outline' size='sm' disabled={runQuery.trim() === '' || runLookup.kind === 'busy'}
            onClick={() => { void lookupRun() }}>
            {t('collect.runLookup.action')}
          </Button>
        </div>
        {runLookup.kind === 'not_found' && (
          <p className={css.collectStatus} role='status'>{t('collect.runLookup.empty')}</p>
        )}
        {runLookup.kind === 'failed' && (
          <div className={css.reasonBanner} role='alert'>
            <span>{t('collect.runLookup.failed')}</span>
            <span className={css.reasonText}>{reasonText(runLookup.reason, t)}</span>
          </div>
        )}
        {runLookup.kind === 'hit' && <RunLookupResult t={t} run={runLookup.run} />}
      </DataCard>
    </div>
  )
}

/** run.get 命中结果：run 字段 + batches 批次表（tools 真实形状；枚举走字典）。 */
function RunLookupResult(props: { t: Translate; run: RunView }): ReactNode {
  const t = props.t
  const run = props.run
  return (
    <div className={css.runResult}>
      <dl className={css.metaGrid}>
        <MetaTerm t={t} label='collect.label.runId' value={run.runId ?? '—'} />
        <MetaTerm t={t} label='run.label.account' value={run.accountId ?? '—'} />
        {run.status !== null && <MetaTerm t={t} label='collect.label.status' value={statusText(run.status, t)} />}
        {run.errorCode !== null && <MetaTerm t={t} label='run.label.errorCode' value={reasonText(run.errorCode, t)} emphasis />}
        <MetaTerm t={t} label='collect.label.startedAt' value={formatDateTime(run.startedAt) ?? '—'} />
        {run.finishedAt !== null && <MetaTerm t={t} label='collect.label.finishedAt' value={formatDateTime(run.finishedAt) ?? run.finishedAt} />}
        <MetaTerm t={t} label='run.label.expected' value={formatCount(run.expectedWorkCount)} />
        <MetaTerm t={t} label='run.label.succeeded' value={formatCount(run.succeededWorkCount)} />
        <MetaTerm t={t} label='run.label.failed' value={formatCount(run.failedWorkCount)} />
      </dl>
      {run.batches.length > 0 && (
        // 窄容器横向滚动区域纳入 Tab 顺序（键盘可达滚动），带 localized 可访问名。
        <div className={css.batchTableWrap} role='region' aria-label={t('run.batchTable.label')} tabIndex={0}>
          <table className={css.batchTable}>
            <thead>
              <tr>
                <th scope='col' className={css.batchTh}>{t('run.batch.batchNo')}</th>
                <th scope='col' className={css.batchTh}>{t('run.batch.type')}</th>
                <th scope='col' className={css.batchTh}>{t('run.batch.status')}</th>
                <th scope='col' className={css.batchTh}>{t('run.batch.items')}</th>
                <th scope='col' className={css.batchTh}>{t('run.batch.succeeded')}</th>
                <th scope='col' className={css.batchTh}>{t('run.batch.failed')}</th>
              </tr>
            </thead>
            <tbody>
              {run.batches.map(batch => (
                <tr key={batch.batchNo} className={css.batchTr}>
                  <td className={css.batchTd}>{batch.batchNo}</td>
                  <td className={css.batchTd}>{batchTypeText(batch.batchType, t)}</td>
                  <td className={css.batchTd}>{batchStatusText(batch.batchStatus, t)}</td>
                  <td className={css.batchTd}>{formatCount(batch.itemCount)}</td>
                  <td className={css.batchTd}>{formatCount(batch.succeededCount)}</td>
                  <td className={css.batchTd}>{formatCount(batch.failedCount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 已知 batch_type 枚举（works / account_metrics / fans_trend / fans_profile）→ 文案；未知值原样展示。 */
function batchTypeText(value: string | null, t: Translate): string {
  switch (value) {
    case 'works': return t('run.batchType.works')
    case 'account_metrics': return t('run.batchType.accountMetrics')
    case 'fans_trend': return t('run.batchType.fansTrend')
    case 'fans_profile': return t('run.batchType.fansProfile')
    case null: return '—'
    default: return value
  }
}

/** 已知 batch_status 枚举（pending / succeeded / failed）→ 文案；「部分成功」由 succeeded 行的失败对象计数表达，不是服务端枚举。 */
function batchStatusText(value: string | null, t: Translate): string {
  switch (value) {
    case 'pending': return t('run.batchStatus.pending')
    case 'succeeded': return t('run.batchStatus.succeeded')
    case 'failed': return t('run.batchStatus.failed')
    case null: return '—'
    default: return value
  }
}

/** 已知状态 → collect.status.* 文案；未知状态原样展示（不猜语义）。 */
function statusText(status: string, t: Translate): string {
  switch (status) {
    case 'not_started': return t('collect.status.not_started')
    case 'running': return t('collect.status.running')
    case 'completed': return t('collect.status.completed')
    case 'partial': return t('collect.status.partial')
    case 'failed': return t('collect.status.failed')
    case 'cancelled': return t('collect.status.cancelled')
    case 'interrupted': return t('collect.status.interrupted')
    default: return status
  }
}

/** 运行记录的通用字段投影（当前任务 / 上次运行共用，attemptId/phase 为本地记录概念）。 */
function RunFields(props: {
  t: Translate
  attemptId: string | null
  runId: string | null
  status: string | null
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  worksCount: number | null
  progress: Record<string, unknown> | undefined
}): ReactNode {
  const t = props.t
  const phase = phaseDisplay(props.progress, t)
  const batchText = batchTextOf(props.progress, t)
  return (
    <dl className={css.metaGrid}>
      <MetaTerm t={t} label='collect.label.attemptId' value={props.attemptId ?? '—'} />
      <MetaTerm t={t} label='collect.label.runId' value={props.runId ?? '—'} />
      {props.status !== null && <MetaTerm t={t} label='collect.label.status' value={statusText(props.status, t)} />}
      {phase !== null && <MetaTerm t={t} label='collect.label.phase' value={phase} />}
      {batchText !== null && <MetaTerm t={t} label='collect.label.batch' value={batchText} />}
      <MetaTerm t={t} label='collect.label.startedAt' value={formatDateTime(props.startedAt) ?? '—'} />
      {props.finishedAt !== null && <MetaTerm t={t} label='collect.label.finishedAt' value={formatDateTime(props.finishedAt) ?? props.finishedAt} />}
      {props.worksCount !== null && <MetaTerm t={t} label='collect.label.works' value={formatCount(props.worksCount)} />}
      {props.error !== null && <MetaTerm t={t} label='collect.errorReason' value={reasonText(props.error, t)} emphasis />}
    </dl>
  )
}

function MetaTerm(props: { t: Translate; label: WxLocaleKey; value: string; emphasis?: boolean }): ReactNode {
  return (
    <div className={css.metaItem}>
      <dt className={css.metaTerm}>{props.t(props.label)}</dt>
      <dd className={props.emphasis === true ? `${css.metaValue} ${css.metaError}` : css.metaValue}>{props.value}</dd>
    </div>
  )
}

/** progress.phase → 文案（列表页码/详情进度/批次进度带数值）。 */
function phaseDisplay(progress: Record<string, unknown> | string | undefined, t: Translate): string | null {
  const phase = typeof progress === 'string' ? progress : progress?.phase
  if (typeof phase !== 'string') return null
  const values: Record<string, unknown> = typeof progress === 'object' && progress !== null ? progress : {}
  switch (phase) {
    case 'probing': return t('collect.phase.probing')
    case 'account_sync': return t('collect.phase.probing')
    case 'list': return t('collect.phase.list')
    case 'list_page': return t('collect.phase.list_page', { page: numberOrZero(values.page) })
    case 'details': return t('collect.phase.details', { done: numberOrZero(values.done), total: numberOrZero(values.total) })
    case 'ingest': return t('collect.phase.ingest', { batchNo: numberOrZero(values.batchNo), totalBatches: numberOrZero(values.totalBatches) })
    case 'finishing': return t('collect.phase.finishing')
    case 'run_started': return t('collect.phase.run_started')
    case 'run_persist_failed': return t('collect.phase.run_persist_failed')
    case 'account_level': return t('collect.phase.finishing')
    default: return null
  }
}

/** ingest 进度 → 批次进度行（#N/M · 成功 X · 失败 Y）。 */
function batchTextOf(progress: Record<string, unknown> | undefined, t: Translate): string | null {
  if (progress?.phase !== 'ingest') return null
  return `#${String(numberOrZero(progress.batchNo))}/${String(numberOrZero(progress.totalBatches))}`
    + ` · ${t('collect.batch.completed', { count: numberOrZero(progress.succeeded) })}`
    + ` · ${t('collect.batch.failed', { count: numberOrZero(progress.failed) })}`
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 当前任务的 runId：result.runId（终态）优先，progress.run_started（实时）兜底。 */
function runIdOf(record: CollectRecord): string | null {
  const fromResult = record.result?.runId
  if (typeof fromResult === 'string' && fromResult !== '') return fromResult
  const fromProgress = record.progress?.runId
  return typeof fromProgress === 'string' && fromProgress !== '' ? fromProgress : null
}

/** 当前任务的入库作品数（result.works）。 */
function worksOf(record: CollectRecord): number | null {
  const works = record.result?.works
  return typeof works === 'number' && Number.isFinite(works) ? works : null
}
