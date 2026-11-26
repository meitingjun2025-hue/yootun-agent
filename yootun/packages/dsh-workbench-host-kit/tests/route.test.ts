/**
 * 路由共享层测试（node --test，结构化假 req/res；实施单 workbench-host-kit
 * 附录 B.1 H1–H3）：信任判定、createActionRoute 响应矩阵（2.2 表六行）、体
 * 上限声明与实际生效、白名单外错误收敛。类型层检查（H4）在 tests/types/，
 * 随 build 执行。运行：`node --test tests/route.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActionRoute, permitted, readJsonBody, sendJson, type ActionHandler, type HandlerPayload, type RouteRequest, type RouteResponse } from '../src/route.ts'

interface RecordedResponse {
  status: number
  payload: Record<string, unknown>
  headers: Record<string, string>
}

function fakeRes(responded: RecordedResponse[]): RouteResponse {
  const headers: Record<string, string> = {}
  return {
    statusCode: 0,
    setHeader(name: string, value: string) { headers[name] = value },
    end(payload: string) {
      responded.push({ status: this.statusCode, payload: JSON.parse(payload) as Record<string, unknown>, headers })
    },
  }
}

function fakeReq(body: unknown, headers: Record<string, unknown> = {}, remote = '127.0.0.1'): RouteRequest {
  return {
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  }
}

type TestCode = 'T_ROUTE_INVALID_REQUEST' | 'T_ROUTE_PAYLOAD_TOO_LARGE' | 'T_ROUTE_REFUSED' | 'CONFIRMATION_REQUIRED'
type TestPayload = HandlerPayload<'ready', TestCode>
const handler: ActionHandler<'ready', TestCode> = async () => ({ status: 'ready' })

const codes = {
  invalidRequest: 'T_ROUTE_INVALID_REQUEST' as TestCode,
  payloadTooLarge: 'T_ROUTE_PAYLOAD_TOO_LARGE' as TestCode,
  routeCodePrefix: 'T_ROUTE',
}
const isStableCode = (code: string): boolean => ['T_ROUTE_INVALID_REQUEST', 'T_ROUTE_PAYLOAD_TOO_LARGE', 'T_ROUTE_REFUSED', 'CONFIRMATION_REQUIRED'].includes(code)
/** 插件 safeCode 口径：稳定码错误按码投影，其余收敛为白名单 fallback。 */
const safeCode = (error: unknown): string => {
  const direct = error instanceof Error ? (error as { code?: unknown }).code : undefined
  return typeof direct === 'string' && isStableCode(direct) ? direct : 'T_ROUTE_REFUSED_FALLBACK'
}

function buildRoute(overrides: Partial<Parameters<typeof createActionRoute<'ready', TestCode>>[0]> = {}): (req: RouteRequest, res: RouteResponse) => Promise<void> {
  return createActionRoute({
    expectedOrigin: () => 'http://127.0.0.1:41111',
    actionSchemas: { 'probe.get': { fields: {} } },
    validate: action => {
      if (action !== 'probe.get') throw new Error(`unexpected action ${action}`)
      return {}
    },
    handlers: { 'probe.get': handler },
    codes,
    safeCode,
    isStableCode,
    maxBodyBytes: 64 * 1024,
    ...overrides,
  })
}

const origin = 'http://127.0.0.1:41111'

test('H1 permitted：loopback 放行；非 loopback 拒绝；cross-site 拒绝；Origin 等于期望值或缺失放行；null 与异源拒绝', () => {
  assert.equal(permitted(fakeReq({}, {}, '127.0.0.1'), origin), true)
  assert.equal(permitted(fakeReq({}, {}, '::1'), origin), true)
  assert.equal(permitted(fakeReq({}, {}, '::ffff:127.0.0.1'), origin), true)
  assert.equal(permitted(fakeReq({ action: 'x' }, { origin }), origin), true)
  assert.equal(permitted(fakeReq({ action: 'x' }, {}, '10.0.0.8'), origin), false)
  assert.equal(permitted(fakeReq({ action: 'x' }, { 'sec-fetch-site': 'cross-site', origin }), origin), false)
  assert.equal(permitted(fakeReq({ action: 'x' }, { origin: 'null' }), origin), false)
  assert.equal(permitted(fakeReq({ action: 'x' }, { origin: 'http://evil.example' }), origin), false)
})

test('H2 非 POST → 405 method_not_allowed', async () => {
  const responded: RecordedResponse[] = []
  const route = buildRoute()
  await route({ ...fakeReq({}), method: 'GET' }, fakeRes(responded))
  assert.equal(responded[0]?.status, 405)
  assert.equal(responded[0]?.payload.reason, 'method_not_allowed')
  assert.equal(responded[0]?.payload.status, 'error')
  assert.equal(responded[0]?.headers['cache-control'], 'no-store')
})

test('H2 信任判定不通过 → 403 forbidden（非 loopback 与显式异源）', async () => {
  const responded: RecordedResponse[] = []
  const route = buildRoute()
  await route(fakeReq({ action: 'probe.get' }, {}, '10.0.0.8'), fakeRes(responded))
  assert.equal(responded[0]?.status, 403)
  assert.equal(responded[0]?.payload.reason, 'forbidden')
  await route(fakeReq({ action: 'probe.get' }, { origin: 'http://evil.example' }), fakeRes(responded))
  assert.equal(responded[1]?.status, 403)
  assert.equal(responded[1]?.payload.reason, 'forbidden')
})

test('H2 action 不在 allowlist 与 allowlist 内无 handler → 400 unknown_action', async () => {
  const responded: RecordedResponse[] = []
  const route = buildRoute()
  await route(fakeReq({ action: 'nope.get' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'unknown_action')
  await route(fakeReq({ action: 'probe.get' }), fakeRes(responded))
  assert.equal(responded[1]?.status, 200)
  assert.equal(responded[1]?.payload.status, 'ready')
})

test('H2 体超限 → 413 payloadTooLarge，且不进入 handler', async () => {
  const responded: RecordedResponse[] = []
  let handlerCalled = false
  const route = buildRoute({
    handlers: { 'probe.get': async () => { handlerCalled = true; return { status: 'ready' } } },
    maxBodyBytes: 16,
  })
  await route(fakeReq({ action: 'probe.get', pad: 'x'.repeat(64) }), fakeRes(responded))
  assert.equal(responded[0]?.status, 413)
  assert.equal(responded[0]?.payload.reason, 'T_ROUTE_PAYLOAD_TOO_LARGE')
  assert.equal(handlerCalled, false)
})

test('H2 抛出码命中 routeCodePrefix → 400；白名单外前缀外稳定码 → 200；handler 返回 error → 200', async () => {
  const responded: RecordedResponse[] = []
  const throwingRoute: ActionHandler<'ready', TestCode> = async () => {
    const error = new Error('refused') as Error & { code?: string }
    error.code = 'T_ROUTE_REFUSED'
    throw error
  }
  const throwingFallback: ActionHandler<'ready', TestCode> = async () => {
    throw Object.assign(new Error('confirm required'), { code: 'CONFIRMATION_REQUIRED' })
  }
  const route = buildRoute({ handlers: { 'probe.get': throwingRoute } })
  await route(fakeReq({ action: 'probe.get' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'T_ROUTE_REFUSED')
  const route2 = buildRoute({ handlers: { 'probe.get': throwingFallback } })
  await route2(fakeReq({ action: 'probe.get' }), fakeRes(responded))
  assert.equal(responded[1]?.status, 200)
  assert.equal(responded[1]?.payload.reason, 'CONFIRMATION_REQUIRED')
  const returning: ActionHandler<'ready', TestCode> = async () => ({ status: 'error', reason: 'T_ROUTE_REFUSED' })
  const route3 = buildRoute({ handlers: { 'probe.get': returning } })
  await route3(fakeReq({ action: 'probe.get' }), fakeRes(responded))
  assert.equal(responded[2]?.status, 200, 'handler 返回的 error 载荷按 200 输出')
  assert.equal(responded[2]?.payload.reason, 'T_ROUTE_REFUSED')
})

test('H2 白名单外原始错误收敛为 invalidRequest（随前缀 400），不透传原文；malformed 体按空体走 schema 拒绝', async () => {
  const responded: RecordedResponse[] = []
  const throwing: ActionHandler<'ready', TestCode> = async () => { throw new Error('secret internal detail') }
  const route = buildRoute({ handlers: { 'probe.get': throwing } })
  await route(fakeReq({ action: 'probe.get' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'T_ROUTE_INVALID_REQUEST')
  assert.equal(JSON.stringify(responded[0]?.payload).includes('secret'), false)

  const route2 = buildRoute({ validate: () => { throw new Error('unexpected') } })
  await route2(fakeReq('{not json'), fakeRes(responded))
  // malformed 体按空体处理：action 缺失 → unknown_action 确定拒绝（同现状）。
  assert.equal(responded[1]?.status, 400)
  assert.equal(responded[1]?.payload.reason, 'unknown_action')
})

test('H3 体上限声明与实际都生效：多 chunk 累计超限同样 413；readJsonBody 单独可用', async () => {
  const responded: RecordedResponse[] = []
  const route = buildRoute({ maxBodyBytes: 10 })
  const multiChunkReq: RouteRequest = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('12345')
      yield Buffer.from('67890')
      yield Buffer.from('1')
    },
  }
  await route(multiChunkReq, fakeRes(responded))
  assert.equal(responded[0]?.status, 413)

  const collected: Record<string, unknown> = await readJsonBody(fakeReq({ a: 1 }), { maxBytes: 1024 })
  assert.deepEqual(collected, { a: 1 })
  const empty = await readJsonBody(fakeReq('not-json'), { maxBytes: 1024 })
  assert.deepEqual(empty, {})
  const nonObject = await readJsonBody(fakeReq([1, 2]), { maxBytes: 1024 })
  assert.deepEqual(nonObject, {})
  await assert.rejects(readJsonBody(fakeReq('pad'.repeat(100)), { maxBytes: 10 }), (error: unknown) =>
    error instanceof Error && error.name === 'RouteBodyTooLargeError')
})

test('sendJson 写稳定安全头', async () => {
  const responded: RecordedResponse[] = []
  sendJson(fakeRes(responded), 200, { status: 'ready' })
  assert.equal(responded[0]?.status, 200)
  assert.equal(responded[0]?.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(responded[0]?.headers['x-content-type-options'], 'nosniff')
  assert.equal(responded[0]?.headers['cache-control'], 'no-store')
})
