/**
 * Workbench MCP 调用通道（`douyin-workbench` caller，分册 15 §3/§4）：按工具
 * 名前缀把单次调用投到 `ctx.yootunWorkbench.callTool` 的 douyin / viral 两个
 * 白名单分组；某 action 可触达的工具全集由 route.ts 的 ACTION_TOOL_MAP 冻结
 * 并在 host 测试对账。WorkbenchMcpError 由 errors.ts `safeCode` 投影，服务端
 * 稳定 envelope 原样保留、原文不透传。D1 只有骨架与类型，无业务 handler
 * 消费（D2+ 接入）。
 * @module
 */
import { DouyinError } from './errors.ts'

/** `ctx.yootunWorkbench` 的结构子集（测试注入面；与 Workbench MCP Service 同形）。 */
export interface WorkbenchFace {
  /**
   * Call one Workbench tool as this Host's own identity.
   * @param caller - the calling Host's identity.
   * @param domain - the tool's group.
   * @param name - exact tool name.
   * @param args - tool arguments.
   * @param signal - caller cancellation.
   * @returns the tool's output projection.
   */
  callTool(caller: 'douyin-workbench', domain: 'douyin' | 'viral', name: string, args: unknown, signal?: AbortSignal): Promise<{ structuredContent: unknown; content: unknown }>
}

/** Douyin 工作台的固定 caller 身份（workbench-mcp 域门按它限制到 douyin/viral 域）。 */
export const DOUYIN_CALLER = 'douyin-workbench' as const

/**
 * Build one Workbench caller bound to this Host's identity. The domain comes
 * from the tool-name prefix（workbench_douyin_* / workbench_viral_*）; the
 * frozen ACTION_TOOL_MAP governs which tools an action may reach（对账在
 * host 测试锁定），so callers pass one exact tool per invocation.
 * @param face - the shared Workbench MCP connector (`ctx.yootunWorkbench`).
 * @returns a caller that projects one tool call onto the douyin-workbench identity.
 * @throws {DouyinError} `DOUYIN_TOOL_UNAVAILABLE` for a tool outside both groups.
 */
export function createWorkbenchCaller(face: WorkbenchFace): (tool: string, args: unknown, signal?: AbortSignal) => Promise<{ structuredContent: unknown; content: unknown }> {
  return async (tool, args, signal) => {
    const domain = tool.startsWith('workbench_douyin_') ? 'douyin' : tool.startsWith('workbench_viral_') ? 'viral' : undefined
    if (domain === undefined) {
      throw new DouyinError('DOUYIN_TOOL_UNAVAILABLE', `tool "${tool}" is outside the douyin/viral groups`)
    }
    return face.callTool(DOUYIN_CALLER, domain, tool, args, signal)
  }
}
