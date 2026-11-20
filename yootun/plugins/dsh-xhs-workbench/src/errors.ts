/**
 * 稳定错误模型（基线清单 §5 的白名单口径）：路由响应只允许出现本表码值。
 * 设备端本地码沿用旧插件 LOCAL_ERROR_CODES；任务链与看板码为 Workbench 服务端
 * envelope `error.code` 白名单（X4/X5 消费），传输/协议失败收敛为本域稳定码，
 * 原始错误不透传。
 * @module
 */

/** 服务端任务链稳定码（workbench_xhs_task_* / result_get envelope）。 */
export const SERVER_TASK_ERROR_CODES = Object.freeze([
  'TASK_NOT_FOUND',
  'TASK_STATE_CONFLICT',
  'RESULT_NOT_READY',
  'CONFIRMATION_REQUIRED',
  'VALIDATION_ERROR',
  'STEP_INPUT_TOO_LARGE',
  'ASSET_NOT_FOUND',
  'PROVIDER_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN',
])

/** 服务端爆款看板稳定码（workbench_xhs_hotboard_* envelope）。 */
export const SERVER_HOTBOARD_ERROR_CODES = Object.freeze([
  'XHS_HOTBOARD_INVALID_ARGUMENT',
  'XHS_HOTBOARD_NOT_FOUND',
  'XHS_HOTBOARD_ACTIVE_RUN_EXISTS',
  'XHS_HOTBOARD_BUDGET_EXHAUSTED',
  'XHS_HOTBOARD_KEYWORD_EMPTY',
  'XHS_HOTBOARD_KEYWORD_CONFLICT',
  'XHS_HOTBOARD_EVIDENCE_INSUFFICIENT',
  'XHS_HOTBOARD_LABEL_CONFLICT',
  'XHS_HOTBOARD_AI_SCHEMA_INVALID',
  'XHS_HOTBOARD_PROVIDER_FAILED',
  'XHS_HOTBOARD_SETTING_TOML_MANAGED',
  'XHS_HOTBOARD_INTERNAL_ERROR',
])

/** 服务端公共码（确认/校验/幂等，两组 envelope 共用）。 */
export const SERVER_COMMON_ERROR_CODES = Object.freeze([
  'CONFIRMATION_REQUIRED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN',
])

/** 本域（设备端）稳定码（沿用旧插件白名单 + 路由层新增）。 */
export const LOCAL_ERROR_CODES = Object.freeze([
  'GOOGLE_CHROME_MISSING',
  'PLAYWRIGHT_DRIVER_MISSING',
  'SESSION_EXPIRED',
  'LOGIN_TIMEOUT',
  'CAPTCHA_DETECTED',
  'COLLECT_FAILED',
  'PROFILE_BUSY',
  'PUBLISH_FAILED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'PROBE_FAILED',
  'LOGIN_FAILED',
  'XHS_ROUTE_UNKNOWN_ACTION',
  'XHS_ROUTE_INVALID_REQUEST',
  'XHS_ROUTE_PAYLOAD_TOO_LARGE',
  'XHS_ROUTE_REFUSED',
  'login_aborted',
  'plugin_disposing',
  'xhs_operation_request_failed',
])

/** 全部对外合法码值（路由 reason 的唯一合法取值）。 */
export const STABLE_ERROR_CODES = Object.freeze([
  ...new Set([...SERVER_TASK_ERROR_CODES, ...SERVER_HOTBOARD_ERROR_CODES, ...SERVER_COMMON_ERROR_CODES, ...LOCAL_ERROR_CODES]),
])

export type StableErrorCode = typeof STABLE_ERROR_CODES[number]

/** 服务端白名单码合集（X4/X5 envelope 投影用；本地收敛判断不用）。 */
export const SERVER_ERROR_CODES = Object.freeze([...new Set([...SERVER_TASK_ERROR_CODES, ...SERVER_HOTBOARD_ERROR_CODES, ...SERVER_COMMON_ERROR_CODES])])

/** 带稳定码的错误（内部诊断用；只有 code 对外）。 */
export class XhsError extends Error {
  /** Stable code from {@link STABLE_ERROR_CODES}. */
  readonly code: StableErrorCode

  /**
   * @param code - stable public code.
   * @param message - diagnostic text for logs (never returned to callers).
   */
  constructor(code: StableErrorCode, message: string) {
    super(message)
    this.name = 'XhsError'
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
 * Normalize any thrown cause into a stable code (旧 index.js 顶层 catch 口径)：
 * errors carrying a whitelisted `code`（CollectError / 本地失败）project it;
 * Chrome/driver missing project by class name; Workbench business failures
 * project their server code (when whitelisted); everything else collapses to
 * the legacy tool-call fallback `xhs_operation_request_failed`.
 * @param error - anything thrown.
 * @returns one of {@link STABLE_ERROR_CODES}.
 */
export function safeCode(error: unknown): StableErrorCode {
  if (error instanceof XhsError) return error.code
  const name = error instanceof Error ? error.name : undefined
  if (name === 'ChromeMissingError') return 'GOOGLE_CHROME_MISSING'
  if (name === 'DriverMissingError') return 'PLAYWRIGHT_DRIVER_MISSING'
  const direct = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (typeof direct === 'string' && (STABLE_ERROR_CODES as readonly string[]).includes(direct)) return direct as StableErrorCode
  const server = serverCodeOf(error)
  if (server !== undefined && (SERVER_ERROR_CODES as readonly string[]).includes(server)) return server as StableErrorCode
  return 'xhs_operation_request_failed'
}
