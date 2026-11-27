/**
 * 视频号工作台页面的组合 hook：UI 态 reducer（[workbench-ui.ts]）、四 machine
 * （[flows.ts]）的创建与订阅、固定 last_7d 摘要流、挂载恢复、批量轮询、选中
 * 驱动的第二路单账号轮询与布局派生值（tabs、headerStatus）。WorkbenchPage
 * 只做 JSX 组合；发起/恢复路竞态守卫在 machine 里，本 hook 只做转发与镜像。
 * @module
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createKitTranslate } from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import css from './workbench.module.css'
import { localeTagOf, reasonText } from './format.ts'
import type { SortState } from './works-format.ts'
import { readBrowserState, readOverview, type OverviewData } from './schema.ts'
import type { OverviewFilters } from './OverviewPage.tsx'
import { createWxFlows, type WxFlows } from './flows.ts'
import { initialWorkbenchUi, workbenchReducer, POLL_MS, type AccountRow, type LoadState, type SingleCollectRecord, type TabItem, type TabValue, type ToastState } from './workbench-ui.ts'
import type { WorkbenchPageProps } from './WorkbenchPage.tsx'

/** collect.status 的 runningAccountIds → string[]（防御：非字符串项丢弃）。 */
function readRunningIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
}

/** collect.status 的 collect 字段 → 记录投影（非对象为 null）。 */
function readCollectRecord(value: unknown): SingleCollectRecord | null {
  return value !== null && typeof value === 'object' ? value as SingleCollectRecord : null
}

/**
 * 页面组合 hook：返回 JSX 组合层所需的全部状态与处理器（字段名与页面 JSX
 * 一致）。locale 座位经 props 注入，语言标签取官方快照的 active id。
 * @param props - 页面 props（t 与 locale 座位）。
 * @returns the page model.
 */
export function useWxWorkbenchPage(props: WorkbenchPageProps) {
  const t = props.t
  const locale = props.locale
  const active = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot).active
  const localeTag = localeTagOf(active)
  const kitTranslate = localeTag === 'zh' ? createKitTranslate(kitZh) : createKitTranslate(kitEn)
  const [ui, dispatch] = useReducer(workbenchReducer, undefined, initialWorkbenchUi)
  // flows 依赖的实时视图（flows 单例不重建，语言/选中经引用读取）。
  const latest = useRef({ t, selectedAccountId: ui.selectedAccountId })
  latest.current = { t, selectedAccountId: ui.selectedAccountId }
  const selectedIdRef = useRef<string | null>(null)
  useEffect(() => { selectedIdRef.current = ui.selectedAccountId }, [ui.selectedAccountId])
  const notify = useCallback((text: string, tone: 'success' | undefined = undefined): void => {
    dispatch({ type: 'notify', text, tone })
  }, [])
  /** @returns 账号列表是否刷新成功（stale 竞态让位不计失败）。 */
  const refreshAccounts = useCallback(async (): Promise<boolean> => {
    try {
      const res = await hostAction('accounts.list')
      const rows = Array.isArray(res.accounts) ? res.accounts as AccountRow[] : []
      dispatch({ type: 'accountsLoaded', rows, remoteOk: res.remoteOk !== false })
      return true
    } catch {
      dispatch({ type: 'accountsFailed' })
      return false
    }
  }, [])
  const flows: WxFlows = useMemo(() => createWxFlows({
    get t() { return latest.current.t },
    notify,
    refreshAccounts,
    refreshAccountStreams: (accountId) => {
      void loadSummary(accountId)
      void refreshAccounts()
    },
    onStarted: () => { dispatch({ type: 'started' }) },
    onInterrupted: view => { dispatch({ type: 'interrupted', view }) },
  }), [notify, refreshAccounts])
  const loginSnap = useSyncExternalStore(flows.login.subscribe, flows.login.get, flows.login.get)
  const collectSnap = useSyncExternalStore(flows.collect.subscribe, flows.collect.get, flows.collect.get)
  const batchSnap = useSyncExternalStore(flows.batch.subscribe, flows.batch.get, flows.batch.get)
  const worksSnap = useSyncExternalStore(flows.works.subscribe, flows.works.get, flows.works.get)

  // ---- 固定 last_7d 摘要流（页面级：独立序号 + 内存缓存 + 同账号刷新淡化） ----

  const [summary, setSummary] = useState<OverviewData | null>(null)
  const [summaryState, setSummaryState] = useState<LoadState>('loading')
  /** 同账号后台刷新摘要中（摘要卡淡化；不整块替换为骨架）。 */
  const [summaryRefreshing, setSummaryRefreshing] = useState(false)
  const summarySeqRef = useRef(0)
  /** 已落屏摘要所属账号（同账号重复刷新走 refreshing 淡化，跨账号不复用）。 */
  const summaryAccountRef = useRef('')
  /** summary 查询内存缓存：切回账号即时渲染，随后后台刷新。 */
  const summaryCacheRef = useRef(new Map<string, OverviewData>())
  /** @returns 固定 last_7d 摘要是否拉取成功（stale 竞态让位不计失败）。 */
  const loadSummary = useCallback(async (accountId: string): Promise<boolean> => {
    const seq = ++summarySeqRef.current
    const cached = summaryCacheRef.current.get(accountId)
    const resume = summaryAccountRef.current === accountId
    if (resume) {
      // 同账号重复刷新（手动刷新 / 采集完成）：保留已渲染值 + 淡化，不整块替换。
      setSummaryRefreshing(true)
    } else if (cached !== undefined && selectedIdRef.current === accountId) {
      // 切回账号：缓存即时渲染上次真实响应，随后后台刷新更新。
      summaryAccountRef.current = accountId
      setSummary(cached)
      setSummaryState('ready')
    } else {
      // 首次进入且无缓存：loading 骨架。
      summaryAccountRef.current = accountId
      setSummary(null)
      setSummaryState('loading')
    }
    try {
      const res = await hostAction('account.overview', { accountId, window: 'last_7d' })
      if (summarySeqRef.current !== seq || selectedIdRef.current !== accountId) return true
      const data = readOverview(res)
      summaryCacheRef.current.set(accountId, data)
      summaryAccountRef.current = accountId
      setSummary(data)
      setSummaryState('ready')
      return true
    } catch {
      if (summarySeqRef.current !== seq || selectedIdRef.current !== accountId) return true
      // 失败必须显式可见：清掉已渲染值进入 error 态，不保留陈旧摘要。
      summaryAccountRef.current = ''
      setSummary(null)
      setSummaryState('error')
      return false
    } finally {
      if (summarySeqRef.current === seq) setSummaryRefreshing(false)
    }
  }, [])

  // ---- 数据联动（原页 refreshAfterDataChange 口径：缓存失效 + 三路重拉） ----

  const refreshAfterDataChange = useCallback(async (accountId: string): Promise<void> => {
    flows.works.invalidateCache(accountId)
    await Promise.all([
      flows.works.load(accountId),
      loadSummary(accountId),
      refreshAccounts(),
    ])
  }, [flows, loadSummary, refreshAccounts])

  // ---- 批量采集轮询（machine 无内置定时器，页面持表） ----

  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopBatchPolling = useCallback((): void => {
    if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
  }, [])
  /** 批量采集轮询（页面内发起与挂载恢复共用同一套）：首跳立即查询，之后按固定间隔。 */
  const beginBatchPolling = useCallback((): void => {
    stopBatchPolling()
    const tick = (): void => {
      void flows.pollBatch().then(({ view, interrupted }) => {
        if (interrupted !== null) dispatch({ type: 'interrupted', view: interrupted })
        if (view === null) return
        flows.batch.beginPolling(view)
        if (view.ready) {
          stopBatchPolling()
          // 批量结束刷新当前账号数据与账号列表（会话状态 / 最近同步随之更新）。
          const current = latest.current.selectedAccountId
          if (current !== null) void refreshAfterDataChange(current)
        }
      }).catch(() => undefined)
    }
    // 首跳立即查询，之后按固定间隔轮询。
    void tick()
    batchPollRef.current = setInterval(tick, POLL_MS)
  }, [flows, refreshAfterDataChange, stopBatchPolling])

  const checkBrowser = useCallback((): void => {
    dispatch({ type: 'browser', state: 'loading' })
    hostAction('browser.status').then(res => {
      dispatch({ type: 'browser', state: readBrowserState(res) })
    }).catch(() => { dispatch({ type: 'browser', state: 'api_error' }) })
  }, [])
  useEffect(() => { checkBrowser() }, [checkBrowser])

  // ---- 作品列表（服务端排序 + 分页）/ 摘要的账号分派 ----
  // machine 缓存键 = 账号|排序|页码；命中缓存即时渲染上次真实响应再后台刷新；
  // 未命中时跨账号清空进 loading，同账号保留当前行只标记在途。过期响应按
  // 序号 + 查询键守卫整体丢弃。切换账号回第 1 页（排序态保留）。

  /** 当前页码状态所属账号：切账号回第 1 页（排序态保留）的判定基准。 */
  const worksPageAccountRef = useRef('')
  useEffect(() => {
    if (ui.selectedAccountId === null) return
    void loadSummary(ui.selectedAccountId)
    if (ui.tab === 'works') {
      if (worksPageAccountRef.current !== ui.selectedAccountId) {
        worksPageAccountRef.current = ui.selectedAccountId
        dispatch({ type: 'worksPage', page: 1 })
        void flows.works.load(ui.selectedAccountId, { page: 1 })
        return
      }
      void flows.works.load(ui.selectedAccountId)
    }
  }, [flows, loadSummary, ui.selectedAccountId, ui.tab])

  // ---- 登录流入口 ----

  const beginLogin = (): void => {
    void flows.login.begin().catch((error: unknown) => {
      notify(error instanceof Error ? error.message : t('error.default'))
    })
  }

  // ---- 单账号采集入口（发起路；machine 内乐观运行态 + 按账号轮询） ----

  /** 发起账号的乐观登记（点击 → collect.start 回执窗口）：选中驱动路同账号让位。 */
  const collectClaimRef = useRef('')
  const startCollect = (accountId: string): void => {
    if (accountId === '') return
    collectClaimRef.current = accountId
    void flows.startCollect(accountId).finally(() => { collectClaimRef.current = '' })
  }
  const cancelCollect = useCallback((accountId: string): void => {
    void flows.collect.cancel(accountId).catch(() => undefined)
  }, [flows])

  // ---- 全账号采集入口 ----

  const startBatch = (): void => {
    void flows.batch.start().then(() => { beginBatchPolling() }).catch((error: unknown) => {
      // 任何异步失败都必须清掉乐观投影，否则面板停在「采集中」且宿主无批量状态可纠正。
      stopBatchPolling()
      notify(`${t('batch.startFailed')}：${reasonText(error instanceof Error ? error.message : 'unknown', t)}`)
    })
  }
  const cancelBatch = useCallback((): void => {
    void flows.batch.cancel().then(() => {
      // 取消回执后立即读一次批量状态（当前账号 settle 后才 finished），不等下一轮询周期。
      return flows.pollBatch()
    }).then(({ view }) => {
      if (view !== null) flows.batch.beginPolling(view)
    }).catch(() => undefined)
  }, [flows])

  // ---- 选中驱动的单账号轮询（批量 / 并发运行中，选中另一运行中账号的第二路；
  // 停表语义 page 持有，发起/恢复路目标经 flows.isMainPolling 互斥） ----

  const selectedPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 选中驱动轮询的目标账号（与发起/恢复路目标互不覆盖）。 */
  const selectedPollAccountRef = useRef('')
  /** 停掉选中驱动轮询，并清掉属于其目标账号的运行中记录（面板不再显示该账号进度）。 */
  const stopSelectedPolling = useCallback((): void => {
    if (selectedPollRef.current !== null) { clearInterval(selectedPollRef.current); selectedPollRef.current = null }
    const target = selectedPollAccountRef.current
    selectedPollAccountRef.current = ''
    if (target !== '') {
      dispatch({ type: 'selectedRecord', record: null })
    }
  }, [])

  /**
   * 选中驱动的单账号采集轮询：选中账号属于运行中集合且不在发起/恢复路目标上时
   * 按该账号另起一路查询，作品面板显示其实时进度。终态一次性收尾：清该账号
   * 记录、仍被选中时刷新一次该账号数据；不弹 toast（批量内部账号的结果由批量
   * 面板汇总）。宿主丢失运行记录（busy=false 且无投影）时停表让位。
   * @param accountId - 选中且运行中的账号。
   */
  const beginSelectedPolling = useCallback((accountId: string): void => {
    stopSelectedPolling()
    selectedPollAccountRef.current = accountId
    let settled = false
    const tick = (): void => {
      void hostAction('collect.status', { accountId }).then(statusRes => {
        // 响应到达时选中路已换目标或已停表：过期响应整体丢弃，不得停掉新目标
        // 的轮询、不得清掉它的进度。
        if (selectedPollAccountRef.current !== accountId) return
        // 运行中集合以响应为准（发起/恢复路与选中路都可更新）。
        dispatch({ type: 'runningIds', ids: readRunningIds(statusRes.runningAccountIds) })
        const record = readCollectRecord(statusRes.collect)
        if (selectedIdRef.current === accountId && record !== null && record.status === 'running') {
          dispatch({ type: 'selectedRecord', record })
        }
        if (settled) return
        if (record !== null && record.status !== 'running') {
          // 该账号一次性终态收尾：清记录；仍被选中时刷新一次该账号数据。
          settled = true
          stopSelectedPolling()
          if (selectedIdRef.current === accountId) void refreshAfterDataChange(accountId)
        } else if (record === null && statusRes.busy !== true) {
          settled = true
          stopSelectedPolling()
        }
      }).catch(() => undefined)
    }
    // 首跳立即查询，之后按固定间隔轮询。
    void tick()
    selectedPollRef.current = setInterval(tick, POLL_MS)
  }, [refreshAfterDataChange, stopSelectedPolling])

  // ---- 挂载恢复：Host 侧采集与批量在页面卸载期间照常运行，重新挂载时等账号
  // 列表收敛（选中账号确定）后并行三路查询，恢复运行态与轮询；恢复响应到达
  // 前用户已发起时结果丢弃（machine 恢复代次）。挂载时不重放终态 ----

  const restoreDoneRef = useRef(false)
  useEffect(() => {
    if (restoreDoneRef.current) return
    if (ui.accountsState === 'loading') return
    restoreDoneRef.current = true
    void flows.restoreCollect(selectedIdRef.current ?? '')
    void flows.restoreBatch().then(({ view, interrupted }) => {
      if (interrupted !== null) dispatch({ type: 'interrupted', view: interrupted })
      if (view === null) return
      if (view.phase === 'probing' || view.phase === 'collecting' || view.phase === 'stopping' || view.phase === 'finished') {
        flows.batch.restore(view)
        if (view.phase !== 'finished') beginBatchPolling()
      }
    }).catch(() => undefined)
  }, [beginBatchPolling, flows, ui.accountsState])

  // ---- 刷新（作品数据页工具栏）：三路真实结果聚合，部分失败明确指出失败路 ----

  const refreshAll = (accountId: string): void => {
    if (accountId === '') return
    dispatch({ type: 'refreshStart' })
    void (async () => {
      // works / loadSummary / refreshAccounts 内部吞错并返回真实成功标志，
      // 靠 reject 判断会把失败报成成功。
      const results = await Promise.all([
        flows.works.load(accountId),
        loadSummary(accountId),
        refreshAccounts(),
      ])
      const failed = [
        results[0] ? null : 'works',
        results[1] ? null : 'overview',
        results[2] ? null : 'accounts',
      ].filter((part): part is 'works' | 'overview' | 'accounts' => part !== null)
      // 成功不提示（按钮恢复即足够反馈）；只有失败才说明白。
      dispatch({ type: 'refreshDone', failedParts: failed })
    })()
  }

  // ---- 数据流入口转发与作品翻页/排序镜像 ----

  const setTab = (value: TabValue): void => { dispatch({ type: 'selectTab', value }) }
  /** @returns works 是否拉取成功（machine 序号守卫让位不计失败）。 */
  const loadWorks = (accountId: string): Promise<boolean> => flows.works.load(accountId)
  /** 表头排序：发起新查询并回第 1 页（三态循环由 nextSortState 计算）。 */
  const handleWorksSortChange = (next: SortState): void => {
    dispatch({ type: 'worksSort', sort: next })
    dispatch({ type: 'worksPage', page: 1 })
    const accountId = ui.selectedAccountId
    if (accountId !== null) void flows.works.load(accountId, { page: 1, sort: next })
  }
  /** 翻页：只改 offset，排序不变。 */
  const handleWorksPageChange = (page: number): void => {
    dispatch({ type: 'worksPage', page })
    const accountId = ui.selectedAccountId
    if (accountId !== null) void flows.works.load(accountId, { page })
  }
  const setToast = (_toast: ToastState | null): void => { dispatch({ type: 'toastDone' }) }
  const setOverviewFilters = (filters: OverviewFilters): void => { dispatch({ type: 'filters', filters }) }
  const setSelectedAccountId = (accountId: string | null): void => { dispatch({ type: 'selectAccount', accountId }) }
  const setBannerDismissed = (_dismissed: boolean): void => { dispatch({ type: 'bannerDismissed' }) }

  // ---- 派生 ----

  const {
    tab, browser, accounts, remoteOk, accountsState, selectedAccountId, worksSort, worksPage,
    overviewFilters, interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
  } = ui
  const loginActive = loginSnap.login !== null
  const machineRecord = collectSnap.record
  // 乐观启动/轮询在途均投影为 running；面板只显示选中账号的发起/恢复路记录。
  const collectRecord = machineRecord !== null && machineRecord.status === 'running'
    && machineRecord.accountId !== null && machineRecord.accountId === selectedAccountId
    ? machineRecord
    : ui.selectedRecord
  const collectStartReason = collectSnap.startReason
  const batch = batchSnap.batch
  const batchRunningIds = batch !== null && batch.ready !== true && batch.phase !== 'finished' ? batch.runningAccountIds : []
  // 账号栏状态点：选中驱动路响应投影 ∪ 发起/恢复路 machine 集合 ∪ 批量运行中集合。
  const collectingIds = [...new Set([...ui.runningIds, ...collectSnap.runningAccountIds, ...batchRunningIds])]
  /** 任一账号采集运行中（宿主互斥的提前反馈；按钮禁用与账号栏锁定的数据源）。 */
  const collectBusy = collectingIds.length > 0
  /** 选中账号是否在运行中集合（选中驱动轮询的开关；布尔依赖避免数组依赖重跑）。 */
  const selectedRunning = selectedAccountId !== null && collectingIds.includes(selectedAccountId)

  // 选中驱动的轮询随 [选中账号, 选中账号是否运行中] 管理：批量运行中切到运行中
  // 的账号另起一路按账号轮询（运行中集合里随后出现选中账号同样触发）；切到
  // 未运行的账号停表并清掉上一选中账号的记录。发起/恢复账号的那一路
  // （machine 按账号轮询）不因切换选中停止或改目标；发起回执窗口内的账号由
  // collectClaimRef 让位，同一时刻至多两路单账号轮询加一路批量轮询。
  useEffect(() => {
    if (selectedAccountId === null || !selectedRunning) {
      stopSelectedPolling()
      return undefined
    }
    // 发起/恢复路已在该账号上轮询（或发起回执在途）：不重复起。
    if (collectClaimRef.current === selectedAccountId || flows.isMainPolling(selectedAccountId)) return undefined
    if (selectedPollRef.current !== null && selectedPollAccountRef.current === selectedAccountId) return undefined
    beginSelectedPolling(selectedAccountId)
    return stopSelectedPolling
  }, [beginSelectedPolling, flows, selectedAccountId, selectedRunning, stopSelectedPolling])

  const browserBlocking = browser === 'chrome_missing' || browser === 'driver_missing'
  const activeAccountId = selectedAccountId
    ?? accounts.find(row => row.deleteState !== 'remote_deleted')?.accountId
    ?? ''
  const selectedAccount = accounts.find(row => row.accountId === activeAccountId) ?? null
  const works = worksSnap.rows
  const worksState = worksSnap.loadState
  const worksTotal = worksSnap.total
  const worksLatestCollectedAt = worksSnap.summary?.latestCollectedAt ?? null
  const worksCompletionRate = worksSnap.summary?.completionRatePct ?? null
  /** works 请求在途（翻页 / 排序 / 后台刷新）：表格 aria-busy 与 Pager busy。 */
  const worksBusy = worksSnap.busy

  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'works', label: t('tab.works'), id: 'wx-tab-works', panelId: 'wx-panel-works' },
    { value: 'overview', label: t('tab.overview'), id: 'wx-tab-overview', panelId: 'wx-panel-overview' },
  ]
  const headerStatus: ReactNode = browser === 'loading'
    ? <span className={css.headerStatus}><StateDot state='ongoing' />{t('header.status.browserChecking')}</span>
    : browserBlocking
      ? <span className={css.headerStatus}><StateDot state='error' />{t('header.status.browserBlocked')}</span>
      : browser === 'api_error'
        ? <span className={css.headerStatus}><StateDot state='warning' />{t('header.status.serviceDegraded')}</span>
        : <span className={css.headerStatus}><StateDot state='done' />{t('header.status.browserReady')}</span>

  // ---- 挂载/卸载（放末尾以便清理引用全部就绪） ----

  useEffect(() => {
    void refreshAccounts()
    return () => {
      flows.login.stop()
      flows.collect.stop()
      flows.batch.stop()
      stopBatchPolling()
      stopSelectedPolling()
    }
  }, [flows, refreshAccounts, stopBatchPolling, stopSelectedPolling])

  return {
    t, localeTag, kitTranslate,
    tab, setTab, browser, accounts, remoteOk, accountsState, selectedAccountId, selectedAccount, activeAccountId,
    worksSort, worksPage, overviewFilters, interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
    loginActive, collectRecord, collectStartReason, batch, collectingIds, collectBusy,
    browserBlocking, works, worksState, worksTotal, worksLatestCollectedAt, worksCompletionRate, worksBusy,
    summary, summaryState, summaryRefreshing,
    tabs, headerStatus,
    beginLogin, startCollect, cancelCollect, startBatch, cancelBatch,
    loadWorks, loadSummary, handleWorksSortChange, handleWorksPageChange, refreshAll, refreshAccounts, notify,
    setToast, setOverviewFilters, setSelectedAccountId, setBannerDismissed,
  }
}
