/**
 * 假 Workbench 面 MCP server（stateless Streamable HTTP fixture）：精确暴露
 * 94 项白名单工具，记录 Authorization 头与连接观测；特殊工具覆盖业务错误、
 * 慢调用与悬挂调用；可注入 serverName 不匹配与清单数量漂移两类协议异常。
 * 仅测试使用。
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { WORKBENCH_TOOL_WHITELIST } from '../src/whitelist.ts'

export interface WorkbenchFixtureOptions {
  /** initialize 返回的 serverInfo.name（缺省 'yootun-workbench'）。 */
  serverName?: string
  /** 清单漂移注入：'extra' 多注册一个白名单外工具。 */
  toolCountMode?: 'exact' | 'extra'
}

export interface WorkbenchFixture {
  url: string
  /** 每个请求的 Authorization 头（连接观测）。 */
  authorization: Array<string | undefined>
  /** 到达 tools/call 的工具名。 */
  toolCalls: string[]
  close: () => Promise<void>
}

/** 业务错误工具：isError + 稳定错误 envelope。 */
const BUSINESS_ERROR_TOOL = 'workbench_xhs_task_cancel'
/** 慢工具：超过缺省调用预算后触发超时投影。 */
const SLOW_TOOL = 'workbench_douyin_export'
const SLOW_DELAY_MS = 1_500
/** 悬挂工具：永不返回，验证取消与卸载中止。 */
const HANG_TOOL = 'workbench_wx_collect_run_start'

/**
 * Start the fake Workbench-face MCP server.
 * @param options - identity and contract-drift injection.
 * @returns the running fixture.
 */
export async function startWorkbenchFixture(options: WorkbenchFixtureOptions = {}): Promise<WorkbenchFixture> {
  const authorization: Array<string | undefined> = []
  const toolCalls: string[] = []
  const serverName = options.serverName ?? 'yootun-workbench'
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: serverName, version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    const names = [...WORKBENCH_TOOL_WHITELIST]
    if (options.toolCountMode === 'extra') names.push('workbench_douyin_unknown_extra')
    for (const toolName of names) {
      mcp.registerTool(toolName, { description: `fixture ${toolName}`, inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
        toolCalls.push(toolName)
        if (toolName === BUSINESS_ERROR_TOOL) {
          // 真实 Tools 稳定错误 envelope 形态（docs/1116/yootun-mcp.md §6.4）。
          return {
            isError: true,
            structuredContent: {
              error: { code: 'TASK_ALREADY_CANCELLED', message: 'task already cancelled', retryable: false, requestId: null },
            },
          }
        }
        if (toolName === SLOW_TOOL) await new Promise(resolve => setTimeout(resolve, SLOW_DELAY_MS))
        if (toolName === HANG_TOOL) await new Promise<void>(() => {})
        return { structuredContent: { ok: true, tool: toolName } }
      })
    }
    return mcp
  })
  const handle = toNodeHandler(handler)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorization.push(request.headers.authorization)
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('workbench fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    authorization,
    toolCalls,
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
