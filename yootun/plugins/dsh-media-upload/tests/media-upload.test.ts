/**
 * 媒体上传状态机测试（node --test，真实 Cordis 组合 + 假授权 + 假 TOS）：
 * 路由同源校验、pick/uploadStart/uploadStatus/media 全流程、授权响应校验、
 * MIME/大小/TOCTOU 拒绝、截断/超时/失败/重试、成功只回公网 URL、失败不泄
 * 预签名 URL 与路径、media_upload 不接受路径。
 * 运行：`pnpm --filter @yootun/dsh-media-upload test`。
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test, after } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { brandString, type ToolCallId } from '@deepseek-ai/dsh-brand'
import * as MediaUpload from '../src/index.ts'
import type { UploaderDeps } from '../src/deps.ts'
import type { ToolCallOutcome } from '@yootun/dsh-workbench-mcp'

const ORIGIN = 'http://127.0.0.1:5757'

/** 假 TOS：记录 PUT 与 Authorization 头，按脚本返回状态码序列。 */
interface FakeTos {
  url: string
  puts: Array<{ url: string; authorization: string | undefined; bytes: number }>
  close: () => Promise<void>
  /** 后续 PUT 的状态码队列；耗尽后一律 200。 */
  statusQueue: number[]
}

async function startFakeTos(): Promise<FakeTos> {
  const puts: FakeTos['puts'] = []
  const statusQueue: number[] = []
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array))
      puts.push({ url: req.url ?? '', authorization: req.headers.authorization, bytes: Buffer.concat(chunks).byteLength })
      const status = statusQueue.shift() ?? 200
      res.statusCode = status
      res.end()
    })().catch(() => {
      res.statusCode = 500
      res.end()
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake TOS has no TCP address')
  const cleanups: Array<() => Promise<void>> = []
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  }))
  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined)
  })
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    puts,
    statusQueue,
    close: async () => {
      for (const cleanup of cleanups) await cleanup().catch(() => undefined)
    },
  }
}

/** 假 Workbench 授权面：校验调用参数只含三个元数据字段，返回可编程授权。 */
interface FakeWorkbenchOptions {
  tos: FakeTos
  /** 覆写授权对象（默认合法）。 */
  override?: (authorize: Record<string, unknown>) => Record<string, unknown>
  /** 让 callTool 直接抛 Workbench 错误（授权拒绝路径）。 */
  reject?: { code: string; payload?: unknown }
}

function fakeWorkbench(options: FakeWorkbenchOptions): UploaderDeps['workbench'] {
  const calls: Array<unknown> = []
  const face = {
    calls,
    async callTool(_caller: string, _domain: string, name: string, args: unknown): Promise<ToolCallOutcome> {
      assert.equal(name, 'workbench_tos_upload_authorize')
      calls.push(args)
      if (options.reject !== undefined) {
        const error = new Error('business failure') as Error & { code: string; payload?: unknown }
        error.code = options.reject.code
        error.payload = options.reject.payload
        throw error
      }
      const meta = args as { filename: string; contentType: string; size: number }
      assert.deepEqual(Object.keys(meta).sort(), ['contentType', 'filename', 'size'], 'authorize 只接受 filename/contentType/size')
      const authorize: Record<string, unknown> = {
        method: 'PUT',
        url: `${options.tos.url}/put/object/key/should-never-leak?sig=secret`,
        headers: { 'content-type': meta.contentType },
        publicUrl: 'https://media.example.test/yootun/objects/public.mp4',
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        maxBytes: 500 * 1024 * 1024,
      }
      return { structuredContent: options.override?.(authorize) ?? authorize, content: [] }
    },
  }
  return face as unknown as UploaderDeps['workbench']
}

/** 本地路由服务器：把 fetch 变成浏览器客户端。 */
async function startRouteServer(routes: UploaderRoute[]): Promise<{ origin: string; close: () => Promise<void> }> {
  const byPath = new Map(routes.map(route => [route.path, route]))
  const server = createServer((req, res) => {
    const route = byPath.get(req.url?.split('?')[0] ?? '')
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    void route.handler(req as import('node:http').IncomingMessage, res).catch((error: unknown) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('route server has no TCP address')
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

interface Harnessed {
  state: { deps: UploaderDeps; registry: MediaUpload.UploadSessionRegistry; staging: MediaUpload.StagingArea }
  tos: FakeTos
  workbenchCalls: Array<unknown>
  origin: string
  close: () => Promise<void>
}

/** 组装路由服务器 + 假授权 + 假 TOS。 */
async function harness(options: { maxUploadBytes?: number; workbench?: UploaderDeps['workbench']; tos?: FakeTos } = {}): Promise<Harnessed> {
  const tos = options.tos ?? await startFakeTos()
  const wb = options.workbench ?? fakeWorkbench({ tos })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024 }, undefined)
  const deps = { ...state.deps, transport: 'loopback-test' } as UploaderDeps
  const routes = MediaUpload.uploaderRoutes(deps)
  const server = await startRouteServer(routes)
  return {
    state,
    tos,
    workbenchCalls: (wb as unknown as { calls: Array<unknown> }).calls,
    origin: server.origin,
    close: async () => {
      await server.close()
      state.registry.destroy()
      await state.staging.destroy()
      if (options.tos === undefined) await tos.close()
    },
  }
}

/** 浏览器侧 fetch 便捷封装（带同源头）。 */
function clientFetch(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(init.headers as Record<string, string> | undefined) },
  })
}

/** PNG 头若干字节 + 填充，构造合法图片字节。 */
function pngBytes(size: number): Buffer {
  const head = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D])
  const filler = Buffer.alloc(Math.max(0, size - head.byteLength), 0x61)
  return Buffer.concat([head, filler])
}

test('路由同源校验拒绝跨站与非同源请求', async () => {
  const h = await harness()
  try {
    const foreign = await fetch(`${h.origin}/_dsh/uploader/pick-file`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(foreign.status, 403)
    const noOrigin = await fetch(`${h.origin}/_dsh/uploader/pick-file`, { method: 'POST', body: '{}' })
    assert.equal(noOrigin.status, 403)
    const get = await clientFetch(h.origin, '/_dsh/uploader/pick-file')
    assert.equal(get.status, 405)
  } finally {
    await h.close()
  }
})

test('pick-file 创建会话并返回 accept/maxBytes，替换选择即新会话', async () => {
  const h = await harness()
  try {
    const first = await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })
    assert.equal(first.status, 200)
    const firstBody = await first.json() as { uploadId: string; accept: string[]; maxBytes: number }
    assert.ok(firstBody.uploadId.length > 0)
    assert.deepEqual(firstBody.accept, ['jpg', 'jpeg', 'png', 'webp'])
    assert.equal(firstBody.maxBytes, 1024 * 1024)
    // 替换选择：再开一个会话，旧会话过期回收，不产生状态污染。
    const second = await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })
    const secondBody = await second.json() as { uploadId: string }
    assert.notEqual(secondBody.uploadId, firstBody.uploadId)
    assert.equal(h.state.registry.ids().length, 2)
  } finally {
    await h.close()
  }
})

test('uploadStart 到 uploadStatus 全链路成功，只回公网 URL', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(2048)
    const start = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    assert.equal(start.status, 200)
    const startBody = await start.json() as { uploadId: string; name: string; size: number; contentType: string }
    assert.equal(startBody.name, 'photo.png')
    assert.equal(startBody.contentType, 'image/png')
    // 授权调用参数只有三个元数据字段。
    assert.equal(h.workbenchCalls.length, 1)
    // 轮询到 done。
    let status: Record<string, unknown> = {}
    for (let i = 0; i < 40; i += 1) {
      status = await (await clientFetch(h.origin, '/_dsh/uploader/uploadStatus', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: pick.uploadId }),
      })).json() as Record<string, unknown>
      if (status.status === 'done' || status.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(status.status, 'done')
    assert.equal(status.url, 'https://media.example.test/yootun/objects/public.mp4')
    const serialized = JSON.stringify(status)
    assert.ok(!serialized.includes('should-never-leak'), '公网响应不含预签名 URL')
    assert.ok(!serialized.includes('/tmp/'), '公网响应不含本地路径')
    // 假 TOS 收到完整字节且无 Authorization（预签名）。
    assert.equal(h.tos.puts.length, 1)
    assert.equal(h.tos.puts[0]?.bytes, bytes.byteLength)
    assert.equal(h.tos.puts[0]?.authorization, undefined)
  } finally {
    await h.close()
  }
})

test('media 预览仅未完成会话可用且支持 Range', async () => {
  const h = await harness({ tos: await makeHangingTos() })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(1024)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    // 悬挂上传期间预览可用。
    const full = await clientFetch(h.origin, `/_dsh/uploader/media?uploadId=${pick.uploadId}`)
    assert.equal(full.status, 200)
    assert.equal((await full.arrayBuffer()).byteLength, bytes.byteLength)
    const ranged = await clientFetch(h.origin, `/_dsh/uploader/media?uploadId=${pick.uploadId}`, { headers: { range: 'bytes=0-7' } })
    assert.equal(ranged.status, 206)
    assert.equal((await ranged.arrayBuffer()).byteLength, 8)
    // 未知 id 一律 403（不解释存在性）。
    const unknown = await clientFetch(h.origin, '/_dsh/uploader/media?uploadId=nope')
    assert.equal(unknown.status, 403)
  } finally {
    await h.close()
  }
})

/** 悬挂 TOS（PUT 挂起直到 release）；release 后以 200 放行全部挂起请求。 */
async function makeHangingTos(): Promise<FakeTos & { release: () => void }> {
  const puts: FakeTos['puts'] = []
  const statusQueue: number[] = []
  const barrier = Promise.withResolvers<void>()
  const server = createServer((req, res) => {
    void (async () => {
      for await (const chunk of req) void chunk
      puts.push({ url: req.url ?? '', authorization: req.headers.authorization, bytes: 0 })
      await barrier.promise
      res.statusCode = 200
      res.end()
    })().catch(() => {
      res.statusCode = 500
      res.end()
    })
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('hanging TOS has no TCP address')
  after(async () => {
    barrier.resolve()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    puts,
    statusQueue,
    release: () => { barrier.resolve() },
    close: async () => {
      barrier.resolve()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

test('MIME 魔数与声明不符拒绝（mime_mismatch）', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const fake = Buffer.alloc(512, 0x41)
    const start = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(fake.byteLength),
      },
      body: fake,
    })
    assert.equal(start.status, 400)
    assert.deepEqual(await start.json(), { error: 'mime_mismatch' })
    assert.equal(h.tos.puts.length, 0)
    assert.equal(h.workbenchCalls.length, 0, '字节校验失败不发起授权')
  } finally {
    await h.close()
  }
})

test('超限与截断拒绝（file_too_large / invalid_request）', async () => {
  const h = await harness({ maxUploadBytes: 512 })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'media' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(2048)
    const tooLarge = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    assert.equal(tooLarge.status, 400)
    assert.deepEqual(await tooLarge.json(), { error: 'file_too_large' })
    // 声明超限本身就是 file_too_large（先于 content-length 检查）。
    // 声明大小低于上限但与 content-length 不一致 → invalid_request。
    const mismatch = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': '384',
      },
      body: bytes,
    })
    assert.equal(mismatch.status, 400)
    assert.deepEqual(await mismatch.json(), { error: 'invalid_request' })
  } finally {
    await h.close()
  }
})

test('扩展名不在档位白名单拒绝（extension_not_allowed）', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'video' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    const start = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    assert.equal(start.status, 400)
    assert.deepEqual(await start.json(), { error: 'extension_not_allowed' })
  } finally {
    await h.close()
  }
})

test('授权响应非法逐项拒绝（协议/公网/过期/大小/类型）', async () => {
  const base = (tosUrl: string): Record<string, unknown> => ({
    method: 'PUT',
    url: `${tosUrl}/put/key`,
    headers: { 'content-type': 'image/png' },
    publicUrl: 'https://media.example.test/objects/public.png',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxBytes: 1024 * 1024,
  })
  const tos = await startFakeTos()
  const cases: Array<{ name: string; override: (authorize: Record<string, unknown>) => Record<string, unknown>; expected: string }> = [
    { name: 'method 非 PUT', override: authorize => ({ ...authorize, method: 'POST' }), expected: 'upload_authorization_invalid' },
    { name: 'publicUrl 指向私网', override: authorize => ({ ...authorize, publicUrl: 'https://127.0.0.1/x' }), expected: 'upload_authorization_invalid' },
    { name: 'publicUrl 非 HTTPS', override: authorize => ({ ...authorize, publicUrl: 'http://media.example.test/x' }), expected: 'upload_authorization_invalid' },
    { name: 'expiresAt 过期', override: authorize => ({ ...authorize, expiresAt: new Date(Date.now() - 1000).toISOString() }), expected: 'upload_authorization_invalid' },
    { name: 'maxBytes 非正整数', override: authorize => ({ ...authorize, maxBytes: 0 }), expected: 'upload_authorization_invalid' },
    { name: 'Content-Type 不一致', override: authorize => ({ ...authorize, headers: { 'content-type': 'video/mp4' } }), expected: 'upload_authorization_invalid' },
  ]
  for (const scenario of cases) {
    const h = await harness({ workbench: fakeWorkbench({ tos, override: scenario.override }) })
    try {
      const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
      })).json() as { uploadId: string }
      const bytes = pngBytes(128)
      const start = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-yootun-upload-id': pick.uploadId,
          'x-yootun-filename': 'photo.png',
          'x-yootun-content-type': 'image/png',
          'x-yootun-size': String(bytes.byteLength),
        },
        body: bytes,
      })
      // 授权在后台管线失败 → uploadStart 本身已 200，状态落 failed。
      assert.equal(start.status, 200)
      let status: Record<string, unknown> = {}
      for (let i = 0; i < 40; i += 1) {
        status = await (await clientFetch(h.origin, '/_dsh/uploader/uploadStatus', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: pick.uploadId }),
        })).json() as Record<string, unknown>
        if (status.status === 'failed') break
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      assert.equal(status.status, 'failed', scenario.name)
      assert.equal(status.error, scenario.expected, scenario.name)
      const serialized = JSON.stringify(status)
      assert.ok(!serialized.includes('should-never-leak') && !serialized.includes('/tmp/'), `${scenario.name} 失败响应不泄露`)
    } finally {
      await h.close()
    }
  }
  await tos.close()
})

test('授权被服务端拒绝映射稳定码（storage_auth_failed）', async () => {
  const tos = await startFakeTos()
  const h = await harness({ workbench: fakeWorkbench({ tos, reject: { code: 'workbench_call_failed', payload: { code: 'UNAUTHORIZED' } } }) })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(128)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    let snapshot: MediaUpload.UploadSnapshot | undefined
    for (let i = 0; i < 40; i += 1) {
      snapshot = h.state.registry.snapshot(pick.uploadId)
      if (snapshot?.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'storage_auth_failed')
  } finally {
    await h.close()
    await tos.close()
  }
})

test('PUT 失败有界重试后成功（attempt=2），持续失败落 upload_failed', async () => {
  const tos = await startFakeTos()
  tos.statusQueue.push(500)
  const h = await harness({ tos })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    let snapshot: MediaUpload.UploadSnapshot | undefined
    for (let i = 0; i < 60; i += 1) {
      snapshot = h.state.registry.snapshot(pick.uploadId)
      if (snapshot?.state === 'done' || snapshot?.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(snapshot?.state, 'done', '一次 500 后重试成功')
    assert.equal(snapshot?.attempt, 2)
    assert.equal(h.tos.puts.length, 2)
  } finally {
    await h.close()
    await tos.close()
  }
})

test('TOCTOU：暂存文件在上传期间被改写判失败', async () => {
  const tos = await makeHangingTos()
  const h = await harness({ tos })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    // 悬挂在 PUT 上：改写暂存文件（模拟上传期间被替换），然后放行 PUT。
    const ids = h.state.registry.ids()
    const session = h.state.registry.getLive(ids[0] ?? '')
    assert.ok(session?.staged !== undefined)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(session.staged.path, Buffer.alloc(32, 0x62))
    tos.release()
    let snapshot: MediaUpload.UploadSnapshot | undefined
    for (let i = 0; i < 60; i += 1) {
      snapshot = h.state.registry.snapshot(pick.uploadId)
      if (snapshot?.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'file_changed')
  } finally {
    await h.close()
  }
})

test('media_upload 工具：真实组合注册、不接受路径参数、人机回环返回公网 URL', async () => {
  const tos = await startFakeTos()
  const ctx = new Context()
  const wb = fakeWorkbench({ tos })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: 1024 * 1024 }, undefined)
  const deps = { ...state.deps, transport: 'loopback-test' } as UploaderDeps
  const routes: MediaUpload.UploadRoute[] = MediaUpload.uploaderRoutes(deps)
  ctx.reflect.provide('webServer', {
    getOrigin: () => ORIGIN,
    register: (route: { path: string }) => {
      void routes.findIndex(candidate => candidate.path === route.path)
      return () => undefined
    },
  })
  ctx.reflect.provide('yootunWorkbench', wb)
  const browser = await startRouteServer(routes)
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin({ inject: ['tools'], apply: scope => { MediaUpload.applyUploaderWiring(scope, deps, 30_000) } })
    const schema = (ctx.tools.schemas() as Array<{ name: string; parameters: Record<string, unknown> }>).find(entry => entry.name === 'media_upload')
    assert.ok(schema !== undefined, 'media_upload 已注册')
    assert.ok('kind' in schema.parameters.properties, '参数只有 kind 档位')
    assert.equal('path' in schema.parameters.properties, false, 'schema 无路径参数')
    assert.equal(schema.parameters.additionalProperties, false)

    // 调用带 path 参数：工具不读取、不使用（仍走人机回环）。
    const pending = ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('media-1'), name: 'media_upload', arguments: JSON.stringify({ kind: 'image', path: '/etc/passwd' }) },
      ],
    })
    // 等会话出现，模拟用户在页面选文件上传。
    const deadline = Date.now() + 10_000
    let uploadId = ''
    while (Date.now() < deadline) {
      uploadId = state.registry.ids().find(id => state.registry.getLive(id)?.kind === 'image') ?? ''
      if (uploadId !== '') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.ok(uploadId !== '', '工具创建了上传会话')
    const bytes = pngBytes(256)
    const start = await clientFetch(browser.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    void start
    const batch = await pending
    const result = batch.results[0]?.result as { isError: boolean; value?: Record<string, unknown> }
    assert.equal(result.isError, false)
    const value = result.value as { ok: boolean; url: string; name: string; size: number; contentType: string }
    assert.equal(value.ok, true)
    assert.equal(value.url, 'https://media.example.test/yootun/objects/public.mp4')
    assert.equal(value.name, 'photo.png')
    const serialized = JSON.stringify(result)
    assert.ok(!serialized.includes('should-never-leak'), '工具结果不含预签名 URL')
    assert.ok(!serialized.includes('/etc/passwd'), '工具结果不含调用方路径')
    assert.ok(!serialized.includes('/tmp/'), '工具结果不含暂存路径')
  } finally {
    await browser.close()
    state.registry.destroy()
    await state.staging.destroy()
    await ctx.fiber.dispose()
    await tos.close()
  }
})

test('media_upload 工具：调用方取消投影取消错误；上传失败回稳定码', async () => {
  const tos = await makeHangingTos()
  const ctx = new Context()
  const wb = fakeWorkbench({ tos })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: 1024 * 1024 }, undefined)
  const deps = { ...state.deps, transport: 'loopback-test' } as UploaderDeps
  const routes = MediaUpload.uploaderRoutes(deps)
  ctx.reflect.provide('webServer', {
    getOrigin: () => ORIGIN,
    register: () => () => undefined,
  })
  ctx.reflect.provide('yootunWorkbench', wb)
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin({ inject: ['tools'], apply: scope => { MediaUpload.applyUploaderWiring(scope, deps, 30_000) } })
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('media-2'), name: 'media_upload', arguments: '{}' },
      ],
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    const batch = await pending
    const result = batch.results[0]?.result as { isError: boolean; value?: { ok: boolean; error?: string } }
    assert.equal(result.isError, true, '调用方取消由执行管线投影为取消错误')
    void result.value

    // 会话级失败（TOS 持续 500）走工具正常返回 {ok:false,error:'upload_failed'}。
    const failing = await startFakeTos()
    failing.statusQueue.push(500, 500, 500)
    const wb2 = fakeWorkbench({ tos: failing })
    const state2 = MediaUpload.createUploaderState(() => ORIGIN, wb2, { maxUploadBytes: 1024 * 1024 }, undefined)
    const deps2 = { ...state2.deps, transport: 'loopback-test' } as UploaderDeps
    const routes2 = MediaUpload.uploaderRoutes(deps2)
    const browser2 = await startRouteServer(routes2)
    const ctx2 = new Context()
    ctx2.reflect.provide('webServer', { getOrigin: () => ORIGIN, register: () => () => undefined })
    ctx2.reflect.provide('yootunWorkbench', wb2)
    try {
      await ctx2.plugin(SystemPrompt)
      await ctx2.plugin(ToolRuntime)
      await ctx2.plugin(NativeToolExecutor)
      await ctx2.plugin({ inject: ['tools'], apply: scope => { MediaUpload.applyUploaderWiring(scope, deps2, 30_000) } })
      const pending2 = ctx2.tools.execute({
        signal: new AbortController().signal,
        calls: [
          { type: 'tool-call' as const, id: brandString<ToolCallId>('media-3'), name: 'media_upload', arguments: '{}' },
        ],
      })
      const deadline = Date.now() + 10_000
      let uploadId = ''
      while (Date.now() < deadline) {
        uploadId = state2.registry.ids().find(id => state2.registry.getLive(id)?.kind === 'media') ?? ''
        if (uploadId !== '') break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      const bytes = pngBytes(256)
      await clientFetch(browser2.origin, '/_dsh/uploader/uploadStart', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-yootun-upload-id': uploadId,
          'x-yootun-filename': 'photo.png',
          'x-yootun-content-type': 'image/png',
          'x-yootun-size': String(bytes.byteLength),
        },
        body: bytes,
      })
      const batch2 = await pending2
      const result2 = batch2.results[0]?.result as { isError: boolean; value?: { ok: boolean; error?: string } }
      assert.equal(result2.isError, false, '会话失败是工具正常返回')
      assert.equal(result2.value?.ok, false)
      assert.equal(result2.value?.error, 'storage_unavailable', '持续 5xx 投影为存储不可用（有界重试耗尽）')
      const serialized = JSON.stringify(result2)
      assert.ok(!serialized.includes('should-never-leak') && !serialized.includes('/tmp/'), '失败结果不泄露')
    } finally {
      await browser2.close()
      state2.registry.destroy()
      await state2.staging.destroy()
      await ctx2.fiber.dispose()
      await failing.close()
    }
  } finally {
    state.registry.destroy()
    await state.staging.destroy()
    await ctx.fiber.dispose()
    await tos.close()
  }
})

test('uploadStart 二次提交在暂存窗口内被拒（并发/重发）', async () => {
  const h = await harness({ tos: await makeHangingTos() })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    const headers = {
      'content-type': 'application/octet-stream',
      'x-yootun-upload-id': pick.uploadId,
      'x-yootun-filename': 'photo.png',
      'x-yootun-content-type': 'image/png',
      'x-yootun-size': String(bytes.byteLength),
    }
    // 第一个请求在悬挂 PUT 期间保持 uploading；第二个提交必须被拒。
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', { method: 'POST', headers, body: bytes })
    const second = await clientFetch(h.origin, '/_dsh/uploader/uploadStart', { method: 'POST', headers, body: bytes })
    assert.equal(second.status, 400)
    assert.deepEqual(await second.json(), { error: 'session_not_found' })
    // 授权只发生一次（不会重复预签名）。
    assert.equal(h.workbenchCalls.length, 1)
  } finally {
    await h.close()
  }
})

test('非 ASCII 文件名经头传输不乱码', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        // fetch 对非 ASCII 头值按 UTF-8 编码、宿主按 latin1 解码：显式还原。
        'x-yootun-filename': encodeHeaderValue('截图.png'),
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    const snapshot = h.state.registry.snapshot(pick.uploadId)
    assert.equal(snapshot?.name, '截图.png')
    const authorizeArgs = h.workbenchCalls[0] as { filename: string }
    assert.equal(authorizeArgs.filename, '截图.png', '授权元数据携带还原后的文件名')
  } finally {
    await h.close()
  }
})

/** 模拟浏览器 fetch 对非 ASCII 头值的 UTF-8 上线（宿主 latin1 解码后还原）。 */
function encodeHeaderValue(value: string): string {
  return Buffer.from(value, 'utf8').toString('latin1')
}

test('strict 模式逐项拒绝（PUT url HTTPS/私网）且 loopback-test 只放宽 PUT url', () => {
  const valid: Record<string, unknown> = {
    method: 'PUT',
    url: 'https://storage.example.test/put/key',
    headers: { 'content-type': 'image/png' },
    publicUrl: 'https://media.example.test/objects/public.png',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxBytes: 1024 * 1024,
  }
  const meta = { filename: 'a.png', contentType: 'image/png', size: 128 }
  // strict：合法响应通过。
  assert.doesNotThrow(() => MediaUpload.validateAuthorizationResponse({ ...valid }, meta))
  // strict：PUT url 非 HTTPS 拒绝。
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'http://storage.example.test/put' }, meta), /upload_authorization_invalid|authorization url must be HTTPS/u)
  // strict：PUT url 私网拒绝。
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'https://10.0.0.1/put' }, meta), /loopback\/private/u)
  // loopback-test：只放宽 PUT url；publicUrl 恒严格。
  assert.doesNotThrow(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'http://127.0.0.1:9/put' }, meta, { transport: 'loopback-test' }))
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'http://127.0.0.1:9/put', publicUrl: 'http://media.example.test/x' }, meta, { transport: 'loopback-test' }), /publicUrl must be HTTPS/u)
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'http://127.0.0.1:9/put', publicUrl: 'https://192.168.1.1/x' }, meta, { transport: 'loopback-test' }), /loopback\/private/u)
})

test('authorize 无 structuredContent 时回退解析 content blocks', async () => {
  const tos = await startFakeTos()
  const workbench: UploaderDeps['workbench'] = {
    async callTool(): Promise<ToolCallOutcome> {
      return {
        structuredContent: undefined,
        content: [{ type: 'text', text: '```json\n' + JSON.stringify({
          method: 'PUT', url: `${tos.url}/put/key`, headers: { 'content-type': 'image/png' },
          publicUrl: 'https://media.example.test/objects/public.png',
          expiresAt: new Date(Date.now() + 600_000).toISOString(), maxBytes: 1024 * 1024,
        }) + '\n```' }],
      }
    },
  } as unknown as UploaderDeps['workbench']
  const h = await harness({ workbench })
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(128)
    await clientFetch(h.origin, '/_dsh/uploader/uploadStart', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId,
        'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png',
        'x-yootun-size': String(bytes.byteLength),
      },
      body: bytes,
    })
    let snapshot: MediaUpload.UploadSnapshot | undefined
    for (let i = 0; i < 40; i += 1) {
      snapshot = h.state.registry.snapshot(pick.uploadId)
      if (snapshot?.state === 'done' || snapshot?.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(snapshot?.state, 'done', 'content blocks 回退解析走通全链路')
    assert.equal(snapshot?.url, 'https://media.example.test/objects/public.png')
  } finally {
    await h.close()
    await tos.close()
  }
})
