/**
 * 同源路由共享层：`/api/desktop/yootun/*` 单端点 POST 分发的唯一实现。安全口径
 * （分册 08 §10.3 / 分册 15 §3）：只接受 POST、loopback 远端 + 浏览器来源标记
 * 信任判定（显式 Origin 精确匹配、显式跨站拒绝；Desktop `forwardWebRequest`
 * 转发剥离两枚标记时放行，语义对齐官方 connection fence）、请求体上限、显式
 * action allowlist、每 action 输入 schema（由调用方经 `validate` 注入）、稳定
 * 错误码（不透传内部异常）。本模块不持有业务状态，schema 校验器留在各插件。
 * @module
 */

/** Structured request surface the route needs（IncomingMessage 结构兼容）. */
export interface RouteRequest {
  /** HTTP method; non-POST is rejected before parsing. */
  method?: string | undefined
  /** Loopback 远端基础防线所需的远端地址。 */
  socket: { remoteAddress?: string | undefined }
  /** Lowercased header record（IncomingHttpHeaders 结构兼容）. */
  headers: Record<string, unknown>
  /** Body byte stream（Readable 的异步迭代面）. */
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>
}

/** Structured response surface the route writes（ServerResponse 结构兼容）. */
export interface RouteResponse {
  /** HTTP status code. */
  statusCode: number
  /** Set one response header. */
  setHeader(name: string, value: string): void
  /** Write the JSON payload body. */
  end(payload: string): void
}

/**
 * 路由信任判定（对齐官方浏览器信任边界 api-request-trust，四个 yootun Host
 * 路由共用）：loopback 远端是基础防线，负责把请求绑定到本机；显式
 * `sec-fetch-site: cross-site` 一律拒绝；显式 Origin 必须精确等于
 * expectedOrigin（字面 `null`、异源都拒绝），Origin 缺失不单独视为攻击——
 * Windows Desktop 的 Electron main 进程 `forwardWebRequest` 转发请求时会剥掉
 * Origin 与 Sec-Fetch-Site 两枚头，双头缺失是 Desktop 转发的合法形态，来源
 * 边界由 loopback 承担。media-upload 的 media 预览路由有自己的 no-cors 规则，
 * 不在本判定内。
 * @param req - Node HTTP 请求。
 * @param expectedOrigin - 本 webServer 绑定的精确 origin。
 * @returns 是否放行。
 */
export function permitted(req: RouteRequest, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  if (!loopback) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  return origin === undefined || origin === expectedOrigin
}

/** 请求体超过上限（`createActionRoute` 翻译为 `codes.payloadTooLarge` 413）。 */
export class RouteBodyTooLargeError extends Error {
  constructor() {
    super('route body too large')
    this.name = 'RouteBodyTooLargeError'
  }
}

/**
 * Read and parse the JSON body under the size cap; malformed bodies and
 * non-object payloads become `{}` so the caller's schema layer gives the
 * deterministic rejection.
 * @param req - the request whose body is consumed.
 * @param limits.maxBytes - byte cap; exceeding it throws before buffering more.
 * @returns the parsed object（解析失败或非对象体返回 `{}`）。
 * @throws {RouteBodyTooLargeError} the body exceeded `maxBytes`.
 */
export async function readJsonBody(req: RouteRequest, limits: { maxBytes: number }): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > limits.maxBytes) throw new RouteBodyTooLargeError()
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch (error: unknown) {
    // JSON 解析失败按空体处理，schema 层给出确定性拒绝。
    void error
    return {}
  }
}

/**
 * Write one JSON response with the fixed security headers（no-store、json
 * charset、nosniff）。
 * @param res - the response to write.
 * @param code - HTTP status code.
 * @param payload - the JSON payload.
 */
export function sendJson(res: RouteResponse, code: number, payload: object): void {
  res.statusCode = code
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/** 路由层拒绝 reason 字面量（进 2.2 表的固定响应体；各插件词典按此三码配文案）。 */
export const ROUTE_REFUSAL_REASONS = ['method_not_allowed', 'forbidden', 'unknown_action'] as const

/** One route-level refusal reason（词典键与稳定码白名单之外的路由层字面量）。 */
export type RouteRefusalReason = (typeof ROUTE_REFUSAL_REASONS)[number]

/** One handled action's validated arguments（插件经 `validate` 收窄为自己的形状）. */
export type ActionArgs = Record<string, unknown>

/**
 * Handler 响应的判别联合：`status` 取调用方登记的成功词汇，error 分支的 reason
 * 必须是调用方稳定码白名单的类型成员——未收录 reason 码编译期报错（新增 reason
 * 码必须先进调用方 STABLE_ERROR_CODES）。
 */
export type HandlerPayload<S extends string, C extends string> =
  | ({ status: S } & Record<string, unknown>)
  | ({ status: 'error'; reason: C } & Record<string, unknown>)

/** One action's business handler: receives validated args and the request-level
 * abort signal（当前分发不传 signal，预留形参保持各插件既有签名）, returns the JSON payload. */
export type ActionHandler<S extends string, C extends string, A extends ActionArgs = ActionArgs> = (args: A, signal?: AbortSignal) => Promise<HandlerPayload<S, C>>

/** 路由响应码组：收敛码与稳定码前缀由各插件实例化。 */
export interface ActionRouteCodes<C extends string> {
  /** 白名单外原始错误的收敛 reason（各插件 `<NS>_ROUTE_INVALID_REQUEST`）。 */
  invalidRequest: C
  /** 请求体超限的 reason（各插件 `<NS>_ROUTE_PAYLOAD_TOO_LARGE`；HTTP 413）。 */
  payloadTooLarge: C
  /** 稳定码前缀：命中前缀的抛出码按 400 响应（其余稳定码 200，同现状）。 */
  routeCodePrefix: string
}

/** `createActionRoute` 的注入面：schema 校验器与稳定码判定留在调用方。 */
export interface ActionRouteOptions<S extends string, C extends string, A extends ActionArgs = ActionArgs> {
  /** Origin provider (the local webServer binds during init). */
  expectedOrigin: () => string
  /** 显式 action allowlist（分发键；未知 action 拒绝）。 */
  actionSchemas: Readonly<Record<string, unknown>>
  /** Per-action input validation, owned by the caller plugin. */
  validate: (action: string, body: Record<string, unknown>) => A
  /** Per-action business handlers（allowlist 内未实现项缺席即 unknown_action）. */
  handlers: Readonly<Record<string, ActionHandler<S, C, A>>>
  /** 响应码组。 */
  codes: ActionRouteCodes<C>
  /** 调用方稳定码投影（错误 → 本插件稳定码；白名单外由插件 fallback 收敛）。 */
  safeCode: (error: unknown) => string
  /** 调用方稳定码白名单判定（投影不在白名单时收敛为 `codes.invalidRequest`）。 */
  isStableCode: (code: string) => boolean
  /** 请求体字节上限。 */
  maxBodyBytes: number
}

/**
 * Build the POST handler for one same-origin workbench route。响应矩阵：非 POST
 * 405 `method_not_allowed`；信任判定不通过 403 `forbidden`；action 不在
 * allowlist 或无 handler 400 `unknown_action`；体超限 413 `payloadTooLarge`；
 * 抛出码命中 `routeCodePrefix` 400，其余稳定码 200，白名单外收敛为
 * `invalidRequest`（HTTP 状态随现状口径）；handler 正常返回 200。
 * @param options - 注入面（见 {@linkcode ActionRouteOptions}）。
 * @returns the webServer route handler.
 */
export function createActionRoute<S extends string, C extends string, A extends ActionArgs = ActionArgs>(options: ActionRouteOptions<S, C, A>): (req: RouteRequest, res: RouteResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { status: 'error', reason: 'method_not_allowed' satisfies RouteRefusalReason })
      return
    }
    if (!permitted(req, options.expectedOrigin())) {
      sendJson(res, 403, { status: 'error', reason: 'forbidden' satisfies RouteRefusalReason })
      return
    }
    try {
      const body = await readJsonBody(req, { maxBytes: options.maxBodyBytes })
      const action = typeof body.action === 'string' ? body.action.trim().slice(0, 64) : ''
      // Object.hasOwn 而非 `in`：原型链上的键名（toString / constructor /
      // __proto__）不得命中 allowlist，一律 unknown_action。
      if (!Object.hasOwn(options.actionSchemas, action) || options.handlers[action] === undefined) {
        sendJson(res, 400, { status: 'error', reason: 'unknown_action' satisfies RouteRefusalReason })
        return
      }
      const args = options.validate(action, body)
      const payload = await options.handlers[action](args)
      sendJson(res, 200, payload)
    } catch (error) {
      if (error instanceof RouteBodyTooLargeError) {
        sendJson(res, 413, { status: 'error', reason: options.codes.payloadTooLarge })
        return
      }
      // 统一收敛：稳定码白名单外的原始错误不透传（分册 15 §6）。投影由调用方
      // safeCode 决定（各插件 fallback 收敛口径同现状），白名单外兜底为
      // codes.invalidRequest。
      const projected = options.safeCode(error)
      const reason = options.isStableCode(projected) ? projected : options.codes.invalidRequest
      const status = projected === options.codes.payloadTooLarge ? 413 : reason.startsWith(options.codes.routeCodePrefix) ? 400 : 200
      sendJson(res, status, { status: 'error', reason })
    }
  }
}
