/**
 * 爆款拆解页（旧 breakdown.js 布局与任务动线重译）：新建与下载区（链接输入 +
 * 规则单选 + 开始拆解 primary + 下载直链 ghost + 归档受理横幅）+ 历史列表
 * （状态筛选 + 5 列表 + 加载更多）+ 详情页（返回/导出/重新改写工具栏 + 状态徽标
 * + 8 步进度 + 候选 6 KPI + 五折叠卡：原视频拆解/口播全文/仿写分镜/拍摄脚本/
 * 规则回显）。异步语义：归档 3s 轮询 → completed 自动发起工作流；工作流 5s
 * 轮询（优先 retryAfterSeconds，连续 5 次失败停）；下载直链 5s×210 次对齐服务
 * 端软时限；重新改写与强制重试均确认后新幂等键发起，IDEMPOTENCY_OUTCOME_UNKNOWN
 * 不自动换键。拍摄脚本 Markdown 表格解析为纯文本表格渲染（无 HTML 注入面）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard, DataState, FilterMenu, KpiCard, ytChartStyle, isOnInteractiveTarget } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { domainErrorText, formatCount, formatDateTime, formatRateRatio, type Translate, attemptId } from './format.ts'
import css from './workbench.module.css'
import {
  asrTranscriptOf, readArchiveRun, readBreakdownDetail, readBreakdownHistory, readBreakdownWorkflows,
  readDownloadJob, readRewriteRules, type BreakdownDetail, type BreakdownHistoryRow,
  type BreakdownSegment, type DownloadJobView, type RewriteRuleRow, type ShotScriptView,
  type WorkflowRow,
} from './schema.ts'
import { downloadBase64 } from './OverviewPage.tsx'

const ARCHIVE_POLL_MS = 3000
const WORKFLOW_POLL_MS = 5000
const WORKFLOW_POLL_MAX_FAILURES = 5
const DOWNLOAD_POLL_MS = 5000
const DOWNLOAD_POLL_MAX_ATTEMPTS = 210
const HISTORY_LIMIT_DEFAULT = 10
const HISTORY_LIMIT_MAX = 200

/** workflow 状态 → 徽标语义（未登记值按进行中处理，不误报成功/失败）。 */
export function breakdownStatusTone(status: string): 'ok' | 'error' | 'warn' | 'running' {
  const tones: Record<string, 'ok' | 'error' | 'warn' | 'running'> = {
    succeeded: 'ok',
    failed: 'error',
    cancelled: 'warn',
    invalid_input: 'error',
    idempotency_conflict: 'error',
    needs_input: 'warn',
    queued: 'running',
    running: 'running',
    waiting: 'running',
  }
  return tones[status] ?? 'running'
}

/** 历史状态筛选（纯前端 tone 归一过滤：失败 = error + warn）。 */
export type BreakdownStatusFilter = 'all' | 'running' | 'succeeded' | 'failed'

export function filterBreakdownHistory(rows: BreakdownHistoryRow[], filter: BreakdownStatusFilter): BreakdownHistoryRow[] {
  if (filter === 'succeeded') return rows.filter(row => breakdownStatusTone(row.status) === 'ok')
  if (filter === 'failed') {
    return rows.filter(row => {
      const tone = breakdownStatusTone(row.status)
      return tone === 'error' || tone === 'warn'
    })
  }
  if (filter === 'running') return rows.filter(row => breakdownStatusTone(row.status) === 'running')
  return rows
}

/** 服务端 workflow 失败 errorCode（小写蛇形）→ 词典键。 */
export function workflowErrorKey(workflow: WorkflowRow): string {
  const codes: Record<string, string> = {
    unknown_rewrite_rule: 'bd.wf.unknownRule',
    candidate_not_found: 'bd.wf.candidateNotFound',
    idempotency_conflict: 'bd.wf.conflict',
    invalid_input: 'bd.wf.invalidInput',
    needs_product_input: 'bd.wf.needsInput',
    soft_time_limit: 'bd.wf.retryable',
    waiting_timeout: 'bd.wf.retryable',
    nonretryable_step: 'bd.wf.failed',
    storyboard_quality: 'bd.wf.retryable',
  }
  return codes[workflow.errorCode ?? ''] ?? 'bd.wf.failed'
}

/** 拍摄脚本 Markdown 表格解析：`|` 分隔块（表头 + `---` 分隔线）→ 纯文本表格。 */
export function shotScriptTable(markdown: string): { head: string[]; rows: string[][]; paragraphs: string[] } {
  const lines = markdown.split(/\r?\n/)
  const head: string[] = []
  const rows: string[][] = []
  const paragraphs: string[] = []
  const splitRow = (line: string): string[] => {
    const text = line.trim()
    if (!text.startsWith('|')) return []
    const body = text.endsWith('|') ? text.slice(1, -1) : text.slice(1)
    return body.split('|').map(cell => cell.trim())
  }
  let i = 0
  while (i < lines.length) {
    const cells = splitRow(lines[i] ?? '')
    const separator = /^[\s|:-]+$/u.test(lines[i + 1] ?? '')
    if (cells.length >= 2 && separator) {
      head.push(...cells)
      i += 2
      while (i < lines.length) {
        const row = splitRow(lines[i] ?? '')
        if (row.length < 2) break
        rows.push(row)
        i += 1
      }
      continue
    }
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed !== '') paragraphs.push(trimmed)
    i += 1
  }
  return { head, rows, paragraphs }
}

export interface BreakdownPageProps {
  t: Translate
  /** 顶级 Tab 是否当前展示（keep-alive：inactive 时隐藏并保留状态与轮询）。 */
  active: boolean
  onNotice: (text: string) => void
  /** 素材看板「去拆解」预填链接（带入聚焦，不自动开始；消费后回调清空）。 */
  prefill: string | null
  onPrefillConsumed: () => void
}

/** 爆款拆解页组件（主视图 ↔ 详情页双态）。 */
export function BreakdownPage(props: BreakdownPageProps): ReactNode {
  const t = props.t
  const active = props.active
  const [rules, setRules] = useState<RewriteRuleRow[]>([])
  const [rulesState, setRulesState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [shareUrl, setShareUrl] = useState('')
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [archivePending, setArchivePending] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadValidationError, setDownloadValidationError] = useState(false)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const [downloadResult, setDownloadResult] = useState<DownloadJobView | null>(null)
  const [history, setHistory] = useState<BreakdownHistoryRow[]>([])
  const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyLimit, setHistoryLimit] = useState(HISTORY_LIMIT_DEFAULT)
  const [loadingMore, setLoadingMore] = useState(false)
  const [statusFilter, setStatusFilter] = useState<BreakdownStatusFilter>('all')
  const [detailWorkflow, setDetailWorkflow] = useState<WorkflowRow | null>(null)
  const [detail, setDetail] = useState<BreakdownDetail | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailError, setDetailError] = useState<string | null>(null)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [rewriteSubmitting, setRewriteSubmitting] = useState(false)
  const [forceConfirmOpen, setForceConfirmOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const shareInputRef = useRef<HTMLInputElement | null>(null)
  const archivePollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const archiveRunRef = useRef<string | null>(null)
  const workflowPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const workflowIdRef = useRef<string | null>(null)
  const detailSeqRef = useRef(0)
  const detailWorkflowRef = useRef<WorkflowRow | null>(null)
  const lastRuleRef = useRef<string | null>(null)
  const pendingWorkflowRef = useRef<{ candidateId: string; rewriteRuleId: string | null } | null>(null)
  const downloadSeqRef = useRef(0)
  const historyLimitRef = useRef(HISTORY_LIMIT_DEFAULT)
  useEffect(() => { detailWorkflowRef.current = detailWorkflow }, [detailWorkflow])

  const stopArchivePolling = useCallback((): void => {
    if (archivePollRef.current !== null) {
      clearInterval(archivePollRef.current)
      archivePollRef.current = null
    }
  }, [])

  const stopWorkflowPolling = useCallback((): void => {
    if (workflowPollRef.current !== null) {
      clearInterval(workflowPollRef.current)
      workflowPollRef.current = null
    }
    workflowIdRef.current = null
  }, [])

  useEffect(() => () => {
    stopArchivePolling()
    stopWorkflowPolling()
    detailSeqRef.current += 1
    downloadSeqRef.current += 1
  }, [stopArchivePolling, stopWorkflowPolling])

  const loadRules = useCallback(async (): Promise<void> => {
    setRulesState('loading')
    try {
      const res = await hostAction('breakdown.rewriteRules', {})
      setRules(readRewriteRules(res))
      setRulesState('ready')
    } catch {
      setRulesState('error')
    }
  }, [])

  const loadHistory = useCallback(async (limit?: number): Promise<void> => {
    const pageLimit = Math.min(Math.max(limit ?? historyLimitRef.current, 1), HISTORY_LIMIT_MAX)
    setHistoryState(previous => (previous === 'ready' ? 'ready' : 'loading'))
    try {
      const res = await hostAction('breakdown.history', { limit: pageLimit })
      setHistory(readBreakdownHistory(res))
      setHistoryLimit(pageLimit)
      historyLimitRef.current = pageLimit
      setHistoryState('ready')
      setHistoryError(null)
    } catch (error) {
      setHistoryState('error')
      setHistoryError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    }
  }, [])

  // Tab 激活（含首次挂载）刷新规则清单与拆解历史（旧客户端 Tab 进入口径；
  // limit 沿用当前已加载页大小）。archive/workflow 轮询不随 inactive 停止。
  useEffect(() => {
    if (!props.active) return
    void loadRules()
    void loadHistory()
  }, [props.active, loadRules, loadHistory])

  // 素材看板「去拆解」外部预填：同步进受控输入并聚焦；只预填不自动开始。
  useEffect(() => {
    if (props.prefill === null || props.prefill.trim() === '') return
    setShareUrl(props.prefill.trim())
    shareInputRef.current?.focus()
    props.onPrefillConsumed()
  }, [props])

  const loadDetail = useCallback(async (candidateId: string): Promise<void> => {
    const seq = ++detailSeqRef.current
    setDetailState('loading')
    setDetailError(null)
    try {
      const res = await hostAction('breakdown.detail', { candidateId })
      if (detailSeqRef.current !== seq) return
      setDetail(readBreakdownDetail(res))
      setDetailState('ready')
    } catch (error) {
      if (detailSeqRef.current !== seq) return
      setDetail(null)
      setDetailState('error')
      setDetailError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    }
  }, [])

  /** 详情页 workflow 轮询（优先 workflowId；间隔取 retryAfterSeconds 下限 5s）。 */
  const startWorkflowPolling = useCallback((target: Pick<WorkflowRow, 'workflowId'> & Partial<WorkflowRow>): void => {
    const workflowId = target.workflowId
    if (workflowId === null) return
    stopWorkflowPolling()
    workflowIdRef.current = workflowId
    let interval = Math.max(WORKFLOW_POLL_MS, (target.retryAfterSeconds ?? 0) * 1000)
    let failures = 0
    const tick = (): void => {
      void hostAction('breakdown.workflowStatus', { workflowId }).then(res => {
        if (workflowIdRef.current !== workflowId) return
        const latest = readBreakdownWorkflows(res).workflows[0]
        if (latest === undefined) return
        failures = 0
        setDetailWorkflow(previous => (previous === null ? previous : { ...previous, ...latest }))
        const next = Math.max(WORKFLOW_POLL_MS, (latest.retryAfterSeconds ?? 0) * 1000)
        if (next !== interval && workflowPollRef.current !== null) {
          clearInterval(workflowPollRef.current)
          interval = next
          workflowPollRef.current = setInterval(tick, interval)
        }
        if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled') {
          stopWorkflowPolling()
          if (latest.status === 'succeeded') void loadDetail(latest.candidateId)
        }
      }).catch(() => {
        // 单次失败静默重试；连续失败达上限停轮询（用户可返回重进恢复）。
        failures += 1
        if (failures >= WORKFLOW_POLL_MAX_FAILURES) stopWorkflowPolling()
      })
    }
    workflowPollRef.current = setInterval(tick, interval)
  }, [loadDetail, stopWorkflowPolling])

  /** workflow 受理：succeeded 直接拉明细；运行态启动轮询；同步失败交详情文案。 */
  const startWorkflow = useCallback(async (candidateId: string, rewriteRuleId: string | null, options?: { force?: boolean }): Promise<void> => {
    setDetail(null)
    setDetailError(null)
    setExportError(null)
    lastRuleRef.current = rewriteRuleId
    const merged: WorkflowRow = detailWorkflowRef.current !== null && detailWorkflowRef.current.candidateId === candidateId
      ? detailWorkflowRef.current
      : emptyWorkflow(candidateId)
    setDetailWorkflow(merged)
    detailWorkflowRef.current = merged
    try {
      const res = await hostAction('breakdown.workflowStart', {
        candidateId,
        // 冻结契约（分册 15）：拆解工作流为风险写操作，路由 requireTrue 确认位。
        confirm: true,
        idempotencyKey: `douyin:vv_workflow:${attemptId()}`,
        ...(rewriteRuleId !== null ? { rewriteRuleId } : {}),
        ...(options?.force === true ? { force: true } : {}),
      })
      const workflow = readBreakdownWorkflows({ workflows: [res.workflow] }).workflows[0] ?? merged
      const next = { ...merged, ...workflow }
      setDetailWorkflow(next)
      detailWorkflowRef.current = next
      if (next.status === 'succeeded') await loadDetail(next.candidateId)
      else if (next.status === 'queued' || next.status === 'running' || next.status === 'waiting') {
        startWorkflowPolling(next)
        void loadDetail(next.candidateId)
      } else {
        // 同步失败 payload（failed/needs_input/invalid_input/idempotency_conflict）。
        setDetailState('ready')
        setDetail({ storyboards: [], analysis: null, analysisError: null, candidate: null, candidateError: null })
      }
    } catch (error) {
      setDetailState('error')
      setDetailError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    }
  }, [loadDetail, startWorkflowPolling])

  /** 主视图受理：归档 → 轮询 completed → 刷新历史 → 自动发起工作流。 */
  const startBreakdown = useCallback((): void => {
    const value = shareUrl.trim()
    if (value === '' || submitting) return
    setSubmitting(true)
    setStartError(null)
    void (async () => {
      try {
        const res = await hostAction('breakdown.archiveStart', {
          shareUrl: value,
          // 冻结契约（分册 15）：归档为风险写操作，路由 requireTrue 确认位。
          confirm: true,
          idempotencyKey: `douyin:vv_archive:${attemptId()}`,
        })
        const archive = readArchiveRun(res)
        if (archive === null) {
          setStartError('douyin_operation_request_failed')
          return
        }
        setShareUrl('')
        setSelectedRuleId(null)
        setArchivePending(true)
        archiveRunRef.current = archive.runId
        stopArchivePolling()
        archivePollRef.current = setInterval(() => {
          void hostAction('breakdown.archiveStatus', { runId: archive.runId }).then(poll => {
            if (archiveRunRef.current !== archive.runId) return
            const latest = readArchiveRun(poll)
            if (latest === null) return
            if (latest.runStatus === 'completed') {
              stopArchivePolling()
              archiveRunRef.current = null
              setArchivePending(false)
              void loadHistory()
              if (latest.candidateId !== null) {
                if (detailWorkflowRef.current !== null) {
                  // 用户在看他详情页：挂起自动启动，返回列表时补启动。
                  pendingWorkflowRef.current = { candidateId: latest.candidateId, rewriteRuleId: selectedRuleId }
                } else {
                  void startWorkflow(latest.candidateId, selectedRuleId)
                }
              } else {
                setStartError('bd.error.archiveFailed')
              }
            } else if (latest.runStatus === 'failed' || latest.runStatus === 'cancelled' || latest.runStatus === 'partial_failed') {
              stopArchivePolling()
              archiveRunRef.current = null
              setArchivePending(false)
              setStartError('bd.error.archiveFailed')
            }
          }).catch(() => undefined)
        }, ARCHIVE_POLL_MS)
      } catch (error) {
        setStartError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      } finally {
        setSubmitting(false)
      }
    })()
  }, [loadHistory, selectedRuleId, startWorkflow, stopArchivePolling, submitting, shareUrl])

  /** 抖音视频稳定下载：start 受理 → 5s 轮询（≤210 次对齐服务端 990s 软时限）。 */
  const downloadVideo = useCallback((): void => {
    const value = shareUrl.trim()
    setDownloadValidationError(false)
    if (value === '') {
      setDownloadValidationError(true)
      return
    }
    if (downloading || submitting) return
    const seq = ++downloadSeqRef.current
    setDownloading(true)
    setDownloadError(null)
    setDownloadResult(null)
    void (async () => {
      try {
        const startRes = await hostAction('breakdown.downloadStart', {
          shareUrl: value,
          idempotencyKey: `douyin:vv_download:${attemptId()}`,
        })
        const started = readDownloadJob(startRes)
        if (started?.jobId == null) {
          setDownloadError('bd.error.downloadFailed')
          return
        }
        const jobId = started.jobId
        for (let attempt = 0; attempt < DOWNLOAD_POLL_MAX_ATTEMPTS; attempt += 1) {
          await new Promise(resolve => { setTimeout(resolve, DOWNLOAD_POLL_MS) })
          if (downloadSeqRef.current !== seq) return
          const statusRes = await hostAction('breakdown.downloadStatus', { jobId })
          if (downloadSeqRef.current !== seq) return
          const download = readDownloadJob(statusRes)
          if (download === null) continue
          if (download.status === 'ready') {
            if (download.downloadUrl === null) {
              setDownloadError('bd.error.downloadMissing')
              return
            }
            setDownloadResult(download)
            return
          }
          if (download.status === 'failed') {
            setDownloadError(download.errorCode ?? 'bd.error.downloadFailed')
            return
          }
        }
        setDownloadError('bd.error.downloadFailed')
      } catch (error) {
        if (downloadSeqRef.current !== seq) return
        setDownloadError(error instanceof Error ? error.message : 'bd.error.downloadFailed')
      } finally {
        if (downloadSeqRef.current === seq) setDownloading(false)
      }
    })()
  }, [downloading, shareUrl, submitting])

  /** 历史行进入详情：拉明细；运行态记录同时启动 workflow 轮询。归档轮询不受
   * 影响（旧语义：归档继续推进；完成时用户在详情页则挂起 pending workflow，
   * 返回列表时补启动——由 startBreakdown 轮询回调写入 pendingWorkflowRef）。 */
  const openDetail = useCallback((row: BreakdownHistoryRow): void => {
    if (row.candidateId === '') return
    setDetailWorkflow(row)
    detailWorkflowRef.current = row
    setExportError(null)
    void loadDetail(row.candidateId)
    if (breakdownStatusTone(row.status) === 'running') startWorkflowPolling(row)
  }, [loadDetail, startWorkflowPolling])

  /** 返回列表：停全部轮询、失效在途请求、复位详情态并刷新历史。 */
  const backToList = useCallback((): void => {
    stopWorkflowPolling()
    stopArchivePolling()
    archiveRunRef.current = null
    detailSeqRef.current += 1
    const pending = pendingWorkflowRef.current
    pendingWorkflowRef.current = null
    setArchivePending(false)
    setDetailWorkflow(null)
    detailWorkflowRef.current = null
    setDetail(null)
    setDetailError(null)
    setExportError(null)
    setRewriteOpen(false)
    setForceConfirmOpen(false)
    void loadHistory()
    if (pending !== null) void startWorkflow(pending.candidateId, pending.rewriteRuleId)
  }, [loadHistory, startWorkflow, stopArchivePolling, stopWorkflowPolling])

  const confirmRewrite = useCallback((ruleId: string | null): void => {
    setRewriteOpen(false)
    const current = detailWorkflowRef.current
    if (current === null || current.candidateId === '') return
    setRewriteSubmitting(true)
    void startWorkflow(current.candidateId, ruleId).finally(() => { setRewriteSubmitting(false) })
  }, [startWorkflow])

  /** 强制重试：force=true；规则 natural key 与失败记录保持一致。 */
  const forceRetry = useCallback((): void => {
    const current = detailWorkflowRef.current
    if (current === null || current.candidateId === '') return
    setForceConfirmOpen(false)
    setRewriteSubmitting(true)
    const ruleId = current.hasRewriteRuleKey ? current.rewriteRuleId : lastRuleRef.current
    void startWorkflow(current.candidateId, ruleId, { force: true }).finally(() => { setRewriteSubmitting(false) })
  }, [startWorkflow])

  /** 详情导出（多 sheet XLSX base64 下载）；错误独立轻提示不替换页面。 */
  const exportDetail = useCallback((): void => {
    const current = detailWorkflowRef.current
    if (current === null || current.candidateId === '') return
    setExporting(true)
    setExportError(null)
    void (async () => {
      try {
        const res = await hostAction('breakdown.export', { candidateId: current.candidateId })
        downloadBase64(
          typeof res.file_name === 'string' ? res.file_name : 'douyin-storyboard-export.xlsx',
          typeof res.content_base64 === 'string' ? res.content_base64 : '',
          typeof res.mime_type === 'string' ? res.mime_type : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
      } catch (error) {
        setExportError(error instanceof Error ? error.message : 'export_failed')
      } finally {
        setExporting(false)
      }
    })()
  }, [])

  if (detailWorkflow !== null) {
    return (
      <div className={css.pageBody} style={ytChartStyle}>
        <BreakdownDetailView
          t={t}
          active={active}
          workflow={detailWorkflow}
          detail={detail}
          detailState={detailState}
          detailError={detailError}
          rules={rules}
          exporting={exporting}
          exportError={exportError}
          rewriteSubmitting={rewriteSubmitting}
          forceConfirmOpen={forceConfirmOpen}
          onBack={backToList}
          onExport={exportDetail}
          onRequestRewrite={() => { setRewriteOpen(true) }}
          onForceRetry={() => { setForceConfirmOpen(true) }}
          onForceCancel={() => { setForceConfirmOpen(false) }}
          onForceConfirm={forceRetry}
        />
        {active && rewriteOpen && (
          <BreakdownRewriteModal
            t={t}
            rules={rules}
            submitting={rewriteSubmitting}
            onConfirm={confirmRewrite}
            onClose={() => { setRewriteOpen(false) }}
          />
        )}
      </div>
    )
  }

  const filtered = filterBreakdownHistory(history, statusFilter)
  return (
    <div className={css.pageBody} style={ytChartStyle}>
      <DataCard title={t('bd.newTitle')}>
        <div className={css.bdNewRow}>
          <Input
            ref={shareInputRef}
            id='douyin-bd-share-url'
            value={shareUrl}
            placeholder={t('bd.sharePlaceholder')}
            aria-label={t('bd.shareLabel')}
            disabled={submitting}
            onChange={event => { setShareUrl(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') startBreakdown() }}
          />
          <Button variant='primary' disabled={submitting || shareUrl.trim() === ''} aria-busy={submitting || undefined} onClick={startBreakdown}>
            {submitting ? t('bd.submitting') : t('bd.startButton')}
          </Button>
          <Button variant='ghost' disabled={downloading || submitting} aria-busy={downloading || undefined} onClick={downloadVideo}>
            {downloading ? t('bd.downloading') : t('bd.downloadButton')}
          </Button>
        </div>
        {(downloadValidationError || downloadError !== null) && (
          <p className={css.formError} role='alert'>
            {downloadValidationError
              ? t('bd.downloadRequired')
              : downloadError !== null && downloadError.startsWith('bd.')
                ? t(downloadError as 'bd.error.downloadFailed')
                : downloadError !== null
                  ? domainErrorText('bd', downloadError, t)
                  : ''}
          </p>
        )}
        {startError !== null && (
          <p className={css.formError} role='alert'>
            {startError.startsWith('bd.') ? t(startError as 'bd.error.archiveFailed') : domainErrorText('bd', startError, t)}
          </p>
        )}
        {archivePending && (
          <p className={css.inlineStatus} role='status' aria-busy='true'>
            <StateDot state='ongoing' />
            {t('bd.archivePending')}
          </p>
        )}
        <div className={css.bdRulesField}>
          <p className={css.bdFieldLabel}>
            {t('bd.rulesLabel')}
            <span className={css.bdFieldLabelOpt}>{t('bd.rulesOptional')}</span>
          </p>
          {rulesState === 'error'
            ? (
              <div className={css.bdRulesError}>
                <p className={css.formError} role='alert'>{t('bd.error.rulesFailed')}</p>
                <Button variant='ghost' size='sm' onClick={() => { void loadRules() }}>{t('bd.rulesRetry')}</Button>
              </div>
            )
            : (
              <BreakdownRulePicker
                rules={rules}
                value={selectedRuleId}
                disabled={submitting}
                emptyText={rulesState === 'loading' ? t('state.loading') : t('bd.rulesEmpty')}
                onSelect={setSelectedRuleId}
              />
            )}
        </div>
        <p className={css.inlineHint}>{t('bd.rulesHint')}</p>
      </DataCard>

      <DataCard
        title={t('bd.historyLabel')}
        description={t('bd.historySub')}
        actions={(
          <FilterMenu
            label={t('bd.filterLabel')}
            visibleLabel={t('bd.col.status')}
            currentLabel={t(`bd.filter.${statusFilter}` as 'bd.filter.all')}
            items={([
              { id: 'all', label: t('bd.filter.all') },
              { id: 'running', label: t('bd.filter.running') },
              { id: 'succeeded', label: t('bd.filter.succeeded') },
              { id: 'failed', label: t('bd.filter.failed') },
            ] as const)}
            selectedId={statusFilter}
            onSelect={id => { setStatusFilter(id as BreakdownStatusFilter) }}
          />
        )}
      >
        {historyState === 'error' && historyError !== null && (
          <p className={css.formError} role='alert'>{domainErrorText('bd', historyError, t)}</p>
        )}
        <DataState state={historyState} shape='rows' onRetry={() => { void loadHistory() }}>
          {historyState === 'ready' && history.length === 0 && (
            <div className={css.emptyState} role='status'><p>{t('bd.historyEmpty')}</p></div>
          )}
          {historyState === 'ready' && history.length > 0 && filtered.length === 0 && (
            <div className={css.emptyState} role='status'><p>{t('bd.historyEmptyFiltered')}</p></div>
          )}
          {filtered.length > 0 && (
            <div className={css.tableWrap} role='region' aria-label={t('bd.historyLabel')} tabIndex={0}>
              <table className={css.dataTable} aria-label={t('bd.historyLabel')}>
                <thead>
                  <tr>
                    {[t('bd.col.video'), t('bd.col.status'), t('bd.col.rule'), t('bd.col.step'), t('bd.col.time'), t('action.viewDetail')].map(label => <th key={label} scope='col'>{label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(row => (
                    <BreakdownHistoryRowView key={`${row.candidateId}-${row.workflowId ?? ''}`} row={row} rules={rules} t={t} onOpen={() => { openDetail(row) }} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {history.length >= historyLimit && historyLimit < HISTORY_LIMIT_MAX && (
            <div className={css.tableMeta}>
              <Button variant='ghost' size='sm' disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => {
                setLoadingMore(true)
                void loadHistory(historyLimit + HISTORY_LIMIT_DEFAULT).finally(() => { setLoadingMore(false) })
              }}>
                {t('bd.loadMore')}
              </Button>
            </div>
          )}
        </DataState>
      </DataCard>

      {active && downloadResult !== null && (
        <BreakdownDownloadModal result={downloadResult} t={t} onClose={() => { setDownloadResult(null) }} />
      )}
    </div>
  )
}

/** 空 workflow 形态（受理前占位；candidateId 恒有）。 */
function emptyWorkflow(candidateId: string): WorkflowRow {
  return {
    workflowId: null, candidateId, status: '', currentStep: null, currentStepLabel: null,
    candidateTitle: null, candidateAuthor: null, candidatePlayCount: null, rewriteRuleId: null,
    hasRewriteRuleKey: false, updatedAt: null, retryAfterSeconds: null, errorCode: null,
  }
}

/** 规则胶囊配色数（按规则在服务端清单中的位次循环取色；同规则恒同色）。 */
const RULE_TONE_COUNT = 5

function ruleToneOf(rules: readonly RewriteRuleRow[], ruleId: string): number {
  const index = rules.findIndex(item => item.rewriteRuleId === ruleId)
  return index < 0 ? 1 : (index % RULE_TONE_COUNT) + 1
}

/** 规则胶囊（旧 ydo-bd-rule-pill 同构：淡色底 + 同色文字；不同规则取不同色）。 */
function RulePill(props: { rules: readonly RewriteRuleRow[]; ruleId: string; name: string }): ReactNode {
  return (
    <span className={css.bdRulePill} data-tone={String(ruleToneOf(props.rules, props.ruleId))}>
      {props.name}
    </span>
  )
}

/** 历史行（视频列两行：标题 + @作者 · 播放 N；行键盘可达）。 */
function BreakdownHistoryRowView(props: { row: BreakdownHistoryRow; rules: RewriteRuleRow[]; t: Translate; onOpen: () => void }): ReactNode {
  const rule = props.rules.find(item => item.rewriteRuleId === props.row.rewriteRuleId) ?? null
  return (
    <tr
      tabIndex={0}
      aria-label={`${props.row.candidateTitle ?? props.row.candidateId}，${props.t('bd.row.openAria')}`}
      onDoubleClick={event => { if (!isOnInteractiveTarget(event)) props.onOpen() }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
    >
      <td className={css.cellMain}>
        <span className={css.bdRowTitle}>{props.row.candidateTitle ?? props.row.candidateId}</span>
        <span className={css.bdRowSub}>
          {props.row.candidateAuthor !== null ? `@${props.row.candidateAuthor}` : null}
          {props.row.candidateAuthor !== null && props.row.candidatePlayCount !== null ? ` · ${props.t('bd.playLabel')} ${formatCount(props.row.candidatePlayCount)}` : null}
          {props.row.hasStoryboard ? ` · ${props.t('bd.hasStoryboard')}` : ''}
        </span>
      </td>
      <td><BreakdownStatusBadge status={props.row.status} t={props.t} /></td>
      <td>{rule !== null ? <RulePill rules={props.rules} ruleId={rule.rewriteRuleId} name={rule.name ?? rule.rewriteRuleId} /> : <span className={css.inlineHint}>{props.t('bd.ruleDefault')}</span>}</td>
      <td>
        {breakdownStatusTone(props.row.status) === 'error'
          ? props.t('bd.status.failed')
          : props.row.currentStepLabel ?? '—'}
      </td>
      <td>{formatDateTime(props.row.updatedAt)}</td>
      <td className={css.colAction}>
        <Button
          variant='ghost'
          size='sm'
          onClick={event => {
            event.stopPropagation()
            props.onOpen()
          }}
        >
          {props.t('action.viewDetail')}
        </Button>
      </td>
    </tr>
  )
}

/** 状态徽标（Tag tone 附文字；needs_input 专属文案）。 */
function BreakdownStatusBadge(props: { status: string; t: Translate }): ReactNode {
  const tone = breakdownStatusTone(props.status)
  const label = props.status === 'needs_input'
    ? props.t('bd.status.needsInput')
    : tone === 'ok' ? props.t('bd.status.succeeded')
      : tone === 'error' ? props.t('bd.status.failed')
        : tone === 'warn' ? props.t('bd.status.cancelled')
          : props.t('bd.status.running')
  const tagTone = tone === 'ok' ? 'success' : tone === 'error' ? 'danger' : tone === 'warn' ? 'warning' : 'neutral'
  return <Tag tone={tagTone}>{label}</Tag>
}

/** 仿写规则单选卡组（新建区与重新改写弹层共用；再点一次取消选中）。 */
function BreakdownRulePicker(props: {
  rules: RewriteRuleRow[]
  value: string | null
  disabled: boolean
  emptyText: string
  onSelect: (value: string | null) => void
}): ReactNode {
  if (props.rules.length === 0) {
    return <p className={css.inlineHint}>{props.emptyText}</p>
  }
  return (
    <div className={css.bdRules} role='radiogroup'>
      {props.rules.map(rule => (
        <button
          key={rule.rewriteRuleId}
          type='button'
          className={css.bdRadio}
          role='radio'
          aria-checked={props.value === rule.rewriteRuleId}
          disabled={props.disabled}
          onClick={() => { props.onSelect(props.value === rule.rewriteRuleId ? null : rule.rewriteRuleId) }}
        >
          <span className={css.bdRadioName}>{rule.name ?? rule.rewriteRuleId}</span>
          {rule.description !== null ? <span className={css.bdRadioDesc}>{rule.description}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** 8 步进度条（当前步高亮、之前步已过、失败整体灰态）。 */
const WORKFLOW_STEPS: readonly string[] = [
  'archive_original', 'transcode_audio', 'asr', 'extract_frames',
  'vision', 'breakdown', 'storyboard', 'shot_script',
]

function StepProgress(props: { workflow: WorkflowRow; t: Translate }): ReactNode {
  const currentIndex = WORKFLOW_STEPS.indexOf(props.workflow.currentStep ?? '')
  const done = props.workflow.status === 'succeeded' || props.workflow.currentStep === 'completed'
  return (
    <ol className={css.bdSteps} aria-label={props.t('bd.progressLabel')}>
      {WORKFLOW_STEPS.map((step, index) => {
        const active = !done && index === currentIndex
        const passed = done || (currentIndex >= 0 && index < currentIndex)
        const state = active ? 'active' : passed ? 'done' : 'todo'
        return (
          <li
            key={step}
            className={css.bdStep}
            data-state={state}
            aria-current={active ? 'step' : undefined}
          >
            <span className={css.bdStepBar} aria-hidden='true' />
            <span className={css.bdStepName}>{props.t(`bd.step.${step}` as 'bd.step.asr')}</span>
          </li>
        )
      })}
    </ol>
  )
}

/** 详情页组件（工具栏 + 头部 + KPI + 五折叠卡）。 */
function BreakdownDetailView(props: {
  t: Translate
  active: boolean
  workflow: WorkflowRow
  detail: BreakdownDetail | null
  detailState: 'loading' | 'ready' | 'error'
  detailError: string | null
  rules: RewriteRuleRow[]
  exporting: boolean
  exportError: string | null
  rewriteSubmitting: boolean
  forceConfirmOpen: boolean
  onBack: () => void
  onExport: () => void
  onRequestRewrite: () => void
  onForceRetry: () => void
  onForceCancel: () => void
  onForceConfirm: () => void
}): ReactNode {
  const t = props.t
  const workflow = props.workflow
  const storyboardRow = props.detail?.storyboards[0] ?? null
  const original = storyboardRow
    ? { summary: storyboardRow.originalSummary, segments: storyboardRow.originalSegments }
    : null
  const rewritten = storyboardRow
    ? { summary: storyboardRow.rewrittenSummary, segments: storyboardRow.rewrittenSegments }
    : null
  const transcript = props.detail !== null ? asrTranscriptOf(props.detail.analysis) : null
  const ruleResolved = storyboardRow?.ruleId !== null && storyboardRow !== null
    ? props.rules.find(item => item.rewriteRuleId === storyboardRow.ruleId) ?? null
    : null
  const failed = breakdownStatusTone(workflow.status) === 'error' || workflow.status === 'needs_input'
  const retryable = workflow.status === 'failed'
  const exportable = workflow.status === 'succeeded' && storyboardRow !== null
  const pending = !failed && breakdownStatusTone(workflow.status) === 'running'
  const shareUrl = props.detail?.candidate?.shareUrl ?? null

  if (props.detailState === 'error') {
    return (
      <div className={css.workToolbarRow}>
        <Button variant='ghost' size='sm' onClick={props.onBack}>{t('bd.backToList')}</Button>
        <p className={css.formError} role='alert'>
          {props.detailError !== null ? domainErrorText('bd', props.detailError, t) : t('bd.error.default')}
        </p>
      </div>
    )
  }

  return (
    <div className={css.bdPage}>
      <div className={css.workToolbarRow}>
        <Button variant='ghost' size='sm' onClick={props.onBack}>{t('bd.backToList')}</Button>
        <span className={css.workToolbarRow}>
          <Button
            variant='ghost'
            size='sm'
            disabled={!exportable || props.exporting}
            aria-busy={props.exporting || undefined}
            onClick={props.onExport}
          >
            {props.exporting ? t('works.exporting') : t('bd.exportExcel')}
          </Button>
          <Button
            variant='ghost'
            size='sm'
            disabled={pending || props.detailState === 'loading' || props.rewriteSubmitting}
            onClick={props.onRequestRewrite}
          >
            {t('bd.rewriteButton')}
          </Button>
        </span>
      </div>
      {props.exportError !== null && (
        <p className={css.formError} role='alert'>{domainErrorText('bd', props.exportError, t)}</p>
      )}
      <DataCard title={workflow.candidateTitle ?? workflow.candidateId}>
        <div className={css.bdHeadRow}>
          <div className={css.bdHeadMain}>
            <p className={css.bdHeadMeta}>
              {workflow.candidateAuthor !== null ? <span>@{workflow.candidateAuthor}</span> : null}
              {props.detail?.candidate?.publishedAt != null ? <span>{t('bd.publishedAt')} {formatDateTime(props.detail.candidate.publishedAt)}</span> : null}
              {shareUrl !== null ? <a href={shareUrl} target='_blank' rel='noreferrer noopener'>{t('bd.originalLink')}</a> : null}
            </p>
          </div>
          <BreakdownStatusBadge status={workflow.status} t={t} />
        </div>
        <StepProgress workflow={workflow} t={t} />
        {props.detail?.candidateError !== null && props.detail !== null && (
          <p className={css.inlineHint} role='status'>{t('bd.candidateDegraded')}{domainErrorText('bd', props.detail.candidateError, t)}</p>
        )}
        {failed && (
          <div className={css.bdErrorActions}>
            <p className={css.formError} role='alert'>{t(workflowErrorKey(workflow) as 'bd.wf.failed')}</p>
            {retryable && (
              <Button variant='ghost' size='sm' disabled={props.detailState === 'loading' || props.rewriteSubmitting} onClick={props.onForceRetry}>
                {t('bd.forceRetry')}
              </Button>
            )}
          </div>
        )}
      </DataCard>

      {props.detail?.candidate != null && (
        <div className={css.kpiRow}>
          <KpiCard label={t('bd.kpi.play')} value={formatCount(props.detail.candidate.playCount)} />
          <KpiCard label={t('bd.kpi.like')} value={formatCount(props.detail.candidate.likeCount)} />
          <KpiCard label={t('bd.kpi.comment')} value={formatCount(props.detail.candidate.commentCount)} />
          <KpiCard label={t('bd.kpi.collect')} value={formatCount(props.detail.candidate.collectCount)} />
          <KpiCard label={t('bd.kpi.share')} value={formatCount(props.detail.candidate.shareCount)} />
          <KpiCard label={t('bd.kpi.interaction')} value={formatRateRatio(props.detail.candidate.interactionRate)} />
        </div>
      )}

      {props.detailState === 'loading' && storyboardRow === null
        ? <p className={css.inlineHint} role='status' aria-busy='true'>{t('state.loading')}</p>
        : storyboardRow === null
          ? (
            <div className={css.emptyState} role='status'>
              <p>{pending ? t('bd.runningTitle') : t('bd.detailEmpty')}</p>
              <p className={css.inlineHint}>{pending ? t('bd.runningSub') : t('bd.detailEmptySub')}</p>
            </div>
          )
          : (
            <div className={css.bdCards}>
              <FoldCard title={t('bd.card.original')} tone='summary' defaultOpen digest={original?.summary !== null && original !== null ? original.summary.slice(0, 60) : null}>
                {original !== null
                  ? (
                    <div className={css.bdCardBodyGap}>
                      {original.summary !== null ? <blockquote className={css.bdQuote}>{original.summary}</blockquote> : null}
                      <OriginalSegmentTable segments={original.segments} t={t} />
                    </div>
                  )
                  : <p className={css.inlineHint}>{t('bd.sectionPending')}</p>}
              </FoldCard>
              <FoldCard
                title={t('bd.card.transcript')}
                tone='dims'
                digest={transcript !== null ? `${t('bd.digest.asr')} · ${transcript.length}${t('bd.digest.charUnit')}` : null}
              >
                {transcript !== null
                  ? <blockquote className={css.bdQuote}>{transcript}</blockquote>
                  : <p className={css.inlineHint}>{t('bd.sectionPending')}</p>}
              </FoldCard>
              <FoldCard
                title={t('bd.card.storyboard')}
                tone='patterns'
                defaultOpen
                digest={rewritten !== null
                  ? `${rewritten.segments.length}${t('bd.segmentUnit')}${ruleResolved !== null ? ` · ${ruleResolved.name ?? ruleResolved.rewriteRuleId}` : ''}`
                  : null}
              >
                {rewritten !== null
                  ? (
                    <div className={css.bdCardBodyGap}>
                      {rewritten.summary !== null ? <p className={css.inlineHint}>{rewritten.summary}</p> : null}
                      <RewrittenSegmentList segments={rewritten.segments} originalSegments={original?.segments ?? null} t={t} />
                    </div>
                  )
                  : <p className={css.inlineHint}>{t('bd.sectionPending')}</p>}
              </FoldCard>
              <FoldCard title={t('bd.card.shotScript')} tone='recs' digest={storyboardRow.shotScript.quotaDigest}>
                <ShotScriptBlock shotScript={storyboardRow.shotScript} t={t} />
              </FoldCard>
              <FoldCard
                title={t('bd.card.rule')}
                tone='dims'
                digest={ruleResolved !== null ? ruleResolved.name ?? ruleResolved.rewriteRuleId : t('bd.ruleDefault')}
              >
                {ruleResolved !== null
                  ? (
                    <div className={css.bdRuleUsed}>
                      <div>
                        <RulePill rules={props.rules} ruleId={ruleResolved.rewriteRuleId} name={ruleResolved.name ?? ruleResolved.rewriteRuleId} />
                        {ruleResolved.description !== null && ruleResolved.description !== ruleResolved.name
                          ? <span className={css.inlineHint}>{ruleResolved.description}</span>
                          : null}
                      </div>
                      {storyboardRow.rulePrompt !== null && storyboardRow.rulePrompt !== ruleResolved.description
                        ? <p className={css.inlineHint}>{storyboardRow.rulePrompt}</p>
                        : null}
                    </div>
                  )
                  : <p className={css.inlineHint}>{t('bd.ruleNone')}</p>}
              </FoldCard>
            </div>
          )}

      {props.active && props.forceConfirmOpen && (
        <Modal
          open
          title={t('bd.forceRetryTitle')}
          closeLabel={t('dialog.close')}
          onClose={props.onForceCancel}
          footer={(
            <>
              <Button variant='ghost' onClick={props.onForceCancel}>{t('bd.cancel')}</Button>
              <Button variant='primary' disabled={props.rewriteSubmitting} aria-busy={props.rewriteSubmitting || undefined} onClick={props.onForceConfirm}>
                {props.rewriteSubmitting ? t('bd.rewriteSubmitting') : t('bd.forceRetryConfirm')}
              </Button>
            </>
          )}
        >
          <p className={css.inlineHint}>{t('bd.forceRetryBody')}</p>
        </Modal>
      )}
    </div>
  )
}

/** 折叠卡（复用 AI 分析折叠卡结构 aiCard；原视频拆解与仿写分镜默认展开）。 */
function FoldCard(props: { title: string; tone: 'summary' | 'dims' | 'patterns' | 'recs'; defaultOpen?: boolean; digest: string | null; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen === true)
  return (
    <section className={css.aiCard} data-tone={props.tone}>
      <button type='button' className={css.aiCardToggle} aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span className={css.aiArrow} aria-hidden='true'>▶</span>
        <span className={css.aiCardTitle}>{props.title}</span>
        {props.digest !== null ? <span className={css.aiCardDigest}>{props.digest}</span> : null}
      </button>
      {open ? <div className={css.aiCardBody}>{props.children}</div> : null}
    </section>
  )
}

/** 原视频分段表（时间/角色/画面/口播四列）。 */
function OriginalSegmentTable(props: { segments: BreakdownSegment[]; t: Translate }): ReactNode {
  const t = props.t
  return (
    <div className={css.tableWrap}>
      <table className={css.dataTable}>
        <thead>
          <tr>
            {[t('bd.col.time'), t('bd.col.role'), t('bd.col.visual'), t('bd.col.speech')].map(label => <th key={label} scope='col'>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {props.segments.map((segment, index) => (
            <tr key={index}>
              <td>{segment.timeRange ?? '—'}</td>
              <td><RoleTag role={segment.role} t={t} /></td>
              <td>{segment.originalVisual ?? '—'}</td>
              <td>{segment.originalSpeech ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 段落角色标签（hook/build/turn/cta；未登记走「其他」）。 */
function RoleTag(props: { role: string | null; t: Translate }): ReactNode {
  const roles: readonly string[] = ['hook', 'build', 'turn', 'cta']
  const key = props.role !== null && roles.includes(props.role) ? props.role : 'other'
  return <Tag>{props.t(`bd.role.${key}` as 'bd.role.hook')}</Tag>
}

/** 改写分镜卡列表（来源段落标注 + 原片段引用 + 新口播 + 画面提示）。 */
function RewrittenSegmentList(props: { segments: BreakdownSegment[]; originalSegments: BreakdownSegment[] | null; t: Translate }): ReactNode {
  const t = props.t
  return (
    <div className={css.bdShotList}>
      {props.segments.map((segment, index) => {
        const sources = segment.sourceSegmentIndexes
        const sourceTexts = sources
          .map(i => {
            const row = props.originalSegments?.[i - 1]
            return row?.originalSpeech != null ? `#${i} ${row.originalSpeech}` : null
          })
          .filter((text): text is string => text !== null)
        return (
          <div key={index} className={css.bdShot}>
            <div className={css.bdShotHead}>
              <RoleTag role={segment.role} t={t} />
              <span className={css.bdSegTime}>{segment.timeRange ?? '—'}</span>
              <span className={css.bdSegSource}>
                {t('bd.sourceFrom')} {sources.length > 0 ? sources.map(i => `#${i}`).join(' ') : '—'}
              </span>
            </div>
            {sourceTexts.length > 0
              ? (
                <p className={css.bdShotSrc}>
                  <span className={css.bdShotPrefix}>{t('bd.shot.srcPrefix')}</span>
                  {sourceTexts.join('；')}
                </p>
              )
              : null}
            {segment.rewrittenSpeech !== null
              ? (
                <p className={css.bdShotCopy}>
                  <span className={css.bdShotPrefix}>{t('bd.shot.copyPrefix')}</span>
                  {segment.rewrittenSpeech}
                </p>
              )
              : null}
            {segment.rewrittenVisual !== null
              ? (
                <p className={css.bdShotVisual}>
                  <span className={css.bdShotPrefix}>{t('bd.shot.visualPrefix')}</span>
                  {segment.rewrittenVisual}
                </p>
              )
              : null}
          </div>
        )
      })}
    </div>
  )
}

/** 拍摄脚本：Markdown 表格纯文本渲染 + 表外段落。 */
function ShotScriptBlock(props: { shotScript: ShotScriptView; t: Translate }): ReactNode {
  if (props.shotScript.status !== 'succeeded' || props.shotScript.markdown === null) {
    return <p className={css.inlineHint}>{props.t('bd.sectionPending')}</p>
  }
  const parsed = shotScriptTable(props.shotScript.markdown)
  return (
    <div>
      {parsed.head.length > 0
        ? (
          <div className={css.tableWrap}>
            <table className={css.dataTable}>
              <thead>
                <tr>{parsed.head.map((cell, index) => <th key={index} scope='col'>{cell}</th>)}</tr>
              </thead>
              <tbody>
                {parsed.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
      {parsed.paragraphs.map((text, index) => <p key={index} className={css.bdShotNote}>{text}</p>)}
    </div>
  )
}

/** 下载直链结果弹窗（临时直链 + 备用播放链接）。 */
function BreakdownDownloadModal(props: { result: DownloadJobView; t: Translate; onClose: () => void }): ReactNode {
  const t = props.t
  return (
    <Modal
      open
      title={t('bd.download.title')}
      closeLabel={t('dialog.close')}
      onClose={props.onClose}
      footer={<Button variant='ghost' onClick={props.onClose}>{t('dialog.close')}</Button>}
    >
      {props.result.title !== null ? <p className={css.bdDownloadTitle}>{props.result.title}</p> : null}
      <p>
        <a href={props.result.downloadUrl ?? '#'} target='_blank' rel='noreferrer' download>{t('bd.download.action')}</a>
      </p>
      {props.result.fallbackPlayUrl !== null
        ? <p><a href={props.result.fallbackPlayUrl} target='_blank' rel='noreferrer'>{t('bd.download.fallback')}</a></p>
        : null}
      <p className={css.inlineHint}>{t('bd.download.hint')}</p>
    </Modal>
  )
}

/** 重新改写确认弹层（规则单选；null = 默认链路）。 */
function BreakdownRewriteModal(props: {
  t: Translate
  rules: RewriteRuleRow[]
  submitting: boolean
  onConfirm: (ruleId: string | null) => void
  onClose: () => void
}): ReactNode {
  const [ruleId, setRuleId] = useState<string | null>(null)
  const t = props.t
  return (
    <Modal
      open
      title={t('bd.rewriteTitle')}
      closeLabel={t('dialog.close')}
      onClose={props.onClose}
      footer={(
        <>
          <Button variant='ghost' disabled={props.submitting} onClick={props.onClose}>{t('bd.cancel')}</Button>
          <Button
            variant='primary'
            disabled={props.submitting}
            aria-busy={props.submitting || undefined}
            onClick={() => { props.onConfirm(ruleId); setRuleId(null) }}
          >
            {props.submitting ? t('bd.rewriteSubmitting') : t('bd.rewriteStart')}
          </Button>
        </>
      )}
    >
      <p className={css.inlineHint}>{t('bd.rewriteHint')}</p>
      <BreakdownRulePicker rules={props.rules} value={ruleId} disabled={props.submitting} emptyText={t('bd.rulesEmpty')} onSelect={setRuleId} />
    </Modal>
  )
}
