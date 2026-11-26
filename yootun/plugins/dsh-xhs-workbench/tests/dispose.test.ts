/**
 * 生命周期测试：dispose 统一收口（拒绝新 action → abort 全部信号 → 等待任务
 * settle → 清理 controllers）。
 * 运行：`node --test tests/dispose.test.ts`。
 */
import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildRouteHandlers, createXhsHostDeps } from '../src/handlers.ts'
import { disposeHostTasks } from '../src/lifecycle.ts'
import { createFakeChrome, sessionCookie } from './fakes.ts'

async function tempRoot(): Promise<string> {
  const root = join(tmpdir(), `xhs-dispose-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  await mkdir(root, { recursive: true })
  return root
}

test('dispose：登录等待中 abort → run 落 login_aborted，新 action 稳定拒绝', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  const deps = createXhsHostDeps({
    root,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: fake.factory,
  })
  deps.loginTimeoutMs = 60_000
  const handlers = buildRouteHandlers(deps)
  const begin = await handlers['account.beginLogin']!({ accountId: 'acc-1' }) as Record<string, unknown>
  assert.equal(begin.status, 'ready')
  assert.equal(deps.taskRegistry.activeCount >= 1, true)
  await disposeHostTasks({ deps })
  assert.equal(deps.disposing, true)
  // dispose 后全部 action 稳定拒绝（不登记新任务）。
  const rejected = await handlers['browser.status']!({}) as Record<string, unknown>
  assert.equal(rejected.status, 'error')
  assert.equal(rejected.reason, 'plugin_disposing')
  assert.equal(deps.taskRegistry.activeCount, 0)
  // 登录 run 以 aborted 终态收敛（dispose 后 handler 被 guard 拦截，直接读 run 表）。
  const run = deps.loginRuns.get('acc-1')
  assert.equal(run?.status, 'failed')
  assert.equal(run?.error, 'login_aborted')
  // 信号表清空。
  assert.equal(deps.loginSignals.size, 0)
  await rm(root, { recursive: true, force: true })
})

test('dispose：采集运行中 abort → run 落 cancelled(collect_cancelled)，等待 settle', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  const deps = createXhsHostDeps({
    root,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: fake.factory,
  })
  const handlers = buildRouteHandlers(deps)
  // 两页响应驱动一次可持续到 dispose 的采集。
  const payload = await handlers['collect.start']!({ accountId: 'acc-1', idempotencyKey: 'k-1' }) as Record<string, unknown>
  assert.equal(payload.status, 'started')
  await disposeHostTasks({ deps })
  const status = await handlers['collect.status']!({ collectId: String(payload.collectId) }) as Record<string, unknown>
  // dispose 后 handler 拒绝：collect.status 也被 guard 拦截（plugin_disposing）。
  assert.equal(status.status, 'error')
  assert.equal(status.reason, 'plugin_disposing')
  // 采集 run 落取消终态（abort 与 collect.cancel 同一判定口径，1126 实施单 A1），
  // 信号表清空。
  const run = deps.collectRuns.get(String(payload.collectId))
  assert.equal(run?.status, 'cancelled')
  assert.equal(run?.error, 'collect_cancelled')
  assert.equal(deps.collectSignals.size, 0)
  await rm(root, { recursive: true, force: true })
})

test('dispose：扫描码成功与 abort 竞态——清理不误删正式账号', async () => {
  const root = await tempRoot()
  const fake = createFakeChrome()
  fake.state.cookies = sessionCookie()
  fake.state.profileJson = { data: { userId: 'acc-keep', userName: '保留' } }
  const deps = createXhsHostDeps({
    root,
    browserStatusFn: async () => ({ chromeAvailable: true, driverAvailable: true, platform: 'linux' }),
    logger: { warn: () => undefined },
    chromeFactory: fake.factory,
  })
  deps.loginTimeoutMs = 60_000
  const handlers = buildRouteHandlers(deps)
  await handlers['account.beginLogin']!({ accountId: 'acc-keep' })
  // 扫码 cookie 即刻命中：登录与 abort 竞速。无论成败，dispose 等待后无 pending
  // 残留；显式重登的正式账号记录绝不被清理路径抹掉（写入成功则保留）。
  await disposeHostTasks({ deps })
  const { readdir } = await import('node:fs/promises')
  let profiles: string[] = []
  try {
    profiles = await readdir(join(root, 'profiles'))
  } catch {
    profiles = []
  }
  assert.deepEqual(profiles.filter(name => name.startsWith('pending-')), [])
  const run = deps.loginRuns.get('acc-keep')
  assert.ok(run?.status === 'ok' || run?.status === 'failed')
  if (run?.status === 'failed') {
    // abort 收敛：账号目录不被清理（显式重登清理只碰 pending 目录）。
    assert.equal(run.error, 'login_aborted')
  } else {
    const accounts = await import('../src/state.ts').then(state => state.readAccounts(root))
    assert.equal(accounts.accounts['acc-keep']?.sessionStatus, 'ok')
  }
  await rm(root, { recursive: true, force: true })
})
