/**
 * Workbench MCP 连接生命周期（直接使用 MCP SDK Streamable HTTP client，
 * 不经官方 dsh-mcp-client——后者会把工具注册进 ctx.tools，破坏普通会话不可
 * 见的边界）。连接时只校验 serverName（服务端身份），并把 tools/list 广播
 * 的工具名集合交给调用层做调用时可用性判断；每个调用显式超时与取消；错误
 * 按稳定码投影（传输层错误按类型与 HTTP 状态分类），上游原文不进入诊断文本。
 * @module
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CLIENT_INFO_NAME, WORKBENCH_SERVER_NAME, workbenchUrl, TENANT_CODE } from './constants.ts'
import { WorkbenchMcpError, classifyTransportError, transportStatusOf } from './errors.ts'

/** One live connection: the SDK client plus its advertised tools/list cache. */
export interface WorkbenchConnection {
  client: Client
  /**
   * The tool names the server advertised. Consulted at call time for
   * availability (unadvertised names project `workbench_tool_unavailable`
   * after one refresh attempt); server-side additions ride along harmlessly.
   * Refresh replaces the set in place via {@linkcode refreshToolNames}.
   */
  toolNames: ReadonlySet<string>
  /**
   * Wall-clock ms the caching service last stamped after a successful
   * `tools/list` (connect leaves it 0; the service stamps at open and after
   * each refresh) and the sole owner of the refresh-window decision.
   */
  refreshedAt: number
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
 * @throws {WorkbenchMcpError} stable transport projections（分册 08 §5.2 表）,
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
    throw projectTransportFailure(error, 'workbench connect failed')
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
    throw projectTransportFailure(error, 'workbench tools/list failed')
  }
  const advertised = new Set(tools.map(tool => tool.name))
  // refreshedAt 由缓存服务层盖章（open 成功后）；连接层不持有时钟语义。
  return { client, toolNames: advertised, refreshedAt: 0 }
}

/** 单飞在途刷新（按连接键控）：并发未广播调用共享同一次 `tools/list`。 */
const refreshInFlight = new WeakMap<WorkbenchConnection, Promise<void>>()

/**
 * Take the pending in-flight refresh or start one and register it in the
 * single-flight map. The map stores the raw refresh; the cleanup rides the
 * promise returned here, so that chain always has a consumer.
 * @param connection - the live connection to refresh.
 * @param timeoutMs - explicit refresh budget for a new refresh.
 * @param signal - cancellation of the caller this refresh is started for.
 * @returns the in-flight refresh when one is pending, else a newly started one.
 */
function startRefresh(connection: WorkbenchConnection, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  const pending = refreshInFlight.get(connection)
  if (pending !== undefined) return pending
  const refresh = refreshToolNamesNow(connection, timeoutMs, signal)
  refreshInFlight.set(connection, refresh)
  return refresh.finally(() => {
    if (refreshInFlight.get(connection) === refresh) refreshInFlight.delete(connection)
  })
}

/**
 * Refresh one connection's advertised tool names in place with a fresh
 * `tools/list`. Concurrent callers on the same connection share the in-flight
 * refresh（单飞：页面挂载并行发多个请求时只打一次刷新）. The caller that started
 * the shared refresh owns its outcome: any failure throws as-is. A late joiner
 * rethrows the shared failure as-is when its own `signal` has aborted by settle
 * time, and also without retry when the shared failure is a transport
 * projection（`workbench_unauthorized` / `workbench_server_error` /
 * `workbench_protocol_error` / `workbench_network_error`：所有等待者得到同一投
 * 影）; when the shared refresh settled with `workbench_call_cancelled` or
 * `workbench_call_timeout`（首发调用方取消或预算耗尽）while the joiner itself is
 * not cancelled, the joiner retries exactly once with its own remaining budget
 * (its `timeoutMs` minus the wall-clock time since it joined; remaining ≤ 0 →
 * `workbench_call_timeout`), joining a newer in-flight refresh when one exists
 * or starting one; the retry's result is final. Elapsed time is measured with
 * `Date.now()` in this module（本文件无时钟注入缝）. On success the set is
 * replaced wholesale and the caller is expected to re-stamp `refreshedAt`; on
 * failure the projection follows the same transport table as calls, so the
 * caller decides whether to retry.
 * @param connection - the live connection to refresh.
 * @param timeoutMs - explicit refresh budget (the current call's remaining budget).
 * @param signal - caller cancellation.
 * @returns resolves once this caller holds a settled refresh of its own (initiated, joined, or retried).
 * @throws {WorkbenchMcpError} timeout / cancellation / transport projections.
 */
export function refreshToolNames(connection: WorkbenchConnection, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  const joinedAt = Date.now()
  const pending = refreshInFlight.get(connection)
  if (pending === undefined) return startRefresh(connection, timeoutMs, signal)
  return pending.catch((error: unknown) => {
    // 后到者自己已取消：共享刷新的错误原样抛出，不重试。
    if (signal?.aborted === true) throw error
    // 首发调用方取消或预算耗尽：后到者以自己的剩余预算重试且仅重试一次。
    if (error instanceof WorkbenchMcpError
      && (error.code === 'workbench_call_cancelled' || error.code === 'workbench_call_timeout')) {
      const remainingMs = timeoutMs - (Date.now() - joinedAt)
      if (remainingMs <= 0) {
        throw new WorkbenchMcpError('workbench_call_timeout', `workbench tools/list refresh timed out after ${String(timeoutMs)}ms`)
      }
      return startRefresh(connection, remainingMs, signal)
    }
    // 传输层投影：所有等待者得到同一投影，不重试。
    throw error
  })
}

/** One actual `tools/list` round-trip behind the {@linkcode refreshToolNames} single-flight. */
async function refreshToolNamesNow(connection: WorkbenchConnection, timeoutMs: number, signal: AbortSignal | undefined): Promise<void> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const effective = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let listing: Awaited<ReturnType<Client['listTools']>>
  try {
    // listTools() 聚合全部分页。
    listing = await connection.client.listTools(undefined, { signal: effective })
  } catch (error: unknown) {
    if (signal?.aborted === true) throw new WorkbenchMcpError('workbench_call_cancelled', 'workbench tools/list refresh cancelled by caller')
    if (timeout.aborted) throw new WorkbenchMcpError('workbench_call_timeout', `workbench tools/list refresh timed out after ${String(timeoutMs)}ms`)
    throw projectTransportFailure(error, 'workbench tools/list refresh failed')
  }
  connection.toolNames = new Set(listing.tools.map(tool => tool.name))
}

/** Close one SDK client, tolerating an already-closed transport. */
async function closeClient(client: Client): Promise<void> {
  try {
    await client.close()
  } catch (_closeFailed: unknown) {
    // transport 已关闭或对端先断开时 close 抛错；连接对象随后丢弃。
  }
}

/**
 * Project one transport-layer failure: cancellation and timeout are the
 * caller's to decide first; everything else goes through
 * {@linkcode classifyTransportError} with the HTTP status attached when present.
 * @param error - the thrown cause.
 * @param what - stable diagnostic prefix for the message (error name only).
 * @returns the projected Workbench MCP error.
 */
function projectTransportFailure(error: unknown, what: string): WorkbenchMcpError {
  const status = transportStatusOf(error)
  return new WorkbenchMcpError(
    classifyTransportError(error),
    `${what}: ${describeErrorName(error)}`,
    undefined,
    status,
  )
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
    throw projectTransportFailure(error, 'workbench call failed')
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
