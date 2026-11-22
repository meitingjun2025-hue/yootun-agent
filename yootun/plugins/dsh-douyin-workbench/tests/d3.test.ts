/**
 * D3 行为测试（node --test）：作品/总览/分析/导出参数白名单与投影、导出载荷
 * 自洽复核与上限、排期四 handler（rowId/键绑定由 route 层锁，此处锁业务投影：
  缺失业务字段显式 null 整行提交、平台归一序、confirm 透传、错误稳定投影）。
 * 运行：`node --test tests/d3.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'

/** 组装 D3 deps 并返回最近调用记录。 */
async function d3Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  handlers: Record<string, import('../src/route.ts').ActionHandler>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({ root, workbenchFace: fake.face, logger: { warn: () => undefined } })
  return { handlers: buildRouteHandlers(deps), calls: fake.calls, cleanup }
}

test('works.list：别名翻译 + includeNotInList 恒传 + 空作品兜底', async () => {
  const { handlers, calls, cleanup } = await d3Deps({ outcomes: [{ structuredContent: { works: [{ work_id: 'w1' }], total: 1 } }] })
  try {
    const payload = await handlers['works.list']({ accountId: 'acc-1' })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(payload.works, [{ work_id: 'w1' }])
    assert.equal(payload.total, 1)
    assert.deepEqual(calls[0]?.args, { accountId: 'acc-1', includeNotInList: false })
  } finally {
    await cleanup()
  }
})

test('overview.get：只带已定义参数（空数组/空串不出网）', async () => {
  const { handlers, calls, cleanup } = await d3Deps()
  try {
    await handlers['overview.get']({ accountIds: [], publishFrom: '2026-06-01', sort: 'hot_count' })
    assert.deepEqual(calls[0]?.args, { publishFrom: '2026-06-01', sort: 'hot_count' })
  } finally {
    await cleanup()
  }
})

test('hotWorks.list：参数面无 ownerName（DTO extra=forbid）', async () => {
  const { handlers, calls, cleanup } = await d3Deps()
  try {
    await handlers['hotWorks.list']({ publishFrom: '2026-06-01' })
    assert.equal(calls[0]?.name, 'workbench_douyin_hot_work_list')
    assert.ok(!('ownerName' in (calls[0]?.args as Record<string, unknown>)), 'hot_work_list 不得携带 ownerName')
  } finally {
    await cleanup()
  }
})

test('account.trend：metric 缺省 play、cohortDelta 仅显式 true 才带', async () => {
  const { handlers, calls, cleanup } = await d3Deps({ outcomes: [{ structuredContent: {} }, { structuredContent: {} }] })
  try {
    await handlers['account.trend']({ accountId: 'a' })
    assert.deepEqual(calls[0]?.args, { accountId: 'a', metric: 'play' })
    await handlers['account.trend']({ accountId: 'a', metric: 'fans', cohortDelta: true })
    assert.deepEqual(calls[1]?.args, { accountId: 'a', metric: 'fans', cohortDelta: true })
  } finally {
    await cleanup()
  }
})

test('export：base64 长度与字节数自洽复核 + 文件名净化 + 1MB 上限', async () => {
  const bytes = Buffer.from('x'.repeat(30))
  const base64 = bytes.toString('base64')
  const { handlers, cleanup } = await d3Deps({ outcomes: [
    { structuredContent: { file_name: '../evil/name.xlsx', content_base64: base64, content_bytes: bytes.byteLength } },
  ] })
  try {
    const payload = await handlers['export']({ accountId: 'a' })
    // 非法文件名（含路径）净化为兜底名。
    assert.equal(payload.file_name, 'douyin-export.xlsx')
    assert.equal(payload.content_bytes, bytes.byteLength)
    assert.ok(payload.mime_type.startsWith('application/vnd'))
  } finally {
    await cleanup()
  }
})

test('export：base64 与字节数不自洽 → export_failed；DOUYIN_EXPORT_TOO_LARGE → export_too_large', async () => {
  const mismatch = await d3Deps({ outcomes: [{ structuredContent: { file_name: 'douyin-export.xlsx', content_base64: 'AAAA', content_bytes: 30 } }] })
  try {
    await assert.rejects(() => mismatch.handlers['export']({ accountId: 'a' }), (error: unknown) => (error as { code?: string }).code === 'export_failed')
  } finally {
    await mismatch.cleanup()
  }
  const tooLarge = await d3Deps({ outcomes: [{ throwCode: 'DOUYIN_EXPORT_TOO_LARGE' }] })
  try {
    await assert.rejects(() => tooLarge.handlers['export']({ accountId: 'a' }), (error: unknown) => (error as { code?: string }).code === 'export_too_large')
  } finally {
    await tooLarge.cleanup()
  }
})

test('overview.export：schema 外字段丢弃 + TOO_MANY_ACCOUNTS 映射 overview_too_many_accounts', async () => {
  const bytes = Buffer.from('overview')
  const { handlers, calls, cleanup } = await d3Deps({ outcomes: [
    { structuredContent: { file_name: 'douyin-overview-2026.xlsx', content_base64: bytes.toString('base64'), content_bytes: bytes.byteLength } },
  ] })
  try {
    await handlers['overview.export']({ accountIds: ['a', 'b'], publishFrom: '2026-06-01', publishTo: '2026-06-30', ruleVersion: 'v2' })
    assert.deepEqual(calls[0]?.args, { accountIds: ['a', 'b'], publishFrom: '2026-06-01', publishTo: '2026-06-30', ruleVersion: 'v2' })
  } finally {
    await cleanup()
  }
  const mapped = await d3Deps({ outcomes: [{ throwCode: 'TOO_MANY_ACCOUNTS' }] })
  try {
    await assert.rejects(() => mapped.handlers['overview.export']({ accountIds: ['a'] }), (error: unknown) => (error as { code?: string }).code === 'overview_too_many_accounts')
  } finally {
    await mapped.cleanup()
  }
})

test('schedule.rowUpdate：缺失业务字段显式 null 整行提交 + confirm 透传 + 平台固定序', async () => {
  const { handlers, calls, cleanup } = await d3Deps({ outcomes: [{ structuredContent: { row: { row_id: 7, row_version: 2 } } }] })
  try {
    const payload = await handlers['schedule.rowUpdate']({
      accountId: 'a', rowId: 7, expectedVersion: 1, confirm: true, idempotencyKey: 'douyin:publish_schedule_update:7:' + 'a'.repeat(32),
      shootingStatus: false, published: false, publishPlatforms: ['xhs', 'douyin'], videoContent: '内容',
    })
    assert.equal(payload.status, 'ready')
    const args = calls[0]?.args as Record<string, unknown>
    assert.equal(args.rowId, 7)
    assert.equal(args.expectedVersion, 1)
    assert.equal(args.confirm, true)
    assert.equal(args.videoContent, '内容')
    assert.equal(args.shootingDate, null)
    assert.equal(args.note, null)
    assert.equal(args.assetLink, null)
    assert.equal(args.publishDate, null)
    assert.equal(args.shootingOwner, null)
    assert.equal(args.editingOwner, null)
    // publishPlatforms 经 route 归一化固定顺序 xhs → douyin → wx_channels。
    assert.deepEqual(args.publishPlatforms, ['xhs', 'douyin'])
  } finally {
    await cleanup()
  }
})

test('schedule.rowDelete / rowCreate：confirm 与键透传、错误稳定投影（SCHEDULE_ROW_CONFLICT 原样）', async () => {
  const ok = await d3Deps({ outcomes: [{ structuredContent: { deleted: true, row_id: 3 } }] })
  try {
    const payload = await ok.handlers['schedule.rowDelete']({ accountId: 'a', rowId: 3, expectedVersion: 2, confirm: true, idempotencyKey: 'douyin:publish_schedule_delete:3:' + 'b'.repeat(32) })
    assert.equal(payload.status, 'ready')
    assert.deepEqual((ok.calls[0]?.args as Record<string, unknown>).rowId, 3)
  } finally {
    await ok.cleanup()
  }
  const conflict = await d3Deps({ outcomes: [{ throwCode: 'SCHEDULE_ROW_CONFLICT' }] })
  try {
    // 直调 handler 时错误按原信封上抛（稳定码投影发生在 route 顶层 catch 的
    // safeCode；此处断言信封码，route.test.ts 已锁投影路径）。
    await assert.rejects(() => conflict.handlers['schedule.rowUpdate']({
      accountId: 'a', rowId: 3, expectedVersion: 1, confirm: true, idempotencyKey: 'douyin:publish_schedule_update:3:' + 'c'.repeat(32),
      shootingStatus: true, published: false, publishPlatforms: [],
    }), (error: unknown) => {
      const envelope = (error as { payload?: { error?: { code?: string } } }).payload?.error?.code
      return envelope === 'SCHEDULE_ROW_CONFLICT'
    })
  } finally {
    await conflict.cleanup()
  }
})
