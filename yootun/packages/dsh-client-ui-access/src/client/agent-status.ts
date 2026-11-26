/**
 * 设置页「智能体工具」行的取值层（分册 08 §4.2 状态出口）：同源状态路由的
 * 拉取与 wire 解析、可见性驱动的 5 秒轮询器、路由快照到状态点与文案的显示
 * 投影。轮询器的可见性与定时依赖可注入，测试用受控替身驱动。
 * @module
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import { ACCESS_AGENT_STATUS_PATH } from '../access-constants.ts'
import type { AccessLocaleKey } from './locales.ts'

/** 状态路由 `state` 的封闭取值（与 host 半 `AgentFaceState` 同集）。 */
export type AgentStatusState = 'disabled' | 'connecting' | 'connected' | 'failed' | 'waiting-credentials'

/** 状态路由 200 响应的客户端投影（wire 解析产物）。 */
export interface AgentStatusView {
  /** 连接状态。 */
  state: AgentStatusState
  /** 官方状态句柄给出的尝试次数。 */
  attempt: number
  /** `connected` 时官方登记的工具数，其余为 0。 */
  count: number
  /** `failed` 且已排定重建时的下次重建时间（ISO 8601）；其余省略。 */
  retryAt?: string
}

/** 轮询器的 useSyncExternalStore 快照（引用稳定）。 */
export interface AgentStatusSnapshot {
  /** 首次拉取是否已落定；未落定时行值显示为空态（状态点 idle）。 */
  ready: boolean
  /** 快照值；`ready` 后为 undefined 表示路由缺失或拉取失败（→ 未加载）。 */
  view: AgentStatusView | undefined
}

/** 页面可见性面（浏览器 `document` 实现的注入缝）。 */
export interface AgentStatusVisibility {
  /** 当前是否可见。 */
  visible(): boolean
  /** 订阅可见性变化；返回退订函数。 */
  onChange(listener: () => void): () => void
}

/** 轮询器的依赖注入面。 */
export interface AgentStatusPollerDeps {
  /** 拉取一次快照；返回 undefined 表示路由缺失或拉取失败。 */
  fetch: (signal: AbortSignal) => Promise<AgentStatusView | undefined>
  /** 页面可见性（隐藏即停）。 */
  visibility: AgentStatusVisibility
  /** 间隔调度（默认 `intervalEvery`）；测试注入受控时钟。 */
  every?: (intervalMs: number, handler: () => void) => () => void
  /** 轮询间隔毫秒（默认 {@link AGENT_STATUS_POLL_INTERVAL_MS}）。 */
  intervalMs?: number
}

/** 轮询器对外面：React 订阅 + 释放。 */
export interface AgentStatusPoller {
  /** useSyncExternalStore 订阅面。 */
  subscribe(observer: () => void): () => void
  /** useSyncExternalStore 快照面（两次变化间引用稳定）。 */
  getSnapshot(): AgentStatusSnapshot
  /** 释放定时器、在途请求与可见性订阅。 */
  dispose(): void
}

/** 轮询间隔（毫秒）：区块挂载且页面可见时每 5 秒。 */
export const AGENT_STATUS_POLL_INTERVAL_MS = 5_000

/** 浏览器真实的间隔调度（setInterval 适配）。 */
export function intervalEvery(intervalMs: number, handler: () => void): () => void {
  const timer = setInterval(handler, intervalMs)
  return () => { clearInterval(timer) }
}

/** 浏览器真实的页面可见性（document.visibilityState + visibilitychange）。 */
export function documentVisibility(): AgentStatusVisibility {
  return {
    visible: () => document.visibilityState === 'visible',
    onChange: (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  }
}

/**
 * Parse one status-route payload. Values cross an HTTP wire boundary, so the
 * read site — not the type system — rejects malformed payloads.
 * @param value - the parsed response JSON.
 * @returns the view, or `undefined` when the payload is not usable.
 */
export function parseAgentStatus(value: unknown): AgentStatusView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { status?: unknown; state?: unknown; attempt?: unknown; count?: unknown; retryAt?: unknown }
  if (record.status !== 'ok') return undefined
  const state = record.state
  if (state !== 'disabled' && state !== 'connecting' && state !== 'connected' && state !== 'failed' && state !== 'waiting-credentials') return undefined
  const attempt = record.attempt
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 0) return undefined
  const count = record.count
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined
  const retryAt = record.retryAt
  if (retryAt !== undefined && typeof retryAt !== 'string') return undefined
  return { state, attempt, count, ...(retryAt !== undefined ? { retryAt } : {}) }
}

/**
 * Fetch one agent-status snapshot over the same-origin route. A non-OK
 * response (404 missing route, 503 disposing) reads as `undefined`, as does
 * a transport failure; the caller turns both into the not-loaded display.
 * @param signal - cancellation signal owned by the poll cycle.
 * @returns the view, or `undefined` when the route is unavailable.
 */
export async function fetchAgentStatus(signal: AbortSignal): Promise<AgentStatusView | undefined> {
  const response = await fetch(ACCESS_AGENT_STATUS_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) return undefined
  return parseAgentStatus(await response.json())
}

/**
 * Create the visibility-driven poller: while the page is visible it pulls
 * once immediately and then on the interval; hiding stops the interval and
 * aborts the in-flight request (late results are discarded); returning to
 * visibility pulls immediately again. Dispose releases everything.
 * @param deps - fetcher, visibility, and optional scheduling seams.
 * @returns the poller.
 */
export function createAgentStatusPoller(deps: AgentStatusPollerDeps): AgentStatusPoller {
  const every = deps.every ?? intervalEvery
  const intervalMs = deps.intervalMs ?? AGENT_STATUS_POLL_INTERVAL_MS
  let snapshot: AgentStatusSnapshot = { ready: false, view: undefined }
  const observers = new Set<() => void>()
  let cancelInterval: (() => void) | undefined
  let controller: AbortController | undefined
  /** Monotonic pull id; a stale result (superseded pull or a stop) never publishes. */
  let generation = 0

  const publish = (): void => {
    for (const observer of [...observers]) observer()
  }

  const pull = async (): Promise<void> => {
    const id = ++generation
    controller?.abort()
    const next = new AbortController()
    controller = next
    try {
      const view = await deps.fetch(next.signal)
      if (id !== generation) return
      snapshot = { ready: true, view }
    } catch {
      if (id !== generation) return
      snapshot = { ready: true, view: undefined }
    }
    publish()
  }

  const setActive = (active: boolean): void => {
    if (active === (cancelInterval !== undefined)) return
    if (active) {
      void pull()
      cancelInterval = every(intervalMs, () => { void pull() })
      return
    }
    generation += 1
    controller?.abort()
    controller = undefined
    cancelInterval?.()
    cancelInterval = undefined
  }

  const unsubscribeVisibility = deps.visibility.onChange(() => { setActive(deps.visibility.visible()) })
  setActive(deps.visibility.visible())

  return {
    subscribe: (observer) => {
      observers.add(observer)
      return () => { observers.delete(observer) }
    },
    getSnapshot: () => snapshot,
    dispose: (): void => {
      setActive(false)
      unsubscribeVisibility()
      observers.clear()
    },
  }
}

/** 「智能体工具」行的显示投影：状态点取值与词典键及插值。 */
export interface AgentStatusPresentation {
  /** 状态点（官方 StateDot 语义）。 */
  dot: StateDotState
  /** 词典键（`yootun.access` namespace）。 */
  key: AccessLocaleKey
  /** 词典插值；省略表示模板无占位符。 */
  values?: Record<string, string>
}

/**
 * Seconds until the scheduled rebuild, rounded up and floored at zero; an
 * unusable `retryAt` reads as zero（窗口极短：触发即清除）.
 * @param retryAt - the ISO 8601 rebuild time, when scheduled.
 * @param now - the render-time clock in epoch milliseconds.
 * @returns the countdown seconds.
 */
function retrySeconds(retryAt: string | undefined, now: number): number {
  const at = retryAt !== undefined ? Date.parse(retryAt) : Number.NaN
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.ceil((at - now) / 1000))
}

/**
 * Project one poller view onto the row's dot and copy. `undefined`（路由
 * 缺失或拉取失败）显示未加载；倒计时秒数由 `retryAt` 与当前时间算出。
 * @param view - the current view, or `undefined` when unavailable.
 * @param now - the render-time clock in epoch milliseconds.
 * @returns the presentation.
 */
export function agentStatusPresentation(view: AgentStatusView | undefined, now: number): AgentStatusPresentation {
  if (view === undefined) return { dot: 'warning', key: 'agent.notLoaded' }
  switch (view.state) {
    case 'connected':
      return { dot: 'done', key: 'agent.connected', values: { count: String(view.count) } }
    case 'connecting':
      // 官方 attempt 是此前失败的次数；对用户显示「第 N 次」为进行中的第 N+1 次。
      return { dot: 'ongoing', key: 'agent.connecting', values: { attempt: String(view.attempt + 1) } }
    case 'failed':
      return { dot: 'error', key: 'agent.failed', values: { seconds: String(retrySeconds(view.retryAt, now)) } }
    case 'waiting-credentials':
      return { dot: 'warning', key: 'agent.waitingCredentials' }
    case 'disabled':
      return { dot: 'idle', key: 'agent.disabled' }
  }
}
