/**
 * Workbench 面调用缝：本插件对 `ctx.yootunWorkbench` 的窄化接口（caller 固定
 * `xhs-workbench`、domain 固定 `xhs`，19 项白名单由连接器强制）。测试以假 face
 * 替换；task/hotboard 其余 action 随 X4/X5 批次接入同一缝。
 * @module
 */
import type { ToolCallOutcome } from '@yootun/dsh-workbench-mcp'

/** xhs 工作台可用的 Workbench 调用面。 */
export interface XhsWorkbenchFace {
  /**
   * Call one whitelisted Workbench tool.
   * @param name - tool name (`workbench_xhs_*` whitelist enforced by the connector).
   * @param args - tool arguments (server contract).
   * @param signal - cancellation signal.
   * @returns the tool outcome with `structuredContent`.
   */
  callTool(caller: 'xhs-workbench', domain: 'xhs', name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallOutcome>
}
