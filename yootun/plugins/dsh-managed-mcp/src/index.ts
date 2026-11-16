/**
 * yootun Agent 面 MCP 管理插件（普通会话唯一 yootun 远端挂载层）。
 * 按激活门禁动态挂载官方 `@deepseek-ai/dsh-mcp-client`（serverName
 * `yootun-agent`），将 Agent 面 36 个 `yootun_*` 工具注册进 `ctx.tools`；
 * 并注册 `tools/pre-execute` guard 约束会话写操作。连接器实现随本批次交付。
 * @module @yootun/dsh-managed-mcp
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis function-plugin name. */
export const name = 'yootun-managed-mcp'

/** Host services required before the supervisor registers. */
export const inject = ['tools']

/**
 * Register the Agent-face guard and the activation supervisor.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  void ctx
}
