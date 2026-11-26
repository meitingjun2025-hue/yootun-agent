/**
 * Profile 锁全临界区覆盖的确定性测试（node --test）：
 * 1. collect 全程持锁（同账号 probe 排队、不同账号不阻塞）；
 * 2. context close 完成前锁不释放；
 * 3. collect.cancel 后锁释放、probe 可立即执行；
 * 4. removeLocal 与 collect 互斥（try 锁立即 collect_busy，不删凭证）；
 * 5. promote 在 realId 被 collect 占用时 collect_busy 且不迁移；
 * 6. 登录迁移（commitLoginIdentity）双锁互斥 + 生产路径端到端；
 * 7. 集成回归：buildRouteHandlers + deps.chromeFactory 注入路径不挂起。
 * 断言全部基于 Promise gate 与锁计数，不用 sleep 时长裁决并发。
 * 运行：`node --test tests/profile-lock.test.ts`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import {
  isProfileLocked, profileLockWaiters, tryWithProfileLock, tryWithProfileLocks,
  withProfileLock, withProfileLocks,
} from '../src/locks.ts'
import { buildRouteHandlers, createWxHostDeps } from '../src/handlers.ts'
import { createCollectController } from '../src/runner.ts'
import type { ChromeFactory } from '../src/session.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function makeRoot(prefix: string): string {
  const root = join(tmpdir(), `${prefix}-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })
  return root
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** auth_data CGI 的合法响应体（parseAuthData 输入形状；errCode=0 是会话有效判据）。 */
function authDataBody(accountId: string): string {
  return JSON.stringify({ errCode: 0, data: { finderUser: { finderUsername: accountId, nickname: `n-${accountId}`, headImgUrl: '', fansCount: 2, feedsCount: 3 } } })
}

/** 有界等待确定性条件（轮询的是状态信号，不是用 sleep 裁决并发）。 */
async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('waitForCondition timeout')
    await sleep(5)
  }
}

/** 防挂起护栏（unref：不阻塞测试进程退出）。 */
function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => { setTimeout(() => reject(new Error(message)), ms).unref() })
}

/** 此刻 promise 是否已 settle（挂起中的锁等待必返回 false）。 */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const winner = await Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(0).then(() => 'pending')])
  return winner === 'settled'
}

interface EnvAccount { id: string; storage?: boolean; profile?: boolean }

function makeEnv(prefix: string, accounts: EnvAccount[]): string {
  const root = makeRoot(prefix)
  const records: Record<string, unknown> = {}
  for (const account of accounts) {
    records[account.id] = { accountId: account.id, sessionStatus: 'ok', sessionSeq: 1 }
    if (account.storage !== false) {
      mkdirSync(join(root, 'storage-state'), { recursive: true })
      writeFileSync(join(root, 'storage-state', `${account.id}.json`), '{"cookies":[]}', { mode: 0o600 })
    }
    if (account.profile === true) {
      mkdirSync(join(root, 'profiles', account.id), { recursive: true })
      writeFileSync(join(root, 'profiles', account.id, 'marker'), 'x', { mode: 0o600 })
    }
  }
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify({ accounts: records }, null, 2)}\n`, { mode: 0o600 })
  return root
}

interface AccountScript {
  /** auth_data 返回的 finderUsername（默认 = 目录账号）。 */
  authAs?: string
  /** collect 本体（该账号第 3 次调用起）auth_data 返回的账号（身份不匹配 → collect 快速失败）。 */
  collectAuthAs?: string
  /** 从第 N 次调用起 factory 直接抛 GOOGLE_CHROME_MISSING。 */
  failFromCall?: number
  /** collect 本体 page.goto 的 gate（进入时先触发 entered）。 */
  collectGoto?: { gate: Promise<void>; entered?: Promise<void> }
  /** collect 本体 context.close 的包装（进入时先触发 entered，gate 可选）。 */
  collectClose?: { gate?: Promise<void>; entered?: Promise<void> }
}

/**
 * 注入的 Chrome factory：按 profileDir basename 路由账号脚本；调用序固定为
 * handler probe(1) → runCollection 内 probe(2) → collect 本体(3+)。
 */
function makeFactory(scripts: Record<string, AccountScript>): ChromeFactory {
  const calls = new Map<string, number>()
  return async options => {
    const accountId = basename(options.profileDir)
    const script = scripts[accountId] ?? {}
    const callNo = (calls.get(accountId) ?? 0) + 1
    calls.set(accountId, callNo)
    if (script.failFromCall !== undefined && callNo >= script.failFromCall) {
      throw Object.assign(new Error('chrome missing'), { code: 'GOOGLE_CHROME_MISSING' })
    }
    // 调用序：handler probe(1) → runCollection 内 probe(2) → collect 本体(3)。
    const isCollectBody = callNo === 3
    const page = {
      goto: async () => {
        if (isCollectBody && script.collectGoto !== undefined) {
          script.collectGoto.entered?.()
          await script.collectGoto.gate
        }
      },
      evaluate: async (_fn: unknown, arg: { url: string }) => {
        if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) {
          const authAs = isCollectBody && script.collectAuthAs !== undefined ? script.collectAuthAs : script.authAs ?? accountId
          return { status: 200, text: authDataBody(authAs) }
        }
        return { status: 500, text: '' }
      },
    }
    const context = {
      pages: () => [page],
      newPage: async () => page,
      cookies: async () => [{ name: 'sessionid', value: 'v' }],
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => {
        if (isCollectBody && script.collectClose !== undefined) {
          script.collectClose.entered?.()
          if (script.collectClose.gate !== undefined) await script.collectClose.gate
        }
      },
    }
    return { context } as never
  }
}

function buildHandlers(root: string, chromeFactory: ChromeFactory): { deps: ReturnType<typeof createWxHostDeps>; handlers: Record<string, (args: Record<string, string>) => Promise<object>> } {
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
    chromeFactory,
  })
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  const collect = createCollectController(
    { workbench: deps.workbench, root, chromeFactory, logger: deps.logger },
    { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
  )
  return { deps, handlers: buildRouteHandlers(deps, batch as never, collect) as Record<string, (args: Record<string, string>) => Promise<object>> }
}

async function callHandler(handlers: Record<string, (args: Record<string, string>) => Promise<object>>, action: string, args: Record<string, string>): Promise<Record<string, unknown>> {
  const handler = handlers[action]
  assert.ok(handler !== undefined, `handler ${action} 必须存在`)
  return await handler(args) as Record<string, unknown>
}

// --- 1. collect 全程持锁 ---

test('profile 锁：collect 全程持锁，同账号 probe 排队等待、不同账号不受阻塞', async () => {
  const root = makeEnv('wx-pl-collect', [{ id: 'acc1' }, { id: 'acc2', storage: false }])
  const gotoGate = deferred<void>()
  const gotoEntered = deferred<void>()
  const factory = makeFactory({
    acc1: {
      collectGoto: { gate: gotoGate.promise, entered: gotoEntered.resolve },
      collectAuthAs: 'someone-else',
    },
  })
  const { handlers } = buildHandlers(root, factory)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.status, 'ok')
  assert.equal(collect.started, true)

  // collect 本体已进入 page.goto gate → 锁正被 collect 持有。
  await gotoEntered.promise
  assert.equal(isProfileLocked('acc1'), true, 'collect 本体阶段必须持有 profile 锁')

  // 同账号 probe：等待在锁外（排队），此刻不得 settle。
  const probeP = callHandler(handlers, 'account.probe', { accountId: 'acc1' })
  await waitForCondition(() => profileLockWaiters('acc1') === 1)
  assert.equal(await isSettled(probeP), false, 'probe 在 collect 持锁期间不得完成')

  // 不同账号 probe：不等待 acc1 的锁，立即完成。
  const probeB = await Promise.race([callHandler(handlers, 'account.probe', { accountId: 'acc2' }), timeoutReject(3000, '不同账号 probe 被阻塞')])
  assert.equal(probeB.status, 'ok')
  assert.equal(probeB.sessionStatus, 'expired', 'acc2 无 storage_state → expired，不碰锁')

  // 释放 gate：collect 失败收尾 → close → 锁释放 → 排队 probe 完成。
  gotoGate.resolve()
  const probe = await Promise.race([probeP, timeoutReject(5000, 'collect 释放锁后 probe 未完成')])
  assert.equal(probe.status, 'ok')
  assert.equal(probe.sessionStatus, 'ok', 'collect 释放锁后同账号 probe 应成功执行')

  await waitForCondition(async () => {
    const st = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
    return st.busy === false && (st.collect as { status?: string } | null)?.status === 'failed'
  })
  cleanup(root)
})

// --- 2. context close 前锁不释放 ---

test('profile 锁：context close 完成前锁不释放，removeLocal 返回 collect_busy 且不删除凭证', async () => {
  const root = makeEnv('wx-pl-close', [{ id: 'acc1', profile: true }])
  const gotoGate = deferred<void>()
  const gotoEntered = deferred<void>()
  const closeGate = deferred<void>()
  const closeEntered = deferred<void>()
  const factory = makeFactory({
    acc1: {
      collectGoto: { gate: gotoGate.promise, entered: gotoEntered.resolve },
      collectClose: { gate: closeGate.promise, entered: closeEntered.resolve },
      collectAuthAs: 'someone-else',
    },
  })
  const { handlers } = buildHandlers(root, factory)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise
  gotoGate.resolve()
  // close 已进入但被 gate 挂起：锁必须仍未释放。
  await closeEntered.promise
  assert.equal(isProfileLocked('acc1'), true, 'context.close 完成前锁不得释放')

  const rm = await callHandler(handlers, 'account.removeLocal', { accountId: 'acc1' })
  assert.equal(rm.removed, false)
  assert.equal(rm.reason, 'collect_busy')
  assert.ok(existsSync(join(root, 'storage-state', 'acc1.json')), 'storage_state 不得被删')
  assert.ok(existsSync(join(root, 'accounts.json')), 'accounts.json 不得被清')
  assert.ok((JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, unknown> }).accounts['acc1'] !== undefined, '账号记录不得被删')

  closeGate.resolve()
  await waitForCondition(() => !isProfileLocked('acc1'))
  const rm2 = await callHandler(handlers, 'account.removeLocal', { accountId: 'acc1' })
  assert.equal(rm2.removed, true, 'close 完成锁释放后 removeLocal 应成功')
  assert.ok(!existsSync(join(root, 'storage-state', 'acc1.json')))
  assert.ok(!existsSync(join(root, 'profiles', 'acc1')), 'profile 目录应被清理')
  cleanup(root)
})

// --- 3. cancel 后锁释放 ---

test('profile 锁：collect.cancel abort 后 runCollection settle、锁释放、probe 可立即执行', async () => {
  const root = makeEnv('wx-pl-cancel', [{ id: 'acc1', profile: true }])
  const gotoEntered = deferred<void>()
  let rejectGoto!: (error: Error) => void
  const abortAwareGate = new Promise<void>((_, reject) => { rejectGoto = reject })
  const factory = makeFactory({
    acc1: { collectGoto: { gate: abortAwareGate, entered: gotoEntered.resolve } },
  })
  const { handlers } = buildHandlers(root, factory)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise
  assert.equal(isProfileLocked('acc1'), true)

  const cancel = await callHandler(handlers, 'collect.cancel', { accountId: 'acc1' })
  assert.deepEqual(cancel, { status: 'ok', cancelled: true })
  // 模拟 Playwright goto 因 abort/context 关闭而失败（真实浏览器语义）。
  rejectGoto(new Error('goto aborted'))
  await waitForCondition(() => !isProfileLocked('acc1'), 5000)
  // busy 表示任一账号运行中；终态记录按账号查询。
  const st = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
  assert.equal(st.busy, false)
  assert.equal((st.collect as { status?: string } | null)?.status, 'cancelled')
  // signal 已清理：重复 cancel 报 not_running。
  const cancel2 = await callHandler(handlers, 'collect.cancel', { accountId: 'acc1' })
  assert.deepEqual(cancel2, { status: 'ok', cancelled: false, reason: 'not_running' })

  // 锁已释放：同账号 probe 立即可执行。
  const probe = await Promise.race([callHandler(handlers, 'account.probe', { accountId: 'acc1' }), timeoutReject(3000, 'cancel 后 probe 未立即完成')])
  assert.equal(probe.status, 'ok')
  assert.equal(probe.sessionStatus, 'ok')
  cleanup(root)
})

// --- 4. removeLocal 与 collect 互斥 ---

test('profile 锁：removeLocal 与 collect 互斥——持锁期间立即 collect_busy，collect 结束后可正常清理', async () => {
  const root = makeEnv('wx-pl-rm', [{ id: 'acc1', profile: true }])
  const gotoGate = deferred<void>()
  const gotoEntered = deferred<void>()
  const factory = makeFactory({
    acc1: {
      collectGoto: { gate: gotoGate.promise, entered: gotoEntered.resolve },
      collectAuthAs: 'someone-else',
    },
  })
  const { handlers } = buildHandlers(root, factory)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise

  const startedAt = Date.now()
  const rm = await callHandler(handlers, 'account.removeLocal', { accountId: 'acc1' })
  assert.ok(Date.now() - startedAt < 2000, 'removeLocal 不得等待长采集')
  assert.equal(rm.removed, false)
  assert.equal(rm.reason, 'collect_busy')
  assert.ok(existsSync(join(root, 'storage-state', 'acc1.json')), '持锁期间不得删除 storage_state')
  assert.ok(existsSync(join(root, 'profiles', 'acc1', 'marker')), '持锁期间不得删除 profile')

  gotoGate.resolve()
  await waitForCondition(() => !isProfileLocked('acc1'))
  const rm2 = await callHandler(handlers, 'account.removeLocal', { accountId: 'acc1' })
  assert.equal(rm2.removed, true)
  assert.ok(!existsSync(join(root, 'storage-state', 'acc1.json')))
  assert.ok(!existsSync(join(root, 'profiles', 'acc1')))
  assert.ok((JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, unknown> }).accounts['acc1'] === undefined, '账号记录应被删除')
  cleanup(root)
})

// --- 5. promote 与真实账号互斥 ---

test('profile 锁：promote 在 realId 被 collect 占用时返回 collect_busy 且不迁移；collect 结束后迁移成功', async () => {
  const root = makeEnv('wx-pl-promote', [{ id: 'real-1' }, { id: 'pending-5', profile: true }])
  const gotoGate = deferred<void>()
  const gotoEntered = deferred<void>()
  const factory = makeFactory({
    'real-1': {
      collectGoto: { gate: gotoGate.promise, entered: gotoEntered.resolve },
      collectAuthAs: 'someone-else',
    },
    'pending-5': { authAs: 'real-1' },
  })
  const { handlers } = buildHandlers(root, factory)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'real-1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise

  // 阶段 1 probe pending-5（不同账号锁，可执行）→ realId=real-1；阶段 2 try 双锁失败。
  const promote1 = await callHandler(handlers, 'account.promote', { accountId: 'pending-5' })
  assert.equal(promote1.status, 'ok')
  assert.equal(promote1.promoted, false)
  assert.equal(promote1.reason, 'collect_busy')
  assert.ok(existsSync(join(root, 'profiles', 'pending-5', 'marker')), 'collect 持锁期间不得迁移 profile')
  assert.ok(existsSync(join(root, 'storage-state', 'pending-5.json')), 'collect 持锁期间不得迁移 storage_state')

  gotoGate.resolve()
  await waitForCondition(() => !isProfileLocked('real-1'))
  const promote2 = await callHandler(handlers, 'account.promote', { accountId: 'pending-5' })
  assert.equal(promote2.status, 'ok')
  assert.equal(promote2.promoted, true)
  assert.equal(promote2.accountId, 'real-1')
  assert.ok(!existsSync(join(root, 'profiles', 'pending-5')), '迁移后 pending profile 应消失')
  assert.ok(!existsSync(join(root, 'storage-state', 'pending-5.json')), '迁移后 pending storage_state 应消失')
  assert.ok(existsSync(join(root, 'storage-state', 'real-1.json')))
  assert.ok((JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, unknown> }).accounts['real-1'] !== undefined, 'realId 记录应存在')
  cleanup(root)
})

// --- 6. 登录迁移与 realId 互斥 ---

test('profile 锁：commitLoginIdentity 双锁内迁移——close 挂起期间 realId 操作被挡、完成后迁移落地', async () => {
  const root = makeRoot('wx-pl-commit')
  mkdirSync(join(root, 'profiles', 'pending-777'), { recursive: true })
  writeFileSync(join(root, 'profiles', 'pending-777', 'marker'), 'x', { mode: 0o600 })
  const closeGate = deferred<void>()
  const closeEntered = deferred<void>()
  const { commitLoginIdentity } = await import('../src/session.ts')

  const context = {
    storageState: async () => ({ cookies: [], origins: [] }),
    close: async () => { closeEntered.resolve(); await closeGate.promise },
  }
  const commit = commitLoginIdentity({
    tempId: 'pending-777',
    resolvedId: 'real-9',
    profile: { accountId: 'real-9', nickname: 'n9', avatar: null, fansCount: 5, feedsCount: 6, isMasterFinder: null },
    context: context as never,
    root,
  })

  await closeEntered.promise
  assert.equal(isProfileLocked('real-9'), true, '迁移临界区内必须持有 realId 锁')
  assert.equal(isProfileLocked('pending-777'), true, '迁移临界区内必须持有 tempId 锁')
  const steal = await tryWithProfileLock('real-9', async () => 'should-not-run')
  assert.equal(steal.acquired, false, 'realId 锁被迁移持有时 try 锁不得获取')
  assert.ok(existsSync(join(root, 'profiles', 'pending-777', 'marker')), 'close 未完成前 moveProfile 不得发生')
  assert.ok(!existsSync(join(root, 'profiles', 'real-9')))

  closeGate.resolve()
  const done = await Promise.race([commit, timeoutReject(3000, '迁移未在 close 释放后完成')])
  assert.deepEqual(done, { accountId: 'real-9' })
  assert.ok(existsSync(join(root, 'profiles', 'real-9', 'marker')), 'profile 应迁移到 realId 名下')
  assert.ok(!existsSync(join(root, 'profiles', 'pending-777')), 'tempId profile 应消失')
  assert.ok(existsSync(join(root, 'storage-state', 'real-9.json')), 'storage_state 应落到 realId 名下')
  assert.equal(isProfileLocked('real-9'), false, '迁移完成后锁应释放')
  const accounts = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, { sessionStatus?: string }> }
  assert.equal(accounts.accounts['real-9']?.sessionStatus, 'ok')
  cleanup(root)
})

test('loginWithQrCode 生产路径经 commitLoginIdentity 迁移（身份稳定窗口约 4 秒）', async () => {
  const root = makeRoot('wx-pl-login')
  const { loginWithQrCode } = await import('../src/session.ts')
  const controller = new AbortController()
  const result = await loginWithQrCode({
    root,
    timeoutMs: 10_000,
    signal: controller.signal,
    chromeFactory: async () => {
      const page = {
        goto: async () => undefined,
        evaluate: async (_fn: unknown, arg: { url: string }) => {
          if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) return { status: 200, text: authDataBody('real-9') }
          return { status: 500, text: '' }
        },
      }
      const context = {
        pages: () => [page],
        newPage: async () => page,
        cookies: async () => [{ name: 'sessionid', value: 'v' }],
        storageState: async () => ({ cookies: [], origins: [] }),
        close: async () => undefined,
      }
      return { context } as never
    },
  })
  assert.equal(result.status, 'ok')
  assert.equal(result.accountId, 'real-9')
  const entries = readdirSync(join(root, 'profiles'))
  assert.deepEqual(entries.filter(name => name.startsWith('pending-')), [], '迁移后不得残留 pending-* profile')
  assert.ok(entries.includes('real-9'), `profiles 应含 real-9: ${JSON.stringify(entries)}`)
  assert.ok(existsSync(join(root, 'storage-state', 'real-9.json')))
  const accounts = JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')) as { accounts: Record<string, { sessionStatus?: string }> }
  assert.equal(accounts.accounts['real-9']?.sessionStatus, 'ok')
  assert.equal(isProfileLocked('real-9'), false, '登录完成后迁移锁应释放')
  cleanup(root)
})

// --- 7. 集成回归：handler 注入路径无嵌套死锁 ---

test('profile 锁：collect.start 经 buildRouteHandlers 失败路径不挂起且锁可重入', async () => {
  const root = makeEnv('wx-pl-integ', [{ id: 'acc1' }])
  const factory = makeFactory({ acc1: { failFromCall: 3 } })
  const { handlers } = buildHandlers(root, factory)

  // handler probe(1) 成功 → collect.start 返回 started（runCollection 已进入全程锁）；
  // runCollection 内 probe(2) 成功 → collect 本体(3) Chrome 失败 → 后台 failed 收尾、锁释放。
  // 全程 handler 层与 runner 层各自独立获取锁，无嵌套挂起。
  const first = await Promise.race([callHandler(handlers, 'collect.start', { accountId: 'acc1' }), timeoutReject(3000, 'collect.start 挂起')])
  assert.equal(first.status, 'ok')
  assert.equal(first.started, true)
  await waitForCondition(async () => {
    const st = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
    return st.busy === false && (st.collect as { status?: string } | null)?.status === 'failed'
  }, 3000)
  assert.equal(isProfileLocked('acc1'), false, 'runCollection 失败收尾后锁必须释放')
  const second = await Promise.race([callHandler(handlers, 'collect.start', { accountId: 'acc1' }), timeoutReject(3000, '第二次 collect.start 挂起')])
  assert.notEqual(second.reason, 'collect_busy', '锁释放后第二次调用不得被 collect_busy 拒绝')
  cleanup(root)
})

// --- 锁原语补充（多锁排序 / try 回滚；集成覆盖见上方用例） ---

test('profile 锁原语：withProfileLocks 以不同 key 顺序并发调用不死锁且互斥', async () => {
  const order: string[] = []
  const [r1, r2] = await Promise.all([
    withProfileLocks(['pa', 'pb'], async () => {
      order.push('ab-start')
      await sleep(20)
      order.push('ab-end')
      return 1
    }),
    withProfileLocks(['pb', 'pa'], async () => {
      order.push('ba-start')
      return 2
    }),
  ])
  assert.equal(r1, 1)
  assert.equal(r2, 2)
  assert.ok(order.indexOf('ab-end') < order.indexOf('ba-start'), 'ba 必须等 ab 全部释放（排序获取全序一致）')
})

test('profile 锁原语：tryWithProfileLocks 任一占用即整体失败，已获取的锁回滚', async () => {
  await withProfileLock('pb', async () => {
    const attempt = await tryWithProfileLocks(['pa', 'pb'], async () => 1)
    assert.equal(attempt.acquired, false)
    assert.equal(isProfileLocked('pa'), false, '回滚后 pa 不得残留占用')
    assert.equal(profileLockWaiters('pa'), 0)
  })
})

// --- probeSession 的 45s race timer 泄漏回归（profile lock 测试暴露：每次成功
// probe 泄漏一个 45s Timeout，把测试进程挂住约 45 秒） ---

function countActiveTimeouts(): number {
  return process.getActiveResourcesInfo().filter(name => name === 'Timeout').length
}

test('probeSession 成功探活后不遗留 Timeout（race timer 必须被清除）', async () => {
  const root = makeEnv('wx-pl-timer', [{ id: 'acc1' }])
  const { probeSession } = await import('../src/session.ts')
  const factory = makeFactory({ acc1: {} })
  const before = countActiveTimeouts()
  const probe = await probeSession({ accountId: 'acc1', root, chromeFactory: factory })
  assert.equal(probe.status, 'ok')
  // 方向性断言（after <= before）：泄漏时 after=before+1 必失败；背景中早期
  // 测试遗留的护栏 timer 恰好到期（after=before-1）不应误报。
  assert.ok(countActiveTimeouts() <= before, `成功 probe 后活跃 Timeout 数不得增加（45s race timer 未清除）: before=${String(before)} after=${String(countActiveTimeouts())}`)
  cleanup(root)
})

test('raceWithTimeout：promise 先完成清 timer；超时分支交付 onTimeout；拒绝原样保留且无 timer 残留', async () => {
  const { raceWithTimeout } = await import('../src/session.ts')
  const before = countActiveTimeouts()

  // promise 先完成：拿到结果，活跃 Timeout 数不增（60s timer 已被清除）。
  assert.equal(await raceWithTimeout(sleep(5).then(() => 'ok'), 60_000, () => 'timeout'), 'ok')
  assert.ok(countActiveTimeouts() <= before, `promise 赢得 race 后 timer 未清除: before=${String(before)} after=${String(countActiveTimeouts())}`)

  // 超时赢得 race：交付 onTimeout 的结果。
  assert.equal(await raceWithTimeout(new Promise<string>(() => {}), 10, () => 'timeout'), 'timeout')

  // promise 拒绝：原始 rejection 原样保留，settle 后无 timer 残留。
  await assert.rejects(
    raceWithTimeout(Promise.reject(new Error('boom')), 60_000, () => 'timeout'),
    /boom/,
  )
  assert.ok(countActiveTimeouts() <= before, `promise 拒绝后 timer 未清除: before=${String(before)} after=${String(countActiveTimeouts())}`)
})
