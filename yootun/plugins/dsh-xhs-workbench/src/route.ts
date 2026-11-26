/**
 * Host 路由层：`/api/desktop/yootun/xhs-workbench` 单端点 POST 分发。安全口径
 * （分册 08 §10.3）：只接受 POST、loopback 远端 + 浏览器来源标记信任判定
 * （显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest` 转发剥离
 * 两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式 action
 * allowlist、每 action 输入 schema 并拒绝未知字段、稳定错误码（不透传内部
 * 异常）。handler 经 deps 注入，本模块不持有业务状态。信任判定、体读取与分发
 * 由 [kit](../../../packages/dsh-workbench-host-kit/src/route.ts) 承担，本模块
 * 只保留小红书的 action 契约、校验器与稳定码实例化。
 *
 * action 集合按批次扩充：已实现 30 项（X1+X2 骨架 8 + 采集 1 + X4 任务 4 + X5 看板 15 + X6 发布
 * 2）；hotboard 其余、upload 各 action 随对应批次加入（assistant 已定案不做，D-6），未实现项按
 * unknown_action 拒绝（fail loud，不做静默半实现）。
 * @module
 */
import { createActionRoute, type ActionHandler as KitActionHandler, type HandlerPayload as KitHandlerPayload, type RouteRequest, type RouteResponse } from '@yootun/dsh-workbench-host-kit'
import { safeCode, STABLE_ERROR_CODES, XhsError, type StableErrorCode } from './errors.ts'

/** 路由固定路径。 */
export const ROUTE_PATH = '/api/desktop/yootun/xhs-workbench'

/** JSON 元数据体上限（bytes；迁移旧 32KB→wx 64KB 统一口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

export { permitted, sendJson, readJsonBody, ROUTE_REFUSAL_REASONS, type RouteRequest, type RouteResponse } from '@yootun/dsh-workbench-host-kit'

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
  'collect.cancel': { fields: { collectId: 'string' }, limits: { collectId: 128 } },
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

/**
 * Handler 响应的判别联合：error 分支的 reason 必须是稳定码白名单成员——
 * 未收录 reason 码编译期报错（新增 reason 码必须先进 STABLE_ERROR_CODES）。
 */
export type HandlerPayload = KitHandlerPayload<'ready' | 'started' | 'created', StableErrorCode>

/** One action's business handler: receives validated args, returns the JSON payload. */
export type ActionHandler = KitActionHandler<'ready' | 'started' | 'created', StableErrorCode, ActionArgs>

/**
 * Build the POST handler for the route（分发矩阵由 kit {@linkcode createActionRoute}
 * 承担：405 `method_not_allowed`、403 `forbidden`、400 `unknown_action`、413
 * 体超限、稳定码白名单收敛）。本函数只绑定小红书的 schema、校验器与稳定码前缀。
 * @param expectedOrigin - origin provider (the local webServer binds during init).
 * @param handlers - per-action business handlers (must cover the allowlist).
 * @returns the webServer route handler.
 */
export function createRouteHandler(
  expectedOrigin: () => string,
  handlers: Readonly<Record<string, ActionHandler>>,
): (req: RouteRequest, res: RouteResponse) => Promise<void> {
  return createActionRoute<'ready' | 'started' | 'created', StableErrorCode, ActionArgs>({
    expectedOrigin,
    actionSchemas: ACTION_SCHEMAS,
    validate: validateActionArgs,
    handlers,
    codes: {
      invalidRequest: 'XHS_ROUTE_INVALID_REQUEST',
      payloadTooLarge: 'XHS_ROUTE_PAYLOAD_TOO_LARGE',
      routeCodePrefix: 'XHS_ROUTE',
    },
    safeCode,
    isStableCode,
    maxBodyBytes: MAX_BODY_BYTES,
  })
}
