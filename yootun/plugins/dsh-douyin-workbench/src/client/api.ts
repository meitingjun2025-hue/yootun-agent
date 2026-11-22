/**
 * Host API 客户端：页面只访问本地同源路由
 * （`/api/desktop/yootun/douyin-workbench`），不直连任何远端地址；30 秒超时、
 * `redirect: 'error'`、same-origin 凭证；错误只透出稳定 reason（未知传输失败
 * 收敛为 `douyin_operation_request_failed`）。响应经 validateHostResponse
 * 边界验证：status ∈ ready/started/created/error、error 必带 string reason、
 * reason 若存在必须是 string；其余字段保持 unknown 由 schema.ts 投影；HTTP
 * 状态码不误当业务 status。
 * @module
 */

export const HOST_PATH = '/api/desktop/yootun/douyin-workbench'

/** 单次 Host 调用超时（毫秒）：长动作由宿主异步执行、页面轮询状态。 */
const REQUEST_TIMEOUT_MS = 30_000

/** Host 响应的业务状态枚举（路由层唯一合法取值）。 */
const HOST_STATUSES = ['ready', 'started', 'created', 'error'] as const

/** Host 响应的通用形状（边界验证后的白名单投影）。 */
export interface HostResponse extends Record<string, unknown> {
  status: (typeof HOST_STATUSES)[number]
  reason?: string | undefined
}

/**
 * Validate one parsed Host response at the client boundary.
 * @param payload - the parsed JSON body（普通 object 才被接受）.
 * @returns the validated envelope; status/reason 确定为合法形态，其余字段原样.
 * @throws `douyin_operation_request_failed` 当 payload 非普通对象、status 不在
 *   枚举内、status=error 缺 reason、或 reason 非字符串（传输层被劫持/代理改写
 *   的兜底收敛，不透传原文）。
 */
export function validateHostResponse(payload: unknown): HostResponse {
  if (payload === null || payload === undefined || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('douyin_operation_request_failed')
  }
  const record = payload as Record<string, unknown>
  const status = record.status
  if (typeof status !== 'string' || !(HOST_STATUSES as readonly string[]).includes(status)) {
    throw new Error('douyin_operation_request_failed')
  }
  const reason = record.reason
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('douyin_operation_request_failed')
  }
  if (status === 'error' && (reason === undefined || reason === '')) {
    throw new Error('douyin_operation_request_failed')
  }
  const validated: HostResponse = { ...record, status: status as HostResponse['status'] }
  if (reason !== undefined) validated.reason = reason
  return validated
}

/**
 * POST one action to the local Host.
 * @param action - whitelisted action name.
 * @param args - action arguments (schema-checked by the Host).
 * @returns the Host payload; throws the stable `reason` on error envelopes.
 */
export async function hostAction(action: string, args: Record<string, unknown> = {}): Promise<HostResponse & Record<string, unknown>> {
  let payload: unknown
  try {
    const response = await fetch(HOST_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ action, ...args }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    payload = await response.json()
  } catch {
    // 传输失败/超时/malformed JSON：稳定收敛，不透传原始报文。
    throw new Error('douyin_operation_request_failed')
  }
  const validated = validateHostResponse(payload)
  if (validated.status === 'error') throw new Error(validated.reason ?? 'douyin_operation_request_failed')
  return validated
}
