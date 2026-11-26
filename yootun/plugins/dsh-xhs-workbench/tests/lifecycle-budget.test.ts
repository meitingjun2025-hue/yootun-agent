/**
 * 生命周期时间预算测试（node --test，实施单 host-lifecycle-budget 附录 B
 * G1–G5）：awaitSettled 预算、dispose 预算耗尽、closeContext 关闭预算、
 * launchWithTimeout 启动预算、发布（publishDraft）的登记/启动超时锁释放与
 * 迟到 context 清理。G6（既有 dispose 用例在新预算下通过）由 dispose/host
 * 既有文件承载。
 * 运行：`node --test tests/lifecycle-budget.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserLaunchTimeoutError, closeContext, launchWithTimeout, type ChromeFactory } from '../src/chrome.ts'
import { safeCode } from '../src/errors.ts'
import { createTaskRegistry, disposeHostTasks } from '../src/lifecycle.ts'
import { buildRouteHandlers, createXhsHostDeps } from '../src/handlers.ts'
import { createFakeChrome, sessionCookie, userInfoPayload } from './fakes.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-budget-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => { setTimeout(() => reject(new Error(message)), ms).unref() })
}

async function waitForCondition(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() > deadline) throw new Error('waitForCondition timeout')
    await sleep(5)
  }
}

test('G1 awaitSettled(50)：永不 settle 的任务在预算处返回 exhausted；无任务立即返回', async () => {
  const registry = createTaskRegistry()
  const never = Promise.withResolvers<void>()
  registry.track(never.promise)
  const started = Date.now()
  const outcome = await registry.awaitSettled(50)
  const elapsed = Date.now() - started
  assert.deepEqual(outcome, { exhausted: true, pending: 1 })
  assert.ok(elapsed >= 40 && elapsed < 500, `应在预算附近返回，实际 ${String(elapsed)}ms`)
  never.resolve()
  await registry.awaitSettled()
  // 无任务：立即返回，不空等预算。
  const empty = await createTaskRegistry().awaitSettled(50)
  assert.deepEqual(empty, { exhausted: false, pending: 0 })
})

test('G1 awaitSettled 预算按注入 now 计算，唤醒用真实计时器', async () => {
  let clock = 0
  const registry = createTaskRegistry({ now: () => clock })
  const gate = Promise.withResolvers<void>()
  registry.track(gate.promise)
  // 入口先按 now 记起点（start=0），等待期间推进 now：下一轮剩余预算为负，
  // 按预算返回 exhausted；唤醒来自真实计时器（100ms 一轮）。
  const pending = registry.awaitSettled(100)
  clock = 1000
  assert.deepEqual(await pending, { exhausted: true, pending: 1 })
  gate.resolve()
  await registry.awaitSettled()
})

test('G2 dispose 预算耗尽：告警且 signals 已清空；挂起任务随后 settle 时 finally 执行', async () => {
  const registry = createTaskRegistry()
  const deps = {
    disposing: false,
    loginSignals: new Map([['l1', new AbortController()]]),
    probeSignals: new Map<string, AbortController>(),
    collectSignals: new Map([['c1', new AbortController()]]),
    taskRegistry: registry,
  }
  const gate = Promise.withResolvers<void>()
  let finallyRan = false
  const task = gate.promise.finally(() => { finallyRan = true })
  registry.track(task)
  const warnings: string[] = []
  await disposeHostTasks({ deps }, { disposeBudgetMs: 50, warn: message => { warnings.push(message) } })
  assert.equal(deps.disposing, true)
  assert.equal(deps.loginSignals.size + deps.probeSignals.size + deps.collectSignals.size, 0, '预算耗尽后信号表仍清空')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /lifecycle: dispose budget exhausted, 1 tasks pending/)
  assert.equal(finallyRan, false, 'dispose 返回时挂起任务尚未 settle')
  gate.resolve()
  await registry.awaitSettled()
  assert.equal(finallyRan, true)
  assert.equal(registry.activeCount, 0)
})

test('G3 closeContext：正常关闭不触发 onTimeout；挂起的 close 超时触发 onTimeout 并 resolve', async () => {
  let timedOut = false
  let closed = false
  await closeContext({ close: async () => { closed = true } }, 1000, () => { timedOut = true })
  assert.equal(closed, true)
  assert.equal(timedOut, false)
  // 挂起的 close：closeContext 在预算处返回（close 永不 settle 也不悬挂调用方）。
  const gate = Promise.withResolvers<void>()
  const started = Date.now()
  await closeContext({ close: () => gate.promise }, 40, () => { timedOut = true })
  const elapsed = Date.now() - started
  assert.equal(timedOut, true)
  assert.ok(elapsed >= 30 && elapsed < 500, `应在预算附近返回，实际 ${String(elapsed)}ms`)
  gate.resolve()
  // close 抛错：旁路消费，closeContext 永不抛。
  timedOut = false
  await closeContext({ close: async () => { throw new Error('close failed') } }, 100, () => { timedOut = true })
  assert.equal(timedOut, false)
})

test('G4 launchWithTimeout：超时抛 BrowserLaunchTimeoutError（safeCode → browser_launch_timeout），迟到结果被关闭', async () => {
  const late = Promise.withResolvers<{ close(): Promise<void> }>()
  let closed = false
  let lateCleaned = false
  setTimeout(() => { late.resolve({ close: async () => { closed = true } }) }, 60)
  let caught: unknown = null
  try {
    await launchWithTimeout(() => late.promise, 40, result => {
      lateCleaned = true
      return result.close()
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BrowserLaunchTimeoutError, '超时必须抛 BrowserLaunchTimeoutError')
  assert.equal(safeCode(caught), 'browser_launch_timeout')
  await late.promise
  // 迟到的启动结果被 onLateResult 立即关闭。
  const deadline = Date.now() + 2000
  while (!(lateCleaned && closed) && Date.now() < deadline) await sleep(10)
  assert.equal(lateCleaned, true)
  assert.equal(closed, true)
  // 预算内成功：结果原样返回。
  assert.equal(await launchWithTimeout(() => Promise.resolve('ok'), 1000), 'ok')
})

test('G5 publish：dispose 等待挂起的 publishDraft 至预算；浏览器保持打开语义不变', async () => {
  const root = await tempRoot()
  try {
    const fake = createFakeChrome()
    fake.state.profileJson = userInfoPayload('acc-p', '账号P', null)
    const gate = Promise.withResolvers<void>()
    const factory: ChromeFactory = async () => {
      await gate.promise
      return { context: fake.context }
    }
    const deps = createXhsHostDeps({
      root,
      browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
      logger: { warn: () => undefined },
      chromeFactory: factory,
    })
    const handlers = buildRouteHandlers(deps)
    const started = await handlers['publish.start']!({ accountId: 'acc-p', target: 'image', idempotencyKey: 'k-1' }) as Record<string, unknown>
    assert.equal(started.status, 'started')
    assert.ok(deps.taskRegistry.activeCount >= 1, '发布 promise 已纳入登记表')
    const warnings: string[] = []
    await Promise.race([
      disposeHostTasks({ deps }, { disposeBudgetMs: 60, warn: message => { warnings.push(message) } }),
      timeoutReject(5000, 'dispose 未按预算返回'),
    ])
    assert.match(warnings[0] ?? '', /lifecycle: dispose budget exhausted, 1 tasks pending/)
    // 释放挂起的 Chrome 启动：发布完成（浏览器保持打开 → 锁随 context 生命周期保持）。
    gate.resolve()
    await waitForCondition(() => deps.taskRegistry.activeCount === 0)
    const run = deps.publishRuns.get(String(started.publishId))
    assert.equal(run?.status, 'completed')
    assert.equal(deps.locks.isProfileLocked('acc-p'), true, '浏览器保持打开：锁保持到用户关闭')
    fake.context.close()
    await waitForCondition(() => !deps.locks.isProfileLocked('acc-p'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('G5 publish：启动超预算后锁释放、account.probe 不再 PROFILE_BUSY、迟到 context 被关闭', async () => {
  const root = await tempRoot()
  try {
    await mkdir(join(root, 'storage-state'), { recursive: true })
    await writeFile(join(root, 'storage-state', 'acc-p.json'), '{"cookies":[]}', { mode: 0o600 })
    const lateGate = Promise.withResolvers<void>()
    let lateCloseCount = 0
    const hangingFactory: ChromeFactory = async () => {
      await lateGate.promise
      return {
        context: {
          cookies: async () => [],
          newPage: async () => { throw new Error('late context must be closed, not used') },
          pages: () => [],
          close: async () => { lateCloseCount += 1 },
          once: () => undefined,
          storageState: async () => ({ cookies: [] }),
        },
      }
    }
    const deps = createXhsHostDeps({
      root,
      browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
      logger: { warn: () => undefined },
      chromeFactory: hangingFactory,
    })
    deps.launchTimeoutMs = 40
    const handlers = buildRouteHandlers(deps)
    const started = await handlers['publish.start']!({ accountId: 'acc-p', target: 'image', idempotencyKey: 'k-2' }) as Record<string, unknown>
    await waitForCondition(() => deps.publishRuns.get(String(started.publishId))?.status === 'failed')
    const run = deps.publishRuns.get(String(started.publishId))
    assert.equal(run?.error, 'PUBLISH_FAILED', `实际: ${String(run?.error)}`)
    assert.equal(deps.locks.isProfileLocked('acc-p'), false, '启动超时后锁由 finally 释放')
    // 锁已释放：account.probe 不再返回 PROFILE_BUSY（注入可成功的 factory 实测）。
    const probeFake = createFakeChrome()
    probeFake.state.cookies = sessionCookie()
    probeFake.state.profileJson = userInfoPayload('acc-p', '账号P', null)
    deps.chromeFactory = probeFake.factory
    const probe = await handlers['account.probe']!({ accountId: 'acc-p' }) as Record<string, unknown>
    assert.equal(probe.status, 'ready')
    assert.equal(probe.sessionStatus, 'ok')
    // 迟到的启动结果：仍被立即关闭，锁不复活（release 幂等）。
    lateGate.resolve()
    await waitForCondition(() => lateCloseCount >= 1)
    assert.equal(deps.locks.isProfileLocked('acc-p'), false, '迟到 context 关闭后锁保持释放')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
