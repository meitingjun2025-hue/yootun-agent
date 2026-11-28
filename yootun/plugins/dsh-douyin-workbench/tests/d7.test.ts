/**
 * D7 爆款素材看板行为测试（node --test）：8 个 action 成功/稳定错误路径、
 * seed upsert 逐项参数、videos 固定 scope='material' 与默认 limit/sortBy、
 * facets 窄投影、collect 异步状态投影、写失败不自动重试。运行：
 * `node --test tests/d7.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTION_TOOL_MAP, buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'
import { routeAction } from './route-actions.ts'

async function d7Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  handlers: Record<string, import('../src/route.ts').ActionHandler>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({ root, workbenchFace: fake.face, logger: { warn: () => undefined } })
  return { handlers: buildRouteHandlers(deps), calls: fake.calls, cleanup }
}

const uuid = 'b'.repeat(32)

test('工具名与 ACTION_TOOL_MAP 精确一致（D7 8 action）', () => {
  const d7Actions: [string, string][] = [
    ['material.seeds.list', 'workbench_viral_seeds_list'],
    ['material.keyword.upsert', 'workbench_viral_keyword_seeds_upsert'],
    ['material.account.upsert', 'workbench_viral_account_seeds_upsert'],
    ['material.collect.start', 'workbench_viral_seed_search_submit'],
    ['material.collect.status', 'workbench_viral_async_submit_get'],
    ['material.videos.list', 'workbench_viral_candidates_list'],
    ['material.runs.list', 'workbench_viral_runs_list'],
    ['material.facets', 'workbench_viral_dashboard_get'],
  ]
  for (const [action, tool] of d7Actions) {
    const binding = ACTION_TOOL_MAP[action]
    assert.equal(binding?.kind, 'remote', `${action} 是远端绑定`)
    if (binding?.kind === 'remote') {
      assert.equal(binding.domain, 'viral', `${action} 属 viral 分组`)
      assert.ok(binding.tools.includes(tool), `${action} 绑定 ${tool}`)
    }
  }
})

test('seeds.list：空参直通 data 投影', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { keywords: [], accounts: [], keywordByStatus: { active: 0 } } }],
  })
  try {
    const payload = await routeAction(handlers, 'material.seeds.list')({})
    assert.equal(payload.status, 'ready')
    assert.deepEqual(payload.data, { keywords: [], accounts: [], keywordByStatus: { active: 0 } })
    assert.deepEqual(calls[0]?.args, {})
  } finally {
    await cleanup()
  }
})

test('keyword.upsert：逐项参数原样透传（keyword/priority/status/searchCount）', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { seedType: 'keywords', inputRows: 2 } }],
  })
  try {
    const payload = await routeAction(handlers, 'material.keyword.upsert')({
      keywords: [
        { keyword: '增程车对比', priority: 'P1', status: 'active', searchCount: 20 },
        { keyword: '纯电续航' },
      ],
      confirm: true,
      idempotencyKey: `douyin:vv_keyword_upsert:${uuid}`,
    })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(calls[0]?.args, {
      keywords: [
        { keyword: '增程车对比', priority: 'P1', status: 'active', searchCount: 20 },
        { keyword: '纯电续航' },
      ],
      confirm: true,
      idempotencyKey: `douyin:vv_keyword_upsert:${uuid}`,
    })
  } finally {
    await cleanup()
  }
})

test('account.upsert：逐项参数原样透传（inputForm/inputValue/maxVideos/displayName）', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { seedType: 'accounts', inputRows: 1 } }],
  })
  try {
    await routeAction(handlers, 'material.account.upsert')({
      accounts: [{ inputForm: 'homepage_url', inputValue: 'https://www.douyin.com/user/abc', displayName: '对标号', priority: 'P2', status: 'active', maxVideos: 30 }],
      confirm: true,
      idempotencyKey: `douyin:vv_account_upsert:${uuid}`,
    })
    assert.deepEqual(calls[0]?.args, {
      accounts: [{ inputForm: 'homepage_url', inputValue: 'https://www.douyin.com/user/abc', displayName: '对标号', priority: 'P2', status: 'active', maxVideos: 30 }],
      confirm: true,
      idempotencyKey: `douyin:vv_account_upsert:${uuid}`,
    })
  } finally {
    await cleanup()
  }
})

test('seed upsert：VALIDATION_ERROR 稳定错误路径且不自动重试', async () => {
  for (const action of ['material.keyword.upsert', 'material.account.upsert'] as const) {
    const { handlers, calls, cleanup } = await d7Deps({ outcomes: [{ throwCode: 'VALIDATION_ERROR' }] })
    try {
      await assert.rejects(() => routeAction(handlers, action)({
        ...(action === 'material.keyword.upsert' ? { keywords: [{ keyword: 'k' }] } : { accounts: [{ inputForm: 'douyin_id', inputValue: 'id1' }] }),
        confirm: true,
        idempotencyKey: `douyin:vv_${action === 'material.keyword.upsert' ? 'keyword' : 'account'}_upsert:${uuid}`,
      }), (error: unknown) => (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'VALIDATION_ERROR')
      assert.equal(calls.length, 1, 'Host 不自动重试写操作')
    } finally {
      await cleanup()
    }
  }
})

test('collect.start：可选参数白名单透传；VIRAL_VIDEO_ACTIVE_RUN_EXISTS 原样投影不重发', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { runId: 'run-7', status: 'queued', nextAction: 'poll_status' } }],
  })
  try {
    const payload = await routeAction(handlers, 'material.collect.start')({ idempotencyKey: `douyin:vv_seed_search:${uuid}`, keywordLimit: 10, priorities: ['P1'] })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(calls[0]?.args, { idempotencyKey: `douyin:vv_seed_search:${uuid}`, keywordLimit: 10, priorities: ['P1'] })
  } finally {
    await cleanup()
  }
  const conflict = await d7Deps({ outcomes: [{ throwCode: 'VIRAL_VIDEO_ACTIVE_RUN_EXISTS' }] })
  try {
    await assert.rejects(() => routeAction(conflict.handlers, 'material.collect.start')({ idempotencyKey: `douyin:vv_seed_search:${uuid}` }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'VIRAL_VIDEO_ACTIVE_RUN_EXISTS'
    })
    assert.equal(conflict.calls.length, 1, '已有 run 未终态时不自动重发')
  } finally {
    await conflict.cleanup()
  }
})

test('collect.status：runId 透传；runStatus 各态原样投影（data 信封）', async () => {
  for (const runStatus of ['queued', 'running', 'completed', 'partial_failed', 'failed', 'cancelled']) {
    const { handlers, calls, cleanup } = await d7Deps({
      outcomes: [{ structuredContent: { runId: 'run-3', runStatus, nextAction: runStatus === 'running' ? 'poll_status' : 'done' } }],
    })
    try {
      const payload = await routeAction(handlers, 'material.collect.status')({ runId: 'run-3' })
      assert.equal((payload.data as { runStatus: string }).runStatus, runStatus)
      assert.deepEqual(calls[0]?.args, { runId: 'run-3' })
    } finally {
      await cleanup()
    }
  }
})

test('videos.list：scope 恒为 material；sortBy 缺省 hot、limit 缺省 200、offset 可选', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { candidates: [], total: 0 } }, { structuredContent: { candidates: [], total: 0 } }, { structuredContent: { candidates: [], total: 0 } }],
  })
  try {
    await routeAction(handlers, 'material.videos.list')({})
    assert.deepEqual(calls[0]?.args, { scope: 'material', sortBy: 'hot', limit: 200 }, '缺省固定素材域语义')
    await routeAction(handlers, 'material.videos.list')({ sortBy: 'play_count', limit: 50, offset: 40, minLevel: 'S', q: '车', sourceKind: 'keyword', tag: 't', publishedFrom: '2026-11-01', publishedTo: '2026-11-20' })
    assert.deepEqual(calls[1]?.args, {
      scope: 'material', sortBy: 'play_count', limit: 50, offset: 40,
      minLevel: 'S', q: '车', sourceKind: 'keyword', tag: 't', publishedFrom: '2026-11-01', publishedTo: '2026-11-20',
    }, '筛选白名单逐项透传，不自造字段')
    await routeAction(handlers, 'material.videos.list')({ scope: 'material' })
    assert.deepEqual(calls[2]?.args, { scope: 'material', sortBy: 'hot', limit: 200 }, '显式 scope 同样固定 material')
  } finally {
    await cleanup()
  }
})

test('videos.list：INVALID_SORT 稳定错误路径', async () => {
  const { handlers, cleanup } = await d7Deps({ outcomes: [{ throwCode: 'INVALID_SORT' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'material.videos.list')({ sortBy: 'hot' }), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'INVALID_SORT'
    })
  } finally {
    await cleanup()
  }
})

test('runs.list：limit 缺省 20、offset 可选；data 投影', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{ structuredContent: { runs: [], total: 0 } }, { structuredContent: { runs: [], total: 0 } }],
  })
  try {
    const payload = await routeAction(handlers, 'material.runs.list')({})
    assert.deepEqual(payload.data, { runs: [], total: 0 })
    assert.deepEqual(calls[0]?.args, { limit: 20 })
    await routeAction(handlers, 'material.runs.list')({ limit: 5, offset: 10 })
    assert.deepEqual(calls[1]?.args, { limit: 5, offset: 10 })
  } finally {
    await cleanup()
  }
})

test('facets：dashboard_get 的 materialFacets.tags 窄投影（其余字段不透出）', async () => {
  const { handlers, calls, cleanup } = await d7Deps({
    outcomes: [{
      structuredContent: {
        summary: { total: 99 },
        materialFacets: { tags: [{ tag: '对标', count: 3 }, { tag: '口播', count: 1 }] },
        otherFacets: { hidden: true },
      },
    }, { structuredContent: {} }],
  })
  try {
    const payload = await routeAction(handlers, 'material.facets')({})
    assert.equal(payload.status, 'ready')
    assert.deepEqual(payload.tags, [{ tag: '对标', count: 3 }, { tag: '口播', count: 1 }])
    assert.ok(!('summary' in payload) && !('materialFacets' in payload), '窄投影只透出 tags')
    assert.deepEqual(calls[0]?.args, {})
    const empty = await routeAction(handlers, 'material.facets')({})
    assert.deepEqual(empty.tags, [], '缺失投影回退空 tags')
  } finally {
    await cleanup()
  }
})

test('facets：PROVIDER_ERROR 稳定错误路径', async () => {
  const { handlers, cleanup } = await d7Deps({ outcomes: [{ throwCode: 'PROVIDER_ERROR' }] })
  try {
    await assert.rejects(() => routeAction(handlers, 'material.facets')({}), (error: unknown) => {
      return (error as { payload?: { error?: { code?: string } } }).payload?.error?.code === 'PROVIDER_ERROR'
    })
  } finally {
    await cleanup()
  }
})
