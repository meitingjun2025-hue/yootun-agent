/**
 * Agent 面 managed MCP 生命周期与 guard 测试（node --test，真实 Cordis 组合 +
 * 假 MCP server）：未激活零连接、激活后仅 Agent 面注册、key 更新/移除、
 * guard 读/写/未分类 ask、Workbench/Catalog 拒绝、卸载清理、状态路由随
 * webServer 的可用性注册。
 * 运行：`pnpm --filter @yootun/dsh-managed-mcp test`。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString, type ToolCallId } from '@deepseek-ai/dsh-brand'
import { McpClientHost } from '@deepseek-ai/dsh-mcp-client'
import { VALIDATION_VERSION } from '@yootun/dsh-client-ui-access/src/access-constants.ts'
import * as ManagedMcp from '../src/index.ts'
import { createAgentStatusRouteHandler, permitted } from '../src/status-route.ts'
import { classifyAgentTool, AGENT_TOOL_NAMES } from '../src/guard.ts'
import { ACCESS_CREDENTIAL_REF, STATUS_PATH } from '../src/constants.ts'
import { startAgentFixture, type AgentFixture } from './fixture-agent-server.ts'

const ACTIVATED_SNAPSHOT = { setupComplete: true, validationVersion: Number(VALIDATION_VERSION) }

/** 已激活组合的默认测试环境变量快照。 */
interface BootOptions {
  /** `yootun-access` namespace 的 settings 值；缺省为已激活快照。 */
  access?: Record<string, unknown> | undefined
  /** MODELS_API_KEY 解析值；undefined 表示无凭证。 */
  keyValue?: string | undefined
  /** 是否提供 settings / credentials 服务（模拟未装服务的宿主）。 */
  omitServices?: boolean | undefined
  /** 外部 fixture（含已关闭的不可达端口）；提供时不改写环境变量。 */
  fixture?: AgentFixture | undefined
  /** 是否先在根作用域注册一个外部 `mcpClientHost`（模拟桌面 profile 的官方 mcp-manager）。 */
  foreignHost?: boolean | undefined
  /** 插件加载前已在根作用域就绪的 webServer；缺省不提供。 */
  webServer?: FakeWebServer | undefined
}

interface Booted {
  ctx: Context
  fixture: AgentFixture
  pluginFiber: Awaited<ReturnType<Context['plugin']>>
  registeredNames(): string[]
  setAccess(value: Record<string, unknown>): void
  setKey(value: string | undefined): void
  emitCredentialUpdate(): void
  emitSettingsUpdate(): void
  restoreEnv(): void
}

/** Poll a predicate until it holds or the budget runs out. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`condition not reached: ${what}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/**
 * Boot a real composition: fake settings/credentials services, official
 * SystemPrompt + ToolRuntime + NativeToolExecutor, and the managed-mcp
 * plugin pointing at the fixture via YOOTUN_AGENT_MCP_URL.
 */
async function boot(options: BootOptions = {}): Promise<Booted> {
  const fixture = options.fixture ?? await startAgentFixture()
  const previousUrl = process.env.YOOTUN_AGENT_MCP_URL
  if (options.fixture === undefined) process.env.YOOTUN_AGENT_MCP_URL = fixture.url
  const ctx = new Context()
  let accessValue: Record<string, unknown> = options.access ?? ACTIVATED_SNAPSHOT
  let keyValue: string | undefined = options.keyValue ?? 'test-model-key'
  if (options.omitServices !== true) {
    ctx.reflect.provide('settings', {
      describe: () => [{ ns: ManagedMcp.ACCESS_NAMESPACE, value: accessValue }],
    })
    ctx.reflect.provide('credentials', {
      resolve: async () => keyValue === undefined ? undefined : { source: 'test' as const, value: keyValue },
    })
  }
  if (options.webServer !== undefined) ctx.reflect.provide('webServer', options.webServer)
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    if (options.foreignHost === true) new McpClientHost(ctx)
    const pluginFiber = await ctx.plugin(ManagedMcp)
    const registeredNames = (): string[] =>
      (ctx.tools.schemas() as Array<{ name: string }>).map(schema => schema.name)
    return {
      ctx,
      fixture,
      pluginFiber,
      registeredNames,
      setAccess(value) { accessValue = value },
      setKey(value) { keyValue = value },
      emitCredentialUpdate() { ctx.emit('credentials/reference-updated', credentialRef(ACCESS_CREDENTIAL_REF) as CredentialRef) },
      emitSettingsUpdate() { ctx.emit('settings/document-updated', ManagedMcp.ACCESS_NAMESPACE, 1) },
      restoreEnv() { process.env.YOOTUN_AGENT_MCP_URL = previousUrl },
    }
  } catch (error: unknown) {
    process.env.YOOTUN_AGENT_MCP_URL = previousUrl
    await fixture.close()
    await ctx.fiber.dispose()
    throw error
  }
}

async function shutdown(booted: Booted): Promise<void> {
  booted.restoreEnv()
  await booted.ctx.fiber.dispose()
  await booted.fixture.close().catch(() => undefined)
}

/** 自愈 / 快照用例的组合环境：真实服务 + 直接构造的监督器（注入测试缝）。 */
interface SupervisorBooted {
  ctx: Context
  fixture: AgentFixture
  supervisor: ManagedMcp.AgentSupervisor
  registeredNames(): string[]
  setKey(value: string | undefined): void
  emitCredentialUpdate(): void
  restoreEnv(): void
}

interface SupervisorBootOptions {
  /** 预建 fixture（可先 setMode 控制请求行为）；缺省新建 healthy fixture。 */
  fixture?: AgentFixture | undefined
  /** `yootun-access` namespace 的 settings 值；缺省为已激活快照。 */
  access?: Record<string, unknown> | undefined
  /** MODELS_API_KEY 解析值。 */
  keyValue?: string | undefined
  /** 自愈退避基值毫秒。 */
  rebuildBackoffMs: number
  /** 退避抖动随机源注入（定值 → 延迟无抖动）。 */
  random?: (() => number) | undefined
  /** 官方重连策略覆盖（测试缝：小预算加速 `failed`）。 */
  reconnect?: ManagedMcp.SupervisorOptions['reconnect']
}

/**
 * Boot the services the supervisor's child needs, then create the supervisor
 * directly with the injected seams so tests hold its snapshot handle.
 */
async function bootSupervisor(options: SupervisorBootOptions): Promise<SupervisorBooted> {
  const fixture = options.fixture ?? await startAgentFixture()
  const previousUrl = process.env.YOOTUN_AGENT_MCP_URL
  process.env.YOOTUN_AGENT_MCP_URL = fixture.url
  const ctx = new Context()
  let accessValue: Record<string, unknown> = options.access ?? ACTIVATED_SNAPSHOT
  let keyValue: string | undefined = options.keyValue ?? 'test-model-key'
  ctx.reflect.provide('settings', {
    describe: () => [{ ns: ManagedMcp.ACCESS_NAMESPACE, value: accessValue }],
  })
  ctx.reflect.provide('credentials', {
    resolve: async () => keyValue === undefined ? undefined : { source: 'test' as const, value: keyValue },
  })
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    const supervisor = ManagedMcp.createSupervisor(ctx, {
      rebuildBackoffMs: options.rebuildBackoffMs,
      ...(options.random !== undefined ? { random: options.random } : {}),
      ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
    })
    supervisor.reevaluate('test boot')
    const registeredNames = (): string[] =>
      (ctx.tools.schemas() as Array<{ name: string }>).map(schema => schema.name)
    return {
      ctx,
      fixture,
      supervisor,
      registeredNames,
      setKey(value) { keyValue = value },
      emitCredentialUpdate() { ctx.emit('credentials/reference-updated', credentialRef(ACCESS_CREDENTIAL_REF) as CredentialRef) },
      restoreEnv() { process.env.YOOTUN_AGENT_MCP_URL = previousUrl },
    }
  } catch (error: unknown) {
    process.env.YOOTUN_AGENT_MCP_URL = previousUrl
    await fixture.close()
    await ctx.fiber.dispose()
    throw error
  }
}

async function shutdownSupervisor(booted: SupervisorBooted): Promise<void> {
  booted.restoreEnv()
  await booted.supervisor.dispose()
  await booted.ctx.fiber.dispose()
  await booted.fixture.close().catch(() => undefined)
}

/** 自愈用例的重连覆盖：官方 client 一次失败即 `failed`，加速状态机收敛。 */
const FAST_FAILED_RECONNECT = { enabled: true, initialDelayMs: 20, maxDelayMs: 100, maxAttempts: 1 } as const

/** 状态路由的响应替身（结构面，无 cast）：记录状态码与响应体。 */
class FakeStatusResponse implements ManagedMcp.StatusRouteResponse {
  code = 0
  body = ''

  get statusCode(): number { return this.code }
  set statusCode(value: number) { this.code = value }

  setHeader(): void {}

  end(body?: string | undefined): void { this.body = body ?? '' }
}

/** 状态路由处理函数的结构面：接受请求与响应替身。 */
type StatusRouteHandler = (req: ManagedMcp.StatusRouteRequest, res: ManagedMcp.StatusRouteResponse) => Promise<void>

/** 状态路由的请求替身：缺省为 loopback、无体的 POST（Desktop 转发剥双头形态）。 */
function statusRequest(overrides: { method?: string | undefined; remote?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined } = {}): ManagedMcp.StatusRouteRequest {
  const method = overrides.method ?? 'POST'
  const remote = overrides.remote ?? '127.0.0.1'
  const headers = overrides.headers ?? {}
  const body = overrides.body ?? ''
  async function* iterate(): AsyncGenerator<Buffer> {
    if (body.length > 0) yield Buffer.from(body)
  }
  return { method, socket: { remoteAddress: remote }, headers, [Symbol.asyncIterator]: iterate }
}

/** webServer 替身（结构面）：记录注册的路由与注销次数；origin 可指定。 */
class FakeWebServer {
  /** 经 register 收到的路由，按注册顺序。 */
  readonly registered: Array<{ kind: string; path: string; handler: StatusRouteHandler }> = []
  /** 路由注销次数。 */
  disposed = 0
  private readonly origin: string

  constructor(origin = 'http://127.0.0.1:3210') {
    this.origin = origin
  }

  getOrigin(): string { return this.origin }

  register(route: { kind: string; path: string; handler: StatusRouteHandler }): () => void {
    this.registered.push(route)
    return () => { this.disposed += 1 }
  }
}

test('已分类 Agent 工具无重复、全有归类，Catalog 与 Workbench 名不归类', () => {
  assert.equal(AGENT_TOOL_NAMES.length, new Set(AGENT_TOOL_NAMES).size)
  assert.ok(AGENT_TOOL_NAMES.length > 0)
  for (const toolName of AGENT_TOOL_NAMES) assert.notEqual(classifyAgentTool(toolName), 'unknown')
  assert.equal(classifyAgentTool('workbench_wx_account_list'), 'unknown')
  assert.equal(classifyAgentTool('yootun_business_tools_search'), 'unknown')
  assert.equal(classifyAgentTool('yootun_xhs_creative_task_start'), 'task-write')
  assert.equal(classifyAgentTool('yootun_wx_accounts_list'), 'read')
  // 抖音发布排期（分册 08 §4.3）：list 只读，row 写是同步幂等写，单列一类、同样按 ask。
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_list'), 'read')
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_create'), 'schedule-write')
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_update'), 'schedule-write')
  // row_delete 按产品决策仅进 Workbench 面，会话中未分类 → ask（经确认后可用）。
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_delete'), 'unknown')
})

test('A1/A2 视频号 AI 报表：两个只读工具免审批放行，三张策略表无「重新生成」', async () => {
  // A2：Agent 面不提供「重新生成」，read / task-write / schedule-write 三张表都不出现。
  assert.equal(classifyAgentTool('yootun_wx_report_regenerate'), 'unknown')
  for (const toolName of AGENT_TOOL_NAMES) {
    assert.ok(!toolName.endsWith('_report_regenerate'), `no regenerate tool in policy tables: ${toolName}`)
  }
  // A1：两个只读工具归类 read，tools/call 免审批到达假 server 并携带正确工具名。
  assert.equal(classifyAgentTool('yootun_wx_reports_list'), 'read')
  assert.equal(classifyAgentTool('yootun_wx_report_get'), 'read')
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'agent tools registered')
    const batch = await booted.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('wx-report-read-1'), name: 'mcp__yootun-agent__yootun_wx_reports_list', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('wx-report-read-2'), name: 'mcp__yootun-agent__yootun_wx_report_get', arguments: '{"reportId":"wx-r-1"}' },
      ],
    })
    assert.equal(batch.results.length, 2)
    assert.equal(batch.results[0]?.result.isError, false)
    assert.equal(batch.results[1]?.result.isError, false)
    assert.ok(booted.fixture.toolCalls.includes('yootun_wx_reports_list'), 'reports_list 到达假 server')
    assert.ok(booted.fixture.toolCalls.includes('yootun_wx_report_get'), 'report_get 到达假 server')
  } finally {
    await shutdown(booted)
  }
})

test('未激活时零连接、零工具', async () => {
  const booted = await boot({ access: { setupComplete: false, validationVersion: Number(VALIDATION_VERSION) }, keyValue: 'test-model-key' })
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(booted.fixture.authorization.length, 0, '未激活不得发起任何网络请求')
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0)
  } finally {
    await shutdown(booted)
  }
})

test('缺 settings 或 credentials 服务时同样零连接', async () => {
  const booted = await boot({ omitServices: true })
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(booted.fixture.authorization.length, 0)
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0)
  } finally {
    await shutdown(booted)
  }
})

test('激活后仅 Agent 面注册，且假 server 走通 initialize / tools/list / tools/call', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'agent tools registered')
    const agentNames = booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).map(name => name.slice('mcp__yootun-agent__'.length))
    assert.deepEqual(new Set(agentNames), new Set(AGENT_TOOL_NAMES))
    assert.equal(booted.fixture.authorization.length > 0, true, '激活后连接建立')
    assert.ok(booted.fixture.authorization.every(value => value === 'Bearer test-model-key'), 'Authorization 使用 Bearer 模板并展开为解析后的 key')
    assert.equal(booted.registeredNames().some(name => name.startsWith('mcp__yootun-workbench__')), false)
    assert.equal(booted.registeredNames().some(name => name.startsWith('mcp__yootun-catalog__')), false)

    const batch = await booted.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('read-1'), name: 'mcp__yootun-agent__yootun_wx_accounts_list', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('read-2'), name: 'mcp__yootun-agent__yootun_douyin_publish_schedule_list', arguments: '{}' },
      ],
    })
    assert.equal(batch.results.length, 2)
    assert.equal(batch.results[0]?.result.isError, false)
    assert.equal(batch.results[1]?.result.isError, false, '发布排期 list 只读放行')
    assert.ok(booted.fixture.toolCalls.includes('yootun_wx_accounts_list'), 'tools/call 到达假 server')
    assert.ok(booted.fixture.toolCalls.includes('yootun_douyin_publish_schedule_list'), '发布排期 list 到达假 server')
  } finally {
    await shutdown(booted)
  }
})

test('根作用域已有 mcpClientHost 提供方时仍能挂载 Agent 面，且不覆盖该提供方', async () => {
  const booted = await boot({ foreignHost: true })
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'agent tools registered beside the root mcpClientHost')
    assert.equal(booted.fixture.authorization.length > 0, true, '激活后连接建立')

    // 本插件卸载只会带走自己隔离子作用域里的 host；根作用域的外部提供方必须原样保留。
    await booted.pluginFiber.dispose()
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0, '插件卸载后工具清空')
    assert.notEqual(booted.ctx.get('mcpClientHost'), undefined, '根作用域的外部 mcpClientHost 不受本插件影响')
  } finally {
    await shutdown(booted)
  }
})

test('key 更新销毁重建、key 移除卸载', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'initial mount')
    const connectionsAfterMount = booted.fixture.authorization.length

    // key 更新：reference-updated 事件触发销毁重建（新 client 重新连接）。
    booted.setKey('rotated-model-key')
    booted.emitCredentialUpdate()
    // 等待「重建后工具重新到齐」，轮换期间的旧连接/新连接都会推高授权头计数。
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length
      && booted.fixture.authorization.length > connectionsAfterMount, 'client rebuilt after key rotation')
    assert.equal(booted.fixture.authorization.length > connectionsAfterMount, true)
    assert.ok(booted.fixture.authorization.includes('Bearer rotated-model-key'), '重建后连接携带轮换后的 key')

    // key 移除：门禁失败，client 卸载、工具清空。
    booted.setKey(undefined)
    booted.emitCredentialUpdate()
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 0, 'tools removed after key removal')
  } finally {
    await shutdown(booted)
  }
})

test('setupComplete 翻转控制挂载', async () => {
  const booted = await boot({ access: { setupComplete: false, validationVersion: Number(VALIDATION_VERSION) } })
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(booted.fixture.authorization.length, 0)
    booted.setAccess(ACTIVATED_SNAPSHOT)
    booted.emitSettingsUpdate()
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'mounted after activation')
  } finally {
    await shutdown(booted)
  }
})

test('validationVersion 不匹配时不挂载', async () => {
  const booted = await boot({ access: { setupComplete: true, validationVersion: Number(VALIDATION_VERSION) + 1 } })
  try {
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(booted.fixture.authorization.length, 0)
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0)
  } finally {
    await shutdown(booted)
  }
})

test('guard：会话内任务型写/未分类工具经审批管线不放行，Workbench/Catalog 面拒绝', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'initial mount')
    const batch = await booted.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('unknown-1'), name: 'mcp__yootun-agent__yootun_business_tools_search', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('wb-1'), name: 'mcp__yootun-workbench__workbench_wx_account_list', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('cat-1'), name: 'mcp__yootun-catalog__yootun_business_capabilities_list', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('write-1'), name: 'mcp__yootun-agent__yootun_xhs_creative_task_start', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('write-2'), name: 'mcp__yootun-agent__yootun_douyin_publish_schedule_row_create', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('write-3'), name: 'mcp__yootun-agent__yootun_douyin_publish_schedule_row_update', arguments: '{}' },
      ],
    })
    assert.equal(batch.results.length, 6)
    for (const outcome of batch.results) {
      assert.equal(outcome.result.isError, true, `${outcome.callId} 应被 guard 拒绝`)
    }
    assert.equal(booted.fixture.toolCalls.length, 0, '被拒调用不得到达假 server')
    // 任务型写与未分类工具都走 ask→无 approval 服务→deny 的管线。
  } finally {
    await shutdown(booted)
  }
})

test('guard 决策：三类 ask 的 reason 与中英文卡片文案，Workbench/Catalog 面 deny，非 yootun 透传 next', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'initial mount')
    const exec = (name: string): ToolExecution => ({
      callId: brandString<ToolCallId>('guard-probe'),
      rootCallId: brandString<ToolCallId>('guard-probe'),
      token: Symbol('guard-probe') as ToolExecutionToken,
      name,
      arguments: {},
      signal: new AbortController().signal,
    })
    const next = async (): Promise<PreToolDecision> => ({ kind: 'allow' })

    // 三类 ask：模型可见 reason 为英文；卡片文案同时提供 en 与 zh，且 en 与 reason 一致。
    const asks = [
      {
        name: 'mcp__yootun-agent__yootun_xhs_creative_task_start',
        reason: 'yootun tool "yootun_xhs_creative_task_start" starts or changes a remote task and may incur model fees',
        zh: 'yootun 工具「yootun_xhs_creative_task_start」会启动或变更远端任务，可能产生模型费用',
      },
      {
        name: 'mcp__yootun-agent__yootun_douyin_publish_schedule_row_update',
        reason: 'yootun tool "yootun_douyin_publish_schedule_row_update" writes a douyin publish schedule record on the server',
        zh: 'yootun 工具「yootun_douyin_publish_schedule_row_update」会在服务端写入一条抖音发布排期记录',
      },
      {
        name: 'mcp__yootun-agent__yootun_business_tools_search',
        reason: 'yootun agent tool "yootun_business_tools_search" is not yet classified; confirm before use',
        zh: 'yootun 工具「yootun_business_tools_search」尚未归类，使用前请确认',
      },
    ]
    for (const probe of asks) {
      const decision = await booted.ctx.waterfall('tools/pre-execute', exec(probe.name), next)
      assert.ok(decision.kind === 'ask', `${probe.name} 应 ask`)
      assert.equal(decision.reason, probe.reason)
      assert.equal(decision.displayReason?.en, probe.reason)
      assert.equal(decision.displayReason?.zh, probe.zh)
    }

    const workbenchFace = await booted.ctx.waterfall('tools/pre-execute', exec('mcp__yootun-workbench__workbench_wx_account_list'), next)
    assert.equal(workbenchFace.kind, 'deny', 'Workbench 面仍 deny')
    const catalogFace = await booted.ctx.waterfall('tools/pre-execute', exec('mcp__yootun-catalog__yootun_business_capabilities_list'), next)
    assert.equal(catalogFace.kind, 'deny', 'Catalog 面仍 deny')

    const foreignMcp = await booted.ctx.waterfall('tools/pre-execute', exec('mcp__other-plain__tool_x'), next)
    assert.deepEqual(foreignMcp, { kind: 'allow' }, '非 yootun MCP 工具透传 next')
    const nativeName = await booted.ctx.waterfall('tools/pre-execute', exec('native_echo'), next)
    assert.deepEqual(nativeName, { kind: 'allow' }, '原生工具名透传 next')
  } finally {
    await shutdown(booted)
  }
})

test('卸载后无残留工具、无新增连接', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'initial mount')
    const connectionsBefore = booted.fixture.authorization.length
    await booted.pluginFiber.dispose()
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0, '卸载后 ctx.tools 无 yootun 工具')
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(booted.fixture.authorization.length, connectionsBefore, '卸载后无重连尝试')
  } finally {
    await shutdown(booted)
  }
})

test('初始连接失败不阻塞插件加载，不伪造工具可用', async () => {
  // 先起 fixture 再关闭，得到一个确定不可达的端口。
  const dead = await startAgentFixture()
  await dead.close()
  process.env.YOOTUN_AGENT_MCP_URL = dead.url
  const booted = await boot({ fixture: dead })
  try {
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0, '连接失败时无 yootun 工具（不伪造可用）')
    assert.equal(booted.fixture.authorization.length, 0, '不可达端口零成功连接')
  } finally {
    await shutdown(booted)
  }
})

test('guard 对 serverName 大小写变体同样拒绝', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'initial mount')
    const batch = await booted.ctx.tools.execute({
      signal: AbortSignal.timeout(10_000),
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('case-1'), name: 'mcp__Yootun-Workbench__workbench_wx_account_list', arguments: '{}' },
        { type: 'tool-call' as const, id: brandString<ToolCallId>('case-2'), name: 'mcp__YOOTUN-CATALOG__yootun_business_tools_search', arguments: '{}' },
      ],
    })
    assert.equal(batch.results.length, 2)
    for (const outcome of batch.results) assert.equal(outcome.result.isError, true, '大小写变体仍被拒绝')
    assert.equal(booted.fixture.toolCalls.length, 0, '变体调用不到达 Agent 面')
  } finally {
    await shutdown(booted)
  }
})

test('S1：门禁通过后挂载，快照 connecting → connected，count 为登记工具数', async () => {
  const fixture = await startAgentFixture()
  fixture.setMode('hold')
  const booted = await bootSupervisor({ fixture, rebuildBackoffMs: 1000 })
  try {
    await waitFor(() => booted.supervisor.snapshot().state === 'connecting', 'connecting while the fixture holds')
    assert.equal(booted.supervisor.snapshot().attempt, 0)
    fixture.setMode('healthy')
    fixture.release()
    await waitFor(() => booted.supervisor.snapshot().state === 'connected', 'connected after release')
    const snap = booted.supervisor.snapshot()
    assert.equal(snap.count, AGENT_TOOL_NAMES.length, 'count 取官方登记的工具数')
    assert.equal(snap.attempt, 0)
    assert.equal(Number.isNaN(Date.parse(snap.since)), false, 'since 为可解析的 ISO 8601')
    assert.equal(snap.retryAt, undefined, 'connected 无 retryAt')
  } finally {
    await shutdownSupervisor(booted)
  }
})

test('S2：failed 后无事件按退避自愈重建，第二次失败延迟约为两倍', async () => {
  const fixture = await startAgentFixture()
  fixture.setMode('reject')
  const booted = await bootSupervisor({ fixture, rebuildBackoffMs: 1000, random: () => 0.5, reconnect: FAST_FAILED_RECONNECT })
  try {
    await waitFor(() => booted.supervisor.snapshot().state === 'failed', 'first failure exhausts the official attempt budget')
    assert.equal(Number.isNaN(Date.parse(booted.supervisor.snapshot().retryAt ?? 'invalid')), false, 'failed 期间快照带排定的 retryAt')
    const firstFailedAt = Date.now()
    const attemptsAfterFirstFailure = booted.fixture.authorization.length
    // 无任何门禁事件：第一次自愈重建的挂载请求 + 新一轮 failed。
    await waitFor(() => booted.supervisor.snapshot().state === 'failed' && booted.fixture.authorization.length > attemptsAfterFirstFailure, 'second failure follows the first self-heal rebuild')
    const secondFailedAt = Date.now()
    const firstDelay = secondFailedAt - firstFailedAt
    assert.ok(firstDelay >= 850, `第一次自愈延迟 ${String(firstDelay)}ms 达到基值量级`)
    assert.ok(firstDelay <= 1800, `第一次自愈延迟 ${String(firstDelay)}ms 在基值窗内`)

    const attemptsAfterSecondFailure = booted.fixture.authorization.length
    await waitFor(() => booted.supervisor.snapshot().state === 'failed' && booted.fixture.authorization.length > attemptsAfterSecondFailure, 'third failure follows the doubled-backoff rebuild')
    const thirdFailedAt = Date.now()
    const secondDelay = thirdFailedAt - secondFailedAt
    assert.ok(secondDelay >= 1700, `第二次自愈延迟 ${String(secondDelay)}ms 达到两倍量级`)
    assert.ok(secondDelay <= 2900, `第二次自愈延迟 ${String(secondDelay)}ms 在两倍窗内`)
    assert.ok(secondDelay > firstDelay, '第二次延迟严格大于第一次（退避倍增）')
  } finally {
    await shutdownSupervisor(booted)
  }
})

test('S3：connected 后退避复位，下一次失败回到基值', async () => {
  const fixture = await startAgentFixture()
  fixture.setMode('reject')
  const booted = await bootSupervisor({ fixture, rebuildBackoffMs: 1000, random: () => 0.5, reconnect: FAST_FAILED_RECONNECT })
  try {
    await waitFor(() => booted.supervisor.snapshot().state === 'failed', 'first failure (backoff at base)')
    fixture.setMode('healthy')
    await waitFor(() => booted.supervisor.snapshot().state === 'connected', 'self-heal rebuild connects')
    // connected 复位退避（触发时翻倍的值回到基值）。用凭证重建制造下一次失败：
    // 该既有路径不触碰退避，失败后的退避值只反映 connected 的复位。
    fixture.setMode('reject')
    booted.setKey('rotated-model-key')
    booted.emitCredentialUpdate()
    await waitFor(() => booted.supervisor.snapshot().state === 'failed', 'failure #2 after the credential rebuild')
    const failedAt = Date.now()
    const attemptsAfterSecondFailure = booted.fixture.authorization.length
    await waitFor(() => booted.supervisor.snapshot().state === 'failed' && booted.fixture.authorization.length > attemptsAfterSecondFailure, 'self-heal rebuild from the reset backoff')
    const delay = Date.now() - failedAt
    assert.ok(delay >= 850, `复位后延迟 ${String(delay)}ms 达到基值量级`)
    assert.ok(delay <= 1800, `复位后延迟 ${String(delay)}ms 是基值而非翻倍值`)
  } finally {
    await shutdownSupervisor(booted)
  }
})

test('S4：dispose 清除待触发的重建，不再 mount', async () => {
  const fixture = await startAgentFixture()
  fixture.setMode('reject')
  const booted = await bootSupervisor({ fixture, rebuildBackoffMs: 1000, random: () => 0.5, reconnect: FAST_FAILED_RECONNECT })
  try {
    await waitFor(() => booted.supervisor.snapshot().state === 'failed', 'failure schedules the rebuild')
    await booted.supervisor.dispose()
    const attemptsAtDispose = fixture.authorization.length
    fixture.setMode('healthy')
    await new Promise(resolve => setTimeout(resolve, 1400))
    assert.equal(fixture.authorization.length, attemptsAtDispose, 'dispose 后原定的重建不再发生（无新连接尝试）')
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0, 'dispose 后无 yootun 工具')
  } finally {
    await shutdownSupervisor(booted)
  }
})

test('S5：未激活时快照 disabled、attempt 0、零连接', async () => {
  const booted = await bootSupervisor({ access: { setupComplete: false, validationVersion: Number(VALIDATION_VERSION) }, rebuildBackoffMs: 1000 })
  try {
    await new Promise(resolve => setTimeout(resolve, 200))
    const snap = booted.supervisor.snapshot()
    assert.equal(snap.state, 'disabled')
    assert.equal(snap.attempt, 0)
    assert.equal(snap.count, 0)
    assert.equal(snap.retryAt, undefined)
    assert.equal(booted.fixture.authorization.length, 0, 'disabled 零网络')
    assert.equal(booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length, 0)
  } finally {
    await shutdownSupervisor(booted)
  }
})

test('S6：状态路由 POST 快照、405/403/503 与空体契约', async () => {
  let snapshot: ManagedMcp.AgentFaceSnapshot = { state: 'connected', attempt: 0, since: '2026-11-26T00:00:00.000Z', count: 3 }
  let disposing = false
  const handler = createAgentStatusRouteHandler(() => 'http://127.0.0.1:1', { snapshot: () => snapshot }, () => disposing)

  const request = statusRequest

  // POST 无体（Desktop 转发剥双头形态）→ 200 快照，字段恰为契约集合。
  const ok = new FakeStatusResponse()
  await handler(request(), ok)
  assert.equal(ok.code, 200)
  const payload = JSON.parse(ok.body) as Record<string, unknown>
  assert.deepEqual(Object.keys(payload).sort(), ['attempt', 'count', 'since', 'state', 'status'])
  assert.equal(payload.status, 'ok')
  assert.equal(payload.state, 'connected')
  assert.equal(payload.count, 3)

  // 显式空对象体同样 200；failed 快照带 retryAt。
  snapshot = { state: 'failed', attempt: 4, since: '2026-11-26T00:00:30.000Z', count: 0, retryAt: '2026-11-26T00:01:00.000Z' }
  const emptyBody = new FakeStatusResponse()
  await handler(request({ body: '{}' }), emptyBody)
  assert.equal(emptyBody.code, 200)
  const failedPayload = JSON.parse(emptyBody.body) as Record<string, unknown>
  assert.deepEqual(Object.keys(failedPayload).sort(), ['attempt', 'count', 'retryAt', 'since', 'state', 'status'])

  // 非 POST → 405。
  const notPost = new FakeStatusResponse()
  await handler(request({ method: 'GET' }), notPost)
  assert.equal(notPost.code, 405)

  // 信任判定：异源 Origin、显式 cross-site、非 loopback → 403（同源 Origin + loopback 已由上文覆盖）。
  for (const untrusted of [
    request({ headers: { origin: 'https://evil.example' } }),
    request({ headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'cross-site' } }),
    request({ remote: '10.0.0.1' }),
  ]) {
    const denied = new FakeStatusResponse()
    await handler(untrusted, denied)
    assert.equal(denied.code, 403)
  }

  // 卸载中 → 503 plugin_disposing（先于体校验，理由固定）。
  disposing = true
  const disposingRes = new FakeStatusResponse()
  await handler(request({ body: '{"key":"x"}' }), disposingRes)
  assert.equal(disposingRes.code, 503)
  assert.equal((JSON.parse(disposingRes.body) as Record<string, unknown>).reason, 'plugin_disposing')
  disposing = false

  // 体契约：非空对象、非法 JSON、超限体 → 400。
  for (const invalid of [
    request({ body: '{"key":"x"}' }),
    request({ body: 'not-json' }),
    request({ body: `"${'a'.repeat(70 * 1024)}"` }),
  ]) {
    const rejected = new FakeStatusResponse()
    await handler(invalid, rejected)
    assert.equal(rejected.code, 400)
  }

  // permitted 直测：loopback 形态全放行，标记语义与视频号路由对齐。
  assert.equal(permitted(request(), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(request({ headers: { origin: 'http://127.0.0.1:1', 'sec-fetch-site': 'same-origin' } }), 'http://127.0.0.1:1'), true)
  assert.equal(permitted(request({ headers: { origin: 'null' } }), 'http://127.0.0.1:1'), false)
  assert.equal(permitted(request({ remote: '::1' }), 'http://127.0.0.1:1'), true)
})

test('S6：无 webServer 时不注册状态路由且插件照常加载', async () => {
  const booted = await boot()
  try {
    assert.equal(booted.ctx.get('webServer'), undefined, '组合未提供 webServer')
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'agent tools registered without a webServer')
    assert.equal(booted.fixture.authorization.length > 0, true, '监督器挂载不受影响')
  } finally {
    await shutdown(booted)
  }
})

test('S7：webServer 晚于插件就绪时，状态路由在其就绪后注册并可响应', async () => {
  const booted = await boot()
  const webServer = new FakeWebServer()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === AGENT_TOOL_NAMES.length, 'agent tools registered before a webServer exists')
    assert.equal(webServer.registered.length, 0)
    booted.ctx.reflect.provide('webServer', webServer)
    await waitFor(() => webServer.registered.length === 1, 'status route registered once the webServer is available')
    const [route] = webServer.registered
    assert.equal(route?.kind, 'exact')
    assert.equal(route?.path, STATUS_PATH)
    const response = new FakeStatusResponse()
    await route?.handler(statusRequest(), response)
    assert.equal(response.code, 200)
    const payload = JSON.parse(response.body) as Record<string, unknown>
    assert.equal(payload.status, 'ok')
    assert.ok(['disabled', 'connecting', 'connected', 'failed', 'waiting-credentials'].includes(payload.state as string))
    assert.equal(webServer.disposed, 0)
  } finally {
    await shutdown(booted)
  }
  assert.equal(webServer.disposed, 1, '插件卸载时路由随之注销')
})

test('S8：webServer 先于插件就绪时，插件加载后随即注册状态路由，origin 取自该实例', async () => {
  const webServer = new FakeWebServer('http://127.0.0.1:4321')
  const booted = await boot({ webServer })
  try {
    await waitFor(() => webServer.registered.length === 1, 'status route registered on the boot-time webServer')
    const [route] = webServer.registered
    assert.equal(route?.path, STATUS_PATH)
    const sameOrigin = new FakeStatusResponse()
    await route?.handler(statusRequest({ headers: { origin: 'http://127.0.0.1:4321' } }), sameOrigin)
    assert.equal(sameOrigin.code, 200)
    const foreign = new FakeStatusResponse()
    await route?.handler(statusRequest({ headers: { origin: 'https://evil.example' } }), foreign)
    assert.equal(foreign.code, 403)
  } finally {
    await shutdown(booted)
  }
})

test('S9：webServer 被替换后，状态路由在旧实例上注销、在新实例上重新注册', async () => {
  const booted = await boot()
  const first = new FakeWebServer('http://127.0.0.1:4321')
  const second = new FakeWebServer('http://127.0.0.1:4322')
  const mount = (server: FakeWebServer) => booted.ctx.plugin({
    name: 'fake-web-server',
    apply: (scope: Context) => { scope.reflect.provide('webServer', server) },
  })
  try {
    const firstFiber = mount(first)
    await waitFor(() => first.registered.length === 1, 'status route registered on the first instance')
    await firstFiber.dispose()
    await waitFor(() => first.disposed === 1, 'status route removed from the first instance')
    assert.equal(second.registered.length, 0)
    mount(second)
    await waitFor(() => second.registered.length === 1, 'status route registered on the replacement instance')
    const [route] = second.registered
    const response = new FakeStatusResponse()
    await route?.handler(statusRequest({ headers: { origin: 'http://127.0.0.1:4322' } }), response)
    assert.equal(response.code, 200, 'origin 取自替换后的实例')
  } finally {
    await shutdown(booted)
  }
})
