/**
 * 生命周期测试（node --test）：任务注册表 settle、dispose 顺序（拒绝新请求 →
 * abort 全部信号 → 等待 settle → 清理）、apply 登记 route 并在 dispose 释放、
 * 无 timer/controller 泄漏。运行：`node --test tests/dispose.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config, apply, buildRouteHandlers, registerSignal } from '../src/index.ts'
import { createTaskRegistry, disposeHostTasks } from '../src/lifecycle.ts'
import { createFakeContext, createFakeWorkbench, tempRoot, testDeps } from './fakes.ts'

test('插件 Config：stateDir 缺省空串、maxPages 缺省 1000、batchConcurrency 缺省 3、生命周期预算缺省 20000/8000/60000', () => {
  assert.deepEqual(Config({}), { stateDir: '', maxPages: 1000, batchConcurrency: 3, disposeBudgetMs: 20000, browserCloseTimeoutMs: 8000, launchTimeoutMs: 60000 })
})

test('taskRegistry：track 登记、settle 自动移除、rejection 旁路不炸 dispose', async () => {
  const registry = createTaskRegistry()
  const gate = Promise.withResolvers<void>()
  registry.track(gate.promise)
  assert.equal(registry.activeCount, 1)
  gate.resolve()
  await registry.awaitSettled()
  assert.equal(registry.activeCount, 0)
  registry.track(Promise.reject(new Error('side task failed')))
  await registry.awaitSettled()
  assert.equal(registry.activeCount, 0)
})

test('disposeHostTasks：置位 → abort 全部信号 → 等 settle → 清理信号表', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const controller = registerSignal(deps, 'task-1')
    let settled = false
    const task = new Promise<void>(resolve => { controller.signal.addEventListener('abort', () => { settled = true; resolve() }) })
    deps.taskRegistry.track(task)
    assert.equal(deps.disposing, false)
    const dispose = disposeHostTasks({ deps })
    await dispose
    assert.equal(deps.disposing, true, 'dispose 后 handler 以 plugin_disposing 拒绝新 action')
    assert.equal(settled, true, 'abort 在 settle 等待前发生')
    assert.equal(deps.signals.size, 0, '信号表已清空')
    assert.equal(deps.taskRegistry.activeCount, 0, '任务全部 settle')
    // 置位后 handler 拒绝新 action。
    await assert.rejects(() => buildRouteHandlers(deps)['browser.status']({}), /plugin is disposing/)
  } finally {
    await cleanup()
  }
})

test('apply：登记 route，dispose 逆序释放且无残留', async () => {
  const { ctx, dispose } = createFakeContext()
  const { root, cleanup } = await tempRoot()
  try {
    apply(ctx, { stateDir: root })
    assert.equal(ctx.registrations.length, 1)
    assert.equal(ctx.registrations[0]?.path, '/api/desktop/yootun/douyin-workbench')
    await dispose()
    assert.equal(ctx.registrations.length, 0, 'route 已释放')
  } finally {
    await cleanup()
  }
})

test('dispose 后无泄漏：重复 dispose 幂等、信号表与注册表归零', async () => {
  const { ctx, dispose } = createFakeContext()
  const { root, cleanup } = await tempRoot()
  try {
    apply(ctx, { stateDir: root })
    await dispose()
    await dispose()
    assert.equal(ctx.registrations.length, 0)
    assert.equal(ctx.registrations.length, 0, '二次 dispose 无副作用')
  } finally {
    await cleanup()
  }
})

test('registerSignal 复用（真实 deps）', async () => {
  const { deps, cleanup } = await testDeps()
  try {
    const first = registerSignal(deps, 'acct-a')
    const second = registerSignal(deps, 'acct-a')
    assert.equal(first, second)
    assert.equal(deps.signals.size, 1)
    registerSignal(deps, 'acct-b')
    assert.equal(deps.signals.size, 2)
  } finally {
    await cleanup()
  }
})
