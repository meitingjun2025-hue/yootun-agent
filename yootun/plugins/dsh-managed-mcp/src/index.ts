/**
 * yootun Agent 面 MCP 管理插件（普通会话唯一 yootun 远端挂载层）。
 * 职责两项：
 * 1. 按激活门禁动态挂载官方 `@deepseek-ai/dsh-mcp-client`（serverName
 *    `yootun-agent`），Agent 面 36 个 `yootun_*` 工具经它注册进 `ctx.tools`；
 *    未激活零连接、key 更新销毁重建、key 移除销毁、卸载无残留；
 * 2. 注册 `tools/pre-execute` guard：读工具允许、任务型写/可能计费 ask、
 *    未识别与 Workbench/Catalog 面 deny（会话权限边界 = 挂载清单之外的纵深防御）。
 * @module @yootun/dsh-managed-mcp
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import { AGENT_SERVER_NAME, FORBIDDEN_SERVER_NAMES, MCP_TOOL_PREFIX } from './constants.ts'
import { classifyAgentTool } from './guard.ts'
import { createSupervisor, type AgentSupervisor } from './supervisor.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-managed-mcp'

/** Host services required before the supervisor registers. */
export const inject = ['tools']

export { classifyAgentTool, AGENT_TOOL_NAMES, type AgentToolClass } from './guard.ts'
export { createSupervisor, type AgentSupervisor } from './supervisor.ts'
export { readAccessSnapshot, isActivated, activationServices, type AccessSnapshot } from './gate.ts'
export { agentUrl, AGENT_SERVER_NAME, ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from './constants.ts'

/**
 * The session guard over `mcp__<serverName>__<rawName>` public names: yootun
 * Agent reads flow through, task writes ask, unknown yootun tools deny, and
 * the Workbench/Catalog faces are refused outright. Non-yootun MCP tools and
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
    if (toolClass === 'task-write') {
      return {
        kind: 'ask',
        reason: `yootun tool "${rawName}" starts or changes a remote task and may incur model fees`,
        displayReason: { en: `yootun tool "${rawName}" starts or changes a remote task and may incur model fees` },
      }
    }
    return { kind: 'deny', reason: `unknown yootun agent tool "${rawName}" is not available in this session` }
  }
  if (FORBIDDEN_SERVER_NAMES.has(normalized)) {
    return { kind: 'deny', reason: `yootun ${normalized} tools are not available in ordinary sessions` }
  }
  return next()
}

/**
 * Register the Agent-face guard and the activation supervisor.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.on('tools/pre-execute', sessionGuard)
  const supervisor: AgentSupervisor = createSupervisor(ctx)
  // 返回 dispose 的 Promise：fiber 卸载 await 它，等子实例与连接释放完成。
  ctx.effect(() => () => supervisor.dispose(), 'yootun-managed-mcp: agent supervisor')
  supervisor.reevaluate('plugin activation')
}
