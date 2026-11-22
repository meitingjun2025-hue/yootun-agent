/**
 * 爆款基因库页（旧 gene-ui.js 布局与任务动线重译）：检索工具栏（query 400ms
 * 防抖 + 品类/采纳态 FilterMenu + 重置）+ KPI 四卡（stats 唯一数据源，失败 —
 * 不造 0）+ 失败警示胶囊（failedCount>0）+ 动态 facets 面板（每维度 Top3 +
 * 展开、chip 选中/移除、维度色映射 --yt-chart-*）+ 已选条件条（清空全部）+
 * 基因卡片墙（封面降级/标签 ≤6/三指标/查看详情/失败重试）+ 加载更多（offset
 * 递增）+ 详情弹层（标签与依据/完整报告四态字段/人工编辑：非 succeeded 仅备注、
 * pending/running 整区禁用/重建确认：覆盖 AI 标签回到草稿、可能产生费用）+
 * 失败列表弹层（逐项同键重试）。update/regenerate 失败保留输入与回执键，
 * IDEMPOTENCY_OUTCOME_UNKNOWN 不换新键。
 * @module
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard, DataState, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { domainErrorText, formatCount, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  readGeneEvidence, readGeneList, readGeneRecord, readGeneSearch,
  type GeneDimension, type GeneFacetEntry, type GeneRecord, type GeneSearch,
} from './schema.ts'
import { FilterMenu } from './FilterMenu.tsx'
import { attemptId } from './AnalysisPage.tsx'

const SEARCH_DEBOUNCE_MS = 400
const GENE_PAGE_LIMIT = 20
const FACETS_COLLAPSE_AT = 3

/** 基因筛选态。 */
interface GeneFilters {
  query: string
  category: string
  adoption: '' | 'ai_draft' | 'adopted' | 'revised'
  dims: Record<string, string[]>
}

const DEFAULT_GENE_FILTERS: GeneFilters = { query: '', category: '', adoption: '', dims: {} }

/** 维度 → 语义类别色序号（--yt-chart-1..9；色彩不承载唯一信息，chip 恒有文字）。 */
const DIMENSION_CHART_KEYS: readonly string[] = ['category', 'topic', 'hook', 'structure', 'script', 'shot', 'bgm', 'audience', 'engagement']

function dimensionTone(dim: string): string {
  const index = DIMENSION_CHART_KEYS.indexOf(dim)
  return index >= 0 ? String(index + 1) : '1'
}

export interface GenePageProps {
  t: Translate
  localeTag: string
  /** 顶级 Tab 是否当前展示（keep-alive：重进 offset 归零重拉；filters/弹层状态保留）。 */
  active: boolean
  onNotice: (text: string) => void
}

/** 爆款基因库页组件。 */
export function GenePage(props: GenePageProps): ReactNode {
  const t = props.t
  const active = props.active
  const [filters, setFilters] = useState<GeneFilters>(DEFAULT_GENE_FILTERS)
  const [search, setSearch] = useState<{ data: GeneSearch | null; loading: boolean; appending: boolean; errorReason: string | null }>({ data: null, loading: true, appending: false, errorReason: null })
  const [offset, setOffset] = useState(0)
  const [facetsOpen, setFacetsOpen] = useState(true)
  const [expandedDims, setExpandedDims] = useState<Record<string, boolean>>({})
  const [detail, setDetail] = useState<{ recordId: string; record: GeneRecord | null; loading: boolean; errorReason: string | null } | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ items: GeneRecord[]; loading: boolean; errorReason: string | null } | null>(null)

  const filtersRef = useRef(filters)
  const searchSeqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateAttemptRef = useRef<{ recordId: string; payloadKey: string; key: string } | null>(null)
  const regenAttemptRef = useRef<{ recordId: string; key: string } | null>(null)

  useEffect(() => () => {
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
  }, [])

  const doSearch = useCallback(async (nextOffset: number, options?: { more?: boolean }): Promise<void> => {
    const query = filtersRef.current
    const seq = ++searchSeqRef.current
    setSearch(previous => ({ ...previous, loading: options?.more !== true, appending: options?.more === true, errorReason: null }))
    try {
      const res = await hostAction('gene.search', {
        ...(query.query.trim() !== '' ? { query: query.query.trim() } : {}),
        ...(query.category !== '' ? { category: query.category } : {}),
        ...(query.adoption !== '' ? { adoptionStatus: query.adoption } : {}),
        ...(Object.keys(query.dims).length > 0 ? { geneTags: query.dims } : {}),
        offset: nextOffset,
        limit: GENE_PAGE_LIMIT,
      })
      if (searchSeqRef.current !== seq) return
      const view = readGeneSearch(res)
      setSearch(previous => ({
        data: options?.more === true && previous.data !== null
          ? { ...view, results: [...previous.data.results, ...view.results] }
          : view,
        loading: false,
        appending: false,
        errorReason: null,
      }))
      setOffset(nextOffset)
    } catch (error) {
      if (searchSeqRef.current !== seq) return
      setSearch(previous => ({ ...previous, loading: false, appending: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
    }
  }, [])

  // Tab 激活（含首次挂载）offset 归零重拉检索；inactive 期间状态全部保留
  //（旧基因库无轮询态，无后台任务需要停止）。
  useEffect(() => {
    if (props.active) void doSearch(0)
  }, [props.active, doSearch])

  const applyFilters = useCallback((next: GeneFilters): void => {
    filtersRef.current = next
    setFilters(next)
    void doSearch(0)
  }, [doSearch])

  const onQueryChange = useCallback((value: string): void => {
    const next = { ...filtersRef.current, query: value }
    filtersRef.current = next
    setFilters(next)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void doSearch(0) }, SEARCH_DEBOUNCE_MS)
  }, [doSearch])

  const toggleTag = useCallback((dim: string, label: string): void => {
    const current = filtersRef.current.dims[dim] ?? []
    const nextLabels = current.includes(label) ? current.filter(item => item !== label) : [...current, label]
    const dims = { ...filtersRef.current.dims }
    if (nextLabels.length > 0) dims[dim] = nextLabels
    else delete dims[dim]
    applyFilters({ ...filtersRef.current, dims })
  }, [applyFilters])

  const removeTag = useCallback((dim: string, label: string): void => {
    toggleTag(dim, label)
  }, [toggleTag])

  const clearTags = useCallback((): void => {
    applyFilters({ ...filtersRef.current, dims: {} })
  }, [applyFilters])

  const resetFilters = useCallback((): void => {
    applyFilters(DEFAULT_GENE_FILTERS)
  }, [applyFilters])

  const openDetail = useCallback(async (recordId: string): Promise<void> => {
    setSaveError(null)
    setRetryError(null)
    setDetail({ recordId, record: null, loading: true, errorReason: null })
    try {
      const res = await hostAction('gene.get', { recordId })
      setDetail({ recordId, record: readGeneRecord(res), loading: false, errorReason: null })
    } catch (error) {
      setDetail({ recordId, record: null, loading: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' })
    }
  }, [])

  /** 人工修正保存：同 recordId + 同参数复用同键（OUTCOME_UNKNOWN 同键重试）；换参数新键。 */
  const saveEdit = useCallback(async (recordId: string, payload: { geneTags?: Record<string, string[]>; manualNotes: string; adoptionStatus?: string }): Promise<void> => {
    const payloadKey = JSON.stringify(payload)
    if (updateAttemptRef.current === null || updateAttemptRef.current.recordId !== recordId || updateAttemptRef.current.payloadKey !== payloadKey) {
      updateAttemptRef.current = { recordId, payloadKey, key: `douyin:vv_gene_upd:${recordId}:${attemptId()}` }
    }
    const key = updateAttemptRef.current.key
    setSaving(true)
    setSaveError(null)
    try {
      await hostAction('gene.update', {
        recordId,
        idempotencyKey: key,
        manualNotes: payload.manualNotes,
        ...(payload.geneTags !== undefined ? { geneTags: payload.geneTags } : {}),
        ...(payload.adoptionStatus !== undefined ? { adoptionStatus: payload.adoptionStatus } : {}),
      })
      updateAttemptRef.current = null
      setSaving(false)
      await openDetail(recordId)
      void doSearch(offset)
    } catch (error) {
      setSaving(false)
      setSaveError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
    }
  }, [doSearch, offset, openDetail])

  /** 重建：同一点击的重试复用同键（不重复计费）；成功终态后新点击换新键。 */
  const regenerate = useCallback(async (recordId: string): Promise<boolean> => {
    if (regenAttemptRef.current === null || regenAttemptRef.current.recordId !== recordId) {
      regenAttemptRef.current = { recordId, key: `douyin:vv_gene_reg:${recordId}:${attemptId()}` }
    }
    setRetryingId(recordId)
    setRetryError(null)
    try {
      await hostAction('gene.regenerate', { recordId, idempotencyKey: regenAttemptRef.current.key })
      regenAttemptRef.current = null
      setRetryingId(null)
      setDetail(previous => previous !== null && previous.record?.recordId === recordId
        ? { ...previous, record: previous.record !== null ? { ...previous.record, geneStatus: 'pending' } : previous.record }
        : previous)
      void doSearch(offset)
      return true
    } catch (error) {
      setRetryingId(null)
      setRetryError(error instanceof Error ? error.message : 'douyin_operation_request_failed')
      return false
    }
  }, [doSearch, offset])

  const openFailed = useCallback(async (): Promise<void> => {
    setFailed({ items: [], loading: true, errorReason: null })
    try {
      const res = await hostAction('gene.list', { geneStatus: 'failed', limit: 100 })
      setFailed({ items: readGeneList(res), loading: false, errorReason: null })
    } catch (error) {
      setFailed({ items: [], loading: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' })
    }
  }, [])

  const data = search.data
  const stats = data?.stats ?? null
  const failedCount = stats?.failedCount ?? null
  const items = data?.results ?? []
  const dimensions = data?.dimensions ?? []
  const facets = data?.facets ?? {}
  const hasMore = data?.hasMore ?? false
  const selectedEntries = Object.entries(filters.dims).flatMap(([dim, labels]) => labels.map(label => ({ dim, label })))
  const dimName = useMemo(() => {
    const names: Record<string, string> = {}
    for (const dim of dimensions) names[dim.id] = dim.name
    return names
  }, [dimensions])

  return (
    <div className={css.pageBody}>
      <div className={css.geneHead}>
        <div className={css.geneHeadMain}>
          <h2 className={css.geneTitle}>{t('tab.gene')}</h2>
          <p className={css.inlineHint}>{t('gene.subtitle')}</p>
        </div>
        {failedCount !== null && failedCount > 0 && (
          <Button variant='ghost' size='sm' className={css.dangerButton} aria-label={t('gene.failedEntryAria')} onClick={() => { void openFailed() }}>
            {t('gene.failedEntry')}（{failedCount}）
          </Button>
        )}
      </div>

      <div className={css.matFilters}>
        <Input
          value={filters.query}
          placeholder={t('gene.searchPlaceholder')}
          aria-label={t('gene.searchLabel')}
          onChange={event => { onQueryChange(event.target.value) }}
        />
        <FilterMenu
          label={t('gene.filter.category')}
          currentLabel={filters.category === '' ? t('gene.filter.category.all') : filters.category}
          items={[{ id: '', label: t('gene.filter.category.all') }, ...(facets.category ?? []).map(entry => ({ id: entry.label, label: `${entry.label}（${entry.count}）` }))]}
          selectedId={filters.category}
          onSelect={id => { applyFilters({ ...filtersRef.current, category: id }) }}
        />
        <FilterMenu
          label={t('gene.filter.adoption')}
          currentLabel={filters.adoption === '' ? t('gene.filter.adoption.all') : t(`gene.filter.adoption.${filters.adoption}` as 'gene.filter.adoption.adopted')}
          items={[
            { id: '', label: t('gene.filter.adoption.all') },
            { id: 'ai_draft', label: t('gene.filter.adoption.ai_draft') },
            { id: 'adopted', label: t('gene.filter.adoption.adopted') },
            { id: 'revised', label: t('gene.filter.adoption.revised') },
          ]}
          selectedId={filters.adoption}
          onSelect={id => { applyFilters({ ...filtersRef.current, adoption: id as GeneFilters['adoption'] }) }}
        />
        <Button variant='ghost' size='sm' onClick={resetFilters}>{t('gene.reset')}</Button>
      </div>

      <div className={css.kpiRow}>
        <KpiCard label={t('gene.kpi.total')} value={stats === null ? '—' : formatCount(stats.total)} footnote={t('gene.kpi.totalFoot')} />
        <KpiCard label={t('gene.kpi.last7d')} value={stats === null ? '—' : formatCount(stats.last7d)} footnote={t('gene.kpi.last7dFoot')} />
        <KpiCard label={t('gene.kpi.adopted')} value={stats !== null && stats.adoptedRatio !== null ? `${Math.round(stats.adoptedRatio * 100)}%` : '—'} footnote={t('gene.kpi.adoptedFoot')} />
        <KpiCard
          label={t('gene.kpi.failed')}
          value={failedCount === null ? '—' : formatCount(failedCount)}
          footnote={failedCount !== null && failedCount > 0 ? t('gene.kpi.failedFoot') : t('gene.kpi.failedCalm')}
        />
      </div>

      <DataCard
        title={t('gene.facetsTitle')}
        description={t('gene.facetsNote')}
        actions={(
          <Button variant='ghost' size='sm' aria-expanded={facetsOpen} onClick={() => { setFacetsOpen(value => !value) }}>
            {facetsOpen ? t('gene.facetsCollapse') : t('gene.facetsExpand')}
          </Button>
        )}
      >
        {facetsOpen && (
          <div className={css.geneFacetBody}>
            {dimensions.map(dim => (
              <FacetGroup
                key={dim.id}
                dim={dim}
                entries={facets[dim.id] ?? []}
                selected={filters.dims[dim.id] ?? []}
                expanded={expandedDims[dim.id] === true}
                t={t}
                onToggleTag={toggleTag}
                onToggleDim={() => { setExpandedDims(previous => ({ ...previous, [dim.id]: !(previous[dim.id] === true) })) }}
              />
            ))}
          </div>
        )}
        {selectedEntries.length > 0 && (
          <div className={css.geneSelected} aria-live='polite'>
            <span className={css.inlineHint}>{t('gene.selected')}</span>
            {selectedEntries.map(({ dim, label }) => (
              <button
                key={`${dim}:${label}`}
                type='button'
                className={css.geneChip}
                data-selected
                title={t('gene.selectedRemove')}
                onClick={() => { removeTag(dim, label) }}
              >
                {`${dimName[dim] ?? dim}·${label}`} ✕
              </button>
            ))}
            <Button variant='ghost' size='sm' onClick={clearTags}>{t('gene.clearAll')}</Button>
          </div>
        )}
      </DataCard>

      {search.errorReason !== null && (
        <p className={css.formError} role='alert'>{domainErrorText('gene', search.errorReason, t)}</p>
      )}
      <DataState state={search.loading && items.length === 0 ? 'loading' : search.errorReason !== null && items.length === 0 ? 'error' : 'ready'} shape='rows' onRetry={() => { void doSearch(0) }}>
        {items.length === 0 && !search.loading && (
          <div className={css.emptyState} role='status'><p>{t('gene.empty')}</p></div>
        )}
        <div className={css.geneCardWall}>
          {items.map(record => (
            <GeneCard
              key={record.recordId}
              record={record}
              t={t}
              onOpenDetail={() => { void openDetail(record.recordId) }}
              onRetry={() => { void regenerate(record.recordId) }}
              retrying={retryingId === record.recordId}
            />
          ))}
        </div>
        <div className={css.matMeta}>
          <span>
            {data !== null
              ? t('gene.meta', { total: formatCount(data.total), shown: items.length, loading: search.loading || search.appending ? t('gene.metaLoading') : '' })
              : t('state.loading')}
          </span>
          <Button variant='ghost' size='sm' disabled={!hasMore || search.loading || search.appending} onClick={() => { void doSearch(offset + GENE_PAGE_LIMIT, { more: true }) }}>
            {t('gene.loadMore')}
          </Button>
        </div>
      </DataState>

      {active && detail !== null && (
        <GeneDetailModal
          detail={detail}
          dimensions={dimensions}
          saving={saving}
          saveError={saveError}
          retryingId={retryingId}
          retryError={retryError}
          t={t}
          onClose={() => { setDetail(null) }}
          onSaveEdit={saveEdit}
          onRegenerate={() => { void regenerate(detail.recordId) }}
        />
      )}
      {active && failed !== null && (
        <GeneFailedModal
          failed={failed}
          retryingId={retryingId}
          retryError={retryError}
          t={t}
          onRetry={recordId => { void regenerate(recordId) }}
          onClose={() => { setFailed(null) }}
        />
      )}
    </div>
  )
}

/** facets 维度组（Top3 + 「+N/收起」；chip 选中态附文字）。 */
function FacetGroup(props: {
  dim: GeneDimension
  entries: GeneFacetEntry[]
  selected: string[]
  expanded: boolean
  t: Translate
  onToggleTag: (dim: string, label: string) => void
  onToggleDim: () => void
}): ReactNode {
  const t = props.t
  const hidden = Math.max(0, props.entries.length - FACETS_COLLAPSE_AT)
  const showAll = props.expanded || hidden <= 2
  const visible = showAll ? props.entries : props.entries.slice(0, FACETS_COLLAPSE_AT)
  return (
    <div className={css.geneFacetGroup}>
      <span className={css.geneFacetLabel}>{props.dim.name}</span>
      <div className={css.geneFacetChips}>
        {visible.map(entry => (
          <button
            key={entry.label}
            type='button'
            className={css.geneChip}
            data-tone={dimensionTone(props.dim.id)}
            aria-pressed={props.selected.includes(entry.label)}
            onClick={() => { props.onToggleTag(props.dim.id, entry.label) }}
          >
            {entry.label}
            <span className={css.geneChipCount}>{entry.count}</span>
          </button>
        ))}
        {hidden > 2 && (
          <button type='button' className={css.geneFacetMore} onClick={props.onToggleDim}>
            {props.expanded ? t('gene.facetsCollapse') : t('gene.facetsMore', { count: hidden })}
          </button>
        )}
      </div>
    </div>
  )
}

/** 基因卡片（封面降级 + 标签 ≤6 + 三指标 + 操作）。 */
function GeneCard(props: { record: GeneRecord; t: Translate; onOpenDetail: () => void; onRetry: () => void; retrying: boolean }): ReactNode {
  const t = props.t
  const record = props.record
  const failed = record.geneStatus === 'failed'
  const pill = geneStatusPill(record, t)
  const tags: ReactNode[] = []
  for (const [dim, labels] of Object.entries(record.geneTags)) {
    for (const label of labels) {
      tags.push(<span key={`${dim}:${label}`} className={css.geneTag} data-tone={dimensionTone(dim)}>{label}</span>)
      if (tags.length >= 6) break
    }
    if (tags.length >= 6) break
  }
  const videoUrl = record.awemeId !== null && /^\d{4,32}$/u.test(record.awemeId) ? `https://www.douyin.com/video/${record.awemeId}` : null
  return (
    <article className={css.geneCard} data-failed={failed || undefined}>
      <div className={css.geneCardHead}>
        <GeneCover record={record} t={t} />
        <div className={css.geneCardMain}>
          <h3 className={css.geneCardTitle}>
            {videoUrl !== null
              ? <a href={videoUrl} target='_blank' rel='noreferrer noopener' title={record.title ?? undefined}>{record.title ?? '—'}</a>
              : record.title ?? '—'}
          </h3>
          <p className={css.geneCardMeta}>
            <span>{record.authorName ?? '—'}</span>
            <span>{record.publishedAt !== null ? record.publishedAt.slice(0, 10) : '—'}</span>
            {pill}
          </p>
        </div>
      </div>
      <div className={css.geneTags}>
        {tags.length > 0 ? tags : <span className={css.inlineHint}>{failed ? t('gene.card.failedHint') : t('gene.card.noTags')}</span>}
      </div>
      <dl className={css.geneMetrics}>
        <div><dt>{t('gene.card.play')}</dt><dd>{formatCount(record.metrics.playCount)}</dd></div>
        <div><dt>{t('gene.card.like')}</dt><dd>{formatCount(record.metrics.likeCount)}</dd></div>
        <div><dt>{t('gene.card.collect')}</dt><dd>{formatCount(record.metrics.collectCount)}</dd></div>
      </dl>
      <div className={css.geneCardFoot}>
        {failed && (
          <Button variant='ghost' size='sm' disabled={props.retrying} aria-busy={props.retrying || undefined} onClick={props.onRetry}>
            {props.retrying ? t('gene.failed.retrying') : t('gene.card.retry')}
          </Button>
        )}
        <Button variant='ghost' size='sm' onClick={props.onOpenDetail}>{t('gene.card.detail')}</Button>
      </div>
    </article>
  )
}

/** 状态 pill（AI 草稿/已采纳/已修正/提取失败/提取中）。 */
function geneStatusPill(record: GeneRecord, t: Translate): ReactNode {
  if (record.geneStatus === 'failed') return <Tag tone='danger'>{t('gene.failedEntry')}</Tag>
  if (record.geneStatus === 'pending' || record.geneStatus === 'running') return <Tag tone='neutral'>{t('gene.detail.loading')}</Tag>
  if (record.adoptionStatus === 'adopted') return <Tag tone='success'>{t('gene.filter.adoption.adopted')}</Tag>
  if (record.adoptionStatus === 'revised') return <Tag tone='success'>{t('gene.filter.adoption.revised')}</Tag>
  return <Tag tone='neutral'>{t('gene.filter.adoption.ai_draft')}</Tag>
}

/** 封面（加载失败/缺失降级；时长角标）。 */
function GeneCover(props: { record: GeneRecord; t: Translate }): ReactNode {
  const [failedLoad, setFailedLoad] = useState(false)
  const duration = props.record.durationSeconds !== null && Number.isFinite(props.record.durationSeconds)
    ? `${String(Math.floor(props.record.durationSeconds / 60)).padStart(2, '0')}:${String(Math.round(props.record.durationSeconds % 60)).padStart(2, '0')}`
    : null
  return (
    <span className={css.geneCover}>
      {props.record.coverUrl !== null && !failedLoad
        ? (
          <img
            src={props.record.coverUrl}
            alt={props.t('gene.card.cover')}
            loading='lazy'
            referrerPolicy='no-referrer'
            onError={() => { setFailedLoad(true) }}
          />
        )
        : <span className={css.geneCoverFallback} aria-hidden='true'>—</span>}
      {duration !== null ? <span className={css.geneCoverDuration}>{duration}</span> : null}
    </span>
  )
}

/** 详情弹层（标签与依据 + 完整报告 + 人工编辑 + 重建确认）。 */
function GeneDetailModal(props: {
  detail: { recordId: string; record: GeneRecord | null; loading: boolean; errorReason: string | null }
  dimensions: GeneDimension[]
  saving: boolean
  saveError: string | null
  retryingId: string | null
  retryError: string | null
  t: Translate
  onClose: () => void
  onSaveEdit: (recordId: string, payload: { geneTags?: Record<string, string[]>; manualNotes: string; adoptionStatus?: string }) => Promise<void>
  onRegenerate: () => void
}): ReactNode {
  const t = props.t
  const record = props.detail.record
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  useEffect(() => { setConfirmRegenerate(false) }, [props.detail.recordId])
  useEffect(() => {
    if (record !== null && (record.geneStatus === 'pending' || record.geneStatus === 'running')) setConfirmRegenerate(false)
  }, [record])
  return (
    <Modal
      open
      title={t('gene.detail.title')}
      closeLabel={t('dialog.close')}
      onClose={props.onClose}
    >
      {props.detail.loading
        ? <p role='status' aria-busy='true'>{t('gene.detail.loading')}</p>
        : props.detail.errorReason !== null
          ? <p className={css.formError} role='alert'>{domainErrorText('gene', props.detail.errorReason, t)}</p>
          : record !== null && (
            <>
              <div className={css.geneDetailHead}>
                <GeneCover record={record} t={t} />
                <div className={css.geneDetailMain}>
                  <h3 className={css.geneDetailTitle}>{record.title ?? '—'}</h3>
                  <p className={css.geneCardMeta}>
                    <span>{record.authorName ?? '—'}</span>
                    <span>{record.publishedAt !== null ? record.publishedAt.slice(0, 10) : '—'}</span>
                    <span>{t('gene.card.play')} {formatCount(record.metrics.playCount)}</span>
                    <span>{t('gene.card.like')} {formatCount(record.metrics.likeCount)}</span>
                    <span>{t('mat.col.comment')} {formatCount(record.metrics.commentCount)}</span>
                    <span>{t('gene.card.collect')} {formatCount(record.metrics.collectCount)}</span>
                    {record.shareUrl !== null ? <a href={record.shareUrl} target='_blank' rel='noreferrer noopener'>{t('gene.link.original')}</a> : null}
                  </p>
                  <p className={css.geneTags}>
                    {Object.entries(record.geneTags).flatMap(([dim, labels]) =>
                      labels.map(label => <span key={`${dim}:${label}`} className={css.geneTag} data-tone={dimensionTone(dim)}>{label}</span>))}
                    {geneStatusPill(record, t)}
                  </p>
                </div>
              </div>
              <section>
                <h4>{t('gene.detail.dimsTitle')}</h4>
                <GeneDimsView record={record} dimensions={props.dimensions} t={t} />
              </section>
              <section>
                <h4>{t('gene.detail.reportTitle')}</h4>
                <ReportGrid record={record} t={t} />
              </section>
              <section>
                <h4>{t('gene.detail.editTitle')}</h4>
                <GeneEditPanel
                  record={record}
                  dimensions={props.dimensions}
                  saving={props.saving}
                  saveError={props.saveError}
                  busy={confirmRegenerate || props.retryingId !== null}
                  t={t}
                  onSave={props.onSaveEdit}
                />
                <div className={css.geneRegenRow}>
                  {confirmRegenerate
                    ? (
                      <>
                        <p className={css.inlineHint}>{t('gene.regenerateBody')}</p>
                        <span className={css.workToolbarRow}>
                          <Button
                            variant='primary'
                            size='sm'
                            disabled={props.retryingId === record.recordId}
                            aria-busy={props.retryingId === record.recordId || undefined}
                            onClick={() => { setConfirmRegenerate(false); props.onRegenerate() }}
                          >
                            {props.retryingId === record.recordId ? t('gene.regenerateSubmitting') : t('gene.regenerateConfirm')}
                          </Button>
                          <Button variant='ghost' size='sm' onClick={() => { setConfirmRegenerate(false) }}>
                            {t('gene.regenerateCancel')}
                          </Button>
                        </span>
                      </>
                    )
                    : (
                      <Button
                        variant='ghost'
                        size='sm'
                        disabled={record.geneStatus === 'pending' || record.geneStatus === 'running' || props.retryingId !== null}
                        onClick={() => { setConfirmRegenerate(true) }}
                      >
                        {record.geneStatus === 'failed' ? t('gene.regenerateRetry') : t('gene.regenerate')}
                      </Button>
                    )}
                </div>
                {record.geneStatus === 'failed' && record.geneErrorCode !== null && (
                  <p className={css.inlineHint}>
                    {t('gene.failed.itemReason', { code: record.geneErrorCode, count: formatCount(record.geneAttemptCount) })}
                  </p>
                )}
                {props.retryError !== null && <p className={css.formError} role='alert'>{domainErrorText('gene', props.retryError, t)}</p>}
              </section>
            </>
          )}
    </Modal>
  )
}

/** 基因维度视图（每维度标签 + 依据列表；audience 附 AI 推断）。 */
function GeneDimsView(props: { record: GeneRecord; dimensions: GeneDimension[]; t: Translate }): ReactNode {
  const t = props.t
  const record = props.record
  const dims = Object.entries(record.geneTags).filter(([, labels]) => labels.length > 0)
  if (dims.length === 0) {
    return <p className={css.inlineHint}>{record.geneStatus === 'failed' ? t('gene.detail.noTagsFailed') : t('gene.detail.noTags')}</p>
  }
  const names: Record<string, string> = {}
  for (const dim of props.dimensions) names[dim.id] = dim.name
  const evidence = record.geneEvidenceJson ?? {}
  return (
    <div className={css.geneDims}>
      {dims.map(([dim, labels]) => {
        const evidenceItems = readGeneEvidence(evidence[dim])
        return (
          <div key={dim} className={css.geneDim}>
            <div className={css.geneDimHead}>
              <span className={css.geneDimName}>{names[dim] ?? dim}</span>
              {dim === 'audience' ? <Tag tone='neutral'>{t('gene.detail.aiInference')}</Tag> : null}
            </div>
            <div className={css.geneTags}>
              {labels.map(label => <span key={label} className={css.geneTag} data-tone={dimensionTone(dim)}>{label}</span>)}
            </div>
            {evidenceItems.length > 0 && (
              <ul className={css.matReasonList}>
                {evidenceItems.map((item, index) => (
                  <li key={`${dim}:${index}`} className={css.matReasonItem}>
                    {t('gene.detail.evidence', { label: item.label || '—', basis: item.basis || '—' })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** 完整报告网格（四态字段采集状态；缺失「未采集」）。 */
function ReportGrid(props: { record: GeneRecord; t: Translate }): ReactNode {
  const t = props.t
  const report = props.record.reportJson ?? {}
  const fieldStateCopy = (state: string | null): string | null => {
    if (state === null) return null
    if (state === 'legacy_snapshot') return t('gene.report.state.legacy_snapshot')
    if (state === 'parse_failed') return t('gene.report.state.parse_failed')
    if (state === 'not_exposed') return t('gene.report.state.not_exposed')
    if (state === 'unknown') return t('gene.report.state.unknown')
    return null
  }
  const text = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed === '' ? null : trimmed
  }
  const joinList = (value: unknown): string | null => {
    if (!Array.isArray(value)) return null
    const joined = value.filter(item => typeof item === 'string' && item.trim() !== '').join('、')
    return joined === '' ? null : joined
  }
  const insight = typeof report.audienceInsight === 'object' && report.audienceInsight !== null ? report.audienceInsight as Record<string, unknown> : null
  const bgm = typeof report.bgmStyle === 'object' && report.bgmStyle !== null ? report.bgmStyle as Record<string, unknown> : null
  const insightText = insight !== null
    ? [
      joinList(insight.targetGroups) !== null ? t('gene.report.groups', { value: joinList(insight.targetGroups) ?? '' }) : null,
      joinList(insight.scenes) !== null ? t('gene.report.scenes', { value: joinList(insight.scenes) ?? '' }) : null,
      joinList(insight.painPoints) !== null ? t('gene.report.painPoints', { value: joinList(insight.painPoints) ?? '' }) : null,
    ].filter((line): line is string => line !== null).join('；') || null
    : null
  const bgmText = bgm !== null
    ? [
      text(bgm.style) !== null ? t('gene.report.style', { value: text(bgm.style) ?? '' }) : null,
      text(bgm.tempo) !== null ? t('gene.report.tempo', { value: text(bgm.tempo) ?? '' }) : null,
      text(bgm.mood) !== null ? t('gene.report.mood', { value: text(bgm.mood) ?? '' }) : null,
      text(bgm.usage) !== null ? t('gene.report.usage', { value: text(bgm.usage) ?? '' }) : null,
    ].filter((line): line is string => line !== null).join('；') || null
    : null
  const rows: [string, string | null][] = [
    [t('gene.report.summary'), text(report.summary)],
    [t('gene.report.hook'), text(report.hook)],
    [t('gene.report.rhythm'), text(report.rhythm)],
    [t('gene.report.audience'), text(report.audience)],
    [t('gene.report.sellingPoints'), joinList(report.sellingPoints)],
    [t('gene.report.rewriteHints'), joinList(report.rewriteHints)],
    [t('gene.report.audienceInsight'), fieldStateCopy(props.record.audienceInsightState) ?? insightText],
    [t('gene.report.bgm'), fieldStateCopy(props.record.bgmStyleState) ?? bgmText],
    [t('gene.report.segmentCount'), typeof report.segmentCount === 'number' ? `${report.segmentCount}${t('gene.report.segmentUnit')}` : null],
  ]
  return (
    <dl className={css.metaList}>
      {rows.map(([label, value]) => (
        <div key={label} className={css.metaRow}>
          <dt>{label}</dt>
          <dd>{value ?? t('gene.report.notCollected')}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 人工修正面板（非 succeeded 仅备注；pending/running 整区禁用）。 */
function GeneEditPanel(props: {
  record: GeneRecord
  dimensions: GeneDimension[]
  saving: boolean
  saveError: string | null
  busy: boolean
  t: Translate
  onSave: (recordId: string, payload: { geneTags?: Record<string, string[]>; manualNotes: string; adoptionStatus?: string }) => Promise<void>
}): ReactNode {
  const t = props.t
  const record = props.record
  const editable = record.geneStatus === 'succeeded'
  const inProgress = record.geneStatus === 'pending' || record.geneStatus === 'running'
  const initialTags = record.geneTags
  const initialNotes = record.manualNotes ?? ''
  const initialAdoption = record.adoptionStatus === 'adopted' || record.adoptionStatus === 'revised' ? record.adoptionStatus : 'ai_draft'
  const [draftTags, setDraftTags] = useState<Record<string, string[]>>(initialTags)
  const [addValue, setAddValue] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState(initialNotes)
  const [adoption, setAdoption] = useState<'ai_draft' | 'adopted' | 'revised'>(initialAdoption)
  useEffect(() => {
    setDraftTags(record.geneTags)
    setAddValue({})
    setNotes(record.manualNotes ?? '')
    setAdoption(record.adoptionStatus === 'adopted' || record.adoptionStatus === 'revised' ? record.adoptionStatus : 'ai_draft')
  }, [record.recordId, record.updatedAt])
  const maxLabels = (dim: string): number => props.dimensions.find(item => item.id === dim)?.maxLabels ?? 3
  const addLabel = (dim: string): void => {
    const value = (addValue[dim] ?? '').trim()
    if (value === '') return
    setDraftTags(previous => {
      const labels = previous[dim] ?? []
      if (labels.includes(value) || labels.length >= maxLabels(dim)) return previous
      return { ...previous, [dim]: [...labels, value] }
    })
    setAddValue(previous => ({ ...previous, [dim]: '' }))
  }
  const save = (): void => {
    if (props.saving || inProgress) return
    if (!editable) {
      // 非 succeeded：只提交备注（不带 geneTags/adoptionStatus，服务端零冲突）。
      void props.onSave(record.recordId, { manualNotes: notes })
      return
    }
    const geneTags: Record<string, string[]> = {}
    for (const [dim, labels] of Object.entries(draftTags)) {
      if (labels.length > 0) geneTags[dim] = labels
    }
    // 采纳态仅在用户显式改动时传递；只改标签未动分段 → 服务端收敛为「已修正」。
    void props.onSave(record.recordId, {
      geneTags,
      manualNotes: notes,
      ...(adoption !== initialAdoption ? { adoptionStatus: adoption } : {}),
    })
  }
  return (
    <div className={css.geneDims}>
      <div className={css.geneDim}>
        <div className={css.geneDimHead}>
          <span className={css.geneDimName}>{t('gene.edit.tagsTitle')}</span>
          {!editable ? <span className={css.inlineHint}>{t('gene.edit.tagsNote')}</span> : null}
        </div>
        {props.dimensions.map(dim => {
          const labels = draftTags[dim.id] ?? []
          return (
            <div key={dim.id} className={css.geneDim}>
              <span className={css.geneFacetLabel}>{t('gene.edit.dimLimit', { name: dim.name, max: dim.maxLabels })}</span>
              <div className={css.geneFacetChips}>
                {labels.map(label => (
                  <button
                    key={label}
                    type='button'
                    className={css.geneChip}
                    data-selected
                    data-tone={dimensionTone(dim.id)}
                    disabled={!editable || props.busy || inProgress}
                    aria-label={t('gene.edit.removeTag', { label })}
                    onClick={() => {
                      setDraftTags(previous => {
                        const next = (previous[dim.id] ?? []).filter(item => item !== label)
                        const tags = { ...previous }
                        if (next.length > 0) tags[dim.id] = next
                        else delete tags[dim.id]
                        return tags
                      })
                    }}
                  >
                    {label} ✕
                  </button>
                ))}
                {labels.length === 0 ? <span className={css.inlineHint}>{t('gene.edit.noTags')}</span> : null}
              </div>
              {editable && !props.busy && !inProgress && (
                <div className={css.workToolbarRow}>
                  <Input
                    value={addValue[dim.id] ?? ''}
                    placeholder={t('gene.edit.addPlaceholder', { name: dim.name })}
                    disabled={props.saving}
                    onChange={event => { setAddValue(previous => ({ ...previous, [dim.id]: event.target.value })) }}
                    onKeyDown={event => { if (event.key === 'Enter') addLabel(dim.id) }}
                  />
                  <Button variant='ghost' size='sm' onClick={() => { addLabel(dim.id) }}>{t('gene.edit.add')}</Button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className={css.geneDim}>
        <span className={css.geneDimName}>{t('gene.edit.notesTitle')}</span>
        <textarea
          className={css.geneTextarea}
          value={notes}
          maxLength={2000}
          placeholder={t('gene.edit.notesPlaceholder')}
          onChange={event => { setNotes(event.target.value) }}
        />
      </div>
      <div className={css.geneDim}>
        <span className={css.geneDimName}>{t('gene.edit.adoptionTitle')}</span>
        <div className={css.workToolbarRow}>
          {(['ai_draft', 'adopted', 'revised'] as const).map(value => (
            <Button
              key={value}
              type='button'
              variant='ghost'
              size='sm'
              aria-pressed={adoption === value}
              disabled={!editable || props.busy || inProgress}
              onClick={() => { setAdoption(value) }}
            >
              {t(`gene.filter.adoption.${value}`)}
            </Button>
          ))}
        </div>
        <p className={css.inlineHint}>{t('gene.edit.adoptionNote')}</p>
      </div>
      {inProgress && <p className={css.inlineHint}>{t('gene.edit.inProgress')}</p>}
      {props.saveError !== null && <p className={css.formError} role='alert'>{domainErrorText('gene', props.saveError, t)}</p>}
      <div className={css.workToolbarRow}>
        <Button variant='primary' size='sm' disabled={props.saving || inProgress} aria-busy={props.saving || undefined} onClick={save}>
          {props.saving ? t('gene.edit.saving') : t('gene.edit.save')}
        </Button>
        <p className={css.inlineHint}>{t('gene.edit.savedNote')}</p>
      </div>
    </div>
  )
}

/** 失败列表弹层（逐项同键重试）。 */
function GeneFailedModal(props: {
  failed: { items: GeneRecord[]; loading: boolean; errorReason: string | null }
  retryingId: string | null
  retryError: string | null
  t: Translate
  onRetry: (recordId: string) => void
  onClose: () => void
}): ReactNode {
  const t = props.t
  return (
    <Modal
      open
      title={t('gene.failed.title')}
      closeLabel={t('dialog.close')}
      onClose={props.onClose}
      footer={<Button variant='ghost' onClick={props.onClose}>{t('gene.close')}</Button>}
    >
      {props.failed.errorReason !== null && (
        <p className={css.formError} role='alert'>{domainErrorText('gene', props.failed.errorReason, t)}</p>
      )}
      {props.retryError !== null && (
        <p className={css.formError} role='alert'>{domainErrorText('gene', props.retryError, t)}</p>
      )}
      {props.failed.loading
        ? <p role='status' aria-busy='true'>{t('gene.failed.loading')}</p>
        : props.failed.items.length === 0
          ? <p className={css.inlineHint}>{t('gene.failed.empty')}</p>
          : (
            <div className={css.geneDims}>
              {props.failed.items.map(item => (
                <div key={item.recordId} className={css.geneFailItem}>
                  <span className={css.geneCardTitle}>{item.title ?? '—'}</span>
                  <p className={css.inlineHint}>
                    {t('gene.failed.itemReason', { code: item.geneErrorCode ?? '—', count: formatCount(item.geneAttemptCount) })}
                  </p>
                  {item.geneErrorSummary !== null ? <p className={css.inlineHint}>{item.geneErrorSummary}</p> : null}
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={props.retryingId === item.recordId}
                    aria-busy={props.retryingId === item.recordId || undefined}
                    onClick={() => { props.onRetry(item.recordId) }}
                  >
                    {props.retryingId === item.recordId ? t('gene.failed.retrying') : t('gene.failed.retry')}
                  </Button>
                </div>
              ))}
            </div>
          )}
    </Modal>
  )
}
