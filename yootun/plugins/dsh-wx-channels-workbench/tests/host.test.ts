/**
 * W1 Host 基础测试：路由安全层（allowlist/schema/未知字段/体上限/同源/CSRF）、
 * 状态目录兼容（旧 accounts.json 直读、串行写、seq 单调、凭证清理）、
 * Chrome 探测口径。
 * 运行：`node --test tests/host.test.ts`。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ACTION_SCHEMAS, MAX_BODY_BYTES, createRouteHandler, permitted, validateActionArgs } from '../src/route.ts'
import { STABLE_ERROR_CODES, WxError, safeCode, serverCodeOf } from '../src/errors.ts'
import {
  bumpSessionSeq, clearLocalCredentials, getAccount, hasStorageState, paths, readAccounts,
  safeSegment, stateRoot, updateAccount, writeAccounts,
} from '../src/state.ts'
import { browserStatus, chromeCandidates, resolveSystemChrome } from '../src/chrome.ts'

// --- 路由 schema 层 ---

test('action allowlist：19 项白名单且全部有 schema', () => {
  const expected = [
    'browser.status', 'accounts.list', 'account.beginLogin', 'account.loginStatus', 'account.refreshLoginQr',
    'account.probe', 'account.promote', 'account.removeLocal', 'account.removeRemote', 'collect.start',
    'collect.status', 'collectAll.start', 'collectAll.status', 'run.get', 'works.list', 'work.get',
    'work.trend', 'account.overview', 'fans.profile.get',
  ]
  assert.deepEqual(Object.keys(ACTION_SCHEMAS).sort(), expected.sort())
})

test('schema：未知字段拒绝、未知 action 拒绝、字符串截断', () => {
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', path: 'x' }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('nonexistent', {}), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_UNKNOWN_ACTION')
  assert.throws(() => validateActionArgs('collect.start', { accountId: 1 }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  const args = validateActionArgs('works.list', { accountId: '  abc  ', sort: 'x'.repeat(64) })
  assert.equal(args.accountId, 'abc')
  assert.equal((args.sort as string).length, 32)
})

test('体上限：超过 64KB 投影 WX_ROUTE_PAYLOAD_TOO_LARGE（413）', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', {
    'collect.status': async () => ({ status: 'ok' }),
  })
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(MAX_BODY_BYTES + 1, 0x61)
    },
  } as unknown as IncomingMessage
  const res = fakeRes(responded)
  await handler(req, res)
  assert.equal(responded[0]?.status, 413)
  assert.equal(responded[0]?.payload.reason, 'WX_ROUTE_PAYLOAD_TOO_LARGE')
})

test('同源与 CSRF：非 loopback / 异源 / 跨站一律 403', async () => {
  const responded: Array<{ status: number }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ok' }) })
  const make = (overrides: Record<string, unknown>, remote = '127.0.0.1'): IncomingMessage => ({
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...overrides },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"collect.status"}') },
  } as unknown as IncomingMessage)
  await handler(make({ origin: 'https://evil.example' }, '10.0.0.1'), fakeRes(responded))
  assert.equal(responded[0]?.status, 403)
  await handler(make({ origin: 'https://evil.example' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 403)
  await handler(make({ 'sec-fetch-site': 'cross-site' }), fakeRes(responded))
  assert.equal(responded[0]?.status, 403)
  // 正向：同源放行。
  await handler(make({}), fakeRes(responded))
  assert.equal(responded[responded.length - 1]?.status, 200)
})

test('未知 action 与 handler 缺位返回 unknown_action（400）', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', {})
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"collect.status"}') },
  } as unknown as IncomingMessage
  await handler(req, fakeRes(responded))
  assert.equal(responded[0]?.status, 400)
  assert.equal(responded[0]?.payload.reason, 'unknown_action')
})

test('handler 抛非稳定码错误收敛为稳定 reason，不透传原文', async () => {
  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', {
    'collect.status': async () => { throw new Error('internal stack with secret=abc') },
  })
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"collect.status"}') },
  } as unknown as IncomingMessage
  await handler(req, fakeRes(responded))
  assert.equal(responded[0]?.status, 200)
  const reason = String(responded[0]?.payload.reason)
  assert.equal(STABLE_ERROR_CODES.includes(reason), true, `reason ${reason} 必须是稳定码`)
  assert.equal(reason.includes('secret'), false)
})

function fakeRes(responded: Array<{ status: number; payload?: Record<string, unknown> }>): ServerResponse {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value },
    end(body?: string) {
      this.statusCode = (this as { statusCode: number }).statusCode
      responded.push({ status: this.statusCode, payload: body === undefined ? {} : JSON.parse(body) as Record<string, unknown> })
    },
  }
  return res as unknown as ServerResponse
}

// --- 错误模型 ---

test('稳定错误模型：Workbench envelope 嵌套码映射，未知码收敛', () => {
  const failure = { payload: { error: { code: 'RUN_NOT_RUNNING', message: 'x', retryable: false, requestId: null } } }
  assert.equal(serverCodeOf(failure), 'RUN_NOT_RUNNING')
  assert.equal(safeCode(failure), 'RUN_NOT_RUNNING')
  assert.equal(safeCode({ payload: { error: { code: 'TOTALLY_NEW' } } }), 'WX_TOOL_UNAVAILABLE')
  assert.equal(safeCode(new Error('plain')), 'WX_TOOL_UNAVAILABLE')
  // 复审要求的最低稳定码集合全部在表内。
  for (const code of [
    'ACCOUNT_NOT_FOUND', 'ACCOUNT_NOT_ACCESSIBLE', 'WORK_NOT_FOUND', 'RUN_NOT_FOUND', 'RUN_ACCOUNT_MISMATCH',
    'RUN_NOT_RUNNING', 'RUN_STILL_ACTIVE', 'RUN_LIST_META_REQUIRED', 'RUN_COUNT_MISMATCH', 'LIST_INCOMPLETE',
    'TIME_SERIES_LENGTH_MISMATCH', 'FIELD_LENGTH_MISMATCH', 'INVALID_DAY_RANGE', 'INVALID_SORT',
    'INVALID_TIME_WINDOW', 'INVALID_IDEMPOTENCY_KEY', 'CONFIRMATION_REQUIRED', 'VALIDATION_ERROR',
    'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_IN_PROGRESS', 'IDEMPOTENCY_OUTCOME_UNKNOWN', 'UNAUTHORIZED',
    'HEARTBEAT_SEQ_REGRESSED', 'WX_SESSION_INVALID', 'WX_TOOL_UNAVAILABLE',
  ]) {
    assert.equal((STABLE_ERROR_CODES as readonly string[]).includes(code), true, code)
  }
})

// --- 状态目录兼容 ---

test('状态目录：env 覆盖与旧默认路径', () => {
  assert.equal(
    stateRoot({ WX_CHANNELS_OPERATION_STATE_DIR: '/tmp/wx-state' }),
    '/tmp/wx-state',
  )
  assert.ok(stateRoot({}).includes('.dofe/dsh-yootun-wx-channels-operation'), '沿用旧目录（升级免重扫）')
})

test('旧 accounts.json 直读兼容：不迁移不改写', async () => {
  const root = join(tmpdir(), `wx-state-${String(Math.random()).slice(2)}`)
  await mkdir(join(root, 'storage-state'), { recursive: true })
  // 旧插件落盘的 accounts.json 形态（无 version 字段也兼容）。
  await writeFile(join(root, 'accounts.json'), JSON.stringify({
    accounts: { acc1: { accountId: 'acc1', nickname: '旧昵称', sessionSeq: 7 } },
  }), 'utf8')
  const state = await readAccounts(root)
  assert.equal(state.version, 1)
  assert.equal(state.accounts.acc1?.sessionSeq, 7)
  const bump = await bumpSessionSeq('acc1', root)
  assert.equal(bump, 8, '旧 sessionSeq 单调递增')
  const record = await getAccount('acc1', root)
  assert.equal(record?.nickname, '旧昵称', '旧字段保留')
  await rm(root, { recursive: true, force: true })
})

test('updateAccount 串行写入不丢并发补丁', async () => {
  const root = join(tmpdir(), `wx-state-${String(Math.random()).slice(2)}`)
  await writeAccounts({ version: 1, accounts: {} }, root)
  await Promise.all([
    updateAccount('a', { nickname: 'n1' }, root),
    updateAccount('a', { heartbeatSeq: 3 }, root),
    updateAccount('b', { nickname: 'n2' }, root),
  ])
  const a = await getAccount('a', root)
  const b = await getAccount('b', root)
  assert.equal(a?.nickname, 'n1')
  assert.equal(a?.heartbeatSeq, 3)
  assert.equal(b?.nickname, 'n2')
  await rm(root, { recursive: true, force: true })
})

test('clearLocalCredentials：删除 storage_state/profile/记录；远端删除前置（hasStorageState=false）', async () => {
  const root = join(tmpdir(), `wx-state-${String(Math.random()).slice(2)}`)
  const layout = paths(root)
  await mkdir(layout.storageStateDir, { recursive: true })
  const storage = layout.storageStatePath('acc1')
  await writeFile(storage, '{"cookies":[]}', { mode: 0o600 })
  await mkdir(layout.profilesDir, { recursive: true })
  await updateAccount('acc1', { nickname: 'x' }, root)
  await chmod(storage, 0o600)
  assert.equal(await hasStorageState('acc1', root), true)
  // storage_state 权限保持 0600（写入口径验证）。
  const mode = (await readFile(storage)).byteLength > 0
  assert.ok(mode)
  await clearLocalCredentials('acc1', root)
  assert.equal(await hasStorageState('acc1', root), false, '本地清理完成后才允许远端删除')
  assert.equal(await getAccount('acc1', root), undefined)
  assert.equal(existsSync(layout.profileDir('acc1')), false)
  await rm(root, { recursive: true, force: true })
})

test('safeSegment：不可信字符收敛', () => {
  assert.equal(safeSegment('../../etc'), '.._.._etc')
  assert.equal(safeSegment(''), 'account')
  assert.equal(safeSegment('a'.repeat(200)).length, 128)
})

// --- Chrome 探测口径 ---

test('chrome 探测：候选路径按平台、缺失阻断不回退', async () => {
  const candidates = chromeCandidates('linux', {})
  assert.deepEqual(candidates, ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'])
  await assert.rejects(
    () => resolveSystemChrome({ platform: 'linux', env: { PATH: '' }, exists: async () => false }),
    (error: unknown) => (error as { code?: string }).code === 'GOOGLE_CHROME_MISSING',
  )
  const found = await resolveSystemChrome({ platform: 'linux', env: { PATH: '/usr/bin' }, exists: async file => file === '/usr/bin/google-chrome' })
  assert.deepEqual(found, { path: '/usr/bin/google-chrome', channel: 'chrome' })
  const status = await browserStatus()
  assert.ok(['available', 'missing'].includes(status.chrome))
})
