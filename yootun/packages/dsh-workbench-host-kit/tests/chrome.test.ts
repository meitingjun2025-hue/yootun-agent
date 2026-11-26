/**
 * Chrome 探测与浏览器生命周期测试（node --test；实施单 workbench-host-kit
 * 附录 B.1 H9 的 G3–G4 迁入 + 探测接缝）：closeContext 关闭预算、launchWithTimeout
 * 启动预算与迟到结果清理、resolveSystemChrome 的候选与 PATH 回退。运行：
 * `node --test tests/chrome.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserLaunchTimeoutError, ChromeMissingError, closeContext, launchWithTimeout, resolveSystemChrome } from '../src/chrome.ts'

test('G3 closeContext：正常关闭不触发 onTimeout；挂起的 close 超时触发 onTimeout 并 resolve', async () => {
  let timedOut = false
  let closed = false
  await closeContext({ close: async () => { closed = true } }, 1000, () => { timedOut = true })
  assert.equal(closed, true)
  assert.equal(timedOut, false)
  // 挂起的 close：closeContext 在预算处返回（close 永不 settle 也不悬挂调用方）。
  const gate = Promise.withResolvers<void>()
  const started = Date.now()
  await closeContext({ close: () => gate.promise }, 40, () => { timedOut = true })
  const elapsed = Date.now() - started
  assert.equal(timedOut, true)
  assert.ok(elapsed >= 30 && elapsed < 500, `应在预算附近返回，实际 ${String(elapsed)}ms`)
  gate.resolve()
  // close 抛错：旁路消费，closeContext 永不抛。
  timedOut = false
  await closeContext({ close: async () => { throw new Error('close failed') } }, 100, () => { timedOut = true })
  assert.equal(timedOut, false)
})

test('G4 launchWithTimeout：超时抛 BrowserLaunchTimeoutError，迟到结果被关闭', async () => {
  const late = Promise.withResolvers<{ close(): Promise<void> }>()
  let closed = false
  let lateCleaned = false
  setTimeout(() => { late.resolve({ close: async () => { closed = true } }) }, 60)
  let caught: unknown = null
  try {
    await launchWithTimeout(() => late.promise, 40, result => {
      lateCleaned = true
      return result.close()
    })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof BrowserLaunchTimeoutError, '超时必须抛 BrowserLaunchTimeoutError')
  assert.equal((caught as BrowserLaunchTimeoutError).name, 'BrowserLaunchTimeoutError')
  await late.promise
  // 迟到的启动结果被 onLateResult 立即关闭。
  const deadline = Date.now() + 2000
  while (!(lateCleaned && closed) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(lateCleaned, true)
  assert.equal(closed, true)
  // 预算内成功：结果原样返回；launch 同步抛出走正常失败路径。
  assert.equal(await launchWithTimeout(() => Promise.resolve('ok'), 1000), 'ok')
  await assert.rejects(launchWithTimeout(() => { throw new Error('sync launch failure') }, 1000), /sync launch failure/)
})

test('resolveSystemChrome：候选命中返回 path + channel；全缺席抛 ChromeMissingError；非 win32 回退 PATH', async () => {
  const found = await resolveSystemChrome({ platform: 'linux', env: {}, exists: async file => file === '/usr/bin/google-chrome-stable' })
  assert.deepEqual(found, { path: '/usr/bin/google-chrome-stable', channel: 'chrome' })
  await assert.rejects(resolveSystemChrome({ platform: 'linux', env: {}, exists: async () => false }), (error: unknown) =>
    error instanceof ChromeMissingError && error.code === 'GOOGLE_CHROME_MISSING')
  const viaPath = await resolveSystemChrome({
    platform: 'linux',
    env: { PATH: '/opt/bin:/usr/local/bin' },
    exists: async file => file === '/opt/bin/google-chrome',
  })
  assert.equal(viaPath.path, '/opt/bin/google-chrome')
  // win32 不做 PATH 回退。
  await assert.rejects(resolveSystemChrome({ platform: 'win32', env: { PATH: '/opt/bin' }, exists: async file => file === '/opt/bin/google-chrome' }), ChromeMissingError)
})
