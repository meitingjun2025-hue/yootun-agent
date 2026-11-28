/**
 * 假 Workbench 面 MCP server（stateless Streamable HTTP fixture）：按域各注册
 * 少量工具覆盖测试路径（业务错误、慢调用、悬挂调用由指定工具承担），记录
 * Authorization 头与连接观测；可注入 serverName 不匹配、多广播一个额外工具、
 * 运行中新增工具、全请求 HTTP 状态故障与全请求延迟五种形态。工具名不代表
 * 服务端契约清单。仅测试使用。
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import type { WorkbenchDomain } from '../src/whitelist.ts'

export interface WorkbenchFixtureOptions {
  /** initialize 返回的 serverInfo.name（缺省 'yootun-workbench'）。 */
  serverName?: string
  /** 多广播形态注入：额外广播的服务端先行工具名（缺省不广播）。 */
  extraTool?: string
}

export interface WorkbenchFixture {
  url: string
  /** 每个请求的 Authorization 头（连接观测；也用作请求计数）。 */
  authorization: Array<string | undefined>
  /** 到达 tools/call 的工具名。 */
  toolCalls: string[]
  /** 运行中向服务端新增一个广播工具（下一次请求起生效）。 */
  addExtraTool: (name: string) => void
  /** 注入全请求 HTTP 状态故障（null 恢复正常服务）。 */
  setFault: (status: number | null) => void
  /** 注入全请求延迟毫秒数（null 恢复立即分发；并发刷新观测用）。 */
  setRequestDelay: (ms: number | null) => void
  close: () => Promise<void>
}

/** 业务错误工具：isError + 稳定错误 envelope。 */
const BUSINESS_ERROR_TOOL = 'workbench_xhs_task_cancel'
/** 慢工具：超过缺省调用预算后触发超时投影。 */
const SLOW_TOOL = 'workbench_douyin_export'
const SLOW_DELAY_MS = 1_500
/** 悬挂工具：永不返回，验证取消与卸载中止。 */
const HANG_TOOL = 'workbench_wx_collect_run_start'

/** 每域的 fixture 工具名；只覆盖测试路径，不表示服务端契约清单。 */
const FIXTURE_TOOLS: Readonly<Record<WorkbenchDomain, readonly string[]>> = Object.freeze({
  wx: ['workbench_wx_account_list', 'workbench_wx_work_list', HANG_TOOL],
  xhs: ['workbench_xhs_task_create', BUSINESS_ERROR_TOOL, 'workbench_xhs_hotboard_overview'],
  douyin: ['workbench_douyin_account_list', SLOW_TOOL, 'workbench_douyin_publish_schedule_list'],
  viral: ['workbench_viral_rewrite_rules_list', 'workbench_viral_workflow_start', 'workbench_viral_dashboard_get'],
  tos: ['workbench_tos_upload_authorize', 'workbench_tos_upload_commit', 'workbench_tos_upload_abort'],
})

/**
 * Start the fake Workbench-face MCP server.
 * @param options - identity and extra-advertisement injection.
 * @returns the running fixture.
 */
export async function startWorkbenchFixture(options: WorkbenchFixtureOptions = {}): Promise<WorkbenchFixture> {
  const authorization: Array<string | undefined> = []
  const toolCalls: string[] = []
  const extraTools = new Set<string>(options.extraTool !== undefined ? [options.extraTool] : [])
  let faultStatus: number | null = null
  let requestDelayMs: number | null = null
  const serverName = options.serverName ?? 'yootun-workbench'
  const handler = createMcpHandler(() => {
    const mcp = new McpServer(
      { name: serverName, version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    // 工厂按请求重建（stateless）：运行中新增的工具在下一次请求即广播。
    const names = [...Object.values(FIXTURE_TOOLS).flat(), ...extraTools]
    for (const toolName of names) {
      mcp.registerTool(toolName, { description: `fixture ${toolName}`, inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
        toolCalls.push(toolName)
        if (toolName === BUSINESS_ERROR_TOOL) {
          // 真实 Tools 稳定错误 envelope 形态（docs/1116/yootun-mcp.md §6.4）。
          return {
            content: [],
            isError: true,
            structuredContent: {
              error: { code: 'TASK_ALREADY_CANCELLED', message: 'task already cancelled', retryable: false, requestId: null },
            },
          }
        }
        if (toolName === SLOW_TOOL) await new Promise(resolve => setTimeout(resolve, SLOW_DELAY_MS))
        if (toolName === HANG_TOOL) await new Promise<void>(() => {})
        return { content: [], structuredContent: { ok: true, tool: toolName } }
      })
    }
    return mcp
  })
  const handle = toNodeHandler(handler)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorization.push(request.headers.authorization)
    const dispatch = (): void => {
      if (faultStatus !== null) {
        // 网关形态故障：不带 MCP 语义的原始状态响应（含上游形态的响应体）。
        response.writeHead(faultStatus, { 'content-type': 'text/plain' }).end('secret-upstream-body-must-not-leak')
        return
      }
      handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error))
      })
    }
    if (requestDelayMs !== null) setTimeout(dispatch, requestDelayMs)
    else dispatch()
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
    addExtraTool: (name: string) => { extraTools.add(name) },
    setFault: (status: number | null) => { faultStatus = status },
    setRequestDelay: (ms: number | null) => { requestDelayMs = ms },
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
