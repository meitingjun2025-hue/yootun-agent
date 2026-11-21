/**
 * 假 Workbench 面 MCP server（stateless Streamable HTTP fixture）：精确暴露
 * 90 项白名单工具，记录 Authorization 头与连接观测；特殊工具覆盖业务错误、
 * 慢调用与悬挂调用；可注入 serverName 不匹配、生产 94 前向多工具与白名单
 * 缺项三类清单形态。
 * 仅测试使用。
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { WORKBENCH_TOOL_WHITELIST } from '../src/whitelist.ts'

/** 服务端 2026-11-21 公网基线在白名单外新增的 4 个抖音排期工具（RQ-2026-013）。 */
const PRODUCTION_EXTRA_TOOLS: readonly string[] = Object.freeze([
  'workbench_douyin_publish_schedule_list',
  'workbench_douyin_publish_schedule_row_create',
  'workbench_douyin_publish_schedule_row_update',
  'workbench_douyin_publish_schedule_row_delete',
])
/** `'missing'` 注入时从白名单内移除的工具。 */
const MISSING_TOOL = 'workbench_xhs_hotboard_overview'

export interface WorkbenchFixtureOptions {
  /** initialize 返回的 serverInfo.name（缺省 'yootun-workbench'）。 */
  serverName?: string
  /**
   * 清单形态注入：`'production-94'` 在白名单外追加 4 个生产新增工具（共 94，
   * 模拟服务端先升级）；`'missing'` 移除一个白名单内工具（模拟服务端缺项）。
   * 缺省 `'exact'` 精确 90。
   */
  toolCountMode?: 'exact' | 'production-94' | 'missing'
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
    if (options.toolCountMode === 'production-94') names.push(...PRODUCTION_EXTRA_TOOLS)
    if (options.toolCountMode === 'missing') {
      const index = names.indexOf(MISSING_TOOL)
      if (index >= 0) names.splice(index, 1)
    }
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
