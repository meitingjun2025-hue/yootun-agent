/**
 * Host 路由层：`/api/desktop/yootun/wx-workbench` 单端点 POST 分发。安全口径
 * （分册 08 §10.3）：只接受 POST、loopback + expected origin + sec-fetch-site、
 * 请求体上限、显式 action allowlist、每 action 输入 schema 并拒绝未知字段、
 * 稳定错误码（不透传内部异常）。handler 经 deps 注入，本模块不持有业务状态。
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WxError, safeCode, STABLE_ERROR_CODES, type StableErrorCode } from './errors.ts'

/** 路由固定路径。 */
export const ROUTE_PATH = '/api/desktop/yootun/wx-workbench'

/** JSON 元数据体上限（bytes；迁移旧 64KB 口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** One whitelisted action's input contract. */
export interface ActionSchema {
  /** Allowed fields; anything else is rejected. */
  fields: Readonly<Record<string, 'string' | 'boolean'>>
  /** Max length for each string field. */
  limits?: Readonly<Record<string, number>>
}

/** Per-action input contracts (explicit allowlist; unknown fields rejected). */
export const ACTION_SCHEMAS: Readonly<Record<string, ActionSchema>> = Object.freeze({
  'browser.status': { fields: {} },
  'accounts.list': { fields: {} },
  'account.beginLogin': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.loginStatus': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.refreshLoginQr': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.probe': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.promote': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.removeLocal': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.removeRemote': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collect.start': { fields: { accountId: 'string', newAttempt: 'boolean' }, limits: { accountId: 128 } },
  'collect.status': { fields: {} },
  'collect.cancel': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collectAll.start': { fields: {} },
  'collectAll.cancel': { fields: {} },
  'collectAll.status': { fields: {} },
  'run.get': { fields: { runId: 'string' }, limits: { runId: 128 } },
  'works.list': { fields: { accountId: 'string', sort: 'string', order: 'string', publishedFrom: 'string', publishedTo: 'string' }, limits: { accountId: 128, sort: 32, order: 8, publishedFrom: 10, publishedTo: 10 } },
  'work.get': { fields: { accountId: 'string', workId: 'string' }, limits: { accountId: 128, workId: 128 } },
  'work.trend': { fields: { accountId: 'string', workId: 'string' }, limits: { accountId: 128, workId: 128 } },
  'account.overview': { fields: { accountId: 'string', window: 'string' }, limits: { accountId: 128, window: 16 } },
  'fans.profile.get': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
})

/** Whitelisted stable reason codes a handler may return (route-level superset). */
export function isStableCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value)
}

/** One handled action's arguments after validation. */
export type ActionArgs = Record<string, string | boolean | undefined>

/**
 * Validate one request body against the action's schema: unknown fields and
 * wrong types are rejected (`WX_ROUTE_INVALID_REQUEST`); strings are trimmed
 * and length-capped.
 * @param action - the whitelisted action name.
 * @param body - the parsed request body.
 * @returns the validated arguments.
 * @throws {WxError} `WX_ROUTE_INVALID_REQUEST`.
 */
export function validateActionArgs(action: string, body: Record<string, unknown>): ActionArgs {
  const schema = ACTION_SCHEMAS[action]
  if (schema === undefined) throw new WxError('WX_ROUTE_UNKNOWN_ACTION', `unknown action ${action}`)
  for (const key of Object.keys(body)) {
    // `action` 是分发键本身，不属于各 action 的参数 schema。
    if (key === 'action') continue
    if (!(key in schema.fields)) throw new WxError('WX_ROUTE_INVALID_REQUEST', `unknown field "${key}" for ${action}`)
  }
  const args: ActionArgs = {}
  for (const [key, kind] of Object.entries(schema.fields)) {
    const value = body[key]
    if (value === undefined || value === null) continue
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" must be boolean`)
      args[key] = value
      continue
    }
    if (typeof value !== 'string') throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" must be a string`)
    const limit = schema.limits?.[key] ?? 128
    const text = value.trim().slice(0, limit)
    if (text === '') continue
    args[key] = text
  }
  return args
}

/** 同源校验（收紧口径）：loopback + Origin 精确相等 + sec-fetch-site 精确
 * same-origin。缺失头部一律拒绝（浏览器同源 fetch 恒带这两类头；缺失即非浏览器
 * 或被剥离，不得放行）。loopback 由 webServer 层强制，这里再独立核一次。 */
export function permitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  return loopback
    && req.headers.origin === expectedOrigin
    && req.headers['sec-fetch-site'] === 'same-origin'
}

/** Read and parse the JSON body with the size cap; malformed bodies become `{}` (schema layer rejects them). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new WxError('WX_ROUTE_PAYLOAD_TOO_LARGE', 'request body too large')
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    // JSON 解析失败按空体处理，schema 层会给出确定性拒绝。
    void error
    return {}
  }
}

function send(res: ServerResponse, code: number, payload: object): void {
  res.statusCode = code
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/** One action's business handler: receives validated args, returns the JSON payload. */
export type ActionHandler = (args: ActionArgs) => Promise<object>

/**
 * Build the POST handler for the route.
 * @param expectedOrigin - origin provider (the local webServer binds during init).
 * @param handlers - per-action business handlers (must cover the allowlist).
 * @returns the webServer route handler.
 */
export function createRouteHandler(
  expectedOrigin: () => string,
  handlers: Readonly<Record<string, ActionHandler>>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      send(res, 405, { status: 'error', reason: 'invalid_request' })
      return
    }
    if (!permitted(req, expectedOrigin())) {
      send(res, 403, { status: 'error', reason: 'forbidden' })
      return
    }
    try {
      const body = await readBody(req)
      const action = typeof body.action === 'string' ? body.action.trim().slice(0, 64) : ''
      if (!(action in ACTION_SCHEMAS) || handlers[action] === undefined) {
        send(res, 400, { status: 'error', reason: 'unknown_action' })
        return
      }
      const args = validateActionArgs(action, body)
      const payload = await handlers[action](args)
      send(res, 200, payload)
    } catch (error) {
      // 统一收敛：稳定码白名单外的原始错误不透传（§9.5）。
      const code = safeCode(error)
      const reason = isStableCode(code) ? code : 'WX_ROUTE_INVALID_REQUEST'
      const status = code === 'WX_ROUTE_PAYLOAD_TOO_LARGE' ? 413 : reason.startsWith('WX_ROUTE') ? 400 : 200
      send(res, status, { status: 'error', reason })
    }
  }
}
