/**
 * dispose 全任务收口的确定性测试（node --test）：
 * 登录/单账号采集/批量采集挂起时 dispose 统一 abort 并等待 settle；dispose 后
 * 新 action 稳定拒绝（plugin_disposing）；晚 factory 清理被等待；runs.json
 * 损坏不阻塞 dispose；全程断言 activeCount 归零、profile lock 无残留、
 * loginSignals/collectSignals 清空、无 unhandled rejection。
 * 断言全部基于 Promise gate / 锁计数 / registry 计数，不用 sleep 裁决。
 * 运行：`node --test tests/dispose.test.ts`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { isProfileLocked } from '../src/locks.ts'
import { createBatchCollectController } from '../src/collect-all.ts'
import { buildRouteHandlers, createWxHostDeps } from '../src/handlers.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { createRouteHandler } from '../src/route.ts'
import { readRuns } from '../src/runs.ts'
import { probeAndReport } from '../src/probe.ts'
import { runCollection } from '../src/runner.ts'
import type { ChromeFactory } from '../src/session.ts'
import type { WxWorkbenchFace } from '../src/ingest.ts'

// unhandled rejection 收集（文件末尾统一断言为 0）。
const unhandled: unknown[] = []
process.on('unhandledRejection', reason => { unhandled.push(reason) })

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

async function waitForCondition(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('waitForCondition timeout')
    await sleep(5)
  }
}

function timeoutReject(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => { setTimeout(() => reject(new Error(message)), ms).unref() })
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const winner = await Promise.race([promise.then(() => 'settled', () => 'settled'), sleep(0).then(() => 'pending')])
  return winner === 'settled'
}

function authDataBody(accountId: string): string {
  return JSON.stringify({ errCode: 0, data: { finderUser: { finderUsername: accountId, nickname: `n-${accountId}`, headImgUrl: '', fansCount: 2, feedsCount: 3 } } })
}

function makeEnv(prefix: string, accounts: Array<{ id: string; storage?: boolean }>): string {
  const root = makeRoot(prefix)
  const records: Record<string, unknown> = {}
  for (const account of accounts) {
    records[account.id] = { accountId: account.id, sessionStatus: 'ok', sessionSeq: 1 }
    if (account.storage !== false) {
      mkdirSync(join(root, 'storage-state'), { recursive: true })
      writeFileSync(join(root, 'storage-state', `${account.id}.json`), '{"cookies":[]}', { mode: 0o600 })
    }
  }
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify({ accounts: records }, null, 2)}\n`, { mode: 0o600 })
  return root
}

interface AccountScript {
  authAs?: string
  /** collect 本体（该账号第 3 次调用）page.goto 挂起；signalOf 给出的 signal abort 时 goto 失败（模拟 Playwright context closed）。 */
  collectGoto?: { entered?: Promise<void> }
}

/**
 * 调用序：probe(1) → runCollection 内 probe(2) → collect 本体(3)。
 * goto gate 由 signalOf(accountId) 的 signal abort 驱动——dispose/cancel 的
 * abort 立刻让 goto 失败，runCollection 走取消分支。
 */
function makeAbortAwareFactory(scripts: Record<string, AccountScript>, signalOf: (accountId: string) => AbortSignal | undefined): ChromeFactory {
  const calls = new Map<string, number>()
  return async options => {
    const accountId = basename(options.profileDir)
    const script = scripts[accountId] ?? {}
    const callNo = (calls.get(accountId) ?? 0) + 1
    calls.set(accountId, callNo)
    const isCollectBody = callNo === 3
    const page = {
      goto: async () => {
        if (isCollectBody && script.collectGoto !== undefined) {
          script.collectGoto.entered?.()
          const signal = signalOf(accountId)
          await new Promise<void>((resolve, reject) => {
            if (signal === undefined) { resolve(); return }
            if (signal.aborted) { reject(new Error('goto aborted')); return }
            signal.addEventListener('abort', () => { reject(new Error('goto aborted')) }, { once: true })
          })
        }
      },
      evaluate: async (_fn: unknown, arg: { url: string }) => {
        if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) return { status: 200, text: authDataBody(script.authAs ?? accountId) }
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
  }
}

function buildHandlers(root: string, chromeFactory: ChromeFactory, logger?: { warnings: string[] }, workbench?: WxWorkbenchFace) {
  const deps = createWxHostDeps({
    root,
    workbench: workbench ?? { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: logger ? { warn: (message: string) => { logger.warnings.push(message) } } : { warn: () => undefined },
    chromeFactory,
  })
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  return { deps, handlers: buildRouteHandlers(deps, batch as never) as Record<string, (args: Record<string, string>) => Promise<object>> }
}

async function callHandler(handlers: Record<string, (args: Record<string, string>) => Promise<object>>, action: string, args: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const handler = handlers[action]
  assert.ok(handler !== undefined, `handler ${action} 必须存在`)
  return await handler(args) as Record<string, unknown>
}

// --- 1. 登录挂起时 dispose ---

test('dispose：挂起登录被 abort 并 settle，context close、临时 profile 清理、signals 清空', async () => {
  const root = makeRoot('wx-dp-login')
  const closeCalled = deferred<void>()
  // 登录 factory：context 打开（cookies 空 → 轮询等待），abort 后 waitForSessionCookie 立即退出。
  const factory: ChromeFactory = async options => {
    const page = {
      goto: async () => undefined,
      evaluate: async (_fn: unknown, arg: { url: string }) => {
        if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) return { status: 200, text: authDataBody('acc1') }
        return { status: 500, text: '' }
      },
    }
    return {
      context: {
        pages: () => [page],
        newPage: async () => page,
        cookies: async () => [],
        storageState: async () => ({ cookies: [], origins: [] }),
        close: async () => { closeCalled.resolve() },
      } as never,
    }
    void options
  }
  const { deps, handlers } = buildHandlers(root, factory)

  const begin = await callHandler(handlers, 'account.beginLogin', { accountId: 'acc1' })
  assert.equal(begin.status, 'ok')
  // 登录已进入轮询阶段（onPage 回调同步置 waiting_confirm），controller 已登记。
  await waitForCondition(() => deps.loginRuns.get('acc1')?.state === 'waiting_confirm')
  assert.equal(deps.loginSignals.has('acc1'), true)
  assert.ok(deps.taskRegistry.activeCount >= 1, '登录任务应已登记')

  await disposeHostTasks({ deps, batch: { stop() {} } })

  assert.equal(deps.loginSignals.size, 0, 'loginSignals 清空')
  assert.equal(deps.loginRuns.get('acc1')?.state, 'timeout', 'abort 后登录 settle（timeout 分支 close+清理）')
  await Promise.race([closeCalled.promise, timeoutReject(1000, 'context 未 close')])
  assert.equal(isProfileLocked('acc1'), false, '无 profile lock 残留')
  const pendingLeft = existsSync(join(root, 'profiles'))
    ? readdirSync(join(root, 'profiles')).filter(name => name.startsWith('pending-'))
    : []
  assert.deepEqual(pendingLeft, [], '无 pending-* 残留')
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 2. 单账号 collect 挂起时 dispose ---

test('dispose：挂起单账号采集被 abort 并 settle，锁释放、cancelled 已落盘、signals 清空', async () => {
  const root = makeEnv('wx-dp-collect', [{ id: 'acc1' }])
  const gotoEntered = deferred<void>()
  let depsRef: ReturnType<typeof createWxHostDeps> | undefined
  const factory = makeAbortAwareFactory(
    { acc1: { collectGoto: { entered: gotoEntered.resolve } } },
    id => depsRef?.collectSignals.get(id)?.signal,
  )
  const { deps, handlers } = buildHandlers(root, factory)
  depsRef = deps

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise
  assert.ok(deps.taskRegistry.activeCount >= 1, '采集任务应已登记')

  await disposeHostTasks({ deps, batch: { stop() {} } })

  assert.equal(deps.collectSignals.size, 0, 'collectSignals 清空')
  assert.equal(isProfileLocked('acc1'), false, 'profile lock 无残留')
  // dispose 后 handler 稳定拒绝（plugin_disposing），状态改由 deps 直读。
  assert.equal(deps.collectBusy, false)
  assert.equal((deps.collectRecord as { status?: string } | null)?.status, 'cancelled')
  const runs = await readRuns(root)
  const records = Object.values(runs)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.status, 'cancelled', '终态写已在 dispose 等待期间完成')
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 3. batch 多账号执行中 dispose ---

test('dispose：batch 当前账号 abort、后续账号 skipped、整体 run settle', async () => {
  const root = makeEnv('wx-dp-batch', [{ id: 'acc1' }, { id: 'acc2' }])
  const gotoEntered = deferred<void>()
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const registry = deps.taskRegistry
  const activeSignals = new Map<string, AbortSignal>()
  const factory = makeAbortAwareFactory(
    { acc1: { collectGoto: { entered: gotoEntered.resolve } } },
    id => activeSignals.get(id),
  )

  const batch = createBatchCollectController({
    collect: async input => {
      const { runCollection } = await import('../src/runner.ts')
      activeSignals.set(input.accountId, input.signal)
      return registry.track(runCollection({
        workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
        accountId: input.accountId, root,
        logger: deps.logger, signal: input.signal, taskRegistry: registry,
        chromeFactory: factory,
      }))
    },
    probe: async accountId => registry.runTracked(() => probeAndReport(deps.workbench, accountId, root, factory)),
    logger: deps.logger,
    trackRun: promise => { registry.track(promise) },
  })
  const handlers = buildRouteHandlers(deps, batch as never) as Record<string, (args: Record<string, string>) => Promise<object>>

  const started = await callHandler(handlers, 'collectAll.start', {})
  assert.equal(started.started, true)
  await gotoEntered.promise
  assert.equal(batch.status.phase, 'collecting')
  assert.equal(batch.status.currentAccountId, 'acc1')

  await disposeHostTasks({ deps, batch })

  assert.equal(batch.status.phase, 'finished', 'batch 整体 run settle')
  assert.equal(batch.status.items[0]?.status, 'cancelled', '当前账号 aborted')
  assert.equal(batch.status.items[1]?.status, 'skipped', '后续账号 skipped')
  assert.equal(isProfileLocked('acc1'), false)
  assert.equal(isProfileLocked('acc2'), false)
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 4. dispose 后新 action 拒绝 ---

test('dispose：横跨 dispose 全程的 collect.start 在 probe 后被复查拦截（started=false）', async () => {
  const root = makeEnv('wx-dp-race', [{ id: 'acc1' }])
  const probeEntered = deferred<void>()
  const probeGate = deferred<void>()
  // factory call1（handler probe）挂 gate：collect.start 卡在 probeAndReport（已登记），
  // dispose 必须等它 settle；释放后 collect.start 在 probe 后的 disposing 复查处被拦截。
  const calls = new Map<string, number>()
  const factory: ChromeFactory = async options => {
    const accountId = basename(options.profileDir)
    const callNo = (calls.get(accountId) ?? 0) + 1
    calls.set(accountId, callNo)
    const page = {
      goto: async () => undefined,
      evaluate: async (_fn: unknown, arg: { url: string }) => {
        if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) {
          if (callNo === 1) {
            probeEntered.resolve()
            await probeGate.promise
          }
          return { status: 200, text: authDataBody(accountId) }
        }
        return { status: 500, text: '' }
      },
    }
    return {
      context: {
        pages: () => [page],
        newPage: async () => page,
        cookies: async () => [{ name: 'sessionid', value: 'v' }],
        storageState: async () => ({ cookies: [], origins: [] }),
        close: async () => undefined,
      } as never,
    }
  }
  const { deps, handlers } = buildHandlers(root, factory)

  const collect = callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  await probeEntered.promise
  // dispose 启动（disposing 已置位）并等待被登记的 probe settle。
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  probeGate.resolve()
  await Promise.race([disposePromise, timeoutReject(5000, 'dispose 未收敛')])
  const result = await collect
  assert.equal(result.status, 'ok')
  assert.equal(result.started, false)
  assert.equal(result.reason, 'plugin_disposing', `实际: ${JSON.stringify(result)}`)
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  const runs = await readRuns(root)
  assert.deepEqual(Object.keys(runs), [], '拦截后不得产生 runs 记录')
  assert.equal(isProfileLocked('acc1'), false)
  cleanup(root)
})

test('dispose：新 Host action 稳定拒绝（plugin_disposing）', async () => {
  const root = makeEnv('wx-dp-reject', [{ id: 'acc1' }])
  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined))
  await disposeHostTasks({ deps, batch: { stop() {} } })
  const probe = await callHandler(handlers, 'account.probe', { accountId: 'acc1' })
  assert.deepEqual(probe, { status: 'error', reason: 'plugin_disposing' })
  const status = await callHandler(handlers, 'collect.status', {})
  assert.equal(status.reason, 'plugin_disposing')
  const begin = await callHandler(handlers, 'account.beginLogin', { accountId: 'acc1' })
  assert.equal(begin.reason, 'plugin_disposing')
  cleanup(root)
})

// --- 5. 晚 factory 清理被 dispose 等待 ---

test('dispose：晚 factory resolve 的清理（close+二次清理）被等待完成', async () => {
  const root = makeRoot('wx-dp-late')
  const controller = new AbortController()
  const factoryEntered = deferred<void>()
  const cleanupCloseEntered = deferred<void>()
  const cleanupGate = deferred<void>()
  const { loginWithQrCode } = await import('../src/session.ts')
  let lateProfileDir = ''

  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
  })
  const factory: ChromeFactory = async options => {
    factoryEntered.resolve()
    const signal = controller.signal
    while (!signal.aborted) await sleep(5)
    mkdirSync(options.profileDir, { recursive: true })
    lateProfileDir = options.profileDir
    const context = {
      pages: () => [],
      newPage: async () => ({ goto: async () => undefined }),
      cookies: async () => [],
      storageState: async () => ({ cookies: [] }),
      close: async () => { cleanupCloseEntered.resolve(); await cleanupGate.promise },
    }
    return { context } as never
  }

  // 清理 promise 在登录启动时即经 trackCleanup 登记到 deps 的 registry。
  const loginPromise = loginWithQrCode({
    root, signal: controller.signal, chromeFactory: factory,
    trackCleanup: promise => { deps.taskRegistry.track(promise) },
  })
  await factoryEntered.promise
  assert.ok(deps.taskRegistry.activeCount >= 1, '清理 promise 应已登记')

  // 与 dispose 并行：dispose abort → factory 晚 resolve → 清理钩子 close 挂 gate → dispose 等待。
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  controller.abort()

  // 清理钩子已运行到 close（挂 gate）：dispose 此刻必须仍未返回。
  await cleanupCloseEntered.promise
  assert.equal(await isSettled(disposePromise), false, '晚 factory 清理未 settle 前 dispose 不得返回')

  cleanupGate.resolve()
  await Promise.race([disposePromise, timeoutReject(5000, 'dispose 未等待清理完成')])
  await loginPromise
  assert.equal(existsSync(lateProfileDir), false, '晚 resolve 的 pending profile 已被二次清理')
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 6. runs.json 损坏不阻塞 dispose ---

test('dispose：runs.json 损坏（写失败）不阻塞 dispose，错误可见且任务 settle', async () => {
  const root = makeEnv('wx-dp-corrupt', [{ id: 'acc1' }])
  const gotoEntered = deferred<void>()
  let depsRef: ReturnType<typeof createWxHostDeps> | undefined
  const factory = makeAbortAwareFactory(
    { acc1: { collectGoto: { entered: gotoEntered.resolve } } },
    id => depsRef?.collectSignals.get(id)?.signal,
  )
  const logger = { warnings: [] as string[] }
  const { deps, handlers } = buildHandlers(root, factory, logger)
  depsRef = deps
  mkdirSync(join(root, 'runs.json'), { recursive: true })

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise

  await Promise.race([disposeHostTasks({ deps, batch: { stop() {} } }), timeoutReject(15000, 'runs.json 损坏阻塞了 dispose')])
  assert.ok(logger.warnings.some(message => message.includes('final state write failed')), '终态写失败必须 warn 可见')
  assert.equal(deps.taskRegistry.activeCount, 0, '损坏场景任务仍 settle、active count 归零')
  assert.equal(isProfileLocked('acc1'), false)
  cleanup(root)
})

// --- 7. route 层 dispose 拒绝（经 createRouteHandler 包装后仍生效） ---

test('dispose：route 包装层的新请求同样被 plugin_disposing 拒绝', async () => {
  const root = makeEnv('wx-dp-route', [{ id: 'acc1' }])
  const { deps } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined))
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  const routeHandler = createRouteHandler(() => 'http://127.0.0.1:1', buildRouteHandlers(deps, batch as never))
  await disposeHostTasks({ deps, batch })

  const responded: Array<{ status: number; payload: Record<string, unknown> }> = []
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (body?: string) => {
      responded.push({ status: res.statusCode, payload: JSON.parse(body ?? '{}') as Record<string, unknown> })
    },
  }
  const req = {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ action: 'account.probe', accountId: 'acc1' }), 'utf8')
    },
  } as never
  await routeHandler(req as never, res as never)
  assert.equal(responded[0]?.payload.reason, 'plugin_disposing', `实际: ${JSON.stringify(responded[0])}`)
  cleanup(root)
})

// --- 8. apply 效果注册/释放顺序（Cordis 逆序释放语义确认） ---

test('apply：dispose effect 先注册、route 后注册（Cordis 逆序释放 → route 先卸载）', async () => {
  const root = makeRoot('wx-dp-apply')
  const effects: Array<{ name: string; disposer: () => Promise<void> | void }> = []
  const routeDisposed = deferred<void>()
  const ctx = {
    logger: { warn: () => undefined },
    effect: (factory: () => unknown, name: string) => {
      const disposer = factory()
      let wrapped = disposer
      if (name.includes('route') && typeof disposer === 'function') {
        wrapped = async () => { await (disposer as () => Promise<void> | void)(); routeDisposed.resolve() }
      }
      effects.push({ name, disposer: typeof wrapped === 'function' ? wrapped as () => Promise<void> | void : () => undefined })
    },
    webServer: { register: () => async () => undefined },
    yootunWorkbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
  }
  const { apply } = await import('../src/index.ts')
  apply(ctx as never, { stateDir: root })

  assert.ok(effects.length >= 2, `应注册至少两个 effect，实际 ${String(effects.length)}`)
  assert.ok(effects[0]?.name.includes('dispose'), `dispose effect 应先注册，实际顺序: ${JSON.stringify(effects.map(e => e.name))}`)
  assert.ok(effects[effects.length - 1]?.name.includes('route'), 'route effect 应最后注册')
  // Cordis 逆序释放：route（后注册）先卸载，dispose（先注册）后执行——dispose
  // 期间路由已不再接受新请求。
  for (const effect of [...effects].reverse()) await effect.disposer()
  await Promise.race([routeDisposed.promise, timeoutReject(3000, 'route disposer 未执行')])
  cleanup(root)
})

// --- 9. unhandled rejection 兜底断言 ---

test('dispose 全场景无 unhandled rejection', async () => {
  await sleep(50)
  assert.deepEqual(unhandled, [], `unhandled rejections: ${JSON.stringify(unhandled)}`)
})
