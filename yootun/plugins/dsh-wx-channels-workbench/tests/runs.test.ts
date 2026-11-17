/**
 * runs.json 状态机确定性测试（node --test）：
 * 1. 并发写：不同 attemptId 两条都保留、同 attemptId 并发 patch 串行合并；
 * 2. 同一条记录：start → progress → 终态（completed/failed/cancelled）全程
 *    更新同 key，startedAt 等字段保留；
 * 3. 重启恢复：recoverInterruptedRuns 只动 running，终态不动；
 * 4. 账号删除：removeAccountRuns 按 accountId 一次性清理；
 * 5. 集成（buildRouteHandlers + deps.chromeFactory 注入）：collect.status 合并
 *    内存与持久化态、取消后同一条记录 running→cancelled、probe 失败不留
 *    runs 记录（无幻影 interrupted）、终态写失败可见（warn + 进度事件）。
 * 断言全部基于文件内容/锁计数/Promise gate，不用 sleep 时长裁决并发。
 * 运行：`node --test tests/runs.test.ts`
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createAttemptId, readRuns, recoverInterruptedRuns, removeAccountRuns, updateRun } from '../src/runs.ts'
import { buildRouteHandlers, createWxHostDeps } from '../src/handlers.ts'
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

/** auth_data CGI 的合法响应体（parseAuthData 输入形状；errCode=0 是会话有效判据）。 */
function authDataBody(accountId: string): string {
  return JSON.stringify({ errCode: 0, data: { finderUser: { finderUsername: accountId, nickname: `n-${accountId}`, headImgUrl: '', fansCount: 2, feedsCount: 3 } } })
}

function makeEnv(prefix: string, accountId: string): string {
  const root = makeRoot(prefix)
  mkdirSync(join(root, 'storage-state'), { recursive: true })
  writeFileSync(join(root, 'storage-state', `${accountId}.json`), '{"cookies":[]}', { mode: 0o600 })
  writeFileSync(join(root, 'accounts.json'), `${JSON.stringify({ accounts: { [accountId]: { accountId, sessionStatus: 'ok', sessionSeq: 1 } } }, null, 2)}\n`, { mode: 0o600 })
  return root
}

interface AccountScript {
  authAs?: string
  /** 从第 N 次调用起 factory 直接抛 GOOGLE_CHROME_MISSING。 */
  failFromCall?: number
  /** collect 本体（该账号第 3 次调用）page.goto 的 gate。 */
  collectGoto?: { gate: Promise<void>; entered?: Promise<void> }
}

/** 调用序：handler probe(1) → runCollection 内 probe(2) → collect 本体(3)。 */
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
    const isCollectBody = callNo === 3
    const page = {
      goto: async () => {
        if (isCollectBody && script.collectGoto !== undefined) {
          script.collectGoto.entered?.()
          await script.collectGoto.gate
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

function buildHandlers(root: string, chromeFactory: ChromeFactory, logger?: { warnings: string[] }): { deps: ReturnType<typeof createWxHostDeps>; handlers: Record<string, (args: Record<string, string>) => Promise<object>> } {
  const deps = createWxHostDeps({
    root,
    workbench: { callTool: async () => ({ structuredContent: {}, content: [] }) },
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

// --- 1. 并发写 ---

test('runs.json：并发 updateRun 两个 attemptId 两条都保留（不丢写）', async () => {
  const root = makeRoot('wx-runs-conc')
  const a = createAttemptId('a')
  const b = createAttemptId('b')
  await Promise.all([
    updateRun(root, 'a', a, { progress: { phase: 'probing' } }),
    updateRun(root, 'b', b, { progress: { phase: 'probing' } }),
  ])
  const runs = await readRuns(root)
  assert.equal(runs[a]?.accountId, 'a')
  assert.equal(runs[b]?.accountId, 'b')
  cleanup(root)
})

test('runs.json：同一 attemptId 并发 patch 经串行队列合并（字段互不覆盖）', async () => {
  const root = makeRoot('wx-runs-merge')
  const attempt = createAttemptId('acc1')
  await updateRun(root, 'acc1', attempt, { progress: { phase: 'probing' } })
  // 并发 6 个 patch，各写不同字段：RMW 串行队列保证全部效果在场。
  await Promise.all([
    updateRun(root, 'acc1', attempt, { runId: 'remote-run-9' }),
    updateRun(root, 'acc1', attempt, { progress: { phase: 'list' } }),
    updateRun(root, 'acc1', attempt, { progress: { phase: 'details', done: 3, total: 9 } }),
    updateRun(root, 'acc1', attempt, { error: null }),
    updateRun(root, 'acc1', attempt, { progress: { phase: 'ingest', batchNo: 1 } }),
    updateRun(root, 'acc1', attempt, { status: 'completed', finishedAt: new Date().toISOString() }),
  ])
  const runs = await readRuns(root)
  const record = runs[attempt]
  assert.ok(record !== undefined)
  assert.equal(Object.keys(runs).length, 1, '同 attemptId 只有一条记录')
  assert.equal(record.accountId, 'acc1')
  assert.equal(record.runId, 'remote-run-9')
  assert.equal(record.status, 'completed')
  assert.equal(record.progress.phase, 'ingest', 'progress 按 settle 顺序最后一个生效')
  cleanup(root)
})

// --- 2. 同一条记录：start → progress → 终态 ---

test('runs.json：start→progress→completed 全程更新同一条记录，startedAt 保留', async () => {
  const root = makeRoot('wx-runs-life')
  const attempt = createAttemptId('acc1')
  const started = await updateRun(root, 'acc1', attempt, { progress: { phase: 'probing' } })
  assert.equal(started.status, 'running')
  await updateRun(root, 'acc1', attempt, { progress: { phase: 'details', done: 1, total: 5 } })
  const finished = await updateRun(root, 'acc1', attempt, { runId: 'remote-run-1', status: 'completed', finishedAt: new Date().toISOString(), error: null })
  assert.equal(finished.status, 'completed')
  assert.equal(finished.startedAt, started.startedAt, 'startedAt 不得被后续更新覆盖')
  const runs = await readRuns(root)
  assert.equal(Object.keys(runs).length, 1)
  const record = runs[attempt]
  assert.equal(record?.runId, 'remote-run-1')
  assert.equal(record?.progress.phase, 'details')
  assert.ok(record?.finishedAt !== null)
  cleanup(root)
})

test('runs.json：failed 与 cancelled 终态更新同一条记录', async () => {
  const root = makeRoot('wx-runs-final')
  const failed = createAttemptId('acc1')
  const cancelled = createAttemptId('acc2')
  await updateRun(root, 'acc1', failed, { progress: { phase: 'list' } })
  const failedRecord = await updateRun(root, 'acc1', failed, { status: 'failed', finishedAt: new Date().toISOString(), error: 'probe_failed' })
  assert.equal(failedRecord.status, 'failed')
  assert.equal(failedRecord.error, 'probe_failed')
  await updateRun(root, 'acc2', cancelled, { progress: { phase: 'details', done: 2, total: 8 } })
  const cancelledRecord = await updateRun(root, 'acc2', cancelled, { status: 'cancelled', finishedAt: new Date().toISOString(), error: 'collect_cancelled' })
  assert.equal(cancelledRecord.status, 'cancelled')
  assert.equal(cancelledRecord.progress.phase, 'details', '取消终态保留最后进度')
  const runs = await readRuns(root)
  assert.equal(runs[failed]?.status, 'failed')
  assert.equal(runs[cancelled]?.status, 'cancelled')
  cleanup(root)
})

// --- 3. 重启恢复 ---

test('runs.json：recoverInterruptedRuns 只把 running 标 interrupted，终态记录不动', async () => {
  const root = makeRoot('wx-runs-recover')
  const running = createAttemptId('acc1')
  const done = createAttemptId('acc1')
  const cancelled = createAttemptId('acc2')
  await updateRun(root, 'acc1', running, { progress: { phase: 'details', done: 4 } })
  await updateRun(root, 'acc1', done, { status: 'completed', finishedAt: new Date().toISOString(), error: null })
  await updateRun(root, 'acc2', cancelled, { status: 'cancelled', finishedAt: new Date().toISOString(), error: 'collect_cancelled' })
  const count = await recoverInterruptedRuns(root)
  assert.equal(count, 1)
  const runs = await readRuns(root)
  assert.equal(runs[running]?.status, 'interrupted')
  assert.equal(runs[running]?.progress.phase, 'details', 'interrupted 保留最后进度')
  assert.equal(runs[done]?.status, 'completed')
  assert.equal(runs[cancelled]?.status, 'cancelled')
  cleanup(root)
})

// --- 4. 账号删除清理 ---

test('runs.json：removeAccountRuns 按 accountId 一次性清理，其他账号保留', async () => {
  const root = makeRoot('wx-runs-remove')
  const a1 = createAttemptId('acc1')
  const a2 = createAttemptId('acc1')
  const b1 = createAttemptId('acc2')
  await updateRun(root, 'acc1', a1, { status: 'completed', finishedAt: new Date().toISOString(), error: null })
  await updateRun(root, 'acc1', a2, { status: 'failed', finishedAt: new Date().toISOString(), error: 'probe_failed' })
  await updateRun(root, 'acc2', b1, { status: 'completed', finishedAt: new Date().toISOString(), error: null })
  const removed = await removeAccountRuns(root, 'acc1')
  assert.equal(removed, 2)
  const runs = await readRuns(root)
  assert.equal(runs[a1], undefined)
  assert.equal(runs[a2], undefined)
  assert.equal(runs[b1]?.accountId, 'acc2', '其他账号记录保留')
  assert.equal(Object.keys(runs).length, 1)
  // 再次清理：幂等返回 0。
  assert.equal(await removeAccountRuns(root, 'acc1'), 0)
  cleanup(root)
})

// --- 5. 集成：collect.status 合并 / 取消 / 幻影 / 终态可见 ---

test('collect.status 合并内存与持久化：取消后 lastRun 与内存 record 是同一条 attemptId', async () => {
  const root = makeEnv('wx-runs-status', 'acc1')
  const gotoEntered = deferred<void>()
  // gate 可 reject：cancel 后让 goto 失败（模拟 Playwright context closed），
  // run 走 catch 的 abort 分支而非继续采集。
  let rejectGoto!: (error: Error) => void
  const gotoGate = new Promise<void>((_, reject) => { rejectGoto = reject })
  const factory = makeFactory({ acc1: { collectGoto: { gate: gotoGate, entered: gotoEntered.resolve } } })
  const { handlers } = buildHandlers(root, factory)

  // 重启后无内存态：collect 为 null，lastRun 为 null（无持久化记录）。
  const status0 = await callHandler(handlers, 'collect.status')
  assert.equal(status0.busy, false)
  assert.equal(status0.collect, null)
  assert.equal(status0.lastRun, null)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise
  // 运行中：内存 running + 持久化 running，同一条 attemptId。
  const status1 = await callHandler(handlers, 'collect.status')
  assert.equal(status1.busy, true)
  const memory = status1.collect as { attemptId: string | null; status: string }
  const persisted = status1.lastRun as { attemptId: string; status: string } | null
  assert.ok(memory.attemptId !== null, '内存 record 应携带 attemptId')
  assert.equal(persisted?.status, 'running')
  assert.equal(persisted?.attemptId, memory.attemptId, '内存与持久化引用同一条记录')

  // 取消：runner 终态写 cancelled（同一条记录），内存同步 cancelled。
  await callHandler(handlers, 'collect.cancel', { accountId: 'acc1' })
  rejectGoto(new Error('goto aborted'))
  await waitForCondition(async () => {
    const status = await callHandler(handlers, 'collect.status')
    return (status.lastRun as { status: string } | null)?.status === 'cancelled'
  }, 5000)
  const status2 = await callHandler(handlers, 'collect.status')
  assert.equal(status2.busy, false)
  const memory2 = status2.collect as { attemptId: string | null; status: string }
  const persisted2 = status2.lastRun as { attemptId: string; status: string; error: string | null }
  assert.equal(memory2.status, 'cancelled')
  assert.equal(persisted2.status, 'cancelled')
  assert.equal(persisted2.error, 'collect_cancelled')
  assert.equal(persisted2.attemptId, memory2.attemptId, '终态仍是同一条 attemptId')
  const runs = await readRuns(root)
  assert.equal(Object.keys(runs).length, 1, '全程只有一条记录，无 pending 占位/分裂')
  cleanup(root)
})

test('collect.start probe 失败不留任何 runs 记录（无幻影 interrupted）', async () => {
  const root = makeEnv('wx-runs-phantom', 'acc1')
  const factory = makeFactory({ acc1: { failFromCall: 1 } })
  const { handlers } = buildHandlers(root, factory)
  const result = await Promise.race([callHandler(handlers, 'collect.start', { accountId: 'acc1' }), timeoutReject(3000, 'collect.start 挂起')])
  assert.equal(result.started, false)
  assert.equal(result.reason, 'probe_failed')
  const runs = await readRuns(root)
  assert.deepEqual(Object.keys(runs), [], 'started=false 不得产生任何 runs 记录')
  const status = await callHandler(handlers, 'collect.status')
  assert.equal(status.lastRun, null)
  cleanup(root)
})

test('collect.status 在重启后（无内存态）提供上次 run 的持久化投影', async () => {
  const root = makeEnv('wx-runs-restart', 'acc1')
  const attempt = createAttemptId('acc1')
  await updateRun(root, 'acc1', attempt, { runId: 'remote-run-5', status: 'completed', finishedAt: new Date().toISOString(), error: null })
  const factory = makeFactory({ acc1: {} })
  const { handlers } = buildHandlers(root, factory)
  const status = await callHandler(handlers, 'collect.status')
  assert.equal(status.busy, false)
  assert.equal(status.collect, null, '新进程无内存态')
  const lastRun = status.lastRun as { attemptId: string; runId: string | null; status: string }
  assert.equal(lastRun.attemptId, attempt)
  assert.equal(lastRun.runId, 'remote-run-5')
  assert.equal(lastRun.status, 'completed')
  cleanup(root)
})

test('终态写失败必须可见：warn 日志 + run_persist_failed 进度事件，内存终态不受影响', async () => {
  const root = makeEnv('wx-runs-visible', 'acc1')
  const gotoEntered = deferred<void>()
  let rejectGoto!: (error: Error) => void
  const gotoGate = new Promise<void>((_, reject) => { rejectGoto = reject })
  const factory = makeFactory({ acc1: { collectGoto: { gate: gotoGate, entered: gotoEntered.resolve } } })
  const logger = { warnings: [] as string[] }
  const { handlers } = buildHandlers(root, factory, logger)

  // runs.json 位置被目录占用：全部 runs 写入确定性失败（EISDIR）。
  mkdirSync(join(root, 'runs.json'), { recursive: true })

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  await gotoEntered.promise
  await callHandler(handlers, 'collect.cancel', { accountId: 'acc1' })
  rejectGoto(new Error('goto aborted'))
  await waitForCondition(async () => {
    const status = await callHandler(handlers, 'collect.status')
    const memory = status.collect as { status: string } | null
    return memory?.status === 'cancelled'
  }, 5000)
  const status = await callHandler(handlers, 'collect.status')
  const memory = status.collect as { status: string; progress: { phase?: string } }
  assert.equal(memory.status, 'cancelled', '内存终态不因持久化失败被覆盖')
  assert.equal(memory.progress.phase, 'run_persist_failed', '进度事件必须暴露终态写失败')
  assert.ok(logger.warnings.some(message => message.includes('final state write failed')), `终态写失败必须产生 warn 日志，实际: ${JSON.stringify(logger.warnings)}`)
  assert.equal(status.lastRun, null, '持久化写失败时 lastRun 不可得（诚实反映）')
  cleanup(root)
})
