/**
 * yootun 接入层包内冒烟（node --test，不进官方 vitest scope）：路由失败原因
 * 分类（R1）与目录解析、门禁三态判定与未知回落（R2）、激活写入顺序与目录
 * 合并（R3）、失败原因与目录同步的表单裁决（R4）、生成常量与 brand.json 的
 * 一致性。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-access test`（node ≥24 原生 type stripping）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { handleDofeModelsRequest, handleDofeValidateRequest, parseModelCatalog } from '../src/route.ts'
import { accessFailureKey, existingProviderModels, gatePhase, GATE_UNKNOWN_FALLBACK_MS, isAuthorized, providerDeclaresModel, saveActivation, timeoutScheduler, type AccessForms, type AccessSettings, type CredentialsFace, type ProviderModelsSection } from '../src/client/logic.ts'
import { agentStatusPresentation, createAgentStatusPoller, parseAgentStatus, type AgentStatusPresentation, type AgentStatusView } from '../src/client/agent-status.ts'
import { en, zh } from '../src/client/locales.ts'
import { TENANT, TENANT_ID, VALIDATION_VERSION } from '../src/access-constants.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('parseModelCatalog 过滤非对话模型并按目录行映射字段', () => {
  const models = parseModelCatalog({
    data: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: 'managed', contextWindow: 1_000_000, inputModalities: ['text', 'image'] },
      { id: 'deepseek-v4-audio', name: 'audio', contextWindow: 1 },
      { id: 'deepseek-v4-pro', name: 'Pro' },
      { id: 'deepseek-v4-flash', name: 'duplicate' },
      { name: 'no-id' },
      'not-an-object',
    ],
  })
  assert.deepEqual(models.map(model => model.id), ['deepseek-v4-flash', 'deepseek-v4-pro'])
  assert.equal(models[0]?.name, 'DeepSeek V4 Flash')
  assert.equal(models[0]?.description, 'managed')
  assert.equal(models[0]?.contextWindow, 1_000_000)
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
  assert.equal(models[1]?.name, 'Pro')
})

test('parseModelCatalog 接受裸数组与拒绝异常载荷', () => {
  assert.equal(parseModelCatalog([{ id: 'm1' }]).length, 1)
  assert.deepEqual(parseModelCatalog('nope'), [])
  assert.deepEqual(parseModelCatalog(null), [])
  assert.deepEqual(parseModelCatalog({ data: 'nope' }), [])
})

test('R2：门禁判定输入未就绪返回未知，已知输入维持 fail-closed', () => {
  const authorized: AccessSettings = {
    setupComplete: true, validationVersion: Number(VALIDATION_VERSION), enabledPlugins: [], modelId: 'deepseek-v4-flash',
  }
  assert.equal(isAuthorized(authorized, true), true)
  assert.equal(isAuthorized(authorized, false), false)
  // 输入未就绪 → 未知（供门禁渲染遮罩，不闪卡片）。
  assert.equal(isAuthorized(undefined, true), undefined)
  assert.equal(isAuthorized(authorized, undefined), undefined)
  assert.equal(isAuthorized(undefined, undefined), undefined)
  // 已知输入维持 fail-closed，版本必须精确一致。
  assert.equal(isAuthorized({ ...authorized, setupComplete: false }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: Number(VALIDATION_VERSION) + 1 }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: 0 }, true), false)
})

test('R2：gatePhase 未知只渲染遮罩、未授权卡片、已授权无层，回落到点按卡片渲染', () => {
  assert.equal(gatePhase(undefined, false), 'unknown')
  assert.equal(gatePhase(undefined, true), 'card')
  assert.equal(gatePhase(false, false), 'card')
  assert.equal(gatePhase(false, true), 'card')
  assert.equal(gatePhase(true, false), 'open')
  // 回落已显示的卡片随授权回包消失。
  assert.equal(gatePhase(true, true), 'open')
})

test('R2：未知回落计时 5 秒触发，清理撤销未触发回调', (t) => {
  const mock = t.mock.timers
  mock.enable({ apis: ['setTimeout'] })
  try {
    assert.equal(GATE_UNKNOWN_FALLBACK_MS, 5_000)
    let fired = 0
    const cancel = timeoutScheduler.schedule(GATE_UNKNOWN_FALLBACK_MS, () => { fired += 1 })
    mock.tick(GATE_UNKNOWN_FALLBACK_MS - 1)
    assert.equal(fired, 0, '5 秒内不触发')
    mock.tick(1)
    assert.equal(fired, 1, '未知持续 5 秒回落为卡片')
    // 回包或卸载路径：清理后时间继续流逝也不再触发。
    const cancelPending = timeoutScheduler.schedule(GATE_UNKNOWN_FALLBACK_MS, () => { fired += 1 })
    cancelPending()
    mock.tick(GATE_UNKNOWN_FALLBACK_MS * 2)
    assert.equal(fired, 1, '清理后不再触发')
    cancel()
  } finally {
    mock.reset()
  }
})

test('生成常量与 brand.json 的租户与版本单一来源一致', () => {
  const brandConfig = JSON.parse(readFileSync(join(packageRoot, '../../../yootun/brand/brand.json'), 'utf8')) as {
    tenant: string; tenantId: string; validationVersion: number
  }
  assert.equal(TENANT, brandConfig.tenant)
  assert.equal(TENANT_ID, brandConfig.tenantId)
  assert.equal(Number(VALIDATION_VERSION), brandConfig.validationVersion)
})

/** 以 zh 词典最小插值渲染投影（镜像官方 `t` 的 `{name}` 替换语义）。 */
function render(presentation: AgentStatusPresentation): string {
  const values = presentation.values ?? {}
  return zh[presentation.key].replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}

test('U1：状态投影 connected / failed 倒计时 / 404 未加载，其余状态各得文案与状态点', () => {
  const now = Date.parse('2026-11-26T00:00:00.000Z')

  const connected = agentStatusPresentation({ state: 'connected', attempt: 0, count: 7 }, now)
  assert.equal(render(connected), '已连接，共 7 个工具可用')
  assert.equal(connected.dot, 'done')

  const failed = agentStatusPresentation({ state: 'failed', attempt: 3, count: 0, retryAt: new Date(now + 30_000).toISOString() }, now)
  assert.equal(render(failed), '连接失败，30 秒后自动重试')
  assert.equal(failed.dot, 'error')
  const expired = agentStatusPresentation({ state: 'failed', attempt: 3, count: 0, retryAt: new Date(now - 500).toISOString() }, now)
  assert.equal(render(expired), '连接失败，0 秒后自动重试')

  // fetch 失败或 404 → 投影入参 undefined → 未加载。
  const notLoaded = agentStatusPresentation(undefined, now)
  assert.equal(render(notLoaded), '未加载，请重启应用')
  assert.equal(notLoaded.dot, 'warning')

  const connecting = agentStatusPresentation({ state: 'connecting', attempt: 0, count: 0 }, now)
  assert.equal(render(connecting), '正在连接（第 1 次）')
  assert.equal(connecting.dot, 'ongoing')
  const disabled = agentStatusPresentation({ state: 'disabled', attempt: 0, count: 0 }, now)
  assert.equal(render(disabled), '未激活，激活后可用')
  assert.equal(disabled.dot, 'idle')
  const waiting = agentStatusPresentation({ state: 'waiting-credentials', attempt: 0, count: 0 }, now)
  assert.equal(render(waiting), '等待密钥')
  assert.equal(waiting.dot, 'warning')
})

test('U1：wire 解析拒绝异常载荷（非 ok / 未知 state / 形态不符 → undefined）', () => {
  const view = parseAgentStatus({ status: 'ok', state: 'failed', attempt: 2, count: 0, retryAt: '2026-11-26T00:01:00.000Z' })
  assert.deepEqual(view, { state: 'failed', attempt: 2, count: 0, retryAt: '2026-11-26T00:01:00.000Z' })
  assert.deepEqual(parseAgentStatus({ status: 'ok', state: 'connected', attempt: 0, count: 5 }), { state: 'connected', attempt: 0, count: 5 })
  for (const bad of [
    undefined,
    null,
    'x',
    {},
    { status: 'error', reason: 'plugin_disposing' },
    { status: 'ok', state: 'bogus', attempt: 0, count: 0 },
    { status: 'ok', state: 'connected', attempt: 1.5, count: 0 },
    { status: 'ok', state: 'connected', attempt: -1, count: 0 },
    { status: 'ok', state: 'connected', attempt: 0, count: -1 },
    { status: 'ok', state: 'failed', attempt: 0, count: 0, retryAt: 5 },
  ]) {
    assert.equal(parseAgentStatus(bad), undefined, `形态不符的载荷须被拒绝: ${JSON.stringify(bad)}`)
  }
})

test('U2：轮询器可见时立即拉取并周期轮询，隐藏停止、恢复立即拉取，卸载清理', async () => {
  let visible = true
  let notify: (() => void) | undefined
  const visibility = {
    visible: (): boolean => visible,
    onChange: (listener: () => void): (() => void) => {
      notify = listener
      return () => { notify = undefined }
    },
  }
  const timers: Array<{ handler: () => void; cancelled: boolean }> = []
  const every = (_intervalMs: number, handler: () => void): (() => void) => {
    const entry = { handler, cancelled: false }
    timers.push(entry)
    return () => { entry.cancelled = true }
  }
  const tick = (): void => {
    for (const entry of [...timers]) if (!entry.cancelled) entry.handler()
  }
  const settle = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)) }

  let calls = 0
  let lastSignal: AbortSignal | undefined
  const poller = createAgentStatusPoller({
    fetch: async (signal: AbortSignal): Promise<AgentStatusView | undefined> => {
      calls += 1
      lastSignal = signal
      return { state: 'connected', attempt: 0, count: 1 }
    },
    visibility,
    every,
  })

  // 初始可见：立即拉一次并发布快照。
  await settle()
  assert.equal(calls, 1)
  assert.equal(poller.getSnapshot().ready, true)
  assert.equal(poller.getSnapshot().view?.state, 'connected')
  tick()
  await settle()
  assert.equal(calls, 2, '间隔到点轮询')

  // 隐藏：停止轮询并中止在途请求。
  visible = false
  notify?.()
  tick()
  await settle()
  assert.equal(calls, 2, '隐藏后间隔不再触发')
  assert.equal(lastSignal?.aborted, true, '隐藏时中止在途请求')

  // 恢复可见：立即拉一次并恢复周期轮询。
  visible = true
  notify?.()
  await settle()
  assert.equal(calls, 3, '恢复可见立即拉一次')
  tick()
  await settle()
  assert.equal(calls, 4, '恢复后周期轮询继续')

  // 卸载：定时器与可见性订阅释放。
  poller.dispose()
  assert.equal(notify, undefined, 'dispose 退订可见性')
  tick()
  await settle()
  assert.equal(calls, 4, 'dispose 后不再拉取')
})

test('U3：词典 zh / en 键集一致且 agent 组键两侧成对', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  const agentKeys = Object.keys(zh).filter(key => key.startsWith('agent.'))
  assert.equal(agentKeys.length, 7)
  for (const key of agentKeys) {
    assert.ok(key in en, `en 缺少 ${key}`)
    assert.ok(zh[key as keyof typeof zh].length > 0)
    assert.ok(en[key as keyof typeof en].length > 0)
  }
})

/** 网关端点字面量（route.ts 内部常量的测试镜像）。 */
const TENANT_CONTEXT_URL = 'https://ixicai.cn/api/internal/auth/context'
const MODEL_CATALOG_URL = 'https://ixicai.cn/api/v1/models?protocol=anthropic'

/** 网关 stub 的单条计划：固定响应、连接抛错、或超时 rejection 形态。 */
type GatewayAction = { status: number; body?: unknown } | 'throw' | 'timeout'

/** 按 URL 索引的网关计划。 */
type GatewayPlan = Record<string, GatewayAction>

/** 网关 stub：按 URL 给出固定响应 / 抛错 / 超时 rejection，未计划的 URL 直接失败。 */
function gatewayStub(plan: GatewayPlan): typeof fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const action = plan[url]
    if (action === undefined) throw new Error(`gateway stub has no plan for ${url}`)
    if (action === 'throw') throw new Error('getaddrinfo ENOTFOUND ixicai.cn')
    if (action === 'timeout') {
      // AbortSignal.timeout 到点后 fetch 以 AbortError 拒绝；stub 直接给出该
      // rejection 形态，测试不真实等待 10 秒。
      throw new DOMException('This operation was aborted', 'AbortError')
    }
    return new Response(JSON.stringify(action.body ?? {}), { status: action.status, headers: { 'content-type': 'application/json' } })
  }
}

/**
 * 起一个只服务被测 handler 的回环服务器并完成一次同源交换：请求侧检查
 * （回环 peer、同源 origin、JSON body）走真实 http 栈，handler 拿到的是
 * 真实 IncomingMessage / ServerResponse。
 */
async function runRoute(
  handler: typeof handleDofeValidateRequest | typeof handleDofeModelsRequest,
  path: '/api/desktop/dofe/validate' | '/api/desktop/dofe/models',
  fetcher: typeof fetch,
): Promise<unknown> {
  let origin = ''
  const server = createServer((request, response) => { void handler(request, response, origin, fetcher) })
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        rejectListen(new Error('route server did not bind a loopback address'))
        return
      }
      origin = `http://127.0.0.1:${String(address.port)}`
      resolveListen()
    })
  })
  try {
    const response = await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ key: 'sk-yootun-test' }),
    })
    return await response.json()
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => { if (error === undefined) resolveClose(); else rejectClose(error) })
    })
  }
}

/** 租户上下文 2xx 且租户匹配的网关计划（可覆写目录端点行为）。 */
function tenantOkPlan(catalog: GatewayAction = { status: 200, body: { data: [{ id: 'gateway-new' }] } }): GatewayPlan {
  return {
    [TENANT_CONTEXT_URL]: { status: 200, body: { data: { tenantId: TENANT_ID } } },
    [MODEL_CATALOG_URL]: catalog,
  }
}

test('R1：validate 路由传输层失败（抛错 / 超时 / 5xx）收敛为 network_unavailable', async () => {
  const tenantOk = { status: 200, body: { data: { tenantId: TENANT_ID } } }
  const cases: GatewayPlan[] = [
    { [TENANT_CONTEXT_URL]: 'throw' },
    { [TENANT_CONTEXT_URL]: 'timeout' },
    { [TENANT_CONTEXT_URL]: { status: 503, body: 'unavailable' } },
    { [TENANT_CONTEXT_URL]: tenantOk, [MODEL_CATALOG_URL]: 'throw' },
    { [TENANT_CONTEXT_URL]: tenantOk, [MODEL_CATALOG_URL]: 'timeout' },
    { [TENANT_CONTEXT_URL]: tenantOk, [MODEL_CATALOG_URL]: { status: 502, body: 'bad gateway' } },
  ]
  for (const plan of cases) {
    assert.deepEqual(
      await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub(plan)),
      { valid: false, reason: 'network_unavailable' },
    )
  }
})

test('R1：validate 路由 401 / 403 → invalid_key，租户不符 → tenant_mismatch，目录为空 → invalid_key', async () => {
  assert.deepEqual(
    await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub({ [TENANT_CONTEXT_URL]: { status: 401, body: 'unauthorized' } })),
    { valid: false, reason: 'invalid_key' },
  )
  assert.deepEqual(
    await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub({ [TENANT_CONTEXT_URL]: { status: 403, body: 'forbidden' } })),
    { valid: false, reason: 'invalid_key' },
  )
  assert.deepEqual(
    await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub({ [TENANT_CONTEXT_URL]: { status: 200, body: { data: { tenantId: 'another-tenant' } } } })),
    { valid: false, reason: 'tenant_mismatch' },
  )
  assert.deepEqual(
    await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub(tenantOkPlan({ status: 200, body: { data: [] } }))),
    { valid: false, reason: 'invalid_key' },
  )
  // 有效路径：租户匹配且目录非空。
  assert.deepEqual(
    await runRoute(handleDofeValidateRequest, '/api/desktop/dofe/validate', gatewayStub(tenantOkPlan())),
    { valid: true },
  )
})

test('R1：models 路由同样的失败原因映射', async () => {
  assert.deepEqual(
    await runRoute(handleDofeModelsRequest, '/api/desktop/dofe/models', gatewayStub({ [TENANT_CONTEXT_URL]: 'timeout' })),
    { models: [], reason: 'network_unavailable' },
  )
  assert.deepEqual(
    await runRoute(handleDofeModelsRequest, '/api/desktop/dofe/models', gatewayStub(tenantOkPlan({ status: 500, body: 'internal' }))),
    { models: [], reason: 'network_unavailable' },
  )
  assert.deepEqual(
    await runRoute(handleDofeModelsRequest, '/api/desktop/dofe/models', gatewayStub(tenantOkPlan({ status: 403, body: 'forbidden' }))),
    { models: [], reason: 'invalid_key' },
  )
  assert.deepEqual(
    await runRoute(handleDofeModelsRequest, '/api/desktop/dofe/models', gatewayStub(tenantOkPlan({ status: 200, body: { data: [{ id: 'gateway-new' }, { id: 'deepseek-v4-flash' }] } }))),
    { models: [{ id: 'gateway-new', name: 'gateway-new' }, { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }] },
  )
})

/** 录制 mutate 调用的 ConfigForm 测试替身（结构化满足 ConfigForm 面）；result 为 'reject' 时模拟传输失败。 */
function recordingForm<T>(
  value: T | undefined, result: boolean | 'reject', events: string[], label: string,
): ConfigForm<T> & { calls: SettingsPathOpView[][] } {
  const calls: SettingsPathOpView[][] = []
  return {
    calls,
    getSnapshot: () => ({ status: value === undefined ? 'unavailable' : 'ready', value, base: undefined, user: undefined, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async (ops) => {
      calls.push([...ops])
      events.push(label)
      if (result === 'reject') throw new Error('settings transport failed')
      return result
    },
    set: async () => result === 'reject' ? false : result,
    unset: async () => result === 'reject' ? false : result,
  }
}

/** 记录写入事件顺序的凭证 seam 测试替身。 */
function fakeCredentials(events: string[]): CredentialsFace {
  return {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => { events.push('credential'); return { ok: true } },
    unset: async () => { events.push('unset'); return { ok: true } },
  }
}

/** 组装 AccessForms：access 与 defaultModel 用可提交替身。 */
function formsWithModels(models: ConfigForm<ProviderModelsSection> | undefined, events: string[]): AccessForms {
  return {
    access: recordingForm<AccessSettings>(undefined, true, events, 'access'),
    defaultModel: recordingForm<{ provider: string; model: string }>(undefined, true, events, 'default-model'),
    models,
  }
}

test('R3：saveActivation 写入顺序 凭证→目录→默认模型→授权，目录写失败不阻断，写入值为并集', async () => {
  const events: string[] = []
  const models = recordingForm<ProviderModelsSection>(
    { providers: { yootun: { models: [{ id: 'built-in-a' }, { id: 'built-in-b' }] } } }, false, events, 'catalog',
  )
  const outcome = await saveActivation(
    formsWithModels(models, events), fakeCredentials(events), 'sk-key', 'built-in-a',
    [{ id: 'gateway-new', name: 'gateway-new' }, { id: 'built-in-b', name: 'built-in-b' }, { id: 'gateway-next', name: 'gateway-next' }],
  )
  assert.deepEqual(events, ['credential', 'catalog', 'default-model', 'access'])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.catalogSynced, false)
  // 并集：分区现有模型一个不少在前，目录新模型追加在后，按 id 去重。
  const expectedMerged = [{ id: 'built-in-a' }, { id: 'built-in-b' }, { id: 'gateway-new' }, { id: 'gateway-next' }]
  assert.deepEqual(outcome.catalog, expectedMerged)
  const write = models.calls[0]?.[0]
  assert.equal(write?.op, 'set')
  assert.deepEqual(write?.path, ['providers', 'yootun', 'models'])
  assert.deepEqual(write?.value, expectedMerged)
})

test('R3：目录写入成功时 catalogSynced 为 true', async () => {
  const events: string[] = []
  const models = recordingForm<ProviderModelsSection>({ providers: { yootun: { models: [] } } }, true, events, 'catalog')
  const outcome = await saveActivation(
    formsWithModels(models, events), fakeCredentials(events), 'sk-key', 'gateway-new', [{ id: 'gateway-new', name: 'gateway-new' }],
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.catalogSynced, true)
  assert.deepEqual(outcome.catalog, [{ id: 'gateway-new' }])
})

test('R3：分区缺省时跳过目录写入；传输 rejection 同样跳过不阻断', async () => {
  const unservedEvents: string[] = []
  const unserved = await saveActivation(
    formsWithModels(undefined, unservedEvents), fakeCredentials(unservedEvents), 'sk-key', 'built-in-a', [{ id: 'gateway-new', name: 'gateway-new' }],
  )
  assert.equal(unserved.catalogSynced, false)
  assert.equal(unserved.ok, true)
  assert.deepEqual(unservedEvents, ['credential', 'default-model', 'access'])

  const rejectingEvents: string[] = []
  const rejecting = await saveActivation(
    formsWithModels(
      recordingForm<ProviderModelsSection>({ providers: { yootun: { models: [{ id: 'built-in-a' }] } } }, 'reject', rejectingEvents, 'catalog'), rejectingEvents,
    ),
    fakeCredentials(rejectingEvents), 'sk-key', 'built-in-a', [{ id: 'gateway-new', name: 'gateway-new' }],
  )
  assert.equal(rejecting.catalogSynced, false)
  assert.equal(rejecting.ok, true, '列表可读且已声明所选模型时，写入 rejection 只跳过目录步，不阻断')
  assert.deepEqual(rejectingEvents, ['credential', 'catalog', 'default-model', 'access'])
})

test('R3：existingProviderModels 分区未就绪、路径缺失时为空', () => {
  const ready = recordingForm<ProviderModelsSection>({ providers: { yootun: { models: [{ id: 'a' }, { id: 'b' }] } } }, true, [], 'x')
  assert.deepEqual(existingProviderModels(formsWithModels(ready, [])), [{ id: 'a' }, { id: 'b' }])
  assert.deepEqual(existingProviderModels(formsWithModels(recordingForm<ProviderModelsSection>(undefined, true, [], 'x'), [])), [])
  assert.deepEqual(existingProviderModels(formsWithModels(recordingForm<ProviderModelsSection>({ providers: {} }, true, [], 'x'), [])), [])
  assert.deepEqual(existingProviderModels(formsWithModels(undefined, [])), [])
})

test('R4：目录未同步且所选模型不在内置列表 → 中止激活，不写默认模型与授权', async () => {
  const events: string[] = []
  const models = recordingForm<ProviderModelsSection>(
    { providers: { yootun: { models: [{ id: 'built-in-a' }] } } }, false, events, 'catalog',
  )
  const outcome = await saveActivation(
    formsWithModels(models, events), fakeCredentials(events), 'sk-key', 'gateway-new', [{ id: 'gateway-new', name: 'gateway-new' }],
  )
  assert.deepEqual(events, ['credential', 'catalog'], '目录写失败且模型未声明时，默认模型与授权不得写入')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.catalogSynced, false)
})

test('R4：路由失败原因映射词典键，network_unavailable 得独立文案', () => {
  assert.equal(accessFailureKey('network_unavailable', 'modelError'), 'networkUnavailable')
  assert.equal(accessFailureKey('tenant_mismatch', 'modelError'), 'tenantMismatch')
  assert.equal(accessFailureKey('tenant_unavailable', 'invalid'), 'tenantUnavailable')
  assert.equal(accessFailureKey('invalid_key', 'modelError'), 'modelError')
  assert.equal(accessFailureKey('invalid_key', 'invalid'), 'invalid')
  assert.equal(accessFailureKey(undefined, 'modelError'), 'modelError')
  assert.equal(providerDeclaresModel('built-in-a', [{ id: 'built-in-a' }]), true)
  assert.equal(providerDeclaresModel('gateway-new', [{ id: 'built-in-a' }]), false)
})

test('R4：新增三条文案 zh / en 成对且措辞与契约一致', () => {
  assert.equal(zh.networkUnavailable, '暂时无法连接模型服务，请检查网络后重试')
  assert.equal(zh.catalogSyncFailed, '模型目录未能同步，当前使用内置目录')
  assert.equal(zh.modelNotAvailable, '该模型当前不可用，请选择其他模型')
  assert.ok(en.networkUnavailable.length > 0)
  assert.ok(en.catalogSyncFailed.length > 0)
  assert.ok(en.modelNotAvailable.length > 0)
})
