/**
 * X1+X2 Host 基础测试：路由安全层（allowlist/schema/未知字段/体上限/同源/CSRF）、
 * action 处理器（browser/accounts/login/probe/removeLocal/collect）、本地投影
 * 与稳定错误收敛。
 * 运行：`node --test tests/host.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ACTION_SCHEMAS, MAX_BODY_BYTES, createRouteHandler, permitted, validateActionArgs } from '../src/route.ts'
import { STABLE_ERROR_CODES, XhsError } from '../src/errors.ts'
import { buildRouteHandlers, createXhsHostDeps, type XhsHostDeps } from '../src/handlers.ts'
import { isProfileLocked, acquireProfileLock } from '../src/locks.ts'
import { writeAccounts } from '../src/state.ts'
import { Config } from '../src/index.ts'
import { createFakeChrome, createFakeState, createFakeWorkbench, postedPage, sessionCookie, userInfoPayload } from './fakes.ts'

/** 独立状态根目录（每用例新建，用后清理）。 */
async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-host-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

function fakeRes(responded: Array<{ status: number; payload: Record<string, unknown> }>): ServerResponse {
  return {
    statusCode: 0,
    setHeader() {},
    end(payload: unknown) {
      responded.push({ status: this.statusCode, payload: JSON.parse(String(payload)) as Record<string, unknown> })
    },
  } as unknown as ServerResponse
}

function fakeReq(body: unknown, headers: Record<string, unknown> = {}, remote = '127.0.0.1'): IncomingMessage {
  return {
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    },
  } as unknown as IncomingMessage
}

/** 组装带假 Chrome 与假 Workbench 的 deps（登录等待压缩为毫秒级）。 */
async function testDeps(root: string, options: {
  factory?: (state: import('./fakes.ts').FakeCreatorState) => import('../src/chrome.ts').ChromeFactory
  workbench?: ReturnType<typeof createFakeWorkbench>['face']
} = {}): Promise<{ deps: XhsHostDeps; state: import('./fakes.ts').FakeCreatorState }> {
  const fake = createFakeChrome()
  const deps = createXhsHostDeps({
    root,
    workbench: options.workbench ?? createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: options.factory === undefined ? fake.factory : options.factory(fake.state),
  })
  deps.loginTimeoutMs = 80
  return { deps, state: fake.state }
}

// --- 路由 schema 层 ---

test('action allowlist：X1+X2 白名单 10 项且全部有 schema', () => {
  const expected = [
    'browser.status', 'accounts.list', 'account.beginLogin', 'account.loginStatus',
    'account.probe', 'account.removeLocal', 'collect.start', 'collect.status',
    'hotboard.settings', 'hotboard.settingsUpdate',
  ]
  assert.deepEqual(Object.keys(ACTION_SCHEMAS).sort(), expected.sort())
})

test('插件 Config 可解析（stateDir 缺省空串）', () => {
  assert.deepEqual(Config({}), { stateDir: '' })
})

test('schema：未知字段拒绝、未知 action 拒绝、类型拒绝、字符串截断', () => {
  assert.throws(() => validateActionArgs('collect.start', { accountId: 'a', theme: 'x' }), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('nonexistent', {}), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_UNKNOWN_ACTION')
  assert.throws(() => validateActionArgs('collect.start', { accountId: 1 }), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_INVALID_REQUEST')
  const args = validateActionArgs('collect.start', { accountId: '  abc  ', idempotencyKey: 'k'.repeat(200) })
  assert.equal(args.accountId, 'abc')
  assert.equal((args.idempotencyKey as string).length, 128)
})

test('体上限：超过 64KB 投影 XHS_ROUTE_PAYLOAD_TOO_LARGE（413）', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ok' }) })
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)
    },
  } as unknown as IncomingMessage
  await handler(req, fakeRes(responded))
  assert.equal(responded[0]?.status, 413)
  assert.equal(responded[0]?.payload.reason, 'XHS_ROUTE_PAYLOAD_TOO_LARGE')
})

test('路由信任：loopback 基础防线，浏览器标记缺失放行（Desktop 转发形态），显式跨站/异源/null 拒绝', async () => {
  const responded: Array<{ status: number }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ok' }) })
  const make = (headers: Record<string, unknown> = {}, remote = '127.0.0.1'): IncomingMessage => ({
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"collect.status"}') },
  } as unknown as IncomingMessage)
  await handler(make(), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  await handler(make({ origin: 'http://127.0.0.1:1' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  await handler(make({ origin: 'https://evil.example' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  await handler(make({ origin: 'null' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' }, '10.0.0.1'), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
})

test('permitted：loopback 各形态放行，标记语义与 connection fence 对齐', () => {
  const req = (headers: Record<string, unknown>, remote = '127.0.0.1'): IncomingMessage =>
    ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage
  assert.equal(permitted(req({}), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(req({}, '::1'), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(req({}, '::ffff:127.0.0.1'), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(req({ origin: 'http://127.0.0.1:1' }), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(req({ origin: 'null' }), 'http://127.0.0.1:1'), false)
  assert.equal(permitted(req({ origin: 'https://evil.example' }), 'http://127.0.0.1:1'), false)
  assert.equal(permitted(req({ 'sec-fetch-site': 'cross-site' }), 'http://127.0.0.1:1'), false)
  assert.equal(permitted(req({}, '10.0.0.1'), 'http://127.0.0.1:1'), false)
})

test('未知 action 返回 unknown_action（400）；非 POST 返回 405', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', {})
  await handler(fakeReq({ action: 'collect.status' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'unknown_action')
  const getReq = { ...fakeReq({}), method: 'GET' } as unknown as IncomingMessage
  await handler(getReq, fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 405)
})

test('handler 抛非稳定码错误收敛为稳定 reason，不透传原文', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', {
    'collect.status': async () => { throw new Error('internal stack with secret=abc') },
  })
  await handler(fakeReq({ action: 'collect.status' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 200)
  assert.equal(responded[0]?.payload.reason, 'xhs_operation_request_failed')
  assert.equal(JSON.stringify(responded[0]?.payload).includes('secret'), false)
})

// --- action 处理器 ---

test('browser.status：布尔与平台投影，不回传设备路径', async () => {
  const root = await tempRoot()
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['browser.status']!({}) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  assert.equal(payload.chromeAvailable, true)
  assert.equal(payload.driverAvailable, true)
  assert.equal(payload.platform, 'linux')
  assert.equal(payload.hint, null)
  await rm(root, { recursive: true, force: true })
})

test('browser.status：无 Chrome 给阻断 hint', async () => {
  const root = await tempRoot()
  const deps = createXhsHostDeps({
    root,
    workbench: createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: false, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['browser.status']!({}) as Record<string, unknown>
  assert.equal(payload.chromeAvailable, false)
  assert.equal(payload.hint, 'install_google_chrome')
  await rm(root, { recursive: true, force: true })
})

test('accounts.list：本地投影排序、头像白名单、快照摘要', async () => {
  const root = await tempRoot()
  await writeAccounts({
    version: 1,
    accounts: {
      'acc-b': { accountId: 'acc-b', nickname: '乙', avatar: 'javascript:alert(1)', sessionStatus: 'expired' },
      'acc-a': { accountId: 'acc-a', nickname: '甲', avatar: 'https://cdn.example/a.png', sessionStatus: 'ok', lastCollectedAt: '2026-11-20T00:00:00.000Z' },
    },
  }, root)
  const snapshotDir = join(root, 'data', 'acc-a')
  await mkdir(snapshotDir, { recursive: true })
  await writeFile(join(snapshotDir, 'notes-20261120-000000-x.json'), `${JSON.stringify({
    schemaVersion: 1, accountId: 'acc-a', capturedAt: '2026-11-20T00:00:00.000Z', source: 'creator-web',
    notes: [{ contentId: 'n1', title: '一', metrics: { plays: 10, likes: 2 } }, { contentId: 'n2', title: '二', metrics: {} }],
  })}\n`)
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['accounts.list']!({}) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  const accounts = payload.accounts as Array<Record<string, unknown>>
  assert.equal(accounts.length, 2)
  assert.equal(accounts[0]?.accountId, 'acc-a')
  assert.equal(accounts[0]?.avatar, 'https://cdn.example/a.png')
  const summary = accounts[0]?.summary as Record<string, unknown>
  assert.equal(summary.notesCount, 2)
  assert.deepEqual(summary.totals, { plays: 10, likes: 2, collects: 0, comments: 0, shares: 0 })
  // n2 metrics 为空对象：全部六项中 plays/likes 记 1 条缺口，其余 2 条。
  assert.deepEqual(summary.gaps, { plays: 1, likes: 1, collects: 2, comments: 2, shares: 2 })
  assert.equal(accounts[1]?.avatar, null)
  assert.equal(accounts[1]?.summary, undefined)
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：扫码成功落账号（pending → resolved 迁移），资料缺失落 unknown', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.cookies = sessionCookie()
  state.profileJson = userInfoPayload('real-id', '昵称甲', 'https://cdn.example/a.png')
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({}) as Record<string, unknown>
  assert.equal(begin.status, 'ready')
  const waiting = begin.login as Record<string, unknown>
  assert.equal(waiting.status, 'waiting')
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['account.loginStatus']!({ loginId: String(waiting.loginId) }) as Record<string, unknown>
  const login = status.login as Record<string, unknown>
  assert.equal(login.status, 'ok')
  assert.equal(login.accountId, 'real-id')
  assert.equal(login.nickname, '昵称甲')
  // 终态读取一次后清理：再次查询为 idle。
  const again = await handlers['account.loginStatus']!({ loginId: 'real-id' }) as Record<string, unknown>
  assert.equal((again.login as Record<string, unknown>).status, 'idle')
  // 账号记录 ok + storage_state 备份落盘。
  const record = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, { sessionStatus: string }> }
  assert.equal(record.accounts['real-id'].sessionStatus, 'ok')
  assert.ok(await readFile(join(root, 'storage-state', 'real-id.json'), 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：waiting 幂等复用；login 运行中同账号 probe 返回 PROFILE_BUSY', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  // cookie 一直不出现 → 等待态保持到超时。
  const handlers = buildRouteHandlers(deps)
  const first = await handlers['account.beginLogin']!({ accountId: 'acc-1' }) as Record<string, unknown>
  const second = await handlers['account.beginLogin']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal((first.login as Record<string, unknown>).loginId, (second.login as Record<string, unknown>).loginId)
  assert.ok(isProfileLocked('acc-1'))
  const probe = await handlers['account.probe']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(probe.status, 'error')
  assert.equal(probe.reason, 'PROFILE_BUSY')
  await deps.taskRegistry.awaitSettled()
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：resolvedId 已被占用时丢弃扫码成果（PROFILE_BUSY）且不覆盖既有会话', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'real-id.json'), '{"cookies":[]}\n', { mode: 0o600 })
  const { deps, state } = await testDeps(root)
  state.cookies = sessionCookie()
  state.profileJson = userInfoPayload('real-id', null, null)
  const handlers = buildRouteHandlers(deps)
  // 模拟 real-id 已被其他浏览器操作占用。
  const release = acquireProfileLock('real-id')
  const begin = await handlers['account.beginLogin']!({}) as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  release()
  const login = begin.login as Record<string, unknown>
  // waiting run 终态为 failed + PROFILE_BUSY（占用期间 resolvedId 锁检查生效）。
  const status = await handlers['account.loginStatus']!({ loginId: String(login.loginId) }) as Record<string, unknown>
  const projected = status.login as Record<string, unknown>
  assert.equal(projected.status, 'failed')
  assert.equal(projected.reason, 'PROFILE_BUSY')
  // 既有备份未被覆盖（pending 目录内容不迁移过去）。
  const backup = await readFile(join(root, 'storage-state', 'real-id.json'), 'utf8')
  assert.equal(backup, '{"cookies":[]}\n')
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：扫码超时收敛 LOGIN_TIMEOUT，窗口关闭无临时残留', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({ accountId: 'acc-timeout' }) as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['account.loginStatus']!({ loginId: 'acc-timeout' }) as Record<string, unknown>
  const login = status.login as Record<string, unknown>
  assert.equal(login.status, 'timeout')
  assert.ok(state.closeCount >= 1)
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：验证码出现收敛 CAPTCHA_DETECTED，绝不绕过', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.captchaVisible = true
  const handlers = buildRouteHandlers(deps)
  await handlers['account.beginLogin']!({ accountId: 'acc-captcha' })
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['account.loginStatus']!({ loginId: 'acc-captcha' }) as Record<string, unknown>
  const login = status.login as Record<string, unknown>
  assert.equal(login.status, 'failed')
  assert.equal(login.reason, 'CAPTCHA_DETECTED')
  await rm(root, { recursive: true, force: true })
})

test('account.probe：ok 回写账号状态并刷新 storage_state 备份', async () => {
  const root = await tempRoot()
  await writeAccounts({ version: 1, accounts: { 'acc-1': { accountId: 'acc-1', sessionStatus: 'unknown' } } }, root)
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'acc-1.json'), '{"cookies":[]}\n', { mode: 0o600 })
  const { deps, state } = await testDeps(root)
  state.url = 'https://creator.xiaohongshu.com/'
  state.profileJson = userInfoPayload('acc-1', '昵称甲', null)
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['account.probe']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  assert.equal(payload.sessionStatus, 'ok')
  const record = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, { sessionStatus: string; sessionSeq: number }> }
  assert.equal(record.accounts['acc-1'].sessionStatus, 'ok')
  assert.equal(record.accounts['acc-1'].sessionSeq, 1)
  await rm(root, { recursive: true, force: true })
})

test('account.probe：登录页兜底判定 expired；缺 storage_state 不开浏览器直接 expired', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const missing = await handlers['account.probe']!({ accountId: 'acc-none' }) as Record<string, unknown>
  assert.equal(missing.status, 'ready')
  assert.equal(missing.sessionStatus, 'expired')
  // 有备份但未登录（创作者中心 302 到 /login）：expired。
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'acc-exp.json'), '{"cookies":[]}\n', { mode: 0o600 })
  state.creatorRedirectsToLogin = true
  const expired = await handlers['account.probe']!({ accountId: 'acc-exp' }) as Record<string, unknown>
  assert.equal(expired.status, 'ready')
  assert.equal(expired.sessionStatus, 'expired')
  await rm(root, { recursive: true, force: true })
})

test('account.probe：缺少 accountId 稳定拒绝', async () => {
  const root = await tempRoot()
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['account.probe']!({}) as Record<string, unknown>
  assert.equal(payload.reason, 'account_id_required')
  await rm(root, { recursive: true, force: true })
})

test('account.removeLocal：清理 profile/storage_state/快照/accounts 记录，幂等', async () => {
  const root = await tempRoot()
  await writeAccounts({ version: 1, accounts: { 'acc-1': { accountId: 'acc-1' } } }, root)
  await mkdir(join(root, 'profiles', 'acc-1'), { recursive: true })
  await mkdir(join(root, 'data', 'acc-1'), { recursive: true })
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'acc-1.json'), '{"cookies":[]}\n', { mode: 0o600 })
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['account.removeLocal']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  const removed = payload.removed as Record<string, unknown>
  assert.equal(removed.profile, true)
  assert.equal(removed.storageState, true)
  const record = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, unknown> }
  assert.equal(record.accounts['acc-1'], undefined)
  // 幂等：再删一次仍 ready。
  const again = await handlers['account.removeLocal']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(again.status, 'ready')
  await rm(root, { recursive: true, force: true })
})

test('account.removeLocal：锁占用即拒绝（PROFILE_BUSY），不删除任何文件', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'acc-1.json'), '{"cookies":[]}\n', { mode: 0o600 })
  const { deps } = await testDeps(root)
  const release = acquireProfileLock('acc-1')
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['account.removeLocal']!({ accountId: 'acc-1' }) as Record<string, unknown>
  release()
  assert.equal(payload.status, 'error')
  assert.equal(payload.reason, 'PROFILE_BUSY')
  assert.ok(await readFile(join(root, 'storage-state', 'acc-1.json'), 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('collect.start：单页采集完成、快照落盘、摘要聚合', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  // 驱动假页面：两页响应（第 1 页 1 条 + 下一页；第 2 页空终止），先于 start 注入。
  state.postedResponses.push(postedPage([{ id: 'n1', display_title: '一', view_count: 5, likes: 1, collected_count: 0, comments_count: 0, shared_count: 0, visible_time: 1700000000, type: 'video', images_list: [{ url: 'https://img.example/1.jpg' }] }], 1))
  state.postedResponses.push(postedPage([], null))
  const payload = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-collect-1' }) as Record<string, unknown>
  assert.equal(payload.status, 'started')
  assert.equal((payload.collect as Record<string, unknown>).collectStatus, 'running')
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['collect.status']!({ collectId: String(payload.collectId) }) as Record<string, unknown>
  const collect = status.collect as Record<string, unknown>
  assert.equal(status.status, 'ready')
  assert.equal(collect.collectStatus, 'completed')
  assert.equal(collect.pagesDone, 2)
  assert.equal(collect.notesTotal, 1)
  const summary = collect.summary as Record<string, unknown>
  assert.deepEqual(summary.totals, { plays: 5, likes: 1, collects: 0, comments: 0, shares: 0 })
  // 采集完成回写 lastCollectedAt。
  const accounts = await readFile(join(root, 'accounts.json'), 'utf8')
  assert.ok(accounts.includes('"lastCollectedAt"'))
  await rm(root, { recursive: true, force: true })
})

test('collect.start：幂等键重放既有 run；缺键稳定拒绝', async () => {
  const root = await tempRoot()
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const missing = await handlers['collect.start']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(missing.status, 'error')
  assert.equal(missing.reason, 'idempotency_key_required')
  const first = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  const replay = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(replay.collectId, first.collectId)
  await deps.taskRegistry.awaitSettled()
  await rm(root, { recursive: true, force: true })
})

test('collect.start：profile 锁占用时同账号操作即拒绝（即时占语义）', async () => {
  const root = await tempRoot()
  const { deps } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  const release = acquireProfileLock('acc-1')
  assert.ok(isProfileLocked('acc-1'))
  const probe = await handlers['account.probe']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(probe.reason, 'PROFILE_BUSY')
  const start = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(start.status, 'error')
  assert.equal(start.reason, 'PROFILE_BUSY')
  release()
  const status = await handlers['collect.status']!({ collectId: 'col-unknown' }) as Record<string, unknown>
  assert.equal(status.status, 'error')
  assert.equal(status.reason, 'collect_id_required')
  await deps.taskRegistry.awaitSettled()
  await rm(root, { recursive: true, force: true })
})

test('collect.start：会话失效收敛 SESSION_EXPIRED（登录框可见），run 落 failed', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.loginBoxVisible = true
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['collect.status']!({ collectId: String(payload.collectId) }) as Record<string, unknown>
  const collect = status.collect as Record<string, unknown>
  assert.equal(collect.collectStatus, 'failed')
  assert.equal(collect.error, 'SESSION_EXPIRED')
  await rm(root, { recursive: true, force: true })
})

test('稳定码白名单包含路由码与本地码（错误契约锁定）', () => {
  for (const code of ['XHS_ROUTE_UNKNOWN_ACTION', 'XHS_ROUTE_INVALID_REQUEST', 'XHS_ROUTE_PAYLOAD_TOO_LARGE', 'PROFILE_BUSY', 'SESSION_EXPIRED', 'CAPTCHA_DETECTED', 'LOGIN_TIMEOUT', 'COLLECT_FAILED', 'PROBE_FAILED', 'xhs_operation_request_failed']) {
    assert.ok((STABLE_ERROR_CODES as readonly string[]).includes(code), `missing ${code}`)
  }
})

// --- hotboard settings 读/写对（D-3：UI 只读，action 保留并测） ---

test('hotboard.settings：读投影透传 data/meta，白名单外错误码收敛', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [{ structuredContent: { data: { scheduleEnabled: true, publishWindowDays: 30 }, meta: null } }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['hotboard.settings']!({}) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  const data = payload.data as Record<string, unknown>
  assert.equal(data.scheduleEnabled, true)
  assert.equal(workbench.calls[0]?.name, 'workbench_xhs_hotboard_settings_get')
  // 白名单外错误码 → XHS_HOTBOARD_INTERNAL_ERROR，不透传原文。
  const bad = createFakeWorkbench({ outcomes: [{ structuredContent: { error: { code: 'XHS_HOTBOARD_SOMETHING_NEW' } } }] })
  const deps2 = createXhsHostDeps({
    root, workbench: bad.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers2 = buildRouteHandlers(deps2)
  const failed = await handlers2['hotboard.settings']!({}) as Record<string, unknown>
  assert.equal(failed.status, 'error')
  assert.equal(failed.reason, 'XHS_HOTBOARD_INTERNAL_ERROR')
  await rm(root, { recursive: true, force: true })
})

test('hotboard.settingsUpdate：确定性校验前置不烧键（confirm/幂等键/settings 白名单）', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench()
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  // confirm 非显式 true → confirmation_required（400 语义走 200 + status error）。
  const noConfirm = await handlers['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: true }, idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(noConfirm.status, 'error')
  assert.equal(noConfirm.reason, 'confirmation_required')
  // 幂等键缺失 → idempotency_key_required。
  const noKey = await handlers['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: true }, confirm: true }) as Record<string, unknown>
  assert.equal(noKey.reason, 'idempotency_key_required')
  // settings 键白名单外 → XHS_HOTBOARD_INVALID_ARGUMENT。
  const unknownKey = await handlers['hotboard.settingsUpdate']!({ settings: { notASetting: 1 }, confirm: true, idempotencyKey: 'k-2' }) as Record<string, unknown>
  assert.equal(unknownKey.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  // bool 字段非布尔 → 拒绝；cron 超长 → 拒绝；空对象 → 拒绝。
  const badBool = await handlers['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: 'yes' }, confirm: true, idempotencyKey: 'k-3' }) as Record<string, unknown>
  assert.equal(badBool.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  const badCron = await handlers['hotboard.settingsUpdate']!({ settings: { fullScheduleCron: 'x'.repeat(65) }, confirm: true, idempotencyKey: 'k-4' }) as Record<string, unknown>
  assert.equal(badCron.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  const empty = await handlers['hotboard.settingsUpdate']!({ settings: {}, confirm: true, idempotencyKey: 'k-5' }) as Record<string, unknown>
  assert.equal(empty.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  // 确定性校验全部失败：Workbench 未被调用（幂等键未被烧毁）。
  assert.deepEqual(workbench.calls, [])
  await rm(root, { recursive: true, force: true })
})

test('hotboard.settingsUpdate：写成功只投影受控字段，TOML 管辖错误投影稳定码', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [{ structuredContent: { ok: true, updatedCount: 1, idempotentReplay: false, internalDiag: 'secret' } }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: false }, confirm: true, idempotencyKey: 'k-run-1' }) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  assert.equal(payload.ok, true)
  assert.equal(payload.updatedCount, 1)
  assert.equal(payload.idempotentReplay, false)
  assert.equal('internalDiag' in payload, false)
  const call = workbench.calls[0]
  assert.equal(call?.name, 'workbench_xhs_hotboard_settings_update')
  assert.deepEqual(call?.args, { settings: { scheduleEnabled: false }, confirm: true, idempotencyKey: 'k-run-1' })
  // 服务端 TOML 管辖码白名单透传。
  const toml = createFakeWorkbench({ outcomes: [{ throwCode: 'XHS_HOTBOARD_SETTING_TOML_MANAGED' }] })
  const deps2 = createXhsHostDeps({
    root, workbench: toml.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers2 = buildRouteHandlers(deps2)
  const failed = await handlers2['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: true }, confirm: true, idempotencyKey: 'k-run-2' }) as Record<string, unknown>
  assert.equal(failed.status, 'error')
  assert.equal(failed.reason, 'XHS_HOTBOARD_SETTING_TOML_MANAGED')
  await rm(root, { recursive: true, force: true })
})

test('hotboard.settingsUpdate：路由 schema 拒绝非对象 settings 与未知字段', () => {
  assert.throws(() => validateActionArgs('hotboard.settingsUpdate', { settings: 'x', confirm: true, idempotencyKey: 'k' }), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('hotboard.settingsUpdate', { settings: [1], confirm: true, idempotencyKey: 'k' }), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('hotboard.settingsUpdate', { settings: {}, confirm: true, idempotencyKey: 'k', extra: 1 }), (error: unknown) =>
    error instanceof XhsError && error.code === 'XHS_ROUTE_INVALID_REQUEST')
})
