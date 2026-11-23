/**
 * Agent 面 client 挂载监督器：按激活门禁动态挂载/卸载一个
 * `@deepseek-ai/dsh-mcp-client` 子实例（serverName `yootun-agent`）。
 * 生命周期：未激活零连接；激活后单实例；key 更新销毁重建；key 移除销毁；
 * 网络初始化失败不阻塞启动（failOnStartupError=false + 重连策略）；
 * 插件卸载销毁子实例与全部监听。Authorization 只以
 * `Bearer ${credential:MODELS_API_KEY}` 模板进入 transport（expandTemplates
 * 展开、诊断脱敏），本插件不把解析值写入任何状态或日志。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { McpClientHost, type McpConnectionStatusHandle, type McpServerInstance } from '@deepseek-ai/dsh-mcp-client'
import { activationServices, isActivated } from './gate.ts'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE, agentUrl, AGENT_SERVER_NAME, TENANT_CODE } from './constants.ts'

/** The supervisor's public face: request reevaluation and release everything. */
export interface AgentSupervisor {
  /** Re-run the gate (serialized); mounts, unmounts, or remounts accordingly. */
  reevaluate(reason: string): void
  /**
   * Mark the supervisor stopped so scheduled evaluations become no-ops, then
   * dispose the live child. Listeners themselves ride the plugin fiber and
   * are removed with it; plugin unload additionally calls this through its
   * effect.
   */
  dispose(): Promise<void>
}

/** Per-call timeout budget (ms); metadata-heavy product tools stay under it. */
const TOOL_CALL_TIMEOUT_MS = 60_000

/** Transport closure budget (ms), mirroring the mcp-client default. */
const CLOSE_TIMEOUT_MS = 5_000

/** Configuration path that names the Agent server in validation failures. */
const CONFIG_PATH: readonly string[] = ['yootun-managed-mcp', 'agent']

/**
 * Create the mount supervisor on the plugin context. Listeners ride the
 * plugin fiber (auto-removed on unload); the child mounts under the same
 * fiber, so final disposal unwinds it with the plugin.
 * @param ctx - the plugin context carrying the tool registry.
 * @returns the supervisor handle.
 */
export function createSupervisor(ctx: Context): AgentSupervisor {
  // 桌面 profile 的官方 mcp-manager 已在根作用域注册 `mcpClientHost`，同名服务重复注册会抛错；
  // 隔离子作用域各用各的键，且继承本插件的 fiber，host 与其挂载的子实例仍随本插件结束。
  const host = new McpClientHost(ctx.isolate('mcpClientHost'))
  let child: McpServerInstance | undefined
  /** 已挂载子实例的状态句柄；激活完成后由 `ready` 给出。 */
  let status: McpConnectionStatusHandle | undefined
  let stopped = false
  let queued = false
  let tail: Promise<void> = Promise.resolve()
  /** Whether the mounted verdict matches a live child (flipped by mount/unmount and failed starts). */
  let mounted = false
  /** Set by credential updates: the next evaluation must destroy and rebuild the child. */
  let credentialDirty = false

  const unmount = async (): Promise<void> => {
    const current = child
    child = undefined
    mounted = false
    status = undefined
    if (current === undefined) return
    // Fiber.dispose 在部分状态下同步返回 undefined；统一收敛成 Promise。
    await Promise.resolve(current.dispose()).catch((error: unknown) => {
      ctx.logger.warn(`yootun-managed-mcp: agent client disposal failed: ${String(error)}`)
    })
  }

  const mount = (): void => {
    // 完整 Config；reconnect 字段省略即官方 dsh-mcp-client 默认重连策略
    // （RECONNECT_DEFAULTS：500ms 起倍增、30s 封顶、10 次）。
    const instance = host.mount(host.validate({
      transport: 'streamable-http',
      serverName: AGENT_SERVER_NAME,
      url: agentUrl(),
      headers: { Authorization: `Bearer \${credential:${ACCESS_CREDENTIAL_REF}}`, 'X-Company-Code': TENANT_CODE },
      toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      expandTemplates: true,
      failOnStartupError: false,
    }, CONFIG_PATH))
    child = instance
    mounted = true
    // 子实例启动失败（如 serverName 被占用）：复位挂载态并告警，下一次事件重试。
    void instance.ready.then((handle) => {
      if (stopped || child !== instance) return
      status = handle
    }, (error: unknown) => {
      if (stopped || child !== instance) return
      mounted = false
      ctx.logger.warn(`yootun-managed-mcp: agent client failed to start, will retry on next gate event: ${String(error)}`)
    })
  }

  const evaluate = async (reason: string): Promise<void> => {
    if (stopped) return
    const activated = await isActivated(activationServices(ctx))
    if (stopped) return
    // 凭证更新或子实例重连耗尽（failed/gave-up）时销毁重建；纯门禁翻转只挂载/卸载。
    let rebuild = credentialDirty
    credentialDirty = false
    if (activated && mounted && !rebuild) {
      if (status?.current().state === 'failed') rebuild = true
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
    dispose: async () => {
      stopped = true
      await tail.catch(() => undefined)
      await unmount()
    },
  }
}
