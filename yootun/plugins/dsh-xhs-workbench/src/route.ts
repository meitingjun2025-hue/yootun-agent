/**
 * Host 路由层：`/api/desktop/yootun/xhs-workbench` 单端点 POST 分发。安全口径
 * （分册 08 §10.3）：只接受 POST、loopback 远端 + 浏览器来源标记信任判定
 * （显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest` 转发剥离
 * 两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式 action
 * allowlist、每 action 输入 schema 并拒绝未知字段、稳定错误码（不透传内部
 * 异常）。handler 经 deps 注入，本模块不持有业务状态。
 *
 * action 集合按批次扩充：已实现 28 项（X1+X2 骨架 10 + X4 任务 4 + X5 看板 12 + X6 发布 2）；hotboard
 * 其余、publish/upload 各 action 随对应批次加入（assistant 已定案不做，D-6），未实现项按
 * unknown_action 拒绝（fail loud，不做静默半实现）。
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
  fields: Readonly<Record<string, 'string' | 'boolean' | 'object' | 'stringArray' | 'number'>>
  /** Max length for each string field. */
  limits?: Readonly<Record<string, number>>
  /** stringArray 字段档位覆盖（缺省 ≤9 项 × 2048 字符）。 */
  arrays?: Readonly<Record<string, { maxItems: number; itemMax: number }>>
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
  'task.create': {
    fields: {
      mediaType: 'string', theme: 'string', direction: 'string', refNote: 'string', refAccount: 'string',
      imageUrls: 'stringArray', videoUrl: 'string', videoUnderstanding: 'boolean', idempotencyKey: 'string',
    },
    limits: { mediaType: 16, theme: 500, direction: 500, refNote: 2048, refAccount: 200, videoUrl: 2048, idempotencyKey: 128 },
  },
  'task.status': { fields: { taskId: 'string' }, limits: { taskId: 64 } },
  'task.result': { fields: { taskId: 'string' }, limits: { taskId: 64 } },
  'task.cancel': { fields: { taskId: 'string', idempotencyKey: 'string' }, limits: { taskId: 64, idempotencyKey: 128 } },
  'hotboard.overview': {
    fields: {
      window: 'string', keyword: 'string', style: 'string', color: 'string', noteWord: 'string', commentWord: 'string',
      scoreMin: 'number', scoreMax: 'number', sort: 'string', onlyMain: 'boolean', onlyTagged: 'boolean', page: 'number', pageSize: 'number',
    },
    limits: { window: 4, keyword: 128, style: 64, color: 64, noteWord: 64, commentWord: 64, sort: 16 },
  },
  'hotboard.noteDetail': { fields: { noteId: 'string' }, limits: { noteId: 128 } },
  'hotboard.noteTagUpdate': {
    fields: { noteId: 'string', tagType: 'string', labelCode: 'string', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { noteId: 128, tagType: 16, labelCode: 64, idempotencyKey: 128 },
  },
  'hotboard.noteExclude': {
    fields: { noteId: 'string', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { noteId: 128, idempotencyKey: 128 },
  },
  'hotboard.keywords': {
    fields: { category: 'string', status: 'string', source: 'string', keyword: 'string', page: 'number', pageSize: 'number' },
    limits: { category: 16, status: 16, source: 16, keyword: 128 },
  },
  'hotboard.keywordSave': {
    fields: { op: 'string', keywordId: 'string', keyword: 'string', category: 'string', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { op: 16, keywordId: 64, keyword: 128, category: 16, idempotencyKey: 128 },
  },
  'hotboard.runStart': {
    fields: { runType: 'string', includeComments: 'boolean', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { runType: 16, idempotencyKey: 128 },
  },
  'hotboard.runGet': { fields: { runId: 'string' }, limits: { runId: 64 } },
  'hotboard.candidates': {
    fields: { status: 'string', category: 'string', keyword: 'string', dateFrom: 'string', dateTo: 'string', page: 'number', pageSize: 'number' },
    limits: { status: 16, category: 16, keyword: 128, dateFrom: 10, dateTo: 10 },
  },
  'hotboard.candidateReview': {
    fields: { op: 'string', candidateIds: 'stringArray', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { op: 16, idempotencyKey: 128 },
    arrays: { candidateIds: { maxItems: 50, itemMax: 64 } },
  },
  'hotboard.labels': {
    fields: { tagType: 'string', status: 'string', source: 'string', proposalStatus: 'string', keyword: 'string', page: 'number', pageSize: 'number' },
    limits: { tagType: 16, status: 16, source: 16, proposalStatus: 24, keyword: 128 },
  },
  'hotboard.labelReview': {
    fields: { op: 'string', proposalId: 'string', labelId: 'string', targetLabelId: 'string', confirm: 'boolean', idempotencyKey: 'string' },
    limits: { op: 16, proposalId: 64, labelId: 64, targetLabelId: 64, idempotencyKey: 128 },
  },
  'hotboard.labelSave': {
    fields: {
      labelId: 'string', tagType: 'string', code: 'string', name: 'string', aliases: 'stringArray',
      definition: 'string', confirm: 'boolean', idempotencyKey: 'string',
    },
    limits: { labelId: 64, tagType: 16, code: 64, name: 128, definition: 2000, idempotencyKey: 128 },
    arrays: { aliases: { maxItems: 20, itemMax: 128 } },
  },
  'hotboard.settings': { fields: {} },
  'hotboard.settingsUpdate': { fields: { settings: 'object', confirm: 'boolean', idempotencyKey: 'string' }, limits: { idempotencyKey: 128 } },
  'publish.start': {
    fields: { accountId: 'string', target: 'string', idempotencyKey: 'string' },
    limits: { accountId: 128, target: 16, idempotencyKey: 128 },
  },
  'publish.status': { fields: { publishId: 'string' }, limits: { publishId: 128 } },
})

/** stringArray 字段约束缺省：最多 9 项（旧 UI 上限，D-4）、单项 ≤2048；档位覆盖见 schema.arrays。 */
const STRING_ARRAY_MAX_ITEMS = 9
const STRING_ARRAY_ITEM_MAX = 2048

/** Whitelisted stable reason codes a handler may return (route-level superset). */
export function isStableCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value)
}

/** One handled action's arguments after validation. */
export type ActionArgs = Record<string, string | boolean | number | string[] | Record<string, unknown> | undefined>

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
    if (kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" must be a finite number`)
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
    if (kind === 'stringArray') {
      const bounds = schema.arrays?.[key] ?? { maxItems: STRING_ARRAY_MAX_ITEMS, itemMax: STRING_ARRAY_ITEM_MAX }
      if (!Array.isArray(value)) throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" must be a string array`)
      if (value.length > bounds.maxItems) throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" exceeds ${bounds.maxItems} items`)
      const items: string[] = []
      for (const item of value) {
        if (typeof item !== 'string') throw new XhsError('XHS_ROUTE_INVALID_REQUEST', `field "${key}" items must be strings`)
        const text = item.trim().slice(0, bounds.itemMax)
        if (text !== '') items.push(text)
      }
      args[key] = items
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

/**
 * Handler 响应的判别联合：error 分支的 reason 必须是稳定码白名单成员——
 * 未收录 reason 码编译期报错（新增 reason 码必须先进 STABLE_ERROR_CODES）。
 */
export type HandlerPayload =
  | ({ status: 'ready' | 'started' | 'created' } & Record<string, unknown>)
  | ({ status: 'error'; reason: StableErrorCode } & Record<string, unknown>)

/** One action's business handler: receives validated args, returns the JSON payload. */
export type ActionHandler = (args: ActionArgs) => Promise<HandlerPayload>

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
