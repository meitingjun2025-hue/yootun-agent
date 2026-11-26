/**
 * yootun Agent 面 MCP 管理插件（普通会话唯一 yootun 远端挂载层）。
 * 职责三项：
 * 1. 按激活门禁动态挂载官方 `@deepseek-ai/dsh-mcp-client`（serverName
 *    `yootun-agent`），Agent 面 `yootun_*` 工具经它注册进 `ctx.tools`（官方
 *    客户端注册服务端全部工具）；未激活零连接、key 更新销毁重建、key 移除
 *    销毁、官方重连耗尽按退避自愈重建、卸载无残留；
 * 2. `webServer` 在场时注册 `POST /api/desktop/yootun/agent-status` 只读
 *    状态路由（设置页「智能体工具」行轮询的状态出口）；
 * 3. 注册 `tools/pre-execute` guard：读工具允许、任务型写与发布排期写 ask、
 *    未分类 yootun 工具 ask（三类审批均交人工确认，卡片文案见 locales.ts）、
 *    Workbench/Catalog 面 deny（会话权限边界 = 挂载清单之外的纵深防御）。
 * @module @yootun/dsh-managed-mcp
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { AGENT_SERVER_NAME, FORBIDDEN_SERVER_NAMES, MCP_TOOL_PREFIX, STATUS_PATH } from './constants.ts'
import { classifyAgentTool } from './guard.ts'
import { askDecision } from './locales.ts'
import { createAgentStatusRouteHandler } from './status-route.ts'
import { createSupervisor, type AgentSupervisor } from './supervisor.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-managed-mcp'

/** Host services required before the supervisor registers. */
export const inject = ['tools']

/** 插件配置：Agent 面自愈退避预算。 */
export interface Config {
  /** 自愈退避基值毫秒（整数 1000..600000）；上限 = max(本值, 300000) 固定。 */
  rebuildBackoffMs: number
}

type ConfigInput = Partial<{ rebuildBackoffMs: unknown }>

export const Config = z.object({
  /** 缺省 30 秒；越界或非整数由 schema 拒绝（插件加载失败）。 */
  rebuildBackoffMs: z.number().min(1000).max(600000).step(1).default(30_000),
}) as z<ConfigInput, Config>

export { classifyAgentTool, AGENT_TOOL_NAMES, type AgentToolClass } from './guard.ts'
export { createSupervisor, type AgentSupervisor, type AgentFaceSnapshot, type AgentFaceState, type SupervisorOptions, type DelayScheduler } from './supervisor.ts'
export { readAccessSnapshot, isActivated, activationServices, type AccessSnapshot } from './gate.ts'
export { agentUrl, AGENT_SERVER_NAME, ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE, STATUS_PATH } from './constants.ts'
export { permitted, createAgentStatusRouteHandler, MAX_BODY_BYTES, type StatusRouteRequest, type StatusRouteResponse, type AgentStatusSnapshotSource } from './status-route.ts'

/**
 * The session guard over `mcp__<serverName>__<rawName>` public names: yootun
 * Agent reads flow through, task writes, schedule writes and unclassified
 * yootun tools ask for human confirmation (card text per locale), and the
 * Workbench/Catalog faces are refused outright. Non-yootun MCP tools and
 * native tools are untouched.
 * @param exec - the pending tool execution.
 * @param next - allow-delegation continuation.
 * @returns the pre-execute decision.
 */
async function sessionGuard(exec: { name: string }, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
  if (!exec.name.startsWith(MCP_TOOL_PREFIX)) return next()
  const rest = exec.name.slice(MCP_TOOL_PREFIX.length)
  const separator = rest.indexOf('__')
  if (separator <= 0) return next()
  const serverName = rest.slice(0, separator)
  // serverName 语法允许大小写；规范化后比较，堵住大小写变体绕过。
  const normalized = serverName.toLowerCase()
  if (normalized === AGENT_SERVER_NAME) {
    const rawName = rest.slice(separator + 2)
    const toolClass = classifyAgentTool(rawName)
    if (toolClass === 'read') return next()
    return askDecision(toolClass, rawName)
  }
  if (FORBIDDEN_SERVER_NAMES.has(normalized)) {
    return { kind: 'deny', reason: `yootun ${normalized} tools are not available in ordinary sessions` }
  }
  return next()
}

/**
 * Register the Agent-face guard, the activation supervisor, and (when the
 * host provides a webServer) the read-only agent-status route.
 * @param ctx - host plugin context.
 * @param config - loader-provided config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('tools/pre-execute', sessionGuard)
  const supervisor: AgentSupervisor = createSupervisor(ctx, { rebuildBackoffMs: config.rebuildBackoffMs })
  let disposing = false
  // 返回 dispose 的 Promise：fiber 卸载 await 它，等子实例与连接释放完成。
  ctx.effect(() => async () => {
    disposing = true
    await supervisor.dispose()
  }, 'yootun-managed-mcp: agent supervisor')
  // webServer 缺席的组合（无桌面 Host）不注册状态路由，也不报错；expected
  // origin 请求时读取：webServer 在服务初始化期绑定端口，先于任何请求。
  const webServer: WebServer | undefined = ctx.get('webServer')
  if (webServer !== undefined) {
    const statusHandler = createAgentStatusRouteHandler(() => webServer.getOrigin(), supervisor, () => disposing)
    ctx.effect(
      () => webServer.register({
        kind: 'exact',
        path: STATUS_PATH,
        handler: (req: IncomingMessage, res: ServerResponse): Promise<void> => statusHandler(req, res),
      }),
      'yootun-managed-mcp: agent status route',
    )
  }
  supervisor.reevaluate('plugin activation')
}
