/**
 * 稳定错误模型（迁移旧 tools-client.js 的白名单口径）：路由响应与会话投影
 * 只允许出现本表码值；Workbench 调用的业务失败按服务端 envelope `error.code`
 * 映射，传输/协议失败收敛为本域稳定码，原始错误不透传。
 * @module
 */

/** 服务端稳定错误码超集（tools 网关 ValueError/BusinessError/幂等层产出）。 */
const SERVER_ERROR_CODE_VALUES = [
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_NOT_ACCESSIBLE',
  'CONFIRMATION_REQUIRED',
  'LOCAL_CLEARED_REQUIRED',
  'DELETE_CLEANUP_FAILED',
  'WORK_NOT_FOUND',
  'RUN_NOT_FOUND',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_NOT_RUNNING',
  'RUN_STILL_ACTIVE',
  'RUN_LIST_META_REQUIRED',
  'RUN_COUNT_MISMATCH',
  'LIST_INCOMPLETE',
  'TIME_SERIES_LENGTH_MISMATCH',
  'FIELD_LENGTH_MISMATCH',
  'INVALID_DAY_RANGE',
  'INVALID_SORT',
  'INVALID_TIME_WINDOW',
  'TOO_MANY_ACCOUNTS',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_IDEMPOTENCY_KEY',
  'VALIDATION_ERROR',
  'PAYLOAD_TOO_LARGE',
  'UNAUTHORIZED',
  'HEARTBEAT_SEQ_REGRESSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN',
  'IDEMPOTENCY_KEY_REQUIRED',
] as const

export const SERVER_ERROR_CODES = Object.freeze([...SERVER_ERROR_CODE_VALUES])

/** 本域（设备端）稳定错误码。 */
const LOCAL_ERROR_CODE_VALUES = [
  'GOOGLE_CHROME_MISSING',
  'PLAYWRIGHT_DRIVER_MISSING',
  'WX_SESSION_INVALID',
  'WX_TOOL_UNAVAILABLE',
  'WX_ROUTE_UNKNOWN_ACTION',
  'WX_ROUTE_INVALID_REQUEST',
  'WX_ROUTE_PAYLOAD_TOO_LARGE',
  'WX_ROUTE_REFUSED',
  'WX_RUN_INTERRUPTED',
  'run_state_corrupt',
  'plugin_disposing',
  'login_timeout',
  'login_failed',
  'collect_busy',
  'session_required',
  'storage_state_missing',
  'pending_account',
  'probe_failed',
  'no_session_cookie',
  'auth_data_unavailable',
  'account_mismatch',
  'LOCAL_CLEARED_REQUIRED',
  // Host action 传输收敛码（2026-11-26 起 kit createHostAction 统一产出）。
  'host_unreachable',
  // 批量采集批内熔断批次原因 / 条目原因（2026-11-26 起，wx-collect-all-concurrency）。
  'risk_paused',
  // 批量取消批次 / 条目原因与采集启动空账号 ID（2026-11-26 起，wx-collect-all-concurrency 补齐）。
  'collect_cancelled',
  'account_id_required',
] as const

export const LOCAL_ERROR_CODES = Object.freeze([...LOCAL_ERROR_CODE_VALUES])

/** 全部对外合法码值（路由 reason / run reason 的唯一合法取值；`LOCAL_CLEARED_REQUIRED` 服务端与本域同码，去重）。 */
export const STABLE_ERROR_CODES = Object.freeze([...new Set([...SERVER_ERROR_CODES, ...LOCAL_ERROR_CODES])])

export type StableErrorCode = typeof STABLE_ERROR_CODES[number]

/** 带稳定码的错误（内部诊断用；只有 code 对外）。 */
export class WxError extends Error {
  /** Stable code from {@link STABLE_ERROR_CODES}. */
  readonly code: StableErrorCode

  /**
   * @param code - stable public code.
   * @param message - diagnostic text for logs (never returned to callers).
   */
  constructor(code: StableErrorCode, message: string) {
    super(message)
    this.name = 'WxError'
    this.code = code
  }
}

/**
 * Extract the server's stable code from a Workbench business failure: the
 * payload's nested `error.code` (Tools contract shape). Unknown codes map to
 * the safe fallback.
 * @param error - a thrown WorkbenchMcpError-shaped failure.
 * @returns the stable code, or `undefined` when the failure carries none.
 */
export function serverCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const payload = (error as { payload?: unknown }).payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const nested = (payload as { error?: { code?: unknown } }).error
  const code = typeof nested === 'object' && nested !== null ? nested.code : (payload as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/**
 * Normalize any thrown cause into a stable code. Workbench business failures
 * project their server code (when whitelisted); connector transport failures
 * project by their stable code（2026-11-26 起 `workbench_unauthorized` 显式投影
 * `UNAUTHORIZED`、`workbench_server_error` 显式投影 `WX_TOOL_UNAVAILABLE`，其余
 * 传输/协议失败收敛 `WX_TOOL_UNAVAILABLE`）; session-invalid keeps its dedicated
 * code; everything else collapses to the local fallback.
 * @param error - anything thrown.
 * @returns one of {@link STABLE_ERROR_CODES}.
 */
export function safeCode(error: unknown): StableErrorCode {
  if (error instanceof WxError) return error.code
  const name = error instanceof Error ? error.name : undefined
  if (name === 'ChromeMissingError') return 'GOOGLE_CHROME_MISSING'
  if (name === 'DriverMissingError') return 'PLAYWRIGHT_DRIVER_MISSING'
  const direct = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  // 连接器新码显式投影（分册 08 §5.2：鉴权失败不伪装成通用服务不可用）。
  if (direct === 'workbench_unauthorized') return 'UNAUTHORIZED'
  if (direct === 'workbench_server_error') return 'WX_TOOL_UNAVAILABLE'
  if (direct === 'WX_SESSION_INVALID') return 'WX_SESSION_INVALID'
  if (direct === 'GOOGLE_CHROME_MISSING') return 'GOOGLE_CHROME_MISSING'
  if (direct === 'PLAYWRIGHT_DRIVER_MISSING') return 'PLAYWRIGHT_DRIVER_MISSING'
  const server = serverCodeOf(error)
  if (server !== undefined && (SERVER_ERROR_CODES as readonly string[]).includes(server)) return server as StableErrorCode
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : undefined
  if (code !== undefined && (STABLE_ERROR_CODES as readonly string[]).includes(code)) return code as StableErrorCode
  if (typeof code === 'string' && code !== '') return 'WX_TOOL_UNAVAILABLE'
  return 'WX_TOOL_UNAVAILABLE'
}

/** Read the live `state` off a session-shaped record without control-flow narrowing. */
export function liveState<T extends { state: string }>(record: T): string {
  return record.state
}
