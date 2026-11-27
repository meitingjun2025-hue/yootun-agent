/**
 * 登录流 machine：begin 拿 key → 立即轮询 + 周期轮询 status → 终态或 idle 停
 * 轮询并触发一次 `onSettled`。单飞（上一拍未返回不发下一拍）；stop 之后迟到
 * 的响应不改状态（L4）。页面经 useSyncExternalStore 订阅登录卡状态。
 * @module
 */
import { createLatest, type LatestGuard } from './guards.ts'
import { createPoller, type Poller, type PollerSchedule } from './polling.ts'
import type { MachineStore } from './types.ts'

/** 登录 machine 的注入面。视图分类（active / terminal / idle）由适配层提供。 */
export interface LoginMachinePorts<LoginView> {
  /** 发起扫码登录（account.beginLogin），返回含 loginKey 的视图。 */
  begin(args?: Record<string, unknown>): Promise<LoginView>
  /** 按 loginKey 查询登录状态。 */
  status(key: string): Promise<LoginView>
  /** 视图的登录 key（轮询句柄；空串表示本次发起失败）。 */
  keyOf(view: LoginView): string
  /** 视图状态（适配层从自己的 schema 投影）。 */
  statusOf(view: LoginView): string
  /** 仍在进行中的状态集合（轮询继续）。 */
  activeStatuses: readonly string[]
  /** 终态集合：命中即停轮询并触发 onSettled。 */
  terminalStatuses: readonly string[]
  /** 轮询间隔毫秒。 */
  pollIntervalMs: number
  poller: PollerSchedule
  /** 终态收敛通知（页面据此弹 toast 并刷新账号列表）。 */
  onSettled(view: LoginView): void
}

/** 登录 machine 状态：登录卡视图（null = 无进行中登录，页面收起卡片）。 */
export interface LoginState<LoginView> {
  login: LoginView | null
}

/** 登录 machine。 */
export interface LoginMachine<LoginView> extends MachineStore<LoginState<LoginView>> {
  /** 发起登录并进入轮询；已有进行中登录时幂等（复用既有卡片）。 */
  begin(args?: Record<string, unknown>): Promise<void>
  /** 停止轮询；迟到的响应不改状态（L4）。 */
  stop(): void
}

/**
 * Create a login machine. 轮询到终态或 idle 停止并触发一次 onSettled（L3）；
 * 上一拍未返回不发下一拍（L2）；首拍立即发出（L1）。
 * @param ports - 注入面。
 * @returns the machine.
 */
export function createLoginMachine<LoginView>(ports: LoginMachinePorts<LoginView>): LoginMachine<LoginView> {
  const poller: Poller = createPoller({ schedule: ports.poller.schedule, cancel: ports.poller.cancel, intervalMs: ports.pollIntervalMs })
  const guard: LatestGuard = createLatest()
  let state: LoginState<LoginView> = { login: null }
  const listeners = new Set<() => void>()
  let stopped = false

  const set = (next: LoginState<LoginView>): void => {
    state = next
    listeners.forEach(listener => listener())
  }

  const tick = async (key: string, seq: number): Promise<void> => {
    try {
      const view = await ports.status(key)
      if (stopped || !guard.isCurrent(seq)) return
      const status = ports.statusOf(view)
      if (ports.activeStatuses.includes(status)) {
        set({ login: view })
        return
      }
      poller.stop()
      set({ login: null })
      ports.onSettled(view)
    } catch {
      // 单次轮询失败不打断等待（用户正在扫码）。
    }
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async begin(args) {
      stopped = false
      const view = await ports.begin(args)
      if (stopped) return
      const key = ports.keyOf(view)
      if (key === '') return
      const status = ports.statusOf(view)
      if (ports.activeStatuses.includes(status)) {
        set({ login: view })
        const seq = guard.take()
        poller.start(() => tick(key, seq))
      }
    },

    stop() {
      stopped = true
      poller.stop()
    },
  }
}
