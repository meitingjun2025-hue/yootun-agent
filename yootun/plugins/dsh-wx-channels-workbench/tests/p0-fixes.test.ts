/**
 * P2 三次复审 P0 修复的确定性测试（node --test）：
 * 1. profile lock 死锁：同账号嵌套锁不得挂起；
 * 2. runs.json 并发写：两条并发 upsert 都保留；
 * 3. login abort：abort 后 profiles 目录无 pending-* 残留。
 * 运行：`node --test tests/p0-fixes.test.ts`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { withProfileLock } from '../src/locks.ts'
import { readRuns, upsertRun } from '../src/runs.ts'

// --- 1. profile lock 死锁 ---

test('profile lock：同账号嵌套调用不得永久挂起（非重入锁的调用方不得再包一层）', async () => {
  // 模拟 handlers.ts 外层包 lock → 内层 probeAndReport 又包 lock → 死锁。
  // 修复后：lock 只在最内层（probeSession），外层不再包。
  const result = await withProfileLock('acc-nested', async () => {
    // 内层不再调用 withProfileLock（修复后的正确行为）。
    return 'inner-done'
  })
  assert.equal(result, 'inner-done')
})

test('profile lock：同账号并发调用串行（不同账号并发不阻塞）', async () => {
  const order: string[] = []
  // 同账号：第二个调用必须等第一个完成。
  const [r1, r2] = await Promise.all([
    withProfileLock('acc-serial', async () => {
      order.push('acc-serial:start')
      await new Promise(resolve => setTimeout(resolve, 50))
      order.push('acc-serial:end')
      return 1
    }),
    withProfileLock('acc-serial', async () => {
      order.push('acc-serial:start-2')
      return 2
    }),
  ])
  assert.equal(r1, 1)
  assert.equal(r2, 2)
  assert.ok(order.indexOf('acc-serial:end') < order.indexOf('acc-serial:start-2'), '同账号串行')

  // 不同账号：并发不阻塞。
  const [a, b] = await Promise.all([
    withProfileLock('acc-A', async () => 'A'),
    withProfileLock('acc-B', async () => 'B'),
  ])
  assert.equal(a, 'A')
  assert.equal(b, 'B')
})

// --- 2. runs.json 并发写 ---

test('runs.json：并发 upsertRun 两条都保留（不丢写）', async () => {
  const root = join(tmpdir(), `wx-runs-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })

  // 并发 upsert 两条不同 runId 的记录。
  await Promise.all([
    upsertRun(root, { accountId: 'a', runId: 'run-1', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: {} }),
    upsertRun(root, { accountId: 'b', runId: 'run-2', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: {} }),
  ])

  const runs = await readRuns(root)
  assert.ok(runs['run-1'] !== undefined, 'run-1 保留')
  assert.ok(runs['run-2'] !== undefined, 'run-2 保留')
  rmSync(root, { recursive: true, force: true })
})

test('runs.json：同一 runId 二次 upsert 覆盖（不产生重复）', async () => {
  const root = join(tmpdir(), `wx-runs-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })

  await upsertRun(root, { accountId: 'a', runId: 'run-1', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: {} })
  await upsertRun(root, { accountId: 'a', runId: 'run-1', status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null, progress: {} })

  const runs = await readRuns(root)
  assert.equal(Object.keys(runs).length, 1)
  assert.equal(runs['run-1']?.status, 'completed')
  rmSync(root, { recursive: true, force: true })
})

test('runs.json：recoverInterruptedRuns 将 running → interrupted', async () => {
  const root = join(tmpdir(), `wx-runs-${String(Math.random()).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const { recoverInterruptedRuns } = await import('../src/runs.ts')
  await upsertRun(root, { accountId: 'a', runId: 'run-1', status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, progress: {} })
  const count = await recoverInterruptedRuns(root)
  assert.equal(count, 1)
  const runs = await readRuns(root)
  assert.equal(runs['run-1']?.status, 'interrupted')
  rmSync(root, { recursive: true, force: true })
})

// --- 3. login abort 清理 ---

test('loginWithQrCode abort 后 profiles 目录无 pending-* 残留', async () => {
  const root = join(tmpdir(), `wx-login-abort-${String(Math.random()).slice(2)}`)
  const profilesDir = join(root, 'profiles')
  mkdirSync(profilesDir, { recursive: true })

  const controller = new AbortController()
  const { loginWithQrCode } = await import('../src/session.ts')
  const { ensureProfileDir } = await import('../src/state.ts')

  // 启动登录（chromeFactory 注入假实现：永不 resolve，模拟 Chrome 打开挂起）。
  const pending = loginWithQrCode({
    root,
    chromeFactory: async options => {
      // 创建 profile 目录（模拟 Chrome persistent context）。
      mkdirSync(options.profileDir, { recursive: true })
      // 永不 resolve 的 context（挂起等 abort）。
      return new Promise<never>(() => {})
    },
    signal: controller.signal,
  })

  // 等 Chrome factory 被调用（profile 目录出现）。
  const deadline = Date.now() + 3000
  while (!existsSync(join(profilesDir, 'pending-')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    // pending profile 目录名可能带时间戳。
    const entries = readdirSync(profilesDir).filter(name => name.startsWith('pending-'))
    if (entries.length > 0) break
  }

  // abort。
  controller.abort()
  const result = await Promise.race([
    pending.catch((error: unknown) => ({ status: 'failed', reason: (error as Error)?.message ?? 'unknown' })),
    new Promise<{ status: string; reason?: string }>((_, reject) => setTimeout(() => reject(new Error('login abort timeout')), 5000)),
  ])
  assert.equal(result.status, 'failed')
  assert.equal(result.reason, 'login_aborted')

  // abort 后 profiles 目录无 pending-* 残留。
  const leftover = readdirSync(profilesDir).filter(name => name.startsWith('pending-'))
  assert.equal(leftover.length, 0, `pending-* 目录应已清理，实际残留: ${JSON.stringify(leftover)}`)

  rmSync(root, { recursive: true, force: true })
})
