/**
 * 视频号工作台数据流适配层：以 Host action 与 schema 投影构造共享 machine
 * （`@yootun/dsh-client-workbench-machines`），返回登录、单账号采集、批量
 * 采集、作品查询四个 machine。页面组件只做布局与组合；发起/恢复路的竞态
 * 守卫（恢复代次、序号、缓存）随数据流迁入 machine。选中驱动的第二路轮询
 * 仍在页面（批量运行中切换选中账号的实时进度，停表语义 machine 不承载），
 * 经 `isMainPolling` 与发起/恢复路互斥。works 响应的页级聚合值
 * （latestCollectedAt / completionRatePct）经 machine 的 summary 泛型透传，
 * 缓存命中一并还原。
 * @module
 */
import { createBatchMachine, createCollectMachine, createLoginMachine, createWorksQuery, type BatchMachine, type CollectMachine, type LoginMachine, type WorksQuery } from '@yootun/dsh-client-workbench-machines'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import { readBatchStatus, readInterrupted, readWorksPage, type BatchStatusView, type InterruptedView, type WorkRow } from './schema.ts'
import { POLL_MS, WORKS_PAGE_SIZE, type SingleCollectRecord } from './workbench-ui.ts'

/** works 页级聚合投影（machine summary 泛型；WorksPage 顶层聚合值的搬运）。 */
export interface WxWorksPageMeta {
  latestCollectedAt: string | null
  completionRatePct: number | null
}

/** collect.running 的读取投影。 */
interface WxRunningView {
  collect: SingleCollectRecord | null
  batchRunning: boolean
}

/** collect.status 的读取投影（busy / runningAccountIds 供合成运行投影判定）。 */
interface WxCollectStatusView {
  collect: SingleCollectRecord | null
  busy: boolean
  runningAccountIds: unknown
  interrupted: InterruptedView | null
}

/** flows 的页面回调依赖（toast、账号刷新、摘要/账号列表联动、横幅态由页面承担）。 */
export interface WxFlowDeps {
  /** 页面翻译函数（reasonText 收敛用；flows 经引用读取，语言切换后取当前值）。 */
  t: Translate
  /** 页面 toast。 */
  notify(text: string, tone?: 'success'): void
  /** 账号列表刷新（登录终态与采集终态后）。 */
  refreshAccounts(): Promise<boolean>
  /** 采集终态/丢记录后的页面侧联动（固定 last_7d 摘要重拉 + 账号列表）。 */
  refreshAccountStreams(accountId: string): void
  /** 单账号/批量启动成功：Host 已清启动中断摘要，页面横幅随之收起。 */
  onStarted(): void
  /** 中断摘要到达（2.5 横幅数据源）。 */
  onInterrupted(view: InterruptedView): void
}

/** 视频号工作台四 machine 集合。 */
export interface WxFlows {
  login: LoginMachine<{ loginKey: string; status: string; reason: string | null }>
  collect: CollectMachine<SingleCollectRecord>
  batch: BatchMachine<BatchStatusView>
  works: WorksQuery<WorkRow, WxWorksPageMeta>
  /** 发起单账号采集（发起路目标登记，选中驱动路据此让位）。 */
  startCollect(accountId: string): Promise<void>
  /** 批量状态单拍读取（页面轮询 tick 调用；含中断摘要投影）。 */
  pollBatch(): Promise<{ view: BatchStatusView | null; interrupted: InterruptedView | null }>
  /** 挂载恢复：collect.running + collect.status（选中账号）并行注入 collect machine。 */
  restoreCollect(accountId: string): Promise<void>
  /** 挂载恢复：collectAll.status 读取（批量面板的 phase 门由页面承担）。 */
  restoreBatch(): Promise<{ view: BatchStatusView | null; interrupted: InterruptedView | null }>
  /** 发起/恢复路的轮询目标查询（选中驱动路对该账号让位）。 */
  isMainPolling(accountId: string): boolean
}

/**
 * Create the wx flows. ports 以 hostAction + schema 投影构造；页面回调经
 * deps 注入（toast 文案、账号刷新、摘要联动、横幅态）。
 * @param deps - 页面回调依赖。
 * @returns the four machines plus restore helpers.
 */
export function createWxFlows(deps: WxFlowDeps): WxFlows {
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
  const works = createWorksQuery<WorkRow, WxWorksPageMeta>({
    list: async (query) => {
      const res = await hostAction('works.list', {
        accountId: query.accountId,
        sort: query.sortKey,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      })
      const page = readWorksPage(res)
      return {
        rows: page.rows,
        total: page.total,
        summary: { latestCollectedAt: page.latestCollectedAt, completionRatePct: page.completionRatePct },
      }
    },
    pageSize: WORKS_PAGE_SIZE,
  })
  const login = createLoginMachine({
    begin: async () => {
      const res = await hostAction('account.beginLogin', {})
      return { loginKey: typeof res.loginKey === 'string' ? res.loginKey : '', status: 'waiting_qr', reason: null }
    },
    status: async (key) => {
      const res = await hostAction('account.loginStatus', { accountId: key })
      return {
        loginKey: key,
        status: String(res.state ?? 'idle'),
        reason: res.reason !== undefined && res.reason !== null ? String(res.reason) : null,
      }
    },
    keyOf: view => view.loginKey,
    statusOf: view => view.status,
    activeStatuses: ['waiting_qr', 'scanned', 'confirming'],
    terminalStatuses: ['ok', 'timeout', 'failed', 'idle'],
    pollIntervalMs: POLL_MS,
    poller: pollerClock,
    onSettled: (view) => {
      if (view.status === 'ok') {
        deps.notify(view.reason !== null ? deps.t('login.savedFailed') : deps.t('login.state.ok'), 'success')
        void deps.refreshAccounts()
      }
      else if (view.status === 'timeout' || view.status === 'failed') {
        // 终态必须停轮询并恢复按钮，否则「添加账号」永远禁用。
        deps.notify(view.status === 'timeout' ? deps.t('login.timeoutToast') : deps.t('login.failedToast'))
      }
      // idle：页面收起卡片即可，不弹提示。
    },
  })
  /** 发起/恢复路的轮询目标（选中驱动路让位判定；machine 内幂等不复起）。 */
  let mainPolledAccount = ''
  /** 用户已发起单账号采集（恢复丢弃判定的 flows 侧镜像，与 machine 代次一致）。 */
  let userStartedCollect = false
  /** 最近一次主路 status 查询的账号（丢记录收尾按它刷新页面数据）。 */
  let lastPolledAccount = ''
  /** 采集终态/丢记录后的数据联动：works 缓存失效 + 当前页重拉 + 页面侧流。 */
  const refreshCollectAccount = (accountId: string): void => {
    if (accountId === '') return
    works.invalidateCache(accountId)
    void works.load(accountId)
    deps.refreshAccountStreams(accountId)
  }
  /** collect.status 的原始读取投影（恢复路用，不做合成）。 */
  const readStatusRaw = async (accountId: string): Promise<WxCollectStatusView> => {
    const res = await hostAction('collect.status', { accountId })
    const raw = res.collect
    const record = raw !== null && typeof raw === 'object' ? raw as SingleCollectRecord : null
    const interruptedView = readInterrupted(res)
    if (interruptedView !== null)
      deps.onInterrupted(interruptedView)
    return { collect: record, busy: res.busy === true, runningAccountIds: res.runningAccountIds, interrupted: interruptedView }
  }
  /** 轮询路读取投影；busy 在而记录缺失时合成运行投影（宿主仍按账号推进，不丢表）。 */
  const readStatus = async (accountId: string): Promise<WxCollectStatusView> => {
    const view = await readStatusRaw(accountId)
    if (view.collect === null && view.busy) {
      return { ...view, collect: { accountId, status: 'running', progress: null, error: null } }
    }
    return view
  }
  const collect = createCollectMachine({
    start: async (accountId) => {
      try {
        const res = await hostAction('collect.start', { accountId, newAttempt: true })
        if (res.started !== true) {
          // started:false 不进入轮询、不置 running：就地呈现稳定 reason。
          mainPolledAccount = ''
          return { collect: null, reason: typeof res.reason === 'string' ? res.reason : 'unknown' }
        }
        deps.onStarted()
        return { collect: { accountId, status: 'running', progress: null, error: null } }
      } catch (error) {
        mainPolledAccount = ''
        throw error
      }
    },
    status: async (accountId) => {
      lastPolledAccount = accountId
      const view = await readStatus(accountId)
      return { collect: view.collect, interrupted: view.interrupted ?? undefined }
    },
    running: async () => {
      const res = await hostAction('collect.running')
      const raw = res.collect
      const record = raw !== null && typeof raw === 'object' ? raw as SingleCollectRecord : null
      return { runningAccountIds: record !== null && record.status === 'running' && record.accountId !== null && record.accountId !== '' ? [record.accountId] : [] }
    },
    accountIdOf: (view, fallback) => view.accountId !== null && view.accountId !== '' ? view.accountId : fallback,
    statusOf: view => view.status ?? '',
    optimisticRunning: accountId => ({ accountId, status: 'running', progress: null, error: null }),
    pollIntervalMs: POLL_MS,
    poller: pollerClock,
    onSettled: (accountId, view) => {
      // 该账号一次性终态收尾：失败 toast 一次，完成后按采集账号刷新数据。
      if (view.status === 'failed') {
        deps.notify(view.error !== null ? `${deps.t('works.collectFailed')}：${reasonText(view.error, deps.t)}` : deps.t('works.collectFailed'))
      }
      refreshCollectAccount(view.accountId ?? accountId)
    },
    onLost: () => {
      // 宿主重启/插件重载丢运行记录（busy=false 且无投影）：清乐观 running 态
      // 并按最近轮询账号刷新（原页 busy 收敛口径）。
      deps.notify(deps.t('works.collectLost'))
      refreshCollectAccount(lastPolledAccount)
    },
  })
  const batch = createBatchMachine({
    start: async () => {
      const res = await hostAction('collectAll.start', {})
      if (res.started !== true) {
        // 宿主拒绝：乐观投影由 machine 的 catch 清空，页面按稳定 reason 提示。
        throw new Error(typeof res.reason === 'string' ? res.reason : 'unknown')
      }
      deps.onStarted()
      return { batch: readBatchStatus({ ready: false, phase: 'probing', items: [], total: 0, currentAccountIndex: 0 }) }
    },
    status: async () => ({ batch: readBatchStatus(await hostAction('collectAll.status')) }),
    cancel: async () => { await hostAction('collectAll.cancel', {}) },
    runningOf: view => view.ready !== true && view.phase !== 'finished',
    optimisticRunning: () => readBatchStatus({ ready: false, phase: 'probing', items: [], total: 0, currentAccountIndex: 0 }),
    onFinished: () => undefined,
    onRunningChanged: () => undefined,
  })
  return {
    login,
    collect,
    batch,
    works,
    async startCollect(accountId) {
      userStartedCollect = true
      mainPolledAccount = accountId
      await collect.start(accountId)
    },
    async pollBatch() {
      const res = await hostAction('collectAll.status')
      const view = readBatchStatus(res)
      const interrupted = readInterrupted(res)
      return { view, interrupted }
    },
    async restoreCollect(accountId) {
      // 两路查询并行发出、相互独立，各自失败即该路丢弃（原页逐路 catch 口径）。
      const runningPromise = hostAction('collect.running').then(async (res) => {
        const raw = res.collect
        const record = raw !== null && typeof raw === 'object' ? raw as SingleCollectRecord : null
        return { collect: record, batchRunning: res.batchRunning === true } satisfies WxRunningView
      }).catch(() => null)
      const selectedPromise = readStatusRaw(accountId).catch(() => null)
      const runningView = await runningPromise
      const selectedView = await selectedPromise
      // 恢复代次守卫在 machine 内（用户已发起则整体丢弃）。
      const firstRunning = runningView !== null && runningView.collect !== null && runningView.collect.status === 'running' ? runningView.collect : null
      const selectedRunning = selectedView !== null && selectedView.collect !== null && selectedView.collect.status === 'running' ? selectedView.collect : null
      const polled = selectedRunning ?? firstRunning
      const polledAccount = polled !== null && polled.accountId !== null && polled.accountId !== '' ? polled.accountId : ''
      if (userStartedCollect || polled === null || polledAccount === '')
        return
      mainPolledAccount = polledAccount
      if (polled === null || polledAccount === '')
        return
      if (selectedRunning !== null) {
        // 选中账号在采：恢复其面板进度并轮询（原页 polled = selectedRunning 口径）。
        collect.restore({ running: null, selected: { collect: selectedRunning }, accountId })
        return
      }
      // 其他账号在采：只恢复运行中集合与轮询，不覆盖选中账号面板。
      collect.restore({ running: { collect: firstRunning, runningAccountIds: [polledAccount] }, selected: null, accountId })
    },
    async restoreBatch() {
      let res: Record<string, unknown>
      try {
        res = await hostAction('collectAll.status')
      } catch {
        // 恢复查询失败按无运行中批量处理（原页 allSettled 口径）。
        return { view: null, interrupted: null }
      }
      const view = readBatchStatus(res)
      const interrupted = readInterrupted(res)
      return { view, interrupted }
    },
    isMainPolling: (accountId) => mainPolledAccount === accountId,
  }
}
