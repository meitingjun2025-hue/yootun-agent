/**
 * Host API 客户端：页面只访问本地同源路由
 * （`/api/desktop/yootun/douyin-workbench`），不直连任何远端地址；30 秒超时、
 * `redirect: 'error'`、same-origin 凭证；错误只透出稳定 reason（未知传输失败
 * 收敛为 `douyin_operation_request_failed`）。
 * @module
 */

export const HOST_PATH = '/api/desktop/yootun/douyin-workbench'

/** 单次 Host 调用超时（毫秒）：长动作由宿主异步执行、页面轮询状态。 */
const REQUEST_TIMEOUT_MS = 30_000

/** Host 响应的通用形状（白名单投影）。 */
export interface HostResponse extends Record<string, unknown> {
  status: 'ready' | 'started' | 'created' | 'error'
  reason?: string | undefined
}

/**
 * POST one action to the local Host.
 * @param action - whitelisted action name.
 * @param args - action arguments (schema-checked by the Host).
 * @returns the Host payload; throws the stable `reason` on error envelopes.
 */
export async function hostAction(action: string, args: Record<string, unknown> = {}): Promise<HostResponse & Record<string, unknown>> {
  const response = await fetch(HOST_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'error',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action, ...args }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object') throw new Error('douyin_operation_request_failed')
  const record = payload as HostResponse & Record<string, unknown>
  if (record.status === 'error') throw new Error(record.reason ?? 'douyin_operation_request_failed')
  return record
}
