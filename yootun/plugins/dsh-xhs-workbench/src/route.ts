/**
 * Host 路由层：`/api/desktop/yootun/xhs-workbench` 单端点 POST 分发。安全口径
 * （分册 08 §10.3）：只接受 POST、loopback 远端 + 浏览器来源标记信任判定
 * （显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest` 转发剥离
 * 两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式 action
 * allowlist、每 action 输入 schema 并拒绝未知字段、稳定错误码（不透传内部
 * 异常）。handler 经 deps 注入，本模块不持有业务状态。
 *
 * action 集合按批次扩充：本批（X1+X2）只登记已实现的 8 项；task/hotboard/
 * publish/upload/assistant 各 action 随对应批次加入，未实现项按 unknown_action
 * 拒绝（fail loud，不做静默半实现）。
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { safeCode, STABLE_ERROR_CODES, XhsError, type StableErrorCode } from './errors.ts'

/** 路由固定路径。 */
export const ROUTE_PATH = '/api/desktop/yootun/xhs-workbench'

/** JSON 元数据体上限（bytes；迁移旧 32KB→wx 64KB 统一口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** One whitelisted action's input contract. */
export interface ActionSchema {
  /** Allowed fields; anything else is rejected. */
  fields: Readonly<Record<string, 'string' | 'boolean' | 'object'>>
  /** Max length for each string field. */
  limits?: Readonly<Record<string, number>>
}

/** Per-action input contracts (explicit allowlist; unknown fields rejected). */
export const ACTION_SCHEMAS: Readonly<Record<string, ActionSchema>> = Object.freeze({
  'browser.status': { fields: {} },
  'accounts.list': { fields: {} },
  'account.beginLogin': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.loginStatus': { fields: { loginId: 'string', accountId: 'string' }, limits: { loginId: 128, accountId: 128 } },
  'account.probe': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.removeLocal': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collect.start': { fields: { accountId: 'string', idempotencyKey: 'string' }, limits: { accountId: 128, idempotencyKey: 128 } },
  'collect.status': { fields: { collectId: 'string' }, limits: { collectId: 128 } },
  'hotboard.settings': { fields: {} },
  'hotboard.settingsUpdate': { fields: { settings: 'object', confirm: 'boolean', idempotencyKey: 'string' }, limits: { idempotencyKey: 128 } },
})

/** Whitelisted stable reason codes a handler may return (route-level superset). */
export function isStableCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value)
}

/** One handled action's arguments after validation. */
export type ActionArgs = Record<string, string | boolean | Record<string, unknown> | undefined>

/**
 * Validate one request body against the action's schema: unknown fields and
 * wrong types are rejected (`XHS_ROUTE_INVALID_REQUEST`); strings are trimmed
 * and length-capped.
 * @param action - the whitelisted action name.
 * @param body - the parsed request body.
 * @returns the validated arguments.
 * @throws {XhsError} `XHS_ROUTE_INVALID_REQUEST`.
 */
export function validateActionArgs(action: string, body: Record<string, unknown>): ActionArgs {
  const schema = ACTION_SCHEMAS[action]
  if (schema === undefined) throw new XhsError('XHS_ROUTE_UNKNOWN_ACTION', `unknown action ${action}`)
  for (const key of Object.keys(body)) {
    // `action` 是分发键本身，不属于各 action 的参数 schema。
    if (key === 'action') continue
    if (!(key in schema.fields)) throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `unknown field "${key}" for ${action}`)
  }
  const args: ActionArgs = {}
  for (const [key, kind] of Object.entries(schema.fields)) {
    const value = body[key]
    if (value === undefined || value === null) continue
    if (kind === 'boolean') {
      if (typeof value !== 'boolean') throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" must be boolean`)
      args[key] = value
      continue
    }
    if (kind === 'object') {
      // 对象字段只做浅形状校验；键级白名单由 handler 按旧插件口径校验。
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" must be an object`)
      }
      args[key] = value as Record<string, unknown>
      continue
    }
    if (typeof value !== 'string') throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" must be a string`)
    const limit = schema.limits?.[key] ?? 128
    const text = value.trim().slice(0, limit)
    if (text === '') continue
    args[key] = text
  }
  return args
}

/** 路由信任判定（对齐官方浏览器信任边界 api-request-trust，wx 模板同款）：
 * loopback 远端是基础防线，负责把请求绑定到本机；显式 `sec-fetch-site:
 * cross-site` 一律拒绝；显式 Origin 必须精确等于 expectedOrigin（字面 `null`、
 * 异源都拒绝），Origin 缺失不单独视为攻击——Windows Desktop 的 Electron main
 * 进程 `forwardWebRequest` 转发请求时会剥掉 Origin 与 Sec-Fetch-Site 两枚头，
 * 双头缺失是 Desktop 转发的合法形态，来源边界由 loopback 承担。
 * @param req - Node HTTP 请求。
 * @param expectedOrigin - 本 webServer 绑定的精确 origin。
 * @returns 是否放行。 */
export function permitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  return origin === undefined || origin === expectedOrigin
}

/** Read and parse the JSON body with the size cap; malformed bodies become `{}` (schema layer rejects them). */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new XhsError('XHS_ROUTE_PAYLOAD_TOO_LARGE', 'request body too large')
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
      send(res, 405, { status: 'error', reason: 'method_not_allowed' })
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
      // 统一收敛：稳定码白名单外的原始错误不透传（基线清单 §5）。
      const code = safeCode(error)
      const reason = isStableCode(code) ? code : 'XHS_ROUTE_INVALID_REQUEST'
      const status = code === 'XHS_ROUTE_PAYLOAD_TOO_LARGE' ? 413 : reason.startsWith('XHS_ROUTE') ? 400 : 200
      send(res, status, { status: 'error', reason })
    }
  }
}
