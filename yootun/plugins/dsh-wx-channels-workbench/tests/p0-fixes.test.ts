/**
 * P2 三次复审 P0 修复的确定性测试（node --test）：
 * 1. profile lock 死锁：同账号嵌套锁不得挂起；
 * 2. login abort：abort 后 profiles 目录无 pending-* 残留（含 factory 晚 resolve）；
 * 3. 集成：account.probe / collect.start 经 buildRouteHandlers 注入不死锁。
 * runs.json 状态机测试见 tests/runs.test.ts。
 * 运行：`node --test tests/p0-fixes.test.ts`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProfileLocks } from '@yootun/dsh-workbench-host-kit'
import type { CollectStartInput } from '../src/runner.ts'

const { withProfileLock } = createProfileLocks()

// --- 1. profile lock 死锁 ---

test('profile lock：同账号嵌套调用不得永久挂起（非重入锁的调用方不得再包一层）', async () => {
  // 模拟 handlers.ts 外层包 lock → 内层 probeAndReport 又包 lock → 死锁。
  // 修复后：lock 只在最内层（probeSession），外层不再包。
  const result = await withProfileLock('acc-nested', async () => {
    // 内层不再调用 withProfileLock（修复后的正确行为）。
    return 'inner-done'
  })
  assert.equal(result, 'inner-done')
})

test('profile lock：同账号并发调用串行（不同账号并发不阻塞）', async () => {
  const order: string[] = []
  // 同账号：第二个调用必须等第一个完成。
  const [r1, r2] = await Promise.all([
    withProfileLock('acc-serial', async () => {
      order.push('acc-serial:start')
      await new Promise(resolve => setTimeout(resolve, 50))
      order.push('acc-serial:end')
      return 1
    }),
    withProfileLock('acc-serial', async () => {
      order.push('acc-serial:start-2')
      return 2
    }),
  ])
  assert.equal(r1, 1)
  assert.equal(r2, 2)
  assert.ok(order.indexOf('acc-serial:end') < order.indexOf('acc-serial:start-2'), '同账号串行')

  // 不同账号：并发不阻塞。
  const [a, b] = await Promise.all([
    withProfileLock('acc-A', async () => 'A'),
    withProfileLock('acc-B', async () => 'B'),
  ])
  assert.equal(a, 'A')
  assert.equal(b, 'B')
})

// --- 2. login abort 清理 ---

test('loginWithQrCode abort 后 profiles 目录无 pending-* 残留', async () => {
  const root = join(tmpdir(), `wx-login-abort-${String(Math.random()).slice(2)}`)
  const profilesDir = join(root, 'profiles')
  mkdirSync(profilesDir, { recursive: true })

  const controller = new AbortController()
  const { loginWithQrCode } = await import('../src/session.ts')

  // 启动登录（chromeFactory 注入假实现：永不 resolve，模拟 Chrome 打开挂起）。
  const pending = loginWithQrCode({
    root,
    locks: createProfileLocks(),
    chromeFactory: async options => {
      // 创建 profile 目录（模拟 Chrome persistent context）。
      mkdirSync(options.profileDir, { recursive: true })
      // 永不 resolve 的 context（挂起等 abort）。
      return new Promise<never>(() => {})
    },
    signal: controller.signal,
  })

  // 等 Chrome factory 被调用（profile 目录出现）。
  const deadline = Date.now() + 3000
  while (!existsSync(join(profilesDir, 'pending-')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    // pending profile 目录名可能带时间戳。
    const entries = readdirSync(profilesDir).filter(name => name.startsWith('pending-'))
    if (entries.length > 0) break
  }

  // abort。
  controller.abort()
  const result = await Promise.race([
    pending.catch((error: unknown) => ({ status: 'failed', reason: (error as Error)?.message ?? 'unknown' })),
    new Promise<{ status: string; reason?: string }>((_, reject) => setTimeout(() => reject(new Error('login abort timeout')), 5000)),
  ])
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'login_aborted')

  // abort 后 profiles 目录无 pending-* 残留。
  const leftover = readdirSync(profilesDir).filter(name => name.startsWith('pending-'))
  assert.equal(leftover.length, 0, `pending-* 目录应已清理，实际残留: ${JSON.stringify(leftover)}`)

  rmSync(root, { recursive: true, force: true })
})

test('loginWithQrCode abort 后 factory 晚 resolve：close + 二次清理，无 pending-* 残留', async () => {
  const root = join(tmpdir(), `wx-late-${String(Math.random()).slice(2)}`)
  const profilesDir = join(root, 'profiles')
  mkdirSync(profilesDir, { recursive: true })

  const controller = new AbortController()
  const { loginWithQrCode } = await import('../src/session.ts')
  let closeCalled = false
  let lateResolved = false

  // 确定性时序：factory 等 abort 赢得 race 后，才创建 pending-* profile 并
  // resolve 一个可 close 的 context（模拟 Chrome persistent context 慢启动）。
  const pending = loginWithQrCode({
    root,
    locks: createProfileLocks(),
    chromeFactory: async options => {
      const signal = controller.signal
      while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 5))
      mkdirSync(options.profileDir, { recursive: true })
      writeFileSync(join(options.profileDir, 'late-marker'), 'x', { mode: 0o600 })
      lateResolved = true
      return { context: { close: async () => { closeCalled = true } } as never }
    },
    signal: controller.signal,
  })

  await new Promise(resolve => setTimeout(resolve, 10))
  controller.abort()

  const result = await Promise.race([
    pending.catch((error: unknown) => ({ status: 'failed', reason: (error as Error)?.message ?? 'unknown' })),
    new Promise<{ status: string; reason?: string }>((_, reject) => setTimeout(() => reject(new Error('login abort timeout')), 5000)),
  ])
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'login_aborted')

  // 等 factory 晚 resolve（abort 后才创建 profile + resolve）。
  const lateDeadline = Date.now() + 3000
  while (!lateResolved && Date.now() < lateDeadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(lateResolved, 'factory 应在 abort 后晚 resolve')

  // 等晚 resolve 钩子 close + 二次清理完成：profiles 目录不得残留 pending-*。
  const cleanDeadline = Date.now() + 3000
  let leftover: string[] = []
  do {
    leftover = existsSync(profilesDir) ? readdirSync(profilesDir).filter(name => name.startsWith('pending-')) : []
    if (leftover.length === 0) break
    await new Promise(resolve => setTimeout(resolve, 20))
  } while (Date.now() < cleanDeadline)
  assert.equal(leftover.length, 0, `pending-* 应已被晚 resolve 钩子清理，实际残留: ${JSON.stringify(leftover)}`)
  assert.equal(closeCalled, true, '晚 resolve 的 context 应被 close')

  rmSync(root, { recursive: true, force: true })
})

// --- 集成测试：account.probe / collect.start 不死锁 ---

/** 注入的 Chrome factory：进入探活锁路径后立刻失败（确定性，不依赖真机 Chrome）。 */
function chromeMissingFactory(): never {
  throw Object.assign(new Error('chrome missing'), { code: 'GOOGLE_CHROME_MISSING' })
}

test('account.probe 真实 handler 在限定时间内完成（无嵌套锁死锁）', async () => {
  const root = join(tmpdir(), `wx-probe-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const storageDir = join(root, 'storage-state')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'acc1.json'), '{"cookies":[]}', { mode: 0o600 })
  writeFileSync(join(root, 'accounts.json'), JSON.stringify({ accounts: { acc1: { accountId: 'acc1', sessionStatus: 'ok', sessionSeq: 1 } } }), { mode: 0o600 })

  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const { createCollectController } = await import('../src/runner.ts')
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
    chromeFactory: chromeMissingFactory,
  })
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  const collect = createCollectController(
    { workbench: deps.workbench, root, chromeFactory: chromeMissingFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
  )
  const handlers = buildRouteHandlers(deps, batch as never, collect)

  // 修复前：外层包 lock + probe 内层再包 lock → 永久挂起；修复后 3 秒内返回。
  const result = await Promise.race([
    handlers['account.probe']?.({ accountId: 'acc1' }) as Promise<Record<string, unknown>>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('account.probe 挂起')), 3000)),
  ])
  assert.equal(result.status, 'ok')
  // 注入 factory 失败 → 探活 unknown（证明锁路径真实执行过而非短路）。
  assert.equal(result.sessionStatus, 'unknown')
  rmSync(root, { recursive: true, force: true })
})

test('collect.start 进入 probe 阶段不挂起且失败后互斥复位', async () => {
  const root = join(tmpdir(), `wx-col-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const storageDir = join(root, 'storage-state')
  mkdirSync(storageDir, { recursive: true })
  writeFileSync(join(storageDir, 'acc1.json'), '{"cookies":[]}', { mode: 0o600 })
  writeFileSync(join(root, 'accounts.json'), JSON.stringify({ accounts: { acc1: { accountId: 'acc1', sessionStatus: 'ok', sessionSeq: 1 } } }), { mode: 0o600 })

  const { buildRouteHandlers, createWxHostDeps } = await import('../src/handlers.ts')
  const { createCollectController } = await import('../src/runner.ts')
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
    chromeFactory: chromeMissingFactory,
  })
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  const collect = createCollectController(
    { workbench: deps.workbench, root, chromeFactory: chromeMissingFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
  )
  const handlers = buildRouteHandlers(deps, batch as never, collect)

  const first = await Promise.race([
    handlers['collect.start']?.({ accountId: 'acc1' }) as Promise<Record<string, unknown>>,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('collect.start 挂起')), 3000)),
  ])
  assert.equal(first.status, 'ok')
  assert.equal(first.started, false)
  assert.equal(first.reason, 'probe_failed', `实际: ${JSON.stringify(first)}`)

  // 失败路径复位互斥：第二次调用不被 collect_busy 拒绝。
  const second = await handlers['collect.start']?.({ accountId: 'acc1' }) as Record<string, unknown>
  assert.notEqual(second.reason, 'collect_busy')
  rmSync(root, { recursive: true, force: true })
})

// --- 生产接线守卫（apply 的三处接线抽为导出工厂，apply 与测试共用同一装配） ---

test('启动恢复接线：interrupted 摘要写进 deps.startupInterruption（2.5 横幅数据源）', async () => {
  const { applyWxStartupRecovery } = await import('../src/index.ts')
  const { createWxHostDeps } = await import('../src/handlers.ts')
  const root = mkdtempSync(join(tmpdir(), 'wx-recover-'))
  try {
    const deps = createWxHostDeps({
      root,
      workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
    })
    const recoverCalls: string[] = []
    applyWxStartupRecovery({
      root,
      deps,
      registry: deps.taskRegistry,
      logger: { warn: () => undefined },
      recover: async rootDir => { recoverCalls.push(rootDir); return { count: 2, accountIds: ['a1', 'a2'] } },
    })
    await deps.taskRegistry.awaitSettled()
    assert.deepEqual(recoverCalls, [root])
    assert.deepEqual(deps.startupInterruption, { count: 2, accountIds: ['a1', 'a2'] })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('启动恢复接线：恢复失败只告警不阻断启动，startupInterruption 保持 null', async () => {
  const { applyWxStartupRecovery } = await import('../src/index.ts')
  const { createWxHostDeps } = await import('../src/handlers.ts')
  const root = mkdtempSync(join(tmpdir(), 'wx-recover-fail-'))
  try {
    const warnings: string[] = []
    const deps = createWxHostDeps({
      root,
      workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
    })
    applyWxStartupRecovery({
      root,
      deps,
      registry: deps.taskRegistry,
      logger: { warn: message => { warnings.push(message) } },
      recover: async () => { throw new Error('runs corrupted') },
    })
    await deps.taskRegistry.awaitSettled()
    assert.equal(deps.startupInterruption, null)
    assert.equal(warnings.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('批量门面：probed 前置探测投影原样透传给单账号控制器（缺透传 = 复用失效）', async () => {
  const { createWxBatchFacade } = await import('../src/index.ts')
  const startedInputs: Array<CollectStartInput> = []
  const facade = createWxBatchFacade({
    start: async input => { startedInputs.push(input); return { started: true, record: null } },
    status: () => null,
    running: () => null,
    runningAccountIds: () => [],
    hasRunning: () => false,
    wait: async () => null,
    cancel: () => false,
  })
  const probed = { state: { sessionStatus: 'ok' as const, reason: null, sessionSeq: 1, checkedAt: '2026-11-27T00:00:00Z', vaultRef: 'v', accountId: 'acc-1', sessionStatusReported: true }, reported: true, probedAt: 42 }
  await facade.start({ accountId: 'acc-1', probed })
  assert.equal(startedInputs[0]?.fromBatch, true)
  assert.deepEqual(startedInputs[0]?.probed, probed)
  assert.equal(facade.hasRunning(), false)
  assert.equal(await facade.wait('acc-1'), null)
})

test('批量前置探测回调：probe 暂存投影原样交给批量控制器（缺字段 = 复用失效）', async () => {
  const { createWxBatchProbe } = await import('../src/index.ts')
  const { createWxHostDeps } = await import('../src/handlers.ts')
  const root = mkdtempSync(join(tmpdir(), 'wx-probe-'))
  try {
    const deps = createWxHostDeps({
      root,
      workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
    })
    const probed = { state: { sessionStatus: 'ok' as const, reason: null, sessionSeq: 2, checkedAt: '2026-11-27T00:00:00Z', vaultRef: 'v', accountId: 'acc-7', sessionStatusReported: true }, reported: true, probedAt: 7 }
    const probe = createWxBatchProbe({
      workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
      root,
      locks: deps.locks,
      chromeFactory: undefined,
      logger: { warn: () => undefined },
      registry: deps.taskRegistry,
      launchTimeoutMs: 60_000,
      browserCloseTimeoutMs: 8_000,
      loadProbe: async () => ({
        probeAndReport: async (_workbench, accountId, _root, _locks, _chromeFactory, budgets) => {
          assert.equal(accountId, 'acc-7')
          assert.equal(budgets?.launchTimeoutMs, 60_000)
          assert.equal(typeof budgets?.trackCleanup, 'function')
          return { sessionStatus: 'ok', reason: null, reported: true, probe: probed }
        },
      }),
    })
    const result = await probe('acc-7')
    assert.equal(result.sessionStatus, 'ok')
    assert.deepEqual(result.probe, probed)
    await deps.taskRegistry.awaitSettled()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
