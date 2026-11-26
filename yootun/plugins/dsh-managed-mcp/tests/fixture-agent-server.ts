/**
 * 假 Agent 面 MCP server（stateless Streamable HTTP fixture）：按
 * `AGENT_TOOL_NAMES` 暴露已分类的 Agent 工具，记录每次 HTTP 请求的
 * Authorization 头（连接观测）与 tools/call 调用名。请求行为可切换
 * （healthy / hold / reject），供自愈与状态投影用例驱动官方连接状态机。
 * 仅测试使用。
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { AGENT_TOOL_NAMES } from '../src/guard.ts'

/** 请求行为模式：healthy 正常 MCP；hold 挂起至 release；reject 直接 500 并断开既有连接。 */
export type AgentFixtureMode = 'healthy' | 'hold' | 'reject'

/** Running agent fixture and its observation surfaces. */
export interface AgentFixture {
  url: string
  /** Every request's Authorization header, in arrival order (connection telemetry). */
  authorization: Array<string | undefined>
  /** Tool names seen at tools/call, in arrival order. */
  toolCalls: string[]
  /** 切换请求行为（见 {@link AgentFixtureMode}）。 */
  setMode: (mode: AgentFixtureMode) => void
  /** 放行 hold 模式挂起的全部请求。 */
  release: () => void
  close: () => Promise<void>
}

/**
 * Start the fake Agent-face MCP server.
 * @returns the running fixture.
 */
export async function startAgentFixture(): Promise<AgentFixture> {
  const authorization: Array<string | undefined> = []
  const toolCalls: string[] = []
  let mode: AgentFixtureMode = 'healthy'
  let held: Array<() => void> = []
  const handler = createMcpHandler(({ requestInfo }) => {
    const mcp = new McpServer(
      { name: 'yootun-agent', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    for (const toolName of AGENT_TOOL_NAMES) {
      mcp.registerTool(toolName, { description: `fixture ${toolName}`, inputSchema: z.object({}) }, async (): Promise<CallToolResult> => {
        toolCalls.push(toolName)
        return { content: [{ type: 'text', text: `ok:${toolName}` }] }
      })
    }
    void requestInfo
    return mcp
  })
  const handle = toNodeHandler(handler)
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorization.push(request.headers.authorization)
    if (mode === 'reject') {
      response.writeHead(500).end('fixture reject')
      return
    }
    if (mode === 'hold') {
      const gate = Promise.withResolvers<void>()
      held.push(gate.resolve)
      void gate.promise.then(() => {
        handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
          response.writeHead(500).end(String(error))
        })
      })
      return
    }
    handle(request as NodeIncomingMessageLike, response).catch((error: unknown) => {
      response.writeHead(500).end(String(error))
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('agent fixture has no TCP address')
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    authorization,
    toolCalls,
    setMode: (next) => {
      mode = next
      // reject 同时断开既有连接：已连接的官方 client 立即进入重连状态机。
      if (next === 'reject') server.closeAllConnections()
    },
    release: () => {
      const pending = held
      held = []
      for (const resolve of pending) resolve()
    },
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
