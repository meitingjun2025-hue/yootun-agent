/**
 * D8 爆款基因库行为测试（node --test）：5 个 action 成功/稳定错误路径、工具名
 * 对账、update/regenerate 幂等键透传与绑定 recordId、写失败不自动重试、
 * IDEMPOTENCY_OUTCOME_UNKNOWN 不换键。运行：`node --test tests/d8.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTION_TOOL_MAP, buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import { routeAction } from './route-actions.ts'

async function d8Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  handlers: Record<string, import('../src/route.ts').ActionHandler>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({ root, workbenchFace: fake.face, logger: { warn: () => undefined } })
  return { handlers: buildRouteHandlers(deps), calls: fake.calls, cleanup }
}

const uuid = 'c'.repeat(32)

test('工具名与 ACTION_TOOL_MAP 精确一致（D8 5 action）', () => {
  const d8Actions: [string, string][] = [
    ['gene.search', 'workbench_viral_knowledge_search'],
    ['gene.get', 'workbench_viral_knowledge_get'],
    ['gene.update', 'workbench_viral_knowledge_update'],
    ['gene.regenerate', 'workbench_viral_knowledge_regenerate'],
    ['gene.list', 'workbench_viral_knowledge_list'],
  ]
  for (const [action, tool] of d8Actions) {
    const binding = ACTION_TOOL_MAP[action]
    assert.equal(binding?.kind, 'remote', `${action} 是远端绑定`)
    if (binding?.kind === 'remote') {
      assert.equal(binding.domain, 'viral', `${action} 属 viral 分组`)
      assert.ok(binding.tools.includes(tool), `${action} 绑定 ${tool}`)
    }
  }
})

test('search：筛选白名单透传（query/category/geneTags/adoptionStatus/offset/limit），不自造字段', async () => {
  const { handlers, calls, cleanup } = await d8Deps({
    outcomes: [{ structuredContent: { results: [], total: 0, hasMore: false } }, { structuredContent: { results: [], total: 0, hasMore: false } }],
  })
  try {
    await routeAction(handlers, 'gene.search')({ query: '钩子', category: '汽车', geneTags: { hook: ['提问'] }, adoptionStatus: 'adopted', offset: 20, limit: 50 })
    assert.deepEqual(calls[0]?.args, { query: '钩子', category: '汽车', geneTags: { hook: ['提问'] }, adoptionStatus: 'adopted', offset: 20, limit: 50 })
    await routeAction(handlers, 'gene.search')({})
    assert.deepEqual(calls[1]?.args, {}, '缺省零参数')
  } finally {
    await cleanup()
  }
})

test('search：VALIDATION_ERROR 稳定错误路径', async () => {
  const { handlers, cleanup } = await d8Deps({ outcomes: [{ throwCode: 'VALIDATION_ERROR' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'gene.search')({ query: 'x' }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'VALIDATION_ERROR'
    })
  } finally {
    await cleanup()
  }
})

test('get：recordId 透传；KNOWLEDGE_NOT_FOUND 原样投影', async () => {
  const { handlers, calls, cleanup } = await d8Deps({
    outcomes: [{ structuredContent: { record: { recordId: 'g1', geneStatus: 'succeeded' } } }],
  })
  try {
    const payload = await routeAction(handlers, 'gene.get')({ recordId: 'g1' })
    assert.deepEqual(payload.data, { record: { recordId: 'g1', geneStatus: 'succeeded' } })
    assert.deepEqual(calls[0]?.args, { recordId: 'g1' })
  } finally {
    await cleanup()
  }
  const missing = await d8Deps({ outcomes: [{ throwCode: 'KNOWLEDGE_NOT_FOUND' }] })
  try {
    await assert.rejects(() => routeAction(missing.handlers, 'gene.get')({ recordId: 'nope' }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'KNOWLEDGE_NOT_FOUND'
    })
  } finally {
    await missing.cleanup()
  }
})

test('update：幂等键绑定 recordId 透传；geneTags 空对象 = 清空语义保留', async () => {
  const { handlers, calls, cleanup } = await d8Deps({
    outcomes: [{ structuredContent: { recordId: 'g1', editedBy: 'system' } }, { structuredContent: { recordId: 'g1' } }],
  })
  try {
    const key = `douyin:vv_gene_upd:g1:${uuid}`
    await routeAction(handlers, 'gene.update')({ recordId: 'g1', idempotencyKey: key, geneTags: { hook: ['反转'] }, manualNotes: '备注', adoptionStatus: 'revised' })
    assert.deepEqual(calls[0]?.args, {
      recordId: 'g1', idempotencyKey: key, geneTags: { hook: ['反转'] }, manualNotes: '备注', adoptionStatus: 'revised',
    })
    await routeAction(handlers, 'gene.update')({ recordId: 'g1', idempotencyKey: key, geneTags: {} })
    assert.deepEqual(calls[1]?.args, { recordId: 'g1', idempotencyKey: key, geneTags: {} }, '空对象整体清空不被剔除')
  } finally {
    await cleanup()
  }
})

test('update：GENE_NOT_READY 稳定错误路径且不自动重试', async () => {
  const { handlers, calls, cleanup } = await d8Deps({ outcomes: [{ throwCode: 'GENE_NOT_READY' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'gene.update')({ recordId: 'g1', idempotencyKey: `douyin:vv_gene_upd:g1:${uuid}`, manualNotes: 'n' }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'GENE_NOT_READY'
    })
    assert.equal(calls.length, 1, '同步幂等写失败不自动重发')
  } finally {
    await cleanup()
  }
})

test('update：IDEMPOTENCY_OUTCOME_UNKNOWN 原样投影，Host 不换新键重发', async () => {
  const { handlers, calls, cleanup } = await d8Deps({ outcomes: [{ throwCode: 'IDEMPOTENCY_OUTCOME_UNKNOWN' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'gene.update')({ recordId: 'g1', idempotencyKey: `douyin:vv_gene_upd:g1:${uuid}`, manualNotes: 'n' }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'IDEMPOTENCY_OUTCOME_UNKNOWN'
    })
    assert.equal(calls.length, 1, '结果未知只允许同键重试（由用户触发），Host 不自动换键')
  } finally {
    await cleanup()
  }
})

test('regenerate：幂等键绑定 recordId 透传；成功受理投影', async () => {
  const { handlers, calls, cleanup } = await d8Deps({
    outcomes: [{ structuredContent: { recordId: 'g1', geneStatus: 'pending', geneAttemptCount: 2 } }],
  })
  try {
    const payload = await routeAction(handlers, 'gene.regenerate')({ recordId: 'g1', idempotencyKey: `douyin:vv_gene_reg:g1:${uuid}` })
    assert.deepEqual(payload.data, { recordId: 'g1', geneStatus: 'pending', geneAttemptCount: 2 })
    assert.deepEqual(calls[0]?.args, { recordId: 'g1', idempotencyKey: `douyin:vv_gene_reg:g1:${uuid}` })
  } finally {
    await cleanup()
  }
})

test('regenerate：GENE_EXTRACT_RUNNING 拒绝原样投影（零副作用受理拒绝不重发）', async () => {
  const { handlers, calls, cleanup } = await d8Deps({ outcomes: [{ throwCode: 'GENE_EXTRACT_RUNNING' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'gene.regenerate')({ recordId: 'g1', idempotencyKey: `douyin:vv_gene_reg:g1:${uuid}` }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'GENE_EXTRACT_RUNNING'
    })
    assert.equal(calls.length, 1)
  } finally {
    await cleanup()
  }
})

test('list：geneStatus/offset/limit 白名单透传；data 投影', async () => {
  const { handlers, calls, cleanup } = await d8Deps({
    outcomes: [{ structuredContent: { items: [], total: 0 } }, { structuredContent: { items: [], total: 0 } }],
  })
  try {
    const payload = await routeAction(handlers, 'gene.list')({ geneStatus: 'failed', limit: 100 })
    assert.deepEqual(payload.data, { items: [], total: 0 })
    assert.deepEqual(calls[0]?.args, { geneStatus: 'failed', limit: 100 })
    await routeAction(handlers, 'gene.list')({ offset: 40 })
    assert.deepEqual(calls[1]?.args, { offset: 40 })
  } finally {
    await cleanup()
  }
})
