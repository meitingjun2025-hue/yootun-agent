/**
 * dispose 全任务收口的确定性测试（node --test）：
 * 登录/单账号采集/批量采集挂起时 dispose 统一 abort 并等待 settle（批量含多
 * 账号并发在途场景）；dispose 后新 action 稳定拒绝（plugin_disposing）；晚
 * factory 清理被等待；runs.json 损坏不阻塞 dispose；全程断言 activeCount 归零、
 * profile lock 无残留、loginSignals/collectSignals 清空、无 unhandled rejection。
 * 断言全部基于 Promise gate / 锁计数 / registry 计数，不用 sleep 裁决。
 * 运行：`node --test tests/dispose.test.ts`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createBatchCollectController } from '../src/collect-all.ts'
import { buildRouteHandlers, createWxHostDeps } from '../src/handlers.ts'
import { createCollectController, type CollectController } from '../src/runner.ts'
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
    // 采集本体 = 第 2 次启动：前置探测（probeAndReport）的结果在有效期内被采集复用（collect-probe-reuse）。
    const isCollectBody = callNo === 2
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
  const collect = createCollectController(
    { workbench: deps.workbench, root, chromeFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
  )
  return { deps, handlers: buildRouteHandlers(deps, batch as never, collect) as Record<string, (args: Record<string, string>) => Promise<object>> }
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
  // 登录记录表随卸载清空（mount-restore 2.3 卸载行）：保留 run 对象引用以断言
  // abort 后的 settle 终态（timeout 分支 close+清理）。
  const runRef = deps.loginRuns.get('acc1')

  await disposeHostTasks({ deps, batch: { stop() {} } })

  assert.equal(deps.loginSignals.size, 0, 'loginSignals 清空')
  assert.equal(deps.loginRuns.size, 0, '登录记录表已清空')
  assert.equal(runRef?.state, 'timeout', 'abort 后登录 settle（timeout 分支 close+清理）')
  await Promise.race([closeCalled.promise, timeoutReject(1000, 'context 未 close')])
  assert.equal(deps.locks.isProfileLocked('acc1'), false, '无 profile lock 残留')
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
  assert.equal(deps.locks.isProfileLocked('acc1'), false, 'profile lock 无残留')
  const runs = await readRuns(root)
  const records = Object.values(runs)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.status, 'cancelled', '终态写已在 dispose 等待期间完成')
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 3. batch 多账号执行中 dispose ---

test('dispose：batch 在途账号 abort、后续账号按取消结算、整体 run settle', async () => {
  const root = makeEnv('wx-dp-batch', [{ id: 'acc1' }, { id: 'acc2' }])
  const gotoEntered = deferred<void>()
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
    chromeFactory: makeAbortAwareFactory(
      { acc1: { collectGoto: { entered: gotoEntered.resolve } } },
      id => depsRef?.collectSignals.get(id)?.signal,
    ),
  })
  let depsRef: typeof deps | undefined
  depsRef = deps
  const registry = deps.taskRegistry

  let batchRef: ReturnType<typeof createBatchCollectController>
  const collect: CollectController = createCollectController(
    { workbench: deps.workbench, root, chromeFactory: deps.chromeFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batchRef.running || deps.batchReserved, taskRegistry: registry, signals: deps.collectSignals },
  )
  const batch = createBatchCollectController({
    collect: {
      start: input => collect.start({
        accountId: input.accountId,
        fromBatch: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
      wait: accountId => collect.wait(accountId),
      hasRunning: () => collect.hasRunning(),
    },
    probe: async accountId => registry.runTracked(() => probeAndReport(deps.workbench, accountId, root, deps.locks, deps.chromeFactory)),
    logger: deps.logger,
    trackRun: promise => { registry.track(promise) },
  })
  batchRef = batch
  const handlers = buildRouteHandlers(deps, batch, collect) as Record<string, (args: Record<string, string>) => Promise<object>>

  const started = await callHandler(handlers, 'collectAll.start', {})
  assert.equal(started.started, true)
  await gotoEntered.promise
  assert.equal(batch.status.phase, 'collecting')
  assert.deepEqual(batch.status.runningAccountIds, ['acc1'])
  assert.equal(batch.status.currentAccountId, 'acc1')

  await disposeHostTasks({ deps, batch })

  assert.equal(batch.status.phase, 'finished', 'batch 整体 run settle')
  assert.equal(batch.status.error, 'collect_cancelled', 'dispose 取消批次')
  assert.equal(batch.status.items[0]?.status, 'failed', '在途账号 aborted')
  assert.equal(batch.status.items[0]?.reason, 'collect_cancelled')
  assert.equal(batch.status.items[1]?.status, 'failed', '后续账号不启动，按取消结算')
  assert.equal(batch.status.items[1]?.reason, 'collect_cancelled')
  assert.deepEqual(batch.status.runningAccountIds, [])
  assert.equal(batch.status.currentAccountId, null)
  assert.equal(deps.locks.isProfileLocked('acc1'), false)
  assert.equal(deps.locks.isProfileLocked('acc2'), false)
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

// --- 3b. 批量多账号在途并发时 dispose（B13/B18） ---

test('dispose：批量三账号并发在途时 abort 全部、等全部 settle、锁全部释放', async () => {
  const root = makeEnv('wx-dp-batch3', [{ id: 'acc1' }, { id: 'acc2' }, { id: 'acc3' }])
  const entered = [deferred<void>(), deferred<void>(), deferred<void>()]
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
    browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
    logger: { warn: () => undefined },
    chromeFactory: makeAbortAwareFactory(
      {
        acc1: { collectGoto: { entered: entered[0]?.resolve } },
        acc2: { collectGoto: { entered: entered[1]?.resolve } },
        acc3: { collectGoto: { entered: entered[2]?.resolve } },
      },
      id => depsRef3?.collectSignals.get(id)?.signal,
    ),
  })
  let depsRef3: typeof deps | undefined
  depsRef3 = deps
  const registry = deps.taskRegistry

  let batchRef: ReturnType<typeof createBatchCollectController>
  const collect: CollectController = createCollectController(
    { workbench: deps.workbench, root, chromeFactory: deps.chromeFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batchRef.running || deps.batchReserved, taskRegistry: registry, signals: deps.collectSignals },
  )
  const batch = createBatchCollectController({
    collect: {
      start: input => collect.start({
        accountId: input.accountId,
        fromBatch: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      }),
      wait: accountId => collect.wait(accountId),
      hasRunning: () => collect.hasRunning(),
    },
    probe: async accountId => registry.runTracked(() => probeAndReport(deps.workbench, accountId, root, deps.locks, deps.chromeFactory)),
    logger: deps.logger,
    trackRun: promise => { registry.track(promise) },
    // 三 worker 同时取号（零随机 + 零等待接缝），三个采集本体同时挂起在 goto 门上。
    rand: () => 0,
    sleep: () => Promise.resolve(),
  })
  batchRef = batch
  const handlers = buildRouteHandlers(deps, batch, collect) as Record<string, (args: Record<string, string>) => Promise<object>>

  const started = await callHandler(handlers, 'collectAll.start', {})
  assert.equal(started.started, true)
  await Promise.all(entered.map(gate => gate.promise))
  assert.equal(batch.status.phase, 'collecting')
  assert.deepEqual(batch.status.runningAccountIds, ['acc1', 'acc2', 'acc3'], '三账号同时运行')
  assert.equal(batch.status.concurrency, 3)

  await disposeHostTasks({ deps, batch })

  assert.equal(batch.status.phase, 'finished', 'batch 整体 run settle')
  assert.equal(batch.status.error, 'collect_cancelled')
  assert.ok(batch.status.items.every(item => item.status === 'failed' && item.reason === 'collect_cancelled'), `全部条目 collect_cancelled: ${JSON.stringify(batch.status.items)}`)
  assert.deepEqual(batch.status.runningAccountIds, [])
  for (const accountId of ['acc1', 'acc2', 'acc3']) {
    assert.equal(deps.locks.isProfileLocked(accountId), false, `${accountId} 锁释放`)
  }
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
  // dispose 启动（disposing 已置位）并等待被 guard 登记的 probe settle：
  // gate 释放前 dispose 不得返回，且 probe 必须已在登记表中。
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  assert.equal(await isSettled(disposePromise), false, 'probe 未 settle 前 dispose 不得返回')
  assert.ok(deps.taskRegistry.activeCount >= 1, '在途 probe 必须已被 guard 登记等待')
  probeGate.resolve()
  await Promise.race([disposePromise, timeoutReject(5000, 'dispose 未收敛')])
  const result = await collect
  assert.equal(result.status, 'ok')
  assert.equal(result.started, false)
  assert.equal(result.reason, 'plugin_disposing', `实际: ${JSON.stringify(result)}`)
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  const runs = await readRuns(root)
  assert.deepEqual(Object.keys(runs), [], '拦截后不得产生 runs 记录')
  assert.equal(deps.locks.isProfileLocked('acc1'), false)
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
  const accounts = await callHandler(handlers, 'accounts.list', {})
  assert.equal(accounts.reason, 'plugin_disposing')
  const works = await callHandler(handlers, 'works.list', { accountId: 'acc1' })
  assert.equal(works.reason, 'plugin_disposing')
  const rmRemote = await callHandler(handlers, 'account.removeRemote', { accountId: 'acc1' })
  assert.equal(rmRemote.reason, 'plugin_disposing')
  cleanup(root)
})

// --- 4.5 在途读/写 action 被 dispose 等待（guard 层 runTracked 登记） ---

test('dispose：accounts.list 远端调用挂起时 dispose 等待其 settle', async () => {
  const root = makeEnv('wx-dp-list', [{ id: 'acc1' }])
  const listEntered = deferred<void>()
  const listGate = deferred<void>()
  const workbench: WxWorkbenchFace = {
    callTool: async (_caller: string, _domain: string, name: string) => {
      if (name === 'workbench_wx_account_list') {
        listEntered.resolve()
        await listGate.promise
        return { structuredContent: { accounts: [] }, content: [] }
      }
      return { structuredContent: {}, content: [] }
    },
  }
  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined), undefined, workbench)

  const listPromise = callHandler(handlers, 'accounts.list', {})
  await listEntered.promise
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  assert.equal(await isSettled(disposePromise), false, '远端调用未 settle 前 dispose 不得返回')
  assert.ok(deps.taskRegistry.activeCount >= 1, '在途 accounts.list 必须已被登记等待')
  listGate.resolve()
  await Promise.race([disposePromise, timeoutReject(3000, 'dispose 未收敛')])
  await listPromise
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

test('dispose：works.list / run.get passthrough 挂起时 dispose 等待其 settle', async () => {
  const root = makeEnv('wx-dp-pass', [{ id: 'acc1' }])
  const workListEntered = deferred<void>()
  const workListGate = deferred<void>()
  const runGetEntered = deferred<void>()
  const runGetGate = deferred<void>()
  const workbench: WxWorkbenchFace = {
    callTool: async (_caller: string, _domain: string, name: string) => {
      if (name === 'workbench_wx_work_list') {
        workListEntered.resolve()
        await workListGate.promise
        return { structuredContent: { works: [] }, content: [] }
      }
      if (name === 'workbench_wx_collect_run_get') {
        runGetEntered.resolve()
        await runGetGate.promise
        return { structuredContent: { run: {} }, content: [] }
      }
      return { structuredContent: {}, content: [] }
    },
  }
  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined), undefined, workbench)

  const worksPromise = callHandler(handlers, 'works.list', { accountId: 'acc1' })
  const runPromise = callHandler(handlers, 'run.get', { runId: 'r-1' })
  await workListEntered.promise
  await runGetEntered.promise
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  assert.equal(await isSettled(disposePromise), false, 'passthrough 未 settle 前 dispose 不得返回')
  assert.ok(deps.taskRegistry.activeCount >= 2, '两个在途 passthrough 必须均已登记等待')
  workListGate.resolve()
  runGetGate.resolve()
  await Promise.race([disposePromise, timeoutReject(3000, 'dispose 未收敛')])
  await worksPromise
  await runPromise
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

test('dispose：removeRemote 远端删除挂起时 dispose 等待其 settle', async () => {
  const root = makeEnv('wx-dp-rmremote', [{ id: 'acc1', storage: false }])
  const removeEntered = deferred<void>()
  const removeGate = deferred<void>()
  const workbench: WxWorkbenchFace = {
    callTool: async (_caller: string, _domain: string, name: string) => {
      if (name === 'workbench_wx_account_remove') {
        removeEntered.resolve()
        await removeGate.promise
        return { structuredContent: { deleted: true }, content: [] }
      }
      return { structuredContent: {}, content: [] }
    },
  }
  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined), undefined, workbench)

  const rmPromise = callHandler(handlers, 'account.removeRemote', { accountId: 'acc1' })
  await removeEntered.promise
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  assert.equal(await isSettled(disposePromise), false, '远端删除未 settle 前 dispose 不得返回')
  assert.ok(deps.taskRegistry.activeCount >= 1, '在途 removeRemote 必须已被登记等待')
  removeGate.resolve()
  await Promise.race([disposePromise, timeoutReject(3000, 'dispose 未收敛')])
  const result = await rmPromise
  assert.equal(result.status, 'ok')
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
  cleanup(root)
})

test('dispose：removeLocal 的 runs 清理在 root 队列挂起时 dispose 等待其 settle', async () => {
  const root = makeEnv('wx-dp-rmlocal', [{ id: 'acc1' }])
  mkdirSync(join(root, 'profiles', 'acc1'), { recursive: true })
  const queueEntered = deferred<void>()
  const queueGate = deferred<void>()
  const { runInRootQueue } = await import('../src/runs.ts')
  // 占住 runs.json 的 root 队列：removeLocal 的 removeAccountRuns 排队挂起
  // （clearLocalCredentials 的记录删除走 state.ts 独立队列，不受影响）。
  const hold = runInRootQueue(root, async () => {
    queueEntered.resolve()
    await queueGate.promise
  })
  await queueEntered.promise

  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined))
  const rmPromise = callHandler(handlers, 'account.removeLocal', { accountId: 'acc1' })
  // removeLocalAccount 完成（storage_state 已删）后挂在 removeAccountRuns
  // 的 runs 队列排队上（被 hold 占住）。
  await waitForCondition(() => !existsSync(join(root, 'storage-state', 'acc1.json')), 3000)
  const disposePromise = disposeHostTasks({ deps, batch: { stop() {} } })
  assert.equal(await isSettled(disposePromise), false, 'removeLocal 未 settle 前 dispose 不得返回')
  assert.ok(deps.taskRegistry.activeCount >= 1, '在途 removeLocal 必须已被登记等待')
  queueGate.resolve()
  await Promise.race([disposePromise, timeoutReject(3000, 'dispose 未收敛')])
  const result = await rmPromise
  assert.equal(result.removed, true)
  await hold
  assert.equal(deps.taskRegistry.activeCount, 0, 'active count 归零')
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
  assert.equal(deps.locks.isProfileLocked('acc1'), false)
  cleanup(root)
})

// --- 7. route 层 dispose 拒绝（经 createRouteHandler 包装后仍生效） ---

test('dispose：route 包装层的新请求同样被 plugin_disposing 拒绝', async () => {
  const root = makeEnv('wx-dp-route', [{ id: 'acc1' }])
  const { deps, handlers } = buildHandlers(root, makeAbortAwareFactory({ acc1: {} }, () => undefined))
  const batch = {
    get status() { return {} as never },
    get running() { return false },
    start: async () => ({ started: false }),
    stop: () => undefined,
  }
  const routeHandler = createRouteHandler(() => 'http://127.0.0.1:1', handlers)
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
