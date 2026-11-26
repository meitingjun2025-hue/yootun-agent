/**
 * 视频号工作台中央面板：browser.status 五态、登录流、账号选择与两个数据页
 * tab（作品数据 / 账号总览，对齐旧工作台顶级信息架构）。作品数据页为左侧
 * 账号管理栏 + 右侧作品面板的两列布局；账号总览页隐藏账号栏、全宽三段。
 * 单账号采集进度在作品工具栏按钮下方就地呈现；全账号采集面板在账号管理栏。
 * 数据页由 WorksPanel / OverviewPage 承担，本组件持有共享数据与采集编排；
 * 作品列表为服务端排序 + 分页（固定每页 10 条），作品 / 摘要查询带内存缓存
 * （切回账号即时渲染上次真实响应，随后后台刷新）。
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
  readBatchStatus, readBrowserState, readOverview, readWorksPage,
  type BatchStatusView, type BrowserState, type OverviewData, type WorkRow, type WorksPage,
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

/** 作品列表页大小（固定 10，不提供页大小选择）。 */
export const WORKS_PAGE_SIZE = 10

/** locale 标签（数值/日期格式化用）：词典逐键不同，逐键等价判定可靠。 */
export function localeTagOf(t: Translate): string {
  return t('panel') === wxZh.panel ? 'zh' : 'en'
}

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
  const [worksPage, setWorksPage] = useState(1)
  const [worksTotal, setWorksTotal] = useState(0)
  const [worksLatestCollectedAt, setWorksLatestCollectedAt] = useState<string | null>(null)
  const [worksCompletionRate, setWorksCompletionRate] = useState<number | null>(null)
  /** works 请求在途（翻页 / 排序 / 后台刷新）：表格 aria-busy 与 Pager busy。 */
  const [worksBusy, setWorksBusy] = useState(false)
  const [summary, setSummary] = useState<OverviewData | null>(null)
  const [summaryState, setSummaryState] = useState<LoadState>('loading')
  /** 同账号后台刷新摘要中（摘要卡淡化；不整块替换为骨架）。 */
  const [summaryRefreshing, setSummaryRefreshing] = useState(false)
  /** 运行中的采集账号（collect.status 的 runningAccountIds 权威投影；批量账号也在其中）。 */
  const [collectRunningIds, setCollectRunningIds] = useState<string[]>([])
  /** 选中账号的运行中采集记录（按账号轮询投影；终态即清除）。 */
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
  /** 当前单账号轮询的目标账号（同账号轮询不重启；换目标由发起方显式停表）。 */
  const collectPollAccountRef = useRef('')
  /** 选中驱动的单账号轮询表（批量运行中选中另一运行中账号时的第二路）。 */
  const selectedPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /** 选中驱动轮询的目标账号（与发起/恢复路目标互不覆盖）。 */
  const selectedPollAccountRef = useRef('')
  /** 页面发起账号的乐观登记（点击 → collect.start 回执窗口）：选中驱动路同账号让位。 */
  const collectClaimRef = useRef('')
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const worksSeqRef = useRef(0)
  /** 已落屏作品行所属账号：partial 保留只对同账号成立，跨账号不得复用。 */
  const worksRowsRef = useRef<{ accountId: string; rows: WorkRow[] }>({ accountId: '', rows: [] })
  /** works 查询内存缓存（账号|排序|页码 → 最近一次真实响应）：切回时即时渲染，随后后台刷新。 */
  const worksCacheRef = useRef(new Map<string, WorksPage>())
  /** 当前页 / 排序 / 查询键镜像：loadWorks 保持零依赖，事件回调先改镜像再发起查询。 */
  const worksPageRef = useRef(1)
  const worksSortRef = useRef<SortState>(DEFAULT_SORT_STATE)
  const worksQueryKeyRef = useRef('')
  /** 当前页码状态所属账号：切账号回第 1 页（排序态保留）的判定基准。 */
  const worksPageAccountRef = useRef('')
  const summarySeqRef = useRef(0)
  /** 已落屏摘要所属账号（同账号重复刷新走 refreshing 淡化，跨账号不复用）。 */
  const summaryAccountRef = useRef<string>('')
  /** summary 查询内存缓存：切回账号即时渲染，随后后台刷新。 */
  const summaryCacheRef = useRef(new Map<string, OverviewData>())
  const selectedIdRef = useRef<string | null>(null)
  const toastSeqRef = useRef(0)
  /** 用户发起过采集 / 批量的标记：挂载恢复的迟到响应让位，不覆盖用户操作。 */
  const userStartedRef = useRef({ collect: false, batch: false })
  /** 挂载恢复只执行一次：依赖的轮询回调随词典函数重建时不重复查询。 */
  const restoredRef = useRef(false)
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
      for (const ref of [loginPollRef, collectPollRef, selectedPollRef, batchPollRef]) {
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

  // ---- 作品列表（服务端排序 + 分页，固定每页 10 条）/ 固定 last_7d 摘要 ----
  // 查询键 = 账号|排序|页码；命中缓存即时渲染上次真实响应再后台刷新；未命中时
  // 跨账号清空进 loading，同账号保留当前行只标记在途。过期响应按序号 + 选中
  // 账号 + 查询键三重守卫整体丢弃。

  /** 应用一次分页响应（当页行 + 整账号聚合值）。 */
  const applyWorksPage = (data: WorksPage): void => {
    setWorks(data.rows)
    setWorksTotal(data.total)
    setWorksLatestCollectedAt(data.latestCollectedAt)
    setWorksCompletionRate(data.completionRatePct)
  }

  /**
   * 拉取一个账号的当前作品页（服务端排序 + 分页）。
   * @param accountId - 目标账号。
   * @param options.page - 目标页（缺省用当前页；排序变化时传 1）。
   * @param options.sort - 目标排序（缺省用当前排序）。
   * @returns works 是否拉取成功（stale 竞态让位不计失败）。
   */
  const loadWorks = useCallback(async (accountId: string, options: { page?: number; sort?: SortState } = {}): Promise<boolean> => {
    const page = options.page ?? worksPageRef.current
    const sort = options.sort ?? worksSortRef.current
    const seq = ++worksSeqRef.current
    const queryKey = `${accountId}|${sort.key}|${sort.direction}|${page}`
    worksQueryKeyRef.current = queryKey
    const cached = worksCacheRef.current.get(queryKey)
    const resume = worksRowsRef.current.accountId === accountId
    if (cached !== undefined && selectedIdRef.current === accountId) {
      // 缓存即时渲染：真实历史响应，随后后台刷新更新。
      applyWorksPage(cached)
      worksRowsRef.current = { accountId, rows: cached.rows }
      setWorksState('ready')
    } else if (!resume) {
      worksRowsRef.current = { accountId: '', rows: [] }
      setWorks([])
      setWorksState('loading')
    }
    setWorksBusy(true)
    try {
      const res = await hostAction('works.list', {
        accountId,
        sort: sort.key,
        order: sort.direction,
        limit: WORKS_PAGE_SIZE,
        offset: (page - 1) * WORKS_PAGE_SIZE,
      })
      // 守卫：序号最新 + 响应账号仍是选中账号 + 查询键未变（翻页 / 排序后旧
      // 响应整体丢弃；采集回调按采集账号刷新，账号不比对会把旧账号数据写进
      // 新账号视图）。
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId || worksQueryKeyRef.current !== queryKey) return true
      const pageData = readWorksPage(res)
      worksCacheRef.current.set(queryKey, pageData)
      applyWorksPage(pageData)
      worksRowsRef.current = { accountId, rows: pageData.rows }
      setWorksState('ready')
      return true
    } catch {
      if (worksSeqRef.current !== seq || selectedIdRef.current !== accountId) return true
      // 失败保留已加载数据仅限同一账号：跨账号旧行不复用（直接 error 态）。
      const sameAccountRows = worksRowsRef.current.accountId === accountId && worksRowsRef.current.rows.length > 0
      setWorksState(sameAccountRows ? 'partial' : 'error')
      return false
    } finally {
      if (worksSeqRef.current === seq) setWorksBusy(false)
    }
  }, [])

  /** 表头排序：发起新查询并回第 1 页（三态循环由 nextSortState 计算）。 */
  const handleWorksSortChange = useCallback((next: SortState): void => {
    worksSortRef.current = next
    setWorksSort(next)
    worksPageRef.current = 1
    setWorksPage(1)
    const accountId = selectedIdRef.current
    if (accountId !== null) void loadWorks(accountId, { page: 1, sort: next })
  }, [loadWorks])

  /** 翻页：只改 offset，排序不变。 */
  const handleWorksPageChange = useCallback((page: number): void => {
    worksPageRef.current = page
    setWorksPage(page)
    const accountId = selectedIdRef.current
    if (accountId !== null) void loadWorks(accountId, { page })
  }, [loadWorks])

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
  // resume 判定管理（跨账号不复用旧数据；缓存命中即时渲染）。切换账号回第 1
  // 页，排序态保留。
  useEffect(() => {
    if (selectedAccountId === null) return
    void loadSummary(selectedAccountId)
    if (tab === 'works') {
      if (worksPageAccountRef.current !== selectedAccountId) {
        worksPageAccountRef.current = selectedAccountId
        worksPageRef.current = 1
        setWorksPage(1)
      }
      void loadWorks(selectedAccountId)
    }
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
    // 数据变更（采集完成）后该账号的全部页缓存作废：重拉当前页拿新行与新聚合值。
    for (const key of [...worksCacheRef.current.keys()]) {
      if (key.startsWith(`${accountId}|`)) worksCacheRef.current.delete(key)
    }
    await Promise.all([
      loadWorks(accountId),
      loadSummary(accountId),
      refreshAccounts(),
    ])
  }, [loadSummary, loadWorks, refreshAccounts])

  const stopCollectPolling = useCallback((): void => {
    if (collectPollRef.current !== null) { clearInterval(collectPollRef.current); collectPollRef.current = null }
    collectPollAccountRef.current = ''
  }, [])

  /**
   * 单账号采集轮询（页面内发起与挂载恢复共用同一套）：按账号查询，以记录自身
   * status 判断该账号终态（busy 现在表示任一账号运行中）；busy=false（全部账号
   * 收敛）才停表。该账号终态时一次性收尾（失败 toast 一次、完成后刷新该账号
   * 数据，不重放挂载前已发生的终态）；其余账号仍在运行时轮询保持，维持运行中
   * 集合的新鲜度。
   * @param accountId - 轮询目标账号（挂载恢复的运行中账号或页面发起账号）。
   */
  const beginCollectPolling = useCallback((accountId: string): void => {
    // 同账号轮询已在跑则不重启（挂载恢复的 collect.running 与 collect.status 指向同一条记录时幂等）。
    if (collectPollRef.current !== null && collectPollAccountRef.current === accountId) return
    stopCollectPolling()
    collectPollAccountRef.current = accountId
    let settledHandled = false
    const tick = (): void => {
      void hostAction('collect.status', { accountId }).then(statusRes => {
        const record = readCollectRecord(statusRes.collect)
        // 运行中集合以响应为准（单账号与批量 worker 账号都在其中）。
        setCollectRunningIds(readRunningIds(statusRes.runningAccountIds))
        if (selectedIdRef.current === accountId && record !== null && record.status === 'running') {
          setCollectRecord(record)
        }
        if (record !== null && record.status !== 'running' && !settledHandled) {
          // 该账号一次性终态收尾：失败 toast 一次，完成后刷新该账号数据。
          settledHandled = true
          setCollectRecord(current => (current !== null && current.accountId === accountId ? null : current))
          if (record.status === 'failed') {
            notify(record.error !== null ? `${t('works.collectFailed')}：${reasonText(record.error, t)}` : t('works.collectFailed'))
          }
          const target = record.accountId ?? accountId
          if (target !== '') void refreshAfterDataChange(target)
        }
        if (statusRes.busy !== true) {
          stopCollectPolling()
          setCollectRunningIds([])
          if (!settledHandled) {
            settledHandled = true
            setCollectRecord(current => (current !== null && current.accountId === accountId ? null : current))
            if (record === null) {
              // 宿主重启/插件重载会丢运行记录：busy=false 且无投影时清掉本地
              // 乐观 running 态，避免「采集中…」永不清除。
              notify(t('works.collectLost'))
            } else if (record.status === 'failed') {
              notify(record.error !== null ? `${t('works.collectFailed')}：${reasonText(record.error, t)}` : t('works.collectFailed'))
            }
            const target = record?.accountId ?? accountId
            if (target !== '') void refreshAfterDataChange(target)
          }
        }
      }).catch(() => undefined)
    }
    // 首跳立即查询，之后按固定间隔轮询。
    void tick()
    collectPollRef.current = setInterval(tick, POLL_MS)
  }, [notify, refreshAfterDataChange, stopCollectPolling, t])

  const startCollect = useCallback((accountId: string): void => {
    if (accountId === '') return
    userStartedRef.current.collect = true
    setCollectStartReason(null)
    // 发起路归属在点击瞬间登记：collect.start 回执前选中驱动路对同账号让位，
    // 不起第三路；started:false / 失败时释放（发起/恢复既有轮询不受影响）。
    collectClaimRef.current = accountId
    // 乐观投影：点击瞬间进入「采集中…」，不等宿主同步链路（实测 2-3 秒）返回。
    setCollectRunningIds(ids => (ids.includes(accountId) ? ids : [...ids, accountId]))
    setCollectRecord({ accountId, status: 'running', progress: null, error: null })
    void hostAction('collect.start', { accountId, newAttempt: true }).then(res => {
      if (res.started !== true) {
        collectClaimRef.current = ''
        // started:false 不进入轮询、不置 running：就地呈现稳定 reason。
        setCollectRunningIds(ids => ids.filter(id => id !== accountId))
        setCollectRecord(current => (current !== null && current.accountId === accountId ? null : current))
        setCollectStartReason(typeof res.reason === 'string' ? res.reason : 'unknown')
        return
      }
      beginCollectPolling(accountId)
      collectClaimRef.current = ''
    }).catch(error => {
      collectClaimRef.current = ''
      stopCollectPolling()
      setCollectRunningIds(ids => ids.filter(id => id !== accountId))
      setCollectRecord(current => (current !== null && current.accountId === accountId ? null : current))
      setCollectStartReason(error instanceof Error ? error.message : 'unknown')
    })
  }, [beginCollectPolling, stopCollectPolling])

  const cancelCollect = useCallback((accountId: string): void => {
    void hostAction('collect.cancel', { accountId }).catch(() => undefined)
  }, [])

  // ---- 全账号采集（账号管理栏批量面板数据源）----

  const stopBatchPolling = useCallback((): void => {
    if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
  }, [])

  /** 批量采集轮询（页面内发起与挂载恢复共用同一套）：首跳立即查询，之后按固定间隔。 */
  const beginBatchPolling = useCallback((): void => {
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
  }, [refreshAfterDataChange, stopBatchPolling])

  const startBatch = useCallback((): void => {
    userStartedRef.current.batch = true
    // 与单账号同理：点击瞬间先挂最小运行投影，批量面板立刻显示进行中。
    setBatch(readBatchStatus({ ready: false, phase: 'probing', items: [], total: 0, currentAccountIndex: 0 }))
    void hostAction('collectAll.start', {}).then(res => {
      if (res.started !== true) {
        setBatch(null)
        notify(`${t('batch.startFailed')}：${reasonText(typeof res.reason === 'string' ? res.reason : 'unknown', t)}`)
        return
      }
      beginBatchPolling()
    }).catch(error => {
      // 任何异步失败都必须清掉乐观投影，否则面板停在「采集中」且宿主无批量状态可纠正。
      stopBatchPolling()
      setBatch(null)
      notify(`${t('batch.startFailed')}：${reasonText(error instanceof Error ? error.message : 'unknown', t)}`)
    })
  }, [beginBatchPolling, notify, stopBatchPolling, t])

  const cancelBatch = useCallback((): void => {
    void hostAction('collectAll.cancel', {}).then(() => {
      // 取消回执后立即读一次批量状态（当前账号 settle 后才 finished），
      // 不等下一轮询周期。
      return hostAction('collectAll.status')
    }).then(batchRes => {
      setBatch(readBatchStatus(batchRes))
    }).catch(() => undefined)
  }, [])

  // ---- 挂载恢复：Host 侧采集与批量在页面卸载期间照常运行，重新挂载时等账号
  // 列表收敛（选中账号确定）后并行三路查询，恢复运行态与轮询（复用页面内发起
  // 采集的同一套轮询与终态收尾）；恢复响应到达前用户已发起时结果丢弃。挂载时
  // 不重放终态（终态只在采集结束时以 toast 提示一次）----

  useEffect(() => {
    if (restoredRef.current) return
    if (accountsState === 'loading') return
    restoredRef.current = true
    const restore = async (): Promise<void> => {
      const [runningRes, selectedRes, batchRes] = await Promise.allSettled([
        hostAction('collect.running'),
        hostAction('collect.status', { accountId: selectedIdRef.current ?? '' }),
        hostAction('collectAll.status'),
      ])
      if (!userStartedRef.current.collect) {
        const runningRecord = runningRes.status === 'fulfilled' ? readCollectRecord(runningRes.value.collect) : null
        const selectedPayload = selectedRes.status === 'fulfilled' ? selectedRes.value : null
        const selectedRecord = selectedPayload !== null ? readCollectRecord(selectedPayload.collect) : null
        const firstRunning = runningRecord !== null && runningRecord.status === 'running' ? runningRecord : null
        const selectedRunning = selectedRecord !== null && selectedRecord.status === 'running' ? selectedRecord : null
        if (firstRunning !== null || selectedRunning !== null) {
          setCollectRunningIds(previous => {
            const merged = new Set([...previous, ...readRunningIds(selectedPayload?.runningAccountIds)])
            if (firstRunning !== null) merged.add(firstRunning.accountId ?? '')
            merged.delete('')
            return [...merged]
          })
          // 轮询目标：选中账号在采则轮询选中账号（面板进度），否则轮询运行中的账号。
          const polled = selectedIdRef.current !== null && selectedRunning !== null ? selectedRunning : firstRunning
          if (polled !== null && (polled.accountId ?? '') !== '') {
            if (polled.accountId === selectedIdRef.current) setCollectRecord(polled)
            beginCollectPolling(polled.accountId ?? '')
          }
        }
      }
      if (!userStartedRef.current.batch && batchRes.status === 'fulfilled') {
        const next = readBatchStatus(batchRes.value)
        if (next.phase === 'probing' || next.phase === 'collecting' || next.phase === 'stopping') {
          setBatch(next)
          beginBatchPolling()
        } else if (next.phase === 'finished') {
          // 已结束的批量只恢复汇总面板：不轮询、不触发刷新（挂载时数据已是最新）。
          setBatch(next)
        }
      }
    }
    void restore()
  }, [accountsState, beginBatchPolling, beginCollectPolling])

  // ---- 选中驱动的单账号轮询（批量 / 并发运行中，选中另一运行中账号的第二路）----

  /** 停掉选中驱动轮询，并清掉属于其目标账号的运行中记录（面板不再显示该账号进度）。 */
  const stopSelectedPolling = useCallback((): void => {
    if (selectedPollRef.current !== null) { clearInterval(selectedPollRef.current); selectedPollRef.current = null }
    const target = selectedPollAccountRef.current
    selectedPollAccountRef.current = ''
    if (target !== '') {
      setCollectRecord(current => (current !== null && current.accountId === target ? null : current))
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
        setCollectRunningIds(readRunningIds(statusRes.runningAccountIds))
        const record = readCollectRecord(statusRes.collect)
        if (selectedIdRef.current === accountId && record !== null && record.status === 'running') {
          setCollectRecord(record)
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

  // 账号栏状态点与选中驱动轮询共用的运行中集合：单账号轮询集合 ∪ 批量运行中
  // 集合（同一控制器，两处投影取并集）。
  const batchRunningIds = batch !== null && batch.ready !== true && batch.phase !== 'finished' ? batch.runningAccountIds : []
  const collectingIds = [...new Set([...collectRunningIds, ...batchRunningIds])]
  /** 选中账号是否在运行中集合（选中驱动轮询的开关；布尔依赖避免数组依赖重跑）。 */
  const selectedRunning = selectedAccountId !== null && collectingIds.includes(selectedAccountId)

  // 选中驱动的轮询随 [选中账号, 选中账号是否运行中] 管理：批量运行中切到运行中
  // 的账号另起一路按账号轮询（运行中集合里随后出现选中账号同样触发）；切到
  // 未运行的账号停表并清掉上一选中账号的记录。发起/恢复账号的那一路
  // （collectPollRef）不因切换选中停止或改目标；发起回执窗口内的账号由
  // collectClaimRef 让位，同一时刻至多两路单账号轮询加一路批量轮询。
  useEffect(() => {
    if (selectedAccountId === null || !selectedRunning) {
      stopSelectedPolling()
      return undefined
    }
    // 发起/恢复路已在该账号上轮询（或发起回执在途）：不重复起。
    if (collectClaimRef.current === selectedAccountId || collectPollAccountRef.current === selectedAccountId) return undefined
    if (selectedPollRef.current !== null && selectedPollAccountRef.current === selectedAccountId) return undefined
    beginSelectedPolling(selectedAccountId)
    return stopSelectedPolling
  }, [selectedAccountId, selectedRunning, beginSelectedPolling, stopSelectedPolling])

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
  /** 任一账号采集运行中（宿主互斥的提前反馈；按钮禁用与账号栏锁定的数据源）。 */
  const collectBusy = collectRunningIds.length > 0
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
                  localeTag={localeTagOf(t)}
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  browserBlocked={browserBlocking}
                  loginActive={loginActive}
                  collectingIds={collectingIds}
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
                    onSortChange={handleWorksSortChange}
                    worksPage={worksPage}
                    worksTotal={worksTotal}
                    worksLatestCollectedAt={worksLatestCollectedAt}
                    worksCompletionRate={worksCompletionRate}
                    worksBusy={worksBusy}
                    onPageChange={handleWorksPageChange}
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
