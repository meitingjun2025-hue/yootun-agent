/**
 * 抖音工作台数据流适配层：以 Host action 与 schema 投影构造共享 machine
 * （`@yootun/dsh-client-workbench-machines`），返回登录、单账号采集、批量
 * 采集、作品查询四个 machine。页面组件只做布局与组合；ref 守卫随数据流迁
 * 入 machine（恢复代次、序号、缓存）。
 * @module
 */
import { createBatchMachine, createCollectMachine, createLoginMachine, createWorksQuery, type BatchMachine, type CollectMachine, type LoginMachine, type WorksQuery } from '@yootun/dsh-client-workbench-machines'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import { readBatchStatus, readCollectRunning, readCollectStatus, readInterrupted, readLogin, readWorksPage,
  type BatchView, type CollectView, type InterruptedView, type WorkRow, type WorksSummary } from './schema.ts'
import { WORKS_PAGE_SIZE } from './WorksPanel.tsx'

/** flows 的页面回调依赖（toast、账号刷新、横幅态由页面承担）。 */
export interface DouyinFlowDeps {
  /** 页面翻译函数（reasonText 收敛用；flows 经引用读取，语言切换后取当前值）。 */
  t: Translate
  /** 页面 toast。 */
  notify(text: string, tone?: 'success'): void
  /** 账号列表刷新（登录终态与采集/批量终态后）。 */
  refreshAccounts(): Promise<boolean>
  /** 单账号/批量启动成功：Host 已清启动中断摘要，页面横幅随之收起。 */
  onStarted(): void
  /** 中断摘要到达（2.5 横幅数据源）。 */
  onInterrupted(view: InterruptedView): void
}

/** 抖音工作台四 machine 集合。 */
export interface DouyinFlows {
  login: LoginMachine<{
    loginKey: string
    status: string
    saveError: string | null
    error: string | null
  }>
  collect: CollectMachine<CollectView>
  batch: BatchMachine<BatchView>
  works: WorksQuery<WorkRow, WorksSummary>
  /** 批量状态单拍读取（页面轮询 tick 调用；含中断摘要投影）。 */
  pollBatch(): Promise<{ view: BatchView | null; interrupted: InterruptedView | null }>
  /** 挂载恢复：collect.running + collect.status（选中账号）注入 collect machine。 */
  restoreCollect(accountId: string): Promise<void>
  /** 挂载恢复：collectAll.status 注入 batch machine（返回批量视图与中断摘要）。 */
  restoreBatch(): Promise<{ view: BatchView | null; interrupted: InterruptedView | null }>
}

/**
 * Create the douyin flows. ports 以 hostAction + schema 投影构造；页面回调
 * 经 deps 注入（toast 文案、账号刷新、横幅态）。
 * @param deps - 页面回调依赖。
 * @returns the four machines plus restore helpers.
 */
export function createDouyinFlows(deps: DouyinFlowDeps): DouyinFlows {
  // machine 只回传本表 schedule 的句柄（登录 + 按账号采集并发在途）。
  const pollHandles = new Set<ReturnType<typeof setInterval>>()
  const pollerClock = {
    schedule: (fn: () => void, ms: number): unknown => {
      const handle = setInterval(fn, ms)
      pollHandles.add(handle)
      return handle
    },
    cancel: (handle: unknown): void => {
      for (const timed of pollHandles) {
        if (timed === handle) {
          clearInterval(timed)
          pollHandles.delete(timed)
        }
      }
    },
  }
  const works = createWorksQuery<WorkRow, WorksSummary>({
    list: async (query) => {
      const page = await readWorksPage(await hostAction('works.list', {
        accountId: query.accountId,
        sort: query.sortKey,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      }))
      // WorksPage 的 summary 可空；machine 透传视图以「缺键 = 无摘要」表达。
      if (page.summary === null) return { rows: page.rows, total: page.total }
      return { rows: page.rows, total: page.total, summary: page.summary }
    },
    pageSize: WORKS_PAGE_SIZE,
  })
  const login = createLoginMachine({
    begin: async () => await readLogin(await hostAction('account.beginLogin', {})),
    status: async (key) => await readLogin(await hostAction('account.loginStatus', { loginKey: key })),
    keyOf: view => view.loginKey,
    statusOf: view => view.status,
    activeStatuses: ['waiting'],
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'],
    pollIntervalMs: 2000,
    poller: pollerClock,
    onSettled: (view) => {
      if (view.status === 'ok') {
        deps.notify(view.saveError !== null ? deps.t('login.savedFailedToast') : deps.t('login.okToast'), 'success')
        void deps.refreshAccounts()
      }
      else if (view.status === 'timeout') {
        deps.notify(deps.t('login.timeoutToast'))
      }
      else if (view.status === 'failed') {
        deps.notify(deps.t('login.failedToast'))
      }
      // idle：页面收起卡片即可，不弹提示。
    },
  })
  /** 迟绑定引用：start 失败路径停全部采集轮询（原页 catch 语义）。 */
  let collectRef: CollectMachine<CollectView> | null = null
  const collect = createCollectMachine({
    start: async (accountId, options) => {
      try {
        const res = await hostAction('collect.start', { accountId, ...(options ?? {}) })
        const view = readCollectStatus({ collect: res.collect })
        if (view.collect !== null) deps.onStarted()
        return { collect: view.collect, reason: typeof res.reason === 'string' ? res.reason : undefined }
      } catch (error) {
        collectRef?.stopPolling()
        throw error
      }
    },
    status: async (accountId) => {
      const view = readCollectStatus(await hostAction('collect.status', { accountId }))
      if (view.interrupted !== null) deps.onInterrupted(view.interrupted)
      return { collect: view.collect, recovery: view.recovery }
    },
    running: async () => {
      const view = readCollectRunning(await hostAction('collect.running'))
      return { runningAccountIds: view.collect !== null && view.collect.accountId !== '' ? [view.collect.accountId] : [] }
    },
    accountIdOf: (view, fallback) => view.accountId !== '' ? view.accountId : fallback,
    statusOf: view => view.status,
    optimisticRunning: accountId => ({ accountId, status: 'running', phase: null, progress: {}, error: null, finishedAt: null }),
    pollIntervalMs: 1500,
    poller: pollerClock,
    onSettled: (accountId, view) => {
      if (view.status === 'failed') {
        deps.notify(view.error !== null ? `${deps.t('works.collectFailed')}：${reasonText(view.error, deps.t)}` : deps.t('works.collectFailed'))
      }
      // 采集完成后该账号作品缓存失效；仍是当前作品账号时重拉一页（其余账号
      // 不打扰在屏列表，原页对非选中账号的重拉本就被序号守卫整体丢弃）。
      const settledAccount = view.accountId !== '' ? view.accountId : accountId
      works.invalidateCache(settledAccount)
      if (works.get().accountId === settledAccount) void works.load(settledAccount)
      void deps.refreshAccounts()
    },
    onLost: (recovery) => {
      // G-2 recovery_required：中断由横幅承载（2.5），不弹 toast。
      if (recovery !== 'recovery_required')
        deps.notify(deps.t('works.collectLost'))
    },
  })
  collectRef = collect
  const batch = createBatchMachine({
    start: async () => {
      const res = await hostAction('collectAll.start', {})
      deps.onStarted()
      return { batch: readBatchStatus(res) }
    },
    status: async () => ({ batch: readBatchStatus(await hostAction('collectAll.status', {})) }),
    cancel: async () => { await hostAction('collectAll.cancel', {}) },
    runningOf: view => view.status === 'running',
    optimisticRunning: () => readBatchStatus({ batch: { status: 'running', phase: 'probing' } }),
    onFinished: () => { void deps.refreshAccounts() },
    onRunningChanged: () => undefined,
  })
  return {
    login,
    collect,
    batch,
    works,
    async pollBatch() {
      const res = await hostAction('collectAll.status', {})
      const view = res.batch === null || res.batch === undefined ? null : readBatchStatus(res)
      const interrupted = readInterrupted(res)
      return { view, interrupted }
    },
    async restoreCollect(accountId) {
      // 两路查询并行发出、相互独立，各自失败即该路丢弃（原页逐路 catch 口径）。
      const runningPromise = hostAction('collect.running').then(res => readCollectRunning(res)).catch(() => null)
      const selectedPromise = hostAction('collect.status', { accountId }).then(res => readCollectStatus(res)).catch(() => null)
      const runningView = await runningPromise
      const selectedView = await selectedPromise
      if (runningView !== null && runningView.batchRunning)
        batch.markRecoveryPending()
      if (selectedView !== null && selectedView.interrupted !== null)
        deps.onInterrupted(selectedView.interrupted)
      collect.restore({
        running: runningView === null ? null : { collect: runningView.collect, runningAccountIds: runningView.collect !== null && runningView.collect.accountId !== '' ? [runningView.collect.accountId] : [] },
        selected: selectedView === null ? null : { collect: selectedView.collect },
        accountId,
      })
    },
    async restoreBatch() {
      let res: Record<string, unknown>
      try {
        res = await hostAction('collectAll.status', {})
      } catch {
        // collectAll.status 恢复查询失败：面板维持空投影并解除入口锁定（原页 catch 口径）。
        batch.restore(null)
        return { view: null, interrupted: null }
      }
      const view = res.batch === null || res.batch === undefined ? null : readBatchStatus(res)
      const interrupted = readInterrupted(res)
      if (interrupted !== null)
        deps.onInterrupted(interrupted)
      batch.restore(view)
      return { view, interrupted }
    },
  }
}
