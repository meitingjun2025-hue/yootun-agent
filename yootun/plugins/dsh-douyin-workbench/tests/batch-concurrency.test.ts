/**
 * 批量采集并发测试（node --test）：候选筛选（pending/无凭证）、阶段 2 worker
 * 队列的并发峰值、取号顺序、单次启动、探测串行、no_eligible_account、
 * collect_busy 互斥、批内熔断、错峰接缝、Config.batchConcurrency 校验与
 * runs.json 并发写入隔离。时序全部经 concurrency/rand/sleep 注入控制，不依赖
 * 真实计时；不启动真实 Chrome，不访问生产 endpoint。
 * 运行：`node --test tests/batch-concurrency.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildRouteHandlers, createDouyinHostDeps, Config } from '../src/index.ts'
import { createProfileLocks } from '@yootun/dsh-workbench-host-kit'
import { batchCandidates, createBatchCollectController, createCollectController, PROBE_REUSE_TTL_MS, type CollectResult, type RunOptions, type RunnerDeps } from '../src/runner.ts'
import { createAttemptId, readRuns, updateRun } from '../src/runs.ts'
import { paths, updateAccount } from '../src/state.ts'
import { createFakeWorkbench, tempRoot } from './fakes.ts'
import { routeAction } from './route-actions.ts'

/** 采集成功结果（completed 口径）。 */
const ok = (): CollectResult => ({ status: 'ready', runStatus: 'completed', listComplete: true })

/** 采集途中会话失效（风控信号：status 承载）。 */
const sessionExpired = (): CollectResult => ({ status: 'session_expired', reason: 'session_invalid' })

/** 采集失败（reason 决定是否计入风控信号）。 */
const collectFailed = (reason: string): CollectResult => ({ status: 'collect_failed', reason })

/** 入库失败（不计数风控信号）。 */
const ingestFailed = (): CollectResult => ({ status: 'ingest_failed', reason: 'ingest_failed' })

/** 零随机接缝（错峰与取号间隔全部落基数）。 */
const zeroRand = (): number => 0

/** 零等待接缝：立即返回（时序完全由 settle 门控决定）。 */
const immediateSleep = (): Promise<void> => Promise.resolve()

/** 让微任务与 immediate sleep 链清空（两个 macrotask 边界）。 */
const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** 采集脚本（accountId → 终态结果）。 */
type CollectScript = Record<string, CollectResult | null>

/** 候选账号入参（skipped 走阶段 0 直接跳过）。 */
function candidate(accountId: string, skipped = false, reason: string | null = null): { accountId: string; skipped: boolean; reason: string | null } {
  return { accountId, skipped, reason }
}

/**
 * 受控假 collect：记录调用序、携带 signal 与在途峰值；gate 为 true 时 wait
 * 挂起直到 settle(accountId)，否则按脚本立即返回终态。
 */
function fakeCollect(script: CollectScript, gate: boolean) {
  const starts: string[] = []
  const signals: Array<AbortSignal | undefined> = []
  let inFlight = 0
  let peak = 0
  const gates = new Map<string, () => void>()
  return {
    starts,
    signals,
    peakInFlight: (): number => peak,
    settle: (accountId: string): void => { gates.get(accountId)?.() },
    start: (input: { accountId: string; options?: Partial<RunOptions> }) => {
      starts.push(input.accountId)
      signals.push(input.options?.signal)
      if (!(input.accountId in script)) return { started: false, record: null, reason: 'collect_busy' }
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return {
        started: true,
        record: { accountId: input.accountId, status: 'running' as const, startedAt: new Date().toISOString(), finishedAt: null, events: [] as Record<string, unknown>[], result: null, error: null },
      }
    },
    wait: async (accountId: string): Promise<CollectResult | null> => {
      if (gate) await new Promise<void>(resolve => { gates.set(accountId, resolve) })
      inFlight -= 1
      return script[accountId] ?? null
    },
    hasRunning: (): boolean => inFlight > 0,
  }
}

/** 写入本地账号记录 + storage_state 占位（批量候选就绪；sessionStatus 缺省 ok）。 */
async function seedAccount(root: string, accountId: string, sessionStatus: string = 'ok'): Promise<void> {
  await updateAccount(accountId, { sessionStatus }, root)
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(paths(root).storageStatePath(accountId), '{"cookies":[]}')
}

// --- U9 抖音探测复用接线（collect-probe-reuse；控制器层，无 Chrome 假件） ---

/** 记录 probed 透传的 collect 门面（复用 fakeCollect 的 starts 记录形态）。 */
function probedRecordingCollect() {
  const starts: Array<{ accountId: string; probed: unknown }> = []
  return {
    starts,
    start: (input: { accountId: string; options?: Partial<RunOptions> }) => {
      starts.push({ accountId: input.accountId, probed: input.options?.probed })
      return {
        started: true,
        record: { accountId: input.accountId, status: 'running' as const, startedAt: new Date().toISOString(), finishedAt: null, events: [] as Record<string, unknown>[], result: null, error: null },
      }
    },
    wait: async (): Promise<CollectResult | null> => ({ status: 'ready', runId: 'r1' }) as CollectResult,
    hasRunning: (): boolean => false,
  }
}

test('U9 批量阶段 1 的探测结果随阶段 2 启动传入（options.probed，TTL 内新鲜）', async () => {
  const collect = probedRecordingCollect()
  const batch = createBatchCollectController({
    collect,
    probe: async accountId => ({
      sessionStatus: 'ok',
      reason: null,
      probe: { state: { sessionStatus: 'ok', reason: null, sessionSeq: 1, checkedAt: new Date().toISOString(), vaultRef: `vault://douyin/${accountId}`, accountId, profile: null }, reported: true, probedAt: Date.now() },
    }),
    rand: () => 0,
    sleep: async () => undefined,
  })
  const started = batch.start([candidate('a1'), candidate('a2')])
  assert.equal(started.started, true)
  await started.runPromise
  assert.deepEqual(collect.starts.map(item => item.accountId).sort(), ['a1', 'a2'])
  for (const item of collect.starts) {
    const probed = item.probed as { probedAt: number } | undefined
    assert.ok(probed !== undefined, `阶段 2 启动 ${item.accountId} 应携带阶段 1 的探测结果`)
    assert.ok(Date.now() - probed.probedAt <= PROBE_REUSE_TTL_MS, 'probedAt 在有效期内')
    assert.equal(probed.probedAt <= Date.now(), true, 'probedAt 不晚于当前时刻')
  }
})

/** 候选筛选纯本地：callTool 一旦被调用即失败（RunnerDeps 最小接缝）。 */
function candidateDeps(root: string): RunnerDeps {
  return {
    callTool: async (): Promise<never> => { throw new Error('no workbench in candidate tests') },
    root,
    locks: createProfileLocks(),
    logger: { warn: (): void => undefined },
  }
}

test('B1 并发峰值 ≤ batchConcurrency：5 账号 2 路并发，同时在途不超过 2', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3'), candidate('a4'), candidate('a5')])
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
  assert.equal(collect.peakInFlight(), 2, '在途峰值不超过并发度')
  assert.equal(batch.status.status, 'completed')
  assert.equal(batch.status.concurrency, 2)
})

test('B2+B3 每账号仅启动一次，取号顺序与 runnable 顺序一致，items 顺序不变', async () => {
  const collect = fakeCollect({ c1: ok(), c2: ok(), c3: ok(), c4: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
  // 入参乱序：控制器按 accountId 排序产出 runnable（c1..c4）。
  const started = batch.start([candidate('c3'), candidate('c1'), candidate('c4'), candidate('c2')])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(collect.starts, ['c1', 'c2', 'c3'])
  collect.settle('c1')
  collect.settle('c2')
  collect.settle('c3')
  await flush()
  assert.deepEqual(collect.starts, ['c1', 'c2', 'c3', 'c4'])
  collect.settle('c4')
  await started.runPromise
  assert.equal(new Set(collect.starts).size, collect.starts.length, '每账号只 collect.start 一次')
  assert.deepEqual(batch.status.items.map(item => item.accountId), ['c1', 'c2', 'c3', 'c4'], 'items 数组顺序不变')
  assert.ok(batch.status.items.every(item => item.status === 'completed'))
})

test('B10 投影：currentAccountId 取 runningAccountIds[0]，终态后空集合与 null', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3')])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(batch.status.runningAccountIds, ['a1', 'a2'], '运行中账号按启动顺序')
  assert.equal(batch.status.currentAccountId, 'a1')
  assert.equal(batch.status.concurrency, 2)
  collect.settle('a1')
  await flush()
  assert.deepEqual(batch.status.runningAccountIds, ['a2', 'a3'], '结算后移除、新账号按启动顺序追加')
  assert.equal(batch.status.currentAccountId, 'a2')
  collect.settle('a2')
  collect.settle('a3')
  await started.runPromise
  assert.deepEqual(batch.status.runningAccountIds, [])
  assert.equal(batch.status.currentAccountId, null)
  assert.equal(batch.status.concurrency, 2)
})

test('B4 阶段 1 仍串行且先于任何采集：探测逐个进行，探测期间零 collect.start', async () => {
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok() }, true)
  const probeCalls: string[] = []
  const releaseProbe = new Map<string, () => void>()
  const batch = createBatchCollectController({
    collect,
    probe: (accountId: string) => new Promise<{ sessionStatus: string; reason: string | null }>(resolve => {
      probeCalls.push(accountId)
      releaseProbe.set(accountId, () => resolve({ sessionStatus: 'ok', reason: null }))
    }),
    concurrency: 3,
    rand: zeroRand,
    sleep: immediateSleep,
  })
  const started = batch.start([candidate('a3'), candidate('a1'), candidate('a2')])
  assert.equal(started.started, true)
  await flush()
  assert.deepEqual(probeCalls, ['a1'], '探测串行：首个挂起时后续不启动')
  assert.equal(collect.starts.length, 0, '探测期间不启动任何采集')
  releaseProbe.get('a1')?.()
  await flush()
  assert.deepEqual(probeCalls, ['a1', 'a2'])
  assert.equal(collect.starts.length, 0)
  releaseProbe.get('a2')?.()
  await flush()
  assert.deepEqual(probeCalls, ['a1', 'a2', 'a3'])
  assert.equal(collect.starts.length, 0)
  releaseProbe.get('a3')?.()
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3'], '探测全部完成后才进入采集')
  collect.settle('a1')
  collect.settle('a2')
  collect.settle('a3')
  await started.runPromise
  assert.equal(batch.status.status, 'completed')
  assert.equal(batch.status.probedCount, 3)
})

test('B5 no_eligible_account：全部被探测拦截时不启动任何采集', async () => {
  // 阶段 0 全拦截：同步拒绝，批次不启动。
  const idle = fakeCollect({}, false)
  let probeCalls = 0
  const batch = createBatchCollectController({ collect: idle, probe: async () => { probeCalls += 1; return { sessionStatus: 'ok', reason: null } } })
  const rejected = batch.start([candidate('a1', true, 'session_required'), candidate('a2', true, 'pending_account')])
  assert.equal(rejected.started, false)
  assert.equal(rejected.reason, 'no_eligible_account')
  assert.equal(idle.starts.length, 0)
  assert.equal(probeCalls, 0)
  // 阶段 1 全拦截：批次 failed / no_eligible_account。
  const collect = fakeCollect({}, true)
  const probed = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'expired', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = probed.start([candidate('b1'), candidate('b2')])
  assert.equal(started.started, true)
  await started.runPromise
  assert.equal(probed.status.status, 'failed')
  assert.equal(probed.status.error, 'no_eligible_account')
  assert.equal(collect.starts.length, 0)
  assert.ok(probed.status.items.every(item => item.status === 'skipped' && item.reason === 'session_required'))
})

test('C1 候选只按缓存排除确定不可采：unknown/expired/ok 且有凭证的账号均入围', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await seedAccount(root, 'c1-unknown', 'unknown')
    await seedAccount(root, 'c1-expired', 'expired')
    await seedAccount(root, 'c1-ok')
    const candidates = await batchCandidates(candidateDeps(root))
    assert.deepEqual(candidates.sort((a, b) => a.accountId.localeCompare(b.accountId)), [
      { accountId: 'c1-expired', skipped: false, reason: null },
      { accountId: 'c1-ok', skipped: false, reason: null },
      { accountId: 'c1-unknown', skipped: false, reason: null },
    ], '缓存 unknown/expired 不再预筛：三种缓存状态全部进入阶段 1')
  } finally {
    await cleanup()
  }
})

test('C2 候选仍排除 pending 占位与无凭证账号', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await updateAccount('pending-c2', { sessionStatus: 'ok' }, root)
    await updateAccount('c2-no-cred', { sessionStatus: 'ok' }, root)
    const candidates = await batchCandidates(candidateDeps(root))
    const byId = new Map(candidates.map(item => [item.accountId, item]))
    assert.deepEqual(byId.get('pending-c2'), { accountId: 'pending-c2', skipped: true, reason: 'pending_account' }, 'pending 占位先行于凭证检查')
    assert.deepEqual(byId.get('c2-no-cred'), { accountId: 'c2-no-cred', skipped: true, reason: 'storage_state_missing' })
  } finally {
    await cleanup()
  }
})

test('C3 缓存 unknown 的账号按阶段 1 实测结算：ok → ready 后采集；unknown → probe_failed；expired → session_required', async () => {
  const collect = fakeCollect({ 'c3-ok': ok() }, true)
  const probeScript: Record<string, { sessionStatus: string; reason: string | null }> = {
    'c3-expired': { sessionStatus: 'expired', reason: 'session_expired' },
    'c3-ok': { sessionStatus: 'ok', reason: null },
    'c3-unknown': { sessionStatus: 'unknown', reason: 'probe_failed' },
  }
  // worker 取号前的错峰等待挂起直到 release：让 ready（探测通过、未被取号）可确定性观察。
  let releaseWorker: (() => void) | undefined
  const workerGate = new Promise<void>(resolve => { releaseWorker = resolve })
  const batch = createBatchCollectController({
    collect,
    probe: async accountId => {
      const scripted = probeScript[accountId]
      if (scripted === undefined) throw new Error(`unscripted probe: ${accountId}`)
      return scripted
    },
    concurrency: 2,
    rand: zeroRand,
    sleep: (): Promise<void> => workerGate,
  })
  const started = batch.start([candidate('c3-unknown'), candidate('c3-expired'), candidate('c3-ok')])
  assert.equal(started.started, true)
  await flush()
  // 批次级标量随访问快照：ready/skipped 观察与终态结算各自重新访问 batch.status。
  assert.deepEqual(collect.starts, [], 'worker 仍在错峰等待：探测通过前不取号')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-ok')?.status, 'ready', '实测 ok → ready（等待采集）')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-unknown')?.status, 'skipped')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-unknown')?.reason, 'probe_failed', '实测 unknown → probe_failed，不是 session_required')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-expired')?.status, 'skipped')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-expired')?.reason, 'session_required', '实测 expired → session_required')
  releaseWorker?.()
  await flush()
  assert.deepEqual(collect.starts, ['c3-ok'], '仅实测 ok 的账号进入阶段 2')
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-ok')?.status, 'running')
  collect.settle('c3-ok')
  await started.runPromise
  assert.equal(batch.status.items.find(item => item.accountId === 'c3-ok')?.status, 'completed', '实测通过即被采集')
  assert.equal(batch.status.status, 'completed')
})

test('C4 回归：全部账号被实测拦截 → 批次 failed / no_eligible_account，不启动采集', async () => {
  const collect = fakeCollect({}, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'unknown', reason: 'probe_failed' }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([candidate('c4-a'), candidate('c4-b')])
  assert.equal(started.started, true)
  await started.runPromise
  assert.equal(batch.status.status, 'failed')
  assert.equal(batch.status.error, 'no_eligible_account')
  assert.equal(collect.starts.length, 0, '实测全拦截时不启动任何采集')
  assert.ok(batch.status.items.every(item => item.status === 'skipped' && item.reason === 'probe_failed'))
})

test('B6 批量运行中：collect.start 与重复 collectAll.start 均 collect_busy；settle 后信号清理', async () => {
  const { root, cleanup } = await tempRoot()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    await seedAccount(root, 'b6')
    // 挂起的 chrome factory：批次停在探测阶段，保持 running 可观察。
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: createFakeWorkbench().face,
      chromeFactory: async (): Promise<never> => { await gate; throw new Error('no chrome in concurrency tests') },
      logger: { warn: () => undefined },
    })
    const handlers = buildRouteHandlers(deps)
    const first = await routeAction(handlers, 'collectAll.start')({})
    assert.equal(first.status, 'ready')
    const single = await routeAction(handlers, 'collect.start')({ accountId: 'b6' })
    assert.equal(single.status, 'error')
    assert.equal(single.reason, 'collect_busy')
    const repeat = await routeAction(handlers, 'collectAll.start')({})
    assert.equal(repeat.status, 'error')
    assert.equal(repeat.reason, 'collect_busy')
    release?.()
    await deps.taskRegistry.awaitSettled()
    const running = await routeAction(handlers, 'collect.running')({})
    assert.equal(running.batchRunning, false)
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('collect:batch:')).length, 0, 'settle 后 batch signal 清理')
  } finally {
    await cleanup()
  }
})

test('B8 熔断：第 2 个风控信号后剩余条目 skipped/risk_paused，批次 partial', async () => {
  const collect = fakeCollect({ a1: ok(), a2: sessionExpired(), a3: sessionExpired(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3'), candidate('a4'), candidate('a5')])
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
  assert.equal(status.status, 'partial', '有成功条目时批次 partial')
  const a5 = status.items.find(item => item.accountId === 'a5')
  assert.ok(a5 !== undefined)
  assert.equal(a5.status, 'skipped')
  assert.equal(a5.reason, 'risk_paused')
  assert.ok(a5.finishedAt !== null, '熔断条目写终态时刻')
  assert.equal(a5.collect, undefined, '熔断条目未采集、无 collect 投影')
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'])
  assert.equal(status.skippedCount, 1, 'risk_paused 条目计入 skippedCount')
  assert.equal(status.runnableDone, 4, 'risk_paused 条目不计入 runnableDone')
  assert.equal(status.failedCount, 2)
  assert.deepEqual(status.runningAccountIds, [])
  assert.equal(status.currentAccountId, null)
})

test('B8 熔断：无成功条目时批次 failed', async () => {
  const collect = fakeCollect({ a1: sessionExpired(), a2: sessionExpired(), a3: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3')])
  assert.equal(started.started, true)
  await flush()
  collect.settle('a1')
  collect.settle('a2')
  await started.runPromise
  const status = batch.status
  assert.equal(status.error, 'risk_paused')
  assert.equal(status.status, 'failed', '零成功条目时批次 failed')
  assert.equal(status.items.find(item => item.accountId === 'a3')?.status, 'skipped')
  assert.equal(status.items.find(item => item.accountId === 'a3')?.reason, 'risk_paused')
})

test('B9 熔断不误触：单信号、非风控失败原因、ingest_failed、阶段 1 跳过都不暂停', async () => {
  const cases: { name: string; script: CollectScript }[] = [
    { name: '单个 session_expired', script: { a1: ok(), a2: sessionExpired(), a3: ok() } },
    { name: 'collect_failed 非风控原因', script: { a1: collectFailed('publish_since_required'), a2: collectFailed('publish_since_required'), a3: ok() } },
    { name: 'ingest_failed', script: { a1: ingestFailed(), a2: ingestFailed(), a3: ok() } },
  ]
  for (const item of cases) {
    const collect = fakeCollect(item.script, true)
    const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
    const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3')])
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
  // 阶段 1 跳过任意数量不计数熔断：4 个跳过 + 1 个风控信号 → 不暂停。
  const collect = fakeCollect({ b1: sessionExpired(), b2: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: immediateSleep })
  const started = batch.start([
    candidate('s1', true, 'session_required'),
    candidate('s2', true, 'probe_failed'),
    candidate('s3', true, 'storage_state_missing'),
    candidate('s4', true, 'session_required'),
    candidate('b1'),
    candidate('b2'),
  ])
  assert.equal(started.started, true)
  await flush()
  collect.settle('b1')
  collect.settle('b2')
  await started.runPromise
  assert.equal(batch.status.error, null, '阶段 1 跳过不计入风控信号')
  assert.deepEqual(collect.starts, ['b1', 'b2'])
  assert.equal(batch.status.skippedCount, 4)
  assert.ok(batch.status.items.filter(item => item.accountId.startsWith('s')).every(item => item.reason !== 'risk_paused'))
})

test('B11 错峰：worker k 首取等待 k×3000 毫秒，取号间隔非负（注入接缝记录）', async () => {
  const sleeps: number[] = []
  const recordingSleep = (ms: number): Promise<void> => { sleeps.push(ms); return Promise.resolve() }
  const collect = fakeCollect({ a1: ok(), a2: ok(), a3: ok(), a4: ok(), a5: ok() }, true)
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2, rand: zeroRand, sleep: recordingSleep })
  const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3'), candidate('a4'), candidate('a5')])
  assert.equal(started.started, true)
  await flush()
  // 首取：worker 0 等待 0、worker 1 等待 1×3000（rand=0 落基数下限）。
  assert.ok(sleeps[0] === 0, `worker 0 首取零等待，实际 ${sleeps[0]}`)
  const firstWorkerWait = sleeps[1]
  assert.ok(firstWorkerWait !== undefined && firstWorkerWait >= 3_000, `worker 1 首取 ≥ 3000ms，实际 ${firstWorkerWait}`)
  collect.settle('a1')
  collect.settle('a2')
  await flush()
  assert.deepEqual(collect.starts, ['a1', 'a2', 'a3', 'a4'])
  collect.settle('a3')
  collect.settle('a4')
  await flush()
  collect.settle('a5')
  await started.runPromise
  // 后续每次取号前各等待一次 rand×3000 = 0（游标耗尽的空等也在 0..3000 内）。
  const nextWaits = sleeps.slice(2)
  assert.ok(nextWaits.length >= 3, `每个后续取号各等待一次：${nextWaits.length}`)
  assert.ok(nextWaits.every(ms => ms >= 0 && ms <= 3_000), `取号间隔在 0..3000 内：${nextWaits.join(',')}`)
})

test('B11 缺省等待接缝：abort 后挂起中的 worker 立即结束等待、不取新账号', async () => {
  const controller = new AbortController()
  const starts: string[] = []
  const collect = {
    start: (input: { accountId: string; options?: Partial<RunOptions> }) => {
      starts.push(input.accountId)
      return { started: true, record: { accountId: input.accountId, status: 'running' as const, startedAt: new Date().toISOString(), finishedAt: null, events: [] as Record<string, unknown>[], result: null, error: null } }
    },
    wait: async (): Promise<CollectResult | null> => {
      if (controller.signal.aborted) return null
      await new Promise<void>(resolve => { controller.signal.addEventListener('abort', () => resolve(), { once: true }) })
      return null
    },
    hasRunning: (): boolean => false,
  }
  // 缺省 rand/sleep：worker 1 首取需真实等待 3–8 秒，abort 必须立刻打断它。
  const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 2 })
  const started = batch.start([candidate('a1'), candidate('a2')], { signal: controller.signal })
  assert.equal(started.started, true)
  for (let index = 0; index < 200 && starts.length === 0; index += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(starts, ['a1'], 'worker 0 已取号，worker 1 仍在错峰等待')
  const begin = Date.now()
  controller.abort()
  await started.runPromise
  assert.ok(Date.now() - begin < 100, 'abort 后等待在 100 毫秒内结束')
  assert.deepEqual(starts, ['a1'], '等待中的 worker 不取新账号')
  assert.equal(batch.status.status, 'failed')
  assert.equal(batch.status.error, 'collect_cancelled')
})

test('B12 Config.batchConcurrency：缺省 3；0/6/2.5/\'3\' 拒绝；1 与 5 接受', () => {
  assert.equal(Config({}).batchConcurrency, 3)
  for (const invalid of [0, 6, 2.5, '3']) {
    assert.throws(() => Config({ batchConcurrency: invalid }), `非法值 ${String(invalid)} 必须被 schema 拒绝`)
  }
  assert.equal(Config({ batchConcurrency: 1 }).batchConcurrency, 1)
  assert.equal(Config({ batchConcurrency: 5 }).batchConcurrency, 5)
})

test('B14 三账号并发：runs.json 每条记录只写自己的 accountId/attemptId，终态全部落盘', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const starts: string[] = []
    const attempts = new Map<string, string>()
    const collect = {
      start: (input: { accountId: string; options?: Partial<RunOptions> }) => {
        starts.push(input.accountId)
        const attemptId = createAttemptId()
        attempts.set(input.accountId, attemptId)
        void updateRun(root, input.accountId, attemptId, { status: 'running' }).catch(() => undefined)
        return { started: true, record: { accountId: input.accountId, status: 'running' as const, startedAt: new Date().toISOString(), finishedAt: null, events: [] as Record<string, unknown>[], result: null, error: null } }
      },
      wait: async (accountId: string): Promise<CollectResult | null> => {
        const attemptId = attempts.get(accountId) ?? ''
        await updateRun(root, accountId, attemptId, { status: 'completed', finishedAt: new Date().toISOString() })
        return ok()
      },
      hasRunning: (): boolean => false,
    }
    const batch = createBatchCollectController({ collect, probe: async () => ({ sessionStatus: 'ok', reason: null }), concurrency: 3, rand: zeroRand, sleep: immediateSleep })
    const started = batch.start([candidate('a1'), candidate('a2'), candidate('a3')])
    assert.equal(started.started, true)
    await started.runPromise
    assert.deepEqual(starts, ['a1', 'a2', 'a3'])
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
  } finally {
    await cleanup()
  }
})

test('B6b 真实单账号控制器接线：批量运行中页面发起被拒，批量内部启动（fromBatch）放行', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const workbench = createFakeWorkbench({})
    const collect = createCollectController(
      { callTool: async (tool, args, signal) => workbench.face.callTool('douyin-workbench', 'douyin', tool, args, signal), root, locks: createProfileLocks() },
      { batchHasRunning: () => true },
    )
    // 页面路径（无 fromBatch）：批量运行中被互斥钩子拒绝。
    const refused = collect.start({ accountId: 'page-acc' })
    assert.equal(refused.started, false)
    assert.equal(refused.reason, 'collect_busy')
    // 批量内部启动（fromBatch）：放行；无 storage_state 时 runCollection 快速落 failed。
    const internal = collect.start({ accountId: 'batch-acc', fromBatch: true })
    assert.equal(internal.started, true)
    const result = await collect.wait('batch-acc')
    assert.equal(result?.status, 'collect_failed')
    assert.equal(result?.reason, 'session_required')
  } finally {
    await cleanup()
  }
})
