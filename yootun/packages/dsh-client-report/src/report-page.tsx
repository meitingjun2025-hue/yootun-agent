/**
 * AI 报表页（列表/详情双态，上移自抖音工作台 `ReportPage.tsx`，渲染结果与
 * 交互行为不变）：列表 = SegmentedControl 日报/周报（切换重置分页）+ 刷新 +
 * 7 列表（周期/状态 Tag 五态/版本/覆盖账号/生成时间/说明失败码文案/查看
 * ghost）+ 加载更多 + 空态；详情 = 工具栏（返回/版本 Menu/生成中·提交中
 * status/重新生成 RiskConfirmation/导出 HTML ghost）+ 详情正文。详情轮询 5s
 * 离开停（连续 5 次失败停）；「重新生成」确认后以 `{regenerateKeyPrefix}:
 * {reportId}:{32hex}` 幂等键提交，同一次点击的重试复用同键；HTML 导出自包含
 * 单文件（文件名 = filePrefix + 日报或周报 + 周期）。请求函数、错误文案、
 * 文件名前缀、幂等键前缀与作品卡指标布局由插件注入：本包不持有任何插件路径，
 * 也不解析任何稳定错误码。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, RiskConfirmation, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState } from '@yootun/dsh-client-ui-kit'
import css from './report.module.css'
import { attemptId, formatDateTime, shiftDay } from './format.ts'
import { createReportTranslate, type ReportLocaleKey, type ReportTranslate } from './locales.ts'
import { readReportDetail, readReportList, type ReportDetail, type ReportListItem, type ReportWork } from './schema.ts'
import { periodTitle, ReportDetailBody, ReportDetailSkeleton } from './report-detail.tsx'
import { serializeReportHtml } from './report-export.ts'

/** 作品卡的指标布局，由插件声明。 */
export interface ReportWorkLayout {
  /** 卡片主行，4 个计数指标。 */
  primary: ReadonlyArray<{ key: string; label: string }>
  /** 次要指标行。 */
  secondary: ReadonlyArray<{ key: string; label: string; kind: 'count' | 'percent' | 'seconds' }>
  /** 完播进度条；不传不渲染。 */
  progress?: { key: string; kind: 'percent'; label: string }
}

/** 报表页组件的 props（注入面见模块注释）。 */
export interface ReportPageProps {
  /** 请求函数：各插件用自己的 hostAction 构造。action 名为 report.list、report.get、report.regenerate。 */
  request: (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 当前语言：选择报表词条与数值、日期的格式。取值与两个插件页面的 localeTag 相同。 */
  locale: 'zh' | 'en'
  /** 稳定码到文案：报表码、连接失败码、路由拒绝码都经它解析；码为空时给出该域的默认文案。 */
  errorText: (code: string | null) => string
  /** 轻通知（导出完成、重新生成失败等）。 */
  onNotice: (text: string, tone?: 'success') => void
  /** 导出文件名前缀，由插件词典提供（如「抖音运营」「视频号运营」）。 */
  filePrefix: string
  /** 「重新生成」幂等键的前缀（如 douyin:report_regenerate），键为前缀加 reportId 加本包生成的后缀。 */
  regenerateKeyPrefix: string
  /** 请求失败的兜底码：request 抛非 Error 值与轮询连续 5 次失败时传给 errorText 的稳定码；不传传 null，由注入方给域默认文案。 */
  requestFailedCode?: string | undefined
  /** 作品卡的指标布局，由插件声明。 */
  work: ReportWorkLayout
  /** 作品卡的扩展区；视频号用它渲染流量来源与最大流失点，抖音不传。 */
  renderWorkExtra?: ((work: ReportWork) => ReactNode) | undefined
}

/** 报表页组件。 */
export function ReportPage(props: ReportPageProps): ReactNode {
  const t = createReportTranslate(props.locale)
  const [reportType, setReportType] = useState<'daily' | 'weekly'>('daily')
  const [items, setItems] = useState<ReportListItem[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  // 「加载更多」的失败提示（§4.5：失败列表保留已加载数据，按钮旁提示与重试；
  // 首屏失败才整块错误）。null = 无在途错误。
  const [moreError, setMoreError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ReportDetail | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [detailError, setDetailError] = useState<string | null>(null)
  const [versions, setVersions] = useState<ReportListItem[]>([])
  const [regenerating, setRegenerating] = useState(false)
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false)
  const [regenAck, setRegenAck] = useState(false)
  const [regenKey, setRegenKey] = useState<string | null>(null)
  const [exportingHtml, setExportingHtml] = useState(false)
  const cursorRef = useRef<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const listSeqRef = useRef(0)
  const detailSeqRef = useRef(0)
  const requestFailedCode = props.requestFailedCode ?? null

  const stopPolling = useCallback((): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => stopPolling, [stopPolling])

  const loadList = useCallback(async (options?: { more?: boolean }): Promise<void> => {
    const seq = ++listSeqRef.current
    if (options?.more === true) setLoadingMore(true)
    else {
      setListState('loading')
      setMoreError(null)
    }
    try {
      const res = await props.request('report.list', {
        reportType,
        limit: 20,
        ...(options?.more === true && cursorRef.current !== null ? { cursor: cursorRef.current } : {}),
      })
      if (listSeqRef.current !== seq) return
      const view = readReportList(res)
      cursorRef.current = view.nextCursor
      setHasMore(view.nextCursor !== null)
      setItems(previous => (options?.more === true ? [...previous, ...view.items] : view.items))
      setListState('ready')
      setListError(null)
      setMoreError(null)
    } catch (error) {
      if (listSeqRef.current !== seq) return
      // 加载更多失败保留已加载的行，只在按钮旁提示；首屏失败整块错误。
      if (options?.more === true) {
        setMoreError(error instanceof Error ? error.message : requestFailedCode)
      } else {
        setListState('error')
        setListError(error instanceof Error ? error.message : requestFailedCode)
      }
    } finally {
      if (listSeqRef.current === seq) setLoadingMore(false)
    }
  }, [props.request, requestFailedCode, reportType])

  useEffect(() => {
    cursorRef.current = null
    setItems([])
    void loadList()
  }, [loadList])

  /** 详情加载 + pending/running 5s 轮询（连续 5 次失败停）。 */
  const loadDetail = useCallback(async (reportId: string, options?: { silent?: boolean }): Promise<ReportDetail | null> => {
    const seq = ++detailSeqRef.current
    if (options?.silent !== true) setDetailState('loading')
    try {
      const res = await props.request('report.get', { reportId })
      if (detailSeqRef.current !== seq) return null
      const view = readReportDetail(res)
      setDetail(view)
      setDetailState('ready')
      setDetailError(null)
      return view
    } catch (error) {
      if (detailSeqRef.current !== seq) return null
      if (options?.silent !== true) {
        setDetailState('error')
        setDetailError(error instanceof Error ? error.message : requestFailedCode)
      }
      return null
    }
  }, [props.request, requestFailedCode])

  const openDetail = useCallback(async (reportId: string): Promise<void> => {
    stopPolling()
    setDetailId(reportId)
    setVersions([])
    const report = await loadDetail(reportId)
    if (report === null) return
    // 版本清单（只读切换；不触发模型）。
    void (async () => {
      try {
        const res = await props.request('report.list', {
          reportType: report.reportType,
          periodStart: report.periodStart ?? undefined,
          allVersions: true,
          limit: 50,
        })
        setVersions(readReportList(res).items)
      } catch {
        setVersions([])
      }
    })()
    if (report.status === 'pending' || report.status === 'running') {
      stopPolling()
      let failures = 0
      const tick = (): void => {
        void loadDetail(reportId, { silent: true }).then(latest => {
          if (latest === null) {
            failures += 1
            if (failures >= 5) {
              stopPolling()
              setDetailState('error')
              setDetailError(requestFailedCode)
            }
            return
          }
          failures = 0
          if (latest.status !== 'pending' && latest.status !== 'running') stopPolling()
        }).catch(() => undefined)
      }
      pollRef.current = setInterval(tick, 5000)
    }
  }, [loadDetail, props.request, requestFailedCode, stopPolling])

  const closeDetail = useCallback((): void => {
    stopPolling()
    setDetailId(null)
    setDetail(null)
    setVersions([])
    setRegenKey(null)
  }, [stopPolling])

  /** 重新生成（确认后；同一点击重试复用同键）。 */
  const regenerate = useCallback((): void => {
    if (detail === null || detailId === null) return
    const key = regenKey ?? `${props.regenerateKeyPrefix}:${detailId}:${attemptId()}`
    setRegenKey(key)
    setRegenerating(true)
    void (async () => {
      try {
        await props.request('report.regenerate', { reportId: detailId, idempotencyKey: key })
        setRegenKey(null)
        await openDetail(detailId)
      } catch (error) {
        props.onNotice(props.errorText(error instanceof Error ? error.message : null))
      } finally {
        setRegenerating(false)
      }
    })()
  }, [detail, detailId, openDetail, props, regenKey])

  /** HTML 导出：自包含单文件（token 解析内联 + details 全展开）。 */
  const exportHtml = useCallback((): void => {
    if (detail === null) return
    setExportingHtml(true)
    try {
      const html = serializeReportHtml(detail, t, props.locale)
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${reportFileStem(detail, props.filePrefix, t)}.html`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      props.onNotice(t('report.htmlDone'))
    } catch {
      props.onNotice(t('report.exportFailed'))
    } finally {
      setExportingHtml(false)
    }
  }, [detail, props, t])

  if (detailId !== null) {
    return (
      <div className={css.pageBody}>
        <div className={css.workToolbarRow}>
          <Button variant='ghost' size='sm' onClick={closeDetail}>{t('report.back')}</Button>
          <VersionMenu versions={versions} currentId={detailId} t={t} onSelect={id => { void openDetail(id) }} />
          <span className={css.workToolbarRow}>
            {(detail?.status === 'pending' || detail?.status === 'running') && (
              <span className={css.inlineHint} role='status'>{t('report.generating')}</span>
            )}
            {regenerating && <span className={css.inlineHint} role='status'>{t('report.submitting')}</span>}
            <Button
              variant='ghost'
              size='sm'
              disabled={(detail?.status === 'pending' || detail?.status === 'running') || regenerating}
              aria-busy={regenerating || undefined}
              onClick={() => { setRegenAck(false); setRegenConfirmOpen(true) }}
            >
              {regenerating ? t('report.submitting') : t('report.regenerate')}
            </Button>
            <Button variant='ghost' size='sm' disabled={exportingHtml || detail === null || detail.status === 'pending' || detail.status === 'running'} aria-busy={exportingHtml || undefined} onClick={exportHtml}>
              {exportingHtml ? t('report.exporting') : t('report.exportHtml')}
            </Button>
          </span>
        </div>
        {detailState === 'loading'
          ? (
            // §4.6：加载态与最终内容形状相似（KPI 数值骨架 + 趋势图形骨架 +
            // 账号表行骨架），不用整块骨架。
            <ReportDetailSkeleton t={t} weekly={(detail?.reportType ?? reportType) === 'weekly'} />
          )
          : (
            <DataState state={detailState} shape='block' onRetry={() => { if (detailId !== null) void loadDetail(detailId) }}>
              {detailState === 'error' && detailError !== null && (
                <p className={css.formError} role='alert'>{props.errorText(detailError)}</p>
              )}
              {detailState === 'ready' && detail !== null && (
                <ReportDetailBody
                  detail={detail}
                  t={t}
                  locale={props.locale}
                  errorText={props.errorText}
                  work={props.work}
                  renderWorkExtra={props.renderWorkExtra}
                  onRegenerate={() => { setRegenAck(false); setRegenConfirmOpen(true) }}
                />
              )}
            </DataState>
          )}
        {regenConfirmOpen && detail !== null && (
          <RiskConfirmation
            open
            title={t('report.regenerateTitle')}
            description={t('report.regenerateBody', { version: (detail.data?.coreMetrics.length ?? 0) >= 0 ? nextVersionOf(detail, versions) : 1 })}
            acknowledgeLabel={t('report.regenerateBody', { version: nextVersionOf(detail, versions) })}
            cancelLabel={t('report.cancel')}
            closeLabel={t('report.dialogClose')}
            confirmLabel={t('report.regenerateConfirm')}
            acknowledged={regenAck}
            onAcknowledgedChange={setRegenAck}
            onCancel={() => { setRegenConfirmOpen(false); setRegenAck(false) }}
            onConfirm={() => { setRegenConfirmOpen(false); regenerate() }}
          />
        )}
      </div>
    )
  }

  return (
    <div className={css.pageBody}>
      <div className={css.workToolbarRow}>
        <SegmentedControl
          id='yootun-report-type'
          options={[{ value: 'daily', label: t('report.daily') }, { value: 'weekly', label: t('report.weekly') }]}
          value={reportType}
          onChange={value => { setReportType(value) }}
          label={t('report.regionLabel')}
        />
        <Button variant='ghost' size='sm' disabled={listState === 'loading'} aria-busy={listState === 'loading' || undefined} onClick={() => { void loadList() }}>
          {listState === 'loading' ? t('report.refreshing') : t('report.refresh')}
        </Button>
      </div>
      {listState === 'error' && (
        <p className={css.formError} role='alert'>{props.errorText(listError)}</p>
      )}
      <DataState state={listState} shape='rows' onRetry={() => { void loadList() }}>
        {listState === 'ready' && items.length === 0 && (
          <div className={css.emptyState} role='status'><p>{t('report.empty')}</p></div>
        )}
        {items.length > 0 && (
          <div className={css.tableWrap} role='region' aria-label={t('report.regionLabel')} tabIndex={0}>
            <table className={css.dataTable} aria-label={t('report.regionLabel')}>
              <thead>
                <tr>
                  {[t('report.col.period'), t('report.col.status'), t('report.col.version'), t('report.col.coverage'),
                    t('report.col.generatedAt'), t('report.col.note'), ''].map((label, index) => (
                      <th key={index} scope='col' className={index === 6 ? css.cellAction : undefined}>{label}</th>
                    ))}
                </tr>
              </thead>
              <tbody>
                {items.map(item => {
                  const pill = statusPill(item)
                  return (
                    <tr key={item.reportId}>
                      <td className={css.cellMain}>{periodTitle({ reportType: item.reportType, periodStart: item.periodStart, periodEnd: item.periodEnd }, t)}</td>
                      <td><Tag tone={pill.tone}>{t(pill.label)}</Tag></td>
                      <td>{item.version === null ? '—' : `v${item.version}`}</td>
                      <td>{item.coveredAccounts !== null || item.totalAccounts !== null ? `${item.coveredAccounts ?? '—'}/${item.totalAccounts ?? '—'}` : '—'}</td>
                      <td>{formatDateTime(item.finishedAt ?? item.createdAt)}</td>
                      <td className={css.cellNote}>
                        {item.status === 'failed' && item.errorCode !== null
                          ? props.errorText(item.errorCode)
                          : item.summary ?? '—'}
                      </td>
                      <td className={css.cellAction}><Button variant='ghost' size='sm' onClick={() => { void openDetail(item.reportId) }}>{t('report.view')}</Button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && items.length > 0 && (
          <div className={css.loadMoreRow}>
            <Button variant='ghost' size='sm' disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => { void loadList({ more: true }) }}>
              {t('report.loadMore')}
            </Button>
            {moreError !== null && (
              <span className={css.loadMoreError}>
                <span className={css.formError} role='alert'>{props.errorText(moreError)}</span>
                <Button variant='ghost' size='sm' onClick={() => { void loadList({ more: true }) }}>{t('report.retry')}</Button>
              </span>
            )}
          </div>
        )}
      </DataState>
    </div>
  )
}

/** 版本 Menu（v{n} · 状态 · 当前）。 */
function VersionMenu(props: { versions: ReportListItem[]; currentId: string; t: ReportTranslate; onSelect: (id: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  if (props.versions.length === 0) return null
  const current = props.versions.find(item => item.reportId === props.currentId)
  const labelOf = (item: ReportListItem): string => {
    const pill = statusPill(item)
    return `v${item.version ?? '—'} · ${props.t(pill.label)}${item.isCurrent || item.reportId === props.currentId ? props.t('report.versionCurrent') : ''}`
  }
  return (
    <Menu
      open={open}
      anchor={(
        <Button
          variant='outline'
          size='sm'
          aria-haspopup='menu'
          aria-expanded={open}
          aria-label={props.t('report.version')}
          onClick={() => { setOpen(value => !value) }}
        >
          {current !== undefined ? labelOf(current) : props.t('report.version')}
        </Button>
      )}
      items={props.versions.map(item => ({ id: item.reportId, label: labelOf(item) }))}
      selectedId={props.currentId}
      onSelect={id => {
        setOpen(false)
        props.onSelect(id)
      }}
      onClose={() => { setOpen(false) }}
    />
  )
}

/** 状态 → Tag tone + 词典键（五态）。 */
function statusPill(item: { status: string; coreAvailable: boolean | null }): { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: ReportLocaleKey } {
  if (item.status === 'succeeded') {
    return item.coreAvailable === false
      ? { tone: 'warning', label: 'report.status.incomplete' }
      : { tone: 'success', label: 'report.status.succeeded' }
  }
  if (item.status === 'failed') return { tone: 'danger', label: 'report.status.failed' }
  if (item.status === 'insufficient') return { tone: 'warning', label: 'report.status.insufficient' }
  return { tone: 'neutral', label: 'report.status.running' }
}

/** 下一版本号（当前版本 + 1；无版本信息回退 1）。 */
function nextVersionOf(detail: ReportDetail, versions: ReportListItem[]): number {
  const current = versions.find(item => item.reportId === detail.reportId)?.version ?? null
  return (current ?? 0) + 1
}

/** 导出文件名主干（{filePrefix}{日报|周报}_{start}；前缀由插件 props 给出）。 */
function reportFileStem(detail: ReportDetail, filePrefix: string, t: ReportTranslate): string {
  const start = detail.periodStart ?? ''
  if (detail.reportType === 'weekly') {
    return `${filePrefix}${t('report.weekly')}_${start}~${shiftDay(detail.periodEnd ?? '', -1)}`
  }
  return `${filePrefix}${t('report.daily')}_${start}`
}
