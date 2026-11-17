/**
 * Host API 客户端：页面只访问本地同源路由（`/api/desktop/yootun/wx-workbench`），
 * 不直连任何远端地址；错误只透出稳定 reason。
 * @module
 */

export const HOST_PATH = '/api/desktop/yootun/wx-workbench'

/** Host 响应的通用形状（白名单投影）。 */
export interface HostResponse extends Record<string, unknown> {
  status: 'ok' | 'error'
  reason?: string | undefined
}

/**
 * POST one action to the local Host.
 * @param action - whitelisted action name.
 * @param args - action arguments (schema-checked by the Host).
 * @returns the Host payload; throws `reason` on error envelopes.
 */
export async function hostAction(action: string, args: Record<string, unknown> = {}): Promise<HostResponse & Record<string, unknown>> {
  const response = await fetch(HOST_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...args }),
  })
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object') throw new Error('default')
  const record = payload as HostResponse & Record<string, unknown>
  if (record.status === 'error') throw new Error(record.reason ?? 'default')
  return record
}
