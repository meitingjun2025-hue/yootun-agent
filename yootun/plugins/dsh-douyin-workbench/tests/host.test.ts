/**
 * Host 半测试（node --test）：browser.status 唯一实现与路径不透出投影、
 * 未实现 action fail loud、ACTION_TOOL_MAP 与 Workbench 域门对账、本地
 * action 零远端绑定、服务端稳定码投影、Workbench caller 通道。
 * 运行：`node --test tests/host.test.ts`。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'
import { isAllowedFor } from '@yootun/dsh-workbench-mcp'
import { ACTION_SCHEMAS, ACTION_TOOL_MAP, ROUTE_PATH } from '../src/route.ts'
import { DOUYIN_CALLER, createWorkbenchCaller } from '../src/workbench.ts'
import { LOCAL_ERROR_CODES, STABLE_ERROR_CODES, safeCode } from '../src/errors.ts'
import { buildRouteHandlers } from '../src/index.ts'
import { runsFilePath } from '../src/runs.ts'
import { join } from 'node:path'
import { createFakeWorkbench, tempRoot, testDeps } from './fakes.ts'
import { routeAction } from './route-actions.ts'

test('连接器新码原样投影与 host_unreachable 登记（2026-11-26，分册 08 §5.2）', () => {
  const workbenchError = (code: string): Error => Object.assign(new Error(`x-${code}`), { name: 'WorkbenchMcpError', code })
  // 抖音按登记表原样投影全部连接器稳定码（不收敛兜底）。
  assert.equal(safeCode(workbenchError('workbench_unauthorized')), 'workbench_unauthorized')
  assert.equal(safeCode(workbenchError('workbench_server_error')), 'workbench_server_error')
  // host_unreachable 为本地新码，白名单直通。
  assert.equal(safeCode(workbenchError('host_unreachable')), 'host_unreachable')
  for (const code of ['workbench_unauthorized', 'workbench_server_error', 'host_unreachable']) {
    assert.equal((STABLE_ERROR_CODES as readonly string[]).includes(code), true, code)
    assert.equal((LOCAL_ERROR_CODES as readonly string[]).includes(code), code === 'host_unreachable' || code.startsWith('workbench_'), code)
  }
})

test('稳定码集合无重复元素（LOCAL_ERROR_CODES 展开面与去重后的全集）', () => {
  assert.equal(new Set(LOCAL_ERROR_CODES).size, LOCAL_ERROR_CODES.length)
  assert.equal(new Set(STABLE_ERROR_CODES).size, STABLE_ERROR_CODES.length)
})

test('路由路径冻结：/api/desktop/yootun/douyin-workbench', () => {
  assert.equal(ROUTE_PATH, '/api/desktop/yootun/douyin-workbench')
})

test('ACTION_TOOL_MAP 对账：Host 侧远端绑定工具名全部通过 douyin-workbench 域门', () => {
  const boundTools = new Set<string>()
  for (const binding of Object.values(ACTION_TOOL_MAP)) {
    if (binding.kind !== 'remote') continue
    for (const tool of binding.tools) {
      boundTools.add(tool)
      assert.equal(isAllowedFor('douyin-workbench', tool), true, `${tool} 不在 douyin-workbench 域门内`)
    }
  }
  assert.ok(boundTools.size > 0, '存在远端绑定')
})

test('全量 57 个 action 精确实现；browser.status 投影不回传设备路径', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    assert.deepEqual(Object.keys(handlers), [
      'browser.status',
      'accounts.list',
      'account.beginLogin',
      'account.loginStatus',
      'account.probe',
      'account.removeLocal',
      'account.removeRemote',
      'collect.start',
      'collect.status',
      'collect.running',
      'collectAll.start',
      'collectAll.status',
      'works.list',
      'work.get',
      'work.trend',
      'run.get',
      'export',
      'overview.get',
      'hotWorks.list',
      'overview.export',
      'account.analysis',
      'account.trend',
      'accountAnalysis.export',
      'schedule.list',
      'schedule.rowCreate',
      'schedule.rowUpdate',
      'schedule.rowDelete',
      'aiAnalysis.start',
      'aiAnalysis.get',
      'report.list',
      'report.get',
      'report.regenerate',
      'account.owner.set',
      'work.promotion.save',
      'breakdown.rewriteRules',
      'breakdown.archiveStart',
      'breakdown.archiveStatus',
      'breakdown.downloadStart',
      'breakdown.downloadStatus',
      'breakdown.workflowStart',
      'breakdown.workflowStatus',
      'breakdown.detail',
      'breakdown.export',
      'breakdown.history',
      'material.seeds.list',
      'material.keyword.upsert',
      'material.account.upsert',
      'material.collect.start',
      'material.collect.status',
      'material.videos.list',
      'material.runs.list',
      'material.facets',
      'gene.search',
      'gene.get',
      'gene.update',
      'gene.regenerate',
      'gene.list',
    ])
    const payload = await routeAction(handlers, 'browser.status')({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.chromeAvailable, true)
    assert.equal(payload.driverAvailable, true)
    assert.equal(payload.platform, 'linux')
    assert.equal(payload.hint, null)
    assert.ok(!('chromePath' in payload), 'chromePath 不得进入响应')
  } finally {
    await cleanup()
  }
})

test('browser.status 无 Chrome 时给稳定安装提示且不抛错', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const { createDouyinHostDeps } = await import('../src/index.ts')
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: createFakeWorkbench().face,
      browserStatusFn: async () => ({ chromeAvailable: false, driverAvailable: false, platform: 'win32', hint: 'install_google_chrome' }),
    })
    const payload = await routeAction(buildRouteHandlers(deps), 'browser.status')({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.chromeAvailable, false)
    assert.equal(payload.hint, 'install_google_chrome')
  } finally {
    await cleanup()
  }
})

test('D8 基因库 5 个 action 全部实现，全量 57 项与 ACTION_SCHEMAS 键集对齐', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    for (const action of ['gene.search', 'gene.get', 'gene.update', 'gene.regenerate', 'gene.list']) {
      assert.equal(typeof handlers[action], 'function', `${action} 属 D8，本批次必须实现`)
    }
    assert.deepEqual(Object.keys(handlers).sort(), Object.keys(ACTION_SCHEMAS).sort())
  } finally {
    await cleanup()
  }
})

test('H2 collect.running：无运行中采集时 collect 为 null、batchRunning 为 false', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    const payload = await routeAction(handlers, 'collect.running')({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.collect, null)
    assert.equal(payload.batchRunning, false)
  } finally {
    await cleanup()
  }
})

test('H5 collect.running：只读本地投影——零 Workbench 调用、不读写 runs.json', async () => {
  const { deps, calls, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    const payload = await routeAction(handlers, 'collect.running')({})
    assert.equal(payload.status, 'ready')
    assert.equal(calls.length, 0, '本地 action 不发起任何 Workbench 调用')
    assert.equal(existsSync(runsFilePath(deps.root)), false, '不得创建或改写 runs.json')
    assert.equal(deps.signals.size, 0)
  } finally {
    await cleanup()
  }
})

test('本地 action 零远端绑定；D1 未实现的远端 action 不产生任何调用', async () => {
  const { deps, calls, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    await routeAction(handlers, 'browser.status')({})
    assert.equal(calls.length, 0, 'browser.status 不发起远端调用')
    for (const [action, binding] of Object.entries(ACTION_TOOL_MAP)) {
      if (binding.kind === 'local') {
        assert.ok(['browser.status', 'account.loginStatus', 'account.removeLocal', 'collect.status', 'collect.running', 'collectAll.status'].includes(action),
          `未预期的本地 action: ${action}`)
      }
    }
    assert.equal(deps.signals.size, 0)
  } finally {
    await cleanup()
  }
})

test('Workbench caller：固定 caller、按工具前缀走 douyin/viral 分组', async () => {
  const fake = createFakeWorkbench({ outcomes: [{ structuredContent: { ok: true } }] })
  const caller = createWorkbenchCaller(fake.face)
  const outcome = await caller('workbench_douyin_publish_schedule_list', { accountId: 'a' })
  assert.deepEqual(outcome.structuredContent, { ok: true })
  assert.deepEqual(fake.calls, [{ caller: 'douyin-workbench', domain: 'douyin', name: 'workbench_douyin_publish_schedule_list', args: { accountId: 'a' } }])
  assert.equal(DOUYIN_CALLER, 'douyin-workbench')
  const viral = createFakeWorkbench({ outcomes: [{ structuredContent: {} }] })
  await createWorkbenchCaller(viral.face)('workbench_viral_knowledge_search', { query: 'x' })
  assert.equal(viral.calls[0]?.domain, 'viral')
  assert.equal(viral.calls[0]?.name, 'workbench_viral_knowledge_search')
})

test('两分组之外的工具名拒绝（不伪造可用）', async () => {
  const fake = createFakeWorkbench()
  const caller = createWorkbenchCaller(fake.face)
  await assert.rejects(() => caller('workbench_xhs_task_create', {}), /outside the douyin\/viral groups/)
  await assert.rejects(() => caller('not-a-tool', {}), /outside the douyin\/viral groups/)
  assert.equal(fake.calls.length, 0)
})

test('服务端稳定码投影：Workbench envelope code 进白名单即透出，未知码收敛兜底', () => {
  const fake = createFakeWorkbench()
  const serverError = (): unknown => {
    const failure = new Error('wrapped') as Error & { payload?: unknown }
    failure.name = 'WorkbenchMcpError'
    failure.payload = { error: { code: 'SCHEDULE_ROW_CONFLICT' } }
    return failure
  }
  assert.equal(safeCode(serverError()), 'SCHEDULE_ROW_CONFLICT')
  const unknownPayload = new Error('x') as Error & { payload?: unknown }
  unknownPayload.payload = { error: { code: 'TOTALLY_UNKNOWN_CODE' } }
  assert.equal(safeCode(unknownPayload), 'douyin_operation_request_failed')
  const plain = new Error('raw transport text')
  assert.equal(safeCode(plain), 'douyin_operation_request_failed')
  // 连接器稳定码登记（LOCAL_ERROR_CODES 的 workbench_* 段即登记表键）：逐个原样投影。
  for (const code of LOCAL_ERROR_CODES.filter(value => value.startsWith('workbench_'))) {
    const transport = Object.assign(new Error('x'), { name: 'WorkbenchMcpError', code })
    assert.equal(safeCode(transport), code, `${code} 原样投影`)
  }
  void fake
})

test('稳定错误码集合：白名单无重复且含路由/浏览器/兜底码', () => {
  assert.equal(new Set(STABLE_ERROR_CODES).size, STABLE_ERROR_CODES.length)
  for (const code of ['DOUYIN_ROUTE_UNKNOWN_ACTION', 'DOUYIN_ROUTE_INVALID_REQUEST', 'DOUYIN_ROUTE_PAYLOAD_TOO_LARGE', 'GOOGLE_CHROME_MISSING', 'PLAYWRIGHT_DRIVER_MISSING', 'douyin_operation_request_failed', 'SCHEDULE_ROW_CONFLICT', 'IDEMPOTENCY_OUTCOME_UNKNOWN']) {
    assert.ok(STABLE_ERROR_CODES.includes(code as (typeof STABLE_ERROR_CODES)[number]), `${code} 应在稳定码集合`)
  }
})

test('I2 collect.status / collectAll.status 附带启动中断摘要；单账号采集成功启动后清空', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { paths, writeAccounts } = await import('../src/state.ts')
  const { root, cleanup } = await tempRoot()
  try {
    // 就绪条件：本地账号记录 + storage_state 文件（采集探测无 Chrome 快速失败，
    // 不影响「成功启动」判定——handler 返回 started 即清空摘要）。
    await writeAccounts({ version: 1, accounts: { 'acc-i2': { accountId: 'acc-i2', sessionStatus: 'ok' } } }, root)
    await mkdir(join(root, 'storage-state'), { recursive: true })
    await writeFile(paths(root).storageStatePath('acc-i2'), '{"cookies":[]}')
    const { createDouyinHostDeps } = await import('../src/index.ts')
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: (await import('./fakes.ts')).createFakeWorkbench().face,
      browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux', hint: null }),
      logger: { warn: () => undefined },
      recovery: async () => ({ count: 2, accountIds: ['a1', 'a2'] }),
    })
    await deps.startupReady
    assert.notEqual(deps.startupInterruption, null, '注入恢复：摘要进 deps')
    const handlers = buildRouteHandlers(deps)
    const status = await routeAction(handlers, 'collect.status')({ accountId: 'acc-i2' })
    assert.deepEqual((status as Record<string, unknown>).interrupted, { count: 2, accountIds: ['a1', 'a2'] }, 'I2：collect.status 附带摘要')
    const batchStatus = await routeAction(handlers, 'collectAll.status')({})
    assert.deepEqual((batchStatus as Record<string, unknown>).interrupted, { count: 2, accountIds: ['a1', 'a2'] }, 'I2：collectAll.status 附带摘要')
    // 单账号采集成功启动 → 摘要清空，两个 status 不再附带。
    const started = await routeAction(handlers, 'collect.start')({ accountId: 'acc-i2' })
    assert.equal((started as Record<string, unknown>).status, 'ready')
    assert.equal(deps.startupInterruption, null, '成功启动后摘要清空')
    const statusAfter = await routeAction(handlers, 'collect.status')({ accountId: 'acc-i2' })
    assert.equal((statusAfter as Record<string, unknown>).interrupted, undefined)
    await deps.taskRegistry.awaitSettled()
  } finally {
    await cleanup()
  }
})

// --- 批量前置探测接线守卫（生产装配在 createBatchProbe；缺 probe 字段 = 探测复用静默失效） ---

test('批量前置探测回调携带 probe 暂存投影，上报结果写进 probe.reported', async () => {
  const { createBatchProbe } = await import('../src/index.ts')
  const { deps, cleanup } = await testDeps()
  try {
    const runnerDeps = {
      callTool: deps.callTool,
      root: deps.root,
      locks: deps.locks,
      chromeFactory: deps.chromeFactory,
      maxPages: deps.maxPages,
      logger: { warn: (message: string) => { deps.logger.warn(message) } },
      browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
      launchTimeoutMs: deps.launchTimeoutMs,
    }
    const session = { sessionStatus: 'ok', reason: null, sessionSeq: 3, checkedAt: '2026-11-27T00:00:00Z', vaultRef: 'vault-ref', accountId: 'acc-1', profile: null } as const
    const reported: string[] = []
    const probe = createBatchProbe(deps, runnerDeps, {
      refresh: async () => session,
      report: async (_runnerDeps, accountId) => { reported.push(accountId); return { ok: true, error: null } },
      now: () => 1_700_000_000_000,
    })
    const result = await probe('acc-1')
    assert.equal(result.sessionStatus, 'ok')
    assert.deepEqual(result.probe, { state: session, reported: true, probedAt: 1_700_000_000_000 })
    assert.deepEqual(reported, ['acc-1'], '探测后立即上报')
  } finally {
    await cleanup()
  }
})

test('createBatchProbe 默认接缝：上报失败写进 probe.reported（复用时不跳过采集内上报）', async () => {
  const { createBatchProbe } = await import('../src/index.ts')
  const { deps, cleanup } = await testDeps()
  try {
    const runnerDeps = {
      callTool: deps.callTool,
      root: deps.root,
      locks: deps.locks,
      chromeFactory: deps.chromeFactory,
      maxPages: deps.maxPages,
      logger: { warn: (message: string) => { deps.logger.warn(message) } },
      browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
      launchTimeoutMs: deps.launchTimeoutMs,
    }
    const probe = createBatchProbe(deps, runnerDeps, {
      refresh: async () => ({ sessionStatus: 'unknown', reason: 'probe_failed', sessionSeq: 0, checkedAt: '2026-11-27T00:00:00Z', vaultRef: '', accountId: 'acc-9', profile: null }),
      report: async () => ({ ok: false, error: 'host_unreachable' }),
      now: () => 1,
    })
    const result = await probe('acc-9')
    assert.equal(result.sessionStatus, 'unknown')
    assert.equal(result.probe?.reported, false, '上报失败写进 probe.reported')
    assert.equal(result.reason, 'probe_failed')
  } finally {
    await cleanup()
  }
})
