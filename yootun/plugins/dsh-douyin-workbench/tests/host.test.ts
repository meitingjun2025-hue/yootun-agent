/**
 * Host 半测试（node --test）：browser.status 唯一实现与路径不透出投影、
 * 未实现 action fail loud、ACTION_TOOL_MAP 与 Workbench 白名单对账
 * （douyin 33−G-1 / viral 22）、本地 action 零远端绑定、服务端稳定码投影、
 * Workbench caller 通道。运行：`node --test tests/host.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKBENCH_GROUP_TOOLS } from '@yootun/dsh-workbench-mcp'
import { ACTION_SCHEMAS, ACTION_TOOL_MAP, ROUTE_PATH } from '../src/route.ts'
import { DOUYIN_CALLER, createWorkbenchCaller } from '../src/workbench.ts'
import { STABLE_ERROR_CODES, safeCode } from '../src/errors.ts'
import { buildRouteHandlers } from '../src/index.ts'
import { createFakeWorkbench, tempRoot, testDeps } from './fakes.ts'

test('路由路径冻结：/api/desktop/yootun/douyin-workbench', () => {
  assert.equal(ROUTE_PATH, '/api/desktop/yootun/douyin-workbench')
})

test('ACTION_TOOL_MAP 对账：douyin 32/33（G-1 cancel 未绑定）+ viral 22/22，无越界', () => {
  const douyinBound = new Set<string>()
  const viralBound = new Set<string>()
  for (const binding of Object.values(ACTION_TOOL_MAP)) {
    if (binding.kind !== 'remote') continue
    for (const tool of binding.tools) {
      if (binding.domain === 'douyin') douyinBound.add(tool)
      else viralBound.add(tool)
    }
  }
  const whitelistDouyin = WORKBENCH_GROUP_TOOLS.douyin as ReadonlySet<string>
  const whitelistViral = WORKBENCH_GROUP_TOOLS.viral as ReadonlySet<string>
  // G-1：cancel 是 D0 缺口，唯一无 action 绑定的 douyin 工具。
  const expectedDouyin = new Set([...whitelistDouyin].filter(name => name !== 'workbench_douyin_collect_run_cancel'))
  assert.deepEqual([...douyinBound].sort(), [...expectedDouyin].sort())
  assert.deepEqual([...viralBound].sort(), [...whitelistViral].sort())
  for (const tool of douyinBound) assert.equal(whitelistDouyin.has(tool), true, `${tool} 不在 douyin 白名单`)
  for (const tool of viralBound) assert.equal(whitelistViral.has(tool), true, `${tool} 不在 viral 白名单`)
})

test('D2–D5 全量 33 个 action 精确实现；browser.status 投影不回传设备路径', async () => {
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
    ])
    const payload = await handlers['browser.status']({})
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
    const payload = await buildRouteHandlers(deps)['browser.status']({})
    assert.equal(payload.status, 'ready')
    assert.equal(payload.chromeAvailable, false)
    assert.equal(payload.hint, 'install_google_chrome')
  } finally {
    await cleanup()
  }
})

test('D6–D8 的 23 个 action 在 handler 表缺席（fail loud 由 route 层 unknown_action 收敛）', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    const d68 = Object.keys(ACTION_SCHEMAS).filter(action => action.startsWith('breakdown.') || action.startsWith('material.') || action.startsWith('gene.'))
    assert.equal(d68.length, 23, 'D6–D8 冻结 23 项（breakdown 10 + material 8 + gene 5）')
    for (const action of d68) {
      assert.equal(handlers[action], undefined, `${action} 属 D6–D8，本阶段不得实现`)
    }
  } finally {
    await cleanup()
  }
})

test('本地 action 零远端绑定；D1 未实现的远端 action 不产生任何调用', async () => {
  const { deps, calls, cleanup } = await testDeps()
  try {
    const handlers = buildRouteHandlers(deps)
    await handlers['browser.status']({})
    assert.equal(calls.length, 0, 'browser.status 不发起远端调用')
    for (const [action, binding] of Object.entries(ACTION_TOOL_MAP)) {
      if (binding.kind === 'local') {
        assert.ok(['browser.status', 'account.loginStatus', 'account.removeLocal', 'collect.status', 'collectAll.status'].includes(action),
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
  void fake
})

test('稳定错误码集合：白名单无重复且含路由/浏览器/兜底码', () => {
  assert.equal(new Set(STABLE_ERROR_CODES).size, STABLE_ERROR_CODES.length)
  for (const code of ['DOUYIN_ROUTE_UNKNOWN_ACTION', 'DOUYIN_ROUTE_INVALID_REQUEST', 'DOUYIN_ROUTE_PAYLOAD_TOO_LARGE', 'GOOGLE_CHROME_MISSING', 'PLAYWRIGHT_DRIVER_MISSING', 'douyin_operation_request_failed', 'SCHEDULE_ROW_CONFLICT', 'IDEMPOTENCY_OUTCOME_UNKNOWN']) {
    assert.ok(STABLE_ERROR_CODES.includes(code as (typeof STABLE_ERROR_CODES)[number]), `${code} 应在稳定码集合`)
  }
})
