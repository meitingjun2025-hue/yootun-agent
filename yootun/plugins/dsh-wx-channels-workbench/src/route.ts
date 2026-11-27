/**
 * Host 路由层：`/api/desktop/yootun/wx-workbench` 单端点 POST 分发。安全口径
 * （分册 08 §10.3）：只接受 POST、loopback 远端 + 浏览器来源标记信任判定
 * （显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest` 转发剥离
 * 两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式 action
 * allowlist、每 action 输入 schema 并拒绝未知字段、稳定错误码（不透传内部
 * 异常）。handler 经 deps 注入，本模块不持有业务状态。信任判定、体读取与分发
 * 由 [kit](../../../packages/dsh-workbench-host-kit/src/route.ts) 承担，本模块
 * 只保留视频号的 action 契约、校验器与稳定码实例化。
 * @module
 */
import { createActionRoute, type ActionHandler as KitActionHandler, type HandlerPayload as KitHandlerPayload, type RouteRequest, type RouteResponse } from '@yootun/dsh-workbench-host-kit'
import { WxError, safeCode, STABLE_ERROR_CODES, type StableErrorCode } from './errors.ts'

/** 路由固定路径。 */
export const ROUTE_PATH = '/api/desktop/yootun/wx-workbench'

/** JSON 元数据体上限（bytes；迁移旧 64KB 口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

export { permitted, sendJson, readJsonBody, ROUTE_REFUSAL_REASONS, type RouteRequest, type RouteResponse } from '@yootun/dsh-workbench-host-kit'

/** One whitelisted action's input contract. */
export interface ActionSchema {
  /** Allowed fields; anything else is rejected. */
  fields: Readonly<Record<string, 'string' | 'boolean' | 'integer' | 'date'>>
  /** Required fields（缺失/null 拒绝；string 类型 trim 后空串同样按缺失拒绝）. */
  required?: readonly string[]
  /** Max length for each string field. */
  limits?: Readonly<Record<string, number>>
  /** integer 字段的闭区间范围（min / max 含端点）；越界拒绝。 */
  ranges?: Readonly<Record<string, { min?: number; max?: number }>>
  /** string 字段的封闭取值集合；截断后不在集合内的值拒绝。 */
  enums?: Readonly<Record<string, readonly string[]>>
  /** 幂等键模板（字段 → 段前缀；绑定字段时键内段必须与请求归一值一致）。 */
  idempotency?: Readonly<Record<string, { segment: string; boundField?: string }>>
}

/** Per-action input contracts (explicit allowlist; unknown fields rejected). */
export const ACTION_SCHEMAS: Readonly<Record<string, ActionSchema>> = Object.freeze({
  'browser.status': { fields: {} },
  'accounts.list': { fields: {} },
  'account.beginLogin': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.loginStatus': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.probe': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.promote': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.removeLocal': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'account.removeRemote': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collect.start': { fields: { accountId: 'string', newAttempt: 'boolean' }, limits: { accountId: 128 } },
  'collect.status': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collect.running': { fields: {} },
  'collect.cancel': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'collectAll.start': { fields: {} },
  'collectAll.cancel': { fields: {} },
  'collectAll.status': { fields: {} },
  'run.get': { fields: { runId: 'string' }, limits: { runId: 128 } },
  'works.list': {
    fields: { accountId: 'string', sort: 'string', order: 'string', publishedFrom: 'string', publishedTo: 'string', limit: 'integer', offset: 'integer' },
    limits: { accountId: 128, sort: 32, order: 8, publishedFrom: 10, publishedTo: 10 },
    ranges: { limit: { min: 1, max: 100 }, offset: { min: 0, max: 1000000 } },
    enums: {
      sort: ['publish_time', 'completion_rate_pct', 'avg_play_duration_s', 'play_count', 'like_count', 'favorite_count', 'comment_count', 'share_count', 'forward_count', 'follow_count'],
      order: ['asc', 'desc'],
    },
  },
  'work.get': { fields: { accountId: 'string', workId: 'string' }, limits: { accountId: 128, workId: 128 } },
  'work.trend': { fields: { accountId: 'string', workId: 'string' }, limits: { accountId: 128, workId: 128 } },
  'account.overview': { fields: { accountId: 'string', window: 'string' }, limits: { accountId: 128, window: 16 } },
  'fans.profile.get': { fields: { accountId: 'string' }, limits: { accountId: 128 } },
  'overview.accounts': { fields: { accountId: 'string', window: 'string', fromDay: 'string', toDay: 'string', sort: 'string', sessionStatus: 'string' }, limits: { accountId: 128, window: 16, fromDay: 10, toDay: 10, sort: 16, sessionStatus: 16 } },
  // AI 报表（wx-report-client 第 3 步；入参约束与抖音同名 action 逐字段一致，
  // 字符串超限仍是截断而非拒绝——与既有 action 的差异保留）。
  'report.list': {
    fields: { reportType: 'string', periodStart: 'date', status: 'string', limit: 'integer', cursor: 'string', allVersions: 'boolean' },
    limits: { status: 16, cursor: 512 },
    ranges: { limit: { min: 1, max: 100 } },
    enums: { reportType: ['daily', 'weekly'], status: ['pending', 'running', 'succeeded', 'failed', 'insufficient'] },
  },
  'report.get': { required: ['reportId'], fields: { reportId: 'string' } },
  'report.regenerate': { required: ['reportId', 'idempotencyKey'], idempotency: { idempotencyKey: { segment: 'wx:report_regenerate', boundField: 'reportId' } }, fields: { reportId: 'string', idempotencyKey: 'string' } },
})

/** Whitelisted stable reason codes a handler may return (route-level superset). */
export function isStableCode(value: string): value is StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(value)
}

/** One handled action's arguments after validation. */
export type ActionArgs = Record<string, string | boolean | number | undefined>

/**
 * Validate one request body against the action's schema: unknown fields,
 * missing required fields, wrong types and non-calendar `date` values are
 * rejected (`WX_ROUTE_INVALID_REQUEST`); strings are trimmed and
 * length-capped, integer fields must be whole numbers inside their `ranges`
 * entry, string fields with an `enums` entry only accept listed values, and
 * idempotency-key fields must match their `idempotency` template
 * (`INVALID_IDEMPOTENCY_KEY`).
 * @param action - the whitelisted action name.
 * @param body - the parsed request body.
 * @returns the validated arguments.
 * @throws {WxError} `WX_ROUTE_INVALID_REQUEST` / `INVALID_IDEMPOTENCY_KEY`.
 */
export function validateActionArgs(action: string, body: Record<string, unknown>): ActionArgs {
  const schema = ACTION_SCHEMAS[action]
  if (schema === undefined) throw new WxError('WX_ROUTE_UNKNOWN_ACTION', `unknown action ${action}`)
  for (const key of Object.keys(body)) {
    // `action` 是分发键本身，不属于各 action 的参数 schema。
    if (key === 'action') continue
    if (!(key in schema.fields)) throw new WxError('WX_ROUTE_INVALID_REQUEST', `unknown field "${key}" for ${action}`)
  }
  for (const key of schema.required ?? []) {
    // 必填字段缺失/null 拒绝；string 类型 trim 后空串同样按缺失拒绝。
    const value = body[key]
    const isStringField = schema.fields[key] === 'string' || schema.fields[key] === 'date'
    if (value === undefined || value === null
      || (isStringField && (typeof value !== 'string' || value.trim() === ''))) {
      throw new WxError('WX_ROUTE_INVALID_REQUEST', `missing required field "${key}" for ${action}`)
    }
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
    if (kind === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" must be an integer`)
      const range = schema.ranges?.[key]
      if (range !== undefined && ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max))) {
        throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" out of range`)
      }
      args[key] = value
      continue
    }
    if (typeof value !== 'string') throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" must be a string`)
    const text = value.trim()
    if (text === '') continue
    if (kind === 'date') {
      if (!isCalendarDate(text)) throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" must be a real calendar date (YYYY-MM-DD)`)
      args[key] = text
      continue
    }
    const limit = schema.limits?.[key] ?? 128
    const capped = text.slice(0, limit)
    if (capped === '') continue
    const allowed = schema.enums?.[key]
    if (allowed !== undefined && !allowed.includes(capped)) throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${key}" has an invalid value`)
    args[key] = capped
  }
  // 幂等键模板：段前缀 + （绑定字段归一值 +）UUID（32 位小写 hex 或
  // 8-4-4-4-12 小写 UUID）；键内绑定段与请求字段不一致 = 跨记录重放，一律
  // 拒绝。绑定值做结构性前缀精确比较（startsWith），不拼动态 RegExp。
  for (const [field, contract] of Object.entries(schema.idempotency ?? {})) {
    const keyText = args[field]
    if (typeof keyText !== 'string' || keyText === '') continue
    const bound = contract.boundField === undefined ? undefined : args[contract.boundField]
    if (contract.boundField !== undefined && (bound === undefined || bound === null)) {
      throw new WxError('WX_ROUTE_INVALID_REQUEST', `field "${contract.boundField}" is required for the idempotency key`)
    }
    const expectedPrefix = contract.boundField === undefined
      ? `${contract.segment}:`
      : `${contract.segment}:${String(bound)}:`
    if (!keyText.startsWith(expectedPrefix)) {
      throw new WxError('INVALID_IDEMPOTENCY_KEY', `field "${field}" does not match the required idempotency key template`)
    }
    const suffix = keyText.slice(expectedPrefix.length)
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(suffix)) {
      throw new WxError('INVALID_IDEMPOTENCY_KEY', `field "${field}" does not match the required idempotency key template`)
    }
  }
  return args
}

/** 按月天数（含闰年）校验 YYYY-MM-DD 真实日历日期。 */
function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Handler 响应的判别联合：error 分支的 reason 必须是稳定码白名单成员——未收录
 * reason 码编译期报错（新增 reason 码必须先进 STABLE_ERROR_CODES）。视频号由此
 * 获得与抖音、小红书相同的编译期稳定码约束（此前 handler 返回 `object` 无约束）。
 */
export type HandlerPayload = KitHandlerPayload<'ok', StableErrorCode>

/** One action's business handler: receives validated args, returns the JSON payload. */
export type ActionHandler = KitActionHandler<'ok', StableErrorCode, ActionArgs>

/**
 * Build the POST handler for the route（分发矩阵由 kit {@linkcode createActionRoute}
 * 承担：405 `method_not_allowed`、403 `forbidden`、400 `unknown_action`、413
 * 体超限、稳定码白名单收敛）。本函数只绑定视频号的 schema、校验器与稳定码前缀。
 * @param expectedOrigin - origin provider (the local webServer binds during init).
 * @param handlers - per-action business handlers (must cover the allowlist).
 * @returns the webServer route handler.
 */
export function createRouteHandler(
  expectedOrigin: () => string,
  handlers: Readonly<Record<string, ActionHandler>>,
): (req: RouteRequest, res: RouteResponse) => Promise<void> {
  return createActionRoute<'ok', StableErrorCode, ActionArgs>({
    expectedOrigin,
    actionSchemas: ACTION_SCHEMAS,
    validate: validateActionArgs,
    handlers,
    codes: {
      invalidRequest: 'WX_ROUTE_INVALID_REQUEST',
      payloadTooLarge: 'WX_ROUTE_PAYLOAD_TOO_LARGE',
      routeCodePrefix: 'WX_ROUTE',
    },
    safeCode,
    isStableCode,
    maxBodyBytes: MAX_BODY_BYTES,
  })
}
