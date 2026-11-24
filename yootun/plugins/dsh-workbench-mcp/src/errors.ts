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
  | 'workbench_network_error'
  | 'workbench_protocol_error'
  | 'workbench_call_failed'
  | 'workbench_unavailable'

/** One projected Workbench failure: a stable code plus the server's stable envelope when present. */
export class WorkbenchMcpError extends Error {
  /** Stable machine code; callers localize from this, never from the message. */
  readonly code: WorkbenchErrorCode
  /** The server's stable error envelope (structuredContent) when the server produced one. */
  readonly payload?: unknown

  /**
   * @param code - stable projection code.
   * @param message - diagnostic text safe for logs (no upstream raw bodies).
   * @param payload - the server's stable envelope, when available.
   */
  constructor(code: WorkbenchErrorCode, message: string, payload?: unknown) {
    super(message)
    this.name = 'WorkbenchMcpError'
    this.code = code
    if (payload !== undefined) this.payload = payload
  }
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
