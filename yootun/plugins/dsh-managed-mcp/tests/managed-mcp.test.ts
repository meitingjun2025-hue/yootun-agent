/**
 * Agent 面 managed MCP 生命周期与 guard 测试（node --test，真实 Cordis 组合 +
 * 假 MCP server）：未激活零连接、激活后仅 Agent 39、key 更新/移除、guard
 * 读/写/未识别、Workbench/Catalog 拒绝、卸载清理。
 * 运行：`pnpm --filter @yootun/dsh-managed-mcp test`。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { brandString, type ToolCallId } from '@deepseek-ai/dsh-brand'
import { McpClientHost } from '@deepseek-ai/dsh-mcp-client'
import { VALIDATION_VERSION } from '@yootun/dsh-client-ui-access/src/access-constants.ts'
import * as ManagedMcp from '../src/index.ts'
import { classifyAgentTool, AGENT_TOOL_NAMES } from '../src/guard.ts'
import { ACCESS_CREDENTIAL_REF } from '../src/constants.ts'
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

test('39 项 Agent 契约分类无遗漏且无未知', () => {
  assert.equal(AGENT_TOOL_NAMES.length, 39)
  assert.equal(new Set(AGENT_TOOL_NAMES).size, 39)
  for (const toolName of AGENT_TOOL_NAMES) assert.notEqual(classifyAgentTool(toolName), 'unknown')
  assert.equal(classifyAgentTool('workbench_wx_account_list'), 'unknown')
  assert.equal(classifyAgentTool('yootun_business_tools_search'), 'unknown')
  assert.equal(classifyAgentTool('yootun_xhs_creative_task_start'), 'task-write')
  assert.equal(classifyAgentTool('yootun_wx_accounts_list'), 'read')
  // 抖音发布排期三项（分册 08 §4.3）：list 只读，row 写按 ask。
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_list'), 'read')
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_create'), 'task-write')
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_update'), 'task-write')
  // row_delete 按产品决策仅进 Workbench 面，会话中未识别 → deny。
  assert.equal(classifyAgentTool('yootun_douyin_publish_schedule_row_delete'), 'unknown')
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

test('激活后仅 Agent 面 39 项注册，且假 server 走通 initialize / tools/list / tools/call', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, '39 agent tools registered')
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
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, '39 agent tools registered beside the root mcpClientHost')
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
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, 'initial mount')
    const connectionsAfterMount = booted.fixture.authorization.length

    // key 更新：reference-updated 事件触发销毁重建（新 client 重新连接）。
    booted.setKey('rotated-model-key')
    booted.emitCredentialUpdate()
    // 等待「重建后工具重新到齐」，轮换期间的旧连接/新连接都会推高授权头计数。
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39
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
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, 'mounted after activation')
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

test('guard：会话内拒绝未识别 yootun 工具与 Workbench/Catalog 面', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, 'initial mount')
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
    // 任务型写被拒走 ask→无 approval 服务→deny 的管线，未知工具走 deny。
  } finally {
    await shutdown(booted)
  }
})

test('卸载后无残留工具、无新增连接', async () => {
  const booted = await boot()
  try {
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, 'initial mount')
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
    await waitFor(() => booted.registeredNames().filter(name => name.startsWith('mcp__yootun-agent__')).length === 39, 'initial mount')
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
