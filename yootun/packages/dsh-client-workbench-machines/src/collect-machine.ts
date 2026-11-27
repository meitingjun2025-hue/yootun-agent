/**
 * 单账号采集 machine：乐观运行态启动、按账号轮询（单飞）、运行中账号集合、
 * 宿主重启丢记录清乐观态、挂载恢复（restore，用户已发起则丢弃——C4）、取消。
 * 终态经 `onSettled(view)` 通知页面（弹 toast 与刷新由适配层承担）。
 * @module
 */
import { createLatest, type LatestGuard } from './guards.ts'
import { createPoller, type Poller, type PollerSchedule } from './polling.ts'
import type { MachineStore } from './types.ts'

/** 单账号采集 machine 的注入面。视图按账号分类（running / 终态）由适配层提供。 */
export interface CollectMachinePorts<CollectView> {
  /** 发起单账号采集（collect.start），失败时抛出（hostAction 语义）。 */
  start(accountId: string, options?: Record<string, unknown>): Promise<{ collect: CollectView | null; reason?: unknown }>
  /** 按账号查询采集状态；`collect: null` 表示宿主重启丢记录，`recovery` 为恢复判定投影。 */
  status(accountId: string): Promise<{ collect: CollectView | null; interrupted?: unknown; recovery?: unknown }>
  /** 查询全局运行中的账号（collect.running / runningAccountIds）。 */
  running(): Promise<{ runningAccountIds: string[] } | null>
  /** 取消该账号的采集（无取消路由的插件不提供）。 */
  cancel?(accountId: string): Promise<unknown>
  /** 视图所属账号（视图无 accountId 时回退轮询目标）。 */
  accountIdOf(view: CollectView, fallback: string): string
  /** 乐观运行投影工厂（start 点击瞬间的 running 视图；视图含 accountId 字段时由适配层填充）。 */
  optimisticRunning(accountId: string): CollectView
  /** 视图状态（running / completed / failed / cancelled / ...）。 */
  statusOf(view: CollectView): string
  /** 轮询间隔毫秒。 */
  pollIntervalMs: number
  poller: PollerSchedule
  /** 终态收敛通知（失败 toast 与数据刷新由适配层承担）。 */
  onSettled(accountId: string, view: CollectView): void
  /** 宿主重启丢记录通知（recovery 为适配层的 G-2 恢复判定投影，页面据此分流 toast/横幅）。 */
  onLost(recovery?: unknown): void
  /** 中断摘要到达通知（2.5 横幅数据源）。 */
  onInterrupted?(interrupted: unknown): void
}

/** 单账号采集 machine 状态。 */
export interface CollectState<CollectView> {
  /** 乐观运行投影（页面发起或恢复的 running 记录）。 */
  record: CollectView | null
  /** 运行中的账号集合（collect.running / runningAccountIds 权威投影）。 */
  runningAccountIds: string[]
  /** 最近一次启动失败原因（稳定码或 hostAction 错误消息；null = 无）。 */
  startReason: string | null
}

/** 单账号采集 machine。 */
export interface CollectMachine<CollectView> extends MachineStore<CollectState<CollectView>> {
  /** 发起单账号采集：乐观运行态，失败回到空闲并落 startReason（C1）。 */
  start(accountId: string, options?: Record<string, unknown>): Promise<void>
  /** 按账号启动轮询（同账号幂等；换目标由发起方显式停表）。 */
  beginPolling(accountId: string): void
  /** 停止单账号轮询。 */
  stopPolling(): void
  /** 该账号的轮询是否在途（终态与丢记录自动翻转；发起/恢复路与页面让位判定用）。 */
  isPolling(accountId: string): boolean
  /** 取消该账号运行中的采集（无取消路由的插件由适配层决定是否注入）。 */
  cancel(accountId: string): Promise<void>
  /** 挂载恢复：注入 collect.running 与 collect.status 两路查询结果（C4：用户已发起则丢弃）。 */
  restore(input: { running: { collect: CollectView | null; runningAccountIds: string[] } | null; selected: { collect: CollectView | null } | null; accountId: string }): void
  /** 恢复代次失效（用户已发起时页面调用，等价的显式守卫入口）。 */
  invalidateRestore(): void
  /** 停止全部轮询（页面卸载）。 */
  stop(): void
}

/** 按账号的轮询句柄。 */
interface AccountPoller {
  poller: Poller
  guard: LatestGuard
}

/**
 * Create a collect machine. 乐观运行态：start 立即进入 running 投影，Host 回
 * `started: false` 或丢记录时清掉（C3）；恢复结果到达前用户已 start 则丢弃（C4）。
 * @param ports - 注入面。
 * @returns the machine.
 */
export function createCollectMachine<CollectView>(ports: CollectMachinePorts<CollectView>): CollectMachine<CollectView> {
  let state: CollectState<CollectView> = { record: null, runningAccountIds: [], startReason: null }
  const listeners = new Set<() => void>()
  const pollers = new Map<string, AccountPoller>()
  let restoreGeneration = 0
  let restoreInitiated = false

  const set = (next: CollectState<CollectView>): void => {
    state = next
    listeners.forEach(listener => listener())
  }

  const tick = (accountId: string, poller: AccountPoller): Promise<void> => {
    const seq = poller.guard.take()
    return ports.status(accountId).then((statusRes) => {
      if (!poller.guard.isCurrent(seq)) return
      if (ports.onInterrupted !== undefined && statusRes.interrupted !== undefined) ports.onInterrupted(statusRes.interrupted)
      const view = statusRes.collect
      if (view === null) {
        // 宿主重启/插件重载丢记录（C3）：清乐观态并停该账号轮询。
        poller.poller.stop()
        pollers.delete(accountId)
        set({ ...state, record: state.record !== null && ports.accountIdOf(state.record, accountId) === accountId ? null : state.record, runningAccountIds: state.runningAccountIds.filter(id => id !== accountId) })
        ports.onLost(statusRes.recovery)
        return
      }
      const status = ports.statusOf(view)
      const resolvedAccountId = ports.accountIdOf(view, accountId)
      if (status === 'running') {
        set({ ...state, record: resolvedAccountId === accountId ? view : state.record, runningAccountIds: state.runningAccountIds.includes(resolvedAccountId) ? state.runningAccountIds : [...state.runningAccountIds, resolvedAccountId] })
        return
      }
      // 终态：停轮询、落终态并通知。
      poller.poller.stop()
      pollers.delete(accountId)
      set({ ...state, record: resolvedAccountId === accountId ? view : state.record, runningAccountIds: state.runningAccountIds.filter(id => id !== resolvedAccountId) })
      ports.onSettled(resolvedAccountId, view)
    }).catch(() => undefined)
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async start(accountId, options) {
      if (accountId === '') return
      restoreInitiated = true
      restoreGeneration += 1
      // 乐观运行态：点击瞬间进入 running 投影（端口 start 回执到达前）。
      const optimisticSame = state.record !== null && ports.accountIdOf(state.record, accountId) === accountId
      set({ ...state, startReason: null, runningAccountIds: state.runningAccountIds.includes(accountId) ? state.runningAccountIds : [...state.runningAccountIds, accountId], record: optimisticSame ? state.record : ports.optimisticRunning(accountId) })
      try {
        const result = await ports.start(accountId, options)
        if (result.collect === null) {
          // started:false / 无投影：回空闲并落原因（C1 不进入运行态）。
          set({ record: null, runningAccountIds: state.runningAccountIds.filter(id => id !== accountId), startReason: typeof result.reason === 'string' ? result.reason : 'collect_busy' })
          return
        }
        set({ ...state, record: result.collect, runningAccountIds: state.runningAccountIds.includes(accountId) ? state.runningAccountIds : [...state.runningAccountIds, accountId], startReason: null })
        this.beginPolling(accountId)
      } catch (error) {
        set({ record: null, runningAccountIds: state.runningAccountIds.filter(id => id !== accountId), startReason: error instanceof Error ? error.message : 'collect_busy' })
      }
    },

    beginPolling(accountId) {
      if (pollers.has(accountId)) return
      const poller: AccountPoller = {
        poller: createPoller({ schedule: ports.poller.schedule, cancel: ports.poller.cancel, intervalMs: ports.pollIntervalMs }),
        guard: createLatest(),
      }
      pollers.set(accountId, poller)
      poller.poller.start(() => tick(accountId, poller))
    },

    stopPolling() {
      for (const poller of pollers.values()) poller.poller.stop()
      pollers.clear()
    },

    isPolling(accountId) {
      return pollers.has(accountId)
    },

    async cancel(accountId) {
      if (ports.cancel === undefined) return
      await ports.cancel(accountId)
    },

    restore(input) {
      if (restoreInitiated) return
      const { running, selected, accountId } = input
      // collect.running 路：运行中记录 + 全局运行集合。
      if (running !== null) {
        const view = running.collect
        if (view !== null && ports.statusOf(view) === 'running') {
          const viewAccount = ports.accountIdOf(view, accountId)
          set({ ...state, record: viewAccount === accountId ? view : state.record, runningAccountIds: state.runningAccountIds.includes(viewAccount) ? state.runningAccountIds : [...state.runningAccountIds, viewAccount] })
          this.beginPolling(viewAccount)
        }
      }
      // collect.status 路（选中账号）：恢复运行态或终态投影。
      if (selected !== null) {
        const view = selected.collect
        if (view === null) return
        const viewAccount = ports.accountIdOf(view, accountId)
        if (ports.statusOf(view) === 'running') {
          set({ ...state, record: viewAccount === accountId ? view : state.record, runningAccountIds: state.runningAccountIds.includes(viewAccount) ? state.runningAccountIds : [...state.runningAccountIds, viewAccount] })
          this.beginPolling(viewAccount)
          return
        }
        // 终态：落投影（不覆盖其他账号的运行中记录——douyin 语义）。
        if (state.record === null || ports.accountIdOf(state.record, accountId) === accountId) {
          set({ ...state, record: view })
        }
      }
    },

    invalidateRestore() {
      restoreInitiated = true
      restoreGeneration += 1
    },

    stop() {
      for (const poller of pollers.values()) poller.poller.stop()
      pollers.clear()
    },
  }
}
