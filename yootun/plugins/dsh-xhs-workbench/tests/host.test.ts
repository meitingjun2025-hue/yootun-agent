/**
 * X1+X2 Host 基础测试：路由安全层（allowlist/schema/未知字段/体上限/同源/CSRF）、
 * action 处理器（browser/accounts/login/probe/removeLocal/collect）、本地投影
 * 与稳定错误收敛。
 * 运行：`node --test tests/host.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ACTION_SCHEMAS, MAX_BODY_BYTES, createRouteHandler, permitted, validateActionArgs } from '../src/route.ts'
import { LOCAL_ERROR_CODES, STABLE_ERROR_CODES, XhsError, safeCode } from '../src/errors.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { buildRouteHandlers, createXhsHostDeps, type XhsHostDeps } from '../src/handlers.ts'
import { writeAccounts } from '../src/state.ts'
import { Config } from '../src/index.ts'
import { createFakeChrome, createFakeWorkbench, postedPage, sessionCookie, userInfoPayload } from './fakes.ts'

/** 独立状态根目录（每用例新建，用后清理）。 */
async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-host-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

function fakeRes(responded: Array<{ status: number; payload: Record<string, unknown> }>): ServerResponse {
  let statusCode = 0
  return {
    get statusCode() { return statusCode },
    set statusCode(value: number) { statusCode = value },
    setHeader() {},
    end(payload: unknown) {
      responded.push({ status: statusCode, payload: JSON.parse(String(payload)) as Record<string, unknown> })
    },
  } as unknown as ServerResponse
}

/** 测试前置断言：即时占锁必须成功，失败的用例在此显式失败并收窄释放函数类型。 */
function mustRelease(release: (() => void) | null): () => void {
  if (release === null) throw new Error('测试前置失败：profile 锁未获取')
  return release
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

test('连接器新码显式投影与本地新码登记（2026-11-26，分册 08 §5.2）', () => {
  const workbenchError = (code: string): Error => Object.assign(new Error(`x-${code}`), { name: 'WorkbenchMcpError', code })
  // 鉴权失败投影 UNAUTHORIZED（本地新码），不再收敛到兜底码。
  assert.equal(safeCode(workbenchError('workbench_unauthorized')), 'UNAUTHORIZED')
  // 服务端故障投影兜底码（xhs 无 WX_TOOL_UNAVAILABLE 同位码）。
  assert.equal(safeCode(workbenchError('workbench_server_error')), 'xhs_operation_request_failed')
  // host_unreachable 为本地新码，白名单直通。
  assert.equal(safeCode(workbenchError('host_unreachable')), 'host_unreachable')
  assert.equal(safeCode(new XhsError('host_unreachable', 'x')), 'host_unreachable')
  for (const code of ['UNAUTHORIZED', 'host_unreachable']) {
    assert.equal((STABLE_ERROR_CODES as readonly string[]).includes(code), true, code)
  }
})

test('稳定码集合无重复元素（本地码表与去重后的全集）', () => {
  assert.equal(new Set(LOCAL_ERROR_CODES).size, LOCAL_ERROR_CODES.length)
  assert.equal(new Set(STABLE_ERROR_CODES).size, STABLE_ERROR_CODES.length)
})

test('action allowlist：白名单 30 项且全部有 schema（含 collect.cancel，XH1）', () => {
  const expected = [
    'browser.status', 'accounts.list', 'account.beginLogin', 'account.loginStatus',
    'account.probe', 'account.removeLocal', 'collect.start', 'collect.status', 'collect.cancel',
    'task.create', 'task.status', 'task.result', 'task.cancel',
    'hotboard.overview', 'hotboard.noteDetail', 'hotboard.noteTagUpdate', 'hotboard.noteExclude',
    'hotboard.keywords', 'hotboard.keywordSave', 'hotboard.runStart', 'hotboard.runGet',
    'hotboard.candidates', 'hotboard.candidateReview', 'hotboard.labels', 'hotboard.labelReview',
    'hotboard.labelSave', 'hotboard.settings',
    'hotboard.settingsUpdate',
    'publish.start', 'publish.status',
  ]
  assert.deepEqual(Object.keys(ACTION_SCHEMAS).sort(), expected.sort())
})

test('插件 Config 可解析（stateDir 缺省空串）', () => {
  assert.deepEqual(Config({}), { stateDir: '', disposeBudgetMs: 20000, browserCloseTimeoutMs: 8000, launchTimeoutMs: 60000 })
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
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ready' }) })
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
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ready' }) })
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
  assert.equal(responded.at(-1)?.payload.reason, 'method_not_allowed')
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

// --- L 系列：登录终态记录保留（mount-restore 2.3） ---

test('L2 超过 30 分钟的登录终态记录在下一次读取时被清理，返回 idle', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.cookies = sessionCookie()
  state.profileJson = userInfoPayload('real-l2', null, null)
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({}) as Record<string, unknown>
  const waiting = begin.login as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  // 回拨 settledAt 到 31 分钟前（等效时钟推进）。
  const run = deps.loginRuns.get(String(waiting.loginId))
  assert.ok(run !== undefined)
  run.settledAt = Date.now() - 31 * 60 * 1000
  if (run.accountId !== null && run.accountId !== run.key) {
    const mapped = deps.loginRuns.get(run.accountId)
    if (mapped !== undefined) mapped.settledAt = run.settledAt
  }
  const status = await handlers['account.loginStatus']!({ loginId: String(waiting.loginId) }) as Record<string, unknown>
  assert.equal((status.login as Record<string, unknown>).status, 'idle', '过期终态被清理 → idle')
  assert.equal(deps.loginRuns.size, 0, '过期记录的键全部清理')
  await rm(root, { recursive: true, force: true })
})

test('L3 dispose 后登录记录表为空', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.cookies = sessionCookie()
  state.profileJson = userInfoPayload('real-l3', null, null)
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({}) as Record<string, unknown>
  assert.equal(begin.status, 'ready')
  await deps.taskRegistry.awaitSettled()
  assert.ok(deps.loginRuns.size > 0)
  await disposeHostTasks({ deps }, { disposeBudgetMs: 5000 })
  assert.equal(deps.loginRuns.size, 0, '登录记录表随卸载清空')
  await rm(root, { recursive: true, force: true })
})

test('L4 pending 键与 resolvedId 指向同一条记录时同时清理', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  state.cookies = sessionCookie()
  state.profileJson = userInfoPayload('real-l4', null, null)
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({}) as Record<string, unknown>
  const waiting = begin.login as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  const run = deps.loginRuns.get(String(waiting.loginId))
  assert.ok(run !== undefined)
  assert.ok(run.accountId !== null && run.accountId !== run.key, 'pending 键与 resolvedId 双映射存在')
  // 回拨后清理：两个键同时消失。
  run.settledAt = Date.now() - 31 * 60 * 1000
  const status = await handlers['account.loginStatus']!({ accountId: 'real-l4' }) as Record<string, unknown>
  assert.equal((status.login as Record<string, unknown>).status, 'idle')
  assert.equal(deps.loginRuns.has(String(waiting.loginId)), false, 'pending 键清理')
  assert.equal(deps.loginRuns.has('real-l4'), false, 'resolvedId 键清理')
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
  // 2.3 终态保留 30 分钟：保留期内重复读取结果一致（不再读完即删）。
  const again = await handlers['account.loginStatus']!({ loginId: 'real-id' }) as Record<string, unknown>
  assert.equal((again.login as Record<string, unknown>).status, 'ok')
  assert.equal((again.login as Record<string, unknown>).accountId, 'real-id')
  // 账号记录 ok + storage_state 备份落盘。
  const record = JSON.parse(await readFile(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, { sessionStatus: string }> }
  const savedRow = record.accounts['real-id']
  assert.ok(savedRow !== undefined, 'real-id 已落盘')
  assert.equal(savedRow.sessionStatus, 'ok')
  assert.ok(await readFile(join(root, 'storage-state', 'real-id.json'), 'utf8'))
  await rm(root, { recursive: true, force: true })
})

test('account.beginLogin：waiting 幂等复用；login 运行中同账号 probe 返回 PROFILE_BUSY', async () => {
  const root = await tempRoot()
  const { deps } = await testDeps(root)
  // cookie 一直不出现 → 等待态保持到超时。
  const handlers = buildRouteHandlers(deps)
  const first = await handlers['account.beginLogin']!({ accountId: 'acc-1' }) as Record<string, unknown>
  const second = await handlers['account.beginLogin']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal((first.login as Record<string, unknown>).loginId, (second.login as Record<string, unknown>).loginId)
  assert.ok(deps.locks.isProfileLocked('acc-1'))
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
  const release = mustRelease(deps.locks.acquireProfileLock('real-id'))
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
  await handlers['account.beginLogin']!({ accountId: 'acc-timeout' })
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
  const savedRow = record.accounts['acc-1']
  assert.ok(savedRow !== undefined, 'acc-1 已落盘')
  assert.equal(savedRow.sessionStatus, 'ok')
  assert.equal(savedRow.sessionSeq, 1)
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
  const release = mustRelease(deps.locks.acquireProfileLock('acc-1'))
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

// --- X 系列：collect.status 按账号查询、终态保留与清理（mount-restore 2.1/2.2） ---

test('X1 按账号查询：运行中返回该 run；只有终态且在保留期内返回终态 run；无则 collect null', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps) as Record<string, (args: Record<string, string>) => Promise<Record<string, unknown>>>
  // 先完成一次采集：账号索引指向已完成的终态 run。
  state.postedResponses.push(postedPage([{ id: 'n-x1', display_title: '一', view_count: 1, likes: 0, collected_count: 0, comments_count: 0, shared_count: 0, visible_time: 1700000000, type: 'video', images_list: [] }], 1))
  state.postedResponses.push(postedPage([], null))
  const started = await handlers['collect.start']!({ accountId: 'acc-x1', idempotencyKey: 'k-x1' })
  assert.equal(started.status, 'started')
  await deps.taskRegistry.awaitSettled()
  const byAccount = await handlers['collect.status']!({ accountId: 'acc-x1' })
  assert.equal(byAccount.status, 'ready')
  const collect = byAccount.collect as Record<string, unknown>
  assert.notEqual(collect, null, '保留期内的终态 run 按账号返回')
  assert.equal(collect.collectStatus, 'completed')
  // 无记录账号 → collect: null。
  const missing = await handlers['collect.status']!({ accountId: 'acc-none' })
  assert.equal(missing.collect, null)
  await rm(root, { recursive: true, force: true })
})

test('X2 两者都缺 → collect_id_required；同时给且不一致 → 以 collectId 为准', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps) as Record<string, (args: Record<string, string>) => Promise<Record<string, unknown>>>
  const missing = await handlers['collect.status']!({})
  assert.equal(missing.status, 'error')
  assert.equal(missing.reason, 'collect_id_required')
  state.postedResponses.push(postedPage([], null))
  const started = await handlers['collect.start']!({ accountId: 'acc-x2', idempotencyKey: 'k-x2' })
  const collectId = String(started.collectId)
  const both = await handlers['collect.status']!({ collectId, accountId: 'acc-other' })
  assert.equal(both.status, 'ready')
  assert.notEqual(both.collect, null, '以 collectId 为准')
  await deps.taskRegistry.awaitSettled()
  await rm(root, { recursive: true, force: true })
})

test('X3 终态 run 30 分钟后在下一次 collect.start / collect.status 被清理；运行中的不清理', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps) as Record<string, (args: Record<string, string>) => Promise<Record<string, unknown>>>
  state.postedResponses.push(postedPage([], null))
  const started = await handlers['collect.start']!({ accountId: 'acc-x3', idempotencyKey: 'k-x3' })
  const collectId = String(started.collectId)
  await deps.taskRegistry.awaitSettled()
  // 回拨 settledAt（等效时钟推进 31 分钟）。
  const run = deps.collectRuns.get(collectId)
  assert.ok(run !== undefined)
  run.settledAt = Date.now() - 31 * 60 * 1000
  // collect.status 入口触发清理。
  const status = await handlers['collect.status']!({ accountId: 'acc-x3' })
  assert.equal(status.collect, null, '过期终态 run 已清理')
  assert.equal(deps.collectRuns.has(collectId), false)
  assert.equal(deps.collectIdempotency.has('k-x3'), false, '幂等映射同步清理')
  assert.equal(deps.collectLatestByAccount.has('acc-x3'), false, '账号索引同步清理')
  // 运行中的不清理：再造一个 run（sweep 后幂等映射已清，用新键）。
  state.postedResponses.push(postedPage([], null))
  const running = await handlers['collect.start']!({ accountId: 'acc-x3', idempotencyKey: 'k-x3b' })
  const runningId = String(running.collectId)
  assert.equal(deps.collectRuns.get(runningId)?.status, 'running')
  await deps.taskRegistry.awaitSettled()
  await rm(root, { recursive: true, force: true })
})

test('X4 同一账号先后两次采集，按账号查询返回后一次', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps) as Record<string, (args: Record<string, string>) => Promise<Record<string, unknown>>>
  state.postedResponses.push(postedPage([], null))
  const first = await handlers['collect.start']!({ accountId: 'acc-x4', idempotencyKey: 'k-x4a' })
  await deps.taskRegistry.awaitSettled()
  state.postedResponses.push(postedPage([], null))
  const second = await handlers['collect.start']!({ accountId: 'acc-x4', idempotencyKey: 'k-x4b' })
  await deps.taskRegistry.awaitSettled()
  const byAccount = await handlers['collect.status']!({ accountId: 'acc-x4' })
  const collect = byAccount.collect as Record<string, unknown> | null
  assert.notEqual(collect, null)
  assert.equal(collect?.collectId, String(second.collectId), '索引指向后一次 run')
  assert.notEqual(String(first.collectId), String(second.collectId))
  await rm(root, { recursive: true, force: true })
})

test('X5 dispose 后 collectRuns / collectIdempotency / 账号索引为空', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps) as Record<string, (args: Record<string, string>) => Promise<Record<string, unknown>>>
  state.postedResponses.push(postedPage([], null))
  await handlers['collect.start']!({ accountId: 'acc-x5', idempotencyKey: 'k-x5' })
  await deps.taskRegistry.awaitSettled()
  assert.ok(deps.collectRuns.size > 0)
  await disposeHostTasks({ deps }, { disposeBudgetMs: 5000 })
  assert.equal(deps.collectRuns.size, 0)
  assert.equal(deps.collectIdempotency.size, 0)
  assert.equal(deps.collectLatestByAccount.size, 0)
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
  const release = mustRelease(deps.locks.acquireProfileLock('acc-1'))
  assert.ok(deps.locks.isProfileLocked('acc-1'))
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

test('collect.start：会话失效收敛 SESSION_EXPIRED（登录框可见），run 落 failed（XH4：非取消失败不被误判为取消）', async () => {
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
  assert.notEqual(collect.collectStatus, 'cancelled')
  await rm(root, { recursive: true, force: true })
})

test('collect.cancel：运行中取消落 cancelled/collect_cancelled，锁释放，abort 后迟到失败不改写（XH2）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  // 挂起的 Chrome 启动让采集停在 running，给取消留窗口；释放后按会话失效抛
  // 带码 CollectError——取消判定只认本 run 的 abort，迟到失败不得改判。
  fake.state.loginBoxVisible = true
  const gate = Promise.withResolvers<void>()
  const deps = createXhsHostDeps({
    root,
    workbench: createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: async () => {
      await gate.promise
      return { context: fake.context }
    },
  })
  const handlers = buildRouteHandlers(deps)
  const started = await handlers['collect.start']!({ accountId: 'acc-x', idempotencyKey: 'k-x1' }) as Record<string, unknown>
  assert.equal(started.status, 'started')
  assert.ok(deps.locks.isProfileLocked('acc-x'))
  const cancel = await handlers['collect.cancel']!({ collectId: String(started.collectId) }) as Record<string, unknown>
  assert.equal(cancel.status, 'ready')
  assert.equal((cancel.collect as Record<string, unknown>).collectStatus, 'cancelled')
  assert.equal((cancel.collect as Record<string, unknown>).error, 'collect_cancelled')
  // 释放挂起的启动：collectNotes 抛 SESSION_EXPIRED，catch 保持取消终态。
  gate.resolve()
  await deps.taskRegistry.awaitSettled()
  const status = await handlers['collect.status']!({ collectId: String(started.collectId) }) as Record<string, unknown>
  const collect = status.collect as Record<string, unknown>
  assert.equal(collect.collectStatus, 'cancelled')
  assert.equal(collect.error, 'collect_cancelled')
  // 锁随采集 promise 的 finally 释放：账号可立即再次采集。
  const release = mustRelease(deps.locks.acquireProfileLock('acc-x'))
  release()
  await rm(root, { recursive: true, force: true })
})

test('collect.cancel：取消时不写本次快照、不回写最近采集时间（XH2）', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  // 会话一直失效且启动挂起：取消后收敛，全程不应有快照落盘。
  fake.state.loginBoxVisible = true
  const gate = Promise.withResolvers<void>()
  const deps = createXhsHostDeps({
    root,
    workbench: createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: async () => {
      await gate.promise
      return { context: fake.context }
    },
  })
  const handlers = buildRouteHandlers(deps)
  const started = await handlers['collect.start']!({ accountId: 'acc-snap', idempotencyKey: 'k-s1' }) as Record<string, unknown>
  const cancel = await handlers['collect.cancel']!({ collectId: String(started.collectId) }) as Record<string, unknown>
  assert.equal((cancel.collect as Record<string, unknown>).collectStatus, 'cancelled')
  gate.resolve()
  await deps.taskRegistry.awaitSettled()
  const dataDir = join(root, 'data', 'acc-snap')
  const entries = await readdir(dataDir).catch(() => [] as string[])
  assert.equal(entries.filter(name => name.startsWith('notes-')).length, 0, '取消不得写入快照文件')
  const accountsRaw = await readFile(join(root, 'accounts.json'), 'utf8').catch(() => '')
  assert.equal(accountsRaw.includes('lastCollectedAt'), false, '取消不得回写最近采集时间')
  await rm(root, { recursive: true, force: true })
})

test('collect.cancel：终态后取消不改写；未知 id 与 collect.status 同口径（XH3）', async () => {
  const root = await tempRoot()
  const { deps, state } = await testDeps(root)
  const handlers = buildRouteHandlers(deps)
  // 自然完成：completed 后取消原样返回既有终态，不改写为 cancelled。
  state.postedResponses.push(postedPage([{ id: 'n1', display_title: '一' }], null))
  const started = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-c1' }) as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  const cancel = await handlers['collect.cancel']!({ collectId: String(started.collectId) }) as Record<string, unknown>
  assert.equal(cancel.status, 'ready')
  const collect = cancel.collect as Record<string, unknown>
  assert.equal(collect.collectStatus, 'completed')
  assert.notEqual(collect.error, 'collect_cancelled')
  // 自然失败：failed 后取消同样不改写。
  state.loginBoxVisible = true
  const failedStart = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-c2' }) as Record<string, unknown>
  await deps.taskRegistry.awaitSettled()
  const failedCancel = await handlers['collect.cancel']!({ collectId: String(failedStart.collectId) }) as Record<string, unknown>
  assert.equal((failedCancel.collect as Record<string, unknown>).collectStatus, 'failed')
  assert.equal((failedCancel.collect as Record<string, unknown>).error, 'SESSION_EXPIRED')
  // 未知 id：collect_id_required（与 collect.status 同口径）。
  const unknown = await handlers['collect.cancel']!({ collectId: 'col-none' }) as Record<string, unknown>
  assert.equal(unknown.status, 'error')
  assert.equal(unknown.reason, 'collect_id_required')
  await rm(root, { recursive: true, force: true })
})

test('accounts.list：running 发布 run 投影 publishWindowOpen，终态/无 run 为 false（XH5）', async () => {
  const root = await tempRoot()
  await writeAccounts({
    version: 1,
    accounts: { 'acc-open': { accountId: 'acc-open' }, 'acc-closed': { accountId: 'acc-closed' } },
  }, root)
  const { deps } = await testDeps(root)
  const release = (): void => undefined
  deps.publishRuns.set('pub-open', { publishId: 'pub-open', accountId: 'acc-open', status: 'running', step: 'open', error: null, release })
  deps.publishRuns.set('pub-done', { publishId: 'pub-done', accountId: 'acc-closed', status: 'completed', step: 'done', error: null, release })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['accounts.list']!({}) as Record<string, unknown>
  const accounts = payload.accounts as Array<Record<string, unknown>>
  const open = accounts.find(account => account.accountId === 'acc-open')
  const closed = accounts.find(account => account.accountId === 'acc-closed')
  assert.equal(open?.publishWindowOpen, true)
  assert.equal(closed?.publishWindowOpen, false)
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

// ---- 看板 12 action（X5；枚举/清洗/写前置，旧 hotboardArgs 同口径）----

test('hotboard.overview：缺省 window=30d、枚举外与评分区间越界拒绝、筛选透传', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [{ structuredContent: { data: { kpis: { totalCases: 3 } }, meta: { total: 3 } } }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['hotboard.overview']!({ window: '90d', keyword: '车衣', scoreMin: 60, onlyMain: true }) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  assert.deepEqual((payload.data as Record<string, unknown>).kpis, { totalCases: 3 })
  assert.deepEqual(workbench.calls[0]?.args, { window: '90d', keyword: '车衣', scoreMin: 60, onlyMain: true })
  // 缺省 window=30d；枚举外 → INVALID_ARGUMENT（face 未调用）。
  await handlers['hotboard.overview']!({})
  assert.deepEqual((workbench.calls[1]?.args as Record<string, unknown>).window, '30d')
  const badSort = await handlers['hotboard.overview']!({ sort: 'bogus' }) as Record<string, unknown>
  assert.equal(badSort.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  const badScore = await handlers['hotboard.overview']!({ scoreMin: 101 }) as Record<string, unknown>
  assert.equal(badScore.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  assert.equal(workbench.calls.length, 2)
  await rm(root, { recursive: true, force: true })
})

test('hotboard 写前置：confirm/幂等键确定性失败不烧键；op→action 映射', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [{ structuredContent: { ok: true, updatedCount: 1, idempotentReplay: false } }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const noConfirm = await handlers['hotboard.noteTagUpdate']!({ noteId: 'n1', tagType: 'style', labelCode: 'c1' }) as Record<string, unknown>
  assert.equal(noConfirm.reason, 'confirmation_required')
  const noKey = await handlers['hotboard.noteTagUpdate']!({ noteId: 'n1', tagType: 'style', labelCode: 'c1', confirm: true }) as Record<string, unknown>
  assert.equal(noKey.reason, 'idempotency_key_required')
  const badTag = await handlers['hotboard.noteTagUpdate']!({ noteId: 'n1', tagType: 'bogus', labelCode: 'c1', confirm: true, idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(badTag.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  assert.deepEqual(workbench.calls.length, 0)
  const ok = await handlers['hotboard.noteTagUpdate']!({ noteId: 'n1', tagType: 'style', labelCode: 'c1', confirm: true, idempotencyKey: 'k-2' }) as Record<string, unknown>
  assert.equal(ok.status, 'ready')
  assert.deepEqual(workbench.calls[0]?.args, { noteId: 'n1', tagType: 'style', labelCode: 'c1', confirm: true, idempotencyKey: 'k-2' })
  // keywordSave/candidateReview/labelReview 的子动作走 op → action。
  await handlers['hotboard.keywordSave']!({ op: 'create', keyword: '车衣', category: 'product', confirm: true, idempotencyKey: 'k-3' })
  assert.deepEqual((workbench.calls.at(-1)?.args as Record<string, unknown>).action, 'create')
  await handlers['hotboard.candidateReview']!({ op: 'accepted', candidateIds: ['aaaa1111-1111-1111-1111-111111111111'], confirm: true, idempotencyKey: 'k-4' })
  const review = workbench.calls.at(-1)?.args as Record<string, unknown>
  assert.equal(review.action, 'accepted')
  assert.deepEqual(review.candidateIds, ['aaaa1111-1111-1111-1111-111111111111'])
  // 非法 id 拒绝且不烧键。
  const before = workbench.calls.length
  await handlers['hotboard.candidateReview']!({ op: 'rejected', candidateIds: ['not hex!'], confirm: true, idempotencyKey: 'k-5' })
  assert.equal(workbench.calls.length, before)
  // labelSave 别名透传（schema 档位 20×128）。
  await handlers['hotboard.labelSave']!({ tagType: 'style', code: 'jss', name: '竞技风', aliases: ['竞技', '竞速'], confirm: true, idempotencyKey: 'k-6' })
  const save = workbench.calls.at(-1)?.args as Record<string, unknown>
  assert.deepEqual(save.aliases, ['竞技', '竞速'])
  await rm(root, { recursive: true, force: true })
})

test('hotboard 读投影：keywords/candidates/labels/runGet 透传 data+meta；candidates 日期区间', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [
    { structuredContent: { data: { keywords: [{ keywordId: 'aaaa1111-1111-1111-1111-111111111111', keyword: '车衣', status: 'active' }] }, meta: { total: 1 } } },
    { structuredContent: { data: { candidates: [] }, meta: { total: 0 } } },
    { structuredContent: { data: { candidates: [] }, meta: { total: 0 } } },
    { structuredContent: { data: { run: { runId: 'r1', status: 'queued' } }, meta: null } },
  ] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const keywords = await handlers['hotboard.keywords']!({ status: 'active', page: 2, pageSize: 20 }) as Record<string, unknown>
  assert.equal(keywords.status, 'ready')
  assert.equal(workbench.calls[0]?.name, 'workbench_xhs_hotboard_keywords_list')
  assert.deepEqual(workbench.calls[0]?.args, { status: 'active', page: 2, pageSize: 20 })
  await handlers['hotboard.candidates']!({ status: 'pending', dateFrom: '2026-11-01', dateTo: '2026-11-20' })
  assert.deepEqual((workbench.calls[1]?.args as Record<string, unknown>).dateRange, ['2026-11-01', '2026-11-20'])
  // 起止只填一个不透传；格式非法拒绝。
  await handlers['hotboard.candidates']!({ dateFrom: '2026-11-01' })
  assert.equal((workbench.calls[2]?.args as Record<string, unknown>).dateRange, undefined)
  const badDate = await handlers['hotboard.candidates']!({ dateFrom: '2026-11-1', dateTo: '2026-11-20' }) as Record<string, unknown>
  assert.equal(badDate.reason, 'XHS_HOTBOARD_INVALID_ARGUMENT')
  const run = await handlers['hotboard.runGet']!({}) as Record<string, unknown>
  assert.equal(workbench.calls.at(-1)?.name, 'workbench_xhs_hotboard_run_get')
  assert.deepEqual(run.data, { run: { runId: 'r1', status: 'queued' } })
  await rm(root, { recursive: true, force: true })
})

// ---- publish（X6；旧 index.js handlePublishStart/handlePublishStatus 同口径）----

test('publish.start：确定性校验（target 枚举/幂等键）与成功 started 投影', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.profileJson = userInfoPayload('acc-1', '甲', null)
  const deps = createXhsHostDeps({
    root, workbench: createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: fake.factory,
  })
  const handlers = buildRouteHandlers(deps)
  const badTarget = await handlers['publish.start']!({ accountId: 'acc-1', target: 'audio', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(badTarget.reason, 'invalid_target')
  const noKey = await handlers['publish.start']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(noKey.reason, 'idempotency_key_required')
  // 会话 ok（user/info 探测主口径）→ completed + step done；浏览器保持打开（closeCount 0）。
  const started = await handlers['publish.start']!({ accountId: 'acc-1', target: 'video', idempotencyKey: 'k-2' }) as Record<string, unknown>
  assert.equal(started.status, 'started')
  const publish = started.publish as Record<string, unknown>
  assert.equal(publish.publishStatus, 'running')
  // 幂等重放：同键返回既有 publishId。
  const replay = await handlers['publish.start']!({ accountId: 'acc-1', target: 'video', idempotencyKey: 'k-2' }) as Record<string, unknown>
  assert.equal(replay.publishId, started.publishId)
  // 发布 run 为后台动作（浏览器保持打开，不进任务登记表）：轮询至终态。
  let done: Record<string, unknown> = {}
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setTimeout(resolve, 20))
    const status = await handlers['publish.status']!({ publishId: String(started.publishId) }) as Record<string, unknown>
    done = status.publish as Record<string, unknown>
    if (done.publishStatus !== 'running') break
  }
  assert.equal(done.publishStatus, 'completed')
  assert.equal(done.step, 'done')
  assert.equal(fake.state.closeCount, 0, '红线：任何结局浏览器保持打开')
  // 状态查询未知 id → publish_id_required。
  const unknown = await handlers['publish.status']!({ publishId: 'pub-none' }) as Record<string, unknown>
  assert.equal(unknown.reason, 'publish_id_required')
  await rm(root, { recursive: true, force: true })
})

test('publish.start：会话过期投影 SESSION_EXPIRED；profile 锁占用即拒绝', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(join(root, 'storage-state', 'acc-exp.json'), '{"cookies":[]}\n', { mode: 0o600 })
  const fake = createFakeChrome()
  fake.state.creatorRedirectsToLogin = true
  const deps = createXhsHostDeps({
    root, workbench: createFakeWorkbench().face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: fake.factory,
  })
  const handlers = buildRouteHandlers(deps)
  const started = await handlers['publish.start']!({ accountId: 'acc-exp', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(started.status, 'started')
  let failed: Record<string, unknown> = {}
  for (let i = 0; i < 150; i++) {
    await new Promise(resolve => setTimeout(resolve, 50))
    const status = await handlers['publish.status']!({ publishId: String(started.publishId) }) as Record<string, unknown>
    failed = status.publish as Record<string, unknown>
    if (failed.publishStatus !== 'running') break
  }
  assert.equal(failed.publishStatus, 'failed')
  assert.equal(failed.error, 'SESSION_EXPIRED')
  // 锁占用即拒绝（发布浏览器保持打开 → 锁随 context close 释放，测试里 close
  // 未触发所以锁仍被本发布 run 持有；锁实例随 deps，断言不再依赖跨用例残留）。
  assert.equal(deps.locks.acquireProfileLock('acc-exp'), null)
  const busy = await handlers['publish.start']!({ accountId: 'acc-exp', idempotencyKey: 'k-2' }) as Record<string, unknown>
  assert.equal(busy.reason, 'PROFILE_BUSY')
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

// --- task 四项（X4；真实 schema 按基线清单 §3 对账表） ---

test('task.create：images/video 参数投影、确定性校验失败稳定拒绝', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [{ structuredContent: { taskId: 'xhst-1', status: 'queued' } }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  // 非法媒体类型 / 缺幂等键 / images 缺 URL / video 缺 URL。
  const badType = await handlers['task.create']!({ mediaType: 'text', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(badType.reason, 'invalid_media_type')
  const noKey = await handlers['task.create']!({ mediaType: 'images' }) as Record<string, unknown>
  assert.equal(noKey.reason, 'idempotency_key_required')
  const noImages = await handlers['task.create']!({ mediaType: 'images', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(noImages.reason, 'image_urls_required')
  const noVideo = await handlers['task.create']!({ mediaType: 'video', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(noVideo.reason, 'video_url_required')
  assert.deepEqual(workbench.calls.length, 0)
  // images 成功：versionCount 固定 1、coverIndex 0、对标投影 {source:'manual',url}/{name}。
  const created = await handlers['task.create']!({
    mediaType: 'images', idempotencyKey: 'k-2', theme: ' 主题 ', direction: '方向',
    refNote: 'https://xhslink.example/n1', refAccount: '甲', imageUrls: ['https://cdn.example/1.jpg'],
  }) as Record<string, unknown>
  assert.equal(created.status, 'created')
  assert.equal(created.taskId, 'xhst-1')
  assert.equal(created.versionCount, 1)
  const call = workbench.calls[0]
  assert.equal(call?.name, 'workbench_xhs_task_create')
  assert.deepEqual(call?.args, {
    mediaType: 'images', confirm: true, references: [{ source: 'manual', url: 'https://xhslink.example/n1' }],
    accounts: [{ name: '甲' }], versionCount: 1, idempotencyKey: 'k-2',
    theme: '主题', direction: '方向', imageUrls: ['https://cdn.example/1.jpg'], coverIndex: 0,
  })
  // video 成功：videoUnderstanding 透传。
  workbench.calls.length = 0
  const video = createFakeWorkbench({ outcomes: [{ structuredContent: { taskId: 'xhst-2', status: 'queued' } }] })
  const deps2 = createXhsHostDeps({
    root, workbench: video.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers2 = buildRouteHandlers(deps2)
  const createdVideo = await handlers2['task.create']!({
    mediaType: 'video', idempotencyKey: 'k-3', videoUrl: 'https://cdn.example/v.mp4', videoUnderstanding: true,
  }) as Record<string, unknown>
  assert.equal(createdVideo.status, 'created')
  assert.deepEqual(video.calls[0]?.args, {
    mediaType: 'video', confirm: true, references: [], accounts: [], versionCount: 1,
    idempotencyKey: 'k-3', videoUrl: 'https://cdn.example/v.mp4', videoUnderstanding: true,
  })
  // 服务端无 taskId → create_failed_no_task。
  const empty = createFakeWorkbench({ outcomes: [{ structuredContent: {} }] })
  const deps3 = createXhsHostDeps({
    root, workbench: empty.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers3 = buildRouteHandlers(deps3)
  const noTask = await handlers3['task.create']!({ mediaType: 'images', idempotencyKey: 'k-4', imageUrls: ['https://cdn.example/1.jpg'] }) as Record<string, unknown>
  assert.equal(noTask.status, 'error')
  assert.equal(noTask.reason, 'create_failed_no_task')
  await rm(root, { recursive: true, force: true })
})

test('task.create：服务端任务链业务错误经 face 抛出后收敛为稳定 reason（route 层）', async () => {
  const root = await tempRoot()
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const workbench = createFakeWorkbench({ outcomes: [{ throwCode: 'IDEMPOTENCY_CONFLICT' }] })
  const deps = createXhsHostDeps({
    root, workbench: workbench.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', buildRouteHandlers(deps))
  await handler(fakeReq({ action: 'task.create', mediaType: 'images', idempotencyKey: 'k-1', imageUrls: ['https://cdn.example/1.jpg'] }), fakeRes(responded))
  assert.equal(responded[0]?.status, 200)
  assert.equal(responded[0]?.payload.reason, 'IDEMPOTENCY_CONFLICT')
  await rm(root, { recursive: true, force: true })
})

test('task.status / task.result / task.cancel：投影与版本数契约', async () => {
  const root = await tempRoot()
  const workbench = createFakeWorkbench({ outcomes: [
    { structuredContent: { taskId: 'xhst-1', status: 'running', currentStep: 'copywriting', steps: [{ step: 'ingest', status: 'succeeded' }, { step: '', status: 'x' }, { step: 'asr', status: 'failed', errorCode: 'asr_failed', errorMessage: 'm'.repeat(600) }] } },
    { structuredContent: { status: 'succeeded', versions: [
      { version: 'A', title: 't', body: 'b', tags: ['x'], coverCopy: 'c', leadGuide: 'l', issues: ['similarity_high'], pages: [{ pageIndex: 0, copy: 'p' }] },
    ] } },
    { structuredContent: { status: 'cancel_requested' } },
  ] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const status = await handlers['task.status']!({ taskId: 'xhst-1' }) as Record<string, unknown>
  assert.equal(status.status, 'ready')
  assert.equal(status.taskStatus, 'running')
  assert.equal(status.currentStep, 'copywriting')
  const steps = status.steps as Array<Record<string, unknown>>
  assert.equal(steps.length, 2)
  assert.equal((steps[1]?.errorMessage as string).length, 512, '错误原因短语截 512')
  const result = await handlers['task.result']!({ taskId: 'xhst-1' }) as Record<string, unknown>
  assert.equal(result.status, 'ready')
  const versions = result.versions as Array<Record<string, unknown>>
  assert.equal(versions.length, 1)
  assert.deepEqual(versions[0]?.tags, ['x'])
  assert.deepEqual(versions[0]?.issues, ['similarity_high'])
  assert.deepEqual(versions[0]?.pages, [{ pageIndex: 0, copy: 'p' }])
  const cancel = await handlers['task.cancel']!({ taskId: 'xhst-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(cancel.status, 'ready')
  assert.equal(cancel.taskStatus, 'cancel_requested')
  // 缺 taskId / 缺幂等键稳定拒绝；succeeded 版本越界 → versions_unavailable。
  const noId = await handlers['task.status']!({}) as Record<string, unknown>
  assert.equal(noId.reason, 'task_id_required')
  const noKey = await handlers['task.cancel']!({ taskId: 'xhst-1' }) as Record<string, unknown>
  assert.equal(noKey.reason, 'idempotency_key_required')
  const bad = createFakeWorkbench({ outcomes: [{ structuredContent: { status: 'succeeded', versions: [] } }] })
  const deps2 = createXhsHostDeps({
    root, workbench: bad.face,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
  })
  const handlers2 = buildRouteHandlers(deps2)
  const unavailable = await handlers2['task.result']!({ taskId: 'xhst-1' }) as Record<string, unknown>
  assert.equal(unavailable.reason, 'versions_unavailable')
  assert.equal(unavailable.taskId, 'xhst-1')
  await rm(root, { recursive: true, force: true })
})

test('projectHotboardWrite：results 行级披露三键截 50，run 只投影 runId/status（旧口径）', async () => {
  const root = await tempRoot()
  const rows = Array.from({ length: 52 }, (_, index) => ({
    candidateId: `cand-${index}`,
    ok: index % 2 === 0,
    errorCode: index % 2 === 0 ? undefined : 'XHS_HOTBOARD_KEYWORD_CONFLICT',
    internalRowDiag: 'drop-me',
  }))
  const workbench = createFakeWorkbench({ outcomes: [{
    structuredContent: {
      ok: true, updatedCount: 27, idempotentReplay: false,
      results: rows,
      run: { runId: 'run-abcdef-0123456789-0123456789-0123456789-0123456789-0123456789', status: 'queued', startedAt: 'drop-me' },
      internalDiag: 'drop-me',
    },
  }] })
  const { deps } = await testDeps(root, { workbench: workbench.face })
  const handlers = buildRouteHandlers(deps)
  const payload = await handlers['hotboard.settingsUpdate']!({ settings: { scheduleEnabled: true }, confirm: true, idempotencyKey: 'k-batch' }) as Record<string, unknown>
  assert.equal(payload.status, 'ready')
  const results = payload.results as Array<Record<string, unknown>>
  assert.equal(results.length, 50)
  assert.deepEqual(results[0], { candidateId: 'cand-0', ok: true, errorCode: null })
  assert.deepEqual(results[1], { candidateId: 'cand-1', ok: false, errorCode: 'XHS_HOTBOARD_KEYWORD_CONFLICT' })
  assert.ok(results.every(row => !('internalRowDiag' in row)))
  const run = payload.run as Record<string, unknown>
  assert.equal(typeof run.runId, 'string')
  assert.ok((run.runId as string).length <= 64)
  assert.equal(run.status, 'queued')
  assert.equal('startedAt' in run, false)
  assert.equal('internalDiag' in payload, false)
  await rm(root, { recursive: true, force: true })
})
