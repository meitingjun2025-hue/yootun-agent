/**
 * AI 报表页（列表/详情双态）：列表 = SegmentedControl 日报/周报（切换重置分页）
 * + 刷新 + 7 列表（周期/状态 Tag 五态/版本/覆盖账号/生成时间/说明失败码文案/
 * 查看 ghost）+ 加载更多 + 空态；详情 = 工具栏（返回/版本 Menu/生成中·提交中
 * status/重新生成 RiskConfirmation「将基于当前已回补数据追加新版本 v{n}，旧版本
 * 保留」+ 继续生成 primary 同键重试/导出 HTML ghost）+ 报表头 meta
 * （对比基准/KPI 口径/互动口径/作品口径/标注说明 + QualityBar）+ KPI 行（涨红
 * 跌绿 ▲▼ + 上期值 + 无对比基准 flat）+ 趋势图（柱+线，缺采断开不补零，末位
 * 深色）+ 账号表 9 列（「—*」无快照口径）+ 作品卡（5s 完播进度条）+ 异常列表
 * + AI 洞察三列（事实/推断/建议 + 展开完整依据 details）+ 数据不足态（信号
 * 清单 + 重新生成）。详情轮询 5s 离开停；HTML 导出自包含单文件（details
 * 全展开 + token 内联 + 文件名 抖音运营{日报|周报}_{start}）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, RiskConfirmation, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard, DataState } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { domainErrorText, formatCount, formatDateTime, formatPercent, reasonText, shiftDay, type Translate, attemptId } from './format.ts'
import css from './workbench.module.css'
import { readReportDetail, readReportList, type ReportDetail, type ReportListItem } from './schema.ts'
import { ReportComboChart } from './charts.tsx'

type ReportType = 'daily' | 'weekly'

export interface ReportPageProps {
  t: Translate
  localeTag: string
  onNotice: (text: string) => void
}

/** 报表页组件。 */
export function ReportPage(props: ReportPageProps): ReactNode {
  const t = props.t
  const [reportType, setReportType] = useState<ReportType>('daily')
  const [items, setItems] = useState<ReportListItem[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
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
    else setListState('loading')
    try {
      const res = await hostAction('report.list', {
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
    } catch (error) {
      if (listSeqRef.current !== seq) return
      setListState('error')
      setListError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    } finally {
      if (listSeqRef.current === seq) setLoadingMore(false)
    }
  }, [reportType])

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
      const res = await hostAction('report.get', { reportId })
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
        setDetailError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      }
      return null
    }
  }, [])

  const openDetail = useCallback(async (reportId: string): Promise<void> => {
    stopPolling()
    setDetailId(reportId)
    setVersions([])
    const report = await loadDetail(reportId)
    if (report === null) return
    // 版本清单（只读切换；不触发模型）。
    void (async () => {
      try {
        const res = await hostAction('report.list', {
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
              setDetailError('douyin_operation_request_failed')
            }
            return
          }
          failures = 0
          if (latest.status !== 'pending' && latest.status !== 'running') stopPolling()
        }).catch(() => undefined)
      }
      pollRef.current = setInterval(tick, 5000)
    }
  }, [loadDetail, stopPolling])

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
    const key = regenKey ?? `douyin:report_regenerate:${detailId}:${attemptId()}`
    setRegenKey(key)
    setRegenerating(true)
    void (async () => {
      try {
        await hostAction('report.regenerate', { reportId: detailId, idempotencyKey: key })
        setRegenKey(null)
        await openDetail(detailId)
      } catch (error) {
        props.onNotice(domainErrorText('report', error instanceof Error ? error.message : null, t))
      } finally {
        setRegenerating(false)
      }
    })()
  }, [detail, detailId, openDetail, props, regenKey, t])

  /** HTML 导出：自包含单文件（token 解析内联 + details 全展开）。 */
  const exportHtml = useCallback((): void => {
    if (detail === null) return
    setExportingHtml(true)
    try {
      const html = serializeReportHtml(detail, t, props.localeTag)
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${reportFileStem(detail, t)}.html`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      props.onNotice(t('report.htmlDone'))
    } catch {
      props.onNotice(reasonText('export_failed', t))
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
              onClick={() => { setRegenAck(false); setRegenConfirmOpen(true) }}
            >
              {t('report.regenerate')}
            </Button>
            <Button variant='ghost' size='sm' disabled={exportingHtml || detail === null || detail.status === 'pending' || detail.status === 'running'} aria-busy={exportingHtml || undefined} onClick={exportHtml}>
              {exportingHtml ? t('report.exporting') : t('report.exportHtml')}
            </Button>
          </span>
        </div>
        <DataState state={detailState} shape='block' onRetry={() => { if (detailId !== null) void loadDetail(detailId) }}>
          {detailState === 'error' && detailError !== null && (
            <p className={css.formError} role='alert'>{domainErrorText('report', detailError, t)}</p>
          )}
          {detailState === 'ready' && detail !== null && <ReportDetailBody detail={detail} t={t} localeTag={props.localeTag} onRegenerate={() => { setRegenAck(false); setRegenConfirmOpen(true) }} />}
        </DataState>
        {regenConfirmOpen && detail !== null && (
          <RiskConfirmation
            open
            title={t('report.regenerateTitle')}
            description={t('report.regenerateBody', { version: (detail.data?.coreMetrics.length ?? 0) >= 0 ? nextVersionOf(detail, versions) : 1 })}
            acknowledgeLabel={t('report.regenerateBody', { version: nextVersionOf(detail, versions) })}
            cancelLabel={t('report.cancel')}
            closeLabel={t('dialog.close')}
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
          id='douyin-report-type'
          options={[{ value: 'daily', label: t('report.daily') }, { value: 'weekly', label: t('report.weekly') }]}
          value={reportType}
          onChange={value => { setReportType(value) }}
          label={t('tab.report')}
        />
        <Button variant='ghost' size='sm' disabled={listState === 'loading'} aria-busy={listState === 'loading' || undefined} onClick={() => { void loadList() }}>
          {listState === 'loading' ? t('schedule.refreshing') : t('report.refresh')}
        </Button>
      </div>
      {listState === 'error' && listError !== null && (
        <p className={css.formError} role='alert'>{domainErrorText('report', listError, t)}</p>
      )}
      <DataState state={listState} shape='rows' onRetry={() => { void loadList() }}>
        {listState === 'ready' && items.length === 0 && (
          <div className={css.emptyState} role='status'><p>{t('report.empty')}</p></div>
        )}
        {items.length > 0 && (
          <div className={css.tableWrap} role='region' aria-label={t('tab.report')} tabIndex={0}>
            <table className={css.dataTable} aria-label={t('tab.report')}>
              <thead>
                <tr>
                  {[t('report.col.period'), t('report.col.status'), t('report.col.version'), t('report.col.coverage'),
                    t('report.col.generatedAt'), t('report.col.note'), ''].map((label, index) => <th key={index} scope='col'>{label}</th>)}
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
                          ? domainErrorText('report', item.errorCode, t)
                          : item.summary ?? '—'}
                      </td>
                      <td><Button variant='ghost' size='sm' onClick={() => { void openDetail(item.reportId) }}>{t('report.view')}</Button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {hasMore && items.length > 0 && (
          <Button variant='ghost' size='sm' className={css.loadMore} disabled={loadingMore} aria-busy={loadingMore || undefined} onClick={() => { void loadList({ more: true }) }}>
            {t('report.loadMore')}
          </Button>
        )}
      </DataState>
    </div>
  )
}

/** 报表详情正文（头部 meta + KPI + 趋势 + 账号表 + 作品卡 + 异常 + AI 洞察）。 */
function ReportDetailBody(props: { detail: ReportDetail; t: Translate; localeTag: string; onRegenerate: () => void }): ReactNode {
  const t = props.t
  const detail = props.detail
  const weekly = detail.reportType === 'weekly'
  if (detail.status === 'insufficient') {
    const coverage = detail.data?.coverage ?? null
    const signals = coverage?.signals ?? { dailyRows: null, workSnapshotRows: null, fansProfileRows: null, periodWorks: null }
    const dailyMissing = coverage?.insufficientReason === 'daily_missing'
      || (signals.dailyRows === 0 && ((signals.workSnapshotRows ?? 0) > 0 || (signals.periodWorks ?? 0) > 0))
    return (
      <div className={css.reportInsufficient} role='status'>
        <p>{dailyMissing ? t('report.insufficient.daily') : t('report.insufficient.all')}</p>
        <ul className={css.signalList}>
          {([
            ['dailyRows', t('report.insufficient.dailyRows')],
            ['workSnapshotRows', t('report.insufficient.workSnapshotRows')],
            ['fansProfileRows', t('report.insufficient.fansProfileRows')],
            ['periodWorks', t('report.insufficient.periodWorks')],
          ] as const).map(([key, label]) => (
            <li key={key}>{t('report.insufficient.rows', { count: formatCount(signals[key] ?? null, props.localeTag) })} · {label}</li>
          ))}
        </ul>
        <Button variant='primary' size='sm' onClick={props.onRegenerate}>{t('report.regenerate')}</Button>
      </div>
    )
  }
  if (detail.data === null) {
    if (detail.status === 'pending' || detail.status === 'running') {
      return (
        <div className={css.reportWaiting} role='status'>
          <p className={css.emptyState}>{t('report.waitingTitle')}</p>
          <p className={css.inlineHint}>{t('report.waitingHint')}</p>
        </div>
      )
    }
    return (
      <div className={css.emptyState} role='status'>
        <p>{t('report.noContent')}</p>
        {detail.status === 'failed' && detail.errorCode !== null && (
          <p className={css.formError} role='alert'>{domainErrorText('report', detail.errorCode, t)}</p>
        )}
      </div>
    )
  }
  const data = detail.data
  const coverage = data.coverage
  const start = detail.periodStart ?? ''
  const endText = weekly ? shiftDay(detail.periodEnd ?? '', -1) : ''
  const baseLine = weekly
    ? t('report.header.baseWeekly', { from: shiftDay(start, -7), to: shiftDay(start, -1) })
    : t('report.header.baseDaily', { day: shiftDay(start, -1) })
  return (
    <div className={css.reportBody}>
      <DataCard title={periodTitle(detail, t)} state='ready' footnote={t('report.header.generatedAt', { time: formatDateTime(data.generatedAt ?? detail.finishedAt), count: formatCount(coverage?.totalAccounts ?? null, props.localeTag) })}>
        <dl className={css.metaList}>
          <div className={css.metaRow}><dt>{t('report.header.base')}</dt><dd>{baseLine}</dd></div>
          <div className={css.metaRow}>
            <dt>{t('report.header.kpi')}</dt>
            <dd>{weekly ? t('report.header.kpiWeekly', { from: start, to: endText }) : t('report.header.kpiDaily', { day: start })}</dd>
          </div>
          <div className={css.metaRow}><dt>{t('report.header.interaction')}</dt><dd>{t('report.header.interactionText')}</dd></div>
          <div className={css.metaRow}><dt>{t('report.header.works')}</dt><dd>{t('report.header.worksText')}</dd></div>
          <div className={css.metaRow}><dt>{t('report.header.note')}</dt><dd>{t('report.header.noteText')}</dd></div>
        </dl>
        {coverage !== null && (
          <p className={css.qualityBar}>
            <span>{t('report.quality.covered', { covered: formatCount(coverage.coveredAccounts, props.localeTag), total: formatCount(coverage.totalAccounts, props.localeTag) })}</span>
            <span>{t('report.quality.lastCollected', { time: formatDateTime(coverage.lastCollectedAt) })}</span>
            {coverage.missingAccounts.length > 0 && (
              <span className={css.qualityMissing}>
                {t('report.quality.missing', {
                  list: coverage.missingAccounts
                    .map(item => `${item.nickname ?? item.accountId}（${missingReasonText(item.reason, t)}）`)
                    .join('、'),
                })}
              </span>
            )}
          </p>
        )}
      </DataCard>

      <div className={css.kpiRow}>
        {data.coreMetrics.map(metric => (
          <div key={metric.key} className={css.kpiTile}>
            <span className={css.metricLabel}>{metric.label ?? metric.key}</span>
            <strong className={css.kpiValue}>{metric.available ? (metric.key === 'interactionRate' ? formatPercent(metric.value) : formatCount(metric.value, props.localeTag)) : '—'}</strong>
            {metric.changePct !== null
              ? (
                <span className={`${css.kpiChange} ${metric.changePct > 0 ? css.deltaUp : metric.changePct < 0 ? css.deltaDown : ''}`}>
                  {`${weekly ? t('report.change.weekly') : t('report.change.daily')} ${metric.changePct > 0 ? '▲' : metric.changePct < 0 ? '▼' : ''}${Math.abs(metric.changePct).toFixed(1)}%`}
                  {metric.prevValue !== null ? ` · ${t('report.change.prev', { value: formatCount(metric.prevValue, props.localeTag) })}` : ''}
                </span>
              )
              : <span className={css.metricFootnote}>{`${weekly ? t('report.change.weekly') : t('report.change.daily')} ${t('report.change.noBase')}`}</span>}
            {metric.note !== null && <span className={css.metricFootnote}>{metric.note}</span>}
          </div>
        ))}
      </div>

      <div className={css.reportSection}>
      <DataCard title={weekly ? t('report.trend.weekly') : t('report.trend.daily')} state='ready' footnote={t('report.trend.gapText')}>
        <ReportComboChart
          days={data.trendSeries.days}
          bars={data.trendSeries.bars}
          line={data.trendSeries.line}
          barLabel={weekly ? t('report.trend.barWeekly') : t('report.trend.barDaily')}
          lineLabel={t('report.trend.lineNote')}
          tooltipLabel={t('report.trend.lineTip')}
          localeTag={props.localeTag}
        />
        <p className={css.inlineHint}>{`${t('report.trend.barNote')}：${weekly ? t('report.trend.barWeekly') : t('report.trend.barDaily')} · ${t('report.trend.lineNote')}：${weekly ? t('report.trend.lineWeekly') : t('report.trend.lineDaily')}`}</p>
      </DataCard>
      </div>

      <div className={css.reportSection}>
      <DataCard title={weekly ? t('report.accounts.weekly', { from: start, to: endText }) : t('report.accounts.daily', { day: start })} state='ready'>
        <div className={css.tableWrap} role='region' aria-label={t('report.col.account')} tabIndex={0}>
          <table className={css.dataTable} aria-label={t('report.col.account')}>
            <thead>
              <tr>
                {[t('report.col.account'), t('report.col.owner'), t('report.col.fans'), t('report.col.plays'),
                  t('report.col.netFans'), t('report.col.publishes'), t('report.col.likes'), t('report.col.comments'), t('report.col.shares')].map(label => <th key={label} scope='col'>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {data.accounts.map(row => (
                <tr key={row.accountId}>
                  <td className={`${css.cellMain} ${css.reportAccountName}`}>
                    {row.nickname ?? row.accountId}
                    {row.sessionStatus === 'expired' && <Tag tone='warning'>{t('report.mark.expired')}</Tag>}
                    {row.marks.map(mark => <span key={mark} className={css.reportMark}>{mark}</span>)}
                  </td>
                  <td>{row.ownerName ?? '—'}</td>
                  <td className={css.cellNum}>{formatCount(row.fanCount, props.localeTag)}</td>
                  {(['plays', 'netFans', 'publishes', 'likes', 'comments', 'shares'] as const).map(key => {
                    const value = row.metrics[key]
                    const missing = !row.eachAvailable || value === null
                    if (key === 'netFans' && !missing && value !== 0) {
                      return (
                        <td key={key} className={css.cellNum}>
                          <span className={value > 0 ? css.deltaUp : css.deltaDown}>
                            {`${value > 0 ? '+' : '−'}${formatCount(Math.abs(value as number), props.localeTag)}`}
                          </span>
                        </td>
                      )
                    }
                    return <td key={key} className={css.cellNum}>{missing ? '—*' : formatCount(value, props.localeTag)}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataCard>
      </div>

      <div className={css.reportSection}>
      <DataCard
        title={weekly
          ? t('report.works.weekly', { count: data.works.length })
          : t('report.works.daily', { day: start, count: data.works.length })}
        state='ready'
      >
        {(data.worksOmittedCount ?? 0) > 0 && (
          <p className={css.inlineHint}>{t('report.works.omitted', { count: data.worksOmittedCount ?? 0, shown: data.works.length })}</p>
        )}
        {data.works.length === 0
          ? <p className={css.inlineHint}>{t('report.works.empty')}</p>
          : (
            <div className={css.workCards}>
              {data.works.map(work => {
                const completion = work.metrics.completion5s
                return (
                  <article key={work.workId} className={css.workCard}>
                    <header className={css.workCardHead}>
                      <strong className={css.workCardTitle}>{work.title ?? work.workId}</strong>
                      {work.isHot && <Tag tone='danger'>{t('report.work.hot')}</Tag>}
                      <span className={css.workCardAccount}>{work.nickname ?? work.accountId ?? ''}</span>
                    </header>
                    <dl className={css.workCardMetrics}>
                      <div><dt>{t('col.play')}</dt><dd>{formatCount(work.metrics.plays, props.localeTag)}</dd></div>
                      <div><dt>{t('col.like')}</dt><dd>{formatCount(work.metrics.likes, props.localeTag)}</dd></div>
                      <div><dt>{t('col.comment')}</dt><dd>{formatCount(work.metrics.comments, props.localeTag)}</dd></div>
                      <div><dt>{t('report.col.netFans')}</dt><dd>{formatCount(work.metrics.fansGain, props.localeTag)}</dd></div>
                    </dl>
                    <p className={css.workCardSecondary}>
                      <span>{t('report.work.collect', { value: formatCount(work.metrics.collects, props.localeTag) })}</span>
                      <span>{t('report.work.share', { value: formatCount(work.metrics.shares, props.localeTag) })}</span>
                      <span>{t('report.work.completion5s', { value: formatPercent(completion) })}</span>
                      <span>{t('report.work.bounce2s', { value: formatPercent(work.metrics.bounce2s) })}</span>
                      <span>{t('report.work.avgWatch', { value: work.metrics.avgWatchSeconds === null ? '—' : String(Math.round(work.metrics.avgWatchSeconds * 10) / 10) })}</span>
                    </p>
                    {completion !== null && (
                      <span className={css.progressTrack} role='img' aria-label={t('report.work.completion5s', { value: formatPercent(completion) })}>
                        <span className={css.progressFill} style={{ width: `${Math.max(0, Math.min(100, completion))}%` }} />
                      </span>
                    )}
                  </article>
                )
              })}
            </div>
          )}
      </DataCard>
      </div>

      {data.anomalies.length > 0 && (
        <DataCard title={t('report.anomaly.gap')} state='ready'>
          <ul className={css.alertList}>
            {data.anomalies.map((anomaly, index) => (
              <li key={index} className={css.alertItem} data-tone={anomaly.type === 'data_gap' ? 'gap' : 'business'}>
                <Tag tone={anomaly.type === 'data_gap' ? 'warning' : 'danger'}>
                  {anomaly.type === 'data_gap' ? t('report.anomaly.gap') : t('report.anomaly.business')}
                </Tag>
                <span>{anomaly.message ?? ''}</span>
              </li>
            ))}
          </ul>
        </DataCard>
      )}

      {detail.ai !== null && (
        <DataCard title={t('report.ai.title')} state='ready' description={detail.ai.summary ?? undefined}>
          <div className={css.insightGrid}>
            <section className={css.insightCol} data-tone='fact'>
              <h4>{t('report.ai.facts')}</h4>
              <ul className={css.insightList}>
                {detail.ai.facts.map((item, index) => <li key={index}>{item.title ?? ''}</li>)}
              </ul>
              <InsightDetails items={detail.ai.facts} t={t} />
              {detail.ai.limitations.length > 0 && (
                <details className={css.aiDetails} open>
                  <summary>{t('report.ai.limits')}</summary>
                  {detail.ai.limitations.map((limit, index) => <p key={index} className={css.inlineHint}>{limit}</p>)}
                </details>
              )}
            </section>
            <section className={css.insightCol} data-tone='infer'>
              <h4>{t('report.ai.inferences')}</h4>
              <ul className={css.insightList}>
                {detail.ai.inferences.map((item, index) => (
                  <li key={index}>
                    <span>{item.title ?? ''}</span>
                    <Tag tone={item.confidence === 'high' ? 'danger' : item.confidence === 'medium' ? 'warning' : 'neutral'}>
                      {item.confidence === 'high' ? t('ai.grade.high') : item.confidence === 'medium' ? t('ai.grade.medium') : t('ai.grade.low')}
                    </Tag>
                  </li>
                ))}
              </ul>
              <InsightDetails items={detail.ai.inferences} t={t} />
            </section>
            <section className={css.insightCol} data-tone='advice'>
              <h4>{t('report.ai.recommendations')}</h4>
              <ul className={css.insightList}>
                {detail.ai.recommendations.map((item, index) => (
                  <li key={index}>
                    <span>{item.title ?? ''}</span>
                    <Tag tone={item.priority === 'high' ? 'danger' : item.priority === 'medium' ? 'warning' : 'neutral'}>
                      {item.priority === 'high' ? t('ai.grade.high') : item.priority === 'medium' ? t('ai.grade.medium') : t('ai.grade.low')}
                    </Tag>
                  </li>
                ))}
              </ul>
              <InsightDetails items={detail.ai.recommendations} t={t} />
            </section>
          </div>
        </DataCard>
      )}
    </div>
  )
}

/** 洞察折叠依据（页面 details；导出全展开）。 */
function InsightDetails(props: {
  items: { title: string | null; detail: string | null; evidence: string | null }[]
  t: Translate
}): ReactNode {
  if (props.items.length === 0) return null
  return (
    <details className={css.aiDetails}>
      <summary>{props.t('report.ai.more')}</summary>
      {props.items.map((item, index) => (
        <div key={index} className={css.insightMoreItem}>
          <strong>{item.title ?? ''}</strong>
          {item.detail !== null && <p>{item.detail}</p>}
          {item.evidence !== null && <p className={css.inlineHint}>{props.t('report.ai.evidence', { text: item.evidence })}</p>}
        </div>
      ))}
    </details>
  )
}

/** 版本 Menu（v{n} · 状态 · 当前）。 */
function VersionMenu(props: { versions: ReportListItem[]; currentId: string; t: Translate; onSelect: (id: string) => void }): ReactNode {
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
function statusPill(item: { status: string; coreAvailable: boolean | null }): { tone: 'success' | 'warning' | 'danger' | 'neutral'; label: Parameters<Translate>[0] } {
  if (item.status === 'succeeded') {
    return item.coreAvailable === false
      ? { tone: 'warning', label: 'report.status.incomplete' }
      : { tone: 'success', label: 'report.status.succeeded' }
  }
  if (item.status === 'failed') return { tone: 'danger', label: 'report.status.failed' }
  if (item.status === 'insufficient') return { tone: 'warning', label: 'report.status.insufficient' }
  return { tone: 'neutral', label: 'report.status.running' }
}

/** 周期标题（周报 end-1 闭区间）。 */
/** 周期标题（周报 end-1 闭区间）。 */
function periodTitle(period: { reportType: string; periodStart: string | null; periodEnd: string | null }, t: Translate): string {
  const start = period.periodStart ?? ''
  if (period.reportType === 'weekly') {
    return `${t('report.weekly')} · ${start} ~ ${shiftDay(period.periodEnd ?? '', -1)}`
  }
  return `${t('report.daily')} · ${start}`
}

/** 导出文件名主干（抖音运营{日报|周报}_{start}；前缀走词典）。 */
function reportFileStem(detail: ReportDetail, t: Translate): string {
  const start = detail.periodStart ?? ''
  if (detail.reportType === 'weekly') {
    return `${t('report.filePrefix')}${t('report.weekly')}_${start}~${shiftDay(detail.periodEnd ?? '', -1)}`
  }
  return `${t('report.filePrefix')}${t('report.daily')}_${start}`
}

/** 下一版本号（当前版本 + 1；无版本信息回退 1）。 */
function nextVersionOf(detail: ReportDetail, versions: ReportListItem[]): number {
  const current = versions.find(item => item.reportId === detail.reportId)?.version ?? null
  return (current ?? 0) + 1
}

/** 缺采原因文案。 */
function missingReasonText(reason: string | null, t: Translate): string {
  if (reason === 'session_expired') return t('report.missing.session_expired')
  if (reason === 'not_collected') return t('report.missing.not_collected')
  if (reason === 'no_data') return t('report.missing.no_data')
  return reason ?? t('report.missing.no_data')
}

/** token 解析（导出内联；未解析回退 CSS 系统色，不落字面色值）。 */
function resolveToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return `var(${name},${fallback})`
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value === '' ? `var(${name},${fallback})` : value
}

/** 自包含单文件 HTML（details 全展开 + token 内联 + 语义类名 dyr-*）。 */
function serializeReportHtml(detail: ReportDetail, t: Translate, localeTag: string): string {
  const data = detail.data
  const lines: string[] = []
  const esc = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  const tokenStyle = [
    `:root{--dyr-text:${resolveToken('--dsw-alias-label-primary', 'canvastext')};`,
    `--dyr-muted:${resolveToken('--dsw-alias-label-secondary', 'graytext')};`,
    `--dyr-bg:${resolveToken('--dsw-alias-bg-layer-1', 'canvas')};`,
    `--dyr-border:${resolveToken('--dsw-alias-border-l2', 'graytext')};`,
    `--dyr-accent:${resolveToken('--dsw-alias-border-selected', 'highlight')};`,
    `--dyr-up:${resolveToken('--dsw-alias-state-error-primary', 'mark')};`,
    `--dyr-down:${resolveToken('--dsw-alias-state-success-primary', 'field')};}`,
  ].join('')
  const sheet = `${tokenStyle}
.dyr{font:13px/1.7 system-ui,sans-serif;color:var(--dyr-text);background:var(--dyr-bg);max-width:1106px;margin:0 auto;padding:24px}
.dyr h2{margin:0 0 8px;font-size:18px}
.dyr h3{margin:24px 0 10px;font-size:15px}
.dyr dl{margin:0 0 12px}.dyr dt{font-weight:600;display:inline}.dyr dt::after{content:'：'}
.dyr dd{display:inline;margin:0 16px 0 0}
.dyr table{border-collapse:collapse;width:100%;margin-bottom:8px}
.dyr th,.dyr td{border:1px solid var(--dyr-border);padding:6px 10px;text-align:start;font-variant-numeric:tabular-nums}
.dyr th{color:var(--dyr-muted);font-weight:400}
.dyr .up{color:var(--dyr-up)}.dyr .down{color:var(--dyr-down)}
.dyr details[open] summary{font-weight:600}
@media print{.dyr{padding:0}}`
  lines.push('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">', `<title>${esc(periodTitle(detail, t))}</title>`, `<style>${sheet}</style></head><body><div class="dyr">`)
  lines.push(`<h2>${esc(periodTitle(detail, t))}</h2>`)
  if (data !== null) {
    const coverage = data.coverage
    lines.push(`<dl>`)
    lines.push(`<dt>${esc(t('report.header.generatedAt', { time: formatDateTime(data.generatedAt ?? detail.finishedAt), count: formatCount(coverage?.totalAccounts ?? null, localeTag) }))}</dt>`)
    lines.push(`<dt>${esc(t('report.header.interaction'))}</dt><dd>${esc(t('report.header.interactionText'))}</dd>`)
    lines.push(`<dt>${esc(t('report.header.note'))}</dt><dd>${esc(t('report.header.noteText'))}</dd></dl>`)
    lines.push('<h3>KPI</h3><table><tbody>')
    for (const metric of data.coreMetrics) {
      const change = metric.changePct === null ? '' : `<span class="${metric.changePct > 0 ? 'up' : metric.changePct < 0 ? 'down' : ''}">${metric.changePct > 0 ? '▲' : metric.changePct < 0 ? '▼' : ''}${Math.abs(metric.changePct).toFixed(1)}%</span>`
      lines.push(`<tr><th>${esc(metric.label ?? metric.key)}</th><td>${metric.available ? esc(formatCount(metric.value, localeTag)) : '—'} ${change}</td></tr>`)
    }
    lines.push('</tbody></table>')
    lines.push(`<h3>${esc(esc(detail.reportType === 'weekly' ? t('report.trend.weekly') : t('report.trend.daily')))}</h3><table><tbody>`)
    data.trendSeries.days.forEach((day, index) => {
      const bar = data.trendSeries.bars[index] ?? null
      const linePoint = data.trendSeries.line[index] ?? null
      lines.push(`<tr><th>${esc(day)}</th><td>${bar === null ? '—*' : esc(formatCount(bar, localeTag))}</td><td>${linePoint === null ? '—*' : esc(formatCount(linePoint, localeTag))}</td></tr>`)
    })
    lines.push('</tbody></table>')
    lines.push(`<h3>${esc(detail.reportType === 'weekly' ? t('report.accounts.weekly', { from: detail.periodStart ?? '', to: shiftDay(detail.periodEnd ?? '', -1) }) : t('report.accounts.daily', { day: detail.periodStart ?? '' }))}</h3>`)
    lines.push('<table><thead><tr>')
    for (const label of [t('report.col.account'), t('report.col.owner'), t('report.col.fans'), t('report.col.plays'), t('report.col.netFans'), t('report.col.publishes'), t('report.col.likes'), t('report.col.comments'), t('report.col.shares')]) {
      lines.push(`<th>${esc(label)}</th>`)
    }
    lines.push('</tr></thead><tbody>')
    for (const row of data.accounts) {
      const cells = [
        esc(row.nickname ?? row.accountId),
        esc(row.ownerName ?? '—'),
        formatCount(row.fanCount, localeTag),
        ...(['plays', 'netFans', 'publishes', 'likes', 'comments', 'shares'] as const).map(key => {
          const value = row.metrics[key]
          return row.eachAvailable && value !== null ? formatCount(value, localeTag) : '—*'
        }),
      ]
      lines.push(`<tr>${cells.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`)
    }
    lines.push('</tbody></table>')
    if (detail.ai !== null) {
      lines.push(`<h3>${esc(t('report.ai.title'))}</h3>`)
      if (detail.ai.summary !== null) lines.push(`<p>${esc(detail.ai.summary)}</p>`)
      const sections: [string, { title: string | null; detail: string | null; evidence: string | null }[]][] = [
        [t('report.ai.facts'), detail.ai.facts],
        [t('report.ai.inferences'), detail.ai.inferences],
        [t('report.ai.recommendations'), detail.ai.recommendations],
      ]
      for (const [title, items] of sections) {
        lines.push(`<details open><summary>${esc(title)}</summary>`)
        for (const item of items) {
          lines.push(`<p><strong>${esc(item.title ?? '')}</strong></p>`)
          if (item.detail !== null) lines.push(`<p>${esc(item.detail)}</p>`)
          if (item.evidence !== null) lines.push(`<p>${esc(t('report.ai.evidence', { text: item.evidence }))}</p>`)
        }
        lines.push('</details>')
      }
    }
  }
  lines.push('</div></body></html>')
  return lines.join('')
}
