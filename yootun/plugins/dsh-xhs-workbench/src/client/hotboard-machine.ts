/**
 * 车衣爆款看板状态机（迁移旧 hotboard-ui.js createHotboardHub 全行为，纯逻辑
 * 无 React 依赖）：二级页切换保留筛选草稿（草稿在 hub）、顶级 Tab 切换保留二级
 * 页状态、页面隐藏停轮询不清数据、active run 轮询 run_get、写操作进行中禁用
 * 重复提交（pending 计数）、操作完成刷新待办数、失败保留原数据。所有写操作
 * Host 侧 confirm + 幂等键（键在 machine 内随一次用户操作生成）。
 * @module
 */
import type { HostResponse } from './api.ts'

/** KPI 投影（hotboard.overview data.kpis）。 */
export interface HotboardKpis {
  totalCases?: number
  coverageRate?: number | null
  aiTaggedRate?: number | null
  duplicateGroupCount?: number
  lowQualityCount?: number
  failedKeywordCount?: number
  lastCollectedAt?: string | null
  nextRun?: { scheduleEnabled?: boolean; cron?: string | null }
}

/** 案例行（hotboard.overview data.notes[]）。 */
export interface HotboardNoteRow {
  noteId: string
  title?: string | null
  noteType?: string
  score?: number | null
  collectCount?: number | null
  likeCount?: number | null
  commentCount?: number | null
  shareCount?: number | null
  interactionTotal?: number | null
  authorName?: string | null
  publishTime?: string | null
  retrievedAt?: string | null
  coverUrl?: string | null
  styleTag?: { name?: string } | null
  colorTag?: { name?: string } | null
  matchedKeywords?: string[]
  duplicateGroupId?: string | null
}

/** 筛选选项投影。 */
export interface HotboardFilterOptions {
  keywords?: Array<{ keyword: string; category?: string }>
  styles?: Array<{ code: string; name: string }>
  colors?: Array<{ code: string; name: string }>
  noteWords?: string[]
  commentWords?: string[]
}

/** 案例看板页数据投影。 */
export interface HotboardOverview {
  kpis?: HotboardKpis
  filterOptions?: HotboardFilterOptions
  runStatus?: { runId?: string; status?: string; runType?: string; startedAt?: string | null; deadlineAt?: string | null } | null
  notes?: HotboardNoteRow[]
  pagination?: { page?: number; pageSize?: number; total?: number }
}

/** 关键词行。 */
export interface HotboardKeywordRow { keywordId: string; keyword: string; category?: string; status?: string; source?: string }

/** 扩词候选行。 */
export interface HotboardCandidateRow { candidateId: string; keyword: string; category?: string; score?: number | null; reason?: string | null; status?: string; generatedAt?: string | null }

/** 标签行 / 提案行。 */
export interface HotboardLabelRow { labelId: string; name: string; code: string; aliases?: string[]; tagType?: string; status?: string; definition?: string | null; source?: string }
export interface HotboardProposalRow { proposalId: string; proposedLabel: string; tagType?: string; confidence?: number | null; evidenceNoteCount?: number | null; status?: string }

/** 行级失败披露（candidate_review results[]，Host 截 50）。 */
export interface CandidateReviewResult { candidateId: string | null; ok: boolean; errorCode: string | null }

/** 写响应投影（projectHotboardWrite 受控字段）。 */
export interface HotboardWriteResult {
  ok?: boolean
  updatedCount?: number
  idempotentReplay?: boolean
  changed?: unknown
  conflictWithActive?: boolean
  created?: boolean
  results?: CandidateReviewResult[]
  run?: { runId?: string; status?: string | null }
}

/** run 负载（hotboard.run_get data）。 */
export interface HotboardRun {
  run?: {
    runId?: string
    status?: string
    runType?: string
    startedAt?: string | null
    finishedAt?: string | null
    errorCode?: string | null
    activeKeywordCount?: number | null
    successKeywordCount?: number | null
    failedKeywordCount?: number | null
    noResultKeywordCount?: number | null
    collectedNoteCount?: number | null
    qualifiedNoteCount?: number | null
    duplicateNoteCount?: number | null
    lowQualityNoteCount?: number | null
    aiTaggedCount?: number | null
    aiPendingCount?: number | null
  }
  keywordRuns?: Array<{ keyword: string; status?: string; collectedCount?: number | null; qualifiedCount?: number | null; errorCode?: string | null }>
  failedKeywords?: Array<{ keyword: string; errorCode?: string | null }>
  remainingSearchBudget?: number | null
}

/** settings 只读投影（hotboard.settings data）。 */
export interface HotboardSettings {
  scheduleEnabled?: boolean
  fullScheduleCron?: string | null
  publishWindowDays?: number | null
  perKeywordLimit?: number | null
  commentTopN?: number | null
  commentMaxPerNote?: number | null
  minInteractionTotal?: number | null
  dedupHammingThreshold?: number | null
  minValidSample?: number | null
  searchMaxCallsPerDay?: number | null
  commentMaxCallsPerDay?: number | null
  detailMaxCallsPerRun?: number | null
  ruleVersion?: string | null
}

/** 笔记详情投影（hotboard.note_detail data）。 */
export interface HotboardNoteDetail {
  note?: { noteId?: string; title?: string | null; authorName?: string | null; noteType?: string; publishTime?: string | null; link?: string | null; body?: string | null }
  metrics?: { likeCount?: number | null; collectCount?: number | null; commentCount?: number | null; shareCount?: number | null; interactionTotal?: number | null; score7d?: number | null; score30d?: number | null; score90d?: number | null }
  currentTags?: Array<{ tagType?: string; labelCode?: string; labelName?: string }>
  images?: { coverUrl?: string | null; imageUrls?: string[] }
  similarNotes?: Array<{ noteId?: string; title?: string | null; coverUrl?: string | null }>
  wordStats?: Array<{ wordType?: string; word: string; frequency?: number | null }>
}

/** 二级页 id（案例看板/关键词与扩词/标签与 AI 标记/采集与规则）。 */
export type HotboardSub = 'board' | 'keywords' | 'tags' | 'rules'

/** 筛选草稿（二级页切换保留）。 */
export interface HotboardFilters {
  board: { window: string; keyword: string; style: string; color: string; noteWord: string; commentWord: string; scoreMin: string; scoreMax: string; sort: string; onlyMain: boolean; onlyTagged: boolean }
  keywords: { category: string; status: string; source: string; keyword: string }
  candidates: { status: string; category: string; dateFrom: string; dateTo: string }
  labels: { tagType: string; status: string; source: string; keyword: string; proposalStatus: string }
}

/** machine 快照。 */
export interface HotboardSnapshot {
  sub: HotboardSub
  loading: boolean
  error: string
  filters: HotboardFilters
  pages: Record<'board' | 'keywords' | 'candidates' | 'labels', number>
  overview: { data: HotboardOverview; meta: Record<string, unknown> | null } | null
  keywords: { data: { keywords?: HotboardKeywordRow[] }; meta: Record<string, unknown> | null } | null
  candidates: { data: { candidates?: HotboardCandidateRow[] }; meta: Record<string, unknown> | null } | null
  labels: { data: { labels?: HotboardLabelRow[]; proposals?: HotboardProposalRow[] }; meta: Record<string, unknown> | null } | null
  settings: HotboardSettings | null
  runLive: HotboardRun | null
  runDrawer: { runId: string; data: HotboardRun | null; loading: boolean; error: string } | null
  noteDrawer: { noteId: string; data: HotboardNoteDetail | null; loading: boolean; error: string } | null
  pending: number
  notice: { kind: 'ok' | 'error'; key: string; extra?: Record<string, string | number> } | null
  confirm: { message: string; action: () => void; tone?: 'warning' } | null
  /** 子导航角标（2026-11-21 用户指认）：「关键词与扩词」=AI 扩词待审候选总数、「标签与 AI 标记」=标签总数（独立计数请求取 meta.total）。 */
  counts: { candidates: number | null; labels: number | null }
}

/** Host 响应形状（{data, meta} 读 / projectHotboardWrite 写）：machine 内部全为
 * 结构化运行时检查（res.status / res.data / res.results…），端口直接复用
 * api.ts 的 HostResponse（index 签名承载其余字段），无需断言。 */
export type HotboardCallResult = HostResponse & Record<string, unknown>

/** machine 注入面（页面以 hostAction 接线；测试注入假 post）。 */
export interface HotboardMachinePorts {
  call(action: string, args?: Record<string, unknown>): Promise<HotboardCallResult>
  intervalMs?: number
  schedule?: ((fn: () => void) => unknown) | undefined
  clearSchedule?: ((id: unknown) => void) | undefined
  idFactory?: (() => string) | undefined
}

export interface HotboardMachine {
  subscribe(listener: () => void): () => void
  get(): HotboardSnapshot
  init(): void
  stop(): void
  refresh(): Promise<void>
  setSub(sub: HotboardSub): void
  setFilter(group: keyof HotboardFilters, key: string, value: string | boolean): void
  resetFilters(group: keyof HotboardFilters): void
  setPage(group: 'board' | 'keywords' | 'candidates' | 'labels', page: number): void
  openNote(noteId: string): Promise<void>
  closeNote(): void
  openRun(runId?: string | null): Promise<void>
  closeRun(): void
  noteTagUpdate(noteId: string, tagType: string, labelCode: string): Promise<boolean>
  noteExclude(noteId: string): Promise<boolean>
  keywordSave(payload: { action: string; keywordId?: string; keyword?: string; category?: string }): Promise<boolean>
  runStart(): Promise<boolean>
  candidateReview(action: string, candidateIds: string[]): Promise<boolean>
  labelReview(payload: { action: string; proposalId?: string; labelId?: string; targetLabelId?: string }): Promise<boolean>
  labelSave(payload: { labelId?: string; tagType?: string; code?: string; name?: string; aliases?: string[]; definition?: string }): Promise<boolean>
  askConfirm(message: string, action: () => void, tone?: 'warning'): void
  resolveConfirm(): void
  dismissConfirm(): void
  dismissNotice(): void
}

/** run 活跃状态（tools ACTIVE_RUN_STATUSES 同口径）；终态停止轮询。 */
const ACTIVE_RUN_STATUSES = new Set(['queued', 'collecting', 'deduplicating', 'scoring', 'tagging'])
const RUN_POLL_INTERVAL_MS = 2000

function defaultFilters(): HotboardFilters {
  // 默认窗口 90d（旧 OPEN-11 用户裁决：搜索召回偏热门存量笔记，90d 已验证有数据）。
  return {
    board: { window: '90d', keyword: '', style: '', color: '', noteWord: '', commentWord: '', scoreMin: '', scoreMax: '', sort: 'score', onlyMain: true, onlyTagged: false },
    keywords: { category: '', status: '', source: '', keyword: '' },
    candidates: { status: 'pending', category: '', dateFrom: '', dateTo: '' },
    labels: { tagType: '', status: '', source: '', keyword: '', proposalStatus: 'pending' },
  }
}

function emptySnapshot(): HotboardSnapshot {
  return {
    sub: 'board',
    loading: false,
    error: '',
    filters: defaultFilters(),
    pages: { board: 1, keywords: 1, candidates: 1, labels: 1 },
    overview: null,
    keywords: null,
    candidates: null,
    labels: null,
    settings: null,
    runLive: null,
    runDrawer: null,
    noteDrawer: null,
    pending: 0,
    notice: null,
    confirm: null,
    counts: { candidates: null, labels: null },
  }
}

function idempotencyKey(ports: HotboardMachinePorts): string {
  if (ports.idFactory !== undefined) return ports.idFactory()
  if (globalThis.crypto !== undefined && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `xhs-hb-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create the hotboard hub machine.
 * @param ports - injected Host caller and timers.
 * @returns the machine.
 */
export function createHotboardHub(ports: HotboardMachinePorts): HotboardMachine {
  const intervalMs = ports.intervalMs ?? RUN_POLL_INTERVAL_MS
  const schedule = ports.schedule ?? ((fn: () => void) => setTimeout(fn, intervalMs))
  const clearSchedule = ports.clearSchedule ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout))

  let snapshot = emptySnapshot()
  const listeners = new Set<() => void>()
  let timer: unknown = null
  let runId: string | null = null
  let generation = 0
  let stopped = true

  const update = (patch: Partial<HotboardSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const get = (): HotboardSnapshot => snapshot

  const call = async (action: string, args: Record<string, unknown> = {}): Promise<HotboardCallResult> => ports.call(action, args)

  function throwReason(result: HotboardCallResult): never {
    const error = new Error(typeof result.reason === 'string' ? result.reason : 'XHS_HOTBOARD_INTERNAL_ERROR')
    ;(error as Error & { reason?: string }).reason = typeof result.reason === 'string' ? result.reason : 'XHS_HOTBOARD_INTERNAL_ERROR'
    throw error
  }

  // --- 读取 ---

  function boardArgs(): Record<string, unknown> {
    const f = snapshot.filters.board
    const args: Record<string, unknown> = {
      window: f.window, page: snapshot.pages.board, pageSize: 20, sort: f.sort,
      onlyMain: f.onlyMain, onlyTagged: f.onlyTagged,
    }
    for (const key of ['keyword', 'style', 'color', 'noteWord', 'commentWord'] as const) {
      if (f[key] !== '') args[key] = f[key]
    }
    if (f.scoreMin !== '') args.scoreMin = Number(f.scoreMin)
    if (f.scoreMax !== '') args.scoreMax = Number(f.scoreMax)
    return args
  }

  async function loadBoard(): Promise<void> {
    update({ loading: true, error: '' })
    try {
      const res = await call('hotboard.overview', boardArgs())
      if (res.status === 'error') throwReason(res)
      update({ overview: { data: (res.data ?? {}) as HotboardOverview, meta: (res.meta ?? null) as Record<string, unknown> | null }, loading: false })
      syncRunPoll((res.data as HotboardOverview | undefined)?.runStatus ?? null)
    } catch (error) {
      if ((error as { reason?: string }).reason !== undefined && (error as { reason?: string }).reason !== '') {
        update({ error: (error as { reason: string }).reason, loading: false })
      } else {
        update({ error: 'loadFailed', loading: false })
      }
    }
  }

  async function loadKeywords(): Promise<void> {
    update({ loading: true, error: '' })
    try {
      const f = snapshot.filters.keywords
      const args: Record<string, unknown> = { page: snapshot.pages.keywords, pageSize: 20 }
      for (const key of ['category', 'status', 'source', 'keyword'] as const) {
        if (f[key] !== '') args[key] = f[key]
      }
      const res = await call('hotboard.keywords', args)
      if (res.status === 'error') throwReason(res)
      update({ keywords: { data: (res.data ?? {}) as { keywords?: HotboardKeywordRow[] }, meta: (res.meta ?? null) as Record<string, unknown> | null }, loading: false })
    } catch (error) {
      update({ error: typeof (error as { reason?: string }).reason === 'string' ? (error as { reason: string }).reason : 'loadFailed', loading: false })
    }
  }

  async function loadCandidates(): Promise<void> {
    update({ loading: true, error: '' })
    try {
      const f = snapshot.filters.candidates
      const args: Record<string, unknown> = { page: snapshot.pages.candidates, pageSize: 20 }
      for (const key of ['status', 'category'] as const) {
        if (f[key] !== '') args[key] = f[key]
      }
      // dateRange 仅在起止都填写时透传（Host 侧校验 YYYY-MM-DD）。
      if (f.dateFrom !== '' && f.dateTo !== '') {
        args.dateFrom = f.dateFrom
        args.dateTo = f.dateTo
      }
      const res = await call('hotboard.candidates', args)
      if (res.status === 'error') throwReason(res)
      update({ candidates: { data: (res.data ?? {}) as { candidates?: HotboardCandidateRow[] }, meta: (res.meta ?? null) as Record<string, unknown> | null }, loading: false })
    } catch (error) {
      update({ error: typeof (error as { reason?: string }).reason === 'string' ? (error as { reason: string }).reason : 'loadFailed', loading: false })
    }
  }

  async function loadLabels(): Promise<void> {
    update({ loading: true, error: '' })
    try {
      const f = snapshot.filters.labels
      const args: Record<string, unknown> = { page: snapshot.pages.labels, pageSize: 20 }
      for (const key of ['tagType', 'status', 'source', 'keyword', 'proposalStatus'] as const) {
        if (f[key] !== '') args[key] = f[key]
      }
      const res = await call('hotboard.labels', args)
      if (res.status === 'error') throwReason(res)
      update({ labels: { data: (res.data ?? {}) as { labels?: HotboardLabelRow[]; proposals?: HotboardProposalRow[] }, meta: (res.meta ?? null) as Record<string, unknown> | null }, loading: false })
    } catch (error) {
      update({ error: typeof (error as { reason?: string }).reason === 'string' ? (error as { reason: string }).reason : 'loadFailed', loading: false })
    }
  }

  /** 配置只读（R3 定案）：settings 只作只读展示，页面无编辑入口。 */
  async function loadSettings(): Promise<void> {
    try {
      await readSettings()
    } catch (error) {
      void error // 配置读取失败不阻塞页面。
    }
  }

  async function readSettings(): Promise<void> {
    const res = await call('hotboard.settings')
    if (res.status === 'error') return
    update({ settings: (res.data ?? null) as HotboardSettings | null })
  }

  /** 角标总数（子导航）：关键词与标签列表 total（与主列表同分页形态，规避服务端对极小 pageSize 的约束）。 */
  async function refreshCounts(): Promise<void> {
    try {
      await readCounts()
    } catch (error) {
      void error // 徽标失败不打扰主数据。
    }
  }

  async function readCounts(): Promise<void> {
    const [cand, lbl] = await Promise.all([
      call('hotboard.candidates', { status: 'pending', page: 1, pageSize: 20 }),
      call('hotboard.labels', { page: 1, pageSize: 20 }),
    ])
    const metaOf = (res: HotboardCallResult): number | null => {
      const meta = res.meta as { total?: unknown } | null
      // 服务端 total 允许数字或数字字符串（Pager 同用 Number 强转口径）。
      const num = Number(meta?.total)
      return Number.isFinite(num) ? num : null
    }
    update({ counts: { candidates: metaOf(cand), labels: metaOf(lbl) } })
  }

  // --- run 轮询（active run 时轮询 run_get；页面隐藏 stop 停止） ---

  function clearTimer(): void {
    if (timer !== null) {
      clearSchedule(timer)
      timer = null
    }
  }

  function syncRunPoll(runStatus: { runId?: string; status?: string } | null | undefined): void {
    const nextId = runStatus?.runId !== undefined && runStatus.status !== undefined && ACTIVE_RUN_STATUSES.has(runStatus.status) ? runStatus.runId : null
    if (nextId === null || nextId === undefined) {
      runId = null
      clearTimer()
      return
    }
    if (runId === nextId && timer !== null) return
    runId = nextId
    clearTimer()
    if (stopped) return
    timer = schedule(pollRun)
  }

  async function pollRun(): Promise<void> {
    timer = null
    if (runId === null || stopped) return
    const gen = generation
    try {
      await pollRunOnce(gen)
    } catch (error) {
      void error // 单次轮询失败继续下一轮。
    }
    if (runId !== null && !stopped && timer === null) timer = schedule(pollRun)
  }

  /** run 单次查询；落终态时清 runId 并刷新看板（外层因此不再续排）。 */
  async function pollRunOnce(gen: number): Promise<void> {
    const res = await call('hotboard.runGet', { runId })
    if (gen !== generation || stopped) return
    if (res.status !== 'ready') return
    update({ runLive: (res.data ?? null) as HotboardRun | null })
    const status = (res.data as HotboardRun | undefined)?.run?.status
    if (status !== undefined && !ACTIVE_RUN_STATUSES.has(status)) {
      // run 落终态：停轮询并刷新看板 KPI 与待办。
      runId = null
      void refresh()
    }
  }

  // --- 生命周期 ---

  function init(): void {
    stopped = false
    void refresh()
  }

  function stop(): void {
    stopped = true
    generation++
    clearTimer()
    timer = null
  }

  async function refresh(): Promise<void> {
    void refreshCounts()
    const sub = snapshot.sub
    if (sub === 'board') await loadBoard()
    else if (sub === 'keywords') await Promise.all([loadKeywords(), loadCandidates()])
    else if (sub === 'tags') await loadLabels()
    else if (sub === 'rules') await loadSettings()
  }

  function setSub(sub: HotboardSub): void {
    if (snapshot.sub === sub) return
    update({ sub, notice: null })
    if (stopped) return
    if (sub === 'board') void loadBoard()
    else if (sub === 'keywords') { void loadKeywords(); void loadCandidates() }
    else if (sub === 'tags') void loadLabels()
    else if (sub === 'rules') void loadSettings()
  }

  /** 筛选草稿更新：保留草稿（不重置为默认），重置该组页码并重拉。 */
  function setFilter(group: keyof HotboardFilters, key: string, value: string | boolean): void {
    const filters = { ...snapshot.filters, [group]: { ...snapshot.filters[group], [key]: value } }
    const pages = { ...snapshot.pages, [group]: 1 }
    update({ filters, pages })
    if (stopped) return
    if (group === 'board') void loadBoard()
    else if (group === 'keywords') void loadKeywords()
    else if (group === 'candidates') void loadCandidates()
    else if (group === 'labels') void loadLabels()
  }

  /** 一键清空整组筛选（「清空全部」chip）：单次重拉，不逐项发请求。 */
  function resetFilters(group: keyof HotboardFilters): void {
    const filters = { ...snapshot.filters, [group]: defaultFilters()[group] }
    const pages = { ...snapshot.pages, [group]: 1 }
    update({ filters, pages })
    if (stopped) return
    if (group === 'board') void loadBoard()
    else if (group === 'keywords') void loadKeywords()
    else if (group === 'candidates') void loadCandidates()
    else if (group === 'labels') void loadLabels()
  }

  function setPage(group: 'board' | 'keywords' | 'candidates' | 'labels', page: number): void {
    const pages = { ...snapshot.pages, [group]: page }
    update({ pages })
    if (stopped) return
    if (group === 'board') void loadBoard()
    else if (group === 'keywords') void loadKeywords()
    else if (group === 'candidates') void loadCandidates()
    else if (group === 'labels') void loadLabels()
  }

  // --- 抽屉 ---

  async function openNote(noteId: string): Promise<void> {
    update({ noteDrawer: { noteId, data: null, loading: true, error: '' } })
    try {
      const res = await call('hotboard.noteDetail', { noteId })
      const drawer = snapshot.noteDrawer
      if (drawer === null || drawer.noteId !== noteId) return
      if (res.status === 'error') throwReason(res)
      update({ noteDrawer: { noteId, data: (res.data ?? null) as HotboardNoteDetail | null, loading: false, error: '' } })
    } catch (error) {
      const drawer = snapshot.noteDrawer
      if (drawer === null || drawer.noteId !== noteId) return
      update({ noteDrawer: { ...drawer, loading: false, error: typeof (error as { reason?: string }).reason === 'string' ? (error as { reason: string }).reason : 'loadFailed' } })
    }
  }

  function closeNote(): void {
    update({ noteDrawer: null })
  }

  async function openRun(targetRunId?: string | null): Promise<void> {
    const id = targetRunId ?? snapshot.runLive?.run?.runId ?? snapshot.overview?.data.runStatus?.runId ?? null
    if (id === null || id === undefined) {
      update({ notice: { kind: 'error', key: 'hb.noRunYet' } })
      return
    }
    update({ runDrawer: { runId: id, data: null, loading: true, error: '' } })
    try {
      const res = await call('hotboard.runGet', { runId: id })
      const drawer = snapshot.runDrawer
      if (drawer === null || drawer.runId !== id) return
      if (res.status === 'error') throwReason(res)
      update({ runDrawer: { runId: id, data: (res.data ?? null) as HotboardRun | null, loading: false, error: '' } })
    } catch (error) {
      const drawer = snapshot.runDrawer
      if (drawer === null || drawer.runId !== id) return
      update({ runDrawer: { ...drawer, loading: false, error: typeof (error as { reason?: string }).reason === 'string' ? (error as { reason: string }).reason : 'loadFailed' } })
    }
  }

  function closeRun(): void {
    update({ runDrawer: null })
  }

  // --- 写操作（统一 pending 计数 + 成功后刷新待办与当前页；失败保留原数据） ---

  function notify(kind: 'ok' | 'error', key: string, extra?: Record<string, string | number>): void {
    update({ notice: { kind, key, ...(extra !== undefined ? { extra } : {}) } })
  }

  async function runWrite(executor: () => Promise<{ successKey?: string; detail?: Record<string, string | number> } | null>, options: { successKey: string; reload?: 'board' | 'keywords' | 'labels' | 'settings' }): Promise<boolean> {
    if (snapshot.pending > 0 || stopped) return false
    update({ pending: snapshot.pending + 1, notice: null })
    try {
      const outcome = await executor()
      update({ pending: Math.max(0, snapshot.pending - 1) })
      notify('ok', outcome?.successKey ?? options.successKey, outcome?.detail)
      void refreshCounts()
      if (options.reload === 'board') await loadBoard()
      else if (options.reload === 'keywords') await Promise.all([loadKeywords(), loadCandidates()])
      else if (options.reload === 'labels') await loadLabels()
      else if (options.reload === 'settings') await loadSettings()
      return true
    } catch (error) {
      update({ pending: Math.max(0, snapshot.pending - 1) })
      const reason = (error as { reason?: string }).reason
      notify('error', typeof reason === 'string' && reason !== '' ? reason : 'XHS_HOTBOARD_INTERNAL_ERROR')
      return false
    }
  }

  function writeCall(action: string, payload: Record<string, unknown>, idempotencyKeyValue: string): Promise<HotboardCallResult> {
    return call(action, { ...payload, confirm: true, idempotencyKey: idempotencyKeyValue })
  }

  /** 索引字段 → 记录（结构化收窄，替代断言）。 */
  function recordOf(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  }

  return {
    subscribe,
    get,
    init,
    stop,
    refresh,
    setSub,
    setFilter,
    resetFilters,
    setPage,
    openNote,
    closeNote,
    openRun,
    closeRun,
    noteTagUpdate: (noteId, tagType, labelCode) => runWrite(async () => {
      const res = await writeCall('hotboard.noteTagUpdate', { noteId, tagType, labelCode }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      // 当前抽屉里的标签立即反映新值。
      await openNote(noteId)
      return { successKey: 'hb.tagUpdated' }
    }, { successKey: 'hb.writeDone', reload: 'board' }),
    noteExclude: noteId => runWrite(async () => {
      const res = await writeCall('hotboard.noteExclude', { noteId }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      return { successKey: 'hb.noteExcluded' }
    }, { successKey: 'hb.writeDone', reload: 'board' }),
    keywordSave: payload => runWrite(async () => {
      // 路由契约用 op 承载子动作（body.action 是宿主路由名）；UI 语义键 action 在此映射。
      const { action, ...rest } = payload
      const res = await writeCall('hotboard.keywordSave', { op: action, ...rest }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      return { successKey: 'hb.keywordSaved' }
    }, { successKey: 'hb.writeDone', reload: 'keywords' }),
    runStart: () => runWrite(async () => {
      const res = await writeCall('hotboard.runStart', { runType: 'incremental' }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      // run 创建即进入活跃轮询（重放 run 也进入）。
      const run = recordOf(res.run)
      const runIdValue = run === null ? undefined : run.runId
      if (run !== null && typeof runIdValue === 'string' && runIdValue !== '') {
        syncRunPoll({ runId: runIdValue, status: typeof run.status === 'string' ? run.status : 'queued' })
      }
      return { successKey: 'hb.runStartDone' }
    }, { successKey: 'hb.writeDone', reload: 'board' }),
    candidateReview: (action, candidateIds) => runWrite(async () => {
      const res = await writeCall('hotboard.candidateReview', { op: action, candidateIds }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      // 行级失败披露（projectHotboardWrite results）：存在失败时换 partial 文案并带统计。
      const results = Array.isArray(res.results) ? res.results : []
      const failed = results.filter(item => item !== null && item.ok !== true).length
      if (failed > 0) return { successKey: 'hb.candidatesPartial', detail: { failed, total: results.length } }
      return { successKey: 'hb.candidatesReviewed' }
    }, { successKey: 'hb.writeDone', reload: 'keywords' }),
    labelReview: payload => runWrite(async () => {
      const { action, ...rest } = payload
      const res = await writeCall('hotboard.labelReview', { op: action, ...rest }, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      return { successKey: 'hb.labelReviewed' }
    }, { successKey: 'hb.writeDone', reload: 'labels' }),
    labelSave: payload => runWrite(async () => {
      const res = await writeCall('hotboard.labelSave', payload, idempotencyKey(ports))
      if (res.status !== 'ready') throwReason(res)
      return { successKey: 'hb.labelSaved' }
    }, { successKey: 'hb.writeDone', reload: 'labels' }),
    askConfirm: (message, action, tone) => { update({ confirm: tone === undefined ? { message, action } : { message, action, tone } }) },
    resolveConfirm: () => {
      const { confirm } = snapshot
      if (confirm === null) return
      update({ confirm: null })
      confirm.action()
    },
    dismissConfirm: () => { update({ confirm: null }) },
    dismissNotice: () => { update({ notice: null }) },
  }
}
