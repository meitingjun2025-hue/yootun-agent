/**
 * G-2 启动恢复产品路径测试（node --test）：apply/createDouyinHostDeps 真实初始
 * 化链（不直测 recoverInterruptedRuns 函数本身）——启动即恢复、action 等待
 * 恢复、损坏拒绝、collect.status 的 interrupted/远端对账矩阵。
 * 运行：`node --test tests/recovery.test.ts`。
 */
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, buildRouteHandlers, createDouyinHostDeps, Config } from '../src/index.ts'
import { createFakeContext, createFakeWorkbench, tempRoot } from './fakes.ts'
import { readRuns, updateRun, runsFilePath } from '../src/runs.ts'

/** 等待异步条件成立（轮询；超时抛错）。 */
async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

test('apply 启动即调用恢复：running 记录真实变为 interrupted（route 注册不被阻塞）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await updateRun(root, 'acc-recover', 'attempt-r1', { status: 'running', runId: 'run-r1' })
    const host = createFakeContext()
    apply(host.ctx, Config({ stateDir: root }))
    // route 注册不被恢复阻塞（同步完成）。
    assert.equal(host.ctx.registrations.length, 1)
    await waitForAsync(async () => (await readRuns(root))['attempt-r1']?.status === 'interrupted', 2000, 'interrupted')
    assert.equal((await readRuns(root))['attempt-r1']?.status, 'interrupted')
    await host.dispose()
    // 恢复写盘与临时目录清理之间的竞态缓冲。
    await new Promise(resolve => setTimeout(resolve, 50))
  } finally {
    await cleanup()
  }
})

test('collect.status 在启动恢复完成前等待（recovery 期间不产生 collect.start 竞态）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const fake = createFakeWorkbench()
    const deps = createDouyinHostDeps({
      root,
      workbenchFace: fake.face,
      recovery: async () => { await gate; return 0 },
    })
    const handlers = buildRouteHandlers(deps)
    let settled = false
    const pending = handlers['collect.status']({ accountId: 'acc-wait' }).then(result => {
      settled = true
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(settled, false, '恢复未完成时 collect.status 不得返回')
    release?.()
    const result = await pending
    assert.equal(result.status, 'ready')
  } finally {
    await cleanup()
  }
})

test('恢复完成后：interrupted + 无 runId → recovery_required（不伪造 running）', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    await updateRun(root, 'acc-i1', 'attempt-i1', { status: 'interrupted', runId: null })
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face })
    const handlers = buildRouteHandlers(deps)
    await deps.startupReady
    const payload = await handlers['collect.status']({ accountId: 'acc-i1' })
    assert.equal(payload.recovery, 'recovery_required')
    assert.equal((payload.lastRun as Record<string, unknown>).status, 'interrupted')
  } finally {
    await cleanup()
  }
})

test('远端 run_get 返回终态 → 本地 runs.json 状态同步 + recovery_required', async () => {
  const { root, cleanup } = await tempRoot()
  const fake = createFakeWorkbench({ outcomes: [
    { structuredContent: { run: { run_id: 'run-t1', status: 'completed' } } },
  ] })
  try {
    await updateRun(root, 'acc-t1', 'attempt-t1', { status: 'interrupted', runId: 'run-t1' })
    const deps = createDouyinHostDeps({ root, workbenchFace: fake.face })
    const handlers = buildRouteHandlers(deps)
    await deps.startupReady
    const payload = await handlers['collect.status']({ accountId: 'acc-t1' })
    assert.equal(payload.recovery, 'recovery_required')
    assert.equal(payload.remoteStatus, 'completed')
    assert.equal((payload.lastRun as Record<string, unknown>).status, 'completed', '本地 runs.json 已同步远端终态')
    assert.equal((await readRuns(root))['attempt-t1']?.status, 'completed')
    // 再次查询：已终态，不再 recovery。
    const again = await handlers['collect.status']({ accountId: 'acc-t1' })
    assert.equal(again.recovery, undefined)
  } finally {
    await cleanup()
  }
})

test('远端 run_get 失败或仍 running → recovery_required（不伪造本地 running）', async () => {
  for (const [label, outcome] of [
    ['查询失败', { throwCode: 'workbench_network_error' }] as const,
    ['远端仍 running', { structuredContent: { run: { run_id: 'run-x', status: 'running' } } }] as const,
  ]) {
    const { root, cleanup } = await tempRoot()
    const fake = createFakeWorkbench({ outcomes: [outcome] })
    try {
      await updateRun(root, 'acc-x', 'attempt-x', { status: 'interrupted', runId: 'run-x' })
      const deps = createDouyinHostDeps({ root, workbenchFace: fake.face })
      const handlers = buildRouteHandlers(deps)
      await deps.startupReady
      const payload = await handlers['collect.status']({ accountId: 'acc-x' })
      assert.equal(payload.recovery, 'recovery_required', label)
      assert.equal((await readRuns(root))['attempt-x']?.status, 'interrupted', `${label}：本地不改写`)
    } finally {
      await cleanup()
    }
  }
})

test('runs.json 语义损坏 → 恢复失败，业务 action 一律 run_state_corrupt 且文件不被改写', async () => {
  const { root, cleanup } = await tempRoot()
  try {
    const corrupt = '{ not valid json'
    await writeFile(runsFilePath(root), corrupt)
    const deps = createDouyinHostDeps({ root, workbenchFace: createFakeWorkbench().face })
    const handlers = buildRouteHandlers(deps)
    await deps.startupReady
    assert.equal(deps.startupError, 'run_state_corrupt')
    await assert.rejects(() => handlers['accounts.list']({}), (error: unknown) => (error as { code?: string }).code === 'run_state_corrupt')
    await assert.rejects(() => handlers['collect.status']({ accountId: 'a' }), (error: unknown) => (error as { code?: string }).code === 'run_state_corrupt')
    // 损坏文件保持原样（不得被恢复/查询改写）。
    assert.equal(await readFile(join(root, 'runs.json'), 'utf8'), corrupt)
  } finally {
    await cleanup()
  }
})
