/**
 * 抖音工作台中央面板：7 Tab 固定顺序（账号总览/账号作品/发布排期看板/爆款
 * 素材看板/爆款拆解/爆款基因库/AI 报表；切任意 Tab 收起 AI 弹层；仅账号作品
 * Tab 有左账号栏两列布局，其余全宽；D6/D7/D8 三 Tab 均为真实实现且首次访问后
 * keep-alive——非当前 Tab 用 hidden 从可访问树移除，页面状态保留；Breakdown
 * archive/workflow 轮询跨 Tab 继续，Material 离开停 run 轮询、重进恢复，Gene
 * 无轮询、重进重拉；未访问过的 Tab 不 eager mount；inactive 期间官方 Modal
 * portal 不泄漏，open 状态保留待切回恢复）。共享编排：browser.status 五态、accounts.list、登录扫码流
 * （beginLogin → 2s 轮询 loginStatus → ok(saveError 透出)/timeout/failed 终态
 * 停轮询刷新列表）、单账号采集（collect.start → 1.5s 轮询 collect.status，乐观
 * 运行态，宿主重启丢 record 清乐观态）、挂载恢复（collect.running /
 * collect.status / collectAll.status 三路查询恢复运行态/横幅/批量面板，用户已
 * 发起则丢弃恢复结果）、批量采集（collectAll.start/status 轮询，
 * 终态刷新）、作品查询（服务端分页排序：固定 10 条/页；切号回第 1 页排序保留；
 * 缓存键=账号|排序|方向|页；序号+账号+查询键三重守卫，过期响应整体丢弃）、
 * 统一作品详情弹层（跨账号显式
 * accountId；detailRequestRef 守卫）、负责人/投流弹层与 Esc 链（官方 Modal 栈
 * 顶层先关、焦点回归）。Toast 收口短暂反馈；素材看板「去拆解」经
 * breakdownPrefill 跨 Tab 预填链接（不自动开始）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { SegmentedTabs, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { createKitTranslate, DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { DEFAULT_WORK_SORT, reasonText, type Translate, type WorkSortState } from './format.ts'
import css from './workbench.module.css'
import { zh as douyinZh } from './locales.ts'
import {
  readAccounts, readBatchStatus, readBrowserState, readCollectRunning, readCollectStatus, readLogin,
  readWorkDetail, readWorksPage, readWorkTrend, type AccountRow, type BatchView,
  type CollectView, type HotWorkRow, type WorkDetailView, type WorkRow, type WorksPage,
  type WorksSummary,
} from './schema.ts'
import { AccountSidebar } from './AccountSidebar.tsx'
import { AnalysisPage, attemptId } from './AnalysisPage.tsx'
import { BreakdownPage } from './BreakdownPage.tsx'
import { GenePage } from './GenePage.tsx'
import { MaterialPage } from './MaterialPage.tsx'
import { OwnerModal } from './OwnerModal.tsx'
import { OverviewPage, DEFAULT_OVERVIEW_FILTERS, downloadBase64, type OverviewFilters } from './OverviewPage.tsx'
import { PromotionModal } from './PromotionModal.tsx'
import { ReportPage } from './ReportPage.tsx'
import { SchedulePage } from './SchedulePage.tsx'
import { WorkDetailModal, type PromotionModalData } from './WorkDetailModal.tsx'
import { WORKS_PAGE_SIZE, WorksPanel } from './WorksPanel.tsx'
import { workTrendRows } from './charts.tsx'

export type { Translate } from './format.ts'
export type { AccountRow, CollectView } from './schema.ts'

type TabValue = 'overview' | 'works' | 'schedule' | 'material' | 'breakdown' | 'gene' | 'report'
type LoadState = 'loading' | 'ready' | 'error'
type WorksLoadState = 'loading' | 'ready' | 'error' | 'partial'
type BrowserState = 'loading' | 'available' | 'chrome_missing' | 'driver_missing' | 'api_error'

/** 登录流状态。 */
interface LoginCardState {
  key: string
  state: string
}

/** 页面级 toast。 */
interface ToastState { text: string; tone: 'success' | undefined; seq: number }

export interface WorkbenchPageProps { t: Translate }

interface TabItem { value: TabValue; label: string; id: string; panelId: string }

const LOGIN_POLL_MS = 2000
const COLLECT_POLL_MS = 1500

/** locale 标签（数值/日期格式化用）：词典逐键不同，逐键等价判定可靠。 */
export function localeTagOf(t: Translate): string {
  return t('panel') === douyinZh.panel ? 'zh' : 'en'
}

/** 页面组件：全量接线 Host API 与 7 Tab 布局。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<TabValue>('overview')
  const [browser, setBrowser] = useState<BrowserState>('loading')
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [accountsState, setAccountsState] = useState<LoadState>('loading')
  const [login, setLogin] = useState<LoginCardState | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [works, setWorks] = useState<WorkRow[]>([])
  const [worksState, setWorksState] = useState<WorksLoadState>('loading')
  const [worksSort, setWorksSort] = useState<WorkSortState>(DEFAULT_WORK_SORT)
  const [worksPage, setWorksPage] = useState(1)
  const [worksTotal, setWorksTotal] = useState(0)
  const [worksSummary, setWorksSummary] = useState<WorksSummary | null>(null)
  const [worksBusy, setWorksBusy] = useState(false)
  const [collectBusy, setCollectBusy] = useState(false)
  const [collectRecord, setCollectRecord] = useState<CollectView | null>(null)
  const [collectStartReason, setCollectStartReason] = useState<string | null>(null)
  const [batch, setBatch] = useState<BatchView | null>(null)
  // 挂载恢复期 collect.running 已报批量运行中、collectAll.status 未返回：先锁入口。
  const [batchRecoveryPending, setBatchRecoveryPending] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailedParts, setRefreshFailedParts] = useState<string[]>([])
  const [exporting, setExporting] = useState(false)
  const [overviewFilters, setOverviewFilters] = useState<OverviewFilters>(DEFAULT_OVERVIEW_FILTERS)
  const [analysisAccountId, setAnalysisAccountId] = useState<string | null>(null)
  const [detailTarget, setDetailTarget] = useState<{ accountId: string; row: WorkRow } | null>(null)
  const [detail, setDetail] = useState<WorkDetailView | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [trendRows, setTrendRows] = useState<{ day: string; value: number | null }[]>([])
  const [ownerModal, setOwnerModal] = useState<{ accountId: string; accountName: string; ownerName: string } | null>(null)
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [promotionModal, setPromotionModal] = useState<(PromotionModalData & { accountName: string; staleRecovered: boolean }) | null>(null)
  const [promotionSaving, setPromotionSaving] = useState(false)
  const [toast, setToast] = useState<ToastState | null>(null)
  // 素材看板「去拆解」跨 Tab 预填：切爆款拆解 Tab 并带入链接（不自动开始）。
  const [breakdownPrefill, setBreakdownPrefill] = useState<string | null>(null)
  // D6–D8 keep-alive：首次访问后保持 mounted（页面状态保留），非当前 Tab 用
  // hidden 从可访问树移除；未访问过的 Tab 不 eager mount。轮询语义分页：
  // Breakdown 跨 Tab 继续，Material 离开停/重进恢复，Gene 无轮询。
  const [visitedTabs, setVisitedTabs] = useState<readonly TabValue[]>(['overview'])

  const selectTab = useCallback((value: TabValue): void => {
    setTab(value)
    setVisitedTabs(previous => previous.includes(value) ? previous : [...previous, value])
  }, [])

  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const collectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 当前单账号轮询的目标账号（同账号恢复双路指向同一条记录时轮询不重启）。 */
  const collectPollAccountRef = useRef<string | null>(null)
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** collectAll.start 在途标记：请求未返回前的重复点击直接忽略。 */
  const batchStartInFlightRef = useRef(false)
  // 挂载恢复竞态守卫：用户已发起采集/批量后，到达的恢复响应一律丢弃。
  const collectInitiatedRef = useRef(false)
  const batchInitiatedRef = useRef(false)
  // 挂载恢复一次性标记（账号列表就绪、选中账号确定时触发）。
  const collectRestoreDoneRef = useRef(false)
  const worksSeqRef = useRef(0)
  const worksCacheRef = useRef(new Map<string, WorksPage>())
  const worksRowsRef = useRef<{ accountId: string; rows: WorkRow[] }>({ accountId: '', rows: [] })
  const worksSortRef = useRef(worksSort)
  const worksPageRef = useRef(worksPage)
  const worksQueryRef = useRef('')
  const worksAccountRef = useRef<string | null>(null)
  const selectedIdRef = useRef<string | null>(null)
  const accountsRef = useRef<AccountRow[]>([])
  const detailSeqRef = useRef(0)
  const toastSeqRef = useRef(0)
  useEffect(() => { selectedIdRef.current = selectedAccountId }, [selectedAccountId])
  useEffect(() => { accountsRef.current = accounts }, [accounts])
  useEffect(() => { worksSortRef.current = worksSort }, [worksSort])
  useEffect(() => { worksPageRef.current = worksPage }, [worksPage])

  const kitTranslate = localeTagOf(t) === 'zh' ? createKitTranslate(kitZh) : createKitTranslate(kitEn)
  const localeTag = localeTagOf(t)

  const notify = useCallback((text: string, tone: 'success' | undefined = undefined): void => {
    toastSeqRef.current += 1
    setToast({ text, tone, seq: toastSeqRef.current })
  }, [])

  /** @returns 账号列表是否刷新成功（stale 竞态让位不计失败）。 */
  const refreshAccounts = useCallback(async (): Promise<boolean> => {
    try {
      const res = await hostAction('accounts.list')
      const rows = readAccounts(res)
      setAccounts(rows)
      setAccountsState('ready')
      setSelectedAccountId(current => {
        if (current !== null && rows.some(row => row.accountId === current)) return current
        const firstUsable = rows.find(row => row.deleteState !== 'remote_deleted')
        return firstUsable !== undefined ? firstUsable.accountId : null
      })
      return true
    } catch {
      setAccountsState('error')
      return false
    }
  }, [])

  useEffect(() => {
    void refreshAccounts()
    void hostAction('browser.status').then(res => { setBrowser(readBrowserState(res)) }).catch(() => { setBrowser('api_error') })
    return () => {
      for (const ref of [loginPollRef, collectPollRef, batchPollRef]) {
        if (ref.current !== null) { clearInterval(ref.current); ref.current = null }
      }
    }
  }, [refreshAccounts])

  // ---- 作品列表（服务端分页排序：切号回第 1 页排序保留；缓存键=账号|排序|方向|页；
  // 序号 + 账号 + 查询键三重守卫，过期响应整体丢弃） ----

  /**
   * 拉取一页作品（无 override 时取当前排序态与页码；排序/翻页变化由调用方显式传）。
   * 命中缓存先即时渲染再后台刷新；请求在途保留当前已渲染行（worksBusy 标记）。
   * @returns works 是否拉取成功（stale 竞态让位不计失败）。
   */
  const loadWorks = useCallback(async (accountId: string, override: { page?: number; sort?: WorkSortState } = {}): Promise<boolean> => {
    const sort = override.sort ?? worksSortRef.current
    const page = Math.max(1, override.page ?? worksPageRef.current)
    const sortKey = sort.key ?? 'publish_time'
    const order: 'asc' | 'desc' = sort.direction === 'asc' ? 'asc' : 'desc'
    const queryKey = `${accountId}|${sortKey}|${order}|${page}`
    const seq = ++worksSeqRef.current
    worksQueryRef.current = queryKey
    const cached = worksCacheRef.current.get(queryKey)
    const resume = worksRowsRef.current.accountId === accountId
    if (cached !== undefined && selectedIdRef.current === accountId) {
      worksRowsRef.current = { accountId, rows: cached.rows }
      setWorks(cached.rows)
      setWorksTotal(cached.total)
      setWorksSummary(cached.summary)
      setWorksState('ready')
    } else if (!resume) {
      worksRowsRef.current = { accountId: '', rows: [] }
      setWorks([])
      setWorksTotal(0)
      setWorksSummary(null)
      setWorksState('loading')
    }
    setWorksBusy(true)
    try {
      const res = await hostAction('works.list', {
        accountId, sort: sortKey, order, limit: WORKS_PAGE_SIZE, offset: (page - 1) * WORKS_PAGE_SIZE,
      })
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId || worksQueryRef.current !== queryKey) return true
      const view = readWorksPage(res)
      worksCacheRef.current.set(queryKey, view)
      worksRowsRef.current = { accountId, rows: view.rows }
      setWorks(view.rows)
      setWorksTotal(view.total)
      setWorksSummary(view.summary)
      setWorksState('ready')
      return true
    } catch {
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId || worksQueryRef.current !== queryKey) return true
      const sameAccountRows = worksRowsRef.current.accountId === accountId && worksRowsRef.current.rows.length > 0
      setWorksState(sameAccountRows ? 'partial' : 'error')
      return false
    } finally {
      if (worksSeqRef.current === seq) setWorksBusy(false)
    }
  }, [])

  useEffect(() => {
    if (selectedAccountId === null) return
    if (tab !== 'works') return
    const switched = worksAccountRef.current !== selectedAccountId
    worksAccountRef.current = selectedAccountId
    if (switched) {
      worksPageRef.current = 1
      setWorksPage(1)
      void loadWorks(selectedAccountId, { page: 1 })
      return
    }
    void loadWorks(selectedAccountId)
  }, [selectedAccountId, tab, loadWorks])

  /** 表头排序：回第 1 页并以新排序重拉（排序态保留到切号）。 */
  const changeWorksSort = useCallback((next: WorkSortState): void => {
    setWorksSort(next)
    worksPageRef.current = 1
    setWorksPage(1)
    const accountId = selectedIdRef.current
    if (accountId !== null && accountId !== '') void loadWorks(accountId, { page: 1, sort: next })
  }, [loadWorks])

  /** 翻页：只改 offset，排序不变。 */
  const changeWorksPage = useCallback((page: number): void => {
    worksPageRef.current = page
    setWorksPage(page)
    const accountId = selectedIdRef.current
    if (accountId !== null && accountId !== '') void loadWorks(accountId, { page })
  }, [loadWorks])

  // ---- 登录扫码流（2s 轮询；终态停轮询刷新列表） ----

  const stopLoginPolling = useCallback((): void => {
    if (loginPollRef.current !== null) { clearInterval(loginPollRef.current); loginPollRef.current = null }
  }, [])

  const beginLoginPolling = useCallback((key: string): void => {
    stopLoginPolling()
    const tick = (): void => {
      void hostAction('account.loginStatus', { loginKey: key }).then(res => {
        const view = readLogin(res)
        if (view.status === 'ok') {
          stopLoginPolling()
          setLogin(null)
          notify(view.saveError !== null ? t('login.savedFailedToast') : t('login.okToast'), 'success')
          void refreshAccounts()
        } else if (view.status === 'timeout' || view.status === 'failed') {
          stopLoginPolling()
          setLogin(null)
          notify(view.status === 'timeout' ? t('login.timeoutToast') : t('login.failedToast'))
        } else if (view.status === 'idle') {
          stopLoginPolling()
          setLogin(null)
        }
      }).catch(() => undefined)
    }
    void tick()
    loginPollRef.current = setInterval(tick, LOGIN_POLL_MS)
  }, [notify, refreshAccounts, stopLoginPolling, t])

  const beginLogin = useCallback((): void => {
    void hostAction('account.beginLogin', {}).then(res => {
      const view = readLogin(res)
      if (view.loginKey !== '') {
        setLogin({ key: view.loginKey, state: view.status })
        beginLoginPolling(view.loginKey)
      }
    }).catch(error => {
      notify(error instanceof Error ? reasonText(error.message, t) : t('error.default'))
    })
  }, [beginLoginPolling, notify, t])

  // ---- 单账号采集（乐观运行态；宿主重启丢 record 清乐观态；挂载恢复共用轮询） ----

  const stopCollectPolling = useCallback((): void => {
    if (collectPollRef.current !== null) { clearInterval(collectPollRef.current); collectPollRef.current = null }
    collectPollAccountRef.current = null
  }, [])

  const refreshAfterDataChange = useCallback(async (accountId: string): Promise<void> => {
    for (const key of [...worksCacheRef.current.keys()]) {
      if (key.startsWith(`${accountId}|`)) worksCacheRef.current.delete(key)
    }
    await Promise.all([loadWorks(accountId), refreshAccounts()])
  }, [loadWorks, refreshAccounts])

  /** 单账号采集轮询（页面发起与挂载恢复共用同一 tick 与终态收尾）。 */
  const beginCollectPolling = useCallback((accountId: string): void => {
    // 同账号轮询已在跑则不重启（挂载恢复的 collect.running 与 collect.status
    // 指向同一条运行中记录时幂等）。
    if (collectPollRef.current !== null && collectPollAccountRef.current === accountId) return
    stopCollectPolling()
    collectPollAccountRef.current = accountId
    const tick = (): void => {
      void hostAction('collect.status', { accountId }).then(statusRes => {
        const statusView = readCollectStatus(statusRes)
        if (statusView.collect === null) {
          // 宿主重启/插件重载丢 collectRecord：清乐观 running 态避免永不清除。
          stopCollectPolling()
          setCollectBusy(false)
          setCollectRecord(null)
          if (statusView.recovery === 'recovery_required') notify(t('run.interrupted'))
          else notify(t('works.collectLost'))
          return
        }
        setCollectRecord(statusView.collect)
        if (statusView.collect.status !== 'running') {
          stopCollectPolling()
          setCollectBusy(false)
          if (statusView.collect.status === 'failed') {
            notify(statusView.collect.error !== null ? `${t('works.collectFailed')}：${reasonText(statusView.collect.error, t)}` : t('works.collectFailed'))
          }
          void refreshAfterDataChange(statusView.collect.accountId || accountId)
        }
      }).catch(() => undefined)
    }
    void tick()
    collectPollRef.current = setInterval(tick, COLLECT_POLL_MS)
  }, [notify, refreshAfterDataChange, stopCollectPolling, t])

  const startCollect = useCallback((accountId: string): void => {
    if (accountId === '') return
    collectInitiatedRef.current = true
    setCollectStartReason(null)
    setCollectBusy(true)
    setCollectRecord({ accountId, status: 'running', phase: null, progress: {}, error: null, finishedAt: null })
    void hostAction('collect.start', { accountId }).then(res => {
      const view = readCollectStatus({ collect: res.collect })
      if (view.collect === null) {
        setCollectBusy(false)
        setCollectRecord(null)
        setCollectStartReason(typeof res.reason === 'string' ? res.reason : 'collect_busy')
        return
      }
      setCollectRecord(view.collect)
      beginCollectPolling(accountId)
    }).catch(error => {
      stopCollectPolling()
      setCollectBusy(false)
      setCollectRecord(null)
      setCollectStartReason(error instanceof Error ? error.message : 'collect_busy')
    })
  }, [beginCollectPolling, stopCollectPolling])

  // ---- 批量采集（终态刷新；挂载恢复共用轮询） ----

  const stopBatchPolling = useCallback((): void => {
    if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
  }, [])

  /** 批量采集轮询（页面发起与挂载恢复共用同一 tick 与终态收尾）。 */
  const beginBatchPolling = useCallback((): void => {
    stopBatchPolling()
    const tick = (): void => {
      void hostAction('collectAll.status', {}).then(batchRes => {
        const next = readBatchStatus(batchRes)
        setBatch(next)
        if (next.status !== null && next.status !== 'running') {
          stopBatchPolling()
          const current = selectedIdRef.current
          if (current !== null) void refreshAfterDataChange(current)
        }
      }).catch(() => undefined)
    }
    void tick()
    batchPollRef.current = setInterval(tick, COLLECT_POLL_MS)
  }, [refreshAfterDataChange, stopBatchPolling])

  const startBatch = useCallback((): void => {
    if (batchStartInFlightRef.current) return
    batchInitiatedRef.current = true
    batchStartInFlightRef.current = true
    setBatch(readBatchStatus({ batch: { status: 'running', phase: 'probing' } }))
    void hostAction('collectAll.start', {}).then(res => {
      // resolve 即已启动：Host 失败走 error envelope（hostAction 抛出，入 catch）。
      batchStartInFlightRef.current = false
      setBatch(readBatchStatus(res))
      beginBatchPolling()
    }).catch(error => {
      batchStartInFlightRef.current = false
      stopBatchPolling()
      setBatch(null)
      notify(`${t('batch.startFailed')}：${reasonText(error instanceof Error ? error.message : 'collect_busy', t)}`)
    })
  }, [beginBatchPolling, notify, stopBatchPolling, t])

  // ---- 挂载恢复：三路并行查询，恢复采集态/横幅/批量面板 ----

  useEffect(() => {
    if (selectedAccountId === null || collectRestoreDoneRef.current) return
    collectRestoreDoneRef.current = true
    const accountId = selectedAccountId
    void hostAction('collect.running').then(res => {
      const view = readCollectRunning(res)
      if (view.collect !== null && !collectInitiatedRef.current) {
        setCollectRecord(view.collect)
        if (view.collect.status === 'running') {
          setCollectBusy(true)
          beginCollectPolling(view.collect.accountId !== '' ? view.collect.accountId : accountId)
        }
      }
      if (view.batchRunning && !batchInitiatedRef.current) {
        // 批量确认查询返回前先禁用采集入口。
        setBatchRecoveryPending(true)
      }
    }).catch(() => undefined)
    void hostAction('collect.status', { accountId }).then(res => {
      if (collectInitiatedRef.current) return
      const view = readCollectStatus(res)
      const recovered = view.collect
      if (recovered === null) {
        // G-2：重启后内存丢失且无法安全对账 → 提示中断，不进入运行态。
        if (view.recovery === 'recovery_required') notify(t('run.interrupted'))
        return
      }
      if (recovered.status === 'running') {
        // 与 collect.running 指向同一条记录时幂等（重复落盘同形投影）。
        setCollectRecord(recovered)
        setCollectBusy(true)
        beginCollectPolling(recovered.accountId !== '' ? recovered.accountId : accountId)
        return
      }
      // 终态：显示横幅；不覆盖其他账号的运行中投影。
      setCollectRecord(previous => previous !== null && previous.status === 'running' && previous.accountId !== recovered.accountId ? previous : recovered)
    }).catch(() => undefined)
    void hostAction('collectAll.status', {}).then(res => {
      setBatchRecoveryPending(false)
      if (batchInitiatedRef.current) return
      // batch 为 null（Host 无批量记录）时不落投影：readBatchStatus 的 fallback
      // 会把 envelope status 误读为批量状态，渲染出幻影面板。
      const next = res.batch === null || res.batch === undefined ? null : readBatchStatus(res)
      setBatch(next)
      if (next !== null && next.status === 'running') beginBatchPolling()
    }).catch(() => { setBatchRecoveryPending(false) })
  }, [beginBatchPolling, beginCollectPolling, notify, selectedAccountId, t])

  // ---- 刷新（账号作品页工具栏） ----

  const refreshAll = useCallback((accountId: string): void => {
    if (accountId === '') return
    setRefreshing(true)
    setRefreshFailedParts([])
    void (async () => {
      const results = await Promise.all([loadWorks(accountId), refreshAccounts()])
      const failed = [results[0] ? null : 'works', results[1] ? null : 'accounts']
        .filter((part): part is 'works' | 'accounts' => part !== null)
      if (failed.length > 0) setRefreshFailedParts(failed)
      setRefreshing(false)
    })()
  }, [loadWorks, refreshAccounts])

  /** 导出 Excel（当前账号全量作品）。 */
  const exportWorks = useCallback((): void => {
    const accountId = selectedAccountId
    if (accountId === null) return
    setExporting(true)
    void (async () => {
      try {
        const res = await hostAction('export', { accountId })
        downloadBase64(
          typeof res.file_name === 'string' ? res.file_name : 'douyin-export.xlsx',
          typeof res.content_base64 === 'string' ? res.content_base64 : '',
          typeof res.mime_type === 'string' ? res.mime_type : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
      } catch (error) {
        notify(reasonText(error instanceof Error ? error.message : 'export_failed', t))
      } finally {
        setExporting(false)
      }
    })()
  }, [notify, selectedAccountId, t])

  // ---- 统一作品详情弹层（跨账号显式 accountId；detailRequestRef 守卫） ----

  const openDetail = useCallback((accountId: string, row: WorkRow): void => {
    const seq = ++detailSeqRef.current
    setDetailTarget({ accountId, row })
    setDetail(null)
    setTrendRows([])
    setDetailState('loading')
    void hostAction('work.get', { accountId, workId: row.work_id }).then(res => {
      if (detailSeqRef.current !== seq) return
      setDetail(readWorkDetail(res))
      setDetailState('ready')
    }).catch(() => {
      if (detailSeqRef.current !== seq) return
      setDetail(null)
      setDetailState('error')
    })
    void hostAction('work.trend', { accountId, workId: row.work_id }).then(res => {
      if (detailSeqRef.current !== seq) return
      setTrendRows(workTrendRows(readWorkTrend(res)))
    }).catch(() => {
      if (detailSeqRef.current !== seq) return
      setTrendRows([])
    })
  }, [])

  const closeDetail = useCallback((): void => {
    detailSeqRef.current += 1
    setDetailTarget(null)
    setDetail(null)
    setTrendRows([])
    setDetailState('loading')
  }, [])

  /** 热门作品行 → 作品行（乐观展示基准）。 */
  const hotWorkToRow = useCallback((work: HotWorkRow): WorkRow => ({
    work_id: work.workId,
    title: work.title,
    url: null,
    cover_url: null,
    duration_s: null,
    publish_time: work.publishTime,
    latest_collected_at: null,
    play_count: work.playCount,
    collect_count: null,
    like_count: null,
    comment_count: null,
    bounce_rate_2s_pct: null,
    completion_rate_5s_pct: null,
    completion_rate_pct: null,
    fans_gain_count: work.fansGainCount,
    avg_watch_duration_s: null,
    avg_view_proportion_pct: null,
    promoted: work.promoted,
    visibility: null,
    data_gap: null,
  }), [])

  const openHotWork = useCallback((accountId: string, work: HotWorkRow): void => {
    openDetail(accountId, hotWorkToRow(work))
  }, [hotWorkToRow, openDetail])

  // ---- 负责人弹层（保存投影更新账号列表 + 筛选唯一一次重查校准） ----

  const saveOwner = useCallback(async (input: { accountId: string; ownerName: string }): Promise<string | null> => {
    setOwnerSaving(true)
    try {
      await hostAction('account.owner.set', {
        accountId: input.accountId,
        ownerName: input.ownerName,
        idempotencyKey: `douyin:account_owner_set:${attemptId()}`,
      })
    } catch (error) {
      setOwnerSaving(false)
      return error instanceof Error ? error.message : 'VALIDATION_ERROR'
    }
    setOwnerSaving(false)
    setOwnerModal(null)
    notify(t('owner.saved'), 'success')
    await refreshAccounts()
    // 筛选校准（RQ-2026-009 §6.5，基于刷新后账号目录 + 本次保存结果，重拉前
    // 一次定案）：旧 ownerName 失联 → 清空；已选账号不在目录或不在负责人名下
    // → 重置全部账号；随后 OverviewPage 的 filters effect 恰发一次查询。
    setOverviewFilters(previous => {
      const candidates = new Set(accountsRef.current
        .map(row => row.ownerName?.trim())
        .filter((name): name is string => name !== undefined && name !== ''))
      const next = { ...previous }
      if (next.ownerName !== '' && !candidates.has(next.ownerName)) next.ownerName = ''
      const picked = next.accountIds[0]
      if (picked !== undefined && picked !== '') {
        const pickedRow = accountsRef.current.find(row => row.accountId === picked)
        const inOwnerScope = next.ownerName === ''
          || (pickedRow?.ownerName?.trim() === next.ownerName)
          || (picked === input.accountId && input.ownerName === next.ownerName)
        if (pickedRow === undefined || !inOwnerScope) next.accountIds = []
      }
      return next
    })
    return null
  }, [notify, refreshAccounts, t])

  // ---- 投流弹层（PROMOTION_ALREADY_EXISTS 自动重拉转更新） ----

  const openPromotion = useCallback((data: PromotionModalData): void => {
    const owner = accounts.find(row => row.accountId === data.accountId)
    setPromotionModal({ ...data, accountName: owner?.nickname ?? data.accountId, staleRecovered: false })
  }, [accounts])

  const savePromotion = useCallback(async (input: {
    accountId: string
    workId: string
    recordId: number | null
    playCount: number
    costAmount: string
    fansCount: number
    durationHours: string
  }): Promise<string | null> => {
    if (promotionModal === null) return 'PROMOTION_FIELD_REQUIRED'
    setPromotionSaving(true)
    try {
      await hostAction('work.promotion.save', {
        accountId: input.accountId,
        workId: input.workId,
        playCount: input.playCount,
        fansCount: input.fansCount,
        costAmount: input.costAmount,
        durationHours: input.durationHours,
        ...(input.recordId !== null ? { recordId: input.recordId } : {}),
        idempotencyKey: `douyin:work_promotion_save:${attemptId()}`,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'douyin_operation_request_failed'
      if (reason === 'PROMOTION_ALREADY_EXISTS') {
        // stale-add 自动恢复：重拉详情换入最新记录（挂载 key 变化重挂载预填）。
        let staleDetail: WorkDetailView | undefined
        try {
          staleDetail = readWorkDetail(await hostAction('work.get', { accountId: input.accountId, workId: input.workId }))
        } catch (_staleRecoveryFailed) {
          // stale-add 恢复是可选补偿；失败时保留原冲突错误与用户输入，不伪装恢复成功。
        }
        if (staleDetail !== undefined && staleDetail.promotion !== null) {
          setPromotionModal(previous => previous !== null ? {
            ...previous,
            recordId: staleDetail.promotion?.id ?? null,
            playCount: staleDetail.promotion?.playCount ?? '',
            costAmount: staleDetail.promotion?.costAmount ?? '',
            fansCount: staleDetail.promotion?.fansCount ?? '',
            durationHours: staleDetail.promotion?.durationHours ?? '',
            staleRecovered: true,
          } : previous)
          setPromotionSaving(false)
          return null
        }
      }
      setPromotionSaving(false)
      return reason
    }
    setPromotionSaving(false)
    setPromotionModal(null)
    notify(t('promotion.saved'), 'success')
    if (detailTarget !== null) openDetail(detailTarget.accountId, detailTarget.row)
    return null
  }, [detailTarget, notify, openDetail, promotionModal, t])

  // ---- Tab 切换（收起 AI 弹层由 AnalysisPage 卸载承担） ----

  const batchRunning = batch !== null && batch.status === 'running'
  // 批量对采集入口的占用 = 运行中或挂载恢复确认在途。
  const batchBusy = batchRunning || batchRecoveryPending
  // 账号栏「采集中」状态点数据源：单账号运行投影 + 批量运行中条目。
  const collectingAccountIds: string[] = []
  if (collectBusy && collectRecord !== null && collectRecord.accountId !== '') collectingAccountIds.push(collectRecord.accountId)
  if (batchRunning && batch !== null) {
    for (const item of batch.items) {
      if (item.status === 'running' && !collectingAccountIds.includes(item.accountId)) collectingAccountIds.push(item.accountId)
    }
  }
  const browserBlocking = browser === 'chrome_missing' || browser === 'driver_missing'
  const loginActive = login !== null && login.state === 'waiting'
  const activeAccountId = selectedAccountId
    ?? accounts.find(row => row.deleteState !== 'remote_deleted')?.accountId
    ?? ''
  const selectedAccount = accounts.find(row => row.accountId === activeAccountId) ?? null

  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'overview', label: t('tab.overview'), id: 'dy-tab-overview', panelId: 'dy-panel-overview' },
    { value: 'works', label: t('tab.works'), id: 'dy-tab-works', panelId: 'dy-panel-works' },
    { value: 'schedule', label: t('tab.schedule'), id: 'dy-tab-schedule', panelId: 'dy-panel-schedule' },
    { value: 'material', label: t('tab.material'), id: 'dy-tab-material', panelId: 'dy-panel-material' },
    { value: 'breakdown', label: t('tab.breakdown'), id: 'dy-tab-breakdown', panelId: 'dy-panel-breakdown' },
    { value: 'gene', label: t('tab.gene'), id: 'dy-tab-gene', panelId: 'dy-panel-gene' },
    { value: 'report', label: t('tab.report'), id: 'dy-tab-report', panelId: 'dy-panel-report' },
  ]

  const headerStatus = browser === 'loading'
    ? <span className={css.headerStatus}><StateDot state='ongoing' />{t('header.status.browserChecking')}</span>
    : browserBlocking
      ? <span className={css.headerStatus}><StateDot state='error' />{t('header.status.browserBlocked')}</span>
      : browser === 'api_error'
        ? <span className={css.headerStatus}><StateDot state='warning' />{t('header.status.serviceDegraded')}</span>
        : <span className={css.headerStatus}><StateDot state='done' />{t('header.status.browserReady')}</span>

  const rangeLabel = overviewFilters.window === 'custom'
    ? t('overview.range.custom', { from: overviewFilters.customFrom ?? '?', to: overviewFilters.customTo ?? '?' })
    : t(`overview.window.${overviewFilters.window}` as 'overview.window.30d')

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={t('panel.subtitle')}
            status={headerStatus}
          />
        )}
      >
        <div className={css.tabsRow}>
          <SegmentedTabs items={tabs} value={tab} onChange={selectTab} label={t('panel')} />
        </div>

        <DataState
          state={accountsState === 'ready' || (accountsState === 'error' && accounts.length > 0) ? 'ready' : accountsState}
          shape='rows'
          onRetry={() => { void refreshAccounts() }}
        >
          <div id='dy-panel-body' role='tabpanel' aria-label={t('panel')} className={css.panelBodyFlex}>
            {tab === 'overview' && analysisAccountId === null && (
              <OverviewPage
                t={t}
                localeTag={localeTag}
                filters={overviewFilters}
                onFiltersChange={setOverviewFilters}
                onOpenAccount={setAnalysisAccountId}
                onOpenWork={openHotWork}
                onNotice={notify}
              />
            )}
            {tab === 'overview' && analysisAccountId !== null && (
              <AnalysisPage
                t={t}
                localeTag={localeTag}
                accountId={analysisAccountId}
                rangeLabel={rangeLabel}
                onBack={() => { setAnalysisAccountId(null) }}
                onOpenWork={openHotWork}
                onNotice={notify}
              />
            )}
            {tab === 'works' && (
              <div className={css.worksLayout}>
                <AccountSidebar
                  t={t}
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  browserBlocked={browserBlocking}
                  loginActive={loginActive}
                  collectBusy={collectBusy}
                  batchBusy={batchBusy}
                  batch={batch}
                  collectingAccountIds={collectingAccountIds}
                  onSelect={setSelectedAccountId}
                  onCollectAll={startBatch}
                  onRelogin={beginLogin}
                  onAddAccount={beginLogin}
                  onAccountsChanged={refreshAccounts}
                  onNotice={notify}
                />
                <section className={css.worksPanel} aria-label={t('tab.works')}>
                  <WorksPanel
                    t={t}
                    localeTag={localeTag}
                    accountId={activeAccountId}
                    account={selectedAccount}
                    works={works}
                    worksState={worksState}
                    worksSort={worksSort}
                    worksPage={worksPage}
                    worksTotal={worksTotal}
                    worksSummary={worksSummary}
                    worksBusy={worksBusy}
                    onSortChange={changeWorksSort}
                    onPageChange={changeWorksPage}
                    onRetryWorks={() => { if (activeAccountId !== '') void loadWorks(activeAccountId) }}
                    collectBusy={collectBusy}
                    collectRecord={collectRecord}
                    collectStartReason={collectStartReason}
                    onStartCollect={startCollect}
                    batchRunning={batchBusy}
                    browserBlocked={browserBlocking}
                    refreshing={refreshing}
                    refreshFailedParts={refreshFailedParts}
                    onRefresh={() => { refreshAll(activeAccountId) }}
                    exporting={exporting}
                    onExport={exportWorks}
                    onOpenOwner={() => {
                      if (selectedAccount === null) return
                      setOwnerModal({
                        accountId: selectedAccount.accountId,
                        accountName: selectedAccount.nickname ?? selectedAccount.accountId,
                        ownerName: selectedAccount.ownerName ?? '',
                      })
                    }}
                    onOpenWork={openDetail}
                  />
                </section>
              </div>
            )}
            {tab === 'schedule' && (
              <SchedulePage t={t} accounts={accounts} accountsState={accountsState} />
            )}
            {visitedTabs.includes('material') && (
              <div className={css.tabPanel} hidden={tab !== 'material'}>
                <MaterialPage
                  t={t}
                  localeTag={localeTag}
                  active={tab === 'material'}
                  onNotice={notify}
                  onStartBreakdown={shareUrl => { selectTab('breakdown'); setBreakdownPrefill(shareUrl) }}
                />
              </div>
            )}
            {visitedTabs.includes('breakdown') && (
              <div className={css.tabPanel} hidden={tab !== 'breakdown'}>
                <BreakdownPage
                  t={t}
                  active={tab === 'breakdown'}
                  onNotice={notify}
                  prefill={breakdownPrefill}
                  onPrefillConsumed={() => { setBreakdownPrefill(null) }}
                />
              </div>
            )}
            {visitedTabs.includes('gene') && (
              <div className={css.tabPanel} hidden={tab !== 'gene'}>
                <GenePage t={t} localeTag={localeTag} active={tab === 'gene'} onNotice={notify} />
              </div>
            )}
            {tab === 'report' && (
              <ReportPage t={t} localeTag={localeTag} onNotice={notify} />
            )}
          </div>
        </DataState>

        <WorkDetailModal
          t={t}
          localeTag={localeTag}
          target={detailTarget}
          detail={detail}
          detailState={detailState}
          trend={trendRows}
          onRetry={() => { if (detailTarget !== null) openDetail(detailTarget.accountId, detailTarget.row) }}
          onClose={closeDetail}
          onOpenPromotion={openPromotion}
        />
        {ownerModal !== null && (
          <OwnerModal t={t} modal={ownerModal} saving={ownerSaving} onConfirm={saveOwner} onClose={() => { setOwnerModal(null) }} />
        )}
        {promotionModal !== null && (
          <PromotionModal
            key={promotionModal.recordId !== null ? `promotion-${promotionModal.recordId}` : 'promotion-new'}
            t={t}
            modal={promotionModal}
            saving={promotionSaving}
            onConfirm={savePromotion}
            onClose={() => { setPromotionModal(null) }}
          />
        )}
        {toast !== null && (
          <Toast
            key={toast.seq}
            {...(toast.tone === 'success' ? { tone: 'success' as const } : {})}
            text={toast.text}
            onDone={() => { setToast(null) }}
          />
        )}
      </PluginPageShell>
    </KitLocaleProvider>
  )
}
