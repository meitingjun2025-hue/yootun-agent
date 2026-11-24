/**
 * Workbench MCP 连接生命周期（直接使用 MCP SDK Streamable HTTP client，
 * 不经官方 dsh-mcp-client——后者会把工具注册进 ctx.tools，破坏普通会话不可
 * 见的边界）。连接时只校验 serverName（服务端身份），并把 tools/list 广播
 * 的工具名集合交给调用层做调用时可用性判断；每个调用显式超时与取消；错误
 * 按稳定码投影，上游原文不进入诊断文本。
 * @module
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CLIENT_INFO_NAME, WORKBENCH_SERVER_NAME, workbenchUrl, TENANT_CODE } from './constants.ts'
import { WorkbenchMcpError } from './errors.ts'

/** One live connection: the SDK client plus its advertised tools/list cache. */
export interface WorkbenchConnection {
  client: Client
  /**
   * The tool names the server advertised. Consulted at call time for
   * availability (unadvertised names project `workbench_tool_unavailable`);
   * server-side additions ride along harmlessly.
   */
  toolNames: ReadonlySet<string>
}

/** Explicit budgets for the connect phase (§5.4: 每个关键操作显式超时). */
export interface ConnectOptions {
  /** Overall connect+identity+listing budget in ms; the SDK default applies when omitted. */
  timeoutMs?: number | undefined
  /** Cancellation propagated into connect and tools/list. */
  signal?: AbortSignal | undefined
}

/**
 * Open one Workbench connection: attach the resolved Authorization value
 * (never logged), connect, and validate the server identity; advertised
 * names are returned for the call-time availability check. No comparison
 * against any client-side tool list happens at connect time.
 * @param authorization - the resolved `MODELS_API_KEY` value; secret, used only in request headers.
 * @param options - explicit budgets and cancellation for the connect phase.
 * @returns the live connection.
 * @throws {WorkbenchMcpError} `workbench_network_error` on transport or listing failure,
 * `workbench_protocol_error` when the identity does not match.
 */
export async function connectWorkbench(authorization: string, options: ConnectOptions = {}): Promise<WorkbenchConnection> {
  const client = new Client({ name: CLIENT_INFO_NAME, version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(workbenchUrl()), {
    requestInit: {
      headers: { Authorization: `Bearer ${authorization}`, 'X-Company-Code': TENANT_CODE },
    },
  })
  const requestPhase = requestOptions(options)
  try {
    await client.connect(transport, requestPhase)
  } catch (error: unknown) {
    await closeClient(client)
    throw new WorkbenchMcpError('workbench_network_error', `workbench connect failed: ${describeErrorName(error)}`)
  }
  const server = client.getServerVersion()
  if (server === undefined || server.name !== WORKBENCH_SERVER_NAME) {
    await closeClient(client)
    throw new WorkbenchMcpError('workbench_protocol_error', `workbench serverName mismatch: expected ${WORKBENCH_SERVER_NAME}`)
  }
  let tools: Array<{ name: string }>
  try {
    // listTools() 聚合全部分页。
    const listing = await client.listTools(undefined, requestPhase)
    tools = listing.tools
  } catch (error: unknown) {
    await closeClient(client)
    throw new WorkbenchMcpError('workbench_network_error', `workbench tools/list failed: ${describeErrorName(error)}`)
  }
  const advertised = new Set(tools.map(tool => tool.name))
  return { client, toolNames: advertised }
}

/** Close one SDK client, tolerating an already-closed transport. */
async function closeClient(client: Client): Promise<void> {
  try {
    await client.close()
  } catch (error: unknown) {
    // 关闭失败不掩盖原始错误；连接对象随后被丢弃。
    void error
  }
}

/** Error text keeps only the error name — never response bodies or headers. */
function describeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : `non-error ${typeof error}`
}

/** Map the connect-phase options onto SDK request options. */
function requestOptions(options: ConnectOptions): { signal?: AbortSignal; timeout?: number } {
  return {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  }
}

/** The shape of one successful tools/call result the service projects. */
export interface ToolCallOutcome {
  /** The tool's structured output when the server produced one. */
  structuredContent: unknown
  /** The raw result payload (content blocks); available when no structured output exists. */
  content: unknown
}

/**
 * Call one tool over the live connection.
 * @param connection - the live connection.
 * @param name - tool name (domain-gate and availability checked by the service layer).
 * @param args - tool arguments.
 * @param timeoutMs - explicit per-call timeout.
 * @param signal - caller cancellation.
 * @returns the tool's stable output projection.
 * @throws {WorkbenchMcpError} timeout / cancellation / network / business projections.
 */
export async function callTool(
  connection: WorkbenchConnection,
  name: string,
  args: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ToolCallOutcome> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const effective = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let result: { isError?: unknown; structuredContent?: unknown; content?: unknown }
  try {
    result = await connection.client.callTool(
      { name, arguments: args as Record<string, unknown> },
      { signal: effective },
    )
  } catch (error: unknown) {
    if (signal?.aborted === true) throw new WorkbenchMcpError('workbench_call_cancelled', 'workbench call cancelled by caller')
    if (timeout.aborted) throw new WorkbenchMcpError('workbench_call_timeout', `workbench call timed out after ${String(timeoutMs)}ms`)
    throw new WorkbenchMcpError('workbench_network_error', `workbench call failed: ${describeErrorName(error)}`)
  }
  if (result.isError === true) {
    const payload = result.structuredContent
    throw new WorkbenchMcpError('workbench_call_failed', `workbench tool "${name}" reported a business failure`, payload ?? undefined)
  }
  return {
    structuredContent: result.structuredContent,
    content: result.content,
  }
}

/** Close a live connection, tolerating transport failures. */
export async function closeWorkbench(connection: WorkbenchConnection): Promise<void> {
  await closeClient(connection.client)
}
