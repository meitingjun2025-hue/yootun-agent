/**
 * Agent 面 client 挂载监督器：按激活门禁动态挂载/卸载一个
 * `@deepseek-ai/dsh-mcp-client` 子实例（serverName `yootun-agent`）。
 * 生命周期：未激活零连接；激活后单实例；key 更新销毁重建；key 移除销毁；
 * 官方重连耗尽（`failed`）后按退避自愈重建，`connected` 复位退避；网络初始
 * 化失败不阻塞启动（failOnStartupError=false + 重连策略）；插件卸载销毁子
 * 实例与全部监听。Authorization 只以 `Bearer ${credential:MODELS_API_KEY}`
 * 模板进入 transport（expandTemplates 展开、诊断脱敏），本插件不把解析值
 * 写入任何状态或日志。`snapshot()` 是设置页状态路由的只读内存投影，不触发
 * 任何网络请求。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { McpClientHost, type McpConnectionStatus, type McpConnectionStatusHandle, type McpServerInstance, type ReconnectConfig } from '@deepseek-ai/dsh-mcp-client'
import { activationServices, isActivated } from './gate.ts'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE, agentUrl, AGENT_SERVER_NAME, TENANT_CODE } from './constants.ts'

/** 设置页可见的 Agent 面连接状态（状态路由响应的 `state` 取值）。 */
export type AgentFaceState = 'disabled' | 'connecting' | 'connected' | 'failed' | 'waiting-credentials'

/**
 * 监督器状态的只读投影：状态路由 200 响应体在 `status: 'ok'` 之外的全部
 * 字段。不含 key、URL 或任何凭证相关信息。
 */
export interface AgentFaceSnapshot {
  /** 连接状态；`disabled` = 门禁未通过（未激活 / 版本不符 / 无 key）。 */
  state: AgentFaceState
  /** 官方状态句柄给出的尝试次数；`disabled` 时为 0。 */
  attempt: number
  /** 当前状态首次出现的 ISO 8601 时间。 */
  since: string
  /** `connected` 时官方登记的工具数（官方 `connected` 事件的 `toolCount`），其余状态为 0。 */
  count: number
  /** `failed` 且退避重建已排定时给出下次重建时间（ISO 8601）；其余省略。 */
  retryAt?: string
}

/** The supervisor's public face: request reevaluation, read state, release everything. */
export interface AgentSupervisor {
  /** Re-run the gate (serialized); mounts, unmounts, or remounts accordingly. */
  reevaluate(reason: string): void
  /** Read-only projection of the face state for the settings status route; never performs I/O. */
  snapshot(): AgentFaceSnapshot
  /**
   * Mark the supervisor stopped so scheduled evaluations become no-ops, clear
   * the pending rebuild timer and the status subscription, then dispose the
   * live child. Listeners themselves ride the plugin fiber and are removed
   * with it; plugin unload additionally calls this through its effect.
   */
  dispose(): Promise<void>
}

/** Delay scheduler seam (defaults to real timers); tests inject a controlled clock. */
export type DelayScheduler = (handler: () => void, delayMs: number) => () => void

/** Injectable seams and budgets for {@link createSupervisor}. */
export interface SupervisorOptions {
  /** 自愈退避基值毫秒（Config `rebuildBackoffMs`，1000..600000）。 */
  rebuildBackoffMs: number
  /** 退避抖动随机源（默认 `Math.random`）；测试注入定值。 */
  random?: () => number
  /** 退避定时调度（默认真实定时器）；测试注入受控时钟。 */
  delay?: DelayScheduler
  /** 官方重连策略覆盖：产品组合省略（官方默认策略）；仅测试注入小预算以加速 `failed`。 */
  reconnect?: ReconnectConfig
}

/** Per-call timeout budget (ms); metadata-heavy product tools stay under it. */
const TOOL_CALL_TIMEOUT_MS = 60_000

/** Transport closure budget (ms), mirroring the mcp-client default. */
const CLOSE_TIMEOUT_MS = 5_000

/** 退避上限基数（毫秒）：实际上限 = max(基值, 本值)，固定不随基值缩小。 */
const BACKOFF_CEILING_BASE_MS = 300_000

/** Configuration path that names the Agent server in validation failures. */
const CONFIG_PATH: readonly string[] = ['yootun-managed-mcp', 'agent']

/** Real-timer {@link DelayScheduler}. */
const realDelay: DelayScheduler = (handler, delayMs) => {
  const timer = setTimeout(handler, delayMs)
  return () => { clearTimeout(timer) }
}

/** One official status folded into the face projection's inputs. */
interface MappedStatus {
  state: AgentFaceState
  attempt: number
  count: number
}

/**
 * Map one official connection status onto the face projection. States this
 * composition cannot reach keep a conservative neighbour: an OAuth wait reads
 * as a credential wait, a closed generation as still connecting.
 * @param status - the published official status.
 * @param lastAttempt - attempt count observed before this status.
 * @returns the projection inputs.
 */
function mapStatus(status: McpConnectionStatus, lastAttempt: number): MappedStatus {
  switch (status.state) {
    case 'connecting':
    case 'reconnecting':
      // reconnecting 是官方自动重连预算内的退避等待，对外同属连接中。
      return { state: 'connecting', attempt: status.attempt, count: 0 }
    case 'connected':
      return { state: 'connected', attempt: 0, count: status.toolCount }
    case 'failed':
      // 官方 failed 不携带 attempt；保留耗尽前的最后一次计数。
      return { state: 'failed', attempt: lastAttempt, count: 0 }
    case 'waiting-credentials':
    case 'waiting-authorization':
      return { state: 'waiting-credentials', attempt: 0, count: 0 }
    case 'closed':
      return { state: 'connecting', attempt: 0, count: 0 }
  }
}

/**
 * Create the mount supervisor on the plugin context. Listeners ride the
 * plugin fiber (auto-removed on unload); the child mounts under the same
 * fiber, so final disposal unwinds it with the plugin.
 * @param ctx - the plugin context carrying the tool registry.
 * @param options - backoff budget and test seams.
 * @returns the supervisor handle.
 */
export function createSupervisor(ctx: Context, options: SupervisorOptions): AgentSupervisor {
  // 桌面 profile 的官方 mcp-manager 已在根作用域注册 `mcpClientHost`，同名服务重复注册会抛错；
  // 隔离子作用域各用各的键，且继承本插件的 fiber，host 与其挂载的子实例仍随本插件结束。
  const host = new McpClientHost(ctx.isolate('mcpClientHost'))
  const baseBackoffMs = options.rebuildBackoffMs
  const backoffCapMs = Math.max(baseBackoffMs, BACKOFF_CEILING_BASE_MS)
  const jitter = options.random ?? Math.random
  const delay = options.delay ?? realDelay
  let child: McpServerInstance | undefined
  /** 已挂载子实例的状态句柄；激活完成后由 `ready` 给出。 */
  let handle: McpConnectionStatusHandle | undefined
  let stopped = false
  let queued = false
  let tail: Promise<void> = Promise.resolve()
  /** Whether the mounted verdict matches a live child (flipped by mount/unmount and failed starts). */
  let mounted = false
  /** Set by credential updates: the next evaluation must destroy and rebuild the child. */
  let credentialDirty = false
  /** 待触发的退避重建定时器的取消柄；undefined = 无排定重建（一次失败只对应一次重建）。 */
  let rebuildCancel: (() => void) | undefined
  /** 当前子实例状态句柄订阅的取消柄；unmount 与 dispose 释放。 */
  let unsubscribeStatus: (() => void) | undefined
  /** 自愈退避当前值；`connected` 复位到基值，重建触发时翻倍。 */
  let backoffMs = baseBackoffMs

  // —— 面投影（设置页状态路由的唯一读数来源）——
  let faceState: AgentFaceState = 'disabled'
  let faceSince = new Date()
  let faceAttempt = 0
  let faceCount = 0
  let faceRetryAt: string | undefined

  /** Update the projection; `since` refreshes only when the state itself changes. */
  const setFace = (state: AgentFaceState, attempt: number, count: number): void => {
    if (state !== faceState) {
      faceState = state
      faceSince = new Date()
      if (state !== 'failed') faceRetryAt = undefined
    }
    faceAttempt = attempt
    faceCount = count
  }

  /** Clear the pending rebuild timer and its `retryAt`; event evaluations take over from it. */
  const clearRebuild = (): void => {
    if (rebuildCancel !== undefined) rebuildCancel()
    rebuildCancel = undefined
    faceRetryAt = undefined
  }

  /** Schedule the self-heal rebuild with jittered exponential backoff; ignored while one is pending. */
  const scheduleRebuild = (): void => {
    if (stopped || rebuildCancel !== undefined) return
    const delayMs = Math.min(backoffMs, backoffCapMs) * (0.8 + jitter() * 0.4)
    faceRetryAt = new Date(Date.now() + delayMs).toISOString()
    rebuildCancel = delay(() => {
      rebuildCancel = undefined
      faceRetryAt = undefined
      // 翻倍后再评估：本次重建失败时下一次退避从新值开始。
      backoffMs = Math.min(backoffMs * 2, backoffCapMs)
      schedule('status failed')
    }, delayMs)
  }

  /** Fold one official status into the projection; `failed` schedules the rebuild, `connected` resets the backoff. */
  const onStatus = (next: McpConnectionStatus): void => {
    if (stopped) return
    const mapped = mapStatus(next, faceAttempt)
    setFace(mapped.state, mapped.attempt, mapped.count)
    if (next.state === 'connected') backoffMs = baseBackoffMs
    if (next.state === 'failed') scheduleRebuild()
  }

  const unmount = async (): Promise<void> => {
    unsubscribeStatus?.()
    unsubscribeStatus = undefined
    const current = child
    child = undefined
    mounted = false
    handle = undefined
    if (current === undefined) return
    // Fiber.dispose 在部分状态下同步返回 undefined；统一收敛成 Promise。
    await Promise.resolve(current.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`yootun-managed-mcp: agent client disposal failed: ${String(error)}`)
    })
  }

  const mount = (): void => {
    // 完整 Config；reconnect 字段省略即官方 dsh-mcp-client 默认重连策略
    // （RECONNECT_DEFAULTS：500ms 起倍增、30s 封顶、10 次）；`reconnect`
    // 覆盖仅为测试缝，产品组合不设置。
    const instance = host.mount(host.validate({
      transport: 'streamable-http',
      serverName: AGENT_SERVER_NAME,
      url: agentUrl(),
      headers: { Authorization: `Bearer \${credential:${ACCESS_CREDENTIAL_REF}}`, 'X-Company-Code': TENANT_CODE },
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      expandTemplates: true,
      failOnStartupError: false,
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
    }, CONFIG_PATH))
    child = instance
    mounted = true
    setFace('connecting', 0, 0)
    // 子实例启动失败（如 serverName 被占用）：复位挂载态并告警，下一次事件重试。
    void instance.ready.then((statusHandle) => {
      if (stopped || child !== instance) return
      handle = statusHandle
      unsubscribeStatus = statusHandle.onChange((next) => {
        if (stopped || child !== instance) return
        onStatus(next)
      })
      // ready 到订阅之间可能错过一次发布；同步对齐一次当前值。
      onStatus(statusHandle.current())
    }, (error: unknown) => {
      if (stopped || child !== instance) return
      mounted = false
      ctx.logger.warn(`yootun-managed-mcp: agent client failed to start, will retry on next gate event: ${String(error)}`)
    })
  }

  const evaluate = async (reason: string): Promise<void> => {
    if (stopped) return
    // 事件评估优先于待触发的退避：到点重建与即时重建只发生其一。
    clearRebuild()
    const activated = await isActivated(activationServices(ctx))
    if (stopped) return
    // 凭证更新或子实例重连耗尽（failed/gave-up）时销毁重建；纯门禁翻转只挂载/卸载。
    let rebuild = credentialDirty
    credentialDirty = false
    if (activated && mounted && !rebuild) {
      if (handle?.current().state === 'failed') rebuild = true
    }
    if (activated && (!mounted || rebuild)) {
      if (mounted) {
        await unmount()
        if (stopped) return
        ctx.logger.info('yootun-managed-mcp: agent client rebuilt (credential update or exhausted reconnect)')
      } else {
        ctx.logger.info(`yootun-managed-mcp: agent face mounted (${reason})`)
      }
      mount()
      return
    }
    if (!activated && mounted) {
      ctx.logger.info(`yootun-managed-mcp: agent face unmounted (${reason})`)
      await unmount()
    }
    if (!activated) setFace('disabled', 0, 0)
  }

  /** Serialize evaluations; coalesce bursts into one queued run. Failures log and leave the tail resolved. */
  const schedule = (reason: string): void => {
    if (stopped) return
    if (queued) return
    queued = true
    tail = tail.then(() => {
      queued = false
      // evaluate 的失败（settings 读取异常、credential 存储故障）只告警：
      // tail 保持 resolved，后续合并事件照常执行。
      return evaluate(reason).catch((error: unknown) => {
        ctx.logger.warn(`yootun-managed-mcp: gate evaluation failed (${reason}): ${String(error)}`)
      })
    })
  }

  ctx.on('settings/document-updated', (ns) => {
    if (ns === ACCESS_NAMESPACE) schedule(`settings ${ACCESS_NAMESPACE} updated`)
  })
  ctx.on('credentials/reference-updated', (ref) => {
    if (ref === ACCESS_CREDENTIAL_REF) {
      credentialDirty = true
      schedule('credential updated')
    }
  })

  return {
    reevaluate: (reason) => { schedule(reason) },
    snapshot: () => ({
      state: faceState,
      attempt: faceAttempt,
      since: faceSince.toISOString(),
      count: faceCount,
      ...(faceState === 'failed' && faceRetryAt !== undefined ? { retryAt: faceRetryAt } : {}),
    }),
    dispose: async () => {
      stopped = true
      clearRebuild()
      await tail.catch(() => undefined)
      await unmount()
    },
  }
}
