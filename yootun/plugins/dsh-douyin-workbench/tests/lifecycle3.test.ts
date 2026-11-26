/**
 * 第三轮生命周期测试（node --test）：startup 等待期 dispose 竞态、批量采集
 * AbortSignal（candidates/probe/collect/start 生命周期）、collect.start 前置
 * 阶段请求级 signal。不启动真实 Chrome（chromeFactory 注入快速失败）、不访问
 * 生产 endpoint。
 * 运行：`node --test tests/lifecycle3.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createProfileLocks } from '@yootun/dsh-workbench-host-kit'
import { buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { batchCandidates, createBatchCollectController } from '../src/runner.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import type { WorkbenchFace } from '../src/workbench.ts'

/** 快速失败的 chrome factory（探测路径不启动浏览器）。 */
const fastFailChrome = async (): Promise<never> => { throw new Error('no chrome in lifecycle tests') }

/** 记录 signal 的挂起 face：所有调用挂起直到 signal abort。 */
function hangingFace(): { face: WorkbenchFace; calls: FakeWorkbenchCall[]; signals: Array<AbortSignal | undefined> } {
  const calls: FakeWorkbenchCall[] = []
  const signals: Array<AbortSignal | undefined> = []
  const face: WorkbenchFace = {
    async callTool(caller, domain, name, args, signal) {
      calls.push({ caller, domain, name, args })
      signals.push(signal)
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  return { face, calls, signals }
}

/** 写入本地账号记录 + storage_state 占位（批量候选就绪；增量不覆盖）。 */
async function seedAccount(root: string, accountId: string): Promise<void> {
  const { updateAccount, paths } = await import('../src/state.ts')
  await updateAccount(accountId, { sessionStatus: 'ok' }, root)
  await mkdir(join(root, 'storage-state'), { recursive: true })
  await writeFile(paths(root).storageStatePath(accountId), '{"cookies":[]}')
}

test('§1 startup 等待期 dispose 竞态：等待中的请求被 abort，不发 Workbench 调用，全部 settle', async () => {
  const { root, cleanup } = await tempRoot()
  const hanging = hangingFace()
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: hanging.face,
      chromeFactory: fastFailChrome,
      recovery: async () => { await gate; return 0 },
    })
    const handlers = buildRouteHandlers(deps)
    // recovery gate pending 时发起 works.list。
    let actionSettled = false
    const pending = handlers['works.list']({ accountId: 'acc-r' }).then(
      () => { actionSettled = true },
      () => { actionSettled = true },
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    // dispose：abort 全部登记信号（含等待中的 action signal），等待共同 settle。
    const disposing = disposeHostTasks({ deps })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(actionSettled, false, 'recovery 未 release 前请求仍在等待')
    release?.()
    await disposing
    await pending
    // 断言：face 未收到 works.list 调用；信号清理；disposing 置位。
    assert.equal(hanging.calls.filter(call => call.name === 'workbench_douyin_work_list').length, 0, '等待中的请求不得发出 Workbench 调用')
    assert.equal(actionSettled, true)
    assert.equal(deps.disposing, true)
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0, 'action signal 已清理')
  } finally {
    await cleanup()
  }
})

test('§2 batchCandidates：abort 后立刻抛 collect_cancelled，不再继续遍历', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await seedAccount(root, 'a1')
    await seedAccount(root, 'a2')
    await seedAccount(root, 'a3')
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face, chromeFactory: fastFailChrome })
    const runnerDeps = {
      callTool: deps.callTool,
      locks: createProfileLocks(),
      root: deps.root,
      chromeFactory: deps.chromeFactory,
      maxPages: deps.maxPages,
      logger: { warn: () => undefined },
    }
    // 基线：未 abort 时三账号全部入围。
    const all = await batchCandidates(runnerDeps)
    assert.equal(all.filter(item => !item.skipped).length, 3)
    // abort（进入前即取消）：立刻稳定取消，不产出任何候选。
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => batchCandidates(runnerDeps, controller.signal), (error: unknown) => (error as { code?: string }).code === 'collect_cancelled')
  } finally {
    await cleanup()
  }
})

test('§2 批量 probe 挂起时 dispose：probe 串行且收到 batch signal，剩余账号不启动，batch failed，信号清理', async () => {
  const controller = new AbortController()
  const probeSignals: Array<AbortSignal | undefined> = []
  const collectStarts: string[] = []
  let runSettled: (() => void) | undefined
  const settled = new Promise<void>(resolve => { runSettled = resolve })
  const batch = createBatchCollectController({
    collect: {
      start: input => { collectStarts.push(input.accountId); return { started: true, record: null } },
      wait: async () => null,
      hasRunning: () => false,
    },
    probe: (accountId, signal) => {
      probeSignals.push(signal)
      void accountId
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
    trackRun: promise => { promise.then(() => runSettled?.()) },
  })
  const started = batch.start(
    [{ accountId: 'b1', skipped: false, reason: null }, { accountId: 'b2', skipped: false, reason: null }, { accountId: 'b3', skipped: false, reason: null }],
    { signal: controller.signal },
  )
  assert.equal(started.started, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(probeSignals[0], controller.signal, 'probe 必须收到 batch signal')
  assert.equal(probeSignals.length, 1, '探测仍逐个串行：首个挂起时后续不并行探测')
  // dispose 语义：abort batch signal 并等待 settle。
  controller.abort()
  await settled
  const status = batch.status
  assert.equal(status.status, 'failed')
  assert.equal(status.error, 'collect_cancelled')
  assert.deepEqual(collectStarts, [], '取消后不启动任何账号采集')
  assert.ok(status.items.every(item => item.status === 'failed' && item.reason === 'collect_cancelled'))
})

test('§2 在途账号采集 Workbench 挂起时 dispose：调用收到 batch signal，取消后不取新账号，batch failed', async () => {
  const controller = new AbortController()
  const hanging = hangingFace()
  const collectStarts: string[] = []
  const collectSignals: Array<AbortSignal | undefined> = []
  let runSettled: (() => void) | undefined
  const settled = new Promise<void>(resolve => { runSettled = resolve })
  const batch = createBatchCollectController({
    collect: {
      start: input => {
        collectStarts.push(input.accountId)
        const signal = input.options?.signal
        // 每个在途账号的采集链路发起挂起的 Workbench 写调用（携带 batch signal）。
        void hanging.face.callTool('douyin-workbench', 'douyin', 'workbench_douyin_collect_run_start', {}, signal)
          .catch(() => undefined)
        collectSignals.push(signal)
        return {
          started: true,
          record: { accountId: input.accountId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, events: [], result: null, error: null },
        }
      },
      wait: (accountId: string) => new Promise(resolve => {
        // 采集挂起直到 batch 取消（对齐真实长采集：取消才 settle）。
        void accountId
        const signal = controller.signal
        if (signal.aborted) { resolve(null); return }
        signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
      hasRunning: () => false,
    },
    probe: async () => ({ sessionStatus: 'ok', reason: null }),
    concurrency: 2,
    rand: () => 0,
    sleep: () => Promise.resolve(),
    trackRun: promise => { promise.then(() => runSettled?.()) },
  })
  const started = batch.start(
    [{ accountId: 'c1', skipped: false, reason: null }, { accountId: 'c2', skipped: false, reason: null }, { accountId: 'c3', skipped: false, reason: null }, { accountId: 'c4', skipped: false, reason: null }],
    { signal: controller.signal },
  )
  assert.equal(started.started, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(collectStarts, ['c1', 'c2'], '并发度 2：同时启动两个账号')
  assert.equal(hanging.calls.length, 2, '两路在途 Workbench 调用')
  assert.ok(collectSignals.every(signal => signal === controller.signal), '采集携带 batch signal')
  assert.ok(hanging.signals.every(signal => signal === controller.signal), '在途 Workbench 调用收到 batch signal')
  controller.abort()
  await settled
  const status = batch.status
  assert.equal(status.status, 'failed')
  assert.equal(status.error, 'collect_cancelled')
  assert.deepEqual(collectStarts, ['c1', 'c2'], '取消后不取新账号')
  assert.ok(status.items.every(item => item.status === 'failed' && item.reason === 'collect_cancelled'))
})

test('§2 三个账号同时采集挂起时 dispose：三路在途调用全部收到 signal，后续不启动，批次 failed', async () => {
  const controller = new AbortController()
  const hanging = hangingFace()
  const collectStarts: string[] = []
  let runSettled: (() => void) | undefined
  const settled = new Promise<void>(resolve => { runSettled = resolve })
  const batch = createBatchCollectController({
    collect: {
      start: input => {
        collectStarts.push(input.accountId)
        const signal = input.options?.signal
        // 每路采集发起挂起的 Workbench 写调用（携带 batch signal）。
        void hanging.face.callTool('douyin-workbench', 'douyin', 'workbench_douyin_collect_run_start', {}, signal)
          .catch(() => undefined)
        return {
          started: true,
          record: { accountId: input.accountId, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, events: [], result: null, error: null },
        }
      },
      wait: () => new Promise(resolve => {
        // 采集挂起直到 batch 取消（对齐真实长采集：取消才 settle）。
        const signal = controller.signal
        if (signal.aborted) { resolve(null); return }
        signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
      hasRunning: () => false,
    },
    probe: async () => ({ sessionStatus: 'ok', reason: null }),
    concurrency: 3,
    rand: () => 0,
    sleep: () => Promise.resolve(),
    trackRun: promise => { promise.then(() => runSettled?.()) },
  })
  const started = batch.start(
    [{ accountId: 'd1', skipped: false, reason: null }, { accountId: 'd2', skipped: false, reason: null }, { accountId: 'd3', skipped: false, reason: null }, { accountId: 'd4', skipped: false, reason: null }],
    { signal: controller.signal },
  )
  assert.equal(started.started, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(collectStarts, ['d1', 'd2', 'd3'], '并发度 3：三个账号同时采集')
  assert.equal(hanging.calls.length, 3)
  assert.ok(hanging.signals.every(signal => signal === controller.signal), '三路在途调用全部收到 batch signal')
  controller.abort()
  await settled
  const status = batch.status
  assert.equal(status.status, 'failed')
  assert.equal(status.error, 'collect_cancelled')
  assert.deepEqual(collectStarts, ['d1', 'd2', 'd3'], '取消后第 4 个账号不启动')
  assert.deepEqual(status.runningAccountIds, [])
  assert.equal(status.currentAccountId, null)
  assert.ok(hanging.signals.every(signal => signal?.aborted === true), 'dispose 后全部在途 signal 已 abort')
  assert.ok(status.items.every(item => item.status === 'failed' && item.reason === 'collect_cancelled'))
})

test('§2 collectAll.start 信号生命周期：action: 清理、collect:batch: 保留至 settle', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await seedAccount(root, 'd1')
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face, chromeFactory: fastFailChrome })
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['collectAll.start']({})
    assert.equal(payload.status, 'ready')
    const batchKeys = [...deps.signals.keys()].filter(key => key.startsWith('collect:batch:'))
    assert.equal(batchKeys.length, 1, 'batch 后台 signal 已登记且保留')
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0, '请求级 action signal 已清理')
    // batch settle（探测快速失败 → no_eligible_account / failed）后清理。
    await deps.taskRegistry.awaitSettled()
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('collect:batch:')).length, 0, 'settle 后 batch signal 清理')
  } finally {
    await cleanup()
  }
})

test('§3 collect.start 前置阶段：pending 提升的 save/remove 收到请求级 signal；abort 后返回 collect_cancelled、不启动采集', async () => {
  const { root, cleanup } = await tempRoot()
  const hanging = hangingFace()
  let releasePromote: (() => void) | undefined
  const promoteGate = new Promise<void>(resolve => { releasePromote = resolve })
  try {
    const { writeAccounts } = await import('../src/state.ts')
    await writeAccounts({ version: 1, accounts: { 'pending-p': { accountId: 'pending-p', sessionStatus: 'ok' } } }, root)
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: hanging.face,
      chromeFactory: fastFailChrome,
      // 受控提升：挂起直到测试 release，随后按「升级成功」返回真实账号。
      promote: async input => {
        await promoteGate
        return { promoted: true, accountId: `real-${input.accountId}` }
      },
    })
    const handlers = buildRouteHandlers(deps)
    let settled = false
    const pending = handlers['collect.start']({ accountId: 'pending-p' }).then(
      () => { settled = true },
      () => { settled = true },
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(settled, false, '前置提升挂起中')
    // dispose：请求级 signal 被 abort（提升 gate release 后 save/remove 收到已
    // abort 的 signal，挂起调用立即取消）。
    const disposing = disposeHostTasks({ deps })
    releasePromote?.()
    await disposing
    await pending
    assert.equal(settled, true)
    // save/remove 都收到请求级 signal（guard 创建的 AbortSignal）。
    const saveIndex = hanging.calls.findIndex(call => call.name === 'workbench_douyin_account_save')
    const removeIndex = hanging.calls.findIndex(call => call.name === 'workbench_douyin_account_remove')
    assert.ok(saveIndex >= 0, 'pending 提升发起 account_save')
    assert.ok(removeIndex >= 0, 'pending 提升发起占位行 account_remove')
    assert.ok(hanging.signals[saveIndex] instanceof AbortSignal && hanging.signals[saveIndex]?.aborted === true, 'account_save 收到已 abort 的请求级 signal')
    assert.ok(hanging.signals[removeIndex] instanceof AbortSignal && hanging.signals[removeIndex]?.aborted === true, 'account_remove 收到已 abort 的请求级 signal')
    // abort 后：不创建 collect: 后台信号、不进入 hasStorageState 后续启动。
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('collect:')).length, 0, '不得创建后台采集信号')
    assert.equal(deps.disposing, true)
  } finally {
    await cleanup()
  }
})

test('§3 dispose 后调用 collect.start：立即 plugin_disposing，零 Workbench 调用', async () => {
  const { root, cleanup } = await tempRoot()
  const hanging = hangingFace()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: hanging.face, chromeFactory: fastFailChrome })
    const handlers = buildRouteHandlers(deps)
    await disposeHostTasks({ deps })
    const before = hanging.calls.length
    await assert.rejects(() => handlers['collect.start']({ accountId: 'normal-acc' }), (error: unknown) => (error as { code?: string }).code === 'plugin_disposing')
    assert.equal(hanging.calls.length, before, 'dispose 后不得发出任何 Workbench 调用')
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('collect:')).length, 0)
  } finally {
    await cleanup()
  }
})

test('§3 collect.start 正常路径：action signal 清理、collect: 信号保留至 run settle（复验）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await seedAccount(root, 'e1')
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face, chromeFactory: fastFailChrome })
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['collect.start']({ accountId: 'e1' })
    assert.equal(payload.status, 'ready')
    assert.ok([...deps.signals.keys()].includes('collect:e1'), '后台采集信号保留')
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0)
    await deps.taskRegistry.awaitSettled()
    assert.equal([...deps.signals.keys()].includes('collect:e1'), false, 'run settle 后清理')
  } finally {
    await cleanup()
  }
})

test('H3 collect.running：单账号运行中投影 accountId/status，终态后回到 null', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await seedAccount(root, 'h3')
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face, chromeFactory: fastFailChrome })
    const handlers = buildRouteHandlers(deps)
    assert.equal((await handlers['collect.running']({})).collect, null)
    const started = await handlers['collect.start']({ accountId: 'h3' })
    assert.equal(started.status, 'ready')
    const running = await handlers['collect.running']({})
    assert.equal(running.status, 'ready')
    assert.equal(running.batchRunning, false)
    const collect = running.collect
    assert.ok(collect !== null && typeof collect === 'object', '运行中投影非空')
    const view = collect as Record<string, unknown>
    assert.equal(view.status, 'running')
    assert.equal(view.accountId, 'h3')
    // 快速失败 factory 让 run 立即到终态：投影回到 null（终态不入 running 查询）。
    await deps.taskRegistry.awaitSettled()
    assert.equal((await handlers['collect.running']({})).collect, null)
  } finally {
    await cleanup()
  }
})

test('H4 collect.running：批量运行中（探测阶段）batchRunning 为 true，结束后 false', async () => {
  const { root, cleanup } = await tempRoot()
  let releaseProbe: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseProbe = resolve })
  try {
    await seedAccount(root, 'h4')
    // 挂起的 chrome factory：probe 停在探测阶段，batch 保持 running 可观察。
    const hangingChrome = async (): Promise<never> => { await gate; throw new Error('no chrome in lifecycle tests') }
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face, chromeFactory: hangingChrome })
    const handlers = buildRouteHandlers(deps)
    const started = await handlers['collectAll.start']({})
    assert.equal(started.status, 'ready')
    const running = await handlers['collect.running']({})
    assert.equal(running.batchRunning, true)
    assert.equal(running.collect, null, '批量探测不产生单账号运行投影')
    // release：probe 快速失败 → 全部 skipped → batch failed（no_eligible_account）。
    releaseProbe?.()
    await deps.taskRegistry.awaitSettled()
    assert.equal((await handlers['collect.running']({})).batchRunning, false)
  } finally {
    await cleanup()
  }
})
