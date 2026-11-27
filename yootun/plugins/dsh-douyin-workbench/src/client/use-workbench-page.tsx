/**
 * 抖音工作台页面的组合 hook：UI 态 reducer（[workbench-ui.ts]）、四 machine
 * （[flows.ts]）的创建与订阅、挂载恢复/作品切号/批量轮询副作用、弹层与导出
 * （[use-workbench-modals.ts]）与布局派生值（tabs、headerStatus、rangeLabel）。
 * WorkbenchPage 只做 JSX 组合；数据流竞态守卫在 machine 里，本 hook 只做
 * 转发与镜像。
 * @module
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createKitTranslate } from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import css from './workbench.module.css'
import { localeTagOf, reasonText, type Translate, type WorkSortState } from './format.ts'
import { readAccounts, readBrowserState } from './schema.ts'
import { createDouyinFlows, type DouyinFlows } from './flows.ts'
import type { OverviewFilters } from './OverviewPage.tsx'
import { useWorkbenchModals } from './use-workbench-modals.ts'
import { groupOf, initialWorkbenchUi, subTabsOf, workbenchReducer, type GroupTabItem, type TabGroup, type TabValue, type ToastState } from './workbench-ui.ts'
import type { WorkbenchPageProps } from './WorkbenchPage.tsx'

/** 批量采集轮询间隔（与单账号采集一致）。 */
const COLLECT_POLL_MS = 1500

/** 顶级组的词典键（组标签文案）。 */
const GROUP_LABEL_KEYS: Record<TabGroup, Parameters<Translate>[0]> = {
  data: 'nav.group.data',
  create: 'nav.group.create',
  material: 'nav.group.material',
  report: 'nav.group.report',
}

/**
 * 页面组合 hook：返回 JSX 组合层所需的全部状态与处理器（字段名与页面 JSX
 * 一致）。locale 座位经 props 注入，语言标签取官方快照的 active id。
 * @param props - 页面 props（t 与 locale 座位）。
 * @returns the page model.
 */
export function useDouyinWorkbenchPage(props: WorkbenchPageProps) {
  const t = props.t
  const locale = props.locale
  const active = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot).active
  const localeTag = localeTagOf(active)
  const kitTranslate = localeTag === 'zh' ? createKitTranslate(kitZh) : createKitTranslate(kitEn)
  const [ui, dispatch] = useReducer(workbenchReducer, undefined, initialWorkbenchUi)
  // flows 依赖的实时视图（flows 单例不重建，语言/选中经引用读取）。
  const latest = useRef({ t, selectedAccountId: ui.selectedAccountId })
  latest.current = { t, selectedAccountId: ui.selectedAccountId }
  const notify = useCallback((text: string, tone: 'success' | undefined = undefined): void => {
    dispatch({ type: 'notify', text, tone })
  }, [])
  /** @returns 账号列表是否刷新成功（stale 竞态让位不计失败）。 */
  const refreshAccounts = useCallback(async (): Promise<boolean> => {
    try {
      const rows = readAccounts(await hostAction('accounts.list'))
      dispatch({ type: 'accountsLoaded', rows })
      return true
    } catch {
      dispatch({ type: 'accountsFailed' })
      return false
    }
  }, [])
  const flows: DouyinFlows = useMemo(() => createDouyinFlows({
    get t() { return latest.current.t },
    notify,
    refreshAccounts,
    onStarted: () => { dispatch({ type: 'started' }) },
    onInterrupted: view => { dispatch({ type: 'interrupted', view }) },
  }), [notify, refreshAccounts])
  const loginSnap = useSyncExternalStore(flows.login.subscribe, flows.login.get, flows.login.get)
  const collectSnap = useSyncExternalStore(flows.collect.subscribe, flows.collect.get, flows.collect.get)
  const batchSnap = useSyncExternalStore(flows.batch.subscribe, flows.batch.get, flows.batch.get)
  const worksSnap = useSyncExternalStore(flows.works.subscribe, flows.works.get, flows.works.get)
  const modals = useWorkbenchModals({
    t,
    notify,
    refreshAccounts,
    accounts: ui.accounts,
    selectedAccountId: ui.selectedAccountId,
    applyOverviewFilters: update => { dispatch({ type: 'filtersCalibrate', update }) },
  })

  // ---- 批量采集轮询（machine 无内置定时器，页面持表；单飞由 flows.pollBatch 单拍承担） ----

  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopBatchPolling = (): void => {
    if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
  }
  /** 批量采集轮询（页面发起与挂载恢复共用同一 tick 与终态收尾）。 */
  const beginBatchPolling = useCallback((): void => {
    stopBatchPolling()
    const tick = (): void => {
      void flows.pollBatch().then(({ view, interrupted }) => {
        if (interrupted !== null) dispatch({ type: 'interrupted', view: interrupted })
        if (view === null) return
        flows.batch.beginPolling(view)
        if (view.status !== null && view.status !== 'running') {
          stopBatchPolling()
          const current = latest.current.selectedAccountId
          if (current !== null) {
            flows.works.invalidateCache(current)
            void flows.works.load(current)
            void refreshAccounts()
          }
        }
      }).catch(() => undefined)
    }
    void tick()
    batchPollRef.current = setInterval(tick, COLLECT_POLL_MS)
  }, [flows, refreshAccounts])

  // ---- 数据流入口与作品翻页/排序（machine 已守卫竞态，这里只做转发与 UI 镜像） ----

  const selectTab = (value: TabValue): void => { dispatch({ type: 'selectTab', value }) }
  /** 点顶级组：组内重选回默认页，切回恢复该组上一次页面（T3/N3）。 */
  const selectGroup = (group: TabGroup): void => { dispatch({ type: 'selectGroup', group }) }
  /** 总览页进入单账号分析（侧栏账号卡与总览账号表「查看分析」共用）：同步选中。 */
  const openAccountAnalysis = (accountId: string): void => {
    dispatch({ type: 'selectAccount', accountId })
    dispatch({ type: 'analysis', accountId })
  }
  const beginLogin = (): void => {
    void flows.login.begin().catch((error: unknown) => {
      notify(error instanceof Error ? reasonText(error.message, t) : t('error.default'))
    })
  }
  const startCollect = (accountId: string): void => { void flows.collect.start(accountId) }
  const startBatch = (): void => {
    void flows.batch.start().then(() => { beginBatchPolling() }).catch((error: unknown) => {
      stopBatchPolling()
      notify(`${t('batch.startFailed')}：${reasonText(error instanceof Error ? error.message : 'collect_busy', t)}`)
    })
  }
  /** @returns works 是否拉取成功（machine 序号守卫让位不计失败）。 */
  const loadWorks = (accountId: string): Promise<boolean> => flows.works.load(accountId)
  /** 表头排序：回第 1 页并以新排序重拉（排序态保留到切号）。 */
  const changeWorksSort = (next: WorkSortState): void => {
    dispatch({ type: 'worksSort', sort: next })
    dispatch({ type: 'worksPage', page: 1 })
    const accountId = ui.selectedAccountId
    if (accountId !== null && accountId !== '') void flows.works.load(accountId, { page: 1, sort: next })
  }
  /** 翻页：只改 offset，排序不变。 */
  const changeWorksPage = (page: number): void => {
    dispatch({ type: 'worksPage', page })
    const accountId = ui.selectedAccountId
    if (accountId !== null && accountId !== '') void flows.works.load(accountId, { page })
  }
  /** 刷新（账号作品页工具栏）：works + accounts，失败分部提示。 */
  const refreshAll = (accountId: string): void => {
    if (accountId === '') return
    dispatch({ type: 'refreshStart' })
    void (async () => {
      const results = await Promise.all([flows.works.load(accountId), refreshAccounts()])
      const failed = [results[0] ? null : 'works', results[1] ? null : 'accounts']
        .filter((part): part is 'works' | 'accounts' => part !== null)
      dispatch({ type: 'refreshDone', failedParts: failed })
    })()
  }
  const setToast = (_toast: ToastState | null): void => { dispatch({ type: 'toastDone' }) }
  const setOverviewFilters = (filters: OverviewFilters): void => { dispatch({ type: 'filters', filters }) }
  const setSelectedAccountId = (accountId: string | null): void => { dispatch({ type: 'selectAccount', accountId }) }
  const setAnalysisAccountId = (accountId: string | null): void => { dispatch({ type: 'analysis', accountId }) }
  const setBreakdownPrefill = (url: string | null): void => { dispatch({ type: 'breakdownPrefill', url }) }
  const setBannerDismissed = (_dismissed: boolean): void => { dispatch({ type: 'bannerDismissed' }) }

  useEffect(() => {
    void refreshAccounts()
    void hostAction('browser.status').then(res => { dispatch({ type: 'browser', state: readBrowserState(res) }) }).catch(() => { dispatch({ type: 'browser', state: 'api_error' }) })
    return () => {
      flows.login.stop()
      flows.collect.stop()
      flows.batch.stop()
      stopBatchPolling()
    }
  }, [flows, refreshAccounts])

  // ---- 作品列表（切号回第 1 页排序保留：machine 缓存键=账号|排序|方向|页） ----

  useEffect(() => {
    if (ui.selectedAccountId === null) return
    if (ui.tab !== 'works') return
    const switched = flows.works.get().accountId !== ui.selectedAccountId
    if (switched) {
      dispatch({ type: 'worksPage', page: 1 })
      void flows.works.load(ui.selectedAccountId, { page: 1 })
      return
    }
    void flows.works.load(ui.selectedAccountId)
  }, [flows, ui.tab, ui.selectedAccountId])

  // ---- 挂载恢复：账号列表就绪且选中账号确定时触发一次（machine 内丢弃用户已发起） ----

  const restoreDoneRef = useRef(false)
  useEffect(() => {
    if (ui.selectedAccountId === null || restoreDoneRef.current) return
    restoreDoneRef.current = true
    void flows.restoreCollect(ui.selectedAccountId)
    void flows.restoreBatch().then(({ view }) => {
      if (view !== null && view.status === 'running') beginBatchPolling()
    }).catch(() => undefined)
  }, [beginBatchPolling, flows, ui.selectedAccountId])

  const {
    tab, browser, accounts, accountsState, selectedAccountId, worksSort, worksPage,
    overviewFilters, analysisAccountId, breakdownPrefill, visitedTabs,
    interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
  } = ui
  const loginActive = loginSnap.login !== null && loginSnap.login.status === 'waiting'
  const collectRecord = collectSnap.record
  // 乐观启动/轮询在途均投影为 running：collectBusy 与原页 setState 口径一致。
  const collectBusy = collectRecord !== null && collectRecord.status === 'running'
  const collectStartReason = collectSnap.startReason
  const batch = batchSnap.batch
  const batchRunning = batch !== null && batch.status === 'running'
  // 批量对采集入口的占用 = 运行中或挂载恢复确认在途。
  const batchBusy = batchRunning || batchSnap.recoveryPending
  // 账号栏「采集中」状态点数据源：单账号运行投影 + 批量运行中条目。
  const collectingAccountIds: string[] = []
  if (collectBusy && collectRecord !== null && collectRecord.accountId !== '') collectingAccountIds.push(collectRecord.accountId)
  if (batchRunning && batch !== null) {
    for (const item of batch.items) {
      if (item.status === 'running' && !collectingAccountIds.includes(item.accountId)) collectingAccountIds.push(item.accountId)
    }
  }
  const browserBlocking = browser === 'chrome_missing' || browser === 'driver_missing'
  const activeAccountId = selectedAccountId
    ?? accounts.find(row => row.deleteState !== 'remote_deleted')?.accountId
    ?? ''
  const selectedAccount = accounts.find(row => row.accountId === activeAccountId) ?? null
  const works = worksSnap.rows
  const worksState = worksSnap.loadState
  const worksTotal = worksSnap.total
  const worksBusy = worksSnap.busy
  const worksSummary = worksSnap.summary

  // ---- 导航分组派生：顶级 4 组 + 组内二级段；组由 tab 推导，不另存当前组 ----

  const group = groupOf(tab)
  const groupTabs: readonly [GroupTabItem, ...GroupTabItem[]] = [
    { value: 'data', label: t('nav.group.data'), id: 'dy-tab-data', panelId: 'dy-panel-body' },
    { value: 'create', label: t('nav.group.create'), id: 'dy-tab-create', panelId: 'dy-panel-body' },
    { value: 'material', label: t('nav.group.material'), id: 'dy-tab-material-group', panelId: 'dy-panel-body' },
    { value: 'report', label: t('nav.group.report'), id: 'dy-tab-report-group', panelId: 'dy-panel-body' },
  ]
  const subTabs = subTabsOf(group, page => t(`tab.${page}` as 'tab.overview'))
  const subLabel = t('nav.subLevel', { group: t(GROUP_LABEL_KEYS[group]) })
  // 页面容器由控制它的 tab 标注：多页组 = 选中的二级段；单页组 = 顶级组 tab。
  const panelLabelledBy = subTabs !== null ? `dy-tab-sub-${tab}` : groupTabs.find(item => item.value === group)?.id ?? 'dy-tab-data'
  const headerStatus: ReactNode = browser === 'loading'
    ? <span className={css.headerStatus}><StateDot state='ongoing' />{t('header.status.browserChecking')}</span>
    : browserBlocking
      ? <span className={css.headerStatus}><StateDot state='error' />{t('header.status.browserBlocked')}</span>
      : browser === 'api_error'
        ? <span className={css.headerStatus}><StateDot state='warning' />{t('header.status.serviceDegraded')}</span>
        : <span className={css.headerStatus}><StateDot state='done' />{t('header.status.browserReady')}</span>
  const rangeLabel = overviewFilters.window === 'custom'
    ? t('overview.range.custom', { from: overviewFilters.customFrom ?? '?', to: overviewFilters.customTo ?? '?' })
    : t(`overview.window.${overviewFilters.window}` as 'overview.window.30d')

  return {
    t, localeTag, kitTranslate,
    tab, browser, accounts, accountsState, selectedAccountId, selectedAccount, activeAccountId,
    worksSort, worksPage, overviewFilters, analysisAccountId, breakdownPrefill, visitedTabs,
    interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
    loginActive, collectRecord, collectBusy, collectStartReason, batch, batchBusy, collectingAccountIds,
    browserBlocking, works, worksState, worksTotal, worksBusy, worksSummary,
    headerStatus, rangeLabel,
    group, groupTabs, subTabs, subLabel, panelLabelledBy,
    selectTab, selectGroup, openAccountAnalysis, beginLogin, startCollect, startBatch, loadWorks, changeWorksSort, changeWorksPage,
    refreshAll, refreshAccounts, notify,
    setToast, setOverviewFilters, setSelectedAccountId, setAnalysisAccountId, setBreakdownPrefill, setBannerDismissed,
    ...modals,
  }
}
