/**
 * 稳定错误投影（分册 08 §5.2/§5.4）：网络、协议、超时、取消与业务错误分开
 * 投影为稳定错误码；服务端稳定错误 envelope 原样挂到 payload（服务端契约
 * 保证其不含敏感值），上游原文（HTTP 体、stack、Authorization 等）不进入
 * message 或 payload。写操作网络失败不自动重试；幂等冲突与结果未知原样投影。
 * @module
 */

/** Stable machine codes the Host clients switch on. */
export type WorkbenchErrorCode =
  | 'workbench_not_activated'
  | 'workbench_credential_unavailable'
  | 'workbench_tool_denied'
  /** 工具通过域门，但服务端 `tools/list` 未广播（服务端未部署该版本或已移除）。 */
  | 'workbench_tool_unavailable'
  | 'workbench_call_timeout'
  | 'workbench_call_cancelled'
  /** 连接被拒、DNS、TLS、socket 挂起、SDK 内部超时等传输异常。 */
  | 'workbench_network_error'
  /** 其它 4xx（含 404 / 410：端点不存在或已下线）与 `serverName` 不匹配。 */
  | 'workbench_protocol_error'
  | 'workbench_call_failed'
  | 'workbench_unavailable'
  /** 传输层报告 HTTP 401 / 403（含 SDK 的 `UnauthorizedError`）：密钥被拒。 */
  | 'workbench_unauthorized'
  /** HTTP ≥ 500、408、429：服务端过载或故障。 */
  | 'workbench_server_error'

/** One projected Workbench failure: a stable code plus the server's stable envelope when present. */
export class WorkbenchMcpError extends Error {
  /** Stable machine code; callers localize from this, never from the message. */
  readonly code: WorkbenchErrorCode
  /** The server's stable error envelope (structuredContent) when the server produced one. */
  readonly payload?: unknown
  /** The HTTP status behind a transport-layer projection; absent for non-HTTP causes. */
  readonly status?: number

  /**
   * @param code - stable projection code.
   * @param message - diagnostic text safe for logs (no upstream raw bodies).
   * @param payload - the server's stable envelope, when available.
   * @param status - the HTTP status when the projection comes from one, else omit.
   */
  constructor(code: WorkbenchErrorCode, message: string, payload?: unknown, status?: number) {
    super(message)
    this.name = 'WorkbenchMcpError'
    this.code = code
    if (payload !== undefined) this.payload = payload
    if (status !== undefined) this.status = status
  }
}

/**
 * Classify one transport-layer failure into a stable code by the error type
 * (`name`) and its numeric `status` — never by parsing message text. Callers
 * must resolve their own cancellation and timeout first: `AbortError` /
 * `TimeoutError` reach this function only defensively and land on
 * `workbench_network_error`.
 * @param error - anything a transport call threw.
 * @returns the stable projection code per the 分册 08 §5.2 table.
 */
export function classifyTransportError(error: unknown): WorkbenchErrorCode {
  const name = error instanceof Error ? error.name : undefined
  if (name === 'UnauthorizedError') return 'workbench_unauthorized'
  if (name === 'SdkHttpError') {
    const status = transportStatusOf(error)
    if (status !== undefined) {
      if (status === 401 || status === 403) return 'workbench_unauthorized'
      if (status >= 500 || status === 408 || status === 429) return 'workbench_server_error'
      return 'workbench_protocol_error'
    }
  }
  return 'workbench_network_error'
}

/**
 * Read the HTTP status off an SDK HTTP transport failure without importing or
 * constructing SDK error classes: the transport stamps `name` and a numeric
 * `status` getter, and name-plus-shape survives duplicated SDK copies in one
 * process.
 * @param error - anything a transport call threw.
 * @returns the numeric HTTP status, or `undefined` when the cause is not one.
 */
export function transportStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/**
 * Extract the server's stable error code from a tool result's structured
 * envelope. The Tools contract nests it at `error.code`
 * (`{ error: { code, message, retryable, requestId } }`); a bare top-level
 * `code` is accepted for tolerance. Only string codes count; free text is
 * never scanned.
 * @param structuredContent - the CallToolResult's structuredContent.
 * @returns the stable code, or `undefined` when the envelope has none.
 */
export function serverErrorCodeOf(structuredContent: unknown): string | undefined {
  if (typeof structuredContent !== 'object' || structuredContent === null) return undefined
  const record = structuredContent as { code?: unknown; error?: { code?: unknown } }
  const nested = typeof record.error === 'object' && record.error !== null ? record.error.code : undefined
  const code = typeof nested === 'string' && nested !== '' ? nested : record.code
  return typeof code === 'string' && code !== '' ? code : undefined
}
