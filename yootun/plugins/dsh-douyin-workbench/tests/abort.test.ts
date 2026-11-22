import { join } from 'node:path'
/**
 * AbortSignal 贯穿测试（node --test）：callerOf 透传、ingest 重试等待可中断、
 * abort 后不再下一批、dispose 中断采集链路 Workbench 调用并等待 settle。
 * 运行：`node --test tests/abort.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRouteHandlers, completeLoginAfterSuccess, createDouyinHostDeps } from '../src/index.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import { createIngestClient, ingestCollectedWorks, type IngestWorkbench } from '../src/ingest.ts'

/** 记录 signal 的假 workbench（按脚本应答）。 */
function signalRecordingFace(script: Array<(signal: AbortSignal | undefined, call: FakeWorkbenchCall) => { structuredContent?: unknown; throwCode?: string }>): {
  face: ReturnType<typeof createFakeWorkbench>['face']
  seen: Array<AbortSignal | undefined>
  calls: FakeWorkbenchCall[]
} {
  const calls: FakeWorkbenchCall[] = []
  const seen: Array<AbortSignal | undefined> = []
  let index = 0
  const face = {
    async callTool(caller: string, domain: string, name: string, args: unknown, signal?: AbortSignal) {
      calls.push({ caller, domain, name, args })
      seen.push(signal)
      const step = script[index] ?? (() => ({ structuredContent: {} }))
      index += 1
      const outcome = step(signal, calls[calls.length - 1] as FakeWorkbenchCall)
      if ('throwCode' in outcome && outcome.throwCode !== undefined) {
        const error = new Error(JSON.stringify({ error: { code: outcome.throwCode } })) as Error & { payload?: unknown }
        error.name = 'WorkbenchMcpError'
        error.payload = { error: { code: outcome.throwCode } }
        throw error
      }
      return { structuredContent: outcome.structuredContent ?? {}, content: null }
    },
  }
  return { face, seen, calls }
}

test('AbortSignal 原样传入 Workbench callTool（callerOf 透传）', async () => {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: fake.face })
    const controller = new AbortController()
    await deps.callTool('workbench_douyin_account_list', { accountId: 'a' }, controller.signal)
    // fake face 丢弃 signal？——createFakeWorkbench 不记录 signal，此处用透传面验证：
    // callerOf 是 deps.callTool 的实现，改用记录版 face 断言。
    void controller
  } finally {
    await cleanup()
  }
  const recorder = signalRecordingFace([() => ({ structuredContent: { accounts: [] } })])
  const { root: root2, cleanup: cleanup2 } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root: root2, workbenchFace: recorder.face })
    const controller = new AbortController()
    await deps.callTool('workbench_douyin_account_list', {}, controller.signal)
    assert.equal(recorder.seen[0], controller.signal, 'signal 必须原样到达 face.callTool')
    await deps.callTool('workbench_douyin_account_list', {})
    assert.equal(recorder.seen[1], undefined, '未传 signal 时为 undefined')
  } finally {
    await cleanup2()
  }
})

test('withRetry 退避等待期间 abort 即刻中断，不再发起下一次重试', async () => {
  const controller = new AbortController()
  let metaCalls = 0
  const workbench: IngestWorkbench = {
    async callTool(tool) {
      if (tool === 'workbench_douyin_collect_run_set_list_meta') {
        metaCalls += 1
        // 瞬态错误（非确定性集）→ 进入 500ms 退避。
        const error = new Error(JSON.stringify({ error: { code: 'workbench_network_error' } })) as Error & { payload?: unknown }
        error.name = 'WorkbenchMcpError'
        error.payload = { error: { code: 'workbench_network_error' } }
        throw error
      }
      return { structuredContent: { run: { run_id: 'run-a', last_heartbeat_seq: 0 } }, content: null }
    },
  }
  const client = createIngestClient({ workbench, accountId: 'acc', signal: controller.signal })
  await client.startRun({ newAttempt: true })
  const pending = client.publishListMeta({ expectedWorkCount: 1, listComplete: true })
  await new Promise(resolve => setTimeout(resolve, 60))
  controller.abort()
  const startedAt = Date.now()
  await assert.rejects(() => pending)
  assert.ok(Date.now() - startedAt < 400, 'abort 后应即刻中断（不等满 500ms 退避）')
  assert.equal(metaCalls, 1, 'abort 后不得再发起下一次重试')
})

test('abort 后不再调用下一批 ingest_batch（批间检查）', async () => {
  const controller = new AbortController()
  const batchCalls: number[] = []
  const workbench: IngestWorkbench = {
    async callTool(tool, args) {
      if (tool === 'workbench_douyin_collect_run_start') return { structuredContent: { run: { run_id: 'run-b', last_heartbeat_seq: 0 } }, content: null }
      if (tool === 'workbench_douyin_collect_run_set_list_meta') return { structuredContent: {}, content: null }
      if (tool === 'workbench_douyin_collect_ingest_batch') {
        const batchNo = Number((args as Record<string, unknown>).batchNo)
        batchCalls.push(batchNo)
        if (batchNo === 1) {
          // 第一批成功响应后立即 abort（模拟 dispose/用户取消落在批间）。
          controller.abort()
        }
        return { structuredContent: { batch: { succeeded_work_ids: ['w1'], failed_work_ids: [] }, replayed: false }, content: null }
      }
      return { structuredContent: {}, content: null }
    },
  }
  const client = createIngestClient({ workbench, accountId: 'acc', batchSize: 1, signal: controller.signal })
  await assert.rejects(() => ingestCollectedWorks({
    client,
    works: [
      { work_id: 'w1' }, { work_id: 'w2' },
    ],
    listComplete: true,
    expectedWorkCount: 2,
    publishSince: '2026-05-31T16:00:00Z',
    dashboard: { dashboardRows: [], dashboardFansRows: [] },
  }))
  assert.deepEqual(batchCalls, [1], 'abort 后不得调用第二批')
})

test('dispose 中断采集链路中的 Workbench 调用并等待任务 settle', async () => {
  const controller = new AbortController()
  const workbench: IngestWorkbench = {
    async callTool(tool, _args, signal) {
      if (tool === 'workbench_douyin_collect_run_start') {
        // 挂起直到 signal abort（模拟在途远端调用收到取消）。
        return new Promise((resolve, reject) => {
          if (signal?.aborted === true) {
            reject(new Error('aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          void setTimeout(() => resolve({ structuredContent: { run: { run_id: 'run-late' } }, content: null }), 10_000)
        })
      }
      return { structuredContent: {}, content: null }
    },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face })
    deps.signals.set('collect:acc-d', controller)
    const client = createIngestClient({ workbench, accountId: 'acc-d', signal: controller.signal })
    const task = deps.taskRegistry.track(ingestCollectedWorks({
      client,
      works: [],
      listComplete: true,
      expectedWorkCount: 0,
      publishSince: null,
      dashboard: { dashboardRows: [], dashboardFansRows: [] },
    }))
    const settled = task.then(() => 'settled', () => 'settled')
    await new Promise(resolve => setTimeout(resolve, 50))
    const start = Date.now()
    await disposeHostTasks({ deps })
    assert.ok(Date.now() - start < 3000, 'dispose 应等待任务 settle 而非等满挂起超时')
    assert.equal(await settled, 'settled')
    assert.equal(controller.signal.aborted, true)
  } finally {
    await cleanup()
  }
})

// ---- §2 请求级 AbortSignal：guard 创建/登记/清理，直接 action 透传 ----

test('请求级 signal：直接 action（works.list）经 guard 创建并原样到达 Workbench face', async () => {
  const recorder = signalRecordingFace([() => ({ structuredContent: { works: [], total: 0 } })])
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: recorder.face })
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['works.list']({ accountId: 'acc-s' })
    assert.equal(payload.status, 'ready')
    assert.ok(recorder.seen[0] instanceof AbortSignal, 'guard 创建的请求级 signal 必须到达 face')
    // action settle 后请求级 controller 从 deps.signals 移除。
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0)
  } finally {
    await cleanup()
  }
})

test('挂起的直接 action 被 dispose 取消并 settle；请求级 signal 清理', async () => {
  const recorder = signalRecordingFace([])
  // face：所有调用挂起直到 signal abort。
  const hanging: ReturnType<typeof createFakeWorkbench>['face'] = {
    async callTool(caller, domain, name, args, signal) {
      void recorder
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: hanging })
    const handlers = buildRouteHandlers(deps)
    let settled = false
    const pending = handlers['run.get']({ runId: 'r1' }).then(
      () => { settled = true },
      () => { settled = true },
    )
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(settled, false, 'dispose 前挂起 action 不得 settle')
    await disposeHostTasks({ deps })
    await pending
    assert.equal(settled, true, 'dispose 后在途 action 必须被取消并 settle')
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0, '请求级 signal 随 settle 清理')
  } finally {
    await cleanup()
  }
})

test('collect.start：返回后后台采集照常推进，请求级 signal 清理不影响后台；后台使用 collect: 信号', async () => {
  const { root, cleanup } = await tempRoot()
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { paths } = await import('../src/state.ts')
  try {
    // 就绪条件：本地账号记录 + storage_state 文件（采集探测将因无 Chrome 快速失败，
    // 不启动真实浏览器——resolveSystemChrome 缺 Chrome 时 probe 走 unknown）。
    const { writeAccounts } = await import('../src/state.ts')
    await writeAccounts({ version: 1, accounts: { 'acc-bg': { accountId: 'acc-bg', sessionStatus: 'ok' } } }, root)
    await mkdir(join(root, 'storage-state'), { recursive: true })
    await writeFile(paths(root).storageStatePath('acc-bg'), '{"cookies":[]}')
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face })
    const handlers = buildRouteHandlers(deps)
    const payload = await handlers['collect.start']({ accountId: 'acc-bg' })
    assert.equal(payload.status, 'ready')
    // 后台 collect 信号已登记（区别于请求级 action: 前缀）。
    assert.ok([...deps.signals.keys()].includes('collect:acc-bg'), '后台采集使用 collect controller 信号')
    assert.equal([...deps.signals.keys()].filter(key => key.startsWith('action:')).length, 0, '请求级 signal 已清理')
    // 等后台 run settle（无 Chrome 环境下快速失败终态）。
    await deps.taskRegistry.awaitSettled()
    const status = await handlers['collect.status']({ accountId: 'acc-bg' })
    assert.equal(status.status, 'ready')
    // settle 后后台信号清理。
    assert.equal([...deps.signals.keys()].includes('collect:acc-bg'), false, '后台 run settle 后 collect 信号清理')
  } finally {
    await cleanup()
  }
})

// ---- §3 登录成功后后续链路的 login signal ----

test('登录后续链路：account_save 与 session report 收到 login controller signal', async () => {
  const controller = new AbortController()
  const seenSignals: Array<AbortSignal | undefined> = []
  const tools: string[] = []
  const face: ReturnType<typeof createFakeWorkbench>['face'] = {
    async callTool(_caller, _domain, name, _args, signal) {
      tools.push(name)
      seenSignals.push(signal)
      if (name === 'workbench_douyin_session_status_report') return { structuredContent: { applied: true }, content: null }
      return { structuredContent: { run: { run_id: 'run-l' } }, content: null }
    },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: face })
    const run = { key: 'k', status: 'waiting' as const, accountId: null, error: null, saveError: null, startedAt: new Date().toISOString() }
    deps.loginRuns.set('k', run)
    await completeLoginAfterSuccess(deps, controller.signal, run, {
      status: 'ok', accountId: 'acc-login', profile: { accountId: 'acc-login', nickname: 'n', avatar: null, fanCount: 1 },
    })
    assert.equal(run.status, 'ok')
    assert.equal(tools.includes('workbench_douyin_account_save'), true)
    assert.equal(seenSignals[0], controller.signal, 'account_save 必须收到 login controller signal')
    assert.ok(tools.includes('workbench_douyin_session_status_report'), '正常链路完成会话上报')
    const reportIndex = tools.indexOf('workbench_douyin_session_status_report')
    assert.equal(seenSignals[reportIndex], controller.signal, 'session report 必须收到 login controller signal')
  } finally {
    await cleanup()
  }
})

test('登录后续链路：account_save 完成后、session report 前 abort → 不再发起 report，run 落 failed/login_aborted', async () => {
  const controller = new AbortController()
  const tools: string[] = []
  const face: ReturnType<typeof createFakeWorkbench>['face'] = {
    async callTool(_caller, _domain, name) {
      if (name === 'workbench_douyin_account_save') {
        controller.abort()
        return { structuredContent: {}, content: null }
      }
      tools.push(name)
      return { structuredContent: {}, content: null }
    },
  }
  const { root, cleanup } = await tempRoot()
  try {
    const deps = createDouyinHostDeps({ root, workbenchFace: face })
    const run = { key: 'k2', status: 'waiting' as const, accountId: null, error: null, saveError: null, startedAt: new Date().toISOString() }
    await completeLoginAfterSuccess(deps, controller.signal, run, {
      status: 'ok', accountId: 'acc-abort', profile: null,
    })
    assert.equal(run.status, 'failed')
    assert.equal(run.error, 'login_aborted', '复用既有稳定码 login_aborted')
    assert.equal(tools.includes('workbench_douyin_session_status_report'), false, 'abort 后不得发起 session report')
    // 本地登录态不清理（abort 路径无任何删除）。
    void deps
  } finally {
    await cleanup()
  }
})

test('登录后续链路：dispose 取消挂起的 account_save；storage_state 不被误删；login 信号最终清理', async () => {
  const controller = new AbortController()
  const face: ReturnType<typeof createFakeWorkbench>['face'] = {
    async callTool(_caller, _domain, _name, _args, signal) {
      return new Promise((_resolve, reject) => {
        if (signal?.aborted === true) { reject(new Error('aborted')); return }
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    },
  }
  const { root, cleanup } = await tempRoot()
  const { writeFile, mkdir } = await import('node:fs/promises')
  const { paths } = await import('../src/state.ts')
  try {
    const storage = paths(root).storageStatePath('acc-dispose')
    await mkdir(join(root, 'storage-state'), { recursive: true })
    await writeFile(storage, '{"cookies":[]}')
    const deps = createDouyinHostDeps({ root, workbenchFace: face })
    deps.signals.set('login:acc-dispose', controller)
    const run = { key: 'login:acc-dispose', status: 'waiting' as const, accountId: 'acc-dispose', error: null, saveError: null, startedAt: new Date().toISOString() }
    deps.loginRuns.set('login:acc-dispose', run)
    let settled = false
    deps.taskRegistry.track(completeLoginAfterSuccess(deps, controller.signal, run, { status: 'ok', accountId: 'acc-dispose', profile: null })
      .then(() => { settled = true }, () => { settled = true })
      .then(() => {
        if (deps.signals.get('login:acc-dispose') === controller) deps.signals.delete('login:acc-dispose')
      }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(settled, false)
    await disposeHostTasks({ deps })
    assert.equal(settled, true, 'dispose 取消登录后续在途调用并 settle')
    assert.equal(run.status, 'failed')
    assert.equal(run.error, 'login_aborted')
    // 本地登录态保留。
    const stillThere = await import('node:fs/promises').then(fs => fs.readFile(storage, 'utf8').then(() => true, () => false))
    assert.equal(stillThere, true, 'abort 不得清理 storage_state')
    // login controller 已清理。
    assert.equal(deps.signals.has('login:acc-dispose'), false)
  } finally {
    await cleanup()
  }
})
