/**
 * run 查询 Dialog（作品工具栏的次级操作）：runId 查询 → run 字段 + 16 类批次
 * 表。载荷按 tools 真实形状 `{ run, batches }` 消费；`RUN_NOT_FOUND` /
 * `RUN_ACCOUNT_MISMATCH` 是确定性「无此运行」，其余失败以失败态呈现，不伪装
 * 成未找到。官方 Modal 承载 Escape / 焦点回归。
 * @module
 */
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostAction } from './api.ts'
import { formatCount, formatDateTime, reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { readRunView, type RunView } from './schema.ts'

/** run.get 查询结果状态：idle / busy / 命中 / 未命中 / 失败（稳定 reason）。 */
type RunLookupState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'hit'; run: RunView }
  | { kind: 'not_found' }
  | { kind: 'failed'; reason: string }

/** 稳定码集合：命中这个集合的查询失败按「未找到」呈现，其余按失败呈现。 */
const RUN_NOT_FOUND_CODES = new Set(['RUN_NOT_FOUND', 'RUN_ACCOUNT_MISMATCH'])

export interface RunQueryDialogProps {
  t: Translate
  open: boolean
  onClose: () => void
}

/** run 查询 Dialog 组件。 */
export function RunQueryDialog(props: RunQueryDialogProps): ReactNode {
  const t = props.t
  const [runQuery, setRunQuery] = useState('')
  const [lookup, setLookup] = useState<RunLookupState>({ kind: 'idle' })
  const lookupSeqRef = useRef(0)

  const lookupRun = useCallback(async (): Promise<void> => {
    const runId = runQuery.trim()
    if (runId === '') return
    // 请求代次守卫：快速连续查询时旧响应不得覆盖新结果。
    const seq = ++lookupSeqRef.current
    setLookup({ kind: 'busy' })
    try {
      const res = await hostAction('run.get', { runId })
      if (lookupSeqRef.current !== seq) return
      const run = readRunView(res)
      // 无 run 对象（含 RUN_NOT_FOUND 之外的空载荷）同样按未命中呈现。
      setLookup(run === null ? { kind: 'not_found' } : { kind: 'hit', run })
    } catch (error) {
      if (lookupSeqRef.current !== seq) return
      const reason = error instanceof Error ? error.message : 'unknown'
      // RUN_NOT_FOUND / RUN_ACCOUNT_MISMATCH 是确定性的「无此运行」；其余
      // （网络 / 服务失败）必须以失败态呈现，不得伪装成未找到。
      setLookup(RUN_NOT_FOUND_CODES.has(reason) ? { kind: 'not_found' } : { kind: 'failed', reason })
    }
  }, [runQuery])

  return (
    <Modal
      open={props.open}
      onClose={() => { props.onClose() }}
      title={t('collect.runLookup.title')}
      closeLabel={t('dialog.close')}
      className={css.runDialog as string}
    >
      <div className={css.runLookup}>
        <Input
          type='text'
          value={runQuery}
          placeholder={t('collect.runLookup.placeholder')}
          aria-label={t('collect.runLookup.placeholder')}
          onChange={event => { setRunQuery(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void lookupRun() }}
        />
        <Button variant='outline' size='sm' disabled={runQuery.trim() === '' || lookup.kind === 'busy'}
          onClick={() => { void lookupRun() }}>
          {t('collect.runLookup.action')}
        </Button>
      </div>
      {lookup.kind === 'not_found' && (
        <p className={css.collectStatus} role='status'>{t('collect.runLookup.empty')}</p>
      )}
      {lookup.kind === 'failed' && (
        <div className={css.reasonBanner} role='alert'>
          <span>{t('collect.runLookup.failed')}</span>
          <span className={css.reasonText}>{reasonText(lookup.reason, t)}</span>
        </div>
      )}
      {lookup.kind === 'hit' && <RunResult t={t} run={lookup.run} />}
    </Modal>
  )
}

/** run.get 命中结果：run 字段 + batches 批次表（tools 真实形状；枚举走字典）。 */
function RunResult(props: { t: Translate; run: RunView }): ReactNode {
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

function MetaTerm(props: { t: Translate; label: Parameters<Translate>[0]; value: string; emphasis?: boolean }): ReactNode {
  return (
    <div className={css.metaItem}>
      <dt className={css.metaTerm}>{props.t(props.label)}</dt>
      <dd className={props.emphasis === true ? `${css.metaValue} ${css.metaError}` : css.metaValue}>{props.value}</dd>
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

/** 已知 run 状态 → collect.status.* 文案；未知状态原样展示（不猜语义）。 */
export function statusText(status: string, t: Translate): string {
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
