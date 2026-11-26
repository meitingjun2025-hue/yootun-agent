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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createAttemptId, readRuns, recoverInterruptedRuns, removeAccountRuns, updateRun } from '../src/runs.ts'
import { buildRouteHandlers, createWxHostDeps } from '../src/handlers.ts'
import { createCollectController, runCollection, type CollectResult } from '../src/runner.ts'
import { progressFromEvent } from '../src/runner.ts'
import { createIngestClient, ingestCollectedData, type WxWorkbenchFace } from '../src/ingest.ts'
import { safeCode } from '../src/errors.ts'
import { probeAndReport, PROBE_REUSE_TTL_MS, type ProbedSession, type RefreshedSession } from '../src/probe.ts'
import type { ChromeFactory } from '../src/session.ts'
import { createProfileLocks, type ProfileLocks } from '@yootun/dsh-workbench-host-kit'

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
    // 采集本体 = 第 2 次启动（前置探测结果复用，collect-probe-reuse）。
    const isCollectBody = callNo === 2
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

function buildHandlers(root: string, chromeFactory: ChromeFactory, logger?: { warnings: string[] }, workbench?: WxWorkbenchFace): { deps: ReturnType<typeof createWxHostDeps>; handlers: Record<string, (args: Record<string, string>) => Promise<object>> } {
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

// --- U1–U6 探测复用（collect-probe-reuse；单账号 runCollection 级） ---

/** 计数接缝：统计上报与每账号启动序号（含每次启动时刻的上报数）。 */
function makeReuseInfra(): { workbench: WxWorkbenchFace; factory: ChromeFactory; launches: Map<string, number>; reports: string[]; launchLog: Array<{ accountId: string; launchNo: number; reports: number }> } {
  const launches = new Map<string, number>()
  const reports: string[] = []
  const launchLog: Array<{ accountId: string; launchNo: number; reports: number }> = []
  const workbench: WxWorkbenchFace = {
    callTool: async (_caller: string, _domain: string, name: string) => {
      if (name === 'workbench_wx_session_status_report') reports.push(name)
      return { structuredContent: {}, content: [] }
    },
  } as never
  const factory: ChromeFactory = async options => {
    const accountId = basename(options.profileDir)
    const launchNo = (launches.get(accountId) ?? 0) + 1
    launches.set(accountId, launchNo)
    launchLog.push({ accountId, launchNo, reports: reports.length })
    const page = {
      goto: async () => undefined,
      evaluate: async (_fn: unknown, arg: { url: string }) => {
        if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) return { status: 200, text: authDataBody(accountId) }
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
  return { workbench, factory, launches, reports, launchLog }
}

/** 前置探测（真实 probeAndReport，发 1 次 Chrome + 1 次上报）并返回可复用的 probe。 */
async function frontProbe(infra: ReturnType<typeof makeReuseInfra>, root: string, accountId: string): Promise<{ probe: ProbedSession<RefreshedSession>; reported: boolean }> {
  const locks = createProfileLocks()
  const result = await probeAndReport(infra.workbench, accountId, root, locks, infra.factory)
  return { probe: result.probe, reported: result.reported }
}

/** 直跑 runCollection（U2–U6；绕过 handlers 页面路径）。 */
function runDirect(infra: ReturnType<typeof makeReuseInfra>, root: string, accountId: string, options: { probed?: ProbedSession<RefreshedSession>; now?: () => number } = {}): Promise<CollectResult> {
  const locks: ProfileLocks = createProfileLocks()
  return runCollection({
    workbench: infra.workbench,
    accountId,
    root,
    locks,
    chromeFactory: infra.factory,
    ...(options.probed !== undefined ? { probed: options.probed } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  })
}

test('U1 页面路径复用：前置探测后进入本体（2 次启动），流程内上报跳过', async () => {
  const root = makeEnv('wx-u1', 'acc1')
  try {
    const infra = makeReuseInfra()
    const deps = createWxHostDeps({
      root,
      workbench: infra.workbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: infra.factory,
    })
    const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }), stop: () => undefined }
    const collect = createCollectController(
      { workbench: deps.workbench, root, chromeFactory: infra.factory, logger: deps.logger, locks: deps.locks },
      { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
    )
    const handlers = buildRouteHandlers(deps, batch as never, collect)
    const started = await (handlers['collect.start'] as (args: Record<string, string>) => Promise<Record<string, unknown>>)({ accountId: 'acc1' })
    assert.equal(started.started, true)
    await deps.taskRegistry.awaitSettled()
    assert.deepEqual([...infra.launches.entries()].sort(), [['acc1', 2]], '前置探测 1 次 + 采集本体 1 次')
    const bodyLog = infra.launchLog.filter(item => item.launchNo === 2)
    assert.deepEqual(bodyLog.map(item => item.reports), [1], '本体启动前只有前置探测的 1 次上报（流程内上报已跳过）')
  } finally {
    cleanup(root)
  }
})

test('U2 不传 probed：外部前置探测 + 流程内重探测 + 本体（3 次启动、2 次上报，现状回归）', async () => {
  const root = makeEnv('wx-u2', 'acc1')
  try {
    const infra = makeReuseInfra()
    const { reported } = await frontProbe(infra, root, 'acc1')
    assert.equal(reported, true)
    const result = await runDirect(infra, root, 'acc1')
    void result
    assert.deepEqual([...infra.launches.entries()].sort(), [['acc1', 3]], '外部探测 1 + 流程内重探测 1 + 本体 1')
    assert.equal(infra.reports.length, 3, '前置探测 1 + 流程内重探测 1 + 采集终态 ok 上报 1')
  } finally {
    cleanup(root)
  }
})

test('U3 注入时钟使探测超 TTL：重新探测（3 次启动），其余照旧', async () => {
  const root = makeEnv('wx-u3', 'acc1')
  try {
    const infra = makeReuseInfra()
    const { probe } = await frontProbe(infra, root, 'acc1')
    // now 注入：探测刚完成但时钟已推进 6 分钟（> TTL）→ 照旧重新探测。
    const result = await runDirect(infra, root, 'acc1', { probed: probe, now: () => Date.now() + PROBE_REUSE_TTL_MS + 60_000 })
    assert.equal(result.status, 'partial', '假 body 无列表数据 → 空列表 incomplete partial（失败形态不在本断言范围）')
    assert.deepEqual([...infra.launches.entries()].sort(), [['acc1', 3]], '超 TTL 回落：外部探测 1 + 重新探测 1 + 本体 1')
  } finally {
    cleanup(root)
  }
})

test('U4 前置就绪检查失败（storage_state 缺失 → expired 类）：页面路径拒绝启动采集（现状回归）', async () => {
  const root = makeEnv('wx-u4', 'acc1')
  try {
    // storage_state 缺失 → 前置探测 expired → collect.start 拒绝（不建 run、不启动采集）。
    rmSync(join(root, 'storage-state', 'acc1.json'), { force: true })
    const infra = makeReuseInfra()
    const deps = createWxHostDeps({
      root,
      workbench: infra.workbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: infra.factory,
    })
    const batch = { get status() { return {} as never }, get running() { return false }, start: async () => ({ started: false }), stop: () => undefined }
    const collect = createCollectController(
      { workbench: deps.workbench, root, chromeFactory: infra.factory, logger: deps.logger, locks: deps.locks },
      { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
    )
    const handlers = buildRouteHandlers(deps, batch as never, collect)
    const started = await (handlers['collect.start'] as (args: Record<string, string>) => Promise<Record<string, unknown>>)({ accountId: 'acc1' })
    assert.equal(started.started, false)
    assert.equal(started.reason, 'storage_state_missing', '就绪检查先行拒绝（expired 场景的细分原因）')
    assert.deepEqual([...infra.launches.entries()], [], '无任何 Chrome 启动（不进入采集）')
    const runs = await readRuns(root)
    assert.deepEqual(Object.keys(runs), [], '不产生 runs 记录')
  } finally {
    cleanup(root)
  }
})

test('U4b runCollection 层收到 expired 的 probed：回落重新探测（复用条件要求 ok）', async () => {
  const root = makeEnv('wx-u4b', 'acc1')
  try {
    const infra = makeReuseInfra()
    const { probe } = await frontProbe(infra, root, 'acc1')
    // 合成 expired：fresh 探测可恢复（假 factory 的 auth_data 命中）→ 回落后
    // 流程内重探测 1 次 + 本体 1 次，共 3 次启动。
    const expiredProbed: ProbedSession<RefreshedSession> = { ...probe, state: { ...probe.state, sessionStatus: 'expired' } }
    await runDirect(infra, root, 'acc1', { probed: expiredProbed })
    assert.deepEqual([...infra.launches.entries()].sort(), [['acc1', 3]], 'expired probed 不复用：外部探测 1 + 流程内重探测 1 + 本体 1')
  } finally {
    cleanup(root)
  }
})

test('U5 复用且 reported=false：采集流程内补一次上报', async () => {
  const root = makeEnv('wx-u5', 'acc1')
  try {
    const infra = makeReuseInfra()
    const { probe } = await frontProbe(infra, root, 'acc1')
    const notReported: ProbedSession<RefreshedSession> = { ...probe, reported: false }
    await runDirect(infra, root, 'acc1', { probed: notReported })
    assert.deepEqual([...infra.launches.entries()].sort(), [['acc1', 2]], '复用生效（无流程内重探测）')
    assert.deepEqual(infra.launchLog.filter(item => item.launchNo === 2).map(item => item.reports), [2], '本体启动前 = 前置探测 1 次 + 流程内补报 1 次')
  } finally {
    cleanup(root)
  }
})

test('U6 复用后身份复核失败：account_mismatch 收尾，runs.json 保留终态记录', async () => {
  const root = makeEnv('wx-u6', 'acc1')
  try {
    const infra = makeReuseInfra()
    const { probe } = await frontProbe(infra, root, 'acc1')
    // 本体 evaluate 身份不一致（collect body 的 auth_data 由 makeReuseInfra 按
    // 目录名返回；这里以 authAs 漂移的 factory 覆盖）。
    const mismatchFactory: ChromeFactory = async options => {
      const accountId = basename(options.profileDir)
      const launchNo = (infra.launches.get(accountId) ?? 0) + 1
      infra.launches.set(accountId, launchNo)
      infra.launchLog.push({ accountId, launchNo, reports: infra.reports.length })
      const page = {
        goto: async () => undefined,
        evaluate: async (_fn: unknown, arg: { url: string }) => {
          if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) {
            const body = JSON.parse(authDataBody(launchNo === 1 ? accountId : 'someone-else'))
            return { status: 200, text: JSON.stringify(body) }
          }
          return { status: 500, text: '' }
        },
      }
      const context = { pages: () => [page], newPage: async () => page, cookies: async () => [{ name: 'sessionid', value: 'v' }], storageState: async () => ({ cookies: [], origins: [] }), close: async () => undefined }
      return { context } as never
    }
    const locks = createProfileLocks()
    const result = await runCollection({
      workbench: infra.workbench,
      accountId: 'acc1',
      root,
      locks,
      chromeFactory: mismatchFactory,
      probed: probe,
    })
    assert.equal(result.status, 'failed')
    // 身份复核失败的细分原因是 account_mismatch（串号防线的可行动文案），不是
    // session_expired（实施单附录 B U6 的「session_expired 收尾」按实际行为修订）。
    assert.equal(result.reason, 'account_mismatch', '身份复核失败以 account_mismatch 收尾（部分成果保留语义由入库路径承担）')
    const runs = await readRuns(root)
    const record = Object.values(runs)[0]
    assert.notEqual(record, undefined, '终态记录已落盘')
    assert.equal(record?.status, 'failed')
  } finally {
    cleanup(root)
  }
})

/** 按工具名分发的 fake workbench：run_start 返回固定远端 runId。 */
function makeIngestWorkbench(options: { runId: string; onFinish?: () => void; finishGate?: Promise<void>; onListMeta?: () => Promise<void> }): WxWorkbenchFace {
  return {
    callTool: async (_caller: string, _domain: string, name: string) => {
      if (name === 'workbench_wx_collect_run_start') return { structuredContent: { run: { run_id: options.runId } }, content: [] }
      if (name === 'workbench_wx_collect_run_set_list_meta') {
        if (options.onListMeta !== undefined) await options.onListMeta()
        return { structuredContent: {}, content: [] }
      }
      if (name === 'workbench_wx_collect_ingest_works') return { structuredContent: { batch: { batch_status: 'succeeded', succeeded_objects: ['w1'], failed_objects: [] } }, content: [] }
      if (name === 'workbench_wx_collect_run_finish') {
        options.onFinish?.()
        if (options.finishGate !== undefined) await options.finishGate
        return { structuredContent: { run: { status: 'completed' } }, content: [] }
      }
      return { structuredContent: {}, content: [] }
    },
  }
}

/** 最小 WorkItem（全空指标字段 + dailyMetrics 空数组）。 */
function makeWork(id: string): Record<string, unknown> {
  return { workId: id, exportId: null, title: null, description: null, coverUrl: null, publishTime: null, mediaType: null, durationS: null, width: null, height: null, visibility: null, playCount: null, likeCount: null, favoriteCount: null, commentCount: null, forwardCount: null, shareCount: null, followCount: null, wecomLinkClickCount: null, wecomLinkClickUv: null, wecomContactAddCount: null, wecomContactAddUv: null, ringsetCount: null, statusCoverCount: null, statusRefCount: null, completionRatePct: null, dailyMetrics: [] }
}

/** 按批次 gate 的 fake workbench（21 works → 2 批；ingest_works 按入参 batchNo 挂起）。 */
function makeBatchWorkbench(options: {
  runId: string
  batchGates: Map<number, Promise<void>>
  onBatchEntered?: (batchNo: number) => void
}): WxWorkbenchFace {
  return {
    callTool: async (_caller: string, _domain: string, name: string, args: unknown) => {
      if (name === 'workbench_wx_collect_run_start') return { structuredContent: { run: { run_id: options.runId } }, content: [] }
      if (name === 'workbench_wx_collect_ingest_works') {
        const batchNo = typeof (args as { batchNo?: unknown })?.batchNo === 'number' ? (args as { batchNo: number }).batchNo : 0
        options.onBatchEntered?.(batchNo)
        const gate = options.batchGates.get(batchNo)
        if (gate !== undefined) await gate
        return { structuredContent: { batch: { batch_status: 'succeeded', succeeded_objects: [], failed_objects: [] } }, content: [] }
      }
      if (name === 'workbench_wx_collect_run_finish') return { structuredContent: { run: { status: 'completed' } }, content: [] }
      return { structuredContent: {}, content: [] }
    },
  }
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
  // 运行中：内存 running + 持久化 running，同一条 attemptId。探测复用后采集
  // 本体启动更快，probing 进度的 runs.json 落盘（fire-and-forget 写）改为
  // 显式等待后再断言持久化投影。
  await waitForCondition(async () => {
    const st = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
    return (st.lastRun as { status?: string } | null)?.status === 'running'
  }, 5000)
  const status1 = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
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
  const status2 = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
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
    const status = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
    const memory = status.collect as { status: string } | null
    return memory?.status === 'cancelled'
  }, 5000)
  const status = await callHandler(handlers, 'collect.status', { accountId: 'acc1' })
  const memory = status.collect as { status: string; progress: { phase?: string } }
  assert.equal(memory.status, 'cancelled', '内存终态不因持久化失败被覆盖')
  assert.equal(memory.progress.phase, 'run_persist_failed', '进度事件必须暴露终态写失败')
  assert.ok(logger.warnings.some(message => message.includes('final state write failed')), `终态写失败必须产生 warn 日志，实际: ${JSON.stringify(logger.warnings)}`)
  assert.equal(status.lastRun, null, '持久化写失败时 lastRun 不可得（诚实反映）')
  cleanup(root)
})

// --- 6. 远端 runId 立即持久化 + ingest 进度持久化 ---

test('ingestCollectedData 正常事件流（run_started/batch_done/finished）经投影全部落盘', async () => {
  const root = makeRoot('wx-runs-ingest')
  const attempt = createAttemptId('acc1')
  const phases: string[] = []
  const persisting: Array<Promise<unknown>> = []
  const result = await ingestCollectedData({
    client: createIngestClient({ workbench: makeIngestWorkbench({ runId: 'remote-run-x' }), accountId: 'acc1', root }),
    works: [{ workId: 'w1', exportId: null, title: null, description: null, coverUrl: null, publishTime: null, mediaType: null, durationS: null, width: null, height: null, visibility: null, playCount: null, likeCount: null, favoriteCount: null, commentCount: null, forwardCount: null, shareCount: null, followCount: null, wecomLinkClickCount: null, wecomLinkClickUv: null, wecomContactAddCount: null, wecomContactAddUv: null, ringsetCount: null, statusCoverCount: null, statusRefCount: null, completionRatePct: null, dailyMetrics: [] } as never],
    listComplete: true,
    expectedWorkCount: 1,
    newAttempt: true,
    // 与 runner 相同的桥接：runId 落盘只走 onRunStart barrier；onProgress 对
    // 事件只做白名单投影落盘 progress。
    onRunStart: runId => { persisting.push(updateRun(root, 'acc1', attempt, { runId })) },
    onProgress: event => {
      phases.push(String(event.phase))
      const progress = progressFromEvent(event)
      if (progress !== null) persisting.push(updateRun(root, 'acc1', attempt, { progress }))
    },
    signal: undefined,
  })
  await Promise.all(persisting)

  assert.equal(result.error, null)
  assert.equal(result.runId, 'remote-run-x')
  assert.deepEqual(phases, ['run_started', 'batch_done', 'finished'], `事件流: ${JSON.stringify(phases)}`)
  const record = (await readRuns(root))[attempt]
  assert.ok(record !== undefined)
  assert.equal(record.runId, 'remote-run-x', 'run_started 事件落盘远端 runId')
  assert.equal(record.progress.phase, 'finishing', 'finished 事件最后落盘')
  assert.equal(record.status, 'running', '单元测试只发进度，无终态')
  cleanup(root)
})

test('远端 run_start 返回后、采集未完成前，runs.json 已含真实 runId；终态保留 runId 与进度', async () => {
  const root = makeEnv('wx-runs-runid', 'acc1')
  const finishEntered = deferred<void>()
  const finishGate = deferred<void>()
  let listMetaSawRunId: boolean | null = null
  const workbench = makeIngestWorkbench({
    runId: 'remote-run-42',
    onFinish: finishEntered.resolve,
    finishGate: finishGate.promise,
    // 落盘 barrier 断言：ingest 流程中途（publishListMeta 时）runId 必已落盘。
    onListMeta: async () => {
      const record = Object.values(await readRuns(root))[0]
      listMetaSawRunId = record?.runId === 'remote-run-42'
    },
  })
  const { handlers } = buildHandlers(root, makeFactory({ acc1: {} }), undefined, workbench)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  try {
    // 等采集流程走到 client.finish（list 重试 + 账号级接口约数秒）。
    await Promise.race([finishEntered.promise, timeoutReject(20000, '采集未到达 finish 阶段')])
    // run_started / finished 事件已 emit：等 fire-and-forget 落盘完成。
    await waitForCondition(async () => {
      const record = Object.values(await readRuns(root))[0]
      return record?.runId === 'remote-run-42' && record?.progress.phase === 'finishing'
    }, 3000)
  } finally {
    // 无论如何解除 gate：断言失败时 runCollection 不得永挂拖住测试进程。
    finishGate.resolve()
  }
  // client.finish 挂起窗口：runId 必须已落盘（run_started 即时持久化），
  // finished 进度也已落盘，状态仍是 running（采集未完成）。
  const running = Object.values(await readRuns(root))[0]
  assert.equal(running?.runId, 'remote-run-42')
  assert.equal(running?.status, 'running', '采集未完成时仍是 running')
  assert.equal(running?.progress.phase, 'finishing')

  finishGate.resolve()
  assert.equal(listMetaSawRunId, true, 'publishListMeta（barrier 之后的第一步）时 runId 必须已落盘')
  await waitForCondition(async () => {
    const status = await callHandler(handlers, 'collect.status')
    return status.busy === false && (status.lastRun as { status: string } | null)?.status !== 'running'
  }, 5000)
  const status = await callHandler(handlers, 'collect.status')
  const lastRun = status.lastRun as { runId: string | null; status: string; progress: { phase?: string } }
  assert.equal(lastRun.runId, 'remote-run-42', '终态保留远端 runId')
  assert.ok(lastRun.status === 'completed' || lastRun.status === 'partial', `实际: ${String(lastRun.status)}`)
  assert.equal(lastRun.progress.phase, 'finishing', '终态不得覆盖最后进度')
  const runs = await readRuns(root)
  assert.equal(Object.keys(runs).length, 1)
  cleanup(root)
})

test('run_start 后取消：cancelled 终态保留 runId 与最后进度', async () => {
  const root = makeEnv('wx-runs-cancel-runid', 'acc1')
  const finishEntered = deferred<void>()
  let rejectFinish!: (error: Error) => void
  const finishGate = new Promise<void>((_, reject) => { rejectFinish = reject })
  const workbench = makeIngestWorkbench({ runId: 'remote-run-77', onFinish: finishEntered.resolve, finishGate })
  const { handlers } = buildHandlers(root, makeFactory({ acc1: {} }), undefined, workbench)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  try {
    // 等采集流程走到 client.finish 且 run_started / finished 已落盘。
    await Promise.race([finishEntered.promise, timeoutReject(20000, '采集未到达 finish 阶段')])
    await waitForCondition(async () => {
      const record = Object.values(await readRuns(root))[0]
      return record?.runId === 'remote-run-77' && record?.progress.phase === 'finishing'
    }, 3000)
  } finally {
    // 无论如何解除 finish gate（reject 使 client.finish 抛错）：断言失败时
    // runCollection 不得永挂拖住测试进程。
    rejectFinish(new Error('test cleanup'))
  }

  // 取消：client.finish 拒绝 → ingest 兜底 cancel → runner 取消分支读本地
  // record.runId 写 cancelled 终态。
  await callHandler(handlers, 'collect.cancel', { accountId: 'acc1' })
  rejectFinish(new Error('finish aborted'))
  await waitForCondition(async () => {
    const status = await callHandler(handlers, 'collect.status')
    return (status.lastRun as { status: string } | null)?.status === 'cancelled'
  }, 5000)
  const status = await callHandler(handlers, 'collect.status')
  const lastRun = status.lastRun as { runId: string | null; status: string; error: string | null; progress: { phase?: string } }
  assert.equal(lastRun.status, 'cancelled')
  assert.equal(lastRun.error, 'collect_cancelled')
  assert.equal(lastRun.runId, 'remote-run-77', '取消终态必须保留远端 runId')
  assert.equal(lastRun.progress.phase, 'finishing', '取消终态保留最后进度')
  cleanup(root)
})

// --- 7. runs.json 语义校验（非法即抛、绝不覆盖） ---

test('runs.json 语义非法：readRuns 抛 run_state_corrupt 且文件字节不变', async () => {
  const root = makeRoot('wx-runs-corrupt')
  const file = join(root, 'runs.json')
  const cases = [
    'not json at all',
    '{"version":1}',
    '{"version":1,"runs":[]}',
    '{"version":1,"runs":{"a":{"startedAt":"2026-01-01T00:00:00Z","status":"running"}}}',
    '{"version":1,"runs":{"a":{"accountId":"a","startedAt":"x","status":"weird"}}}',
    '{"version":1,"runs":{"a":{"accountId":9,"startedAt":"x","status":"running"}}}',
    '{"version":1,"runs":{"a":{"accountId":"a","startedAt":5,"status":"running"}}}',
    '{"version":1,"runs":{"a":{"accountId":"a","startedAt":"x","status":"running","runId":7}}}',
    '{"version":1,"runs":{"a":"broken"}}',
  ]
  for (const [index, content] of cases.entries()) {
    writeFileSync(file, content, 'utf8')
    const before = readFileSync(file)
    await assert.rejects(readRuns(root), (error: unknown) => {
      assert.equal(safeCode(error), 'run_state_corrupt', `case ${String(index)} 错误码`)
      return true
    }, `case ${String(index)} 应抛 run_state_corrupt`)
    assert.ok(before.equals(readFileSync(file)), `case ${String(index)} 文件字节不变`)
  }
  cleanup(root)
})

test('非法 runs.json：updateRun / recoverInterruptedRuns / removeAccountRuns 全部失败且不覆盖文件', async () => {
  const root = makeRoot('wx-runs-corrupt-guard')
  const file = join(root, 'runs.json')
  const content = '{"version":1,"runs":{"a":{"accountId":"a","startedAt":"x","status":"weird"}},"extra":"keep"}'
  writeFileSync(file, content, 'utf8')
  const before = readFileSync(file)
  await assert.rejects(updateRun(root, 'a', 'a', { progress: { phase: 'x' } }), (error: unknown) => {
    assert.equal(safeCode(error), 'run_state_corrupt')
    return true
  })
  await assert.rejects(recoverInterruptedRuns(root), (error: unknown) => {
    assert.equal(safeCode(error), 'run_state_corrupt')
    return true
  })
  await assert.rejects(removeAccountRuns(root, 'a'), (error: unknown) => {
    assert.equal(safeCode(error), 'run_state_corrupt')
    return true
  })
  assert.equal(readFileSync(file, 'utf8'), content, '非法文件必须原样保留')
  cleanup(root)
})

test('runs.json 合法旧字段兼容：缺 attemptId/runId 等可空字段正常读取且不魔改 status', async () => {
  const root = makeRoot('wx-runs-legacy')
  const file = join(root, 'runs.json')
  writeFileSync(file, '{"version":1,"runs":{"legacy-1":{"accountId":"a","startedAt":"2026-01-01T00:00:00Z","status":"failed","error":"probe_failed"}}}', 'utf8')
  const runs = await readRuns(root)
  const record = runs['legacy-1']
  assert.ok(record !== undefined)
  assert.equal(record.attemptId, 'legacy-1', 'attemptId 以 key 为准')
  assert.equal(record.runId, null)
  assert.equal(record.status, 'failed', 'status 不被魔改')
  assert.equal(record.error, 'probe_failed')
  assert.equal(record.finishedAt, null)
  assert.deepEqual(record.progress, {})
  cleanup(root)
})

test('collect.status 对语义非法 runs.json 暴露 run_state_corrupt reason，不伪装空记录', async () => {
  const root = makeEnv('wx-runs-status-corrupt', 'acc1')
  writeFileSync(join(root, 'runs.json'), '{"version":1}', 'utf8')
  const { handlers } = buildHandlers(root, makeFactory({ acc1: {} }))
  const status = await callHandler(handlers, 'collect.status')
  assert.equal(status.busy, false)
  assert.equal(status.lastRun, null)
  assert.equal(status.reason, 'run_state_corrupt', `实际: ${JSON.stringify(status)}`)
  cleanup(root)
})

// --- 8. 逐批实时进度 / runId 落盘 barrier 失败路径 / version 校验 ---

test('ingest 批次实时进度：第二批挂起时 runs.json 已是第一批 batch_done（batchNo=1）', async () => {
  const root = makeRoot('wx-runs-batch')
  const attempt = createAttemptId('acc1')
  const batch1Gate = deferred<void>()
  const batch2Entered = deferred<void>()
  const batch2Gate = deferred<void>()
  const workbench = makeBatchWorkbench({
    runId: 'remote-run-9',
    batchGates: new Map([[1, batch1Gate.promise], [2, batch2Gate.promise]]),
    onBatchEntered: batchNo => { if (batchNo === 2) batch2Entered.resolve() },
  })
  const phases: string[] = []
  const persisting: Array<Promise<unknown>> = []
  // 21 works → splitIngestBatches 切成 2 批（每批上限 20）。
  const promise = ingestCollectedData({
    client: createIngestClient({ workbench, accountId: 'acc1', root }),
    works: Array.from({ length: 21 }, (_, index) => makeWork(`w${String(index + 1)}`)) as never,
    listComplete: true,
    expectedWorkCount: 21,
    newAttempt: true,
    onRunStart: runId => { persisting.push(updateRun(root, 'acc1', attempt, { runId })) },
    // runId 落盘只走 onRunStart barrier；onProgress 对 run_started 只投影
    // progress（与 runner emit 一致）。
    onProgress: event => {
      phases.push(String(event.phase))
      const progress = progressFromEvent(event)
      if (progress !== null) persisting.push(updateRun(root, 'acc1', attempt, { progress }))
    },
    signal: undefined,
  })

  // 第一批 gate 放行 → batch_done(1) 发出 → 第二批进入并挂起。
  batch1Gate.resolve()
  await Promise.race([batch2Entered.promise, timeoutReject(5000, '第二批未进入')])
  // 第二批仍挂起时：第一批 batch_done 必须已落盘（逐批实时，非补发）。
  await waitForCondition(async () => {
    const record = (await readRuns(root))[attempt]
    return record?.progress.phase === 'ingest' && record?.progress.batchNo === 1
  }, 3000)
  const mid = (await readRuns(root))[attempt]
  assert.equal(mid?.progress.totalBatches, 2)
  assert.equal(mid?.progress.batchNo, 1)

  // 释放第二批：batch_done(2) → finished → 完成。
  batch2Gate.resolve()
  await Promise.race([promise, timeoutReject(5000, 'ingestCollectedData 未完成')])
  await Promise.all(persisting)
  assert.deepEqual(phases, ['run_started', 'batch_done', 'batch_done', 'finished'], `事件流: ${JSON.stringify(phases)}`)
  const final = (await readRuns(root))[attempt]
  // 最终 progress 是 finished 的投影（覆盖 batch_done；第二批发出由 phases 序列证明）。
  assert.equal(final?.progress.phase, 'finishing')
  cleanup(root)
})

test('ingest 批次间取消：runs.json 保留已落盘的 batchNo=1 进度与远端 runId', async () => {
  const root = makeRoot('wx-runs-batch-cancel')
  const attempt = createAttemptId('acc1')
  const controller = new AbortController()
  const batch1Gate = deferred<void>()
  const batch2Entered = deferred<void>()
  let rejectBatch2!: (error: Error) => void
  const batch2Gate = new Promise<void>((_, reject) => { rejectBatch2 = reject })
  const workbench = makeBatchWorkbench({
    runId: 'remote-run-8',
    batchGates: new Map([[1, batch1Gate.promise], [2, batch2Gate]]),
    onBatchEntered: batchNo => { if (batchNo === 2) batch2Entered.resolve() },
  })
  const persisting: Array<Promise<unknown>> = []
  const promise = ingestCollectedData({
    client: createIngestClient({ workbench, accountId: 'acc1', root }),
    works: Array.from({ length: 21 }, (_, index) => makeWork(`w${String(index + 1)}`)) as never,
    listComplete: true,
    expectedWorkCount: 21,
    newAttempt: true,
    onRunStart: runId => { persisting.push(updateRun(root, 'acc1', attempt, { runId })) },
    // runId 落盘只走 onRunStart barrier；onProgress 对 run_started 只投影
    // progress（与 runner emit 一致）。
    onProgress: event => {
      const progress = progressFromEvent(event)
      if (progress !== null) persisting.push(updateRun(root, 'acc1', attempt, { progress }))
    },
    signal: controller.signal,
  })

  batch1Gate.resolve()
  await Promise.race([batch2Entered.promise, timeoutReject(5000, '第二批未进入')])
  await waitForCondition(async () => {
    const record = (await readRuns(root))[attempt]
    return record?.runId === 'remote-run-8' && record?.progress.batchNo === 1
  }, 3000)

  // 第二批挂起时取消：abort + gate 拒绝 → ingestAll 抛 → 兜底 cancel → 传播。
  controller.abort()
  rejectBatch2(new Error('ingest aborted'))
  await assert.rejects(promise)
  await Promise.all(persisting)
  const record = (await readRuns(root))[attempt]
  assert.equal(record?.runId, 'remote-run-8', '取消后远端 runId 保留')
  assert.equal(record?.progress.batchNo, 1, '取消后最后批次进度保留')
  assert.equal(record?.status, 'running', '单元路径无 runner 终态（cancelled 终态由 runner 写，见集成取消测试）')
  cleanup(root)
})

test('runId 落盘失败：warn 可见、采集继续、终态仍尝试写入并暴露失败', async () => {
  const root = makeEnv('wx-runs-runid-fail', 'acc1')
  // runs.json 位置被目录占用：runId barrier 与终态写入确定性失败。
  mkdirSync(join(root, 'runs.json'), { recursive: true })
  const logger = { warnings: [] as string[] }
  const workbench = makeIngestWorkbench({ runId: 'remote-run-5' })
  const { handlers } = buildHandlers(root, makeFactory({ acc1: {} }), logger, workbench)

  const collect = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
  assert.equal(collect.started, true)
  // 采集继续到收尾（完整流程约数秒；30s 防挂护栏）。
  await waitForCondition(async () => {
    const status = await callHandler(handlers, 'collect.status')
    return status.busy === false
  }, 30000)
  assert.ok(logger.warnings.some(message => message.includes('runId persist failed')), `runId 落盘失败必须 warn，实际: ${JSON.stringify(logger.warnings)}`)
  assert.ok(logger.warnings.some(message => message.includes('final state write failed')), '终态写入仍会尝试并暴露失败')
  cleanup(root)
})

test('runs.json version 校验：缺 version / version=99 / 类型错均抛 run_state_corrupt 且文件不变', async () => {
  const root = makeRoot('wx-runs-version')
  const file = join(root, 'runs.json')
  const cases = [
    '{"runs":{}}',
    '{"version":99,"runs":{}}',
    '{"version":"1","runs":{}}',
  ]
  for (const [index, content] of cases.entries()) {
    writeFileSync(file, content, 'utf8')
    const before = readFileSync(file)
    await assert.rejects(readRuns(root), (error: unknown) => {
      assert.equal(safeCode(error), 'run_state_corrupt', `case ${String(index)} 错误码`)
      return true
    }, `case ${String(index)} 应抛 run_state_corrupt`)
    assert.ok(before.equals(readFileSync(file)), `case ${String(index)} 文件字节不变`)
  }
  cleanup(root)
})
