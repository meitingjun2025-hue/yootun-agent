/**
 * 稳定错误模型（分册 15 §6 冻结的白名单口径）：路由响应只允许出现本表码值。
 * 服务端稳定码为 Workbench envelope `error.code` 白名单（D2+ 消费）；本地码含
 * 路由层、浏览器探测与旧插件小写 reason 码。原始错误与传输细节不透传；日志与
 * 响应不得出现 Authorization、Cookie、storage_state、本地路径、上游原文、内网
 * 地址。
 * @module
 */
import type { WorkbenchErrorCode } from '@yootun/dsh-workbench-mcp'

/** 服务端抖音数据域稳定码（workbench_douyin_* envelope；分册 15 §6 冻结）。 */
const SERVER_DOUYIN_ERROR_CODE_VALUES = [
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_NOT_ACCESSIBLE',
  'WORK_NOT_FOUND',
  'RUN_NOT_FOUND',
  'RUN_ACCOUNT_MISMATCH',
  'RUN_NOT_RUNNING',
  'RUN_STILL_ACTIVE',
  'RUN_LIST_META_REQUIRED',
  'HEARTBEAT_SEQ_REGRESSED',
  'PUBLISH_SINCE_MISMATCH',
  'DAILY_DAY_IN_FUTURE',
  'UNAUTHORIZED',
  'PAYLOAD_TOO_LARGE',
  'DOUYIN_EXPORT_TOO_LARGE',
  'INVALID_CURSOR',
  'INVALID_SORT',
  'RULE_VERSION_MISMATCH',
  'INVALID_TIME_WINDOW',
  'INVALID_METRIC',
  'CONTRACT_VERSION_MISMATCH',
  'TREND_RANGE_TOO_LARGE',
  'OVERVIEW_SAMPLE_TOO_LARGE',
  'AI_ANALYSIS_RUNNING',
  'AI_ANALYSIS_GLOBAL_CONCURRENCY_LIMIT',
  'AI_ANALYSIS_INSUFFICIENT_DATA',
  'AI_ANALYSIS_MODEL_FAILED',
  'AI_ANALYSIS_SCHEMA_INVALID',
  'AI_ANALYSIS_TIMEOUT',
  'AI_ANALYSIS_ENQUEUE_FAILED',
  'AI_ANALYSIS_MODEL_CONFIG_MISSING',
  'AI_ANALYSIS_PROMPT_INVALID',
  'REPORT_NOT_FOUND',
  'REPORT_DISABLED',
  'REPORT_INSUFFICIENT_DATA',
  'REPORT_MODEL_FAILED',
  'REPORT_SCHEMA_INVALID',
  'REPORT_TIMEOUT',
  'REPORT_TRUNCATED',
  'REPORT_INPUT_TOO_LARGE',
  'REPORT_PAYLOAD_TOO_LARGE',
  'REPORT_ENQUEUE_FAILED',
  'REPORT_MODEL_CONFIG_MISSING',
  'REPORT_LEASE_EXPIRED',
  'REPORT_PROMPT_INVALID',
  'OWNER_NAME_REQUIRED',
  'OWNER_NAME_INVALID',
  'PROMOTION_ALREADY_EXISTS',
  'PROMOTION_NOT_FOUND',
  'PROMOTION_FIELD_REQUIRED',
  'PROMOTION_VALUE_INVALID',
  'TOO_MANY_ACCOUNTS',
  'SCHEDULE_ROW_NOT_FOUND',
  'SCHEDULE_ROW_CONFLICT',
  'SCHEDULE_VALIDATION_ERROR',
] as const

export const SERVER_DOUYIN_ERROR_CODES = Object.freeze([...SERVER_DOUYIN_ERROR_CODE_VALUES])

/** 服务端 viral 域稳定码（workbench_viral_* envelope；分册 15 §6 冻结）。 */
const SERVER_VIRAL_ERROR_CODE_VALUES = [
  'ASYNC_RUN_NOT_FOUND',
  'UNKNOWN_REWRITE_RULE',
  'CANDIDATE_NOT_FOUND',
  'STORYBOARD_NOT_READY',
  'DOUYIN_DOWNLOAD_URL_MISSING',
  'PROVIDER_ERROR',
  'ONEAPI_BUDGET_EXHAUSTED',
  'DOWNLOAD_JOB_NOT_FOUND',
  'DOWNLOAD_JOB_TIMEOUT',
  'DOWNLOAD_JOB_NOT_CLAIMABLE',
  'DOUYIN_VIDEO_DOWNLOAD_FAILED',
  'DOUYIN_TOS_UPLOAD_FAILED',
  'TOS_PRESIGN_FAILED',
  'VIRAL_VIDEO_NO_ACTIVE_SEEDS',
  'VIRAL_VIDEO_ACTIVE_RUN_EXISTS',
  'VIRAL_VIDEO_SEED_LIMIT_INVALID',
  'VIRAL_VIDEO_SEARCH_DISPATCH_FAILED',
  'KNOWLEDGE_NOT_FOUND',
  'GENE_NOT_READY',
  'GENE_EXTRACT_RUNNING',
  'GENE_INPUT_MISSING',
  'GENE_EXTRACT_MODEL_FAILED',
  'GENE_EXTRACT_TIMEOUT',
  'GENE_EXTRACT_PARSE_FAILED',
  'GENE_EXTRACT_QUALITY_FAILED',
  'GENE_EXTRACT_LEASE_EXPIRED',
  'GENE_EXTRACT_DISABLED',
] as const

export const SERVER_VIRAL_ERROR_CODES = Object.freeze([...SERVER_VIRAL_ERROR_CODE_VALUES])

/** 服务端公共码（确认/校验/幂等；分册 15 §6 冻结）。 */
const SERVER_COMMON_ERROR_CODE_VALUES = [
  'INVALID_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_REQUIRED',
  'CONFIRMATION_REQUIRED',
  'VALIDATION_ERROR',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNKNOWN',
] as const

export const SERVER_COMMON_ERROR_CODES = Object.freeze([...SERVER_COMMON_ERROR_CODE_VALUES])

/** 连接器稳定码登记（原样投影，不收敛兜底）；键受 `WorkbenchErrorCode` 约束，缺键即类型报错。 */
const WORKBENCH_ERROR_CODES: Readonly<Record<WorkbenchErrorCode, true>> = Object.freeze({
  workbench_not_activated: true,
  workbench_credential_unavailable: true,
  workbench_tool_denied: true,
  workbench_tool_unavailable: true,
  workbench_call_timeout: true,
  workbench_call_cancelled: true,
  workbench_network_error: true,
  workbench_protocol_error: true,
  workbench_call_failed: true,
  workbench_unavailable: true,
  // 2026-11-26 传输层状态分类新增（分册 08 §5.2）。
  workbench_unauthorized: true,
  workbench_server_error: true,
})

/** 登记表的键清单（键集受 `WorkbenchErrorCode` 约束；Object.keys 会放宽为 string[]）。 */
const WORKBENCH_ERROR_CODE_KEYS = Object.keys(WORKBENCH_ERROR_CODES) as readonly WorkbenchErrorCode[]

/** 本域（设备端）稳定码：路由层 + 浏览器探测 + 旧插件小写 reason（分册 15 §6）。 */
const LOCAL_ERROR_CODE_VALUES = [
  'GOOGLE_CHROME_MISSING',
  'PLAYWRIGHT_DRIVER_MISSING',
  // Workbench MCP 连接器传输层稳定码（分册 15 §6：原样投影，不收敛兜底）；见上方登记表。
  ...WORKBENCH_ERROR_CODE_KEYS,
  'DOUYIN_TOOL_UNAVAILABLE',
  'DOUYIN_ROUTE_UNKNOWN_ACTION',
  'DOUYIN_ROUTE_INVALID_REQUEST',
  'DOUYIN_ROUTE_PAYLOAD_TOO_LARGE',
  'DOUYIN_ROUTE_REFUSED',
  // Host action 传输收敛码（2026-11-26 起 kit createHostAction 统一产出）。
  'host_unreachable',
  'plugin_disposing',
  // 旧插件兜底码（沿用旧 route 语义，xhs 同款先例）。
  'douyin_operation_request_failed',
  // 旧 session/chrome 探测小写原因码（D2 消费；D1 登记全集）。
  'session_invalid',
  'storage_state_missing',
  'login_page_detected',
  'user_info_unavailable',
  'session_error',
  'login_timeout',
  'login_failed',
  'probe_failed',
  'refresh_failed',
  'account_save_failed',
  // D2 登录/探测/采集链路细分原因（run error 槽与 handler reason 槽取值）。
  'run_state_corrupt',
  'recovery_required',
  'login_aborted',
  'identity_not_stable',
  'no_session_cookie',
  'account_mismatch',
  'collect_cancelled',
  'ingest_failed',
  'start_failed',
  'stale_report',
  'session_report_rejected',
  'already_ok',
  'remote_account_unavailable',
  'profile_unverified',
  // 旧路由确定性校验小写 reason（handlers 直返，client 半据此映射提示）。
  'account_id_required',
  'work_id_required',
  'run_id_required',
  'share_url_required',
  'candidate_id_required',
  'job_id_required',
  'row_id_invalid',
  'version_invalid',
  'idempotency_key_required',
  'collect_busy',
  'no_eligible_account',
  'session_required',
  'publish_since_required',
  'expected_work_count_out_of_range',
  'cleanup_failed',
  'export_too_large',
  'export_failed',
  'overview_too_many_accounts',
  // 批量采集批内熔断（collectAll 批次 error 槽与未开始条目 reason 槽；不是路由 reason）。
  'risk_paused',
] as const

export const LOCAL_ERROR_CODES = Object.freeze([...LOCAL_ERROR_CODE_VALUES])

/** 全部对外合法码值（路由 reason 的唯一合法取值）。 */
export const STABLE_ERROR_CODES = Object.freeze([
  ...new Set([...SERVER_DOUYIN_ERROR_CODES, ...SERVER_VIRAL_ERROR_CODES, ...SERVER_COMMON_ERROR_CODES, ...LOCAL_ERROR_CODES]),
])

export type StableErrorCode = typeof STABLE_ERROR_CODES[number]

/** 服务端白名单码合集（Workbench envelope 投影用；本地收敛判断不用）。 */
export const SERVER_ERROR_CODES = Object.freeze([
  ...new Set([...SERVER_DOUYIN_ERROR_CODES, ...SERVER_VIRAL_ERROR_CODES, ...SERVER_COMMON_ERROR_CODES]),
])

/** 带稳定码的错误（内部诊断用；只有 code 对外）。 */
export class DouyinError extends Error {
  /** Stable code from {@link STABLE_ERROR_CODES}. */
  readonly code: StableErrorCode

  /**
   * @param code - stable public code.
   * @param message - diagnostic text for logs (never returned to callers).
   */
  constructor(code: StableErrorCode, message: string) {
    super(message)
    this.name = 'DouyinError'
    this.code = code
  }
}

/**
 * Extract the server's stable code from a Workbench business failure: the
 * payload's nested `error.code`（Tools contract shape）. Unknown codes map to
 * the safe fallback by {@link safeCode}.
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
 * Normalize any thrown cause into a stable code（旧 index.js 顶层 catch 口径）：
 * errors carrying a whitelisted `code`（DouyinError / 本地失败）project it;
 * Chrome/driver missing project by class name; Workbench business failures
 * project their server code（when whitelisted）; everything else collapses to
 * the legacy tool-call fallback `douyin_operation_request_failed`.
 * @param error - anything thrown.
 * @returns one of {@link STABLE_ERROR_CODES}.
 */
export function safeCode(error: unknown): StableErrorCode {
  if (error instanceof DouyinError) return error.code
  const name = error instanceof Error ? error.name : undefined
  if (name === 'ChromeMissingError') return 'GOOGLE_CHROME_MISSING'
  if (name === 'DriverMissingError') return 'PLAYWRIGHT_DRIVER_MISSING'
  const direct = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (typeof direct === 'string' && (STABLE_ERROR_CODES as readonly string[]).includes(direct)) return direct as StableErrorCode
  const server = serverCodeOf(error)
  // envelope 稳定码投影按全量稳定码集合判白（服务端业务码 + workbench 传输码）。
  if (server !== undefined && (STABLE_ERROR_CODES as readonly string[]).includes(server)) return server as StableErrorCode
  return 'douyin_operation_request_failed'
}

/** Whether one reason string is a route-legal stable code. */
export function isStableCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value)
}
