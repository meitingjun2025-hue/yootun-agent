/**
 * 视频号工作台中央面板：browser.status 五态、登录流、账号选择与两个数据页
 * tab（作品数据 / 账号总览，对齐旧工作台顶级信息架构）。作品数据页为左侧
 * 账号管理栏 + 右侧作品面板的两列布局；账号总览页隐藏账号栏、全宽三段。
 * 单账号采集进度在作品工具栏按钮下方就地呈现；全账号采集面板在账号管理栏。
 * 数据页由 WorksPanel / OverviewPage 承担，本组件持有共享数据与采集编排；
 * 作品 / 摘要查询带内存缓存（切回账号即时渲染上次真实响应，随后后台刷新）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { SegmentedTabs, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createKitTranslate, DataState, KitLocaleProvider, PluginHeader, PluginPageShell,
} from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { zh as wxZh } from './locales.ts'
import {
  readBatchStatus, readBrowserState, readOverview, readWorkRows,
  type BatchStatusView, type BrowserState, type OverviewData, type WorkRow,
} from './schema.ts'
import { AccountSidebar } from './AccountSidebar.tsx'
import { DEFAULT_OVERVIEW_FILTERS, OverviewPage, type OverviewFilters } from './OverviewPage.tsx'
import { WorksPanel } from './WorksPanel.tsx'
import { DEFAULT_SORT_STATE, type SortState } from './works-format.ts'

export type { Translate } from './format.ts'

export interface AccountRow {
  accountId: string
  nickname: string | null
  avatar: string | null
  feedCount: number | null
  followerTotalCount: number | null
  sessionStatus: string
  sessionCheckedAt: string | null
  lastCollectedAt: string | null
  deleteState: string
  isPending: boolean
  hasStorageState: boolean
  localCredentialsMissing?: boolean
}

/** 登录流状态（key 是 account.beginLogin 返回的 loginKey）。 */
interface LoginCardState { key: string; state: string; reason: string | null }

/** 单账号采集状态投影（collect.status 的 collect 字段）。 */
export interface SingleCollectRecord {
  accountId: string | null
  status: string | null
  progress: Record<string, unknown> | null
  error: string | null
}

/** 页面级 toast：短暂成功 / 失败反馈（进度与刷新提示在各自就地位置）。 */
interface ToastState { text: string; tone: 'success' | undefined; seq: number }

export interface WorkbenchPageProps { t: Translate }

type TabValue = 'works' | 'overview'
type LoadState = 'loading' | 'ready' | 'error'
type WorksLoadState = 'loading' | 'ready' | 'error' | 'partial'

interface TabItem { value: TabValue; label: string; id: string; panelId: string }

const POLL_MS = 1200

/** locale 标签（数值/日期格式化用）：词典逐键不同，逐键等价判定可靠。 */
export function localeTagOf(t: Translate): string {
  return t('panel') === wxZh.panel ? 'zh' : 'en'
}

/** 页面组件：全量接线 Host API 与两 tab 布局。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<TabValue>('works')
  const [browser, setBrowser] = useState<BrowserState>('loading')
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [remoteOk, setRemoteOk] = useState(true)
  const [accountsState, setAccountsState] = useState<LoadState>('loading')
  const [login, setLogin] = useState<LoginCardState | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [works, setWorks] = useState<WorkRow[]>([])
  const [worksState, setWorksState] = useState<WorksLoadState>('loading')
  const [worksSort, setWorksSort] = useState<SortState>(DEFAULT_SORT_STATE)
  const [summary, setSummary] = useState<OverviewData | null>(null)
  const [summaryState, setSummaryState] = useState<LoadState>('loading')
  /** 同账号后台刷新摘要中（摘要卡淡化；不整块替换为骨架）。 */
  const [summaryRefreshing, setSummaryRefreshing] = useState(false)
  const [collectBusy, setCollectBusy] = useState(false)
  const [collectRecord, setCollectRecord] = useState<SingleCollectRecord | null>(null)
  const [collectStartReason, setCollectStartReason] = useState<string | null>(null)
  const [batch, setBatch] = useState<BatchStatusView | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshFailedParts, setRefreshFailedParts] = useState<string[]>([])
  /** 账号总览筛选（页面级持有，切 tab 保留；表格行选中同走这套筛选）。 */
  const [overviewFilters, setOverviewFilters] = useState<OverviewFilters>(DEFAULT_OVERVIEW_FILTERS)
  const [toast, setToast] = useState<ToastState | null>(null)

  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const collectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const worksSeqRef = useRef(0)
  /** 已落屏作品行所属账号：partial 保留只对同账号成立，跨账号不得复用。 */
  const worksRowsRef = useRef<{ accountId: string; rows: WorkRow[] }>({ accountId: '', rows: [] })
  /** works 查询内存缓存（账号 → 最近一次真实响应）：切回账号即时渲染，随后后台刷新。 */
  const worksCacheRef = useRef(new Map<string, WorkRow[]>())
  const summarySeqRef = useRef(0)
  /** 已落屏摘要所属账号（同账号重复刷新走 refreshing 淡化，跨账号不复用）。 */
  const summaryAccountRef = useRef<string>('')
  /** summary 查询内存缓存：切回账号即时渲染，随后后台刷新。 */
  const summaryCacheRef = useRef(new Map<string, OverviewData>())
  const selectedIdRef = useRef<string | null>(null)
  const toastSeqRef = useRef(0)
  useEffect(() => { selectedIdRef.current = selectedAccountId }, [selectedAccountId])

  const kitTranslate = localeTagOf(t) === 'zh' ? createKitTranslate(kitZh) : createKitTranslate(kitEn)

  const notify = useCallback((text: string, tone: 'success' | undefined = undefined): void => {
    toastSeqRef.current += 1
    setToast({ text, tone, seq: toastSeqRef.current })
  }, [])

  /** @returns 账号列表是否刷新成功（stale 竞态让位不计失败）。 */
  const refreshAccounts = useCallback(async (): Promise<boolean> => {
    try {
      const res = await hostAction('accounts.list')
      const rows = Array.isArray(res.accounts) ? res.accounts as AccountRow[] : []
      setAccounts(rows)
      setRemoteOk(res.remoteOk !== false)
      setAccountsState('ready')
      setSelectedAccountId(current => {
        if (current !== null && rows.some(row => row.accountId === current)) return current
        const firstUsable = rows.find(row => row.deleteState !== 'remote_deleted')
        return firstUsable ? firstUsable.accountId : null
      })
      return true
    } catch {
      setAccountsState('error')
      return false
    }
  }, [])

  useEffect(() => {
    void refreshAccounts()
    return () => {
      for (const ref of [loginPollRef, collectPollRef, batchPollRef]) {
        if (ref.current !== null) { clearInterval(ref.current); ref.current = null }
      }
    }
  }, [refreshAccounts])

  const checkBrowser = useCallback((): void => {
    setBrowser('loading')
    hostAction('browser.status').then(res => {
      setBrowser(readBrowserState(res))
    }).catch(() => { setBrowser('api_error') })
  }, [])

  useEffect(() => { checkBrowser() }, [checkBrowser])

  // ---- 作品列表 / 固定 last_7d 摘要（缓存即时渲染 + 后台刷新；代次 + 账号双守卫）----
  // 查询只带 accountId（排序全在客户端完成），切换账号时命中缓存立即渲染上次
  // 真实响应，再发起远端刷新——不再等待一次远端往返才出数据。

  /** @returns works 是否拉取成功（stale 竞态让位不计失败）。 */
  const loadWorks = useCallback(async (accountId: string): Promise<boolean> => {
    const seq = ++worksSeqRef.current
    const cached = worksCacheRef.current.get(accountId)
    const resume = worksRowsRef.current.accountId === accountId
    if (cached !== undefined && selectedIdRef.current === accountId) {
      // 缓存即时渲染：真实历史响应，随后后台刷新更新。
      worksRowsRef.current = { accountId, rows: cached }
      setWorks(cached)
      setWorksState('ready')
    } else if (!resume) {
      worksRowsRef.current = { accountId: '', rows: [] }
      setWorks([])
      setWorksState('loading')
    }
    try {
      const res = await hostAction('works.list', { accountId })
      // 守卫：序号最新 + 响应账号仍是当前选中账号（采集回调按采集账号刷新，
      // 与当前选中无关，账号不比对会把旧账号数据写进新账号视图）。
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId) return true
      const rows = readWorkRows(res)
      worksCacheRef.current.set(accountId, rows)
      worksRowsRef.current = { accountId, rows }
      setWorks(rows)
      setWorksState('ready')
      return true
    } catch {
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId) return true
      // 失败保留已加载数据仅限同一账号：跨账号旧行不复用（直接 error 态）。
      const sameAccountRows = worksRowsRef.current.accountId === accountId && worksRowsRef.current.rows.length > 0
      setWorksState(sameAccountRows ? 'partial' : 'error')
      return false
    }
  }, [])

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

  // 账号 / tab 变化统一分派：加载初态由 loadWorks / loadSummary 内部按缓存与
  // resume 判定管理（跨账号不复用旧数据；缓存命中即时渲染）。
  useEffect(() => {
    if (selectedAccountId === null) return
    void loadSummary(selectedAccountId)
    if (tab === 'works') void loadWorks(selectedAccountId)
  }, [selectedAccountId, tab, loadSummary, loadWorks])

  // ---- 登录流 ----

  const stopLoginPolling = useCallback((): void => {
    if (loginPollRef.current !== null) { clearInterval(loginPollRef.current); loginPollRef.current = null }
  }, [])

  const beginLoginPolling = useCallback((key: string): void => {
    stopLoginPolling()
    const tick = (): void => {
      void hostAction('account.loginStatus', { accountId: key }).then(res => {
        const state = String(res.state ?? 'idle')
        if (state === 'ok') {
          stopLoginPolling()
          setLogin(null)
          notify(res.reason !== undefined && res.reason !== null ? t('login.savedFailed') : t('login.state.ok'), 'success')
          void refreshAccounts()
        } else if (state === 'timeout' || state === 'failed') {
          // 终态必须停轮询并恢复按钮，否则「添加账号」永远禁用。
          stopLoginPolling()
          setLogin(null)
          notify(state === 'timeout' ? t('login.timeoutToast') : t('login.failedToast'))
        } else if (state === 'idle') {
          stopLoginPolling()
          setLogin(null)
        } else {
          setLogin({ key, state, reason: res.reason !== undefined && res.reason !== null ? String(res.reason) : null })
        }
      }).catch(() => undefined)
    }
    // 首跳立即查询，之后按固定间隔轮询（长动作在宿主异步执行、页面轮询）。
    void tick()
    loginPollRef.current = setInterval(tick, POLL_MS)
  }, [notify, refreshAccounts, stopLoginPolling, t])

  const beginLogin = useCallback((): void => {
    void hostAction('account.beginLogin', {}).then(res => {
      if (typeof res.loginKey === 'string') {
        setLogin({ key: res.loginKey, state: 'waiting_qr', reason: null })
        beginLoginPolling(res.loginKey)
      }
    }).catch(error => {
      notify(error instanceof Error ? error.message : t('error.default'))
    })
  }, [beginLoginPolling, notify, t])

  // ---- 单账号采集（乐观运行态；工具栏进度行数据源）----

  const refreshAfterDataChange = useCallback(async (accountId: string): Promise<void> => {
    await Promise.all([
      loadWorks(accountId),
      loadSummary(accountId),
      refreshAccounts(),
    ])
  }, [loadSummary, loadWorks, refreshAccounts])

  const stopCollectPolling = useCallback((): void => {
    if (collectPollRef.current !== null) { clearInterval(collectPollRef.current); collectPollRef.current = null }
  }, [])

  const startCollect = useCallback((accountId: string): void => {
    if (accountId === '') return
    setCollectStartReason(null)
    // 乐观投影：点击瞬间进入「采集中…」，不等宿主同步链路（实测 2-3 秒）返回。
    setCollectBusy(true)
    setCollectRecord({ accountId, status: 'running', progress: null, error: null })
    void hostAction('collect.start', { accountId, newAttempt: true }).then(res => {
      if (res.started !== true) {
        // started:false 不进入轮询、不置 running：就地呈现稳定 reason。
        setCollectBusy(false)
        setCollectRecord(null)
        setCollectStartReason(typeof res.reason === 'string' ? res.reason : 'unknown')
        return
      }
      stopCollectPolling()
      const tick = (): void => {
        void hostAction('collect.status').then(statusRes => {
          const record = statusRes.collect !== null && typeof statusRes.collect === 'object'
            ? statusRes.collect as SingleCollectRecord
            : null
          if (record !== null) setCollectRecord(record)
          if (statusRes.busy !== true) {
            stopCollectPolling()
            setCollectBusy(false)
            const final = record
            if (final === null) {
              // 宿主重启/插件重载会丢 collectRecord：busy=false 且无投影时清掉
              // 本地乐观 running 态，避免「采集中…」永不清除。
              setCollectRecord(null)
              notify(t('works.collectLost'))
            } else if (final.status === 'failed') {
              notify(final.error !== null ? `${t('works.collectFailed')}：${reasonText(final.error, t)}` : t('works.collectFailed'))
            }
            void refreshAfterDataChange(final?.accountId ?? accountId)
          }
        }).catch(() => undefined)
      }
      // 首跳立即查询，之后按固定间隔轮询。
      void tick()
      collectPollRef.current = setInterval(tick, POLL_MS)
    }).catch(error => {
      stopCollectPolling()
      setCollectBusy(false)
      setCollectRecord(null)
      setCollectStartReason(error instanceof Error ? error.message : 'unknown')
    })
  }, [notify, refreshAfterDataChange, stopCollectPolling, t])

  const cancelCollect = useCallback((accountId: string): void => {
    void hostAction('collect.cancel', { accountId }).catch(() => undefined)
  }, [])

  // ---- 全账号采集（账号管理栏批量面板数据源）----

  const stopBatchPolling = useCallback((): void => {
    if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
  }, [])

  const startBatch = useCallback((): void => {
    // 与单账号同理：点击瞬间先挂最小运行投影，批量面板立刻显示进行中。
    setBatch(readBatchStatus({ ready: false, phase: 'probing', items: [], total: 0, currentAccountIndex: 0 }))
    void hostAction('collectAll.start', {}).then(res => {
      if (res.started !== true) {
        setBatch(null)
        notify(`${t('batch.startFailed')}：${reasonText(typeof res.reason === 'string' ? res.reason : 'unknown', t)}`)
        return
      }
      stopBatchPolling()
      const tick = (): void => {
        void hostAction('collectAll.status').then(batchRes => {
          const next = readBatchStatus(batchRes)
          setBatch(next)
          if (next.ready) {
            stopBatchPolling()
            // 批量结束刷新当前账号数据与账号列表（会话状态 / 最近同步随之更新）。
            const current = selectedIdRef.current
            if (current !== null) void refreshAfterDataChange(current)
          }
        }).catch(() => undefined)
      }
      // 首跳立即查询，之后按固定间隔轮询。
      void tick()
      batchPollRef.current = setInterval(tick, POLL_MS)
    }).catch(error => {
      // 任何异步失败都必须清掉乐观投影，否则面板停在「采集中」且宿主无批量状态可纠正。
      stopBatchPolling()
      setBatch(null)
      notify(`${t('batch.startFailed')}：${reasonText(error instanceof Error ? error.message : 'unknown', t)}`)
    })
  }, [notify, refreshAfterDataChange, stopBatchPolling, t])

  const cancelBatch = useCallback((): void => {
    void hostAction('collectAll.cancel', {}).then(() => {
      // 取消回执后立即读一次批量状态（当前账号 settle 后才 finished），
      // 不等下一轮询周期。
      return hostAction('collectAll.status')
    }).then(batchRes => {
      setBatch(readBatchStatus(batchRes))
    }).catch(() => undefined)
  }, [])

  // ---- 刷新（作品数据页工具栏）：三路真实结果聚合，部分失败明确指出失败路 ----

  const refreshAll = useCallback((accountId: string): void => {
    if (accountId === '') return
    setRefreshing(true)
    setRefreshFailedParts([])
    void (async () => {
      // loadWorks / loadSummary / refreshAccounts 内部吞错并返回真实成功标志，
      // 靠 reject 判断会把失败报成成功。
      const results = await Promise.all([
        loadWorks(accountId),
        loadSummary(accountId),
        refreshAccounts(),
      ])
      const failed = [
        results[0] ? null : 'works',
        results[1] ? null : 'overview',
        results[2] ? null : 'accounts',
      ].filter((part): part is 'works' | 'overview' | 'accounts' => part !== null)
      // 成功不提示（按钮恢复即足够反馈）；只有失败才说明白。
      if (failed.length > 0) setRefreshFailedParts(failed)
      setRefreshing(false)
    })()
  }, [loadSummary, loadWorks, refreshAccounts])

  const activeAccountId = selectedAccountId
    ?? accounts.find(row => row.deleteState !== 'remote_deleted')?.accountId
    ?? ''
  const selectedAccount = accounts.find(row => row.accountId === activeAccountId) ?? null
  const browserBlocking = browser === 'chrome_missing' || browser === 'driver_missing'
  const loginActive = login !== null && login.state !== 'ok' && login.state !== 'timeout' && login.state !== 'failed' && login.state !== 'idle'

  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'works', label: t('tab.works'), id: 'wx-tab-works', panelId: 'wx-panel-works' },
    { value: 'overview', label: t('tab.overview'), id: 'wx-tab-overview', panelId: 'wx-panel-overview' },
  ]

  const headerStatus = browser === 'loading'
    ? <span className={css.headerStatus}><StateDot state='ongoing' />{t('header.status.browserChecking')}</span>
    : browserBlocking
      ? <span className={css.headerStatus}><StateDot state='error' />{t('header.status.browserBlocked')}</span>
      : browser === 'api_error'
        ? <span className={css.headerStatus}><StateDot state='warning' />{t('header.status.serviceDegraded')}</span>
        : <span className={css.headerStatus}><StateDot state='done' />{t('header.status.browserReady')}</span>

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={remoteOk ? t('panel.subtitle') : t('state.partial')}
            status={headerStatus}
          />
        )}
      >
        <div className={css.tabs}>
          <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('panel')} />
        </div>

        <DataState
          state={accountsState === 'ready' || (accountsState === 'error' && accounts.length > 0) ? 'ready' : accountsState}
          shape='rows'
          onRetry={() => { void refreshAccounts() }}
        >
          <div id='wx-panel-body' role='tabpanel' aria-label={t('panel')}>
            {tab === 'works' ? (
              <div className={css.worksLayout}>
                <AccountSidebar
                  t={t}
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  browserBlocked={browserBlocking}
                  loginActive={loginActive}
                  collectBusy={collectBusy}
                  batch={batch}
                  onSelect={setSelectedAccountId}
                  onCollectAll={startBatch}
                  onCancelBatch={cancelBatch}
                  onRelogin={beginLogin}
                  onAddAccount={beginLogin}
                  onAccountsChanged={refreshAccounts}
                  onNotice={text => { notify(text) }}
                />
                <section className={css.worksPanel} aria-label={t('tab.works')}>
                  <WorksPanel
                    t={t}
                    localeTag={localeTagOf(t)}
                    accountId={activeAccountId}
                    account={selectedAccount}
                    works={works}
                    worksState={worksState}
                    worksSort={worksSort}
                    onSortChange={setWorksSort}
                    onRetryWorks={() => { if (activeAccountId !== '') void loadWorks(activeAccountId) }}
                    summary={summary}
                    summaryState={summaryState}
                    summaryRefreshing={summaryRefreshing}
                    onRetrySummary={() => { if (activeAccountId !== '') void loadSummary(activeAccountId) }}
                    collectBusy={collectBusy}
                    collectRecord={collectRecord}
                    collectStartReason={collectStartReason}
                    onStartCollect={startCollect}
                    onCancelCollect={cancelCollect}
                    batchRunning={batch !== null && batch.ready !== true && batch.phase !== 'finished'}
                    refreshing={refreshing}
                    refreshFailedParts={refreshFailedParts}
                    onRefresh={() => { refreshAll(activeAccountId) }}
                    browserBlocked={browserBlocking}
                  />
                </section>
              </div>
            ) : (
              <OverviewPage
                t={t}
                localeTag={localeTagOf(t)}
                accounts={accounts}
                filters={overviewFilters}
                onFiltersChange={setOverviewFilters}
              />
            )}
          </div>
        </DataState>
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
