/**
 * 批量采集并发测试（node --test）：action 清单（collect.running）、单账号控制
 * 器互斥与并发、阶段 2 worker 队列的并发峰值 / 取号顺序 / 并发度落定、批内熔
 * 断与不误触、错峰接缝、Config.batchConcurrency 校验、stop 收口、collect.wait
 * 幂等、collect.status / collect.running 投影、no_eligible_account。时序全部
 * 经 concurrency/rand/sleep 注入控制，不依赖真实计时；不启动真实 Chrome，不
 * 访问生产 endpoint。dispose 收口见 tests/dispose.test.ts（B13/B18）。
 * 运行：`node --test tests/batch-concurrency.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { createBatchCollectController } from '../src/collect-all.ts'
import { buildRouteHandlers, createWxHostDeps, type WxHostDeps } from '../src/handlers.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { ACTION_SCHEMAS } from '../src/route.ts'
import { createCollectController, type CollectResult, type CollectController } from '../src/runner.ts'
import { PROBE_REUSE_TTL_MS, type ProbedSession, type RefreshedSession } from '../src/probe.ts'
import { createAttemptId, readRuns, updateRun } from '../src/runs.ts'
import type { ChromeFactory } from '../src/session.ts'
import type { WxWorkbenchFace } from '../src/ingest.ts'

/** 采集成功（completed 口径）。 */
const ok = (): CollectResult => ({ status: 'completed', runId: `run-${String(Math.random()).slice(2)}`, works: 3 })

/** partial（部分作品缺失，不伪装成功）。 */
const partial = (): CollectResult => ({ status: 'partial', runId: `run-${String(Math.random()).slice(2)}`, works: 2 })

/** 采集失败（reason 决定是否计入风控信号）。 */
const collectFailed = (reason: string): CollectResult => ({ status: 'failed', runId: null, reason })

/** 采集途中会话失效（风控信号：探测通过后 runCollection 失败原因承载）。 */
const sessionExpired = (): CollectResult => collectFailed('session_expired')

/** 零随机接缝（错峰与取号间隔全部落下限）。 */
const zeroRand = (): number => 0

/** 半值随机接缝（首取延迟断言 k × (base + 0.5 × spread)）。 */
const halfRand = (): number => 0.5

/** 零等待接缝：立即返回（时序完全由 settle 门控决定）。 */
const immediateSleep = (): Promise<void> => Promise.resolve()

/** 让微任务与 immediate sleep 链清空（两个 macrotask 边界）。 */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 采集脚本（accountId → 终态结果）。 */
type CollectScript = Record<string, CollectResult | null>

/** 批量控制器 collect 门面的 start 入参。 */
interface FakeStartInput { accountId: string; signal?: AbortSignal; fromBatch?: boolean }

/**
 * 受控假 collect 门面：记录启动序与在途峰值；gate 为 true 时 wait 挂起直到
 * settle(accountId) 或该账号 signal abort，否则按脚本立即返回终态。
 */
function fakeCollect(script: CollectScript, gate: boolean) {
  const starts: string[] = []
  const accountSignals = new Map<string, AbortSignal | undefined>()
  let inFlight = 0
  let peak = 0
  const gates = new Map<string, () => void>()
  return {
    starts,
    peakInFlight: (): number => peak,
    settle: (accountId: string): void => { gates.get(accountId)?.() },
    start: async (input: FakeStartInput): Promise<{ started: boolean; reason?: string }> => {
      starts.push(input.accountId)
      accountSignals.set(input.accountId, input.signal)
      if (!(input.accountId in script)) return { started: false, reason: 'collect_busy' }
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return { started: true }
    },
    wait: async (accountId: string): Promise<CollectResult | null> => {
      if (gate) {
        const signal = accountSignals.get(accountId)
        await new Promise<void>(resolve => {
          gates.set(accountId, resolve)
          if (signal !== undefined) {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => { resolve() }, { once: true })
          }
        })
      }
      inFlight -= 1
      return script[accountId] ?? null
    },
    hasRunning: (): boolean => inFlight > 0,
  }
}

/** 临时状态根 + 账号记录 + storage_state 占位（readiness 与 probe 就绪）。 */
async function makeEnv(prefix: string, accountIds: string[]): Promise<string> {
  const root = join(tmpdir(), `${prefix}-${String(Math.random()).slice(2)}`)
  await mkdir(join(root, 'storage-state'), { recursive: true })
  const records: Record<string, unknown> = {}
  for (const accountId of accountIds) {
    records[accountId] = { accountId, sessionStatus: 'ok', sessionSeq: 1 }
    await writeFile(join(root, 'storage-state', `${accountId}.json`), '{"cookies":[]}', { mode: 0o600 })
  }
  await writeFile(join(root, 'accounts.json'), JSON.stringify({ accounts: records }), { mode: 0o600 })
  return root
}

const cleanupRoot = (root: string): Promise<void> => rm(root, { recursive: true, force: true })

function authDataBody(accountId: string): string {
  return JSON.stringify({ errCode: 0, data: { finderUser: { finderUsername: accountId, nickname: `n-${accountId}`, headImgUrl: '', fansCount: 2, feedsCount: 3 } } })
}

/**
 * 门控 Chrome factory（与 dispose.test 同调用序：probe(1) → runCollection 内
 * probe(2) → collect 本体(3)）：probe 调用立即成功；collect 本体对 hang 账号
 * 挂起，直到该账号 signal abort（抛错模拟 Playwright context closed）。
 */
function makeGateFactory(signalOf: (accountId: string) => AbortSignal | undefined, hangAccounts: readonly string[]): ChromeFactory {
  const hang = new Set(hangAccounts)
  const calls = new Map<string, number>()
  return async options => {
    const accountId = basename(options.profileDir)
    const callNo = (calls.get(accountId) ?? 0) + 1
    calls.set(accountId, callNo)
    const page = {
      goto: async () => {
        // 采集本体 = 第 2 次启动（前置探测结果复用，collect-probe-reuse）。
        if (callNo === 2 && hang.has(accountId)) {
          const signal = signalOf(accountId)
          await new Promise<void>((resolve, reject) => {
            if (signal === undefined) { resolve(); return }
            if (signal.aborted) { reject(new Error('goto aborted')); return }
            signal.addEventListener('abort', () => { reject(new Error('goto aborted')) }, { once: true })
          })
        }
      },
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
}

const noopWorkbench: WxWorkbenchFace = { callTool: async () => ({ structuredContent: {}, content: [] }) } as never

/** Host 接线（与 index.ts apply 同构）：单账号控制器 + 真实批量控制器。 */
function wireHost(deps: WxHostDeps, options: {
  batchProbe?: (accountId: string) => Promise<{ sessionStatus: string; reason: string | null; probe?: ProbedSession<RefreshedSession> }>
  /** 批量控制器取号节奏接缝（U7/U8 用零等待；缺省走真实错峰）。 */
  rand?: (() => number) | undefined
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined
} = {}) {
  const registry = deps.taskRegistry
  let batch: ReturnType<typeof createBatchCollectController>
  const collect: CollectController = createCollectController(
    { workbench: deps.workbench, root: deps.root, chromeFactory: deps.chromeFactory, logger: deps.logger, locks: deps.locks },
    { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: registry, signals: deps.collectSignals },
  )
  batch = createBatchCollectController({
    collect: {
      start: input => collect.start({
        accountId: input.accountId,
        fromBatch: true,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        ...(input.probed !== undefined ? { probed: input.probed } : {}),
      }),
      wait: accountId => collect.wait(accountId),
      hasRunning: () => collect.hasRunning(),
    },
    probe: options.batchProbe ?? (async accountId => registry.runTracked(() => import('../src/probe.ts').then(({ probeAndReport }) => probeAndReport(deps.workbench, accountId, deps.root, deps.locks, deps.chromeFactory)))
      .then(result => ({ sessionStatus: result.sessionStatus, reason: result.reason, probe: result.probe })) ),
    logger: deps.logger,
    trackRun: promise => { registry.track(promise) },
    ...(options.rand !== undefined ? { rand: options.rand } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
  })
  const handlers = buildRouteHandlers(deps, batch, collect) as Record<string, (args: Record<string, string | boolean>) => Promise<object>>
  return { batch, collect, handlers }
}

async function callHandler(handlers: Record<string, (args: Record<string, string | boolean>) => Promise<object>>, action: string, args: Record<string, string | boolean> = {}): Promise<Record<string, unknown>> {
  const handler = handlers[action]
  assert.ok(handler !== undefined, `handler ${action} 必须存在`)
  return await handler(args) as Record<string, unknown>
}

// --- U7/U8 批量探测复用（collect-probe-reuse） ---

/**
 * 计数 workbench + 计数 factory：统计上报次数与每账号启动次数。无门控——
 * 采集本体的 post-list 页面取不到数据（evaluate 500）快速失败，批次自然收敛，
 * 断言只看启动与上报计数（body 的成功路径由其他用例覆盖）。
 */
function makeReuseInfra(): { workbench: WxWorkbenchFace; factory: ChromeFactory; launches: Map<string, number>; reports: string[]; launchLog: Array<{ accountId: string; launchNo: number; reports: number }> } {
  const launches = new Map<string, number>()
  const reports: string[] = []
  // 每次启动的（账号, 序号, 此刻上报数）日志：复用语义断言用（合成 batchProbe
  // 不发 Chrome，阶段 1 零启动——账号的第 1 次启动即采集本体）。
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

test('U7 批量：ok 账号阶段 2 只再启动 1 次 Chrome，上报次数 = 账号数（前置探测复用）', async () => {
  const root = await makeEnv('wx-u7', ['a1', 'a2'])
  try {
    const infra = makeReuseInfra()
    const deps = createWxHostDeps({
      root,
      workbench: infra.workbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: message => { console.error('U7 WARN:', message) } },
      chromeFactory: infra.factory,
    })
    const { handlers } = wireHost(deps, { rand: () => 0, sleep: async () => undefined })
    const started = await callHandler(handlers, 'collectAll.start', {})
    assert.equal(started.started, true)
    // 等 batch run 自然收敛（runPromise 经 trackRun 登记；不能先 dispose——
    // dispose 会 stop 批次把整批置 collect_cancelled）。
    await deps.taskRegistry.awaitSettled()
    assert.deepEqual([...infra.launches.entries()].sort(), [['a1', 2], ['a2', 2]], '每账号 = 前置探测 1 次 + 采集本体 1 次（复用跳过流程内探测）')
    // 本体启动时刻的上报数 = 阶段 1 的总上报数（复用账号的流程内上报已跳过；
    // 真实 batchProbe 下阶段 1 串行完成两账号后阶段 2 才启动）。
    assert.deepEqual(infra.launchLog.filter(item => item.accountId === 'a1').map(item => item.reports), [0, 2], 'a1：探测时 0 上报，本体前 = 阶段 1 共 2 次（流程内上报已跳过）')
    assert.deepEqual(infra.launchLog.filter(item => item.accountId === 'a2').map(item => item.reports), [1, 2], 'a2：探测前 a1 已上报 1 次，本体前 = 2 次（流程内上报已跳过）')
  } finally {
    await cleanupRoot(root)
  }
})

test('U8 批量：靠后账号探测结果超 TTL → 回落重新探测（3 次启动），其余仍复用', async () => {
  const root = await makeEnv('wx-u8', ['a1', 'a2'])
  try {
    const infra = makeReuseInfra()
    const deps = createWxHostDeps({
      root,
      workbench: infra.workbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: infra.factory,
    })
    // a2 的探测结果带已过期的 probedAt（构造即超 TTL，等价于注入时钟推进）。
    const staleProbe = async (accountId: string): Promise<{ sessionStatus: string; reason: string | null; probe?: ProbedSession<RefreshedSession> }> => ({
      sessionStatus: 'ok',
      reason: null,
      probe: {
        state: { sessionStatus: 'ok', reason: null, sessionSeq: 1, checkedAt: new Date().toISOString(), vaultRef: `vault://wx/${accountId}`, accountId, sessionStatusReported: true },
        reported: true,
        probedAt: accountId === 'a2' ? Date.now() - PROBE_REUSE_TTL_MS - 1_000 : Date.now(),
      },
    })
    const { handlers } = wireHost(deps, { batchProbe: staleProbe, rand: () => 0, sleep: async () => undefined })
    const started = await callHandler(handlers, 'collectAll.start', {})
    assert.equal(started.started, true)
    await deps.taskRegistry.awaitSettled()
    // 合成 batchProbe 不发 Chrome：a1 新鲜探测直接复用 → 第 1 次启动就是采集
    // 本体（0 上报）；a2 超 TTL 回落 → 重新探测（补报 1）后再本体。
    assert.deepEqual([...infra.launches.entries()].sort(), [['a1', 1], ['a2', 2]], 'a1 复用（仅本体 1 次启动）；a2 回落（探测 + 本体 2 次）')
    assert.deepEqual(infra.launchLog.filter(item => item.accountId === 'a1').map(item => item.reports), [0], 'a1 复用：进入本体前零上报')
    assert.deepEqual(infra.launchLog.filter(item => item.accountId === 'a2').map(item => item.reports), [0, 1], 'a2 回落：探测前 0 上报，探测补报后进本体')
  } finally {
    await cleanupRoot(root)
  }
})

// --- U7b 生产接线回归（collect-probe-reuse）：批量门面必须透传 probed ---

test('U7b 生产接线（与 index.ts apply 同构）：批量阶段 2 复用阶段 1 探测，每账号仅本体 1 次启动', async () => {
  const root = await makeEnv('wx-u7b', ['a1', 'a2'])
  try {
    // 合成 batchProbe 不发 Chrome（与生产 probe 回调同构的返回形状）：复用生效时
    // 每账号唯一一次启动就是采集本体；门面丢 probed 时会回落重探测（2 次启动）
    // 且流程内补报——本用例同时抓住两种回退（验收轮 2 的 F1 即由本形态证实）。
    const launches = new Map<string, number>()
    const reports: string[] = []
    const workbench: WxWorkbenchFace = {
      callTool: async (_caller: string, _domain: string, name: string) => {
        if (name === 'workbench_wx_session_status_report') reports.push(name)
        return { structuredContent: {}, content: [] }
      },
    } as never
    const factory: ChromeFactory = async options => {
      const accountId = basename(options.profileDir)
      launches.set(accountId, (launches.get(accountId) ?? 0) + 1)
      const page = {
        goto: async () => undefined,
        evaluate: async (_fn: unknown, arg: { url: string }) => {
          if (typeof arg?.url === 'string' && arg.url.includes('auth_data')) return { status: 200, text: authDataBody(accountId) }
          return { status: 500, text: '' }
        },
      }
      const context = { pages: () => [page], newPage: async () => page, cookies: async () => [{ name: 'sessionid', value: 'v' }], storageState: async () => ({ cookies: [], origins: [] }), close: async () => undefined }
      return { context } as never
    }
    const deps = createWxHostDeps({
      root,
      workbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: factory,
    })
    let batch: ReturnType<typeof createBatchCollectController>
    const collect: CollectController = createCollectController(
      { workbench: deps.workbench, root, chromeFactory: factory, logger: deps.logger, locks: deps.locks },
      { batchHasRunning: () => batch.running || deps.batchReserved, taskRegistry: deps.taskRegistry, signals: deps.collectSignals },
    )
    // 门面与生产 index.ts apply 逐行同构（含 probed 透传行）。
    batch = createBatchCollectController({
      collect: {
        start: input => collect.start({
          accountId: input.accountId,
          fromBatch: true,
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.probed !== undefined ? { probed: input.probed } : {}),
        }),
        wait: accountId => collect.wait(accountId),
        hasRunning: () => collect.hasRunning(),
      },
      probe: async accountId => ({
        sessionStatus: 'ok',
        reason: null,
        probe: {
          state: { sessionStatus: 'ok', reason: null, sessionSeq: 1, checkedAt: new Date().toISOString(), vaultRef: `vault://wx/${accountId}`, accountId, sessionStatusReported: true },
          reported: true,
          probedAt: Date.now(),
        },
      }),
      logger: deps.logger,
      trackRun: promise => { deps.taskRegistry.track(promise) },
      rand: () => 0,
      sleep: async () => undefined,
    })
    const handlers = buildRouteHandlers(deps, batch, collect) as Record<string, (args: Record<string, string | boolean>) => Promise<object>>
    const started = await callHandler(handlers, 'collectAll.start', {})
    assert.equal(started.started, true)
    await deps.taskRegistry.awaitSettled()
    assert.deepEqual([...launches.entries()].sort(), [['a1', 1], ['a2', 1]], '每账号唯一一次启动 = 采集本体（阶段 1 合成探测不发 Chrome，复用跳过流程内探测）')
  } finally {
    await cleanupRoot(root)
  }
})

// --- B1 action 清单 ---

test('B1 action 清单含 collect.running（25 项：mount-restore 单删除 account.refreshLoginQr 后 22 项 + AI 报表 3 项），ACTION_SCHEMAS 为空字段', () => {
  assert.equal(Object.keys(ACTION_SCHEMAS).length, 25, `action 总数应为 25: ${String(Object.keys(ACTION_SCHEMAS).length)}`)
  assert.ok('collect.running' in ACTION_SCHEMAS)
  assert.deepEqual(ACTION_SCHEMAS['collect.running']?.fields, {})
  // collect.status 增可选 accountId（≤128）。
  assert.deepEqual(ACTION_SCHEMAS['collect.status']?.fields, { accountId: 'string' })
  assert.equal(ACTION_SCHEMAS['collect.status']?.limits?.accountId, 128)
})

// --- B2 单账号控制器互斥与并发（handler 级，真实 runCollection + 门控 Chrome） ---

test('B2 同账号运行中再次 collect.start → collect_busy；不同账号可同时运行', async () => {
  const root = await makeEnv('wx-b2', ['acc1', 'acc2'])
  try {
    let depsRef: WxHostDeps | undefined
    const deps = createWxHostDeps({
      root,
      workbench: noopWorkbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: makeGateFactory(id => depsRef?.collectSignals.get(id)?.signal, ['acc1', 'acc2']),
    })
    depsRef = deps
    const { handlers } = wireHost(deps)
    const first = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
    assert.equal(first.started, true)
    // 同账号运行中（采集本体挂起在 Chrome goto）：再次启动被拒。
    const second = await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
    assert.deepEqual(second, { status: 'ok', started: false, reason: 'collect_busy' })
    // 不同账号不受阻塞：acc2 同时启动。
    const other = await callHandler(handlers, 'collect.start', { accountId: 'acc2' })
    assert.equal(other.started, true)
    const status = await callHandler(handlers, 'collect.status', {})
    assert.deepEqual(status.runningAccountIds, ['acc1', 'acc2'], '两个账号同时运行，按启动顺序')
    await disposeHostTasks({ deps, batch: { stop: () => undefined } })
    assert.equal(deps.collectSignals.size, 0)
  } finally {
    await cleanupRoot(root)
  }
})

// --- B3 批量互斥与 fromBatch 放行 ---

test('B3 批量运行中页面发起单账号 → collect_busy；fromBatch 内部启动不受拦截', async () => {
  const root = await makeEnv('wx-b3', ['acc1'])
  let releaseBatchProbe: (() => void) | undefined
  const batchProbeGate = new Promise<void>(resolve => { releaseBatchProbe = resolve })
  try {
    const deps = createWxHostDeps({
      root,
      workbench: noopWorkbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: makeGateFactory(() => undefined, []),
    })
    // 批量探测挂起：批次停在 probing，保持 running 可观察。
    const { batch, collect, handlers } = wireHost(deps, {
      batchProbe: () => batchProbeGate.then(() => ({ sessionStatus: 'ok', reason: null })),
    })
    const started = await callHandler(handlers, 'collectAll.start', {})
    assert.equal(started.started, true)
    await flush()
    assert.equal(batch.running, true)
    // 页面发起（无 fromBatch）：批量互斥钩子拒绝。
    const page = await collect.start({ accountId: 'acc1', newAttempt: true })
    assert.equal(page.started, false)
    assert.equal(page.reason, 'collect_busy')
    // 批量内部启动（fromBatch）：放行；无真实差异——这里直接断言控制器放行后
    // 记录进入 running（探测通过前就登记，与页面路径的探测等待不同）。
    const internal = await collect.start({ accountId: 'acc1', newAttempt: true, fromBatch: true })
    assert.equal(internal.started, true)
    assert.notEqual(internal.record, null)
    releaseBatchProbe?.()
    await disposeHostTasks({ deps, batch })
  } finally {
    await cleanupRoot(root)
  }
})

// --- B4/B5/B6 worker 队列：并发峰值、取号顺序、并发度落定 ---

test('B4 并发峰值 = min(并发度, ready 账号数)，任何时刻不超过', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['a1', 'a2', 'a3', 'a4', 'a5'])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2'])
  collect.settle('a1')
  collect.settle('a2')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'])
  collect.settle('a3')
  collect.settle('a4')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4', 'a5'])
  collect.settle('a5')
  await started.runPromise
  assert.equal(batch.status.phase, 'finished')
  assert.equal(collect.peakInFlight(), 2, '在途峰值不超过并发度')
  assert.equal(batch.status.concurrency, 2, '并发度 = min(配置, ready 数)')
})

test('B5 worker 按 accountId 排序取号；runningAccountIds 按启动顺序；currentAccountId 为首个', async () => {
  const collect = fakeCollect({ c1: ok(), c2: ok(), c3: ok(), c4: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
  // 入参乱序：items 仍按 accountId 排序产出取号顺序 c1..c4。
  const started = await batch.start(['c3', 'c1', 'c4', 'c2'])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['c1', 'c2', 'c3'])
  assert.deepEqual(batch.status.runningAccountIds, ['c1', 'c2', 'c3'])
  assert.equal(batch.status.currentAccountId, 'c1')
  collect.settle('c1')
  await flush()
  assert.deepEqual(batch.status.runningAccountIds, ['c2', 'c3', 'c4'], '结算后移除、新账号按启动顺序追加')
  assert.equal(batch.status.currentAccountId, 'c2')
  collect.settle('c2')
  collect.settle('c3')
  collect.settle('c4')
  await started.runPromise
  assert.ok(new Set(collect.starts).size === collect.starts.length, '每账号只 collect.start 一次')
  assert.deepEqual(batch.status.items.map(item => item.accountId), ['c1', 'c2', 'c3', 'c4'], 'items 数组顺序不变')
  assert.deepEqual(batch.status.runningAccountIds, [], '终态后运行集合清空')
  assert.equal(batch.status.currentAccountId, null)
})

test('B6 concurrency 在阶段 2 启动时落定，终态后不变；空状态为 0', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 5, rand: zeroRand, sleep: immediateSleep })
  assert.equal(batch.status.concurrency, 0, '未启动过的空状态为 0')
  const started = await batch.start(['a1', 'a2'])
  assert.equal(started.started, true)
  await flush()
  assert.equal(batch.status.concurrency, 2, '落定为 min(5, ready 2)')
  collect.settle('a1')
  collect.settle('a2')
  await started.runPromise
  assert.equal(batch.status.phase, 'finished')
  assert.equal(batch.status.concurrency, 2, '终态后不变')
})

test('B4b batchConcurrency=1：单 worker 串行取号，并发峰值为 1', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 1, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['a1', 'a2', 'a3'])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['a1'], '单 worker：同屏只有第一个账号')
  assert.equal(batch.status.concurrency, 1)
  collect.settle('a1')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2'])
  collect.settle('a2')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3'])
  collect.settle('a3')
  await started.runPromise
  assert.equal(collect.peakInFlight(), 1, '并发峰值 1')
  assert.equal(batch.status.phase, 'finished')
})

// --- B7 单账号 partial / failed 结算 ---

test('B7 单账号 partial 结算为 partial；failed 结算为 failed 并带原因', async () => {
  const collect = fakeCollect({ p1: partial(), f1: collectFailed('ACCOUNT_NOT_FOUND'), c1: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['p1', 'f1', 'c1'])
  assert.equal(started.started, true)
  await flush()
  collect.settle('c1')
  collect.settle('f1')
  collect.settle('p1')
  await started.runPromise
  const byId = new Map(batch.status.items.map(item => [item.accountId, item]))
  assert.equal(byId.get('p1')?.status, 'partial')
  assert.equal(byId.get('p1')?.reason, null, 'partial 不带失败原因')
  assert.equal(byId.get('f1')?.status, 'failed')
  assert.equal(byId.get('f1')?.reason, 'ACCOUNT_NOT_FOUND', 'failed 带稳定原因')
  assert.equal(byId.get('c1')?.status, 'completed')
  assert.equal(batch.status.partialCount, 1)
  assert.equal(batch.status.failedCount, 1)
  assert.equal(batch.status.completedCount, 1)
})

// --- B8/B9 批内熔断 ---

test('B8 风控信号达到 2：剩余条目 skipped/risk_paused，error=risk_paused，已运行账号正常结束', async () => {
  const collect = fakeCollect({ a1: ok(), a2: sessionExpired(), a3: sessionExpired(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['a1', 'a2', 'a3', 'a4', 'a5'])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2'])
  collect.settle('a1')
  collect.settle('a2')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'], '单信号不熔断：第 3、4 个账号继续取号')
  collect.settle('a3')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'], '熔断后不再取新账号')
  collect.settle('a4')
  await started.runPromise
  const status = batch.status
  assert.equal(status.error, 'risk_paused')
  assert.equal(status.phase, 'finished')
  const a5 = status.items.find(item => item.accountId === 'a5')
  assert.ok(a5 !== undefined)
  assert.equal(a5.status, 'skipped')
  assert.equal(a5.reason, 'risk_paused')
  assert.ok(a5.finishedAt !== null, '熔断条目写暂停时刻')
  assert.ok(status.items.find(item => item.accountId === 'a4')?.status === 'completed', '已运行账号正常结束')
  assert.deepEqual(status.runningAccountIds, [])
  assert.equal(status.currentAccountId, null)
  assert.equal(status.skippedCount, 1, 'risk_paused 条目计入 skippedCount')
  assert.equal(status.failedCount, 2, '两个风控信号条目结算 failed')
})

test('B8b 风控熔断零成功条目：汇总 failed 类计数，error 保留 risk_paused', async () => {
  const collect = fakeCollect({ a1: sessionExpired(), a2: sessionExpired(), a3: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['a1', 'a2', 'a3'])
  assert.equal(started.started, true)
  await flush()
  collect.settle('a1')
  collect.settle('a2')
  await started.runPromise
  assert.equal(batch.status.error, 'risk_paused')
  const a3 = batch.status.items.find(item => item.accountId === 'a3')
  assert.equal(a3?.status, 'skipped')
  assert.equal(a3?.reason, 'risk_paused')
  assert.equal(batch.status.completedCount, 0)
})

test('B9 熔断不误触：单信号、非风控失败原因、取消类失败都不暂停', async () => {
  const cases: { name: string; script: CollectScript }[] = [
    { name: '单个 session_expired', script: { a1: ok(), a2: sessionExpired(), a3: ok() } },
    { name: 'failed 非风控原因', script: { a1: collectFailed('UNAUTHORIZED'), a2: collectFailed('UNAUTHORIZED'), a3: ok() } },
    { name: 'collect_cancelled 不计数', script: { a1: collectFailed('collect_cancelled'), a2: collectFailed('collect_cancelled'), a3: ok() } },
  ]
  for (const item of cases) {
    const collect = fakeCollect(item.script, true)
    const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
    const started = await batch.start(['a1', 'a2', 'a3'])
    assert.equal(started.started, true, item.name)
    await flush()
    collect.settle('a1')
    collect.settle('a2')
    collect.settle('a3')
    await started.runPromise
    assert.equal(batch.status.error, null, `${item.name}：不置批次 error`)
    assert.equal(batch.status.items.filter(entry => entry.reason === 'risk_paused').length, 0, `${item.name}：无 risk_paused 条目`)
    assert.deepEqual(collect.starts, ['a1', 'a2', 'a3'], `${item.name}：全部账号照常取号`)
  }
})

test('B9b 阶段 1 跳过任意数量不计入风控信号', async () => {
  const probeScript: Record<string, { sessionStatus: string; reason: string | null }> = {
    s1: { sessionStatus: 'expired', reason: 'session_expired' },
    s2: { sessionStatus: 'unknown', reason: 'probe_failed' },
    s3: { sessionStatus: 'expired', reason: 'session_expired' },
    s4: { sessionStatus: 'expired', reason: 'session_expired' },
    b1: { sessionStatus: 'ok', reason: null },
    b2: { sessionStatus: 'ok', reason: null },
  }
  const collect = fakeCollect({ b1: sessionExpired(), b2: ok() }, true)
  const batch = createBatchCollectController({
    collect,
    probe: async accountId => {
      const scripted = probeScript[accountId]
      if (scripted === undefined) throw new Error(`unscripted probe: ${accountId}`)
      return scripted
    },
    concurrency: 2,
    rand: zeroRand,
    sleep: immediateSleep,
  })
  const started = await batch.start(['s1', 's2', 's3', 's4', 'b1', 'b2'])
  assert.equal(started.started, true)
  await flush()
  collect.settle('b1')
  collect.settle('b2')
  await started.runPromise
  assert.equal(batch.status.error, null, '4 个阶段 1 跳过 + 1 个风控信号：不熔断')
  assert.deepEqual(collect.starts, ['b1', 'b2'])
  assert.equal(batch.status.skippedCount, 4)
  assert.ok(batch.status.items.filter(item => item.accountId.startsWith('s')).every(item => item.reason !== 'risk_paused'))
})

// --- B10 错峰接缝 ---

test('B10 错峰：第 k 个 worker 首取延迟为 k × (base + rand × spread)，取号间隔在 0..gap 内', async () => {
  const sleeps: number[] = []
  const recordingSleep = (ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve() }
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: halfRand, sleep: recordingSleep })
  const started = await batch.start(['a1', 'a2', 'a3', 'a4', 'a5'])
  assert.equal(started.started, true)
  await flush()
  // 首取：worker 0 = 0 × (3000 + 0.5×5000) = 0；worker 1 = 1 × 5500 = 5500。
  assert.equal(sleeps[0], 0)
  assert.equal(sleeps[1], 5_500)
  collect.settle('a1')
  collect.settle('a2')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'])
  collect.settle('a3')
  collect.settle('a4')
  await flush()
  collect.settle('a5')
  await started.runPromise
  const nextWaits = sleeps.slice(2)
  assert.ok(nextWaits.length >= 3, `每个后续取号各等待一次：${String(nextWaits.length)}`)
  assert.ok(nextWaits.every(ms => ms >= 0 && ms <= 3_000), `取号间隔在 0..3000 内：${nextWaits.join(',')}`)
})

// --- B11 Config 校验 ---

test('B11 batchConcurrency：缺省 3；0/6/2.5/\'3\' 拒绝；1 与 5 接受', async () => {
  const { Config } = await import('../src/index.ts')
  assert.equal(Config({}).batchConcurrency, 3)
  for (const invalid of [0, 6, 2.5, '3']) {
    assert.throws(() => Config({ batchConcurrency: invalid }), `非法值 ${String(invalid)} 必须被 schema 拒绝`)
  }
  assert.equal(Config({ batchConcurrency: 1 }).batchConcurrency, 1)
  assert.equal(Config({ batchConcurrency: 5 }).batchConcurrency, 5)
})

// --- B12 stop 收口 ---

test('B12 stop() → stopping；在途账号 abort 并结算 collect_cancelled；后续账号不启动；settle 后 finished', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok(), a4: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = await batch.start(['a1', 'a2', 'a3', 'a4'])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2'])
  assert.equal(batch.status.phase, 'collecting')
  batch.stop()
  assert.equal(batch.status.phase, 'stopping')
  assert.deepEqual(collect.starts, ['a1', 'a2'], 'stop 后等待中的 worker 不取新账号')
  // abort 后挂起的 wait 立即返回（假 collect 依赖 signal abort），worker 结算
  // collect_cancelled，全部 settle 后 finished。
  await started.runPromise
  assert.equal(batch.status.phase, 'finished')
  assert.equal(batch.status.error, 'collect_cancelled')
  assert.ok(batch.status.items.every(item => item.status === 'failed' && item.reason === 'collect_cancelled'), `全部条目 collect_cancelled: ${JSON.stringify(batch.status.items)}`)
  assert.deepEqual(batch.status.runningAccountIds, [])
  assert.equal(batch.status.currentAccountId, null)
  assert.equal(batch.status.ready, true)
})

// --- B14 collect.wait 幂等 ---

test('B14 collect.wait 在任务已完成时立即返回结果（重复 wait 幂等）', async () => {
  const root = await makeEnv('wx-b14', ['acc1'])
  try {
    const deps = createWxHostDeps({
      root,
      workbench: noopWorkbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: makeGateFactory(() => undefined, []),
    })
    const { collect } = wireHost(deps)
    // 真实 runCollection 在 fake Chrome 上快速失败（无作品可采，不挂起）。
    const started = await collect.start({ accountId: 'acc1', fromBatch: true })
    assert.equal(started.started, true)
    const first = await collect.wait('acc1')
    assert.ok(first !== null, 'wait 返回采集结果')
    const begin = Date.now()
    const second = await collect.wait('acc1')
    assert.deepEqual(second, first, '任务已完成时 wait 幂等返回同结果')
    assert.ok(Date.now() - begin < 100, '重复 wait 立即返回')
    await disposeHostTasks({ deps, batch: { stop: () => undefined } })
  } finally {
    await cleanupRoot(root)
  }
})

// --- B15/B16 collect.status / collect.running 投影（handler 级） ---

test('B15 collect.status 传 accountId 返回该账号记录；未传返回首个运行中；runningAccountIds 正确', async () => {
  const root = await makeEnv('wx-b15', ['acc1', 'acc2'])
  try {
    let depsRef: WxHostDeps | undefined
    const deps = createWxHostDeps({
      root,
      workbench: noopWorkbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: makeGateFactory(id => depsRef?.collectSignals.get(id)?.signal, ['acc1', 'acc2']),
    })
    depsRef = deps
    const { handlers } = wireHost(deps)
    await callHandler(handlers, 'collect.start', { accountId: 'acc1' })
    await callHandler(handlers, 'collect.start', { accountId: 'acc2' })
    const both = await callHandler(handlers, 'collect.status', {})
    assert.deepEqual(both.runningAccountIds, ['acc1', 'acc2'])
    assert.equal(both.busy, true)
    assert.equal((both.collect as { accountId?: string } | null)?.accountId, 'acc1', '未传 accountId 返回首个运行中')
    const one = await callHandler(handlers, 'collect.status', { accountId: 'acc2' })
    assert.equal((one.collect as { accountId?: string } | null)?.accountId, 'acc2', '传 accountId 返回该账号记录')
    const missing = await callHandler(handlers, 'collect.status', { accountId: 'acc9' })
    assert.equal(missing.collect, null, '无记录账号返回 null')
    assert.equal(missing.busy, true, 'busy 表示任一账号运行中')
    await disposeHostTasks({ deps, batch: { stop: () => undefined } })
  } finally {
    await cleanupRoot(root)
  }
})

test('B16 collect.running 无运行中时 collect=null；批量运行中 batchRunning=true', async () => {
  const root = await makeEnv('wx-b16', ['acc1'])
  let releaseBatchProbe: (() => void) | undefined
  const batchProbeGate = new Promise<void>(resolve => { releaseBatchProbe = resolve })
  try {
    const deps = createWxHostDeps({
      root,
      workbench: noopWorkbench,
      browserStatusFn: async () => ({ chrome: 'available', driver: 'available' }),
      logger: { warn: () => undefined },
      chromeFactory: makeGateFactory(() => undefined, []),
    })
    const { batch, handlers } = wireHost(deps, {
      batchProbe: () => batchProbeGate.then(() => ({ sessionStatus: 'ok', reason: null })),
    })
    const idle = await callHandler(handlers, 'collect.running', {})
    assert.deepEqual(idle, { status: 'ok', collect: null, batchRunning: false })
    const started = await callHandler(handlers, 'collectAll.start', {})
    assert.equal(started.started, true)
    await flush()
    const running = await callHandler(handlers, 'collect.running', {})
    assert.equal(running.batchRunning, true, '批量运行中 batchRunning=true')
    assert.equal(batch.status.phase, 'probing')
    releaseBatchProbe?.()
    await disposeHostTasks({ deps, batch })
  } finally {
    await cleanupRoot(root)
  }
})

// --- B17 阶段 1 全拦截 ---

test('B17 阶段 1 全部拦截 → 批次 error=no_eligible_account，阶段 2 不启动', async () => {
  const collect = fakeCollect({}, true)
  let probeCalls = 0
  const batch = createBatchCollectController({
    collect,
    probe: async () => {
      probeCalls += 1
      return { sessionStatus: 'expired', reason: 'session_expired' }
    },
    concurrency: 2,
    rand: zeroRand,
    sleep: immediateSleep,
  })
  const started = await batch.start(['b1', 'b2'])
  assert.equal(started.started, true)
  await started.runPromise
  assert.equal(probeCalls, 2, '阶段 1 串行探测全部账号')
  assert.equal(batch.status.phase, 'finished')
  assert.equal(batch.status.error, 'no_eligible_account')
  assert.equal(collect.starts.length, 0, '阶段 2 不启动')
  assert.ok(batch.status.items.every(item => item.status === 'skipped' && item.reason === 'session_required'))
})

// --- runs.json 并发写入隔离（行为保持不变 #9） ---

test('runs.json 三账号并发：每条记录只写自己的 accountId/attemptId，终态全部落盘', async () => {
  const root = await makeEnv('wx-b-runs', [])
  try {
    const attempts = new Map<string, string>()
    const collect = {
      start: async (input: FakeStartInput): Promise<{ started: boolean; reason?: string }> => {
        const attemptId = createAttemptId(input.accountId)
        attempts.set(input.accountId, attemptId)
        await updateRun(root, input.accountId, attemptId, { status: 'running' })
        return { started: true }
      },
      wait: async (accountId: string): Promise<CollectResult | null> => {
        const attemptId = attempts.get(accountId) ?? ''
        await updateRun(root, accountId, attemptId, { status: 'completed', finishedAt: new Date().toISOString() })
        return ok()
      },
      hasRunning: (): boolean => false,
    }
    const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
    const started = await batch.start(['a1', 'a2', 'a3'])
    assert.equal(started.started, true)
    await started.runPromise
    const runs = await readRuns(root)
    assert.equal(Object.keys(runs).length, 3, '三条 run 记录全部落盘')
    assert.equal(new Set(attempts.values()).size, 3, 'attemptId 互不重复')
    for (const [accountId, attemptId] of attempts) {
      const record = runs[attemptId]
      assert.ok(record !== undefined, `${accountId} 的 run 记录存在`)
      assert.equal(record.accountId, accountId, '每条记录只写自己的 accountId')
      assert.equal(record.attemptId, attemptId)
      assert.equal(record.status, 'completed', '终态落盘')
    }
    // 同一账号任一时刻至多一条 running：三次启动各自唯一 attemptId 键。
    const raw = JSON.parse(await readFile(join(root, 'runs.json'), 'utf8')) as Record<string, { accountId: string; status: string }>
    const runningKeys = Object.entries(raw).filter(([, record]) => record.status === 'running')
    assert.equal(runningKeys.length, 0, '全部收敛后无 running 残留')
  } finally {
    await cleanupRoot(root)
  }
})
