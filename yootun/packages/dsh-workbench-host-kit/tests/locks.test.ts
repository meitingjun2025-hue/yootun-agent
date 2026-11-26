/**
 * profile 锁测试（node --test；实施单 workbench-host-kit 附录 B.1 H5–H6）：
 * 同账号 FIFO 等待、不同账号并行、try 语义不排队、多锁排序获取、即时占 release
 * 幂等、等待者计数、实例间互不影响。运行：`node --test tests/locks.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProfileLocks } from '../src/profile-locks.ts'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

test('H5 同账号等待：后到调用排队 FIFO，前序 settle 后依次进入', async () => {
  const locks = createProfileLocks()
  const order: string[] = []
  const gate = Promise.withResolvers<void>()
  const first = locks.withProfileLock('a', async () => {
    order.push('first-enter')
    await gate.promise
    order.push('first-exit')
  })
  const second = locks.withProfileLock('a', async () => { order.push('second-enter') })
  const third = locks.withProfileLock('a', async () => { order.push('third-enter') })
  await tick()
  assert.deepEqual(order, ['first-enter'], '前序未 settle 时后序不得进入')
  assert.equal(locks.isProfileLocked('a'), true)
  assert.equal(locks.profileLockWaiters('a'), 2)
  gate.resolve()
  await Promise.all([first, second, third])
  assert.deepEqual(order, ['first-enter', 'first-exit', 'second-enter', 'third-enter'])
  assert.equal(locks.isProfileLocked('a'), false)
})

test('H5 不同账号并行；try 语义不排队（占用即 acquired:false，绝不等待）', async () => {
  const locks = createProfileLocks()
  const gate = Promise.withResolvers<void>()
  const slow = locks.withProfileLock('a', async () => { await gate.promise })
  const parallel = locks.withProfileLock('b', async () => 'b-ok')
  await tick()
  assert.equal(await parallel, 'b-ok', '不同账号不得互相阻塞')

  const busy = await locks.tryWithProfileLock('a', async () => 'never')
  assert.deepEqual(busy, { acquired: false, result: undefined })
  const free = await locks.tryWithProfileLock('c', async () => 'c-ok')
  assert.deepEqual(free, { acquired: true, result: 'c-ok' })
  gate.resolve()
  await slow
})

test('H5 try 锁在任务失败时也释放；多锁按 key 排序获取、tryWithProfileLocks 全有或全无', async () => {
  const locks = createProfileLocks()
  const failing = locks.tryWithProfileLock('a', async () => { throw new Error('task failed') })
  await assert.rejects(failing, /task failed/)
  assert.equal(locks.isProfileLocked('a'), false, '任务失败后锁必须已释放')

  // 排序获取：两个多锁请求以相反顺序传入，按 key 排序后全序一致，并发不死锁。
  const g1 = locks.withProfileLocks(['a', 'b'], async () => { await tick() })
  const g2 = locks.withProfileLocks(['b', 'a'], async () => 'g2')
  const held = await Promise.all([g1, g2])
  assert.deepEqual(held, [undefined, 'g2'])
  const cross = locks.withProfileLocks(['a', 'b'], async () => 'cross')
  const other = locks.withProfileLock('a', async () => 'other')
  await Promise.all([cross, other])

  // tryWithProfileLocks：任一 key 被占（此处占 z）即整体不获取。
  const gateZ = Promise.withResolvers<void>()
  const holdZ = locks.withProfileLock('z', async () => { await gateZ.promise })
  await tick()
  const blocked = await locks.tryWithProfileLocks(['a', 'z'], async () => 'never')
  assert.deepEqual(blocked, { acquired: false, result: undefined })
  assert.equal(locks.isProfileLocked('a'), false, '部分获取的集合必须回滚')
  gateZ.resolve()
  await holdZ
  const allFree = await locks.tryWithProfileLocks(['a', 'z'], async () => 'both-free')
  assert.deepEqual(allFree, { acquired: true, result: 'both-free' })
})

test('H5 即时占：占用返回 release；重复释放安全；未占用返回 null', async () => {
  const locks = createProfileLocks()
  const release = locks.acquireProfileLock('a')
  assert.notEqual(release, null)
  assert.equal(locks.acquireProfileLock('a'), null, '已被占用时即时占返回 null')
  assert.equal(locks.isProfileLocked('a'), true)
  release?.()
  release?.()
  assert.equal(locks.isProfileLocked('a'), false, '重复释放幂等')
  assert.equal(locks.profileLockWaiters('a'), 0)
})

test('H6 两个锁实例互不影响：同账号名在不同实例中可同时持有', async () => {
  const locksA = createProfileLocks()
  const locksB = createProfileLocks()
  const gate = Promise.withResolvers<void>()
  const holdA = locksA.withProfileLock('a', async () => { await gate.promise })
  await tick()
  assert.equal(locksA.isProfileLocked('a'), true)
  assert.equal(locksB.isProfileLocked('a'), false, '实例 B 不受实例 A 影响')
  const gateB = Promise.withResolvers<void>()
  const holdB = locksB.withProfileLock('a', async () => { await gateB.promise })
  await tick()
  assert.equal(locksB.isProfileLocked('a'), true, '实例 B 同账号名独立持有')
  gateB.resolve()
  await holdB
  gate.resolve()
  await holdA
})
