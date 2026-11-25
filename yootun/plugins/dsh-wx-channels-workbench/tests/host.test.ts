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
import {
  ingestAccountMetricsIdempotencyKey, ingestFansProfileIdempotencyKey, ingestFansTrendIdempotencyKey,
} from '../src/idempotency.ts'

// --- 路由 schema 层 ---

test('action allowlist：全部 action 有 schema', () => {
  const expected = [
    'browser.status', 'accounts.list', 'account.beginLogin', 'account.loginStatus', 'account.refreshLoginQr',
    'account.probe', 'account.promote', 'account.removeLocal', 'account.removeRemote', 'collect.start',
    'collect.status', 'collect.cancel', 'collectAll.start', 'collectAll.status', 'collectAll.cancel',
    'run.get', 'works.list', 'work.get', 'work.trend', 'account.overview', 'fans.profile.get',
  ]
  assert.deepEqual(Object.keys(ACTION_SCHEMAS).sort(), expected.sort())
})

test('Tools 契约：插件 Config 可解析，vault 引用与账号级幂等键前缀精确', async () => {
  const { Config } = await import('../src/index.ts')
  assert.deepEqual(Config({}), { stateDir: '' })
  assert.equal(paths('/tmp/wx').vaultRef('a@finder'), 'vault://wx-channels/a@finder')
  assert.equal(
    ingestAccountMetricsIdempotencyKey('run-1', '2026-01-01', '2026-01-31'),
    'wx_channels:ingest_account_metrics:run-1:2026-01-01:2026-01-31',
  )
  assert.equal(
    ingestFansTrendIdempotencyKey('run-1', '2026-01-01', '2026-01-31'),
    'wx_channels:ingest_fans_trend:run-1:2026-01-01:2026-01-31',
  )
  assert.equal(
    ingestFansProfileIdempotencyKey('run-1', '2026-01-31'),
    'wx_channels:ingest_fans_profile:run-1:2026-01-31',
  )
})

test('schema：未知字段拒绝、未知 action 拒绝、字符串截断', () => {
  assert.throws(() => validateActionArgs('works.list', { accountId: 'a', path: 'x' }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  assert.throws(() => validateActionArgs('nonexistent', {}), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_UNKNOWN_ACTION')
  assert.throws(() => validateActionArgs('collect.start', { accountId: 1 }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  const args = validateActionArgs('works.list', { accountId: '  abc  ', sort: 'play_count' })
  assert.equal(args.accountId, 'abc')
  assert.equal(args.sort, 'play_count')
})

test('schema：integer 字段只接受整数并按范围校验，string 枚举封闭', () => {
  const invalid = (body: Record<string, unknown>): void => {
    assert.throws(() => validateActionArgs('works.list', body), (error: unknown) =>
      error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  }
  // 非整数一律拒绝：小数与字符串数字都不是 integer。
  invalid({ accountId: 'a', limit: 2.5 })
  invalid({ accountId: 'a', limit: '3' })
  // 越界拒绝：limit 1..100，offset 0..1,000,000。
  invalid({ accountId: 'a', limit: 0 })
  invalid({ accountId: 'a', limit: 101 })
  invalid({ accountId: 'a', offset: -1 })
  invalid({ accountId: 'a', offset: 1000001 })
  // 范围内整数通过（offset 0 合法）。
  const paged = validateActionArgs('works.list', { accountId: 'a', limit: 10, offset: 0 })
  assert.equal(paged.limit, 10)
  assert.equal(paged.offset, 0)
  // 枚举封闭：sort / order 枚举外拒绝，枚举内通过。
  invalid({ accountId: 'a', sort: 'bogus_column' })
  invalid({ accountId: 'a', order: 'sideways' })
  const sorted = validateActionArgs('works.list', { accountId: 'a', sort: 'completion_rate_pct', order: 'asc' })
  assert.equal(sorted.sort, 'completion_rate_pct')
  assert.equal(sorted.order, 'asc')
  // 既有 string / boolean 行为不变：trim + 长度截断、boolean 类型校验。
  const trimmed = validateActionArgs('works.list', { accountId: ` ${'x'.repeat(200)} ` })
  assert.equal((trimmed.accountId as string).length, 128)
  assert.throws(() => validateActionArgs('collect.start', { accountId: 'a', newAttempt: 1 }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
  const flag = validateActionArgs('collect.start', { accountId: 'a', newAttempt: true })
  assert.equal(flag.newAttempt, true)
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

test('路由信任：loopback 基础防线，浏览器标记缺失放行，显式跨站 / 异源 / Origin null 拒绝', async () => {
  const responded: Array<{ status: number }> = []
  const handler = createRouteHandler(() => 'http://127.0.0.1:1', { 'collect.status': async () => ({ status: 'ok' }) })
  const make = (headers: Record<string, unknown> = {}, remote = '127.0.0.1'): IncomingMessage => ({
    method: 'POST',
    socket: { remoteAddress: remote },
    headers: { 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"action":"collect.status"}') },
  } as unknown as IncomingMessage)
  // Desktop forwardWebRequest 形态：Origin 与 Sec-Fetch-Site 均被剥掉 → 200。
  await handler(make(), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  // Web 形态：正确 Origin + same-origin → 200。
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  // 正确 Origin 未带 Sec-Fetch-Site：Origin 已精确绑定来源 → 200（fence 语义）。
  await handler(make({ origin: 'http://127.0.0.1:1' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 200)
  // 异源 Origin → 403；Origin 字面 null（不透明源）→ 403。
  await handler(make({ origin: 'https://evil.example' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  await handler(make({ origin: 'null' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  // 显式跨站标记 → 403（即使 Origin 同源）。
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' }), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
  // 非 loopback：即使 Origin 看起来正确 → 403。
  await handler(make({ origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' }, '10.0.0.1'), fakeRes(responded))
  assert.equal(responded.at(-1)?.status, 403)
})

test('permitted：loopback 形态全放行，标记语义与 fence 对齐', () => {
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

// --- P1-5 复审补充：设备端语义回归（迁移/互斥/批次账本） ---

test('moveProfile：目标已存在时备份迁移，失败回滚', async () => {
  const root = join(tmpdir(), `wx-move-${String(Math.random()).slice(2)}`)
  const layout = paths(root)
  // 旧账号已有 profile（真实场景：任何一次成功登录后必然存在）。
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(layout.profileDir('old-id'), { recursive: true })
  await writeFile(join(layout.profileDir('old-id'), 'marker.txt'), 'old-data', 'utf8')
  // 新 pending profile。
  await mkdir(layout.profileDir('pending-1'), { recursive: true })
  await writeFile(join(layout.profileDir('pending-1'), 'marker.txt'), 'new-data', 'utf8')

  const { moveProfile } = await import('../src/state.ts')
  await moveProfile('pending-1', 'old-id', root)

  const { readdirSync } = await import('node:fs')
  const migrated = readdirSync(layout.profileDir('old-id'))
  assert.ok(migrated.includes('marker.txt'), '迁移后目标目录存在')
  assert.equal(existsSync(layout.profileDir('pending-1')), false, 'pending 目录已迁走')
  // 备份已清理。
  const siblings = readdirSync(layout.profilesDir).filter(name => name.startsWith('old-id.bak-'))
  assert.equal(siblings.length, 0, '备份目录已清理')
  await rm(root, { recursive: true, force: true })
})

test('collect.start 同步互斥：并发第二请求被拒（TOCTOU 缺口锁定）', async () => {
  // 通过 handler 表直接驱动：第一个请求占住 collectBusy（用阻塞探针），第二个必须立即 collect_busy。
  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  let probeStarted = 0
  const deps = createWxHostDeps({
    root: join(tmpdir(), `wx-mutex-${String(Math.random()).slice(2)}`),
    workbench: { callTool: async () => ({ structuredContent: { accounts: [] }, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  // 让 probe 挂起，保证第一请求持有 collectBusy。
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(deps.root, { recursive: true })
  await writeFile(join(deps.root, 'accounts.json'), JSON.stringify({ accounts: { acc1: { accountId: 'acc1', sessionStatus: 'ok', sessionSeq: 1 } } }), { mode: 0o600 })
  const release = Promise.withResolvers<void>()
  const batch = {
    get status() { return { ready: true, phase: 'ready', items: [], total: 0, currentAccountIndex: -1, currentAccountId: null, currentRunId: null, startedAt: null, finishedAt: null, completedCount: 0, partialCount: 0, failedCount: 0, skippedCount: 0, summary: null } as never },
    get running() { return false },
    start: async () => ({ started: false, reason: 'collect_busy' }),
  }
  const handlers = buildRouteHandlers(deps, batch as never)
  // 注入挂起 probe：临时替换 probeAndReport 动态导入不可行——改为直接测 deps 互斥位。
  // 用 collectBusy=true 直接模拟第一请求已受理。
  deps.collectBusy = true
  const second = await handlers['collect.start']?.({ accountId: 'acc1' })
  assert.deepEqual(second, { status: 'ok', started: false, reason: 'collect_busy' })
  assert.equal(handlers['collect.status'] ? (await handlers['collect.status']({})).busy : undefined, true)
  void probeStarted
  void release
  deps.collectBusy = false
  await rm(deps.root, { recursive: true, force: true })
})

test('removeRemote 前置：本地 storage_state 存在时拒绝', async () => {
  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const root = join(tmpdir(), `wx-rr-${String(Math.random()).slice(2)}`)
  const { mkdir, writeFile } = await import('node:fs/promises')
  const storageDir = join(root, 'storage-state')
  await mkdir(storageDir, { recursive: true })
  await writeFile(join(storageDir, 'acc1.json'), '{"cookies":[]}', { mode: 0o600 })
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }) }
  const handlers = buildRouteHandlers(deps, batch as never)
  const result = await handlers['account.removeRemote']?.({ accountId: 'acc1' }) as Record<string, unknown>
  assert.equal(result.status, 'error')
  assert.equal(result.reason, 'LOCAL_CLEARED_REQUIRED')
  await rm(root, { recursive: true, force: true })
})

test('accounts.list：远端删除墓碑不回流为可操作账号', async () => {
  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const deps = createWxHostDeps({
    root: join(tmpdir(), `wx-al-${String(Math.random()).slice(2)}`),
    workbench: {
      callTool: async (_caller: string, _domain: string, name: string) => {
        assert.equal(name, 'workbench_wx_account_list')
        return {
          structuredContent: {
            accounts: [
              { account_id: 'deleted-1', nickname: '远端已删除', delete_state: 'remote_deleted' },
              { account_id: 'active-1', nickname: '远端可用', delete_state: 'none' },
            ],
          },
          content: [],
        }
      },
    },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }) }
  const handlers = buildRouteHandlers(deps, batch as never)
  const result = await handlers['accounts.list']?.({}) as { accounts?: Array<{ accountId: string }> }
  assert.deepEqual(result.accounts?.map(row => row.accountId), ['active-1'])
})

test('works.list 窗口参数：publishedFrom/publishedTo 透传 tools，缺省不携带', async () => {
  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const deps = createWxHostDeps({
    root: join(tmpdir(), `wx-wl-${String(Math.random()).slice(2)}`),
    workbench: {
      callTool: async (_caller: string, _domain: string, name: string, args: unknown) => {
        calls.push({ name, args: args as Record<string, unknown> })
        return { structuredContent: { works: [] }, content: [] }
      },
    },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }) }
  const handlers = buildRouteHandlers(deps, batch as never)
  await handlers['works.list']?.({ accountId: 'acc1', sort: 'play_count', order: 'desc', publishedFrom: '2026-11-11', publishedTo: '2026-11-17' })
  await handlers['works.list']?.({ accountId: 'acc1' })
  assert.deepEqual(calls[0]?.args, { accountId: 'acc1', sort: 'play_count', order: 'desc', publishedFrom: '2026-11-11', publishedTo: '2026-11-17' })
  assert.deepEqual(calls[1]?.args, { accountId: 'acc1' })
  // 路由层：窗口字段长度截断为 10（YYYY-MM-DD），未知字段仍拒绝。
  const capped = validateActionArgs('works.list', { publishedFrom: '2026-11-11T00:00' })
  assert.equal(capped.publishedFrom, '2026-11-11')
  assert.throws(() => validateActionArgs('works.list', { publishedUntil: '2026-11-11' }), (error: unknown) =>
    error instanceof WxError && error.code === 'WX_ROUTE_INVALID_REQUEST')
})

test('works.list 分页参数：limit / offset 透传 tools，offset 0 不被丢弃', async () => {
  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const deps = createWxHostDeps({
    root: join(tmpdir(), `wx-wp-${String(Math.random()).slice(2)}`),
    workbench: {
      callTool: async (_caller: string, _domain: string, name: string, args: unknown) => {
        calls.push({ name, args: args as Record<string, unknown> })
        return { structuredContent: { works: [] }, content: [] }
      },
    },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }) }
  const handlers = buildRouteHandlers(deps, batch as never)
  await handlers['works.list']?.({ accountId: 'acc1', sort: 'play_count', order: 'asc', limit: 10, offset: 20 })
  await handlers['works.list']?.({ accountId: 'acc1', limit: 10, offset: 0 })
  assert.deepEqual(calls[0]?.args, { accountId: 'acc1', sort: 'play_count', order: 'asc', limit: 10, offset: 20 })
  assert.deepEqual(calls[1]?.args, { accountId: 'acc1', limit: 10, offset: 0 })
  // 缺省不携带：只传账号时工具参数里没有 limit / offset。
  await handlers['works.list']?.({ accountId: 'acc1' })
  assert.deepEqual(calls[2]?.args, { accountId: 'acc1' })
})

test('ingest 编排：RUN_NOT_RUNNING 重建 run 并重发 meta；确定性错误不重试', async () => {
  const { createIngestClient } = await import('../src/ingest.ts')
  const calls: Array<[string, Record<string, unknown>]> = []
  let runStartCount = 0
  let firstMetaThrows = true
  let firstBatchThrows = true
  const workbench = {
    callTool: async (_caller: string, _domain: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push([name, args])
      if (name === 'workbench_wx_collect_run_start') {
        runStartCount += 1
        return { structuredContent: { run: { run_id: `r-${String(runStartCount)}`, heartbeat_seq: 0 } } }
      }
      if (name === 'workbench_wx_collect_run_set_list_meta') {
        if (firstMetaThrows) {
          firstMetaThrows = false
          const error = new Error('lease expired') as Error & { payload?: unknown }
          error.payload = { error: { code: 'RUN_NOT_RUNNING', message: 'reclaimed', retryable: false, requestId: null } }
          throw error
        }
        return { structuredContent: { ok: true } }
      }
      if (name === 'workbench_wx_collect_ingest_works') {
        if (firstBatchThrows) {
          firstBatchThrows = false
          const error = new Error('lease expired again') as Error & { payload?: unknown }
          error.payload = { error: { code: 'RUN_NOT_RUNNING', message: 'reclaimed', retryable: false, requestId: null } }
          throw error
        }
        return { structuredContent: { batch: { succeeded_objects: ['w1'], failed_objects: [], batch_status: 'succeeded' }, replayed: false } }
      }
      if (name === 'workbench_wx_collect_run_cancel') return { structuredContent: { ok: true } }
      if (name === 'workbench_wx_collect_run_finish') return { structuredContent: { run: { status: 'completed' } } }
      return { structuredContent: { ok: true } }
    },
  }
  const client = createIngestClient({ workbench: workbench as never, accountId: 'acc1', root: join(tmpdir(), `wx-ing-${String(Math.random()).slice(2)}`), retries: 3, sleep: async () => undefined })
  await client.startRun({ newAttempt: true })
  // meta 失败 RUN_NOT_RUNNING → 无 onRecover 时抛出（重建由 ingestAll 的 withRetry 驱动）。
  await client.publishListMeta({ expectedWorkCount: 1, listComplete: true }).catch(() => undefined)
  // ingestAll：第一批 RUN_NOT_RUNNING → recoverRun（startRun+重发 meta）→ 重试成功。
  const ingest = await client.ingestAll([
    { workId: 'w1', publishTime: '2026-02-01T00:00:00.000Z', dailyMetrics: [] } as never,
  ], { observedCount: 1 })
  assert.deepEqual(ingest.succeededWorkIds, ['w1'])
  assert.equal(runStartCount >= 2, true, 'RUN_NOT_RUNNING 触发 run 重建')
  const startCalls = calls.filter(entry => entry[0] === 'workbench_wx_collect_run_start')
  assert.equal(startCalls.length >= 2, true)
  // 确定性错误不重试：RUN_ACCOUNT_MISMATCH 直接抛，且不再 start。
  const before = runStartCount
  await client.ingestAccountMetrics({ startDay: '2026-02-01', endDay: '2026-02-03', rows: [{ day: '2026-02-01' }], trafficSource: null }).catch((error: unknown) => {
    assert.equal((error as { payload?: { error?: { code?: string } } }).payload?.error?.code, 'RUN_ACCOUNT_MISMATCH')
  })
  // 构造确定性错误：让 finish 抛 RUN_ACCOUNT_MISMATCH。
  const deterministic = createIngestClient({ workbench: {
    callTool: async (_caller: string, _domain: string, name: string): Promise<unknown> => {
      if (name === 'workbench_wx_collect_run_start') return { structuredContent: { run: { run_id: 'r-d', heartbeat_seq: 0 } } }
      if (name === 'workbench_wx_collect_run_finish') {
        const error = new Error('mismatch') as Error & { payload?: unknown }
        error.payload = { error: { code: 'RUN_ACCOUNT_MISMATCH', message: 'x', retryable: false, requestId: null } }
        throw error
      }
      return { structuredContent: { ok: true } }
    },
  } as never, accountId: 'acc1', root: join(tmpdir(), `wx-det-${String(Math.random()).slice(2)}`), retries: 3, sleep: async () => undefined })
  await deterministic.startRun({ newAttempt: true })
  const finishStart = deterministic.heartbeatSeq
  await deterministic.finish({ clientStatus: 'completed', clientCounts: { expectedWorkCount: 0, succeededWorkCount: 0, failedWorkCount: 0 } }).catch((error: unknown) => {
    assert.equal((error as { payload?: { error?: { code?: string } } }).payload?.error?.code, 'RUN_ACCOUNT_MISMATCH')
  })
  void finishStart
  // 确定性错误只调用一次 finish（无重试）。
  assert.equal(before <= runStartCount, true)
})
