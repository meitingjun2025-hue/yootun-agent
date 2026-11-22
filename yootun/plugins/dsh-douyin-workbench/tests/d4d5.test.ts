/**
 * D4/D5 行为测试（node --test）：AI 分析受理与轮询投影、报表三 action、负责人
 * 与投流写入（recordId 条件携带、stale-add 错误原样投影）。
 * 运行：`node --test tests/d4d5.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRouteHandlers, createDouyinHostDeps } from '../src/index.ts'
import { createFakeWorkbench, tempRoot, type FakeWorkbenchCall } from './fakes.ts'

async function d45Deps(script: { outcomes?: Array<{ structuredContent?: unknown; throwCode?: string }> } = {}): Promise<{
  handlers: Record<string, import('../src/route.ts').ActionHandler>
  calls: FakeWorkbenchCall[]
  cleanup: () => Promise<void>
}> {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench(script)
  const deps = createDouyinHostDeps({ root, workbenchFace: fake.face, logger: { warn: () => undefined } })
  return { handlers: buildRouteHandlers(deps), calls: fake.calls, cleanup }
}

const uuid = 'a'.repeat(32)

test('aiAnalysis.start：受理透传（窗口/模型由服务端定，Host 不传额外参数）', async () => {
  const { handlers, calls, cleanup } = await d45Deps({ outcomes: [{ structuredContent: { status: 'running' } }] })
  try {
    const payload = await handlers['aiAnalysis.start']({ accountId: 'a', idempotencyKey: `douyin:ai_analysis:${uuid}` })
    assert.equal(payload.status, 'ready')
    assert.equal(calls[0]?.name, 'workbench_douyin_account_ai_analysis_start')
    assert.deepEqual(calls[0]?.args, { accountId: 'a', idempotencyKey: `douyin:ai_analysis:${uuid}` })
  } finally {
    await cleanup()
  }
})

test('aiAnalysis.get：展平单层投影（aiStatus 运行态 / analysis 可为 null）', async () => {
  const { handlers, cleanup } = await d45Deps({ outcomes: [{ structuredContent: { status: 'succeeded', analysis: { summary: 'ok' } } }] })
  try {
    const payload = await handlers['aiAnalysis.get']({ accountId: 'a' })
    assert.equal(payload.aiStatus, 'succeeded')
    assert.deepEqual(payload.analysis, { summary: 'ok' })
  } finally {
    await cleanup()
  }
  const never = await d45Deps({ outcomes: [{ structuredContent: { status: 'not_analyzed' } }] })
  try {
    const payload = await never.handlers['aiAnalysis.get']({ accountId: 'a' })
    assert.equal(payload.aiStatus, 'not_analyzed')
    assert.equal(payload.analysis, null)
  } finally {
    await never.cleanup()
  }
})

test('report.list：只带已定义参数；report.get/regenerate 直通', async () => {
  const { handlers, calls, cleanup } = await d45Deps({ outcomes: [{ structuredContent: { reports: [], nextCursor: null } }, { structuredContent: { report: {} } }, { structuredContent: { report: {} } }] })
  try {
    await handlers['report.list']({ reportType: 'daily', allVersions: true })
    assert.deepEqual(calls[0]?.args, { reportType: 'daily', allVersions: true })
    await handlers['report.get']({ reportId: 'r1' })
    assert.deepEqual(calls[1]?.args, { reportId: 'r1' })
    await handlers['report.regenerate']({ reportId: 'r1', idempotencyKey: `douyin:report_regenerate:r1:${uuid}` })
    assert.deepEqual(calls[2]?.args, { reportId: 'r1', idempotencyKey: `douyin:report_regenerate:r1:${uuid}` })
  } finally {
    await cleanup()
  }
})

test('account.owner.set：全量透传（trim/超长由 route 层拒）', async () => {
  const { handlers, calls, cleanup } = await d45Deps({ outcomes: [{ structuredContent: { ownerName: '张三' } }] })
  try {
    const payload = await handlers['account.owner.set']({ accountId: 'a', ownerName: '张三', idempotencyKey: `douyin:account_owner_set:${uuid}` })
    assert.equal(payload.status, 'ready')
    assert.deepEqual(calls[0]?.args, { accountId: 'a', ownerName: '张三', idempotencyKey: `douyin:account_owner_set:${uuid}` })
  } finally {
    await cleanup()
  }
})

test('work.promotion.save：定点串/整数原样、recordId 仅显式携带', async () => {
  const { handlers, calls, cleanup } = await d45Deps({ outcomes: [{ structuredContent: { id: 9 } }, { structuredContent: { id: 9 } }] })
  try {
    await handlers['work.promotion.save']({ accountId: 'a', workId: 'w1', playCount: 100, fansCount: 3, costAmount: '12.50', durationHours: '2.00', idempotencyKey: `douyin:work_promotion_save:${uuid}` })
    const first = calls[0]?.args as Record<string, unknown>
    assert.equal(first.costAmount, '12.50')
    assert.equal(first.durationHours, '2.00')
    assert.equal(first.playCount, 100)
    assert.ok(!('recordId' in first), 'recordId 缺省不携带')
    await handlers['work.promotion.save']({ accountId: 'a', workId: 'w1', playCount: 1, fansCount: 0, costAmount: '0', durationHours: '1', recordId: 9, idempotencyKey: `douyin:work_promotion_save:${uuid}` })
    assert.equal((calls[1]?.args as Record<string, unknown>).recordId, 9)
  } finally {
    await cleanup()
  }
})

test('work.promotion.save：PROMOTION_ALREADY_EXISTS 原样投影（不自动换键重发）', async () => {
  const { handlers, calls, cleanup } = await d45Deps({ outcomes: [{ throwCode: 'PROMOTION_ALREADY_EXISTS' }] })
  try {
    await assert.rejects(() => handlers['work.promotion.save']({ accountId: 'a', workId: 'w1', playCount: 1, fansCount: 0, costAmount: '0', durationHours: '1', idempotencyKey: `douyin:work_promotion_save:${uuid}` }), (error: unknown) => {
      const envelope = (error as { payload?: { error?: { code?: string } } }).payload?.error?.code
      return envelope === 'PROMOTION_ALREADY_EXISTS'
    })
    assert.equal(calls.length, 1, 'Host 不自动重发（stale-add 恢复由页面重拉转更新）')
  } finally {
    await cleanup()
  }
})
