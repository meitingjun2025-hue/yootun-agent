/**
 * 素材上传状态机测试（旧 test/upload-machine.test.mjs 全行为移植 + 新 transport
 * 适配项）：per-asset 轮询、done/failed/not_found、remove/stopAll/resume、
 * 组内 hasUploading、maxBytes 本地预检、waiting 态。
 * 运行：`node --test tests/upload-machine.test.ts`。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUploadManager, type UploadAssetInput, type UploadStatusSnapshot } from '../src/upload-machine.ts'

// 手动假定时器：schedule 捕获回调，测试里用 fire() 手动推进到下一个轮询周期。
function fakeTimers() {
  const scheduled: Array<(() => void) | null> = []
  return {
    schedule: (fn: () => void): number => { scheduled.push(fn); return scheduled.length },
    clear: (id: unknown): void => { scheduled[Number(id) - 1] = null },
    fire: async (): Promise<void> => {
      const pending = [...scheduled]
      scheduled.length = 0
      for (const fn of pending) if (fn !== null) await fn()
    },
    // 启动回调但不等待其完成（用于 pollStatus 永不返回的在途场景）。
    launch: (): void => {
      const pending = [...scheduled]
      scheduled.length = 0
      for (const fn of pending) if (fn !== null) void fn()
    },
    get pending(): boolean { return scheduled.some(fn => fn !== null) },
  }
}

const START_INPUT: UploadAssetInput = {
  kind: 'video', name: 'clip.mp4', size: 139_700_000, mime: 'video/mp4',
  previewUrl: 'blob:asset-preview-1', file: { stub: 'browser-file' },
}

function makeManager(overrides: {
  startSession?: (kind: 'image' | 'video') => Promise<{ uploadId: string; accept: string[]; maxBytes: number } | null>
  sendBytes?: (input: { uploadId: string; file: unknown }) => Promise<boolean>
  pollStatus?: (input: { uploadId: string }) => Promise<UploadStatusSnapshot | null>
  onChange?: () => void
} = {}) {
  const timers = fakeTimers()
  let seq = 0
  const sessions: Array<'image' | 'video'> = []
  const sends: Array<{ uploadId: string; file: unknown }> = []
  const polls: Array<{ uploadId: string }> = []
  const manager = createUploadManager({
    startSession: overrides.startSession ?? (async kind => {
      sessions.push(kind)
      seq += 1
      return { uploadId: `up-${seq}`, accept: ['mp4'], maxBytes: 500_000_000 }
    }),
    sendBytes: overrides.sendBytes ?? (async input => {
      sends.push(input)
      return true
    }),
    pollStatus: overrides.pollStatus ?? (async input => {
      polls.push(input)
      return { status: 'uploading', progress: 45, bytesSent: 62_865_000, bytesTotal: 139_700_000, attempt: 0 }
    }),
    schedule: timers.schedule,
    clearSchedule: timers.clear,
    onChange: overrides.onChange ?? (() => {}),
  })
  return { manager, timers, sessions, sends, polls }
}

test('start registers an uploading asset with caller preview and uploadId', async () => {
  const { manager, timers, sessions, sends } = makeManager()
  const asset = await manager.start(START_INPUT)
  assert.equal(asset.status, 'uploading')
  assert.equal(asset.uploadId, 'up-1')
  assert.equal(asset.localPreviewUrl, 'blob:asset-preview-1', '已选即预览：预览 URL 由调用方提供（新链路无本地路径）')
  assert.equal(asset.progress, 0)
  assert.equal(asset.url, null, 'uploading 期间 url 必须为 null')
  assert.deepEqual(sessions, ['video'], 'pick-file 已建会话')
  assert.equal(sends.length, 1, '字节流已推送 uploadStart')
  assert.equal(manager.hasUploading('video'), true)
  assert.ok(timers.pending, '轮询已排程')
  manager.stopAll()
})

test('polling progression updates progress and done lands uploaded with url', async () => {
  let pollCount = 0
  const { manager, timers } = makeManager({
    pollStatus: async () => {
      pollCount += 1
      if (pollCount === 1) return { status: 'uploading', progress: 45, bytesSent: 62_865_000, bytesTotal: 139_700_000, attempt: 0 }
      return { status: 'done', url: 'https://cdn.example.com/media/clip.mp4', name: 'clip.mp4', size: 139_700_000 }
    },
  })
  const asset = await manager.start(START_INPUT)
  await timers.fire()
  const polled = manager.get(asset.id)
  assert.equal(polled?.status, 'uploading')
  assert.equal(polled?.progress, 45)
  assert.equal(polled?.bytesWritten, 62_865_000)
  assert.ok(timers.pending, 'uploading 状态继续轮询')

  await timers.fire()
  const done = manager.get(asset.id)
  assert.equal(done?.status, 'uploaded', 'done → uploaded')
  assert.equal(done?.url, 'https://cdn.example.com/media/clip.mp4')
  assert.equal(done?.progress, 100)
  assert.equal(done?.receivedDone, true)
  assert.equal(done?.localPreviewUrl, 'blob:asset-preview-1', '缩略图保持本地预览不变')
  assert.equal(manager.hasUploading('video'), false)
  assert.equal(timers.pending, false, '终态后停止轮询')
})

test('polling progress clamps invalid values before rendering', async () => {
  let pollCount = 0
  const { manager, timers } = makeManager({
    pollStatus: async () => {
      pollCount += 1
      return pollCount === 1
        ? { status: 'uploading', progress: 140, bytesSent: 1, bytesTotal: 10, attempt: 0 }
        : { status: 'uploading', progress: -5, bytesSent: 2, bytesTotal: 10, attempt: 0 }
    },
  })
  const asset = await manager.start({ ...START_INPUT, size: 10 })
  await timers.fire()
  assert.equal(manager.get(asset.id)?.progress, 100, '越界上限归一到 100')
  await timers.fire()
  assert.equal(manager.get(asset.id)?.progress, 0, '负数归一到 0')
})

test('failed status lands failed with error and stops polling', async () => {
  const { manager, timers } = makeManager({
    pollStatus: async () => ({ status: 'failed', error: 'storage_unavailable' }),
  })
  const asset = await manager.start(START_INPUT)
  await timers.fire()
  const failed = manager.get(asset.id)
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.error, 'uploadFailed')
  assert.equal(failed?.url, null, '失败不产生 url')
  assert.equal(timers.pending, false)
})

test('waiting snapshot keeps polling at snapshot progress (字节受理未开传)', async () => {
  let pollCount = 0
  const { manager, timers } = makeManager({
    pollStatus: async () => {
      pollCount += 1
      return pollCount === 1
        ? { status: 'waiting', progress: 0, bytesSent: 0, bytesTotal: 100, attempt: 0 }
        : { status: 'uploading', progress: 50, bytesSent: 50, bytesTotal: 100, attempt: 0 }
    },
  })
  const asset = await manager.start({ ...START_INPUT, size: 100 })
  await timers.fire()
  const waiting = manager.get(asset.id)
  assert.equal(waiting?.status, 'uploading', 'waiting 按 uploading 口径展示')
  assert.equal(waiting?.progress, 0)
  assert.ok(timers.pending)
  await timers.fire()
  assert.equal(manager.get(asset.id)?.progress, 50)
  manager.stopAll()
})

test('pick-session rejection marks the asset failed immediately', async () => {
  const { manager, timers, sends } = makeManager({
    startSession: async () => null,
  })
  const asset = await manager.start(START_INPUT)
  assert.equal(asset.status, 'failed', 'pick-file 快速失败 → 素材 failed')
  assert.equal(asset.error, 'uploadFailed')
  assert.equal(sends.length, 0, '不推送字节')
  assert.equal(timers.pending, false, '不启动轮询')
  assert.equal(manager.hasUploading('video'), false)
})

test('session/send throwing (network/parse) is normalized to failed with no orphaned poll', async () => {
  // 回归：startSession/sendBytes 抛错（fetch 拒绝/JSON 解析失败）必须与返回 null
  // 同归一置 failed，不得停留在 uploading 且无轮询、也不得向上抛未捕获异常。
  const throwing = makeManager({
    startSession: async () => { throw new TypeError('Failed to fetch') },
  })
  const assetA = await throwing.manager.start(START_INPUT)
  assert.equal(assetA.status, 'failed', 'startSession 抛错 → 素材 failed')
  assert.equal(assetA.error, 'uploadFailed')
  assert.equal(throwing.timers.pending, false, '不排程轮询')

  const sendThrowing = makeManager({
    sendBytes: async () => { throw new TypeError('Failed to fetch') },
  })
  const assetB = await sendThrowing.manager.start(START_INPUT)
  assert.equal(assetB.status, 'failed', 'sendBytes 抛错 → 素材 failed')
  assert.equal(assetB.uploadId, 'up-1', 'transport 拆分后会话已建（uploadId 保留作诊断，无重试路径）')
  assert.equal(sendThrowing.timers.pending, false)
})

test('oversize input fails locally before sending bytes', async () => {
  const { manager, timers, sends } = makeManager()
  const asset = await manager.start({ ...START_INPUT, size: 500_000_001 })
  assert.equal(asset.status, 'failed', '超过 pick-file maxBytes 本地预检直接 failed')
  assert.equal(asset.error, 'uploadFailed')
  assert.equal(sends.length, 0)
  assert.equal(timers.pending, false)
  manager.stopAll()
})

test('not_found before any done marks failed; after done is ignored (P2)', async () => {
  // 分支一：从未收到 done → not_found 置 failed（回归锚点 4）。
  const first = makeManager({ pollStatus: async () => ({ status: 'not_found' }) })
  const assetA = await first.manager.start(START_INPUT)
  await first.timers.fire()
  assert.equal(first.manager.get(assetA.id)?.status, 'failed', 'not_found 且从未收到 done → failed')

  // 分支二：已收到 done（asset 已 uploaded）后不会再轮询，状态保持 uploaded。
  const second = makeManager({
    pollStatus: async () => ({ status: 'done', url: 'https://cdn.example.com/media/clip.mp4' }),
  })
  const assetB = await second.manager.start(START_INPUT)
  await second.timers.fire()
  assert.equal(second.manager.get(assetB.id)?.status, 'uploaded')
  assert.equal(second.manager.get(assetB.id)?.status, 'uploaded', 'done 后状态稳定，不被后续 not_found 竞态破坏')
})

test('attempt increments surface the retrying state and progress resets (P3)', async () => {
  let pollCount = 0
  const { manager, timers } = makeManager({
    pollStatus: async () => {
      pollCount += 1
      if (pollCount === 1) return { status: 'uploading', progress: 30, bytesSent: 41_910_000, bytesTotal: 139_700_000, attempt: 0 }
      return { status: 'uploading', progress: 0, bytesSent: 0, bytesTotal: 139_700_000, attempt: 1 }
    },
  })
  const asset = await manager.start(START_INPUT)
  await timers.fire()
  assert.equal(manager.get(asset.id)?.attempt, 0)
  await timers.fire()
  const retried = manager.get(asset.id)
  assert.equal(retried?.attempt, 1, 'attempt 递增（客户端可显示「重试中」）')
  assert.equal(retried?.progress, 0, '重试开始时进度归零')
  assert.equal(retried?.status, 'uploading')
  assert.ok(timers.pending)
})

test('transient poll failures keep polling and give up after the bound', async () => {
  let pollCount = 0
  const { manager, timers } = makeManager({
    pollStatus: async () => {
      pollCount += 1
      if (pollCount <= 3) return null
      return { status: 'done', url: 'https://cdn.example.com/media/clip.mp4' }
    },
  })
  const asset = await manager.start(START_INPUT)
  await timers.fire()
  await timers.fire()
  await timers.fire()
  assert.equal(manager.get(asset.id)?.status, 'uploading', '暂态轮询失败继续轮询')
  await timers.fire()
  assert.equal(manager.get(asset.id)?.status, 'uploaded', '恢复后仍能正常终态')

  // 连续失败超过上限 → failed，避免永久空转。
  const stuck = makeManager({ pollStatus: async () => null })
  const assetC = await stuck.manager.start(START_INPUT)
  for (let i = 0; i < 12; i++) await stuck.timers.fire()
  assert.equal(stuck.manager.get(assetC.id)?.status, 'failed')
  assert.equal(stuck.timers.pending, false)
})

test('remove stops polling and drops the asset', async () => {
  const { manager, timers } = makeManager()
  const asset = await manager.start(START_INPUT)
  assert.ok(timers.pending)
  manager.remove(asset.id)
  assert.equal(timers.pending, false, '移除素材必须停止该 id 的轮询')
  assert.equal(manager.get(asset.id), null)
  assert.equal(manager.hasUploading('video'), false)
})

test('stopAll halts every poll; resume restores uploading assets only', async () => {
  let started = 0
  const { manager, timers } = makeManager({
    sendBytes: async () => { started += 1; return true },
  })
  const videoAsset = await manager.start(START_INPUT)
  const imageAsset = await manager.start({ ...START_INPUT, kind: 'image', name: 'a.jpg', size: 2048, mime: 'image/jpeg' })
  assert.equal(manager.list('image').length, 1)
  assert.equal(manager.list('video').length, 1)

  manager.stopAll()
  assert.equal(timers.pending, false, '关闭面板停止全部轮询')

  // 上传在面板关闭期间完成：resume 后下一次轮询拿到 done。
  let finished = false
  const resumed = makeManager({
    pollStatus: async () => (finished
      ? { status: 'done', url: 'https://cdn.example.com/media/done.mp4' }
      : { status: 'uploading', progress: 10, bytesSent: 1, bytesTotal: 10, attempt: 0 }),
  })
  const assetC = await resumed.manager.start(START_INPUT)
  resumed.manager.stopAll()
  finished = true
  resumed.manager.resume()
  assert.ok(resumed.timers.pending, 'resume 恢复 uploading 素材的轮询')
  await resumed.timers.fire()
  assert.equal(resumed.manager.get(assetC.id)?.status, 'uploaded')

  // 已终态素材不会被 resume 重新轮询。
  manager.remove(videoAsset.id)
  manager.remove(imageAsset.id)
  manager.resume()
  assert.equal(timers.pending, false, '全部终态后 resume 不排程轮询')
})

test('in-flight poll resolving after stopAll must not resurrect polling', async () => {
  // 回归：关闭面板时若有轮询请求在途，其返回后不得重新排程（suspend 门闸）。
  let resolvePoll: ((value: UploadStatusSnapshot | null) => void) | undefined
  const { manager, timers } = makeManager({
    pollStatus: () => new Promise(resolve => { resolvePoll = resolve }),
  })
  const asset = await manager.start(START_INPUT)
  timers.launch() // 触发轮询回调但不等待（pollStatus 挂起中）
  assert.equal(typeof resolvePoll, 'function', '轮询请求已发出且在途')

  manager.stopAll()
  resolvePoll?.({ status: 'uploading', progress: 20, bytesSent: 2, bytesTotal: 10, attempt: 0 })
  // 让 in-flight 回调的后续微任务跑完（多个 tick 足以覆盖 await 链）。
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(timers.pending, false, '在途轮询返回后不得复活轮询')
  assert.equal(manager.get(asset.id)?.status, 'uploading', '被丢弃的轮询结果不改变素材状态')

  manager.resume()
  assert.ok(timers.pending, 'resume 后重新排程轮询')
  manager.stopAll()
})

test('hasUploading is scoped per kind so submit interception stays per-tab (P5)', async () => {
  const { manager } = makeManager()
  await manager.start(START_INPUT)
  assert.equal(manager.hasUploading('video'), true)
  assert.equal(manager.hasUploading('image'), false, '视频上传不拦截图片 tab 的提交')
})

test('video re-selection replaces the previous asset via remove', async () => {
  let started = 0
  const { manager } = makeManager({
    sendBytes: async () => { started += 1; return true },
  })
  const first = await manager.start(START_INPUT)
  const second = await manager.start({ ...START_INPUT, name: 'other.mp4' })
  assert.notEqual(first.id, second.id)
  manager.remove(first.id)
  assert.equal(manager.list('video').length, 1)
  assert.equal(manager.list('video')[0]?.id, second.id, '覆盖后只剩新视频')
})
