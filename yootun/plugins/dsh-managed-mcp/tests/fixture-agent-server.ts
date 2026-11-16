/**
 * 假 Agent 面 MCP server（stateless Streamable HTTP fixture）：精确暴露
 * Agent 契约 36 项工具，记录每次 HTTP 请求的 Authorization 头（连接观测）
 * 与 tools/call 调用名。仅测试使用。
 * @module
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { AGENT_TOOL_NAMES } from '../src/guard.ts'

/** Running agent fixture and its observation surfaces. */
export interface AgentFixture {
  url: string
  /** Every request's Authorization header, in arrival order (connection telemetry). */
  authorization: Array<string | undefined>
  /** Tool names seen at tools/call, in arrival order. */
  toolCalls: string[]
  close: () => Promise<void>
}

/**
 * Start the fake Agent-face MCP server.
 * @returns the running fixture.
 */
export async function startAgentFixture(): Promise<AgentFixture> {
  const authorization: Array<string | undefined> = []
  const toolCalls: string[] = []
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
    close: async () => {
      await handler.close()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error === undefined) resolve(); else reject(error) })
      })
    },
  }
}
