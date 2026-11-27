/**
 * 账号管理状态机（迁移旧 client.js createAccountsHub 全行为，纯逻辑无 React
 * 依赖）：登录 waiting 与采集 running 各自 2s 轮询一次 status；登录终态
 * ok/timeout/failed 与采集 completed/failed/cancelled 停止轮询并刷新列表；
 * 宿主侧终态 run 读取一次即清理，轮询返回 idle 视为扫码中断（进程重启/窗口
 * 丢失）。Chrome 缺失时浏览器动作前置阻断（不动浏览器，直接受控提示）。
 * @module
 */
import { hostAction } from './api.ts'

/** 账号列表行（accounts.list 投影）。 */
export interface AccountRow {
  accountId: string
  nickname: string | null
  avatar: string | null
  sessionStatus: string
  sessionCheckedAt: string | null
  lastCollectedAt: string | null
  /** 存在 running 发布 run（浏览器发布页仍打开）；缺省 false。 */
  publishWindowOpen?: boolean
  summary?: {
    notesCount: number
    totals: { plays: number; likes: number; collects: number; comments: number; shares: number }
    gaps: { plays: number; likes: number; collects: number; comments: number; shares: number }
    capturedAt: string | null
  }
}

/** 登录 run 投影（account.beginLogin/loginStatus 的 login 字段）。 */
export interface LoginState {
  loginId: string
  status: string
  accountId?: string | null
  nickname?: string | null
  avatar?: string | null
  reason?: string | null
}

/** 采集 run 投影（collect.start/status 的 collect 字段）。 */
export interface CollectState {
  collectId: string
  accountId: string
  collectStatus: string
  pagesDone: number
  notesTotal: number
  truncated?: boolean
  error?: string | null
}

/** 通知条（kind 决定 role 与配色；error 时 reason 走稳定码文案映射）。 */
export interface AccountsNotice {
  kind: 'ok' | 'warn' | 'error'
  /** 固定文案键，或稳定 reason 码（UI 经 reasonText 映射）。 */
  key: string
  reason?: string | undefined
}

/** machine 快照。 */
export interface AccountsSnapshot {
  loaded: boolean
  loading: boolean
  accounts: AccountRow[]
  listError: string | null
  selectedId: string | null
  login: LoginState | null
  collect: CollectState | null
  probing: ReadonlySet<string>
  notice: AccountsNotice | null
  /** null = 未探测；true/false 来自 browser.status（无 Chrome 阻断提示）。 */
  chromeAvailable: boolean | null
}

/** Host 调用注入面（页面以 hostAction 接线；测试注入假 post）。 */
export interface AccountsMachinePorts {
  listAccounts(): Promise<{ accounts?: AccountRow[] }>
  beginLogin(args?: { accountId?: string }): Promise<{ login?: LoginState }>
  loginStatus(args: { loginId?: string }): Promise<{ login?: { status: string; loginId?: string | null; accountId?: string | null; nickname?: string | null; avatar?: string | null; reason?: string | null } }>
  probe(args: { accountId: string }): Promise<{ status?: string; sessionStatus?: string }>
  removeLocal(args: { accountId: string }): Promise<unknown>
  startCollect(args: { accountId: string; idempotencyKey: string }): Promise<{ collect?: CollectState }>
  collectStatus(args: { collectId: string } | { accountId: string }): Promise<{ status?: string; collect?: CollectState | null }>
  cancelCollect(args: { collectId: string }): Promise<{ status?: string; collect?: CollectState | null }>
  browserStatus(): Promise<{ chromeAvailable?: boolean }>
  intervalMs?: number
  schedule?: ((fn: () => void) => unknown) | undefined
  clearSchedule?: ((id: unknown) => void) | undefined
  newIdempotencyKey?: (() => string) | undefined
}

export interface AccountsMachine {
  subscribe(listener: () => void): () => void
  get(): AccountsSnapshot
  /** 首次进入账号页：拉列表/探测 Chrome，并继续未完成的轮询（后台动作仍在跑）。 */
  init(): void
  /** 离开账号页：停轮询（不丢弃状态，重新进入时恢复）。 */
  stop(): void
  select(accountId: string): void
  dismissNotice(): void
  /** 浏览器动作前置阻断：无系统 Chrome 时不动浏览器。 */
  chromeBlocked(): boolean
  beginLoginFlow(options?: { accountId?: string | null }): Promise<void>
  probeNow(accountId: string): Promise<void>
  removeAccount(accountId: string): Promise<void>
  startCollectFlow(accountId: string): Promise<void>
  /** 取消运行中的采集（collect.cancel）；终态收敛与轮询路径同口径。 */
  cancelCollectFlow(): Promise<void>
  /** 测试辅助：注入假时钟推进轮询。 */
  tick(): Promise<void>
}

const DEFAULT_POLL_INTERVAL_MS = 2000

function emptySnapshot(): AccountsSnapshot {
  return {
    loaded: false,
    loading: false,
    accounts: [],
    listError: null,
    selectedId: null,
    login: null,
    collect: null,
    probing: new Set<string>(),
    notice: null,
    chromeAvailable: null,
  }
}

/**
 * Create the accounts hub machine.
 * @param ports - injected Host caller and timers.
 * @returns the machine.
 */
export function createAccountsMachine(ports: AccountsMachinePorts): AccountsMachine {
  const intervalMs = ports.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const schedule = ports.schedule ?? ((fn: () => void) => setTimeout(fn, intervalMs))
  const clearSchedule = ports.clearSchedule ?? ((id: unknown) => clearTimeout(id as NodeJS.Timeout))
  const newKey = ports.newIdempotencyKey ?? (() => `xhs-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)

  let snapshot = emptySnapshot()
  const listeners = new Set<() => void>()
  let timer: unknown = null
  let active = false
  // 挂载恢复的代次守卫：用户已点「采集」（startCollectFlow）则丢弃在途恢复响应。
  let restoreGeneration = 0

  const setState = (patch: Partial<AccountsSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  const get = (): AccountsSnapshot => snapshot

  const setNotice = (kind: AccountsNotice['kind'], key: string, reason?: string): void => {
    setState({ notice: key === '' ? null : { kind, key, ...(reason !== undefined ? { reason } : {}) } })
  }

  /** 宿主受控错误码 → 文案键：页面只见中文提示，绝不暴露内部错误码与细节。 */
  function accountReasonKey(reason: string | undefined | null): string | null {
    if (reason === undefined || reason === null || reason === '') return null
    const keys: Readonly<Record<string, string>> = {
      PROFILE_BUSY: 'reason.PROFILE_BUSY',
      GOOGLE_CHROME_MISSING: 'reason.GOOGLE_CHROME_MISSING',
      PLAYWRIGHT_DRIVER_MISSING: 'reason.PLAYWRIGHT_DRIVER_MISSING',
      SESSION_EXPIRED: 'reason.SESSION_EXPIRED',
      CAPTCHA_DETECTED: 'reason.CAPTCHA_DETECTED',
      LOGIN_TIMEOUT: 'reason.LOGIN_TIMEOUT',
      COLLECT_FAILED: 'reason.COLLECT_FAILED',
      PUBLISH_FAILED: 'reason.PUBLISH_FAILED',
      PROBE_FAILED: 'reason.PROBE_FAILED',
      LOGIN_FAILED: 'reason.LOGIN_FAILED',
    }
    return keys[reason] ?? null
  }

  function noticeForReason(kind: AccountsNotice['kind'], reason: string | undefined, fallbackKey: string): void {
    const mapped = accountReasonKey(reason)
    if (mapped !== null) setNotice(kind, mapped, reason)
    else setNotice(kind, fallbackKey, reason)
  }

  async function refresh(options: { keepNotice?: boolean } = {}): Promise<void> {
    setState({ loading: snapshot.accounts.length === 0 })
    try {
      const result = await ports.listAccounts()
      if (!active) return
      const accounts = Array.isArray(result?.accounts) ? result.accounts : []
      const current = snapshot.selectedId !== null && accounts.some(item => item.accountId === snapshot.selectedId)
        ? snapshot.selectedId
        : accounts[0]?.accountId ?? null
      setState({
        loaded: true,
        loading: false,
        accounts,
        listError: null,
        selectedId: current,
        ...(options.keepNotice === false ? { notice: null } : {}),
      })
    } catch {
      if (!active) return
      setState({ loaded: true, loading: false, listError: 'accounts.listFailed' })
    }
  }

  /** 每次进入账号页都重探 Chrome（安装是环境事实，随时可能变化）。 */
  async function refreshBrowserStatus(): Promise<void> {
    try {
      const result = await ports.browserStatus()
      if (!active) return
      setState({ chromeAvailable: result?.chromeAvailable === true })
    } catch {
      if (!active) return
      setState({ chromeAvailable: null })
    }
  }

  function ensurePolling(): void {
    if (timer !== null || !active) return
    // intervalMs 属于默认 schedule 实现；注入的 schedule 自带节奏（测试假定时器）。
    timer = schedule(async () => {
      timer = null
      await pollOnce()
      ensurePolling()
    })
  }

  function stopPolling(): void {
    if (timer !== null) {
      clearSchedule(timer)
      timer = null
    }
  }

  async function pollOnce(): Promise<void> {
    const login = snapshot.login
    if (login !== null && login.status === 'waiting') {
      try {
        await pollLoginOnce(login)
      } catch (error) {
        void error // 单次轮询失败不终止等待：下个周期继续（用户正在扫码，不能打断）。
      }
      return
    }
    const collect = snapshot.collect
    if (collect !== null && collect.collectStatus === 'running') {
      try {
        await pollCollectOnce()
      } catch (error) {
        void error // 同上：采集轮询单次失败不打断，继续下一周期。
      }
    }
  }

  /** 登录等待单次查询：waiting 续等，终态收敛并刷新列表（用户正在扫码，不打断等待）。 */
  async function pollLoginOnce(login: LoginState): Promise<void> {
    const result = await ports.loginStatus({ loginId: login.loginId })
    if (!active) return
    const next = result?.login
    if (next === undefined || next === null || next.status === 'idle') {
      // 终态 run 已被宿主清理（进程重启）：按失败收敛，刷新列表。
      setState({ login: null })
      setNotice('error', 'accounts.loginFailed')
      await refresh()
      return
    }
    if (next.status === 'waiting') {
      setState({ login: next as LoginState })
      return
    }
    setState({ login: null })
    if (next.status === 'ok') {
      setNotice('ok', 'accounts.loginOk')
      await refresh()
      if (active && typeof next.accountId === 'string') setState({ selectedId: next.accountId })
    } else {
      noticeForReason('error', typeof next.reason === 'string' ? next.reason : undefined, next.status === 'timeout' ? 'accounts.loginTimeout' : 'accounts.loginFailed')
      await refresh()
    }
  }

  /** 采集终态收敛（轮询与取消共用）：清运行态、按终态分流提示并刷新列表摘要。 */
  async function settleCollectTerminal(next: CollectState): Promise<void> {
    setState({ collect: null })
    if (next.collectStatus === 'completed') setNotice(next.truncated === true ? 'warn' : 'ok', next.truncated === true ? 'accounts.truncated' : 'accounts.collectDone')
    // 取消是终态而非失败：固定提示「已取消，未保存本次采集」（快照未变）。
    else if (next.collectStatus === 'cancelled') setNotice('warn', 'collect.cancelled')
    else noticeForReason('error', typeof next.error === 'string' ? next.error : undefined, 'accounts.collectFailed')
    await refresh()
  }

  /** 采集单次查询：宿主重启后 run 丢失（collect_id_required 等）收敛为失败，不静默清空。 */
  async function pollCollectOnce(): Promise<void> {
    const collect = snapshot.collect
    if (collect === null) return
    const result = await ports.collectStatus({ collectId: collect.collectId })
    if (result === null || result.collect === undefined || result.collect === null) {
      if (!active) return
      setState({ collect: null })
      setNotice('error', 'accounts.collectFailed')
      return
    }
    const next = result.collect
    if (!active) return
    if (next === undefined || next === null) {
      setState({ collect: null })
      return
    }
    if (next.collectStatus === 'running') {
      setState({ collect: next })
      return
    }
    await settleCollectTerminal(next)
  }

  return {
    subscribe,
    get,
    init() {
      active = true
      // 冷启动只发一次 accounts.list：挂载恢复 IIFE 复用同一刷新 promise。
      const initialRefresh = snapshot.loaded !== true ? refresh() : null
      if (initialRefresh !== null) void initialRefresh
      // stop 期间迟到的 probeNow 会跳过 finally 清理（active 已翻转），此处兜底重置。
      if (snapshot.probing.size > 0) setState({ probing: new Set() })
      void refreshBrowserStatus()
      const loginWaiting = snapshot.login !== null && snapshot.login.status === 'waiting'
      const collectRunning = snapshot.collect !== null && snapshot.collect.collectStatus === 'running'
      if (loginWaiting || collectRunning) ensurePolling()
      // 挂载恢复（2.1）：账号列表就绪且选中账号确定后，按账号查询一次采集状态；
      // 运行中 → 写入 collect 并启动轮询；用户已点「采集」则丢弃该响应。
      const generationAtRestore = restoreGeneration
      void (async () => {
        if (initialRefresh !== null) await initialRefresh
        if (!active) return
        const selectedId = snapshot.selectedId
        if (selectedId === null || restoreGeneration !== generationAtRestore) return
        try {
          const result = await ports.collectStatus({ accountId: selectedId })
          if (!active || restoreGeneration !== generationAtRestore) return
          // 查询在途时选中账号可能已切换：结果不再指向当前选中即丢弃。
          if (snapshot.selectedId !== selectedId) return
          const next = result?.collect ?? null
          if (next !== null && next.collectStatus === 'running') {
            setState({ collect: next })
            ensurePolling()
          }
        } catch (error: unknown) {
          void error // 恢复查询失败不打断挂载。
        }
      })()
    },
    stop() {
      active = false
      stopPolling()
    },
    select(accountId) {
      if (accountId !== snapshot.selectedId) setState({ selectedId: accountId, notice: null })
    },
    dismissNotice() {
      if (snapshot.notice !== null) setState({ notice: null })
    },
    chromeBlocked() {
      return snapshot.chromeAvailable === false
    },
    async beginLoginFlow(options = {}) {
      const accountId = options.accountId ?? null
      if (snapshot.login !== null && snapshot.login.status === 'waiting') return
      if (this.chromeBlocked()) {
        setNotice('error', 'reason.GOOGLE_CHROME_MISSING', 'GOOGLE_CHROME_MISSING')
        return
      }
      setNotice('error', '')
      try {
        const result = await ports.beginLogin(accountId !== null ? { accountId } : {})
        if (!active) return
        const login = result?.login
        if (login === undefined) {
          noticeForReason('error', undefined, 'accounts.loginFailed')
          return
        }
        setState({ login: login as LoginState })
        if (login.status === 'waiting') ensurePolling()
        else if (login.status === 'ok') {
          setNotice('ok', 'accounts.loginOk')
          await refresh()
          if (active && typeof login.accountId === 'string') setState({ selectedId: login.accountId })
        } else noticeForReason('error', typeof login.reason === 'string' ? login.reason : undefined, login.status === 'timeout' ? 'accounts.loginTimeout' : 'accounts.loginFailed')
      } catch (error) {
        if (active) noticeForReason('error', error instanceof Error && error.message !== 'default' ? error.message : undefined, 'accounts.loginFailed')
      }
    },
    async probeNow(accountId) {
      if (snapshot.probing.has(accountId)) return
      if (this.chromeBlocked()) {
        setNotice('error', 'reason.GOOGLE_CHROME_MISSING', 'GOOGLE_CHROME_MISSING')
        return
      }
      setState({ probing: new Set(snapshot.probing).add(accountId) })
      try {
        const result = await ports.probe({ accountId })
        if (result !== null && result.status === 'error') noticeForReason('error', undefined, 'accounts.probeFailed')
        if (active) await refresh()
      } catch (error) {
        if (active) noticeForReason('error', error instanceof Error ? error.message : undefined, 'accounts.probeFailed')
      } finally {
        // 无条件清理：stop 后残留会让按钮永久卡「检测中」（切页再回来的场景）。
        const next = new Set(snapshot.probing)
        next.delete(accountId)
        setState({ probing: next })
      }
    },
    async removeAccount(accountId) {
      try {
        await ports.removeLocal({ accountId })
        if (!active) return
        setNotice('ok', 'accounts.removedDone')
        await refresh()
      } catch {
        if (active) noticeForReason('error', undefined, 'accounts.actionFailed')
      }
    },
    async startCollectFlow(accountId) {
      restoreGeneration += 1
      const collect = snapshot.collect
      if (collect !== null && collect.collectStatus === 'running') return
      if (this.chromeBlocked()) {
        setNotice('error', 'reason.GOOGLE_CHROME_MISSING', 'GOOGLE_CHROME_MISSING')
        return
      }
      setNotice('error', '')
      try {
        const result = await ports.startCollect({ accountId, idempotencyKey: newKey() })
        if (!active) return
        const next = result?.collect
        if (next === undefined) {
          noticeForReason('error', undefined, 'accounts.collectFailed')
          return
        }
        setState({ collect: next })
        if (next.collectStatus === 'running') ensurePolling()
        else if (next.collectStatus === 'completed') setNotice(next.truncated === true ? 'warn' : 'ok', next.truncated === true ? 'accounts.truncated' : 'accounts.collectDone')
        else noticeForReason('error', typeof next.error === 'string' ? next.error : undefined, 'accounts.collectFailed')
        // 终态（含同步 completed）也要刷新列表（最近采集时间/基本数据随之更新）。
        if (next.collectStatus !== 'running') await refresh()
      } catch (error) {
        if (active) noticeForReason('error', error instanceof Error ? error.message : undefined, 'accounts.collectFailed')
      }
    },
    async cancelCollectFlow() {
      const collect = snapshot.collect
      // 只取消本机运行中的 run；自然结束后按钮已回「采集」，不再发取消请求（X2）。
      if (collect === null || collect.collectStatus !== 'running') return
      try {
        const result = await ports.cancelCollect({ collectId: collect.collectId })
        if (!active) return
        const next = result?.collect
        // Host 已同步落终态；回包异常时留给下一轮 collect.status 收敛，不打断采集。
        if (next !== undefined && next !== null && next.collectStatus !== 'running') await settleCollectTerminal(next)
      } catch (error) {
        void error // 取消请求失败不打断运行中的采集：下一轮 collect.status 继续观察终态。
      }
    },
    async tick() {
      if (timer !== null) {
        clearSchedule(timer)
        timer = null
        await pollOnce()
        ensurePolling()
      }
    },
  }
}

/** 生产接线（页面用）：全部经同源 hostAction。 */
export function createAccountsMachineWithHost(): AccountsMachine {
  return createAccountsMachine({
    listAccounts: async () => await hostAction('accounts.list') as { accounts?: AccountRow[] },
    beginLogin: async args => await hostAction('account.beginLogin', args ?? {}) as { login?: LoginState },
    loginStatus: async args => await hostAction('account.loginStatus', args) as { login?: { status: string; loginId?: string | null; accountId?: string | null; nickname?: string | null; avatar?: string | null; reason?: string | null } },
    probe: async args => await hostAction('account.probe', args) as { status?: string; sessionStatus?: string },
    removeLocal: async args => await hostAction('account.removeLocal', args),
    startCollect: async args => await hostAction('collect.start', args) as { collect?: CollectState },
    collectStatus: async args => await hostAction('collect.status', args) as { status?: string; collect?: CollectState | null },
    cancelCollect: async args => await hostAction('collect.cancel', args) as { status?: string; collect?: CollectState | null },
    browserStatus: async () => await hostAction('browser.status') as { chromeAvailable?: boolean },
  })
}
