/**
 * Workbench 私有 MCP 连接器测试（node --test，真实 Cordis 组合 + 假 server）：
 * 90 项白名单精确匹配、调用方分组隔离、viral/tos 专属约束、Catalog 拒绝、
 * 超时/取消/网络/协议/业务错误分开投影、credential 缓存失效、卸载无泄漏。
 * 运行：`pnpm --filter @yootun/dsh-workbench-mcp test`。
 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { Context } from '@deepseek-ai/cordis'
import { VALIDATION_VERSION } from '@yootun/dsh-client-ui-access/src/access-constants.ts'
import WorkbenchMcp, { WorkbenchMcpError, WORKBENCH_GROUP_TOOLS, WORKBENCH_TOOL_WHITELIST, CATALOG_TOOL_NAMES, CALLER_DOMAINS, type WorkbenchCaller, type WorkbenchDomain } from '../src/index.ts'
import { ACCESS_CREDENTIAL_REF } from '../src/constants.ts'
import { startWorkbenchFixture, type WorkbenchFixture } from './fixture-workbench-server.ts'

const ACTIVATED_SNAPSHOT = { setupComplete: true, validationVersion: Number(VALIDATION_VERSION) }
/** 所有测试共享的环境恢复点。 */
const cleanups: Array<() => Promise<void>> = []
after(async () => {
  delete process.env.YOOTUN_WORKBENCH_MCP_URL
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined)
})

interface Booted {
  service: InstanceType<typeof WorkbenchMcp>
  fixture: WorkbenchFixture
  ctx: Context
  setAccess(value: Record<string, unknown>): void
  setKey(value: string | undefined): void
  emitCredentialUpdate(): void
}

async function boot(options: { access?: Record<string, unknown>; keyValue?: string | undefined; fixture?: WorkbenchFixture } = {}): Promise<Booted> {
  const fixture = options.fixture ?? await startWorkbenchFixture()
  process.env.YOOTUN_WORKBENCH_MCP_URL = fixture.url
  const ctx = new Context()
  let accessValue: Record<string, unknown> = options.access ?? ACTIVATED_SNAPSHOT
  let keyValue: string | undefined = options.keyValue ?? 'test-model-key'
  ctx.reflect.provide('settings', {
    describe: () => [{ ns: 'yootun-access', value: accessValue }],
  })
  ctx.reflect.provide('credentials', {
    resolve: async () => keyValue === undefined ? undefined : { source: 'test' as const, value: keyValue },
  })
  const service = await ctx.plugin(WorkbenchMcp, { callTimeoutMs: 900 })
  void service
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
  })
  return {
    service: ctx.yootunWorkbench,
    fixture,
    ctx,
    setAccess(value) { accessValue = value },
    setKey(value) { keyValue = value },
    emitCredentialUpdate() { ctx.emit('credentials/reference-updated', credentialRef(ACCESS_CREDENTIAL_REF)) },
  }
}

/** Assert one call throws the expected stable code. */
async function assertRejects(run: () => Promise<unknown>, code: string, what: string): Promise<WorkbenchMcpError> {
  try {
    await run()
    throw new Error(`expected rejection with ${code}: ${what}`)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('expected rejection')) throw error
    assert.ok(error instanceof WorkbenchMcpError, `${what}: expected WorkbenchMcpError, got ${String(error)}`)
    assert.equal(error.code, code, what)
    return error
  }
}

test('白名单结构：90 项精确、分组 19/19/29/22/1、无 Catalog 交集', () => {
  const counts = Object.entries(WORKBENCH_GROUP_TOOLS).map(([domain, tools]) => `${domain}:${String(tools.size)}`)
  assert.deepEqual(counts, ['wx:19', 'xhs:19', 'douyin:29', 'viral:22', 'tos:1'])
  assert.equal(WORKBENCH_TOOL_WHITELIST.size, 90)
  for (const catalogTool of CATALOG_TOOL_NAMES) {
    assert.equal(WORKBENCH_TOOL_WHITELIST.has(catalogTool), false, `${catalogTool} 不得进入 Workbench 白名单`)
  }
  assert.deepEqual(Object.keys(CALLER_DOMAINS), ['wx-workbench', 'xhs-workbench', 'douyin-workbench', 'media-upload'])
})

test('未激活时拒绝调用且零连接', async () => {
  const booted = await boot({ access: { setupComplete: false, validationVersion: Number(VALIDATION_VERSION) } })
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_account_list', {}),
    'workbench_not_activated',
    '未激活不得调用',
  )
  assert.equal(booted.fixture.authorization.length, 0)
})

test('激活后分组内调用成功并到达假 server', async () => {
  const booted = await boot()
  const outcome = await booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_account_list', {})
  assert.deepEqual(outcome.structuredContent, { ok: true, tool: 'workbench_wx_account_list' })
  assert.equal(booted.fixture.authorization.length > 0, true)
  assert.deepEqual(booted.fixture.toolCalls, ['workbench_wx_account_list'])
})

test('三个工作台互不可访问对方分组', async () => {
  const booted = await boot()
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'douyin', 'workbench_douyin_account_list', {}),
    'workbench_tool_denied',
    'wx 不可调 douyin',
  )
  await assertRejects(
    () => booted.service.callTool('xhs-workbench', 'wx', 'workbench_wx_account_list', {}),
    'workbench_tool_denied',
    'xhs 不可调 wx',
  )
  await assertRejects(
    () => booted.service.callTool('douyin-workbench', 'xhs', 'workbench_xhs_task_create', {}),
    'workbench_tool_denied',
    'douyin 不可调 xhs',
  )
  // 白名单外伪造名也拒绝（douyin caller + 假名）。
  await assertRejects(
    () => booted.service.callTool('douyin-workbench', 'douyin', 'workbench_douyin_unknown_extra', {}),
    'workbench_tool_denied',
    '白名单外拒绝',
  )
})

test('viral 分组只允许 douyin 调用方', async () => {
  const booted = await boot()
  const outcome = await booted.service.callTool('douyin-workbench', 'viral', 'workbench_viral_rewrite_rules_list', {})
  assert.deepEqual(outcome.structuredContent, { ok: true, tool: 'workbench_viral_rewrite_rules_list' })
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'viral', 'workbench_viral_rewrite_rules_list', {}),
    'workbench_tool_denied',
    'wx 不可调 viral',
  )
  await assertRejects(
    () => booted.service.callTool('xhs-workbench', 'viral', 'workbench_viral_rewrite_rules_list', {}),
    'workbench_tool_denied',
    'xhs 不可调 viral',
  )
})

test('tos authorize 只允许 media-upload', async () => {
  const booted = await boot()
  const outcome = await booted.service.callTool('media-upload', 'tos', 'workbench_tos_upload_authorize', { filename: 'a.png', contentType: 'image/png', size: 3 })
  assert.deepEqual(outcome.structuredContent, { ok: true, tool: 'workbench_tos_upload_authorize' })
  await assertRejects(
    () => booted.service.callTool('xhs-workbench', 'tos', 'workbench_tos_upload_authorize', {}),
    'workbench_tool_denied',
    'xhs 工作台不可直接调 authorize',
  )
  await assertRejects(
    () => booted.service.callTool('douyin-workbench', 'tos', 'workbench_tos_upload_authorize', {}),
    'workbench_tool_denied',
    'douyin 工作台不可调 authorize',
  )
})

test('Catalog 5 个 yootun_business_* 全部拒绝', async () => {
  const booted = await boot()
  const callers: Array<[WorkbenchCaller, WorkbenchDomain]> = [
    ['wx-workbench', 'wx'], ['xhs-workbench', 'xhs'], ['douyin-workbench', 'douyin'], ['media-upload', 'tos'],
  ]
  for (const [caller, domain] of callers) {
    for (const catalogTool of CATALOG_TOOL_NAMES) {
      await assertRejects(
        () => booted.service.callTool(caller, domain, catalogTool, {}),
        'workbench_tool_denied',
        `${caller} 不可调 ${catalogTool}`,
      )
    }
  }
  assert.equal(booted.fixture.toolCalls.length, 0, 'Catalog 拒绝不发起任何调用')
})

test('业务错误按稳定 envelope 原样投影', async () => {
  const booted = await boot()
  const error = await assertRejects(
    () => booted.service.callTool('xhs-workbench', 'xhs', 'workbench_xhs_task_cancel', { taskId: 't1' }),
    'workbench_call_failed',
    '业务错误投影',
  )
  assert.deepEqual(error.payload, { code: 'TASK_ALREADY_CANCELLED', ok: false })
})

test('空 key 门禁拒绝与不可达端口网络投影', async () => {
  // 空串 key：门禁按空值处理 → not_activated，且零连接。
  const booted = await boot({ keyValue: '' })
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {}),
    'workbench_not_activated',
    '空 key 门禁拒绝',
  )
  assert.equal(booted.fixture.authorization.length, 0)
  // 网络错误：有 key、端口已关。
  const closed = await startWorkbenchFixture()
  await closed.close()
  const booted2 = await boot({ fixture: closed })
  await assertRejects(
    () => booted2.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {}),
    'workbench_network_error',
    '连接不可达',
  )
})

test('慢调用超时与悬挂调用取消', async () => {
  const booted = await boot()
  // callTimeoutMs=900，慢工具 1500ms → 超时投影。
  await assertRejects(
    () => booted.service.callTool('douyin-workbench', 'douyin', 'workbench_douyin_export', {}),
    'workbench_call_timeout',
    '显式超时',
  )
  // 悬挂工具 + 调用方取消 → 取消投影。
  const controller = new AbortController()
  const pending = booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_collect_run_start', {}, controller.signal)
  setTimeout(() => { controller.abort() }, 150)
  await assertRejects(() => pending, 'workbench_call_cancelled', '调用方取消')
})

test('serverName 不匹配与清单漂移按协议错误投影', async () => {
  const wrongName = await startWorkbenchFixture({ serverName: 'imposter' })
  const booted = await boot({ fixture: wrongName })
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_account_list', {}),
    'workbench_protocol_error',
    'serverName 校验',
  )
  const drifted = await startWorkbenchFixture({ toolCountMode: 'extra' })
  const booted2 = await boot({ fixture: drifted })
  await assertRejects(
    () => booted2.service.callTool('wx-workbench', 'wx', 'workbench_wx_account_list', {}),
    'workbench_protocol_error',
    'tools/list 必须精确 90',
  )
  assert.equal(booted2.fixture.toolCalls.length, 0, '契约不匹配时不发起业务调用')
})

test('credential 更新使连接缓存失效并重连', async () => {
  const booted = await boot()
  await booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
  const requestsBefore = booted.fixture.authorization.length
  booted.setKey('rotated-model-key')
  booted.emitCredentialUpdate()
  // 新连接后再次成功调用，且携带轮换后的 key。
  await booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
  assert.equal(booted.fixture.authorization.length > requestsBefore, true)
  assert.ok(booted.fixture.authorization.includes('rotated-model-key'), '重连请求携带轮换后的 key')
  assert.ok(booted.fixture.authorization.every(value => value === 'test-model-key' || value === 'rotated-model-key'), '无未知凭证值')
  // key 移除后门禁拒绝。
  booted.setKey(undefined)
  booted.emitCredentialUpdate()
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {}),
    'workbench_not_activated',
    'key 移除后拒绝',
  )
})

test('并发窗口：连接建立期间凭证轮换，旧连接不进缓存', async () => {
  // resolve 捕获旧值、300ms 后返回：轮换事件落在 open 在途，旧 key 连接必须被弃用。
  const fixture = await startWorkbenchFixture()
  process.env.YOOTUN_WORKBENCH_MCP_URL = fixture.url
  const ctx = new Context()
  let keyValue = 'old-model-key'
  let resolveCount = 0
  ctx.reflect.provide('settings', { describe: () => [{ ns: 'yootun-access', value: ACTIVATED_SNAPSHOT }] })
  ctx.reflect.provide('credentials', {
    resolve: async () => {
      resolveCount += 1
      const captured = keyValue
      // 第一次 resolve 是门禁（快速）；第二次是 open（慢速），在途期注入轮换。
      if (resolveCount >= 2) await new Promise(resolve => setTimeout(resolve, 300))
      return captured === '' ? undefined : { source: 'test' as const, value: captured }
    },
  })
  await ctx.plugin(WorkbenchMcp, { callTimeoutMs: 900 })
  const cleanups: Array<() => Promise<void>> = []
  cleanups.push(async () => {
    await ctx.fiber.dispose()
    await fixture.close()
  })
  try {
    const stale = (ctx.yootunWorkbench as InstanceType<typeof WorkbenchMcp>).callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
    const emitted = setTimeout(() => { keyValue = 'rotated-model-key'; ctx.emit('credentials/reference-updated', credentialRef(ACCESS_CREDENTIAL_REF)) }, 60)
    await assertRejects(() => stale, 'workbench_unavailable', '在途 open 被世代自检作废')
    clearTimeout(emitted)
    // 新世代连接：全部请求只携带 rotated key。
    const outcome = await (ctx.yootunWorkbench as InstanceType<typeof WorkbenchMcp>).callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
    assert.deepEqual(outcome.structuredContent, { ok: true, tool: 'workbench_wx_work_list' })
    // 旧 key 至多出现在被弃用连接的握手阶段（open 早期已解析），且被弃用连接
    // 不产生任何业务调用；轮换后的请求全部携带 rotated key。
    assert.deepEqual(fixture.toolCalls, ['workbench_wx_work_list'])
    const firstRotated = fixture.authorization.indexOf('rotated-model-key')
    assert.ok(firstRotated > -1, '存在 rotated 请求')
    assert.ok(fixture.authorization.slice(firstRotated).every(value => value === 'rotated-model-key'), '首个 rotated 请求之后无旧 key')
    // 旧 key 只出现在被弃用连接的握手期（首个 rotated 请求之前）。
    assert.ok(fixture.authorization.slice(0, firstRotated).every(value => value === 'old-model-key'), '弃用握手期不含 rotated')
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined)
  }
})

test('并发窗口：卸载落在连接建立期间，产物自关且无调用', async () => {
  const fixture = await startWorkbenchFixture()
  process.env.YOOTUN_WORKBENCH_MCP_URL = fixture.url
  const ctx = new Context()
  let resolveCount = 0
  ctx.reflect.provide('settings', { describe: () => [{ ns: 'yootun-access', value: ACTIVATED_SNAPSHOT }] })
  ctx.reflect.provide('credentials', {
    resolve: async () => {
      resolveCount += 1
      if (resolveCount >= 2) await new Promise(resolve => setTimeout(resolve, 300))
      return { source: 'test' as const, value: 'test-model-key' }
    },
  })
  await ctx.plugin(WorkbenchMcp, { callTimeoutMs: 900 })
  const cleanups: Array<() => Promise<void>> = []
  cleanups.push(async () => {
    await fixture.close()
  })
  try {
    const pending = (ctx.yootunWorkbench as InstanceType<typeof WorkbenchMcp>).callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
    const disposeWait = setTimeout(async () => { await ctx.fiber.dispose() }, 60)
    await assertRejects(() => pending, 'workbench_unavailable', '卸载使在途 open 作废')
    clearTimeout(disposeWait)
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(fixture.toolCalls.length, 0, '卸载竞态不产生业务调用')
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined)
  }
})

test('卸载中止 in-flight 且无后续连接', async () => {
  const booted = await boot()
  await booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {})
  const requestsBefore = booted.fixture.authorization.length
  const pending = booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_collect_run_start', {})
  // 等 tools/call 真正在途（服务端已收到）再卸载，避免启动竞态。
  const deadline = Date.now() + 5_000
  while (!booted.fixture.toolCalls.includes('workbench_wx_collect_run_start')) {
    if (Date.now() > deadline) throw new Error('hang tool call never reached the fixture')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await booted.ctx.fiber.dispose()
  await assertRejects(() => pending, 'workbench_call_cancelled', '卸载中止悬挂调用')
  // transport 关闭会补发 DELETE 会话等收尾请求；等收尾完成后再断言稳定。
  await new Promise(resolve => setTimeout(resolve, 200))
  const afterTeardown = booted.fixture.authorization.length
  const callsBefore = booted.fixture.toolCalls.length
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(booted.fixture.authorization.length, afterTeardown, '卸载收尾后无新连接')
  assert.equal(booted.fixture.toolCalls.length, callsBefore, '卸载后无新业务调用')
  await assertRejects(
    () => booted.service.callTool('wx-workbench', 'wx', 'workbench_wx_work_list', {}),
    'workbench_unavailable',
    '卸载后拒绝新调用',
  )
  void requestsBefore
})
