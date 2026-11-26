/**
 * 路由安全层测试（node --test，结构化假 req/res）：57 项契约与 required 模型、
 * 未知 action/字段拒绝、类型/长度/数值/数组边界、trim 不截断（超长拒绝）、
 * objectArray 逐项契约、十进制整数、来源信任判定、体上限、malformed JSON、
 * 稳定响应头。运行：`node --test tests/route.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTION_SCHEMAS, ACTION_TOOL_MAP, MAX_BODY_BYTES, createRouteHandler, permitted, validateActionArgs } from '../src/route.ts'
import type { RouteRequest, RouteResponse } from '../src/route.ts'
import { DouyinError } from '../src/errors.ts'

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

const handlers = { 'browser.status': async () => ({ status: 'ready' as const }) }
const origin = 'http://127.0.0.1:41111'
/** schedule.rowUpdate 的必填字段基础（只缺被测字段时补齐其余）。 */
function rowUpdateBase(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { accountId: 'a', rowId: 1, expectedVersion: 1, confirm: true, idempotencyKey: 'douyin:publish_schedule_update:1:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f', shootingStatus: false, published: false, publishPlatforms: ['xhs'], ...extra }
}

test('契约规模：ACTION_SCHEMAS 与 ACTION_TOOL_MAP 各精确 57 项且键一致', () => {
  assert.equal(Object.keys(ACTION_SCHEMAS).length, 57)
  assert.equal(Object.keys(ACTION_TOOL_MAP).length, 57)
  assert.deepEqual(Object.keys(ACTION_SCHEMAS).sort(), Object.keys(ACTION_TOOL_MAP).sort())
  for (const [action, schema] of Object.entries(ACTION_SCHEMAS)) {
    assert.ok(schema.fields !== undefined, `${action} 缺 fields`)
    for (const required of schema.required ?? []) {
      assert.ok(required in schema.fields, `${action} 的 required "${required}" 不在 fields`)
    }
  }
})

test('validateActionArgs：未知 action 与未知字段拒绝；collect.cancel 不在 allowlist（G-1）', () => {
  assert.throws(() => validateActionArgs('collect.cancel', {}), (error: unknown) =>
    error instanceof DouyinError && error.code === 'DOUYIN_ROUTE_UNKNOWN_ACTION')
  assert.throws(() => validateActionArgs('schedule.list', { accountId: 'a', extra: 1 }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'DOUYIN_ROUTE_INVALID_REQUEST')
})

test('H1 collect.running：allowlist 在册、绑定 local、空入参通过、未知字段拒绝', () => {
  assert.deepEqual(ACTION_TOOL_MAP['collect.running'], { kind: 'local' })
  assert.deepEqual(validateActionArgs('collect.running', {}), {})
  assert.throws(() => validateActionArgs('collect.running', { accountId: 'a' }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'DOUYIN_ROUTE_INVALID_REQUEST')
})

test('required 字段缺失拒绝（probe 缺 accountId、schedule.rowCreate 缺 confirm、promotion 缺数值）', () => {
  assert.throws(() => validateActionArgs('account.probe', {}), /missing required field "accountId"/)
  assert.throws(() => validateActionArgs('schedule.rowCreate', { accountId: 'a', idempotencyKey: 'douyin:publish_schedule_create:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /missing required field "confirm"/)
  assert.throws(() => validateActionArgs('breakdown.archiveStart', { shareUrl: 'https://v.douyin.com/x', idempotencyKey: 'douyin:vv_archive:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /missing required field "confirm"/)
  assert.throws(() => validateActionArgs('breakdown.workflowStart', { candidateId: 'c', idempotencyKey: 'douyin:vv_workflow:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /missing required field "confirm"/)
  const base = rowUpdateBase()
  for (const key of Object.keys(base)) {
    const partial = { ...base }
    delete (partial as Record<string, unknown>)[key]
    assert.throws(() => validateActionArgs('schedule.rowUpdate', partial), new RegExp(`missing required field "${key}"`), `缺 ${key} 应拒绝`)
  }
  // recordId 是可选：同参不缺必填 → 应通过（无 recordId 时不抛 missing）。
  const ok = validateActionArgs('work.promotion.save', { accountId: 'a', workId: 'w', playCount: 1, fansCount: 2, costAmount: '3.5', durationHours: '4', idempotencyKey: 'douyin:work_promotion_save:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' })
  assert.equal(ok.recordId, undefined)
})

test('validateActionArgs：类型拒绝、trim 生效、空串可选跳过', () => {
  assert.throws(() => validateActionArgs('schedule.list', { accountId: 7 }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'DOUYIN_ROUTE_INVALID_REQUEST')
  const args = validateActionArgs('schedule.list', { accountId: '  abc  ' })
  assert.equal(args.accountId, 'abc')
  const empty = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ note: '   ' }))
  assert.equal(empty.note, undefined)
})

test('超长字符串拒绝而非截断（顶层字段与数组项同口径）', () => {
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ videoContent: 'x'.repeat(2001) })), /exceeds 2000 characters/)
  assert.throws(() => validateActionArgs('breakdown.archiveStart', { shareUrl: 'x'.repeat(2049), confirm: true, idempotencyKey: 'douyin:vv_archive:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /exceeds 2048 characters/)
  const ok = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ videoContent: 'x'.repeat(2000) }))
  assert.equal((ok.videoContent as string).length, 2000)
})

test('validateActionArgs：number 边界越界拒绝', () => {
  assert.throws(() => validateActionArgs('overview.get', { topN: 0 }), DouyinError)
  assert.throws(() => validateActionArgs('overview.get', { topN: 10001 }), DouyinError)
  assert.equal(validateActionArgs('overview.get', { topN: 100 }).topN, 100)
  assert.throws(() => validateActionArgs('breakdown.history', { limit: 201 }), DouyinError)
})

test('validateActionArgs：integer 接受十进制字符串并夹安全整数范围', () => {
  const fromString = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: '123', expectedVersion: '4', idempotencyKey: 'douyin:publish_schedule_update:123:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }))
  assert.equal(fromString.rowId, 123)
  assert.equal(fromString.expectedVersion, 4)
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: '9007199254740993' })), DouyinError)
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: 0 })), DouyinError)
})

test('validateActionArgs：publishPlatforms 3 项档位与 stringArray 边界', () => {
  const platforms = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['xhs', 'douyin', 'wx_channels'] }))
  assert.deepEqual(platforms.publishPlatforms, ['xhs', 'douyin', 'wx_channels'])
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['xhs', 'douyin', 'wx_channels', 'tiktok'] })), DouyinError)
})

test('material.keyword.upsert 逐项契约：未知键/缺 keyword/非法枚举/越界 searchCount 拒绝', () => {
  const base = { confirm: true, idempotencyKey: 'douyin:vv_keyword_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', category: 'c' }] }), /unknown key "category"/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ status: 'active' }] }), /missing required "keyword"/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', priority: 'P9' }] }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', status: 'paused' }] }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', searchCount: 0 }] }), /out of range/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', searchCount: 101 }] }), /out of range/)
  assert.throws(() => validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'x'.repeat(129) }] }), /exceeds 128 characters/)
  const ok = validateActionArgs('material.keyword.upsert', { ...base, keywords: [{ keyword: 'k', priority: 'P1', status: 'active', searchCount: 5 }] })
  const items = ok.keywords
  assert.ok(Array.isArray(items))
  assert.deepEqual(items[0], { keyword: 'k', priority: 'P1', status: 'active', searchCount: 5 })
})

test('material.account.upsert 逐项契约：枚举/域约束/越界拒绝，合法条目通过', () => {
  const base = { confirm: true, idempotencyKey: 'douyin:vv_account_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'tiktok_id', inputValue: 'x' }] }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'douyin_id', inputValue: 'x', nickname: 'n' }] }), /unknown key "nickname"/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'douyin_id' }] }), /missing required "inputValue"/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'homepage_url', inputValue: 'http://www.douyin.com/user/x' }] }), /https douyin homepage/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'homepage_url', inputValue: 'https://evil.example/u' }] }), /https douyin homepage/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'douyin_id', inputValue: 'x', maxVideos: 101 }] }), /out of range/)
  assert.throws(() => validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'douyin_id', inputValue: 'x', maxVideos: 1.5 }] }), /must be an integer/)
  const ok = validateActionArgs('material.account.upsert', { ...base, accounts: [{ inputForm: 'homepage_url', inputValue: 'https://www.douyin.com/user/x', displayName: '对标', priority: 'P2', status: 'active', maxVideos: 20 }] })
  const items = ok.accounts
  assert.ok(Array.isArray(items))
  assert.deepEqual(items[0], { inputForm: 'homepage_url', inputValue: 'https://www.douyin.com/user/x', displayName: '对标', priority: 'P2', status: 'active', maxVideos: 20 })
})

test('permitted：loopback 基础防线 + cross-site 拒绝 + Origin 精确匹配/缺失放行', () => {
  const make = (headers: Record<string, unknown>, remote = '127.0.0.1'): RouteRequest => ({
    method: 'POST',
    socket: { remoteAddress: remote },
    headers,
  })
  assert.equal(permitted(make({}), origin), true, '双头缺失（Desktop 转发形态）放行')
  assert.equal(permitted(make({ origin }), origin), true)
  assert.equal(permitted(make({ origin: 'http://evil.example' }), origin), false)
  assert.equal(permitted(make({ origin: 'null' }), origin), false)
  assert.equal(permitted(make({ 'sec-fetch-site': 'cross-site', origin }), origin), false)
  assert.equal(permitted(make({}, '10.0.0.8'), origin), false)
})

test('非 POST 拒绝；非 loopback 拒绝；显式异源拒绝', async () => {
  const responded: RecordedResponse[] = []
  const handler = createRouteHandler(() => origin, handlers)
  const res = fakeRes(responded)
  await handler({ ...fakeReq({}), method: 'GET' }, res)
  assert.equal(responded[0]?.status, 405)
  assert.equal(responded[0]?.payload.reason, 'method_not_allowed', '405 的 reason 随 kit 统一为 method_not_allowed（R1）')
  const res2 = fakeRes(responded)
  await handler(fakeReq({ action: 'browser.status' }, {}, '10.0.0.8'), res2)
  assert.equal(responded[1]?.status, 403)
  const res3 = fakeRes(responded)
  await handler(fakeReq({ action: 'browser.status' }, { origin: 'http://evil.example' }), res3)
  assert.equal(responded[2]?.status, 403)
})

test('body 上限：超过 64KB 投影 413 + DOUYIN_ROUTE_PAYLOAD_TOO_LARGE', async () => {
  const responded: RecordedResponse[] = []
  const handler = createRouteHandler(() => origin, handlers)
  const req = fakeReq('a'.repeat(MAX_BODY_BYTES + 1), { origin, 'sec-fetch-site': 'same-origin' })
  await handler(req, fakeRes(responded))
  assert.equal(responded[0]?.status, 413)
  assert.equal(responded[0]?.payload.reason, 'DOUYIN_ROUTE_PAYLOAD_TOO_LARGE')
})

test('malformed JSON 按空体处理 → unknown_action 确定拒绝；未实现 action 同口径', async () => {
  const responded: RecordedResponse[] = []
  const handler = createRouteHandler(() => origin, handlers)
  await handler(fakeReq('{ not json', { origin }), fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'unknown_action')
  await handler(fakeReq({ action: 'schedule.list', accountId: 'a' }, { origin }), fakeRes(responded))
  assert.equal(responded[1]?.status, 400)
  assert.equal(responded[1]?.payload.reason, 'unknown_action')
})

test('稳定响应头：no-store / application/json / nosniff', async () => {
  const responded: RecordedResponse[] = []
  const handler = createRouteHandler(() => origin, handlers)
  await handler(fakeReq({ action: 'browser.status' }, { origin }), fakeRes(responded))
  assert.equal(responded[0]?.headers['cache-control'], 'no-store')
  assert.ok(String(responded[0]?.headers['content-type']).startsWith('application/json'))
  assert.equal(responded[0]?.headers['x-content-type-options'], 'nosniff')
})


test('required 字符串 trim 后空串按缺失拒绝', () => {
  assert.throws(() => validateActionArgs('account.probe', { accountId: '   ' }), /missing required field "accountId"/)
  assert.throws(() => validateActionArgs('schedule.rowCreate', { accountId: 'a', confirm: true, idempotencyKey: '' }), /missing required field "idempotencyKey"/)
  assert.throws(() => validateActionArgs('report.get', { reportId: '' }), /missing required field "reportId"/)
})

test('写操作 confirm 必须为字面量 true（七 action 逐一拒绝 false）', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['breakdown.archiveStart', { shareUrl: 'https://v.douyin.com/x', idempotencyKey: 'douyin:vv_archive:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
    ['breakdown.workflowStart', { candidateId: 'c', idempotencyKey: 'douyin:vv_workflow:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
    ['schedule.rowCreate', { accountId: 'a', idempotencyKey: 'douyin:publish_schedule_create:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
    ['schedule.rowUpdate', rowUpdateBase()],
    ['schedule.rowDelete', { accountId: 'a', rowId: 1, expectedVersion: 1, idempotencyKey: 'douyin:publish_schedule_delete:1:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
    ['material.keyword.upsert', { keywords: [{ keyword: 'k' }], idempotencyKey: 'douyin:vv_keyword_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
    ['material.account.upsert', { accounts: [{ inputForm: 'douyin_id', inputValue: 'x' }], idempotencyKey: 'douyin:vv_account_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }],
  ]
  for (const [action, args] of cases) {
    assert.throws(() => validateActionArgs(action, { ...args, confirm: false }), (error: unknown) =>
      error instanceof DouyinError && error.code === 'CONFIRMATION_REQUIRED', `${action} confirm=false 应拒绝`)
    assert.throws(() => validateActionArgs(action, { ...args, confirm: 'yes' }), DouyinError, `${action} confirm 非布尔应拒绝`)
  }
})

test('workflowStatus oneOf：双缺/双空拒绝，单字段通过', () => {
  assert.throws(() => validateActionArgs('breakdown.workflowStatus', {}), /one of \[workflowId, candidateId\] is required/)
  assert.throws(() => validateActionArgs('breakdown.workflowStatus', { workflowId: '  ', candidateId: '' }), /one of/)
  const byWorkflow = validateActionArgs('breakdown.workflowStatus', { workflowId: 'wf-1' })
  assert.equal(byWorkflow.workflowId, 'wf-1')
  const byCandidate = validateActionArgs('breakdown.workflowStatus', { candidateId: 'c-1' })
  assert.equal(byCandidate.candidateId, 'c-1')
})

test('minItems：keywords/accounts 空数组拒绝，publishPlatforms 空数组合法', () => {
  assert.throws(() => validateActionArgs('material.keyword.upsert', { keywords: [], confirm: true, idempotencyKey: 'douyin:vv_keyword_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /needs at least 1 items/)
  assert.throws(() => validateActionArgs('material.account.upsert', { accounts: [], confirm: true, idempotencyKey: 'douyin:vv_account_upsert:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /needs at least 1 items/)
  const platforms = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: [] }))
  assert.deepEqual(platforms.publishPlatforms, [])
})

test('顶层封闭枚举：非法值拒绝、合法值通过', () => {
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['xhs', 'tiktok'] })), /item is not an allowed value/)
  assert.throws(() => validateActionArgs('report.list', { reportType: 'monthly' }), /not an allowed value/)
  assert.equal(validateActionArgs('report.list', { reportType: 'daily' }).reportType, 'daily')
  assert.throws(() => validateActionArgs('material.collect.start', { idempotencyKey: 'douyin:vv_seed_search:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f', priorities: ['P1', 'P9'] }), /item is not an allowed value/)
  assert.throws(() => validateActionArgs('material.collect.start', { idempotencyKey: 'douyin:vv_seed_search:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f', candidateMinLevel: 'D' }), /not an allowed value/)
  assert.equal(validateActionArgs('material.collect.start', { idempotencyKey: 'douyin:vv_seed_search:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f', candidateMinLevel: 'A' }).candidateMinLevel, 'A')
  assert.throws(() => validateActionArgs('material.videos.list', { minLevel: 'E' }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.videos.list', { sortBy: 'random' }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.videos.list', { storyboardStatus: 'pending' }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.videos.list', { scope: 'everything' }), /not an allowed value/)
  assert.throws(() => validateActionArgs('material.videos.list', { sourceKind: 'manual' }), /not an allowed value/)
  assert.equal(validateActionArgs('material.videos.list', { minLevel: 'S', sourceKind: 'both' }).sourceKind, 'both')
  assert.throws(() => validateActionArgs('gene.search', { adoptionStatus: 'draft' }), /not an allowed value/)
  assert.equal(validateActionArgs('gene.search', { adoptionStatus: 'ai_draft' }).adoptionStatus, 'ai_draft')
  assert.throws(() => validateActionArgs('gene.update', { recordId: 'r', idempotencyKey: 'douyin:vv_gene_upd:rec-1:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f', adoptionStatus: 'archived' }), /not an allowed value/)
  assert.throws(() => validateActionArgs('gene.list', { geneStatus: 'queued' }), /not an allowed value/)
  assert.equal(validateActionArgs('gene.list', { geneStatus: 'succeeded' }).geneStatus, 'succeeded')
})

test('顶层整数约束：小数与 NaN 拒绝（promotion.playCount=1.5 必须拒绝）', () => {
  assert.throws(() => validateActionArgs('work.promotion.save', { accountId: 'a', workId: 'w', playCount: 1.5, fansCount: 2, costAmount: '3.5', durationHours: '4', idempotencyKey: 'douyin:work_promotion_save:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }), /must be an integer/)
  assert.throws(() => validateActionArgs('collect.start', { accountId: 'a', maxPages: 1.5 }), /must be an integer/)
  assert.throws(() => validateActionArgs('overview.get', { topN: Number.NaN }), /must be an integer/)
  assert.throws(() => validateActionArgs('material.videos.list', { offset: 2.5 }), /must be an integer/)
  const ok = validateActionArgs('work.promotion.save', { accountId: 'a', workId: 'w', playCount: 1, fansCount: 0, costAmount: '3.5', durationHours: '4', idempotencyKey: 'douyin:work_promotion_save:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' })
  assert.equal(ok.playCount, 1)
  const offsetZero = validateActionArgs('material.videos.list', { offset: 0 })
  assert.equal(offsetZero.offset, 0, 'offset 允许 0（ranges 下限覆盖）')
})

test('定点十进制字符串：格式与边界（promotion 金额/时长）', () => {
  const base = { accountId: 'a', workId: 'w', playCount: 1, fansCount: 2, idempotencyKey: 'douyin:work_promotion_save:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: 'abc', durationHours: '4' }), /unsigned decimal/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '1.234', durationHours: '4' }), /at most two fraction digits/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '+3.5', durationHours: '4' }), /unsigned decimal/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '1e3', durationHours: '4' }), /unsigned decimal/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '1000000000000.00', durationHours: '4' }), /exceeds 999999999999.99/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '3.5', durationHours: '0' }), /below the allowed minimum/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '3.5', durationHours: '1000000.00' }), /exceeds 999999.99/)
  assert.throws(() => validateActionArgs('work.promotion.save', { ...base, costAmount: '3.5', durationHours: '4.123' }), /at most two fraction digits/)
  const ok = validateActionArgs('work.promotion.save', { ...base, costAmount: '999999999999.99', durationHours: '999999.99' })
  assert.equal(ok.costAmount, '999999999999.99')
  assert.equal(ok.durationHours, '999999.99')
  const zeroCost = validateActionArgs('work.promotion.save', { ...base, costAmount: '0', durationHours: '0.01' })
  assert.equal(zeroCost.costAmount, '0', '金额允许 0')
  assert.equal(zeroCost.durationHours, '0.01', '时长必须大于 0，0.01 合法')
})

test('日期字段：YYYY-MM-DD 真实日历校验', () => {
  assert.throws(() => validateActionArgs('overview.get', { publishFrom: '2026-02-30' }), /real calendar date/)
  assert.throws(() => validateActionArgs('overview.get', { publishTo: '2026-13-01' }), /real calendar date/)
  assert.throws(() => validateActionArgs('overview.get', { publishFrom: '2026/01/01' }), /real calendar date/)
  assert.throws(() => validateActionArgs('overview.get', { publishFrom: '2026-02-29' }), /real calendar date/, '非闰年 2 月 29 拒绝')
  const leap = validateActionArgs('overview.get', { publishFrom: '2024-02-29' })
  assert.equal(leap.publishFrom, '2024-02-29', '闰年 2 月 29 通过')
  const normal = validateActionArgs('overview.get', { publishFrom: '2026-02-28' })
  assert.equal(normal.publishFrom, '2026-02-28')
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ shootingDate: '2026-02-30' })), /real calendar date/)
  const schedule = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ shootingDate: '2026-01-31', publishDate: '2026-03-01' }))
  assert.equal(schedule.publishDate, '2026-03-01')
  assert.throws(() => validateActionArgs('material.videos.list', { publishedFrom: '2026-02-30' }), /real calendar date/)
})


test('integer 字符串只接受纯十进制位：十六进制/指数/加号/小数/空串拒绝，前导零归一', () => {
  const illegal = ['0x10', '1e2', '+123', '123.0', '', '  ', '-5']
  for (const bad of illegal) {
    assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: bad })), /must be an integer/, `"${bad}" 应拒绝`)
    assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ expectedVersion: bad })), /must be an integer/, `expectedVersion "${bad}" 应拒绝`)
  }
  const normalized = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: '000123', expectedVersion: '007', idempotencyKey: 'douyin:publish_schedule_update:123:0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f' }))
  assert.equal(normalized.rowId, 123, '前导零归一为十进制值')
  assert.equal(normalized.expectedVersion, 7)
})

test('account.loginStatus 二选一：双缺/双空拒绝，单字段通过', () => {
  assert.throws(() => validateActionArgs('account.loginStatus', {}), /one of \[accountId, loginKey\] is required/)
  assert.throws(() => validateActionArgs('account.loginStatus', { accountId: ' ', loginKey: ' ' }), /one of \[accountId, loginKey\] is required/)
  const byAccount = validateActionArgs('account.loginStatus', { accountId: 'acct-9' })
  assert.equal(byAccount.accountId, 'acct-9')
  const byKey = validateActionArgs('account.loginStatus', { loginKey: 'pending-1' })
  assert.equal(byKey.loginKey, 'pending-1')
})

test('works.list 分页参数：sort/order 枚举、limit/offset 整数与范围、accountId 仍必填', () => {
  // 类型：sort/order 必须 string，limit/offset 必须整数（十进制串放行）。
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', sort: 7 }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'DOUYIN_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', order: true }), DouyinError)
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', limit: 1.5 }), /must be an integer/)
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', offset: 'abc' }), /must be an integer/)
  // sort 十一枚举：枚举外拒绝、枚举内逐一通过。
  const sortKeys = ['publish_time', 'play_count', 'collect_count', 'like_count', 'comment_count', 'bounce_rate_2s_pct', 'completion_rate_5s_pct', 'completion_rate_pct', 'fans_gain_count', 'avg_watch_duration_s', 'avg_view_proportion_pct']
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', sort: 'random' }), /not an allowed value/)
  for (const key of sortKeys) {
    assert.equal(validateActionArgs('works.list', { accountId: 'a', sort: key }).sort, key)
  }
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', order: 'ascending' }), /not an allowed value/)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', order: 'asc' }).order, 'asc')
  assert.equal(validateActionArgs('works.list', { accountId: 'a', order: 'desc' }).order, 'desc')
  // 范围：limit 1..100、offset 0..1000000（0 合法、负数与越界拒绝）。
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', limit: 0 }), /out of range/)
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', limit: 101 }), /out of range/)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', limit: 100 }).limit, 100)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', limit: '10' }).limit, 10)
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', offset: -1 }), /out of range/)
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', offset: 1000001 }), /out of range/)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', offset: 0 }).offset, 0)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', offset: 1000000 }).offset, 1000000)
  assert.equal(validateActionArgs('works.list', { accountId: 'a', offset: '20' }).offset, 20)
  // accountId 仍必填。
  assert.throws(() => validateActionArgs('works.list', { limit: 10, offset: 0 }), /missing required field "accountId"/)
})

test('服务端封闭枚举：总览排序/热门形态/账号趋势指标/报表状态', () => {
  assert.throws(() => validateActionArgs('overview.get', { sort: 'random' }), /not an allowed value/)
  assert.equal(validateActionArgs('overview.get', { sort: 'median_play' }).sort, 'median_play')
  assert.throws(() => validateActionArgs('account.analysis', { accountId: 'a', sort: 'play' }), /not an allowed value/)
  assert.equal(validateActionArgs('account.analysis', { accountId: 'a', sort: 'engagement_rate' }).sort, 'engagement_rate')
  assert.throws(() => validateActionArgs('hotWorks.list', { hotType: 'relative' }), /not an allowed value/)
  assert.equal(validateActionArgs('hotWorks.list', { hotType: 'account_relative' }).hotType, 'account_relative')
  assert.throws(() => validateActionArgs('hotWorks.list', { sort: 'hot_count' }), /not an allowed value/)
  assert.equal(validateActionArgs('hotWorks.list', { sort: 'growth' }).sort, 'growth')
  assert.throws(() => validateActionArgs('account.trend', { accountId: 'a', metric: 'ctr' }), /not an allowed value/)
  assert.equal(validateActionArgs('account.trend', { accountId: 'a', metric: 'net_fans' }).metric, 'net_fans')
  assert.throws(() => validateActionArgs('report.list', { status: 'cancelled' }), /not an allowed value/)
  assert.equal(validateActionArgs('report.list', { status: 'insufficient' }).status, 'insufficient')
})


test('account.trend / report.list 日期字段：非日历形态拒绝，合法通过', () => {
  assert.throws(() => validateActionArgs('account.trend', { accountId: 'a', fromDay: '2026-02-30' }), /real calendar date/)
  assert.throws(() => validateActionArgs('account.trend', { accountId: 'a', toDay: '2026-13-01' }), /real calendar date/)
  const trend = validateActionArgs('account.trend', { accountId: 'a', fromDay: '2026-01-01', toDay: '2026-01-31', metric: 'play' })
  assert.equal(trend.fromDay, '2026-01-01')
  assert.throws(() => validateActionArgs('report.list', { periodStart: '2026-02-30' }), /real calendar date/)
  const report = validateActionArgs('report.list', { periodStart: '2026-04-30', reportType: 'daily' })
  assert.equal(report.periodStart, '2026-04-30')
})

test('assetLink：绝对 http(s) URL 校验（协议/host/空白字符）', () => {
  const base = rowUpdateBase({ idempotencyKey: `douyin:publish_schedule_update:1:${'0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f'}` })
  assert.throws(() => validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'not a url' }), /absolute http\(s\) url/)
  assert.throws(() => validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'http:///no-host' }), /absolute http\(s\) url/)
  assert.throws(() => validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'https://example.com/a b' }), /absolute http\(s\) url/)
  assert.throws(() => validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'ftp://example.com/a' }), /absolute http\(s\) url/)
  const https = validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'https://example.com/a' })
  assert.equal(https.assetLink, 'https://example.com/a')
  const http = validateActionArgs('schedule.rowUpdate', { ...base, assetLink: 'http://example.com/a' })
  assert.equal(http.assetLink, 'http://example.com/a')
})

test('publishPlatforms 归一化：去重并按固定顺序输出，空数组仍合法', () => {
  const deduped = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['wx_channels', 'douyin', 'wx_channels'] }))
  assert.deepEqual(deduped.publishPlatforms, ['douyin', 'wx_channels'])
  const reordered = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['douyin', 'xhs'] }))
  assert.deepEqual(reordered.publishPlatforms, ['xhs', 'douyin'])
  const empty = validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: [] }))
  assert.deepEqual(empty.publishPlatforms, [])
  assert.throws(() => validateActionArgs('schedule.rowUpdate', rowUpdateBase({ publishPlatforms: ['tiktok'] })), /item is not an allowed value/)
})

test('幂等键模板：非法键拒绝（十五 action 覆盖）', () => {
  const hex32 = '0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f'
  const bad: Array<[string, Record<string, unknown>]> = [
    ['aiAnalysis.start', { accountId: 'a', idempotencyKey: 'douyin:ai_analysis:not-a-uuid' }],
    ['breakdown.archiveStart', { shareUrl: 'https://v.douyin.com/x', confirm: true, idempotencyKey: 'wrong:vv_archive:' + hex32 }],
    ['breakdown.downloadStart', { shareUrl: 'https://v.douyin.com/x', idempotencyKey: 'douyin:vv_download:' + 'z'.repeat(32) }],
    ['breakdown.workflowStart', { candidateId: 'c', confirm: true, idempotencyKey: 'douyin:vv_workflow:u' }],
    ['report.regenerate', { reportId: 'rep-1', idempotencyKey: 'douyin:report_regenerate:rep-2:' + hex32 }],
    ['account.owner.set', { accountId: 'a', ownerName: 'N', idempotencyKey: 'douyin:account_owner_set' }],
    ['work.promotion.save', { accountId: 'a', workId: 'w', playCount: 1, fansCount: 2, costAmount: '1', durationHours: '2', idempotencyKey: 'douyin:work_promotion_save:12345' }],
    ['schedule.rowCreate', { accountId: 'a', confirm: true, idempotencyKey: 'douyin:publish_schedule_create:1:' + hex32 }],
    ['schedule.rowUpdate', { ...rowUpdateBase({ idempotencyKey: `douyin:publish_schedule_update:2:${hex32}` }) }],
    ['schedule.rowDelete', { accountId: 'a', rowId: 3, expectedVersion: 1, confirm: true, idempotencyKey: `douyin:publish_schedule_delete:9:${hex32}` }],
    ['material.keyword.upsert', { keywords: [{ keyword: 'k' }], confirm: true, idempotencyKey: 'douyin:vv_keyword_upsert:1e2' }],
    ['material.account.upsert', { accounts: [{ inputForm: 'douyin_id', inputValue: 'x' }], confirm: true, idempotencyKey: 'douyin:vv_account_upsert:+123' }],
    ['material.collect.start', { idempotencyKey: 'douyin:vv_seed_search:0F8F1C9E-1A2B-4C3D-8E4F-5A6B7C8D9E0F'.toLowerCase().replace('0f', '0F') }],
    ['gene.update', { recordId: 'rec-1', idempotencyKey: `douyin:vv_gene_upd:rec-2:${hex32}` }],
    ['gene.regenerate', { recordId: 'rec-1', idempotencyKey: 'douyin:vv_gene_reg:rec-1:fffffffffffffffffffffffffffffffff' }],
  ]
  for (const [action, args] of bad) {
    assert.throws(() => validateActionArgs(action, args), (error: unknown) =>
      error instanceof DouyinError && error.code === 'INVALID_IDEMPOTENCY_KEY', `${action} 非法幂等键应拒绝`)
  }
})

test('幂等键模板：合法键通过（32 位 hex 与标准 UUID 两形态、绑定段归一）', () => {
  const hex32 = '0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f'
  const std = '0f8f1c9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f'
  assert.equal(validateActionArgs('aiAnalysis.start', { accountId: 'a', idempotencyKey: `douyin:ai_analysis:${std}` }).idempotencyKey, `douyin:ai_analysis:${std}`)
  assert.equal(validateActionArgs('breakdown.archiveStart', { shareUrl: 'https://v.douyin.com/x', confirm: true, idempotencyKey: `douyin:vv_archive:${hex32}` }).idempotencyKey, `douyin:vv_archive:${hex32}`)
  assert.equal(validateActionArgs('breakdown.downloadStart', { shareUrl: 'https://v.douyin.com/x', idempotencyKey: `douyin:vv_download:${hex32}` }).idempotencyKey, `douyin:vv_download:${hex32}`)
  assert.equal(validateActionArgs('breakdown.workflowStart', { candidateId: 'c', confirm: true, idempotencyKey: `douyin:vv_workflow:${std}` }).idempotencyKey, `douyin:vv_workflow:${std}`)
  assert.equal(validateActionArgs('report.regenerate', { reportId: 'rep-1', idempotencyKey: `douyin:report_regenerate:rep-1:${hex32}` }).idempotencyKey, `douyin:report_regenerate:rep-1:${hex32}`)
  assert.equal(validateActionArgs('account.owner.set', { accountId: 'a', ownerName: 'N', idempotencyKey: `douyin:account_owner_set:${hex32}` }).idempotencyKey, `douyin:account_owner_set:${hex32}`)
  const promo = validateActionArgs('work.promotion.save', { accountId: 'a', workId: 'w', playCount: 1, fansCount: 2, costAmount: '1', durationHours: '2', idempotencyKey: `douyin:work_promotion_save:${hex32}` })
  assert.ok(typeof promo.idempotencyKey === 'string')
  assert.equal(validateActionArgs('schedule.rowCreate', { accountId: 'a', confirm: true, idempotencyKey: `douyin:publish_schedule_create:${hex32}` }).idempotencyKey, `douyin:publish_schedule_create:${hex32}`)
  // 绑定段：十进制字符串 rowId 归一后与键内段一致（'007' → 7 → 键内 7）。
  assert.equal(validateActionArgs('schedule.rowUpdate', rowUpdateBase({ rowId: '007', idempotencyKey: `douyin:publish_schedule_update:7:${hex32}` })).idempotencyKey, `douyin:publish_schedule_update:7:${hex32}`)
  assert.equal(validateActionArgs('schedule.rowDelete', { accountId: 'a', rowId: 3, expectedVersion: 1, confirm: true, idempotencyKey: `douyin:publish_schedule_delete:3:${hex32}` }).idempotencyKey, `douyin:publish_schedule_delete:3:${hex32}`)
  assert.equal(validateActionArgs('material.keyword.upsert', { keywords: [{ keyword: 'k' }], confirm: true, idempotencyKey: `douyin:vv_keyword_upsert:${hex32}` }).idempotencyKey, `douyin:vv_keyword_upsert:${hex32}`)
  assert.equal(validateActionArgs('material.account.upsert', { accounts: [{ inputForm: 'douyin_id', inputValue: 'x' }], confirm: true, idempotencyKey: `douyin:vv_account_upsert:${std}` }).idempotencyKey, `douyin:vv_account_upsert:${std}`)
  assert.equal(validateActionArgs('material.collect.start', { idempotencyKey: `douyin:vv_seed_search:${hex32}` }).idempotencyKey, `douyin:vv_seed_search:${hex32}`)
  assert.equal(validateActionArgs('gene.update', { recordId: 'rec-1', idempotencyKey: `douyin:vv_gene_upd:rec-1:${hex32}` }).idempotencyKey, `douyin:vv_gene_upd:rec-1:${hex32}`)
  assert.equal(validateActionArgs('gene.regenerate', { recordId: 'rec-1', idempotencyKey: `douyin:vv_gene_reg:rec-1:${std}` }).idempotencyKey, `douyin:vv_gene_reg:rec-1:${std}`)
})


test('幂等键绑定段对抗性测试：正则元字符与冒号绑定值按字面精确比较', () => {
  const hex32 = '0f8f1c9e1a2b4c3d8e4f5a6b7c8d9e0f'
  // regex 注入：reportId='rep.*' 的 .* 不得扩大键内段匹配。
  assert.throws(() => validateActionArgs('report.regenerate', { reportId: 'rep.*', idempotencyKey: `douyin:report_regenerate:repOTHER:${hex32}` }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'INVALID_IDEMPOTENCY_KEY', 'rep.* 的通配注入应拒绝')
  const repStar = validateActionArgs('report.regenerate', { reportId: 'rep.*', idempotencyKey: `douyin:report_regenerate:rep.*:${hex32}` })
  assert.equal(repStar.idempotencyKey, `douyin:report_regenerate:rep.*:${hex32}`, '字面 rep.* 前缀精确匹配通过')
  // 分组括号注入：rep(a|b) 不得让 repa 匹配。
  assert.throws(() => validateActionArgs('report.regenerate', { reportId: 'rep(a|b)', idempotencyKey: `douyin:report_regenerate:repa:${hex32}` }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'INVALID_IDEMPOTENCY_KEY', 'rep(a|b) 的分组注入应拒绝')
  const repGroup = validateActionArgs('report.regenerate', { reportId: 'rep(a|b)', idempotencyKey: `douyin:report_regenerate:rep(a|b):${hex32}` })
  assert.equal(repGroup.idempotencyKey, `douyin:report_regenerate:rep(a|b):${hex32}`, '字面 rep(a|b) 前缀精确匹配通过')
  // recordId 同口径。
  assert.throws(() => validateActionArgs('gene.update', { recordId: 'rec.*', idempotencyKey: `douyin:vv_gene_upd:recOTHER:${hex32}` }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'INVALID_IDEMPOTENCY_KEY', 'rec.* 的通配注入应拒绝')
  const recStar = validateActionArgs('gene.update', { recordId: 'rec.*', idempotencyKey: `douyin:vv_gene_upd:rec.*:${hex32}` })
  assert.equal(recStar.idempotencyKey, `douyin:vv_gene_upd:rec.*:${hex32}`, '字面 rec.* 前缀精确匹配通过')
  // 含冒号的绑定值：前缀按完整字面比较，第二段冒号不产生歧义。
  assert.throws(() => validateActionArgs('gene.update', { recordId: 'rec:1', idempotencyKey: `douyin:vv_gene_upd:rec:2:${hex32}` }), (error: unknown) =>
    error instanceof DouyinError && error.code === 'INVALID_IDEMPOTENCY_KEY', 'rec:2 键应拒绝')
  const recColon = validateActionArgs('gene.update', { recordId: 'rec:1', idempotencyKey: `douyin:vv_gene_upd:rec:1:${hex32}` })
  assert.equal(recColon.idempotencyKey, `douyin:vv_gene_upd:rec:1:${hex32}`, 'rec:1 完整前缀精确匹配通过')
})
