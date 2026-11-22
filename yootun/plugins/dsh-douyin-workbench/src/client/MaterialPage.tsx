/**
 * 爆款素材看板页（旧 material-ui.js 布局与任务动线重译）：页内二级
 * SegmentedControl 四子页（素材看板/关键词管理/对标账号/采集记录）。
 * 看板子页 = 筛选条（搜索 300ms 防抖 + 档位/来源/时间窗/标签/排序 FilterMenu，
 * 变化即查 offset 归零，序号守卫收口）+ KPI 五卡（total 服务端口径，失败同步
 * 置 —）+ 12 列候选表（封面降级/档位 Tag/长文 ellipsis/sticky 操作列）+ 上下页
 * + 评分理由抽屉（结构化对照四态）。种子子页 = 两表 + 新增/编辑弹层 + 启停二次
 * 确认（幂等键 vv_{keyword|account}_upsert）。采集子页 = 立即采集 primary +
 * 确认弹层（纯确认式）+ run 轮询 3s（隐藏暂停、连续 5 次失败停、终态刷新
 * board/seeds/runs/facets）+ activeRun 横幅 + 失败明细弹层。已有 run 未终态时
 * 服务端拒绝（VIRAL_VIDEO_ACTIVE_RUN_EXISTS），UI 解释并恢复现有 run 轮询，
 * 不自动重发。「去拆解」只预填链接不自动开始。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Input, Modal, SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard, DataState, KpiCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { domainErrorText, formatCount, formatDateTime, formatRateRatio, type Translate } from './format.ts'
import css from './workbench.module.css'
import {
  readMaterialBoard, readMaterialFacets, readMaterialRunStatus, readMaterialRuns, readMaterialSeeds,
  type AccountSeedRow, type KeywordSeedRow, type MaterialBoard, type MaterialCandidateRow,
  type MaterialFacetTag, type MaterialRunRow, type MaterialSeeds,
} from './schema.ts'
import { FilterMenu } from './FilterMenu.tsx'
import { attemptId } from './AnalysisPage.tsx'

const BOARD_PAGE_SIZE = 20
const RUNS_PAGE_LIMIT = 20
const MATERIAL_POLL_MS = 3000
const MATERIAL_POLL_MAX_FAILURES = 5
const SEARCH_DEBOUNCE_MS = 300

type MaterialSection = 'board' | 'keywords' | 'accounts' | 'runs'
type PublishedRange = '7d' | '30d' | '90d' | 'all'

/** 看板筛选态。 */
export interface MaterialFilters {
  q: string
  minLevel: '' | 'S' | 'A' | 'B' | 'C'
  sourceKind: '' | 'keyword' | 'account' | 'both'
  publishedRange: PublishedRange
  tag: string
  sortBy: string
  offset: number
}

export const DEFAULT_MATERIAL_FILTERS: MaterialFilters = {
  q: '', minLevel: '', sourceKind: '', publishedRange: 'all', tag: '', sortBy: 'hot', offset: 0,
}

/** 时间窗 → publishedFrom/To（YYYY-MM-DD；all 不携带）。 */
function publishedWindow(range: PublishedRange): { publishedFrom?: string; publishedTo?: string } {
  if (range === 'all') return {}
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const to = new Date()
  const from = new Date(to.getTime() - days * 24 * 3600 * 1000)
  const iso = (date: Date): string => date.toISOString().slice(0, 10)
  return { publishedFrom: iso(from), publishedTo: iso(to) }
}

/** run 展示状态 → Tag tone（五态）。 */
function runStatusTone(status: string): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'completed') return 'success'
  if (status === 'partial_failed' || status === 'running') return 'warning'
  if (status === 'failed') return 'danger'
  return 'neutral'
}

export interface MaterialPageProps {
  t: Translate
  localeTag: string
  onNotice: (text: string) => void
  /** 「去拆解」：预填链接并切爆款拆解 Tab（不自动开始）。 */
  onStartBreakdown: (shareUrl: string) => void
}

/** 爆款素材看板页组件。 */
export function MaterialPage(props: MaterialPageProps): ReactNode {
  const t = props.t
  const [section, setSection] = useState<MaterialSection>('board')
  const [filters, setFilters] = useState<MaterialFilters>(DEFAULT_MATERIAL_FILTERS)
  const [board, setBoard] = useState<MaterialBoard & { loading: boolean; loaded: boolean; errorReason: string | null }>({
    rows: [], total: null, levelSummary: null, offset: 0, limit: BOARD_PAGE_SIZE, loading: true, loaded: false, errorReason: null,
  })
  const [facets, setFacets] = useState<MaterialFacetTag[]>([])
  const [seeds, setSeeds] = useState<{ data: MaterialSeeds | null; loading: boolean; errorReason: string | null }>({ data: null, loading: true, errorReason: null })
  const [runs, setRuns] = useState<{ rows: MaterialRunRow[]; loading: boolean; errorReason: string | null }>({ rows: [], loading: true, errorReason: null })
  const [activeRun, setActiveRun] = useState<{ runId: string | null; status: string; startedAt: string | null } | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [collectOpen, setCollectOpen] = useState(false)
  const [collectError, setCollectError] = useState<string | null>(null)
  const [reasonRow, setReasonRow] = useState<MaterialCandidateRow | null>(null)
  const [seedModal, setSeedModal] = useState<{ mode: 'keyword' | 'account'; row: KeywordSeedRow | AccountSeedRow | null } | null>(null)
  const [savingSeed, setSavingSeed] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)
  const [toggleConfirm, setToggleConfirm] = useState<{ mode: 'keyword' | 'account'; row: KeywordSeedRow | AccountSeedRow } | null>(null)
  const [failureRun, setFailureRun] = useState<MaterialRunRow | null>(null)

  const filtersRef = useRef(filters)
  const boardSeqRef = useRef(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seedsRef = useRef(seeds)
  useEffect(() => { seedsRef.current = seeds }, [seeds])

  const stopPolling = useCallback((): void => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => () => {
    stopPolling()
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
  }, [stopPolling])

  const loadFacets = useCallback(async (): Promise<void> => {
    try {
      const res = await hostAction('material.facets', {})
      setFacets(readMaterialFacets(res))
    } catch {
      // 标签 facets 降级为空：筛选条只剩「全部标签」，不影响其余筛选。
    }
  }, [])

  const loadBoard = useCallback(async (options?: { offset?: number }): Promise<void> => {
    const query = filtersRef.current
    const seq = ++boardSeqRef.current
    const offset = options?.offset ?? query.offset
    setBoard(previous => ({ ...previous, loading: true, errorReason: null }))
    try {
      const res = await hostAction('material.videos.list', {
        scope: 'material',
        sortBy: query.sortBy,
        limit: BOARD_PAGE_SIZE,
        offset,
        ...(query.q.trim() !== '' ? { q: query.q.trim() } : {}),
        ...(query.minLevel !== '' ? { minLevel: query.minLevel } : {}),
        ...(query.tag !== '' ? { tag: query.tag } : {}),
        ...(query.sourceKind !== '' ? { sourceKind: query.sourceKind } : {}),
        ...publishedWindow(query.publishedRange),
      })
      if (boardSeqRef.current !== seq) return
      const view = readMaterialBoard(res)
      setBoard({ ...view, offset, loading: false, loaded: true, errorReason: null })
    } catch (error) {
      if (boardSeqRef.current !== seq) return
      // 失败时 total/levelSummary 一并置空：KPI 与分页随看板降级，不沿用旧筛选口径。
      setBoard(previous => ({ ...previous, rows: [], total: null, levelSummary: null, loading: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
    }
  }, [])

  const loadSeeds = useCallback(async (options?: { silent?: boolean }): Promise<MaterialSeeds | null> => {
    setSeeds(previous => ({ ...previous, loading: true, errorReason: options?.silent === true ? previous.errorReason : null }))
    try {
      const res = await hostAction('material.seeds.list', {})
      const data = readMaterialSeeds(res)
      setSeeds({ data, loading: false, errorReason: null })
      return data
    } catch (error) {
      setSeeds(previous => ({ ...previous, loading: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
      return null
    }
  }, [])

  const loadRuns = useCallback(async (options?: { silent?: boolean }): Promise<MaterialRunRow[] | null> => {
    setRuns(previous => ({ ...previous, loading: true, errorReason: options?.silent === true ? previous.errorReason : null }))
    try {
      const res = await hostAction('material.runs.list', { limit: RUNS_PAGE_LIMIT })
      const rows = readMaterialRuns(res)
      setRuns({ rows, loading: false, errorReason: null })
      return rows
    } catch (error) {
      setRuns(previous => ({ ...previous, loading: false, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
      // 失败返回 null（≠空列表）：resume 据此区分「拉取失败（保留现状）」与
      // 「确认无在途/终态（清残留横幅）」。
      return null
    }
  }, [])

  /** 轮询在途 run；终态（nextAction≠poll_status）刷新 board/seeds/runs/facets。 */
  const startPolling = useCallback((runId: string): void => {
    stopPolling()
    let failures = 0
    pollRef.current = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return
      void hostAction('material.collect.status', { runId }).then(res => {
        const latest = readMaterialRunStatus(res)
        if (latest === null) {
          failures += 1
          if (failures >= MATERIAL_POLL_MAX_FAILURES) {
            stopPolling()
            setActiveRun(null)
            setRuns(previous => ({ ...previous, errorReason: 'douyin_operation_request_failed' }))
          }
          return
        }
        failures = 0
        setActiveRun({ runId: latest.runId, status: latest.runStatus, startedAt: latest.startedAt })
        if (latest.nextAction !== 'poll_status') {
          stopPolling()
          setActiveRun(null)
          void loadRuns({ silent: true })
          void loadBoard()
          // 终态同步刷新 seeds（解析状态推进）与 facets（新标签）。
          void loadSeeds({ silent: true })
          void loadFacets()
        }
      }).catch(() => {
        failures += 1
        if (failures >= MATERIAL_POLL_MAX_FAILURES) stopPolling()
      })
    }, MATERIAL_POLL_MS)
  }, [loadBoard, loadFacets, loadRuns, loadSeeds, stopPolling])

  /** 从最新 run 行恢复轮询（Tab 进入/手动刷新共用）；拉取失败保留现状。 */
  const resumePollingFromRows = useCallback((rows: MaterialRunRow[] | null): void => {
    if (rows === null) return
    const latest = rows[0]
    if (latest !== undefined && (latest.runStatus === 'queued' || latest.runStatus === 'running')) {
      setActiveRun({ runId: latest.runId, status: latest.runStatus, startedAt: latest.startedAt })
      startPolling(latest.runId)
    } else {
      setActiveRun(null)
    }
  }, [startPolling])

  useEffect(() => {
    void loadBoard()
    void loadFacets()
    void loadSeeds()
    void loadRuns().then(resumePollingFromRows).catch(() => undefined)
  }, [loadBoard, loadFacets, loadRuns, loadSeeds, resumePollingFromRows])

  /** 筛选变化：ref 先写再 setState（避免闭包旧值）；仅搜索词变化走防抖。 */
  const changeFilters = useCallback((patch: Partial<MaterialFilters>): void => {
    const previous = filtersRef.current
    const next = { ...previous, ...patch, offset: 0 }
    filtersRef.current = next
    setFilters(next)
    if (debounceRef.current !== null) clearTimeout(debounceRef.current)
    if (patch.q !== undefined && patch.q !== previous.q) {
      debounceRef.current = setTimeout(() => { void loadBoard({ offset: 0 }) }, SEARCH_DEBOUNCE_MS)
    } else {
      void loadBoard({ offset: 0 })
    }
  }, [loadBoard])

  const changePage = useCallback((offset: number): void => {
    const next = { ...filtersRef.current, offset }
    filtersRef.current = next
    setFilters(next)
    void loadBoard({ offset })
  }, [loadBoard])

  const refreshRuns = useCallback((): void => {
    void loadRuns().then(resumePollingFromRows).catch(() => undefined)
  }, [loadRuns, resumePollingFromRows])

  /** 种子保存（新增/编辑共用单条 upsert；失败保留输入）。 */
  const saveSeed = useCallback(async (payload: {
    keyword?: string
    displayName?: string
    inputForm?: string
    inputValue?: string
    priority: string
    status: string
    maxVideos?: number | null
  }): Promise<string | null> => {
    if (seedModal === null) return 'VALIDATION_ERROR'
    const isKeyword = seedModal.mode === 'keyword'
    setSavingSeed(true)
    setSeedError(null)
    try {
      const entry = isKeyword
        ? { keyword: payload.keyword ?? '', priority: payload.priority, status: payload.status }
        : {
          displayName: payload.displayName ?? '',
          inputForm: payload.inputForm ?? 'douyin_id',
          inputValue: payload.inputValue ?? '',
          priority: payload.priority,
          status: payload.status,
          ...(payload.maxVideos !== null && payload.maxVideos !== undefined ? { maxVideos: payload.maxVideos } : {}),
        }
      await hostAction(isKeyword ? 'material.keyword.upsert' : 'material.account.upsert', {
        [isKeyword ? 'keywords' : 'accounts']: [entry],
        confirm: true,
        idempotencyKey: isKeyword ? `douyin:vv_keyword_upsert:${attemptId()}` : `douyin:vv_account_upsert:${attemptId()}`,
      })
    } catch (error) {
      setSavingSeed(false)
      return error instanceof Error ? error.message : 'douyin_operation_request_failed'
    }
    setSavingSeed(false)
    setSeedModal(null)
    void loadSeeds({ silent: true })
    return null
  }, [loadSeeds, seedModal])

  /** 启停只带身份键 + status（未提交字段保留服务端原值）；确认后执行。 */
  const confirmToggle = useCallback(async (): Promise<void> => {
    const pending = toggleConfirm
    setToggleConfirm(null)
    if (pending === null) return
    const nextStatus = pending.row.status === 'active' ? 'disabled' : 'active'
    const isKeyword = pending.mode === 'keyword'
    const entry = isKeyword
      ? { keyword: (pending.row as KeywordSeedRow).keyword, status: nextStatus }
      : { inputForm: (pending.row as AccountSeedRow).inputForm, inputValue: (pending.row as AccountSeedRow).inputValue, status: nextStatus }
    try {
      await hostAction(isKeyword ? 'material.keyword.upsert' : 'material.account.upsert', {
        [isKeyword ? 'keywords' : 'accounts']: [entry],
        confirm: true,
        idempotencyKey: isKeyword ? `douyin:vv_keyword_upsert:${attemptId()}` : `douyin:vv_account_upsert:${attemptId()}`,
      })
    } catch (error) {
      setSeeds(previous => ({ ...previous, errorReason: error instanceof Error ? error.message : 'douyin_operation_request_failed' }))
      return
    }
    void loadSeeds({ silent: true })
  }, [loadSeeds, toggleConfirm])

  const openCollect = useCallback((): void => {
    setCollectError(null)
    setCollectOpen(true)
    if (seedsRef.current.data === null && !seedsRef.current.loading) void loadSeeds()
  }, [loadSeeds])

  /** 确认采集：受理即轮询；ACTIVE_RUN_EXISTS 冲突经 run 历史恢复现有 run。 */
  const confirmCollect = useCallback((): void => {
    setCollecting(true)
    setCollectError(null)
    void (async () => {
      try {
        const res = await hostAction('material.collect.start', { idempotencyKey: `douyin:vv_seed_search:${attemptId()}` })
        setCollectOpen(false)
        const run = readMaterialRunStatus(res)
        setActiveRun({ runId: run?.runId ?? null, status: run?.runStatus ?? 'queued', startedAt: run?.startedAt ?? null })
        if (run?.runId != null) startPolling(run.runId)
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'douyin_operation_request_failed'
        setCollectError(reason)
        if (reason === 'VIRAL_VIDEO_ACTIVE_RUN_EXISTS') {
          void loadRuns({ silent: true }).then(resumePollingFromRows).catch(() => undefined)
        }
      } finally {
        setCollecting(false)
      }
    })()
  }, [loadRuns, resumePollingFromRows, startPolling])

  const keywordCount = seeds.data?.keywords.length
  const accountCount = seeds.data?.accounts.length

  return (
    <div className={css.pageBody}>
      <SegmentedControl
        id='douyin-material-section'
        options={[
          { value: 'board', label: t('mat.section.board') },
          { value: 'keywords', label: t('mat.section.keywords') + (keywordCount !== undefined ? ` ${keywordCount}` : '') },
          { value: 'accounts', label: t('mat.section.accounts') + (accountCount !== undefined ? ` ${accountCount}` : '') },
          { value: 'runs', label: t('mat.section.runs') },
        ]}
        value={section}
        onChange={value => { setSection(value as MaterialSection) }}
        label={t('tab.material')}
      />

      {section === 'board' && (
        <>
          <div className={css.matFilters}>
            <Input
              value={filters.q}
              placeholder={t('mat.filter.searchPlaceholder')}
              aria-label={t('mat.filter.search')}
              onChange={event => { changeFilters({ q: event.target.value }) }}
            />
            <FilterMenu
              label={t('mat.filter.minLevel')}
              currentLabel={filters.minLevel === '' ? t('mat.filter.minLevel.all') : t(`mat.filter.minLevel.${filters.minLevel}` as 'mat.filter.minLevel.S')}
              items={[
                { id: '', label: t('mat.filter.minLevel.all') },
                { id: 'S', label: t('mat.filter.minLevel.S') },
                { id: 'A', label: t('mat.filter.minLevel.A') },
                { id: 'B', label: t('mat.filter.minLevel.B') },
                { id: 'C', label: t('mat.filter.minLevel.C') },
              ]}
              selectedId={filters.minLevel}
              onSelect={id => { changeFilters({ minLevel: id as MaterialFilters['minLevel'] }) }}
            />
            <FilterMenu
              label={t('mat.filter.sourceKind')}
              currentLabel={filters.sourceKind === '' ? t('mat.filter.sourceKind.all') : t(`mat.filter.sourceKind.${filters.sourceKind}` as 'mat.filter.sourceKind.keyword')}
              items={[
                { id: '', label: t('mat.filter.sourceKind.all') },
                { id: 'keyword', label: t('mat.filter.sourceKind.keyword') },
                { id: 'account', label: t('mat.filter.sourceKind.account') },
                { id: 'both', label: t('mat.filter.sourceKind.both') },
              ]}
              selectedId={filters.sourceKind}
              onSelect={id => { changeFilters({ sourceKind: id as MaterialFilters['sourceKind'] }) }}
            />
            <FilterMenu
              label={t('mat.filter.publishedRange')}
              currentLabel={t(`mat.publishedRange.${filters.publishedRange}` as 'mat.publishedRange.7d')}
              items={(['7d', '30d', '90d', 'all'] as const).map(value => ({ id: value, label: t(`mat.publishedRange.${value}` as 'mat.publishedRange.7d') }))}
              selectedId={filters.publishedRange}
              onSelect={id => { changeFilters({ publishedRange: id as PublishedRange }) }}
            />
            <FilterMenu
              label={t('mat.filter.tag')}
              currentLabel={filters.tag === '' ? t('mat.filter.tag.all') : filters.tag}
              items={[{ id: '', label: t('mat.filter.tag.all') }, ...facets.map(facet => ({ id: facet.tag, label: `${facet.tag}（${facet.count}）` }))]}
              selectedId={filters.tag}
              onSelect={id => { changeFilters({ tag: id }) }}
            />
            <FilterMenu
              label={t('mat.filter.sortBy')}
              currentLabel={t(`mat.sort.${filters.sortBy}` as 'mat.sort.hot')}
              items={['hot', 'latest', 'published_at', 'play_count', 'like_count', 'comment_count', 'share_count', 'collect_count', 'interaction_rate']
                .map(value => ({ id: value, label: t(`mat.sort.${value}` as 'mat.sort.hot') }))}
              selectedId={filters.sortBy}
              onSelect={id => { changeFilters({ sortBy: id }) }}
            />
          </div>

          <MaterialKpiRow board={board} seeds={seeds.data} runs={runs.rows} t={t} />

          {board.errorReason !== null && (
            <p className={css.formError} role='alert'>{domainErrorText('mat', board.errorReason, t)}</p>
          )}
          <DataState state={board.loading && !board.loaded ? 'loading' : board.errorReason !== null ? 'error' : 'ready'} shape='rows' onRetry={() => { void loadBoard() }}>
            {!board.loading && board.loaded && board.rows.length === 0 && (
              <div className={css.emptyState} role='status'><p>{t('mat.empty.board')}</p></div>
            )}
            {board.rows.length > 0 && (
              <div className={css.tableWrap} role='region' aria-label={t('mat.section.board')} tabIndex={0}>
                <table className={`${css.dataTable} ${css.matBoardTable}`} aria-label={t('mat.section.board')}>
                  <thead>
                    <tr>
                      {[
                        t('mat.col.cover'), t('mat.col.video'), t('mat.col.score'), t('mat.col.play'), t('mat.col.like'),
                        t('mat.col.comment'), t('mat.col.collect'), t('mat.col.share'), t('mat.col.interaction'),
                        t('mat.col.publishedAt'), t('mat.col.source'), t('mat.col.actions'),
                      ].map(label => <th key={label} scope='col'>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {board.rows.map(row => (
                      <BoardRow
                        key={row.candidateId}
                        row={row}
                        seedAccounts={seeds.data?.accounts ?? null}
                        t={t}
                        onOpenReason={() => { setReasonRow(row) }}
                        onStartBreakdown={props.onStartBreakdown}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className={css.matMeta}>
              <span>{board.total !== null
                ? t('mat.page.info', { total: formatCount(board.total), page: Math.floor(board.offset / board.limit) + 1, pages: Math.max(1, Math.ceil(board.total / board.limit)) })
                : t('mat.page.loading')}</span>
              <span className={css.workToolbarRow}>
                <Button variant='ghost' size='sm' disabled={board.rows.length === 0 || board.offset <= 0} onClick={() => { changePage(Math.max(0, board.offset - board.limit)) }}>
                  {t('mat.page.prev')}
                </Button>
                <Button variant='ghost' size='sm' disabled={board.total === null || board.offset + board.limit >= board.total} onClick={() => { changePage(board.offset + board.limit) }}>
                  {t('mat.page.next')}
                </Button>
              </span>
            </div>
          </DataState>
        </>
      )}

      {section === 'keywords' && (
        <DataCard
          title={t('mat.section.keywords')}
          description={t('mat.keywords.subtitle')}
          actions={<Button variant='primary' size='sm' onClick={() => { setSeedError(null); setSeedModal({ mode: 'keyword', row: null }) }}>{t('mat.keywords.add')}</Button>}
        >
          {seeds.errorReason !== null && (
            <p className={css.formError} role='alert'>{domainErrorText('mat', seeds.errorReason, t)}</p>
          )}
          <DataState state={seeds.loading && seeds.data === null ? 'loading' : seeds.errorReason !== null && seeds.data === null ? 'error' : 'ready'} shape='rows' onRetry={() => { void loadSeeds() }}>
            {(seeds.data?.keywords.length ?? 0) === 0 && !seeds.loading && (
              <div className={css.emptyState} role='status'><p>{t('mat.keywords.empty')}</p></div>
            )}
            {(seeds.data?.keywords.length ?? 0) > 0 && (
              <SeedTable
                kind='keyword'
                rows={seeds.data?.keywords ?? []}
                t={t}
                onEdit={row => { setSeedError(null); setSeedModal({ mode: 'keyword', row }) }}
                onToggle={row => { setToggleConfirm({ mode: 'keyword', row }) }}
              />
            )}
          </DataState>
        </DataCard>
      )}

      {section === 'accounts' && (
        <DataCard
          title={t('mat.section.accounts')}
          description={t('mat.accounts.subtitle')}
          actions={<Button variant='primary' size='sm' onClick={() => { setSeedError(null); setSeedModal({ mode: 'account', row: null }) }}>{t('mat.accounts.add')}</Button>}
        >
          {seeds.errorReason !== null && (
            <p className={css.formError} role='alert'>{domainErrorText('mat', seeds.errorReason, t)}</p>
          )}
          <DataState state={seeds.loading && seeds.data === null ? 'loading' : seeds.errorReason !== null && seeds.data === null ? 'error' : 'ready'} shape='rows' onRetry={() => { void loadSeeds() }}>
            {(seeds.data?.accounts.length ?? 0) === 0 && !seeds.loading && (
              <div className={css.emptyState} role='status'><p>{t('mat.accounts.empty')}</p></div>
            )}
            {(seeds.data?.accounts.length ?? 0) > 0 && (
              <SeedTable
                kind='account'
                rows={seeds.data?.accounts ?? []}
                t={t}
                onEdit={row => { setSeedError(null); setSeedModal({ mode: 'account', row }) }}
                onToggle={row => { setToggleConfirm({ mode: 'account', row }) }}
              />
            )}
          </DataState>
        </DataCard>
      )}

      {section === 'runs' && (
        <DataCard
          title={t('mat.section.runs')}
          description={t('mat.runs.subtitle')}
          actions={(
            <span className={css.workToolbarRow}>
              <Button variant='ghost' size='sm' disabled={runs.loading} aria-busy={runs.loading || undefined} onClick={refreshRuns}>
                {runs.loading ? t('schedule.refreshing') : t('mat.runs.refresh')}
              </Button>
              <Button variant='primary' size='sm' disabled={collecting || activeRun !== null} aria-busy={collecting || undefined} onClick={openCollect}>
                {collecting ? t('mat.runs.submitting') : t('mat.runs.start')}
              </Button>
            </span>
          )}
        >
          {activeRun !== null && (
            <p className={css.matActiveBanner} role='status'>
              {t('mat.runs.active', {
                status: t(`mat.run.status.${activeRun.status}` as 'mat.run.status.running'),
                startedAt: activeRun.startedAt !== null ? formatDateTime(activeRun.startedAt) : '',
              })}
            </p>
          )}
          {runs.errorReason !== null && (
            <p className={css.formError} role='alert'>{domainErrorText('mat', runs.errorReason, t)}</p>
          )}
          <DataState state={runs.loading && runs.rows.length === 0 ? 'loading' : runs.errorReason !== null && runs.rows.length === 0 ? 'error' : 'ready'} shape='rows' onRetry={refreshRuns}>
            {runs.rows.length === 0 && !runs.loading && (
              <div className={css.emptyState} role='status'><p>{t('mat.runs.empty')}</p></div>
            )}
            {runs.rows.length > 0 && (
              <div className={css.tableWrap} role='region' aria-label={t('mat.section.runs')} tabIndex={0}>
                <table className={css.dataTable} aria-label={t('mat.section.runs')}>
                  <thead>
                    <tr>
                      {[
                        t('mat.runs.col.status'), t('mat.runs.col.startedAt'), t('mat.runs.col.duration'), t('mat.runs.col.keywords'),
                        t('mat.runs.col.accounts'), t('mat.runs.col.jobs'), t('mat.runs.col.newPromoted'), t('mat.runs.col.levels'), t('mat.runs.col.actions'),
                      ].map(label => <th key={label} scope='col'>{label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {runs.rows.map(row => (
                      <RunRow key={row.runId} row={row} t={t} onViewBoard={() => { setSection('board'); void loadBoard({ offset: 0 }) }} onOpenFailure={() => { setFailureRun(row) }} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DataState>
        </DataCard>
      )}

      {reasonRow !== null && (
        <ReasonDrawer row={reasonRow} seedAccounts={seeds.data?.accounts ?? null} t={t} onClose={() => { setReasonRow(null) }} />
      )}
      {seedModal !== null && (
        <SeedModal
          modal={seedModal}
          busy={savingSeed}
          errorReason={seedError}
          t={t}
          onConfirm={payload => { void saveSeed(payload).then(reason => { if (reason !== null) setSeedError(reason) }) }}
          onClose={() => { setSeedModal(null) }}
        />
      )}
      {toggleConfirm !== null && (
        <Modal
          open
          title={t('mat.seedConfirm.title')}
          closeLabel={t('dialog.close')}
          onClose={() => { setToggleConfirm(null) }}
          footer={(
            <>
              <Button variant='ghost' onClick={() => { setToggleConfirm(null) }}>{t('bd.cancel')}</Button>
              <Button variant='primary' onClick={() => { void confirmToggle() }}>{t('mat.seedConfirm.confirm')}</Button>
            </>
          )}
        >
          <p>{toggleConfirm.row.status === 'active'
            ? t(toggleConfirm.mode === 'keyword' ? 'mat.seedConfirm.disable.keyword' : 'mat.seedConfirm.disable.account')
            : t(toggleConfirm.mode === 'keyword' ? 'mat.seedConfirm.enable.keyword' : 'mat.seedConfirm.enable.account')}</p>
        </Modal>
      )}
      {collectOpen && (
        <CollectModal
          activeKeywords={seeds.data !== null ? seeds.data.activeKeywords : null}
          activeAccounts={seeds.data !== null ? seeds.data.activeAccounts : null}
          busy={collecting}
          errorReason={collectError}
          t={t}
          onConfirm={confirmCollect}
          onClose={() => { setCollectOpen(false) }}
        />
      )}
      {failureRun !== null && (
        <FailureModal run={failureRun} t={t} onClose={() => { setFailureRun(null) }} />
      )}
    </div>
  )
}

/** KPI 五卡（候选素材 = 看板 total；其余最新批次投影）。 */
function MaterialKpiRow(props: {
  board: MaterialBoard & { loading: boolean; loaded: boolean; errorReason: string | null }
  seeds: MaterialSeeds | null
  runs: MaterialRunRow[]
  t: Translate
}): ReactNode {
  const t = props.t
  const latest = props.runs.find(row => row.runStatus === 'completed' || row.runStatus === 'partial_failed' || row.runStatus === 'failed') ?? null
  const levels = props.board.levelSummary
  const fallbackLevels = latest?.hotLevelSummary ?? null
  const saText = levels !== null
    ? ['S', 'A', 'B', 'C'].map(key => `${String(levels[key] ?? 0)}`).join(' / ')
    : fallbackLevels !== null
      ? ['S', 'A', 'B', 'C'].map(key => `${String(fallbackLevels[key] ?? 0)}`).join(' / ')
      : null
  const num = (value: number | null): string => formatCount(value)
  return (
    <div className={css.kpiRow}>
      <KpiCard label={t('mat.kpi.total')} value={props.board.errorReason !== null ? '—' : props.board.total !== null ? num(props.board.total) : '—'} footnote={t('mat.kpi.totalFoot')} />
      <KpiCard label={t('mat.kpi.levels')} value={saText ?? '—'} footnote={levels !== null ? t('mat.kpi.levelsFiltered') : latest !== null ? t('mat.kpi.levelsBatch') : t('mat.kpi.levelsNone')} />
      <KpiCard
        label={t('mat.kpi.newVideos')}
        value={latest !== null ? num(latest.newVideos) : '—'}
        footnote={latest !== null ? t('mat.kpi.newVideosFoot', { discovered: num(latest.discovered), inserted: num(latest.candidatesInserted) }) : t('mat.kpi.levelsNone')}
      />
      <KpiCard
        label={t('mat.kpi.promoted')}
        value={latest !== null ? num(latest.promotedCandidates) : '—'}
        footnote={latest !== null ? t('mat.kpi.promotedFoot', { skipped: num(latest.duplicatesSkipped) }) : t('mat.kpi.levelsNone')}
      />
      <KpiCard
        label={t('mat.kpi.latest')}
        value={latest !== null && latest.startedAt !== null ? latest.startedAt.slice(0, 10) : '—'}
        footnote={latest !== null ? t('mat.kpi.latestFoot', { status: t(`mat.run.status.${latest.runStatus}` as 'mat.run.status.completed') }) : t('mat.kpi.levelsNone')}
      />
    </div>
  )
}

/** 候选行（12 列；长文 ellipsis + 完整 title；档位 Tag 附文字）。 */
function BoardRow(props: {
  row: MaterialCandidateRow
  seedAccounts: AccountSeedRow[] | null
  t: Translate
  onOpenReason: () => void
  onStartBreakdown: (shareUrl: string) => void
}): ReactNode {
  const t = props.t
  const row = props.row
  const sourceLines: ReactNode[] = []
  const seen = new Set<string>()
  for (const match of row.sourceMatches) {
    if (match.keyword !== null && !seen.has(`k:${match.keyword}`)) {
      seen.add(`k:${match.keyword}`)
      sourceLines.push(<span key={`k:${match.keyword}`} className={css.matSourceTag}>{t('mat.source.keyword', { keyword: match.keyword })}</span>)
    }
    if (match.accountSeedId !== null && !seen.has(`a:${match.accountSeedId}`)) {
      seen.add(`a:${match.accountSeedId}`)
      const name = props.seedAccounts?.find(account => account.accountSeedId === match.accountSeedId)?.displayName ?? match.accountSeedId
      sourceLines.push(<span key={`a:${match.accountSeedId}`} className={css.matSourceTag}>{t('mat.source.account', { name })}</span>)
    }
  }
  const levelTone = row.hotLevel === 'S' ? 'danger' : row.hotLevel === 'A' ? 'warning' : row.hotLevel === 'B' ? 'info' : 'neutral'
  return (
    <tr aria-label={`${row.title ?? row.candidateId}，${row.hotLevel !== null ? t('mat.score.level', { level: row.hotLevel }) : ''}`}>
      <td>
        <CoverCell coverUrl={row.coverUrl} label={row.title ?? row.candidateId} />
      </td>
      <td className={css.cellMain}>
        <span className={css.matVideoTitle} title={row.title ?? undefined} aria-label={row.title ?? row.candidateId}>{row.title ?? '—'}</span>
        <span className={css.matTags}>
          {row.tags !== null && row.tags.length > 0
            ? row.tags.map((tag, index) => <span key={`${tag}:${index}`} className={css.matTag}>{tag}</span>)
            : <span className={css.matTagMiss}>{t('mat.tag.miss')}</span>}
        </span>
      </td>
      <td>
        <span className={css.matScore}>{formatCount(row.hotScore)}</span>
        {row.hotLevel !== null ? <Tag tone={levelTone}>{t('mat.score.level', { level: row.hotLevel })}</Tag> : null}
      </td>
      <td>{formatCount(row.playCount)}</td>
      <td>{formatCount(row.likeCount)}</td>
      <td>{formatCount(row.commentCount)}</td>
      <td>{formatCount(row.collectCount)}</td>
      <td>{formatCount(row.shareCount)}</td>
      <td>{formatRateRatio(row.interactionRate)}</td>
      <td>{row.publishedAt !== null ? row.publishedAt.slice(0, 10) : '—'}</td>
      <td>
        <span className={css.matSource}>
          {sourceLines.length > 0 ? sourceLines : <span className={css.matSourceTag}>—</span>}
        </span>
      </td>
      <td className={css.matActionsCell}>
        <Button variant='ghost' size='sm' onClick={props.onOpenReason}>{t('mat.action.reason')}</Button>
        {row.shareUrl !== null
          ? <Button variant='ghost' size='sm' onClick={() => { props.onStartBreakdown(row.shareUrl ?? '') }}>{t('mat.action.breakdown')}</Button>
          : <Button variant='ghost' size='sm' disabled title={t('mat.action.breakdownDisabled')}>{t('mat.action.breakdown')}</Button>}
      </td>
    </tr>
  )
}

/** 封面单元格（加载失败/缺失降级占位块）。 */
function CoverCell(props: { coverUrl: string | null; label: string }): ReactNode {
  const [failed, setFailed] = useState(false)
  if (props.coverUrl === null || failed) {
    return <span className={css.matCoverFallback} aria-hidden='true'>—</span>
  }
  return (
    <img
      className={css.matCover}
      src={props.coverUrl}
      alt=''
      loading='lazy'
      referrerPolicy='no-referrer'
      onError={() => { setFailed(true) }}
    />
  )
}

/** 种子表（关键词 6 列 / 账号 7 列；启停按钮与编辑可辨）。 */
function SeedTable(props: {
  kind: 'keyword' | 'account'
  rows: (KeywordSeedRow | AccountSeedRow)[]
  t: Translate
  onEdit: (row: KeywordSeedRow | AccountSeedRow) => void
  onToggle: (row: KeywordSeedRow | AccountSeedRow) => void
}): ReactNode {
  const t = props.t
  if (props.kind === 'keyword') {
    return (
      <div className={css.tableWrap} role='region' aria-label={t('mat.section.keywords')} tabIndex={0}>
        <table className={css.dataTable} aria-label={t('mat.section.keywords')}>
          <thead>
            <tr>
              {[t('mat.keywords.col.keyword'), t('mat.keywords.col.status'), t('mat.keywords.col.priority'), t('mat.keywords.col.searchCount'), t('mat.keywords.col.updatedAt'), t('mat.keywords.col.actions')]
                .map(label => <th key={label} scope='col'>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {props.rows.map(row => (
              <tr key={(row as KeywordSeedRow).seedId}>
                <td className={css.cellMain}>{(row as KeywordSeedRow).keyword}</td>
                <td><Tag tone={row.status === 'active' ? 'success' : 'neutral'}>{t(row.status === 'active' ? 'mat.seed.status.active' : 'mat.seed.status.disabled')}</Tag></td>
                <td>{row.priority ?? '—'}</td>
                <td>{formatCount((row as KeywordSeedRow).searchCount)}</td>
                <td>{formatDateTime((row as KeywordSeedRow).updatedAt)}</td>
                <td>
                  <span className={css.matActionsCell}>
                    <Button variant='ghost' size='sm' onClick={() => { props.onEdit(row) }}>{t('mat.seed.edit')}</Button>
                    <Button variant='ghost' size='sm' onClick={() => { props.onToggle(row) }}>
                      {t(row.status === 'active' ? 'mat.seed.disable' : 'mat.seed.enable')}
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <div className={css.tableWrap} role='region' aria-label={t('mat.section.accounts')} tabIndex={0}>
      <table className={css.dataTable} aria-label={t('mat.section.accounts')}>
        <thead>
          <tr>
            {[t('mat.accounts.col.displayName'), t('mat.accounts.col.inputValue'), t('mat.accounts.col.inputForm'), t('mat.accounts.col.resolved'), t('mat.accounts.col.status'), t('mat.accounts.col.lastFetched'), t('mat.accounts.col.actions')]
              .map(label => <th key={label} scope='col'>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {props.rows.map(row => {
            const account = row as AccountSeedRow
            return (
              <tr key={account.accountSeedId} title={account.lastResolutionError !== null ? account.lastResolutionError : undefined}>
                <td className={css.cellMain}><span className={css.matEllipsis} title={account.displayName ?? undefined}>{account.displayName ?? '—'}</span></td>
                <td><span className={css.matSeedInput} title={account.inputValue}>{account.inputValue}</span></td>
                <td>{t(`mat.inputForm.${account.inputForm}` as 'mat.inputForm.douyin_id')}</td>
                <td>
                  {account.resolved
                    ? <Tag tone='success'>{t('mat.seed.resolved')}</Tag>
                    : <Tag tone={account.verificationStatus === 'resolution_failed' ? 'danger' : 'neutral'}>{t(account.verificationStatus === 'resolution_failed' ? 'mat.seed.resolveFailed' : 'mat.seed.unresolved')}</Tag>}
                </td>
                <td><Tag tone={account.status === 'active' ? 'success' : 'neutral'}>{t(account.status === 'active' ? 'mat.seed.status.active' : 'mat.seed.status.disabled')}</Tag></td>
                <td>{formatDateTime(account.lastContentFetchedAt)}</td>
                <td>
                  <span className={css.matActionsCell}>
                    <Button variant='ghost' size='sm' onClick={() => { props.onEdit(account) }}>{t('mat.seed.edit')}</Button>
                    <Button variant='ghost' size='sm' onClick={() => { props.onToggle(account) }}>
                      {t(account.status === 'active' ? 'mat.seed.disable' : 'mat.seed.enable')}
                    </Button>
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** run 行（9 列；失败明细 danger 入口按状态/计数判定）。 */
function RunRow(props: { row: MaterialRunRow; t: Translate; onViewBoard: () => void; onOpenFailure: () => void }): ReactNode {
  const t = props.t
  const row = props.row
  const levels = row.hotLevelSummary !== null && Object.keys(row.hotLevelSummary).length > 0
    ? ['S', 'A', 'B', 'C'].map(level => t('mat.run.levels', { level, count: formatCount(row.hotLevelSummary?.[level] ?? null) })).join(' · ')
    : null
  const failedSeeds = row.failedKeywords.length > 0 || row.failedAccounts.length > 0
  const runFailed = row.runStatus === 'failed' || row.runStatus === 'partial_failed'
  const showFailureDetail = runFailed || (row.failedJobs !== null && row.failedJobs > 0) || failedSeeds
  const seenCandidateCount = row.materialCandidateCount ?? row.candidatesInserted
  const failedNoCandidates = runFailed && seenCandidateCount === 0
  return (
    <tr>
      <td><Tag tone={runStatusTone(row.runStatus)}>{t(`mat.run.status.${row.runStatus}` as 'mat.run.status.completed')}</Tag></td>
      <td>{formatDateTime(row.startedAt)}</td>
      <td>{row.durationSeconds !== null ? `${Math.floor(row.durationSeconds / 60)}m ${Math.round(row.durationSeconds % 60)}s` : '—'}</td>
      <td>{formatCount(row.keywordCount)}</td>
      <td>{formatCount(row.accountCount)}</td>
      <td>{row.succeededJobs !== null || row.failedJobs !== null ? `${formatCount(row.succeededJobs)} / ${formatCount(row.failedJobs)}` : '—'}</td>
      <td>{row.newVideos !== null || row.promotedCandidates !== null ? `${formatCount(row.newVideos)} / ${formatCount(row.promotedCandidates)}` : '—'}</td>
      <td>{levels ?? '—'}</td>
      <td>
        <span className={css.matActionsCell}>
          {!failedNoCandidates && <Button variant='ghost' size='sm' onClick={props.onViewBoard}>{t('mat.runs.viewBoard')}</Button>}
          {showFailureDetail && (
            <Button variant='ghost' size='sm' className={css.dangerButton} onClick={props.onOpenFailure}>
              {t('mat.runs.failureDetail')}
            </Button>
          )}
        </span>
      </td>
    </tr>
  )
}

/** 评分理由抽屉（基础信息 + 结构化对照 + 命中理由列表）。 */
function ReasonDrawer(props: { row: MaterialCandidateRow; seedAccounts: AccountSeedRow[] | null; t: Translate; onClose: () => void }): ReactNode {
  const t = props.t
  const row = props.row
  const ruleVersion = row.scoreRuleVersion === null
    ? t('mat.reason.ruleVersion.legacy')
    : row.scoreRuleVersion === 'hot-v1' || row.scoreRuleVersion === 'hot-v1-potential'
      ? t(`mat.reason.ruleVersion.${row.scoreRuleVersion}` as 'mat.reason.ruleVersion.hot-v1')
      : row.scoreRuleVersion
  return (
    <aside className={css.matDrawer} role='dialog' aria-modal='true' aria-label={t('mat.reason.title')}>
      <div className={css.matDrawerHead}>
        <h3>{t('mat.reason.title')}</h3>
        <Button variant='ghost' size='sm' onClick={props.onClose}>{t('mat.close')}</Button>
      </div>
      <p className={css.inlineHint} title={row.title ?? undefined}>{row.title ?? '—'}</p>
      <dl className={css.metaList}>
        <div className={css.metaRow}>
          <dt>{t('mat.reason.score')}</dt>
          <dd>{formatCount(row.hotScore)}（{row.hotLevel !== null ? t('mat.reason.level', { level: row.hotLevel }) : '—'}）</dd>
        </div>
        <div className={css.metaRow}>
          <dt>{t('mat.reason.ruleVersion')}</dt>
          <dd>{ruleVersion}</dd>
        </div>
        <div className={css.metaRow}>
          <dt>{t('mat.reason.publishedAt')}</dt>
          <dd>{row.publishedAt !== null ? row.publishedAt.slice(0, 10) : '—'}</dd>
        </div>
        <div className={css.metaRow}>
          <dt>{t('mat.reason.videoLink')}</dt>
          <dd>{row.shareUrl !== null ? <a href={row.shareUrl} target='_blank' rel='noreferrer noopener' title={t('mat.reason.openVideo')}>{row.title ?? row.shareUrl}</a> : '—'}</dd>
        </div>
      </dl>
      {row.scoreReasonDetails.length > 0 && (
        <>
          <h4>{t('mat.reason.detailsTitle')}</h4>
          <div className={css.tableWrap}>
            <table className={css.dataTable}>
              <thead>
                <tr>
                  {[t('mat.reason.col.dimension'), t('mat.reason.col.observed'), t('mat.reason.col.threshold'), t('mat.reason.col.score')]
                    .map(label => <th key={label} scope='col'>{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {row.scoreReasonDetails.map((detail, index) => {
                  // 比率维度判定用数据形态（阈值为 <1 的小数比率行），不匹配维度名文案。
                  const isRate = detail.threshold !== null && detail.threshold > 0 && detail.threshold < 1
                  const observed = detail.observed !== null ? (isRate ? formatRateRatio(detail.observed) : formatCount(detail.observed)) : null
                  const threshold = detail.threshold !== null ? (isRate ? formatRateRatio(detail.threshold) : formatCount(detail.threshold)) : null
                  const score = detail.hit && detail.points !== null && detail.points > 0
                    ? <Tag tone='success'>{t('mat.reason.hit', { points: detail.points })}</Tag>
                    : detail.observed === null
                      ? <Tag tone='neutral'>{t('mat.reason.notCollected')}</Tag>
                      : detail.threshold !== null
                        ? <Tag tone='neutral'>{t('mat.reason.gap', { gap: isRate ? formatRateRatio(detail.threshold - detail.observed) : formatCount(detail.threshold - detail.observed) })}</Tag>
                        : <Tag tone='neutral'>{t('mat.reason.zero')}</Tag>
                  return (
                    <tr key={`${detail.name}:${index}`}>
                      <td>{detail.name}</td>
                      <td>{observed ?? '—'}</td>
                      <td>{threshold ?? '—'}</td>
                      <td>{score}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className={css.inlineHint}>{t('mat.reason.interactionNote')}</p>
        </>
      )}
      <h4>{t('mat.reason.hitListTitle', { count: row.scoreReasons.length })}</h4>
      {row.scoreReasons.length > 0
        ? (
          <ul className={css.matReasonList}>
            {row.scoreReasons.map((reason, index) => <li key={`${index}:${reason}`} className={css.matReasonItem}>{reason}</li>)}
          </ul>
        )
        : <p className={css.inlineHint}>{t('mat.reason.hitListEmpty')}</p>}
    </aside>
  )
}

/** 种子弹窗（新增/编辑；失败保留输入）。 */
function SeedModal(props: {
  modal: { mode: 'keyword' | 'account'; row: KeywordSeedRow | AccountSeedRow | null }
  busy: boolean
  errorReason: string | null
  t: Translate
  onConfirm: (payload: {
    keyword?: string
    displayName?: string
    inputForm?: string
    inputValue?: string
    priority: string
    status: string
    maxVideos?: number | null
  }) => void
  onClose: () => void
}): ReactNode {
  const t = props.t
  const isKeyword = props.modal.mode === 'keyword'
  const editing = props.modal.row !== null
  const keywordRow = editing && isKeyword ? props.modal.row as KeywordSeedRow : null
  const accountRow = editing && !isKeyword ? props.modal.row as AccountSeedRow : null
  const [keyword, setKeyword] = useState(keywordRow?.keyword ?? '')
  const [displayName, setDisplayName] = useState(accountRow?.displayName ?? '')
  const [inputForm, setInputForm] = useState(accountRow?.inputForm ?? 'douyin_id')
  const [inputValue, setInputValue] = useState(accountRow?.inputValue ?? '')
  const [priority, setPriority] = useState(props.modal.row?.priority ?? 'P1')
  const [status, setStatus] = useState(props.modal.row?.status ?? 'active')
  const [maxVideos, setMaxVideos] = useState(accountRow?.maxVideos !== null && accountRow?.maxVideos !== undefined ? String(accountRow.maxVideos) : '')
  const submit = (): void => {
    if (props.busy) return
    if (isKeyword) {
      props.onConfirm({ keyword: keyword.trim(), priority, status })
      return
    }
    const max = Number(maxVideos)
    props.onConfirm({
      displayName: displayName.trim(),
      inputForm,
      inputValue: inputValue.trim(),
      priority,
      status,
      maxVideos: maxVideos.trim() !== '' && Number.isFinite(max) && max > 0 ? max : null,
    })
  }
  return (
    <Modal
      open
      title={t(isKeyword ? (editing ? 'mat.seed.title.keywordEdit' : 'mat.seed.title.keyword') : editing ? 'mat.seed.title.accountEdit' : 'mat.seed.title.account')}
      closeLabel={t('dialog.close')}
      onClose={() => { if (!props.busy) props.onClose() }}
      footer={(
        <>
          <Button variant='ghost' disabled={props.busy} onClick={props.onClose}>{t('mat.seed.cancel')}</Button>
          <Button variant='primary' disabled={props.busy} aria-busy={props.busy || undefined} onClick={submit}>
            {props.busy ? t('mat.seed.saving') : t('mat.seed.confirm')}
          </Button>
        </>
      )}
    >
      <form
        className={css.formBody}
        onSubmit={event => {
          event.preventDefault()
          submit()
        }}
      >
        {isKeyword
          ? (
            <label className={css.formField}>
              <span className={css.formLabel}>{t(editing ? 'mat.seed.field.keywordEdit' : 'mat.seed.field.keyword')}</span>
              <Input value={keyword} maxLength={128} disabled={props.busy || editing} onChange={event => { setKeyword(event.target.value) }} />
            </label>
          )
          : (
            <>
              <label className={css.formField}>
                <span className={css.formLabel}>{t('mat.seed.field.displayName')}</span>
                <Input value={displayName} maxLength={256} disabled={props.busy} onChange={event => { setDisplayName(event.target.value) }} />
              </label>
              <label className={css.formField}>
                <span className={css.formLabel}>{t(editing ? 'mat.seed.field.inputFormEdit' : 'mat.seed.field.inputForm')}</span>
                <Input value={t(`mat.inputForm.${inputForm}` as 'mat.inputForm.douyin_id')} readOnly aria-readonly='true' disabled={editing} />
                {!editing
                  ? (
                    <span className={css.matFormButtons}>
                      {(['douyin_id', 'homepage_url', 'sec_user_id'] as const).map(value => (
                        <Button key={value} type='button' variant='ghost' size='sm' disabled={props.busy} aria-pressed={inputForm === value} onClick={() => { setInputForm(value) }}>
                          {t(`mat.inputForm.${value}`)}
                        </Button>
                      ))}
                    </span>
                  )
                  : null}
              </label>
              <label className={css.formField}>
                <span className={css.formLabel}>{t(inputForm === 'homepage_url' && !editing ? 'mat.seed.field.inputValue.homepage_url' : 'mat.seed.field.inputValue')}</span>
                <Input
                  value={inputValue}
                  maxLength={512}
                  disabled={props.busy || editing}
                  placeholder={inputForm === 'homepage_url' ? 'https://www.douyin.com/user/…' : inputForm === 'sec_user_id' ? 'MS4wLjABAAAA…' : t('mat.inputForm.douyin_id')}
                  onChange={event => { setInputValue(event.target.value) }}
                />
              </label>
              <label className={css.formField}>
                <span className={css.formLabel}>{t('mat.seed.field.maxVideos')}</span>
                <Input
                  type='number'
                  min={1}
                  max={100}
                  value={maxVideos}
                  disabled={props.busy}
                  onChange={event => { setMaxVideos(event.target.value) }}
                />
              </label>
            </>
          )}
        <div className={css.formField}>
          <span className={css.formLabel}>{t('mat.seed.field.priority')}</span>
          <span className={css.matFormButtons}>
            {(['P1', 'P2', 'P3', 'P4', 'P5'] as const).map(value => (
              <Button key={value} type='button' variant='ghost' size='sm' disabled={props.busy} aria-pressed={priority === value} onClick={() => { setPriority(value) }}>{value}</Button>
            ))}
          </span>
        </div>
        <div className={css.formField}>
          <span className={css.formLabel}>{t('mat.seed.field.status')}</span>
          <span className={css.matFormButtons}>
            {(['active', 'disabled'] as const).map(value => (
              <Button key={value} type='button' variant='ghost' size='sm' disabled={props.busy} aria-pressed={status === value} onClick={() => { setStatus(value) }}>
                {t(`mat.seed.status.${value}`)}
              </Button>
            ))}
          </span>
        </div>
        {props.errorReason !== null && <p className={css.formError} role='alert'>{domainErrorText('mat', props.errorReason, t)}</p>}
      </form>
    </Modal>
  )
}

/** 采集确认弹窗（纯确认式：只读统计 + 外部服务提示）。 */
function CollectModal(props: {
  activeKeywords: number | null
  activeAccounts: number | null
  busy: boolean
  errorReason: string | null
  t: Translate
  onConfirm: () => void
  onClose: () => void
}): ReactNode {
  const t = props.t
  const num = (value: number | null): string => value === null ? '—' : formatCount(value)
  const expected = props.activeKeywords !== null && props.activeAccounts !== null
    ? formatCount(props.activeKeywords + props.activeAccounts)
    : null
  return (
    <Modal
      open
      title={t('mat.collect.title')}
      closeLabel={t('dialog.close')}
      onClose={() => { if (!props.busy) props.onClose() }}
      footer={(
        <>
          <Button variant='ghost' disabled={props.busy} onClick={props.onClose}>{t('mat.collect.cancel')}</Button>
          <Button variant='primary' disabled={props.busy} aria-busy={props.busy || undefined} onClick={props.onConfirm}>
            {props.busy ? t('mat.runs.submitting') : t('mat.collect.confirm')}
          </Button>
        </>
      )}
    >
      <p className={css.inlineHint}>{t('mat.collect.body')}</p>
      <dl className={css.metaList}>
        <div className={css.metaRow}><dt>{t('mat.collect.activeKeywords')}</dt><dd>{num(props.activeKeywords)}</dd></div>
        <div className={css.metaRow}><dt>{t('mat.collect.activeAccounts')}</dt><dd>{num(props.activeAccounts)}</dd></div>
        <div className={css.metaRow}><dt>{t('mat.collect.expected')}</dt><dd>{expected ?? '—'}</dd></div>
      </dl>
      <p className={css.inlineHint}>{t('mat.collect.note')}</p>
      {props.errorReason !== null && <p className={css.formError} role='alert'>{domainErrorText('mat', props.errorReason, t)}</p>}
    </Modal>
  )
}

/** 失败明细弹窗（run 级原因 + 种子级两列表）。 */
function FailureModal(props: { run: MaterialRunRow; t: Translate; onClose: () => void }): ReactNode {
  const t = props.t
  const run = props.run
  const failedTotal = run.failedKeywords.length + run.failedAccounts.length
  return (
    <Modal
      open
      title={t('mat.failure.title')}
      closeLabel={t('dialog.close')}
      onClose={props.onClose}
      footer={<Button variant='ghost' onClick={props.onClose}>{t('mat.close')}</Button>}
    >
      <dl className={css.metaList}>
        <div className={css.metaRow}><dt>{t('mat.failure.runId')}</dt><dd>{run.runId}</dd></div>
        <div className={css.metaRow}>
          <dt>{t('mat.failure.status')}</dt>
          <dd><Tag tone={runStatusTone(run.runStatus)}>{t(`mat.run.status.${run.runStatus}` as 'mat.run.status.completed')}</Tag></dd>
        </div>
        <div className={css.metaRow}><dt>{t('mat.failure.startedAt')}</dt><dd>{formatDateTime(run.startedAt)}</dd></div>
        <div className={css.metaRow}>
          <dt>{t('mat.failure.duration')}</dt>
          <dd>{run.durationSeconds !== null ? `${Math.floor(run.durationSeconds / 60)}m ${Math.round(run.durationSeconds % 60)}s` : '—'}</dd>
        </div>
        <div className={css.metaRow}><dt>{t('mat.failure.count')}</dt><dd>{String(failedTotal)}</dd></div>
        {run.runError !== null && (
          <div className={css.metaRow}>
            <dt>{t('mat.failure.reason')}</dt>
            <dd className={css.formError}>{run.runError.code ?? '—'}：{run.runError.message ?? '—'}</dd>
          </div>
        )}
      </dl>
      {failedTotal > 0
        ? (
          <div className={css.tableWrap}>
            <table className={css.dataTable}>
              <thead>
                <tr><th scope='col'>{t('mat.reason.col.dimension')}</th><th scope='col'>{t('mat.failure.count')}</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>{t('mat.failure.keywords', { count: run.failedKeywords.length })}</td>
                  <td>{run.failedKeywords.join('、') || '—'}</td>
                </tr>
                <tr>
                  <td>{t('mat.failure.accounts', { count: run.failedAccounts.length })}</td>
                  <td>{run.failedAccounts.join('、') || '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
        : run.runError !== null
          ? <p className={css.inlineHint}>{t('mat.failure.runLevel')}</p>
          : <p className={css.inlineHint}>{t('mat.failure.empty')}</p>}
    </Modal>
  )
}
