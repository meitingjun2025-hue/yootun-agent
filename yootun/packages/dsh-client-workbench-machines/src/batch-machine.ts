/**
 * 批量采集 machine：start 乐观运行态、单飞（在途重复 start 不发请求）。状态
 * 注入经 `restore` / `beginPolling`（挂载恢复与消费方轮询喂数；本 machine
 * 不持定时器，终态判定与 `onFinished` 收敛由消费方的轮询回调承担）。用户已
 * 发起则丢弃恢复结果（入口单飞 + 恢复代次守卫）。
 * @module
 */
import type { MachineStore } from './types.ts'

/** 批量采集 machine 的注入面。视图投影由适配层承担（BatchView 为通用形状）。 */
export interface BatchMachinePorts<BatchView> {
  /** 发起批量采集（collectAll.start）；失败抛出，成功返回含批量视图的响应。 */
  start(): Promise<{ batch: BatchView | null }>
  /** 查询批量状态（collectAll.status）。 */
  status(): Promise<{ batch: BatchView | null }>
  /** 取消批量（collectAll.cancel）。 */
  cancel(): Promise<unknown>
  /** 视图的批量运行判定（status === 'running' 等）。 */
  runningOf(view: BatchView): boolean
  /** 乐观运行投影工厂（点击瞬间的 probing 投影）。 */
  optimisticRunning(): BatchView
  /** 终态收敛通知（数据刷新由适配层承担）。 */
  onFinished(view: BatchView): void
  /** 批量运行中判定变化通知（账号栏入口禁用等；恢复确认在途也通知）。 */
  onRunningChanged(running: boolean): void
}

/** 批量 machine 状态：批量面板投影（null = 无批量记录，页面不渲染面板）。 */
export interface BatchState<BatchView> {
  batch: BatchView | null
  /** 挂载恢复确认在途（collect.running 已报批量运行中、collectAll.status 未返回）。 */
  recoveryPending: boolean
}

/** 批量采集 machine。 */
export interface BatchMachine<BatchView> extends MachineStore<BatchState<BatchView>> {
  /** 发起批量采集：单飞 + 乐观运行态 + 轮询；成功启动清空中断摘要回调。 */
  start(): Promise<void>
  /** 启动轮询（挂载恢复 running 批量复用）。 */
  beginPolling(view: BatchView): void
  /** 取消批量。 */
  cancel(): Promise<void>
  /** 挂载恢复：注入 collectAll.status 的批量视图（null = Host 无批量记录）。 */
  restore(view: BatchView | null): void
  /** 挂载恢复确认在途标记（collect.running 已报批量运行中的窗口）。 */
  markRecoveryPending(): void
  /** 停止轮询（页面卸载）。 */
  stop(): void
}

/**
 * Create a batch machine. 终态（status 非 running）停轮询并触发一次
 * `onFinished`；`start` 在途时第二次 start 不发请求（B2）。
 * @param ports - 注入面。
 * @returns the machine.
 */
export function createBatchMachine<BatchView>(ports: BatchMachinePorts<BatchView>): BatchMachine<BatchView> {
  let state: BatchState<BatchView> = { batch: null, recoveryPending: false }
  const listeners = new Set<() => void>()
  let inFlight = false
  let restoreInitiated = false

  const set = (next: BatchState<BatchView>): void => {
    state = next
    listeners.forEach(listener => listener())
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async start() {
      if (inFlight) return
      inFlight = true
      restoreInitiated = true
      set({ batch: ports.optimisticRunning(), recoveryPending: false })
      try {
        const res = await ports.start()
        inFlight = false
        set({ batch: res.batch, recoveryPending: false })
        if (res.batch !== null && ports.runningOf(res.batch)) ports.onRunningChanged(true)
      } catch (error) {
        inFlight = false
        set({ batch: null, recoveryPending: false })
        throw error
      }
    },

    beginPolling(view) {
      set({ batch: view, recoveryPending: false })
    },

    async cancel() {
      await ports.cancel()
    },

    restore(view) {
      if (restoreInitiated) return
      set({ batch: view, recoveryPending: false })
      if (view !== null && ports.runningOf(view)) ports.onRunningChanged(true)
    },

    markRecoveryPending() {
      // 恢复确认窗口标记；用户已发起批量后（代次失效）迟到的 collect.running
      // 不再锁入口（与 restore 的丢弃语义一致）。
      if (restoreInitiated) return
      set({ ...state, recoveryPending: true })
    },

    stop() {
      // 轮询由页面挂载的 poller 生命周期管理（machine 不持内置定时器）。
    },
  }
}

/** 批量轮询的驱动面：页面挂载恢复/轮询 tick 使用（与 machine 状态解耦的读取）。 */
export interface BatchPollerDeps<BatchView> {
  status(): Promise<{ batch: BatchView | null }>
  runningOf(view: BatchView): boolean
  onFinished(view: BatchView): void
  onTick(view: BatchView): void
  onStopped(): void
}

/**
 * 单次批量状态读取并按结果回调（页面 tick 用）：running → onTick 继续；
 * 非 running → onFinished 一次 + onStopped。
 * @param deps - 注入面。
 * @returns the batch view (may be null when Host has no record).
 */
export async function pollBatchOnce<BatchView>(deps: BatchPollerDeps<BatchView>): Promise<BatchView | null> {
  const res = await deps.status()
  const view = res.batch
  if (view === null) return null
  if (!deps.runningOf(view)) {
    deps.onFinished(view)
    deps.onStopped()
    return view
  }
  deps.onTick(view)
  return view
}
