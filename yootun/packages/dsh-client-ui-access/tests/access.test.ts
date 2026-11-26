/**
 * yootun 接入层包内冒烟（node --test，不进官方 vitest scope）：路由目录解析、
 * 门禁判定的 fail-closed 语义、生成常量与 brand.json 的一致性。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-access test`（node ≥24 原生 type stripping）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parseModelCatalog } from '../src/route.ts'
import { blockApplicationScroll, isAuthorized } from '../src/client/logic.ts'
import { agentStatusPresentation, createAgentStatusPoller, parseAgentStatus, type AgentStatusPresentation, type AgentStatusView } from '../src/client/agent-status.ts'
import { en, zh } from '../src/client/locales.ts'
import { TENANT, TENANT_ID, VALIDATION_VERSION } from '../src/access-constants.ts'

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

test('isAuthorized 对每个缺失面 fail-closed，版本必须精确一致', () => {
  const authorized: Parameters<typeof isAuthorized>[0] = {
    setupComplete: true, validationVersion: Number(VALIDATION_VERSION), enabledPlugins: [], modelId: 'deepseek-v4-flash',
  }
  assert.equal(isAuthorized(authorized, true), true)
  assert.equal(isAuthorized(undefined, true), false)
  assert.equal(isAuthorized(authorized, false), false)
  assert.equal(isAuthorized({ ...authorized, setupComplete: false }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: Number(VALIDATION_VERSION) + 1 }, true), false)
  assert.equal(isAuthorized({ ...authorized, validationVersion: 0 }, true), false)
})

test('门禁滚动锁不申请 root.inert，避免与官方启动 overlay 的恢复快照竞态', () => {
  const root = { inert: false }
  const bodyStyle = { overflow: '' }
  const previousDocument = globalThis.document
  const fakeDocument = {
    getElementById: () => root,
    body: { style: bodyStyle },
  } as Document
  globalThis.document = fakeDocument

  try {
    const release = blockApplicationScroll()
    assert.equal(root.inert, false)
    assert.equal(bodyStyle.overflow, 'hidden')
    release()
    assert.equal(bodyStyle.overflow, '')
  } finally {
    globalThis.document = previousDocument
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
