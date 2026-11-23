/**
 * 单账号分析下钻页（账号总览 Tab 内）：工具栏（返回 ghost 保留筛选 / AI 分析
 * 入口 ghost / 导出 ghost+icon）→ 头部（账号名/负责人/粉丝·作品数·最近采集/
 * 提醒）→ 5 KPI → 粉丝数据 5 卡（整块缺失不渲染）→ 数据趋势（指标 Menu 7
 * 枚举 + ChartFrame 折线 30 天窗口，缺口虚线、单点提示、caption）→ 内容指标
 * 卡（覆盖率缺失→「数据不足」note）→ 观众与流量 5 块 → 本账号爆款 7 列 →
 * AI 分析弹层（六折叠卡 + 状态机：开始分析 primary / 分析中 disabled
 * aria-busy / 重新分析 RiskConfirmation；轮询 3s 优先后端 pollIntervalSeconds，
 * 连续 5 次失败停；失败保留旧结果警示）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Menu, Modal, RiskConfirmation, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChartFrame, DataCard, DataState } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import {
  basisLines, domainErrorText, fanDelta, formatAgeBucket, formatCount, formatDateTime,
  formatPercent, formatSeconds, genderLabel, hotLabelText, reasonText, trafficSourceLabel,
  type Translate,
} from './format.ts'
import css from './workbench.module.css'
import { readAccountTrend, readAiAnalysis, readAnalysis, type AiAnalysisView, type AnalysisData, type HotWorkRow } from './schema.ts'
import { DistributionBars, LineTrendChart, accountTrendRows } from './charts.tsx'
import { downloadBase64 } from './OverviewPage.tsx'

/** 趋势指标 7 枚举（account.trend metric 白名单）。 */
const TREND_METRICS: readonly { id: string; labelKey: Parameters<Translate>[0] }[] = [
  { id: 'play', labelKey: 'metric.play' },
  { id: 'like', labelKey: 'metric.like' },
  { id: 'comment', labelKey: 'metric.comment' },
  { id: 'collect', labelKey: 'metric.collect' },
  { id: 'share', labelKey: 'metric.share' },
  { id: 'fans', labelKey: 'metric.fans' },
  { id: 'net_fans', labelKey: 'metric.net_fans' },
]

/** 内容指标卡定义（固定清单；key 对应 readAnalysis 的 content 行）。 */
const CONTENT_LABEL_KEYS: Readonly<Record<string, Parameters<Translate>[0]>> = {
  engagementRatePct: 'cm.engagement',
  likeCount: 'cm.likeRate',
  commentCount: 'cm.commentRate',
  collectCount: 'cm.collectRate',
  shareCount: 'cm.shareRate',
  newFansCount: 'cm.fansGain',
  completion5s: 'cm.completion5s',
  avgViewProportion: 'cm.avgViewShare',
  avgWatchDuration: 'cm.avgWatchDuration',
}

export interface AnalysisPageProps {
  t: Translate
  localeTag: string
  accountId: string
  rangeLabel: string
  onBack: () => void
  onOpenWork: (accountId: string, work: HotWorkRow) => void
  onNotice: (text: string) => void
}

/** AI 运行态。 */
interface AiState {
  status: string | null
  ai: AiAnalysisView | null
  error: string | null
  busy: boolean
  confirming: boolean
  confirmAck: boolean
}

/** 单账号分析页组件。 */
export function AnalysisPage(props: AnalysisPageProps): ReactNode {
  const t = props.t
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [metric, setMetric] = useState('play')
  const [trendPoints, setTrendPoints] = useState<{ day: string; value: number | null }[]>([])
  const [trendError, setTrendError] = useState<string | null>(null)
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [ai, setAi] = useState<AiState>({ status: 'not_analyzed', ai: null, error: null, busy: false, confirming: false, confirmAck: false })
  const seqRef = useRef(0)
  const trendSeqRef = useRef(0)
  const aiPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopAiPolling = useCallback((): void => {
    if (aiPollRef.current !== null) {
      clearInterval(aiPollRef.current)
      aiPollRef.current = null
    }
  }, [])

  useEffect(() => stopAiPolling, [stopAiPolling])

  /** 账号分析加载（序号守卫；失败保留空态显式可见）。 */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++seqRef.current
    setState('loading')
    setErrorReason(null)
    try {
      const res = await hostAction('account.analysis', { accountId: props.accountId })
      if (seqRef.current !== seq) return
      setAnalysis(readAnalysis(res))
      setState('ready')
    } catch (error) {
      if (seqRef.current !== seq) return
      setAnalysis(null)
      setErrorReason(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      setState('error')
    }
  }, [props.accountId])

  useEffect(() => { void load() }, [load])

  /** 趋势加载（指标切换；独立错误呈现不吞成「暂无趋势」）。 */
  const loadTrend = useCallback(async (nextMetric: string): Promise<void> => {
    const seq = ++trendSeqRef.current
    setTrendError(null)
    try {
            const dayFmt = (offsetDays: number): string => new Date(Date.now() + 8 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
      const res = await hostAction('account.trend', {
        accountId: props.accountId,
        metric: nextMetric,
        // 固定 7 天窗口（上海自然日，从当天往前推 7 天）：服务端窗口是半开
        // [fromDay, toDay)，toDay 必须取明天否则末端数据日被排除（旧插件
        // toDay=今天 + 30 天窗口同理覆盖昨日数据）。
        fromDay: dayFmt(-6),
        toDay: dayFmt(1),
      })
      if (trendSeqRef.current !== seq) return
      setTrendPoints(readAccountTrend(res))
    } catch (error) {
      if (trendSeqRef.current !== seq) return
      setTrendPoints([])
      setTrendError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    }
  }, [props.accountId])

  useEffect(() => { void loadTrend(metric) }, [metric, loadTrend])

  /** AI 现状加载（进入分析页只 get 一次；轮询仅在接受受理后进行）。 */
  const loadAi = useCallback(async (options?: { silent?: boolean }): Promise<{ aiStatus: string | null } | null> => {
    try {
      const res = await hostAction('aiAnalysis.get', { accountId: props.accountId })
      const view = readAiAnalysis(res)
      setAi(previous => ({ ...previous, status: view.aiStatus, ai: view.ai, error: null }))
      return { aiStatus: view.aiStatus }
    } catch {
      if (options?.silent !== true) {
        setAi(previous => ({ ...previous, error: 'douyin_operation_request_failed' }))
      }
      return null
    }
  }, [props.accountId])

  useEffect(() => { void loadAi() }, [loadAi])

  const startAi = useCallback((): void => {
    if (ai.busy) return
    setAi(previous => ({ ...previous, busy: true, error: null }))
    void (async () => {
      try {
        await hostAction('aiAnalysis.start', {
          accountId: props.accountId,
          idempotencyKey: `douyin:ai_analysis:${attemptId()}`,
        })
        const first = await loadAi({ silent: true })
        if (first === null || first.aiStatus === 'running' || first.aiStatus === null) {
          stopAiPolling()
          let failures = 0
          const tick = (): void => {
            void loadAi({ silent: true }).then(latest => {
              if (latest === null) {
                failures += 1
                if (failures >= 5) {
                  stopAiPolling()
                  setAi(previous => ({ ...previous, error: 'douyin_operation_request_failed' }))
                }
                return
              }
              failures = 0
              if (latest.aiStatus !== 'running') stopAiPolling()
            }).catch(() => undefined)
          }
          void tick()
          aiPollRef.current = setInterval(tick, 3000)
        }
      } catch (error) {
        setAi(previous => ({ ...previous, error: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
      } finally {
        setAi(previous => ({ ...previous, busy: false }))
      }
    })()
  }, [ai.busy, loadAi, props.accountId, stopAiPolling])

  const exportAnalysis = useCallback((): void => {
    setExporting(true)
    void (async () => {
      try {
        const res = await hostAction('accountAnalysis.export', { accountId: props.accountId })
        downloadBase64(
          typeof res.file_name === 'string' ? res.file_name : 'douyin-account-analysis-report.xlsx',
          typeof res.content_base64 === 'string' ? res.content_base64 : '',
          typeof res.mime_type === 'string' ? res.mime_type : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
      } catch (error) {
        props.onNotice(reasonText(error instanceof Error ? error.message : 'export_failed', t))
      } finally {
        setExporting(false)
      }
    })()
  }, [props, t])

  const account = analysis?.account ?? null
  const fans = analysis?.fansSummary ?? null
  const kpi = analysis?.kpi
  const hasResult = ai.ai !== null && ai.ai.status === 'succeeded' && ai.ai.result !== null
  const running = ai.busy || ai.status === 'running' || ai.ai?.status === 'running'

  return (
    <div className={css.pageBody}>
      <div className={css.workToolbarRow}>
        <Button variant='ghost' size='sm' onClick={props.onBack}>{t('analysis.back')}</Button>
        <Button variant='ghost' size='sm' onClick={() => { setAiModalOpen(true) }}>{t('analysis.aiEntry')}</Button>
        <Button variant='ghost' size='sm' icon={<ExportIcon />} disabled={exporting} aria-busy={exporting || undefined} onClick={exportAnalysis}>
          {exporting ? t('report.exporting') : t('analysis.export')}
        </Button>
      </div>

      <DataState state={state} shape='block' onRetry={() => { void load() }}>
        {state === 'error' && errorReason !== null && <p className={css.formError} role='alert'>{reasonText(errorReason, t)}</p>}
        {state === 'ready' && account === null && <div className={css.emptyState} role='status'><p>{t('state.empty')}</p></div>}
        {state === 'ready' && account !== null && (
          <>
            <header className={css.analysisHead}>
              <h3 className={css.analysisTitle}>{t('analysis.accountTitle', { name: account.nickname ?? account.accountId })}</h3>
              {account.ownerName !== null && <p className={css.inlineHintStrong}>{t('analysis.owner', { name: account.ownerName })}</p>}
              <p className={css.inlineHint}>
                {t('analysis.metaFans', { count: formatCount(account.fanCount, props.localeTag) })}
                {' · '}
                {t('analysis.metaWorks', { count: formatCount(analysis?.workCount ?? null, props.localeTag) })}
                {`（${props.rangeLabel}）`}
                {' · '}
                {t('analysis.metaLatest', { time: account.lastCollectedAt === null ? t('analysis.noRecord') : formatDateTime(account.lastCollectedAt) })}
              </p>
              {(account.sessionStatus === 'expired' || account.suspiciousEmptyCollect || (analysis?.alerts.length ?? 0) > 0) && (
                <div className={css.tagRow}>
                  {account.sessionStatus === 'expired' && <Tag tone='danger'>{t('overview.alert.sessionExpired')}</Tag>}
                  {account.suspiciousEmptyCollect && <Tag tone='warning'>{t('overview.alert.suspiciousEmpty')}</Tag>}
                  {(analysis?.alerts ?? []).map(alert => (
                    <Tag key={alert.ruleId} tone='warning'>{`${alertRuleText(alert.ruleId, t)}（${alert.workCount}）`}</Tag>
                  ))}
                </div>
              )}
            </header>

            <div className={css.kpiRow}>
              <KpiTile label={t('analysis.kpi.totalPlay')} value={formatCount(kpi?.totalPlayCount ?? null, props.localeTag)} />
              <KpiTile label={t('analysis.kpi.medianPlay')} value={formatCount(kpi?.medianPlayCount ?? null, props.localeTag)} />
              <KpiTile label={t('analysis.kpi.maxPlay')} value={formatCount(kpi?.maxPlayCount ?? null, props.localeTag)} />
              <KpiTile label={t('analysis.kpi.hotWorks')} value={formatCount(kpi?.hotWorkCount ?? null, props.localeTag)} />
              <KpiTile label={t('analysis.kpi.hotRate')} value={formatPercent(kpi?.hotRatePct ?? null)} />
            </div>

            {fans !== null && (
              <DataCard title={t('analysis.fans.title')} footnote={props.rangeLabel} state='ready'>
                <div className={css.kpiRow}>
                  <KpiTile label={t('analysis.fans.total')} value={formatCount(fans.totalFansCount, props.localeTag)} />
                  <KpiTile label={t('analysis.fans.add')} value={deltaNode(fans.newFansCount, props.localeTag)} />
                  <KpiTile label={t('analysis.fans.cancel')} value={deltaNode(fans.cancelFansCount, props.localeTag, 'cancel')} />
                  <KpiTile label={t('analysis.fans.revisit')} value={formatCount(fans.homeViewFansCount, props.localeTag)} />
                  <KpiTile label={t('analysis.fans.homeView')} value={formatCount(fans.homepageViewCount, props.localeTag)} />
                </div>
              </DataCard>
            )}

            <div className={css.workToolbarRow}>
              <h3 className={css.sectionTitle}>{t('analysis.trend.title')}</h3>
              <MetricMenu t={t} metric={metric} onChange={setMetric} />
            </div>
            <ChartFrame
              title=' '
              ariaLabel={t('analysis.trend.title')}
              state='ready'
              height='fit'
              footnote={t('analysis.trend.caption')}
            >
              {trendError !== null
                ? (
                  <div role='alert'>
                    <p className={css.formError}>{reasonText(trendError, t)}</p>
                    <Button variant='ghost' size='sm' onClick={() => { void loadTrend(metric) }}>{t('state.retry')}</Button>
                  </div>
                )
                : (
                  <LineTrendChart
                    rows={accountTrendRows(trendPoints)}
                    seriesLabel={t(`metric.${metric}` as 'metric.play')}
                    localeTag={props.localeTag}
                    emptyText={t('trend.empty')}
                    singleHint={t('trend.singleHint')}
                  />
                )}
            </ChartFrame>

            <div className={css.analysisTwoCol}>
            <DataCard title={t('analysis.metrics.title')} state='ready'>
              <div className={css.metricGrid}>
                {(analysis?.content ?? []).map(row => {
                  const labelKey = CONTENT_LABEL_KEYS[row.key]
                  if (labelKey === undefined) return null
                  const insufficient = row.value === null || (row.coveragePct !== null && row.coveragePct <= 0)
                  const valueText = row.key === 'avgWatchDuration'
                    ? formatSeconds(row.value, t)
                    : row.key === 'newFansCount'
                      ? null
                      : formatPercent(row.value)
                  return (
                    <div key={row.key} className={css.metricCard}>
                      <span className={css.metricHeadRow}>
                        <span className={css.metricLabel}>{t(labelKey)}</span>
                        {insufficient && <span className={css.metricNote}>{t('analysis.dataInsufficient')}</span>}
                      </span>
                      <strong className={css.metricValue}>
                        {row.key === 'newFansCount' ? deltaNode(row.value, props.localeTag) : valueText}
                      </strong>
                    </div>
                  )
                })}
              </div>
            </DataCard>

            <DataCard title={t('analysis.audience.title')} state='ready'>
              <div className={css.audienceGrid}>
                <AudienceCard title={t('audience.gender')}>
                  {analysis?.audience.gender != null && analysis !== null
                    ? <DistributionBars rows={analysis.audience.gender} format={key => genderLabel(key, t)} localeTag={props.localeTag} />
                    : <p className={css.chartEmpty}>{t('analysis.dataInsufficient')}</p>}
                </AudienceCard>
                <AudienceCard title={t('audience.age')}>
                  {analysis?.audience.age != null && analysis !== null
                    ? <DistributionBars rows={analysis.audience.age} format={key => formatAgeBucket(key, t)} localeTag={props.localeTag} />
                    : <p className={css.chartEmpty}>{t('analysis.dataInsufficient')}</p>}
                </AudienceCard>
                <AudienceCard title={t('audience.region')}>
                  {analysis?.audience.province != null && analysis !== null
                    ? <DistributionBars rows={analysis.audience.province} format={key => key} localeTag={props.localeTag} />
                    : <p className={css.chartEmpty}>{t('analysis.dataInsufficient')}</p>}
                </AudienceCard>
                <AudienceCard title={t('audience.cityLevel')}>
                  {analysis?.audience.city_level != null && analysis !== null
                    ? <DistributionBars rows={analysis.audience.city_level} format={key => key} localeTag={props.localeTag} />
                    : <p className={css.chartEmpty}>{t('analysis.dataInsufficient')}</p>}
                </AudienceCard>
                <AudienceCard title={t('audience.traffic')}>
                  {(analysis?.traffic.length ?? 0) > 0 && analysis !== null
                    ? <DistributionBars
                        rows={analysis.traffic.map(row => ({ key: trafficSourceLabel(row.key, row.label, t), pct: row.pct }))}
                        format={key => key}
                        localeTag={props.localeTag}
                      />
                    : <p className={css.chartEmpty}>{t('analysis.dataInsufficient')}</p>}
                </AudienceCard>
              </div>
            </DataCard>
            </div>

            <DataCard title={t('analysis.hot.title')} state='ready'>
              <DataState state={(analysis?.hotWorks.length ?? 0) > 0 ? 'ready' : 'empty'} shape='rows'>
                <div className={css.tableWrap} role='region' aria-label={t('analysis.hot.title')} tabIndex={0}>
                  <table className={css.dataTable} aria-label={t('analysis.hot.title')}>
                    <thead>
                      <tr>
                        {[t('overview.col.rank'), t('overview.col.video'), t('overview.col.publishTime'), t('col.play'),
                          t('overview.col.engagement'), t('overview.col.fansGain'), t('overview.col.hotBasis')].map(label => <th key={label} scope='col'>{label}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {(analysis?.hotWorks ?? []).map((work, index) => (
                        <tr
                          key={work.workId}
                          tabIndex={0}
                          className={work.promoted ? css.rowPromoted : undefined}
                          aria-label={t('row.detailAria', { title: work.title ?? work.workId })}
                          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onOpenWork(props.accountId, work) } }}
                          onDoubleClick={() => { props.onOpenWork(props.accountId, work) }}
                        >
                          <td>{work.rank ?? index + 1}</td>
                          <td className={css.cellMain}>
                            <button type='button' className={css.workLinkButton} title={work.title ?? work.workId} onClick={() => { props.onOpenWork(props.accountId, work) }}>
                              {work.title ?? work.workId}
                            </button>
                            {work.promoted && <Tag tone='danger'>{t('promotion.badge')}</Tag>}
                          </td>
                          <td>{formatDateTime(work.publishTime)}</td>
                          <td className={css.cellNum}>{formatCount(work.playCount, props.localeTag)}</td>
                          <td className={css.cellNum}>{formatPercent(work.engagementRatePct)}</td>
                          <td className={css.cellNum}>{deltaNode(work.fansGainCount, props.localeTag)}</td>
                          <td>
                            <span className={css.basisCell}>
                              {(basisLines(work.basis).length > 0 ? basisLines(work.basis) : [hotLabelText(work.labels, t)])
                                .map(line => <span key={line} className={css.basisLine}>{line}</span>)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </DataState>
            </DataCard>
          </>
        )}
      </DataState>

      <Modal
        open={aiModalOpen}
        onClose={() => { if (!ai.busy) setAiModalOpen(false) }}
        title={t('ai.title')}
        closeLabel={t('dialog.close')}
        className={css.aiDialog as string}
        contentClassName={css.detailContent as string}
      >
        <div className={css.aiBody}>
          <div className={css.aiToolbar}>
            <span className={css.aiStatus} role='status' data-status={ai.status ?? ai.ai?.status ?? 'not_analyzed'}>
              {t(aiStatusKey(ai.status ?? ai.ai?.status ?? 'not_analyzed'))}
            </span>
            {running
              ? <Button variant='primary' size='sm' disabled aria-busy='true'>{t('ai.running')}</Button>
              : hasResult || ai.status === 'insufficient' || ai.ai?.status === 'insufficient'
                ? <Button variant='primary' size='sm' onClick={() => { setAi(previous => ({ ...previous, confirming: true })) }}>{t('ai.rerun')}</Button>
                : (
                  <Button variant='primary' size='sm' disabled={ai.busy} onClick={startAi} data-modal-autofocus=''>
                    {t(ai.status === 'not_analyzed' && ai.ai === null ? 'ai.startFirst' : 'ai.start')}
                  </Button>
                )}
          </div>
          {ai.error !== null && <p className={css.formError} role='alert'>{aiErrorText(ai.error, t)}</p>}
          {ai.ai?.retainedError != null && ai.ai.retainedError !== '' && ai.ai.result !== null && (
            <p className={css.formNotice} role='status'>
              {ai.ai.retainedError === 'AI_ANALYSIS_INSUFFICIENT_DATA' ? domainErrorText('ai', 'AI_ANALYSIS_INSUFFICIENT_DATA', t) : t('ai.error.retained')}
            </p>
          )}
          <AiCards ai={ai.ai} hasResult={hasResult} running={running} t={t} onOpenWork={props.onOpenWork} />
          {ai.confirming && (
            <RiskConfirmation
              open
              title={t('ai.rerunTitle')}
              description={t('ai.rerunBody')}
              acknowledgeLabel={t('ai.rerunBody')}
              cancelLabel={t('ai.rerunCancel')}
              closeLabel={t('dialog.close')}
              confirmLabel={t('ai.rerunConfirm')}
              acknowledged={ai.confirmAck}
              onAcknowledgedChange={value => { setAi(previous => ({ ...previous, confirmAck: value })) }}
              onCancel={() => { setAi(previous => ({ ...previous, confirming: false, confirmAck: false })) }}
              onConfirm={() => {
                setAi(previous => ({ ...previous, confirming: false, confirmAck: false }))
                startAi()
              }}
            />
          )}
        </div>
      </Modal>
    </div>
  )
}

/** AI 六折叠卡。 */
function AiCards(props: {
  ai: AiAnalysisView | null
  hasResult: boolean
  running: boolean
  t: Translate
  onOpenWork: (accountId: string, work: HotWorkRow) => void
}): ReactNode {
  const t = props.t
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({ summary: true })
  const result = props.ai?.result ?? null
  if (!props.hasResult || result === null) {
    return (
      <div className={css.aiCards}>
        <p className={css.chartEmpty} role='status'>
          {props.running ? t('ai.running') : t('ai.emptyHint')}
        </p>
      </div>
    )
  }
  const toggle = (key: string): void => { setOpenCards(previous => ({ ...previous, [key]: !(previous[key] === true) })) }
  const evidenceOf = (workId: string): string | null =>
    props.ai?.evidenceWorks.find(work => work.workId === workId)?.title ?? null
  const dimTitle = (key: string, fallback: string | null): string => {
    const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
      content: 'ai.dim.content',
      interaction: 'ai.dim.interaction',
      retention: 'ai.dim.retention',
      audience: 'ai.dim.audience',
      stability: 'ai.dim.stability',
    }
    const mapped = keys[key]
    return mapped !== undefined ? t(mapped) : fallback ?? t('ai.dim.other')
  }
  const cards: { key: string; title: string; digest: string; body: ReactNode }[] = [
    {
      key: 'summary',
      title: t('ai.card.summary'),
      digest: `${t('ai.summary.assessment')}：${assessmentText(result.overallAssessment, t)}`,
      body: (
        <>
          <p className={css.aiText}>{result.summary}</p>
          <p className={css.aiMeta}>
            {result.generatedAt !== null && <span>{t('ai.summary.generatedAt', { time: result.generatedAt })}</span>}
            {result.sampleCount !== null && <span>{t('ai.summary.sample', { count: result.sampleCount })}</span>}
          </p>
        </>
      ),
    },
    {
      key: 'dims',
      title: t('ai.card.dims'),
      digest: result.dimensions.map(dimension => `${dimTitle(dimension.key, dimension.title)} · ${t(levelKey(dimension.level))}`).join(' · '),
      body: (
        <div className={css.aiItems}>
          {result.dimensions.map(dimension => (
            <div key={dimension.key} className={css.aiItem}>
              <div className={css.aiItemHead}>
                <span className={css.aiItemTitle}>{dimension.title ?? dimTitle(dimension.key, null)}</span>
                <Tag tone={levelTone(dimension.level)}>{t(levelKey(dimension.level))}</Tag>
              </div>
              {dimension.facts[0] !== undefined && <p className={css.aiText}>{dimension.facts[0]}</p>}
              {dimension.insight !== null && <p className={css.aiText}>{dimension.insight}</p>}
              <details className={css.aiDetails}>
                <summary>{t('ai.dimDetail')}</summary>
                {dimension.facts.slice(1).map((fact, index) => <p key={index} className={css.aiText}>{fact}</p>)}
                {dimension.limitations.length > 0 && (
                  <p className={css.aiText}>{`${t('ai.dataLimitations')}：${dimension.limitations.join('；')}`}</p>
                )}
                <EvidenceChips workIds={dimension.evidenceWorkIds} evidenceOf={evidenceOf} onOpenWork={props.onOpenWork} t={t} />
              </details>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'risks',
      title: t('ai.card.risks'),
      digest: result.risks[0]?.title ?? '',
      body: <AiItems items={result.risks} badge='priority' evidenceOf={evidenceOf} onOpenWork={props.onOpenWork} t={t} />,
    },
    {
      key: 'recs',
      title: t('ai.card.recs'),
      digest: result.recommendations[0]?.title ?? '',
      body: <AiItems items={result.recommendations} badge='priority' evidenceOf={evidenceOf} onOpenWork={props.onOpenWork} t={t} />,
    },
    {
      key: 'patterns',
      title: t('ai.card.patterns'),
      digest: result.viralPatterns[0]?.title ?? '',
      body: (
        <div className={css.aiItems}>
          {result.viralPatterns.map((pattern, index) => (
            <div key={index} className={css.aiItem}>
              <div className={css.aiItemHead}>
                <span className={css.aiItemTitle}>{pattern.title ?? '—'}</span>
                <Tag tone={gradeTone(pattern.confidence)}>{gradeText(pattern.confidence, t)}</Tag>
              </div>
            </div>
          ))}
        </div>
      ),
    },
    {
      key: 'limits',
      title: t('ai.card.limits'),
      digest: t('ai.digestLimits', { n: result.dataLimitations.length }),
      body: (
        <>
          <ul className={css.aiLimits}>
            {result.dataLimitations.map((limit, index) => <li key={index}>{limit}</li>)}
          </ul>
          {result.disclaimer !== null && <p className={css.aiText}>{`${t('ai.disclaimer')}：${result.disclaimer}`}</p>}
        </>
      ),
    },
  ]
  return (
    <div className={css.aiCards}>
      {cards.map(card => (
        <section key={card.key} className={css.aiCard} data-tone={card.key}>
          <button type='button' className={css.aiCardToggle} aria-expanded={openCards[card.key] === true} onClick={() => { toggle(card.key) }}>
            <span className={css.aiCardTitle}>{card.title}</span>
            {card.digest !== '' && <span className={css.aiCardDigest}>{card.digest.length > 48 ? `${card.digest.slice(0, 48)}…` : card.digest}</span>}
            <span className={css.aiArrow} aria-hidden='true'>▶</span>
          </button>
          <div className={css.aiCardBody} hidden={openCards[card.key] !== true}>{card.body}</div>
        </section>
      ))}
    </div>
  )
}

/** 风险/建议条目列表（等级徽章 Tag + 证据 chip）。 */
function AiItems(props: {
  items: { title: string | null; detail: string | null; priority: string | null; evidenceWorkIds: string[] }[]
  badge: 'priority'
  evidenceOf: (workId: string) => string | null
  onOpenWork: (accountId: string, work: HotWorkRow) => void
  t: Translate
}): ReactNode {
  return (
    <div className={css.aiItems}>
      {props.items.map((item, index) => (
        <div key={index} className={css.aiItem}>
          <div className={css.aiItemHead}>
            <span className={css.aiItemTitle}>{item.title ?? '—'}</span>
            <Tag tone={gradeTone(item.priority)}>{gradeText(item.priority, props.t)}</Tag>
          </div>
          {item.detail !== null && <p className={css.aiText}>{item.detail}</p>}
          <EvidenceChips workIds={item.evidenceWorkIds} evidenceOf={props.evidenceOf} onOpenWork={props.onOpenWork} t={props.t} />
        </div>
      ))}
    </div>
  )
}

/** 证据作品 chip（点击叠开统一作品详情）。 */
function EvidenceChips(props: {
  workIds: string[]
  evidenceOf: (workId: string) => string | null
  onOpenWork: (accountId: string, work: HotWorkRow) => void
  t: Translate
}): ReactNode {
  const unique = [...new Set(props.workIds)]
  if (unique.length === 0) return null
  return (
    <div className={css.aiEvidence}>
      <span className={css.aiEvidenceLabel}>{props.t('ai.evidence')}</span>
      <div className={css.aiEvidenceList}>
        {unique.map(workId => {
          const title = props.evidenceOf(workId)
          return (
            <button
              key={workId}
              type='button'
              className={css.aiChip}
              title={title ?? workId}
              onClick={() => {
                props.onOpenWork('', { workId, accountId: null, accountNickname: null, title, publishTime: null, playCount: null, engagementRatePct: null, fansGainCount: null, basis: null, labels: null, promoted: false, rank: null })
              }}
            >
              {title !== null && title.length > 18 ? `${title.slice(0, 18)}…` : title !== null ? title : `${workId.slice(0, 8)}…`}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 指标 Menu（7 枚举）。 */
function MetricMenu(props: { t: Translate; metric: string; onChange: (metric: string) => void }): ReactNode {
  const [open, setOpen] = useState(false)
  const current = TREND_METRICS.find(item => item.id === props.metric) ?? TREND_METRICS[0]
  if (current === undefined) return null
  return (
    <span className={css.filterGroup}>
      <span className={css.filterGroupLabel}>{props.t('analysis.trend.metric')}</span>
      <Menu
        open={open}
        anchor={(
          <Button
            variant='outline'
            size='sm'
            aria-haspopup='menu'
            aria-expanded={open}
            aria-label={props.t('analysis.trend.metric')}
            onClick={() => { setOpen(value => !value) }}
          >
            {props.t(current.labelKey)}
          </Button>
        )}
        items={TREND_METRICS.map(item => ({ id: item.id, label: props.t(item.labelKey) }))}
        selectedId={props.metric}
        onSelect={id => {
          setOpen(false)
          props.onChange(id)
        }}
        onClose={() => { setOpen(false) }}
      />
    </span>
  )
}

/** KPI 瓦片（与总览同款）。 */
function KpiTile(props: { label: string; value: ReactNode }): ReactNode {
  return (
    <div className={css.kpiTile}>
      <span className={css.metricLabel}>{props.label}</span>
      <strong className={css.kpiValue}>{props.value}</strong>
    </div>
  )
}

/** 受众块。 */
function AudienceCard(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.audienceCard}>
      <span className={css.audienceCardTitle}>{props.title}</span>
      {props.children}
    </div>
  )
}

/** 净增/吸粉着色节点。 */
function deltaNode(value: number | null, localeTag: string, mode: 'net' | 'cancel' = 'net'): ReactNode {
  const delta = fanDelta(value, mode, localeTag)
  if (delta.tone === 'flat') return <span>{delta.text}</span>
  return <span className={delta.tone === 'up' ? css.deltaUp : css.deltaDown}>{delta.text}</span>
}

/** 服务端 ruleId → 词典键（未登记收敛「其他标签」）。 */
function alertRuleText(ruleId: string, t: Translate): string {
  const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
    high_play_low_engagement: 'analysis.rule.high_play_low_engagement',
    high_engagement_low_play: 'analysis.rule.high_engagement_low_play',
    retention_anomaly: 'analysis.rule.retention_anomaly',
  }
  const key = keys[ruleId]
  return key !== undefined ? t(key) : t('hot.label.other')
}

/** AI 状态 → 词典键。 */
function aiStatusKey(status: string): Parameters<Translate>[0] {
  const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
    not_analyzed: 'ai.status.not_analyzed',
    running: 'ai.status.running',
    succeeded: 'ai.status.succeeded',
    insufficient: 'ai.status.insufficient',
    failed: 'ai.status.failed',
  }
  return keys[status] ?? 'ai.status.not_analyzed'
}

/** AI 错误码 → 文案（9 码全表 + 默认）。 */
function aiErrorText(reason: string, t: Translate): string {
  return domainErrorText('ai', reason, t)
}

/** 等级 → 词典键。 */
function levelKey(level: string): Parameters<Translate>[0] {
  const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
    strong: 'ai.level.strong',
    medium: 'ai.level.medium',
    weak: 'ai.level.weak',
    insufficient: 'ai.level.insufficient',
  }
  return keys[level] ?? 'ai.level.insufficient'
}

/** 等级 → Tag tone。 */
function levelTone(level: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (level === 'strong') return 'success'
  if (level === 'medium') return 'warning'
  if (level === 'weak') return 'danger'
  return 'neutral'
}

/** 高/中/低 → 词典键文本。 */
function gradeText(value: string | null, t: Translate): string {
  const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
    high: 'ai.grade.high',
    medium: 'ai.grade.medium',
    low: 'ai.grade.low',
  }
  const key = value !== null ? keys[value] : undefined
  return key !== undefined ? t(key) : t('ai.grade.low')
}

/** 高/中/低 → Tag tone。 */
function gradeTone(value: string | null): 'success' | 'warning' | 'neutral' {
  if (value === 'high') return 'success'
  if (value === 'medium') return 'warning'
  return 'neutral'
}

/** 整体评估文本。 */
function assessmentText(value: string | null, t: Translate): string {
  const keys: Readonly<Record<string, Parameters<Translate>[0]>> = {
    stable: 'ai.assessment.stable',
    growing: 'ai.assessment.growing',
    volatile: 'ai.assessment.volatile',
  }
  const key = value !== null ? keys[value] : undefined
  return key !== undefined ? t(key) : '—'
}

/** 导出图标。 */
function ExportIcon(): ReactNode {
  return (
    <svg width='14' height='14' viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <path d='M8 2.5v7m0 0L5.2 6.7M8 9.5l2.8-2.8M3 12.5h10' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' strokeLinejoin='round' />
    </svg>
  )
}

/** 客户端幂等键后缀（32 位小写 hex）。 */
export function attemptId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}
