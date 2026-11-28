/**
 * 媒体上传状态机测试（node --test，真实 Cordis 组合 + 假授权 + 假 TOS）：
 * 路由信任判定（Desktop 转发双头缺失放行、跨站/异源/非 loopback 拒绝）、
 * pick/uploadStart/uploadStatus/media 全流程、pending/cancel 承接路由、
 * 授权响应校验、MIME/大小/TOCTOU 拒绝、截断/超时/失败/重试、成功只回公网
 * URL、失败不泄预签名 URL 与路径、media_upload 不接受路径。
 * 运行：`pnpm --filter @yootun/dsh-media-upload test`。
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest, IncomingMessage } from 'node:http'
import type { RequestOptions } from 'node:http'
import { Socket } from 'node:net'
import { test, after } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as MediaUpload from '../src/index.ts'
import { permitted } from '../src/routes.ts'
import type { UploaderDeps } from '../src/deps.ts'
import type { UploadSessionRegistry } from '../src/sessions.ts'
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
async function startRouteServer(routes: MediaUpload.UploadRoute[]): Promise<{ origin: string; close: () => Promise<void> }> {
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
function pngBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(0, size))
  bytes.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D])
  bytes.fill(0x61, 12)
  return bytes
}

test('路由信任判定：Desktop 转发双头缺失放行，跨站与非同源拒绝', async () => {
  const h = await harness()
  try {
    const foreign = await fetch(`${h.origin}/_dsh/uploader/pick-file`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(foreign.status, 403)
    // 双头缺失 = Desktop Electron forwardWebRequest 转发的合法形态（真机
    // 抓包证实无 Origin / Sec-Fetch-Site），来源边界由 loopback 承担 → 放行。
    const desktopForward = await (await fetch(`${h.origin}/_dsh/uploader/pick-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).json() as { uploadId: string }
    assert.ok(desktopForward.uploadId.length > 0, 'Desktop 转发形态放行并创建会话')
    const get = await clientFetch(h.origin, '/_dsh/uploader/pick-file')
    assert.equal(get.status, 405)
  } finally {
    await h.close()
  }
})

/** transferEncoding 由 Node 运行时支持，@types/node 22 尚未声明；测试侧补齐请求参数类型。 */
interface ChunkedRequestOptions extends RequestOptions {
  transferEncoding: 'chunked'
}

/** 模拟 Desktop 转发的 chunked 上传：流式 write，避免 Node 按 buffer 长度自动补 content-length。 */
function chunkedUpload(origin: string, headers: Record<string, string>, body: Uint8Array): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${origin}/_dsh/uploader/uploadStart`)
    const options: ChunkedRequestOptions = {
      host: url.hostname, port: url.port, path: url.pathname, method: 'POST', transferEncoding: 'chunked', headers,
    }
    const req = httpRequest(
      options,
      res => { void res.resume(); resolve(res.statusCode ?? 0) },
    )
    req.on('error', reject)
    // write + end（而非 end(body)）：end(buffer) 会按长度自动补 content-length，
    // 覆盖 chunked 意图导致用例不命中「无 content-length」分支。
    req.write(body)
    req.end()
  })
}

test('uploadStart 接受 chunked 无 content-length 传输（Desktop 转发形态）', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { uploadId: string }
    // Chromium 流式转发剔除 content-length（fetch forbidden header）→ chunked
    // 无该头；声明的字节数完整性由 staging 兜底校验，此处应放行。
    const status = await chunkedUpload(h.origin, {
      origin: ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'image/png',
      'x-yootun-upload-id': pick.uploadId,
      'x-yootun-filename': 'a.png',
      'x-yootun-content-type': 'image/png',
      'x-yootun-size': '4096',
    }, pngBytes(4096))
    assert.equal(status, 200, 'chunked 无 content-length 放行')
  } finally {
    await h.close()
  }
})

test('uploadStart 对 content-length 与声明 size 不符仍拒绝（防截断语义保留）', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { uploadId: string }
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(`${h.origin}/_dsh/uploader/uploadStart`)
      const req = httpRequest(
        {
          host: url.hostname, port: url.port, path: url.pathname, method: 'POST',
          headers: {
            origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'image/png',
            'x-yootun-upload-id': pick.uploadId, 'x-yootun-filename': 'a.png', 'x-yootun-content-type': 'image/png',
            'x-yootun-size': '4096', 'content-length': '100',
          },
        },
        res => { void res.resume(); resolve(res.statusCode ?? 0) },
      )
      req.on('error', reject)
      req.end(pngBytes(4096))
    })
    assert.equal(status, 400, 'content-length ≠ 声明 size 拒绝')
  } finally {
    await h.close()
  }
})

test('permitted：Desktop 转发双头缺失放行，标记语义与 wx/xhs connection fence 对齐', () => {
  const req = (headers: Record<string, unknown>, remote = '127.0.0.1'): IncomingMessage =>
    ({ socket: { remoteAddress: remote }, headers }) as IncomingMessage
  // 双头缺失放行（Desktop 转发形态）；loopback 各地址形态等价。
  assert.equal(permitted(req({}), ORIGIN), true)
  assert.equal(permitted(req({}, '::1'), ORIGIN), true)
  assert.equal(permitted(req({}, '::ffff:127.0.0.1'), ORIGIN), true)
  // 显式同源标记放行。
  assert.equal(permitted(req({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }), ORIGIN), true)
  // 显式 sec-fetch-site: cross-site 一律拒绝（无论 Origin 是否同源）。
  assert.equal(permitted(req({ 'sec-fetch-site': 'cross-site' }), ORIGIN), false)
  assert.equal(permitted(req({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }), ORIGIN), false)
  // 显式 Origin 必须精确匹配：字面 null 与异源拒绝。
  assert.equal(permitted(req({ origin: 'null' }), ORIGIN), false)
  assert.equal(permitted(req({ origin: 'https://evil.example' }), ORIGIN), false)
  // 非 loopback 拒绝。
  assert.equal(permitted(req({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }, '10.0.0.1'), ORIGIN), false)
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
    const fake = new Uint8Array(512).fill(0x41)
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

test('授权被服务端拒绝映射稳定码（UNAUTHORIZED → uploader_not_configured）', async () => {
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
    assert.equal(snapshot?.error, 'uploader_not_configured')
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
    const schema = ctx.tools.schemas().find(entry => entry.name === 'media_upload')
    assert.ok(schema !== undefined, 'media_upload 已注册')
    const { properties } = schema.parameters
    if (typeof properties !== 'object' || properties === null) throw new Error('media_upload schema 缺 properties 表')
    assert.equal('kind' in properties, true, '参数只有 kind 档位')
    assert.equal('path' in properties, false, 'schema 无路径参数')
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

test('真实 Tools error.code 嵌套 envelope 的稳定映射', async () => {
  // mapServerErrorCode：UNAUTHORIZED → uploader_not_configured（mount-restore/upload-experience 2.2）。
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'UNAUTHORIZED', message: 'x', retryable: false, requestId: null } }), 'uploader_not_configured')
  // UPLOAD_SIZE_EXCEEDED → file_too_large。
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'UPLOAD_SIZE_EXCEEDED', message: 'x', retryable: false, requestId: null } }), 'file_too_large')
  // STORAGE_UNAVAILABLE → storage_unavailable。
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'STORAGE_UNAVAILABLE', message: 'x', retryable: true, requestId: null } }), 'storage_unavailable')
  // 未知 code 安全 fallback。
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'SOMETHING_NEW', message: 'x', retryable: false, requestId: null } }), 'upload_authorization_invalid')
  // 顶层 code 兼容保留。
  assert.equal(MediaUpload.mapServerErrorCode({ code: 'UNAUTHORIZED' }), 'uploader_not_configured')

  // 集成：嵌套 UNAUTHORIZED envelope → 授权失败 → uploader_not_configured。
  const tos = await startFakeTos()
  const h = await harness({
    workbench: fakeWorkbench({ tos, reject: { code: 'workbench_call_failed', payload: { error: { code: 'UNAUTHORIZED', message: 'denied', retryable: false, requestId: null } } } }),
  })
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
    assert.equal(snapshot?.error, 'uploader_not_configured')
  } finally {
    await h.close()
    await tos.close()
  }
})

test('连接器传输新码的授权映射（2026-11-26，分册 08 §5.2）', async () => {
  const awaitFailure = async (h: Awaited<ReturnType<typeof harness>>, uploadId: string): Promise<MediaUpload.UploadSnapshot | undefined> => {
    let snapshot: MediaUpload.UploadSnapshot | undefined
    for (let i = 0; i < 40; i += 1) {
      snapshot = h.state.registry.snapshot(uploadId)
      if (snapshot?.state === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return snapshot
  }
  const pushBytes = async (origin: string, uploadId: string): Promise<void> => {
    const bytes = pngBytes(128)
    await clientFetch(origin, '/_dsh/uploader/uploadStart', {
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
  }
  // workbench_unauthorized（密钥被拒）与 not_activated / tool_denied 同映射：未配置。
  const tosUnauthorized = await startFakeTos()
  const hUnauthorized = await harness({
    workbench: fakeWorkbench({ tos: tosUnauthorized, reject: { code: 'workbench_unauthorized' } }),
  })
  try {
    const pick = await (await clientFetch(hUnauthorized.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    await pushBytes(hUnauthorized.origin, pick.uploadId)
    const snapshot = await awaitFailure(hUnauthorized, pick.uploadId)
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'uploader_not_configured')
  } finally {
    await hUnauthorized.close()
    await tosUnauthorized.close()
  }
  // workbench_server_error 与网络错误同映射：存储不可用。
  const tosServer = await startFakeTos()
  const hServer = await harness({
    workbench: fakeWorkbench({ tos: tosServer, reject: { code: 'workbench_server_error' } }),
  })
  try {
    const pick = await (await clientFetch(hServer.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    await pushBytes(hServer.origin, pick.uploadId)
    const snapshot = await awaitFailure(hServer, pick.uploadId)
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'storage_unavailable')
  } finally {
    await hServer.close()
    await tosServer.close()
  }
})

test('pick-file 与 uploadStatus 拒绝未知字段（正反两向）', async () => {
  const h = await harness()
  try {
    // 正向：合法体通过。
    const ok = await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })
    assert.equal(ok.status, 200)
    // 负向：未知字段拒绝。
    const extra = await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image', path: '/etc/passwd' }),
    })
    assert.equal(extra.status, 400)
    assert.deepEqual(await extra.json(), { error: 'invalid_request' })
    const pick = await ok.json() as { uploadId: string }
    // uploadStatus 正向。
    const statusOk = await clientFetch(h.origin, '/_dsh/uploader/uploadStatus', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: pick.uploadId }),
    })
    assert.equal(statusOk.status, 200)
    // uploadStatus 负向：未知字段拒绝。
    const statusExtra = await clientFetch(h.origin, '/_dsh/uploader/uploadStatus', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: pick.uploadId, verbose: true }),
    })
    assert.equal(statusExtra.status, 400)
    assert.deepEqual(await statusExtra.json(), { error: 'invalid_request' })
  } finally {
    await h.close()
  }
})

test('media_upload 输出 schema 收紧为 additionalProperties:false', async () => {
  const tos = await startFakeTos()
  const ctx = new Context()
  const wb = fakeWorkbench({ tos })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: 1024 * 1024 }, undefined)
  const deps = { ...state.deps, transport: 'loopback-test' } as UploaderDeps
  ctx.reflect.provide('webServer', { getOrigin: () => ORIGIN, register: () => () => undefined })
  ctx.reflect.provide('yootunWorkbench', wb)
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    // 捕获注册定义，断言 output.schema 与导出常量同一引用（防止未来换回
    // 内联 additionalProperties:true 字面量而测试仍绿）。
    const registeredDefinitions: Array<{ name: string; output: { schema: unknown } }> = []
    const originalRegister = ctx.tools.register.bind(ctx.tools)
    const capturingRegister = (definition: Parameters<typeof originalRegister>[0]): (() => void) => {
      registeredDefinitions.push(definition)
      return originalRegister(definition)
    }
    ctx.tools.register = capturingRegister as typeof ctx.tools.register
    await ctx.plugin({ inject: ['tools'], apply: scope => { MediaUpload.applyUploaderWiring(scope, deps, 30_000) } })
    const definition = registeredDefinitions.find(entry => entry.name === 'media_upload')
    assert.ok(definition !== undefined, 'media_upload 定义被捕获')
    assert.equal(definition.output.schema, MediaUpload.MEDIA_UPLOAD_OUTPUT_SCHEMA, 'output.schema 与导出常量同一引用')
    assert.equal(MediaUpload.MEDIA_UPLOAD_OUTPUT_SCHEMA.additionalProperties, false)
    assert.deepEqual(Object.keys(MediaUpload.MEDIA_UPLOAD_OUTPUT_SCHEMA.properties).sort(), ['contentType', 'error', 'name', 'ok', 'size', 'url'])
  } finally {
    state.registry.destroy()
    await state.staging.destroy()
    await ctx.fiber.dispose()
    await tos.close()
  }
})

test('插件 dispose 等待异步清理：真实 apply 路由可用、暂存目录被删除', async () => {
  // 生产组合（真实 ctx.plugin(MediaUpload)，含生产 disposal effect）：
  // fake webServer 捕获插件注册的路由并起本地 server 供浏览器侧调用；
  // 悬挂 TOS 让暂存文件在卸载时仍存在，dispose 的 Promise 必须等到暂存
  // 删除完成（若生产 wiring 回退为不等待，本测试即失败）。
  const tos = await makeHangingTos()
  const ctx = new Context()
  const wb = fakeWorkbench({ tos })
  const registeredRoutes: Array<{ path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }> = []
  const before = stagingDirs()
  ctx.reflect.provide('webServer', {
    getOrigin: () => ORIGIN,
    register: (route: { path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> }) => {
      registeredRoutes.push(route)
      return () => undefined
    },
  })
  ctx.reflect.provide('yootunWorkbench', wb)
  let browser: Awaited<ReturnType<typeof startRouteServer>> | undefined
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(MediaUpload)
    assert.equal(registeredRoutes.length, 6, '真实 apply 注册六条上传路由（含 pending/cancel）')
    // 路由捕获完成后才起本地 server。
    browser = await startRouteServer(registeredRoutes)
    const pick = await (await clientFetch(browser.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }
    const bytes = pngBytes(256)
    await clientFetch(browser.origin, '/_dsh/uploader/uploadStart', {
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
    // 悬挂 PUT 期间：生产链路产生的暂存目录存在。
    const during = stagingDirs().filter(dir => !before.includes(dir))
    assert.equal(during.length, 1, '暂存目录在卸载前存在')
    // dispose：fiber 卸载 await 生产异步清理；返回时暂存目录必须已被删除。
    await ctx.fiber.dispose()
    const after = stagingDirs().filter(dir => !before.includes(dir))
    assert.equal(after.length, 0, 'dispose 完成后暂存目录已删除（无孤儿）')
  } finally {
    if (browser !== undefined) await browser.close()
    await tos.close()
  }
})

/** 扫描系统临时目录下的 yootun-media-* 前缀目录。 */
function stagingDirs(): string[] {
  return readdirSync(tmpdir()).filter(name => name.startsWith('yootun-media-')).map(name => `${tmpdir()}/${name}`)
}

test('dispose 等 staging 在途请求 settle：handler-settled 先于 dispose-done', async () => {
  // 真实 apply 组合（生产 disposal effect）；uploadStart 用异步 body：
  // 先发 PNG 头部让 handler 卡在 staging.stage()，期间启动 dispose，
  // 再释放剩余 body——destroy 的 admission 等待保证 handler 先 settle。
  const tos = await startFakeTos()
  const ctx = new Context()
  const wb = fakeWorkbench({ tos })
  const before = stagingDirs()
  const registeredRoutes: MediaUpload.UploadRoute[] = []
  // 捕获会话稳定投影：abort 销毁 socket 后 409 响应不可达（res.statusCode
  // 在 close 时仍是缺省 200），会话投影码才是 handler 的真实落点。
  const settleCodes: string[] = []
  const regProto = MediaUpload.UploadSessionRegistry.prototype as unknown as {
    settleFailed: (session: unknown, code: string) => void
  }
  const trueSettle = regProto.settleFailed
  regProto.settleFailed = function (session: unknown, code: string) {
    settleCodes.push(code)
    trueSettle.call(this, session, code)
  }
  // 测试结束恢复原型（P2：patch 不得泄漏到其他用例）。
  const restoreSettle = (): void => { regProto.settleFailed = trueSettle }
  ctx.reflect.provide('webServer', {
    getOrigin: () => ORIGIN,
    register: (route: MediaUpload.UploadRoute) => {
      registeredRoutes.push(route)
      return () => undefined
    },
  })
  ctx.reflect.provide('yootunWorkbench', wb)
  const { createServer, request: httpRequest } = await import('node:http')
  // 懒查找：server 先起、路由在插件注册后生效；uploadStart 在服务端分发后
  // 握手（beginRequest 已同步准入），随后才启动 dispose。
  let arriveResolve: (() => void) | undefined
  const arrived = new Promise<void>(resolve => { arriveResolve = resolve })
  const server = createServer((req, res) => {
    const path = req.url?.split('?')[0] ?? ''
    const route = registeredRoutes.find(candidate => candidate.path === path)
    if (route === undefined) { res.statusCode = 404; res.end(); return }
    const dispatched = route.handler(req as import('node:http').IncomingMessage, res as import('node:http').ServerResponse)
    if (path === '/_dsh/uploader/uploadStart') {
      arriveResolve?.()
      // handler 落定在服务端响应 finish/close 时刻（abort 会销毁 socket，
      // 客户端不可达，必须在服务端观测）。
      res.on('finish', () => { events.push('handler-settled'); handlerResolve({ statusCode: res.statusCode, body: { error: 'observed' } }) })
      res.on('close', () => { events.push('handler-settled'); handlerResolve({ statusCode: res.statusCode, body: { error: 'observed' } }) })
    }
    void dispatched.catch(() => undefined)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const origin = `http://127.0.0.1:${String(port)}`
  const events: string[] = []
  let arrivalWired = false
  let handlerResolve: (value: { statusCode: number | undefined; body: Record<string, unknown> }) => void = () => undefined
  const handlerSettled = new Promise<{ statusCode: number | undefined; body: Record<string, unknown> }>(resolve => { handlerResolve = resolve })
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(MediaUpload)
    assert.equal(registeredRoutes.length, 6)

    // 1. pick-file 创建会话。
    const pick = await (await clientFetch(origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image' }),
    })).json() as { uploadId: string }

    // 2-3. uploadStart 异步 body：只发 PNG 头部（8 字节），handler 卡在 stage。
    const bytes = pngBytes(256)
    const req = httpRequest({
      host: '127.0.0.1', port, method: 'POST', path: '/_dsh/uploader/uploadStart',
      headers: {
        origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream',
        'x-yootun-upload-id': pick.uploadId, 'x-yootun-filename': 'photo.png',
        'x-yootun-content-type': 'image/png', 'x-yootun-size': String(bytes.byteLength),
        'content-length': String(bytes.byteLength),
      },
    })
    req.on('error', () => undefined)
    req.write(bytes.subarray(0, 8))
    // 4. 服务端准入后启动 dispose（不 await）；stage 此刻卡在等剩余字节。
    void arrived.then(async () => {
      if (arrivalWired) return
      arrivalWired = true
      const disposePromise = ctx.fiber.dispose().then(() => { events.push('dispose-done') })
      // 5. 释放剩余 body（流可能已被中止销毁，错误已吞）。
      await new Promise(resolve => setTimeout(resolve, 50))
      req.end(bytes.subarray(8))
      await disposePromise
    })

    // 6. 顺序断言：handler-settled 先于 dispose-done。
    const outcome = await handlerSettled
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(events, ['handler-settled', 'dispose-done'])

    // 7. handler 稳定投影：会话被 dispose 中止 → upload_cancelled（409
    //    语义），不得变成 upload_failed（500 语义）。socket 已被中止销毁，
    //    响应不可达；settleFailed 的会话投影码即 handler 的落点。
    assert.equal(settleCodes.includes('upload_cancelled'), true, 'dispose 中止投影 upload_cancelled')
    assert.equal(settleCodes.includes('upload_failed'), false, '不得退化为 upload_failed')
    void outcome

    // 8. dispose 完成后暂存目录为 0（等待发生在 disposal effect 内）。
    const after = stagingDirs().filter(dir => !before.includes(dir))
    assert.equal(after.length, 0, 'dispose 完成后暂存目录已删除（无孤儿）')
  } finally {
    // 第一行同步恢复原型：即使后续 close 抛错，settleFailed patch 也不泄漏。
    restoreSettle()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await tos.close()
  }
})

test('admission 生命周期：release 即出集合，destroy 后拒绝新请求', async () => {
  const staging = new MediaUpload.StagingArea()
  const registry = new MediaUpload.UploadSessionRegistry({ staging, sweepMs: 0 })
  try {
    // 三次 begin/release（uploadStatus 轮询形态）：每次 begin 计 1、release 归零。
    for (let i = 0; i < 3; i += 1) {
      const admission = registry.beginRequest()
      assert.ok(admission !== undefined)
      assert.equal(registry.activeRequestCount, 1)
      admission.release()
      assert.equal(registry.activeRequestCount, 0)
    }
    // 未 release 的 admission 计 1，release 后归零。
    const pending = registry.beginRequest()
    assert.ok(pending !== undefined)
    assert.equal(registry.activeRequestCount, 1)
    pending.release()
    assert.equal(registry.activeRequestCount, 0)
    // release 幂等：重复释放不重复 resolve、不复活计数。
    const once = registry.beginRequest()
    once?.release()
    once?.release()
    assert.equal(registry.activeRequestCount, 0)

    // destroy 后 beginRequest 拒绝新请求。
    await registry.destroy()
    assert.equal(registry.beginRequest(), undefined)
    assert.equal(registry.activeRequestCount, 0)
    await staging.destroy()
  } finally {
    registry.destroy()
    await staging.destroy()
  }
})

// ---------------------------------------------------------------------------
// 承接卡片 Host 面（实施单附录 B.1 H1–H8）：会话来源、pending 投影与加固、
// cancel 取消语义（终态先行、暂存清理、终态不可改写）、exec 标识投影、
// dispose 后拒绝。

/** uploadStart 便捷封装：把 PNG 字节推进一个会话（新测试共用）。 */
async function pushBytes(origin: string, uploadId: string, size = 256): Promise<void> {
  const bytes = pngBytes(size)
  await clientFetch(origin, '/_dsh/uploader/uploadStart', {
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
}

/** 轮询等待工具创建的 tool 会话出现，返回 uploadId（超时返回空串）。 */
async function waitForToolSession(registry: UploadSessionRegistry, kind = 'media'): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const id = registry.ids().find(candidate => {
      const live = registry.getLive(candidate)
      return live?.origin === 'tool' && live.kind === kind
    }) ?? ''
    if (id !== '') return id
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return ''
}

/** 真实工具组合：Context + 假授权/假 TOS + 路由服务器 + applyUploaderWiring。 */
async function toolHarness(options: { tos?: FakeTos } = {}): Promise<{
  ctx: Context
  registry: UploadSessionRegistry
  origin: string
  dispose: () => Promise<void>
}> {
  const tos = options.tos ?? await startFakeTos()
  const wb = fakeWorkbench({ tos })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: 1024 * 1024 }, undefined)
  const deps = { ...state.deps, transport: 'loopback-test' } as UploaderDeps
  const routes: MediaUpload.UploadRoute[] = MediaUpload.uploaderRoutes(deps)
  const ctx = new Context()
  ctx.reflect.provide('webServer', { getOrigin: () => ORIGIN, register: () => () => undefined })
  ctx.reflect.provide('yootunWorkbench', wb)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin({ inject: ['tools'], apply: scope => { MediaUpload.applyUploaderWiring(scope, deps, 30_000) } })
  const browser = await startRouteServer(routes)
  return {
    ctx,
    registry: state.registry,
    origin: browser.origin,
    dispose: async () => {
      await browser.close()
      state.registry.destroy()
      await state.staging.destroy()
      await ctx.fiber.dispose()
      await tos.close()
    },
  }
}

test('H1 会话来源：pick-file 会话 origin page，工具与显式 tool 创建为 tool', async () => {
  const h = await harness()
  try {
    const pick = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as { uploadId: string }
    assert.equal(h.state.registry.getLive(pick.uploadId)?.origin, 'page', 'pick-file 会话来自页面')
    // 缺省 origin 保持 page（既有调用点不改也能通过）。
    assert.equal(h.state.registry.create('image').origin, 'page')
    assert.equal(h.state.registry.create('image', 'tool').origin, 'tool')
  } finally {
    await h.close()
  }
})

test('H2 pending 投影：只含 tool 会话的 waiting/uploading，升序，无敏感字段', async () => {
  const h = await harness({ tos: await makeHangingTos() })
  try {
    // page 会话：不得出现在投影。
    const page = await (await clientFetch(h.origin, '/_dsh/uploader/pick-file', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).json() as { uploadId: string }
    // tool 会话 a（waiting）、b（uploading，悬挂 PUT）、c（已取消终态）。
    const a = h.state.registry.create('image', 'tool')
    const b = h.state.registry.create('image', 'tool')
    await pushBytes(h.origin, b.id)
    const c = h.state.registry.create('image', 'tool')
    assert.equal(h.state.registry.cancel(c.id), 'cancelled')

    const response = await clientFetch(h.origin, '/_dsh/uploader/pending', { method: 'POST' })
    assert.equal(response.status, 200)
    const body = await response.json() as { sessions: Array<Record<string, unknown>> }
    assert.deepEqual(body.sessions.map(session => session.uploadId), [a.id, b.id], '只含 tool 且未终态的会话，按创建时间升序')
    assert.equal(body.sessions[0]?.state, 'waiting')
    assert.equal(body.sessions[1]?.state, 'uploading')
    assert.equal(body.sessions[0]?.progress, 0, 'waiting 会话尚未绑定字节，进度 0')
    for (const session of body.sessions) {
      assert.deepEqual(Object.keys(session).sort(), ['createdAt', 'kind', 'progress', 'state', 'uploadId'], '无 context 时省略键，无 name/size/URL')
    }
    const serialized = JSON.stringify(body)
    assert.ok(!serialized.includes('should-never-leak'), '投影不含预签名 URL')
    assert.ok(!serialized.includes('/tmp/'), '投影不含本地路径')
    assert.ok(!serialized.includes('"name"'), '投影不含文件名')
    assert.ok(!ids(body.sessions).includes(page.uploadId), 'page 会话不在投影')
    assert.ok(!ids(body.sessions).includes(c.id), '终态会话不在投影')
  } finally {
    await h.close()
  }
})

/** 会话投影 uploadId 列表。 */
function ids(sessions: Array<Record<string, unknown>>): string[] {
  return sessions.map(session => String(session.uploadId))
}

test('H3 pending 加固：非 POST 405、不信任来源 403、有体含字段 400', async () => {
  const h = await harness()
  try {
    const get = await clientFetch(h.origin, '/_dsh/uploader/pending')
    assert.equal(get.status, 405)
    const foreign = await fetch(`${h.origin}/_dsh/uploader/pending`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    assert.equal(foreign.status, 403)
    const extra = await clientFetch(h.origin, '/_dsh/uploader/pending', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verbose: true }),
    })
    assert.equal(extra.status, 400)
    assert.deepEqual(await extra.json(), { error: 'invalid_request' })
    // 空对象体与无体同样放行（只读路由的体可省略）。
    const empty = await clientFetch(h.origin, '/_dsh/uploader/pending', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(empty.status, 200)
  } finally {
    await h.close()
  }
})

test('H4 cancel 取消 awaiting 会话：cancelled true、工具返回 user_cancelled、终态不被改写', async () => {
  const h = await toolHarness()
  try {
    const startedAt = Date.now()
    const batch = h.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('media-cancel-1'), name: 'media_upload', arguments: '{}' },
      ],
    })
    const uploadId = await waitForToolSession(h.registry)
    assert.ok(uploadId !== '', '工具创建了上传会话')
    const cancel = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }),
    })
    assert.equal(cancel.status, 200)
    assert.deepEqual(await cancel.json(), { cancelled: true })
    const result = (await batch).results[0]?.result as { isError: boolean; value?: { ok: boolean; error?: string } }
    assert.equal(result.isError, false, '取消是工具正常返回')
    assert.equal(result.value?.ok, false)
    assert.equal(result.value?.error, 'user_cancelled')
    assert.ok(Date.now() - startedAt < 2000, '工具在 2 秒内拿到取消结果')
    const snapshot = h.registry.snapshot(uploadId)
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'user_cancelled')
    // 后到的超时回调（模拟 30 分钟预算或 sweep 先落 cancel 的竞态反面）不得改写终态码。
    const live = h.registry.getLive(uploadId)
    assert.ok(live !== undefined)
    h.registry.settleFailed(live, 'upload_timeout')
    assert.equal(h.registry.snapshot(uploadId)?.error, 'user_cancelled', 'settle 幂等挡住后到回调')
  } finally {
    await h.dispose()
  }
})

test('H5 cancel 取消 uploading 会话：中止 PUT，暂存文件按失败路径清理', async () => {
  const h = await harness({ tos: await makeHangingTos() })
  try {
    const session = h.state.registry.create('image', 'tool')
    await pushBytes(h.origin, session.id)
    const live = h.state.registry.getLive(session.id)
    assert.equal(live?.state, 'uploading')
    const stagedPath = live?.staged?.path
    assert.ok(stagedPath !== undefined && stagedPath !== '', '悬挂上传期间暂存文件存在')

    const cancel = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: session.id }),
    })
    assert.equal(cancel.status, 200)
    assert.deepEqual(await cancel.json(), { cancelled: true })
    // 失败路径异步清理暂存：等文件真正落盘删除（rm 完成晚于 staged 摘除）。
    const deadline = Date.now() + 5000
    let snapshot: MediaUpload.UploadSnapshot | undefined
    while (Date.now() < deadline) {
      snapshot = h.state.registry.snapshot(session.id)
      if (snapshot?.state === 'failed' && !existsSync(stagedPath)) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(snapshot?.state, 'failed')
    assert.equal(snapshot?.error, 'user_cancelled', '先落的取消码不被管线后到的 abort 改写')
    assert.equal(h.state.registry.getLive(session.id)?.staged, undefined)
    assert.equal(existsSync(stagedPath), false, '暂存文件已删除（无孤儿）')
  } finally {
    await h.close()
  }
})

test('H6 cancel 边界：终态 not_running、未知 id 403 session_not_found、未知字段 400', async () => {
  const h = await harness()
  try {
    const session = h.state.registry.create('image', 'tool')
    assert.equal(h.state.registry.cancel(session.id), 'cancelled')
    const again = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: session.id }),
    })
    assert.equal(again.status, 200)
    assert.deepEqual(await again.json(), { cancelled: false, reason: 'not_running' })
    const unknown = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: 'nope' }),
    })
    assert.equal(unknown.status, 403)
    assert.deepEqual(await unknown.json(), { error: 'session_not_found' })
    const extra = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: session.id, force: true }),
    })
    assert.equal(extra.status, 400)
    assert.deepEqual(await extra.json(), { error: 'invalid_request' })
  } finally {
    await h.close()
  }
})

test('H7 pending 投影携带 exec 标识：工具会话带 context.toolCallId，缺省省略键；工具会话 origin tool', async () => {
  const h = await toolHarness()
  try {
    const batch = h.ctx.tools.execute({
      signal: new AbortController().signal,
      calls: [
        { type: 'tool-call' as const, id: brandString<ToolCallId>('media-ctx-1'), name: 'media_upload', arguments: JSON.stringify({ kind: 'image' }) },
      ],
    })
    const uploadId = await waitForToolSession(h.registry, 'image')
    assert.ok(uploadId !== '', '工具创建了上传会话')
    assert.equal(h.registry.getLive(uploadId)?.origin, 'tool', '工具创建的会话来源 tool（H1 工具侧）')
    const response = await clientFetch(h.origin, '/_dsh/uploader/pending', { method: 'POST' })
    const body = await response.json() as { sessions: Array<{ uploadId: string; context?: Record<string, unknown> }> }
    const mine = body.sessions.find(session => session.uploadId === uploadId)
    assert.deepEqual(mine?.context, { toolCallId: 'media-ctx-1' }, 'exec 的调用标识进入 context')
    // registry 直接创建、不提供 context：投影省略 context 键。
    const bare = h.registry.create('image', 'tool')
    const bareResponse = await clientFetch(h.origin, '/_dsh/uploader/pending', { method: 'POST' })
    const bareBody = await bareResponse.json() as { sessions: Array<Record<string, unknown>> }
    const bareProjection = bareBody.sessions.find(session => session.uploadId === bare.id)
    assert.ok(bareProjection !== undefined)
    assert.equal('context' in bareProjection, false, '无标识时省略 context 键')
    // 收尾：取消让工具返回，不留悬挂 promise。
    await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId }),
    })
    await batch
  } finally {
    await h.dispose()
  }
})

test('H8 dispose 后 pending / cancel 返回 503 uploader_not_configured', async () => {
  const h = await harness()
  try {
    await h.state.registry.destroy()
    const pending = await clientFetch(h.origin, '/_dsh/uploader/pending', { method: 'POST' })
    assert.equal(pending.status, 503)
    assert.deepEqual(await pending.json(), { error: 'uploader_not_configured' })
    const cancel = await clientFetch(h.origin, '/_dsh/uploader/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: 'whatever' }),
    })
    assert.equal(cancel.status, 503)
    assert.deepEqual(await cancel.json(), { error: 'uploader_not_configured' })
    assert.equal(h.state.registry.ids().length, 0, 'dispose 后不触碰会话（已清空）')
  } finally {
    await h.close()
  }
})

// --- 附录 B（upload-experience-fixes）：D1/D2 TTL、E1/E2 错误映射、T1–T5 暂存清理、F1–F4 内网过滤 ---

test('D1/D2 注入时钟：done 9 分钟可查、11 分钟 not_found；failed 与 done 同保留', () => {
  let clock = Date.now()
  // 不显式传 doneTtlMs：断言作用于 DEFAULT_DONE_TTL_MS 缺省（60s→10min 的
  // 回退由此用例拦截）。
  const registry = new MediaUpload.UploadSessionRegistry({
    staging: new MediaUpload.StagingArea(),
    now: () => clock,
  })
  try {
    const done = registry.create('image')
    done.settle('done', { url: 'https://storage.example/u.png' })
    clock += 9 * 60_000
    assert.equal(registry.snapshot(done.id)?.state, 'done', 'D1：9 分钟后仍可查')
    clock += 2 * 60_000
    assert.equal(registry.snapshot(done.id), undefined, 'D1：11 分钟后过期 not_found')

    const failed = registry.create('image')
    failed.settle('failed', { errorCode: 'upload_timeout' })
    clock += 9 * 60_000
    assert.equal(registry.snapshot(failed.id)?.state, 'failed', 'D2：failed 与 done 同保留（9 分钟可查）')
    clock += 2 * 60_000
    assert.equal(registry.snapshot(failed.id), undefined, 'D2：failed 11 分钟后过期')
  } finally {
    registry.destroy()
  }
})

test('E1/E2 mapServerErrorCode：UNAUTHORIZED → uploader_not_configured；STORAGE_AUTH_FAILED 两种形态', () => {
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'UNAUTHORIZED' } }), 'uploader_not_configured', 'E1：密钥问题不再是存储失败')
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'STORAGE_AUTH_FAILED' } }), 'storage_auth_failed')
  assert.equal(MediaUpload.mapServerErrorCode({ code: 'STORAGE_AUTH_FAILED' }), 'storage_auth_failed', 'E2：顶层形态')
  assert.equal(MediaUpload.mapServerErrorCode({ error: { code: 'STORAGE_UNAVAILABLE' } }), 'storage_unavailable', '不变项回归')
})

test('T1 暂存目录名含当前进程号；同一暂存区两次 stage 得到同一目录', async () => {
  const { dirname } = await import('node:path')
  const staging = new MediaUpload.StagingArea()
  /** 预缓冲的假请求体：stage 的参数类型是请求消息，假体装同一份 PNG 字节后立即封口。 */
  const fakeBody = (): IncomingMessage => {
    const message = new IncomingMessage(new Socket())
    message.push(pngBytes(64))
    message.push(null)
    return message
  }
  try {
    const first = await staging.stage(fakeBody(), 64, 'image/png')
    const second = await staging.stage(fakeBody(), 64, 'image/png')
    const marker = `yootun-media-${String(process.pid)}-`
    assert.ok(first.path.includes(marker), `目录名含进程号：${first.path}`)
    assert.equal(dirname(first.path), dirname(second.path), '同一暂存区两次创建同一目录')
  } finally {
    await staging.destroy()
  }
})

test('T2/T3/T4/T5 启动清理：pid 判定 + 旧命名 24h + 前缀限定 + 失败告警继续', async () => {
  const { mkdtemp, mkdir, writeFile, utimes } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const tmp = await mkdtemp(join(tmpdir(), 'wx-sweep-test-'))
  try {
    // 目标目录：不存在的 pid；当前进程 pid；旧命名 25 小时前；旧命名 1 小时前；非前缀目录。
    const deadDir = join(tmp, 'yootun-media-999999-abc')
    const aliveDir = join(tmp, `yootun-media-${String(process.pid)}-alive`)
    const legacyOld = join(tmp, 'yootun-media-olddead')
    const legacyNew = join(tmp, 'yootun-media-oldfresh')
    const foreign = join(tmp, 'not-yootun-media-other')
    for (const dir of [deadDir, aliveDir, legacyOld, legacyNew, foreign]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'f.txt'), 'x')
    }
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
    const freshTime = new Date(Date.now() - 1 * 60 * 60 * 1000)
    await utimes(legacyOld, oldTime, oldTime)
    await utimes(legacyNew, freshTime, freshTime)

    let warned = 0
    const result = await MediaUpload.sweepStaleStagingDirs({
      tmpDir: tmp,
      isAlive: pid => pid === process.pid,
      warn: () => { warned += 1 },
    })
    assert.equal(result.removed, 2, `删除：死 pid 目录 + 25 小时旧命名目录（实际 ${String(result.removed)}）`)
    assert.equal(result.kept, 2, `保留：存活 pid + 1 小时内旧命名（非前缀目录不进计数；实际 ${String(result.kept)}）`)
    assert.equal(existsSync(deadDir), false, 'T2：不存在的 pid 目录被删除')
    assert.equal(existsSync(aliveDir), true, 'T2：存活 pid 目录保留')
    assert.equal(existsSync(legacyOld), false, 'T3：24 小时外旧命名删除')
    assert.equal(existsSync(legacyNew), true, 'T3：24 小时内旧命名保留')
    assert.equal(existsSync(foreign), true, 'T4：非前缀目录不动')
    assert.equal(warned, 0)

    // T5：某项删除失败（把死 pid 目录换成同名文件使 rm 递归删除仍成功——改用只读方式不可靠，
    // 这里以 tmpDir 读失败路径验证告警与计数不抛）。
    const broken = await MediaUpload.sweepStaleStagingDirs({ tmpDir: join(tmp, 'missing-subdir'), warn: () => { warned += 1 } })
    assert.deepEqual(broken, { removed: 0, kept: 0 }, '读目录失败返回零计数')
    assert.equal(warned >= 1, true, '读目录失败记一条告警')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('T5 sweep 逐项删除失败：每项告警、继续处理其余、失败项计 kept', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wx-sweep-t5-'))
  const deadA = join(tmp, 'yootun-media-999999-a')
  const deadB = join(tmp, 'yootun-media-999998-b')
  mkdirSync(deadA)
  writeFileSync(join(deadA, 'f'), 'x')
  mkdirSync(deadB)
  writeFileSync(join(deadB, 'f'), 'x')
  const warns: string[] = []
  // r-x：readdir 可用；rm/unlink 需 w+x，两项删除都会失败。
  chmodSync(tmp, 0o555)
  let result: { removed: number; kept: number }
  try {
    result = await MediaUpload.sweepStaleStagingDirs({ tmpDir: tmp, isAlive: () => false, warn: m => warns.push(m) })
  } finally {
    chmodSync(tmp, 0o755)
  }
  assert.deepEqual(result, { removed: 0, kept: 2 }, '失败项计入 kept，不抛')
  assert.equal(warns.length, 2, '每项删除失败各记一条告警')
  assert.equal(existsSync(deadA), true, '失败项保留原样')
  assert.equal(existsSync(deadB), true)
  rmSync(tmp, { recursive: true, force: true })
})

test('isForbiddenPublicHost 边界现状：mapped 大小写与 link-local 带区拒绝', () => {
  assert.equal(MediaUpload.isForbiddenPublicHost('::FFFF:10.0.0.1'), true, '大写 FFFF 的 mapped 形拒绝')
  assert.equal(MediaUpload.isForbiddenPublicHost('[::ffff:10.0.0.1]'), true, '方括号 mapped 形拒绝')
  assert.equal(MediaUpload.isForbiddenPublicHost('fe80::1%25eth0'), true, 'link-local 带区 id 拒绝')
})

test('isForbiddenPublicHost 放行缺口现状记录（不在 2.4 表内，供后续收紧时对照）', () => {
  // `::a00:1` 为已废弃的 IPv4 兼容形、`localhost..` 为双尾点：两者均不在 2.4 表，
  // 放行是单上表格的既有口径；收紧时先修订实施单 2.4 再改此处。
  assert.equal(MediaUpload.isForbiddenPublicHost('::a00:1'), false)
  assert.equal(MediaUpload.isForbiddenPublicHost('localhost..'), false)
})

test('F1–F4 isForbiddenPublicHost 按地址块判定（含 mapped/NAT64/6to4/localhost 变体）', () => {
  const reject = (host: string): void => assert.equal(MediaUpload.isForbiddenPublicHost(host), true, host)
  const allow = (host: string): void => assert.equal(MediaUpload.isForbiddenPublicHost(host), false, host)
  // F1 主机名。
  for (const host of ['localhost', 'localhost.', 'foo.localhost', '']) reject(host)
  allow('media.example.com')
  // F2 IPv4 地址块（经 URL 解析的 hostname 形态）。
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '224.0.0.1', '240.0.0.1']) reject(ip)
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '172.32.0.1']) allow(ip)
  // F3 mapped（含 WHATWG 规范化形态）。
  for (const host of ['::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:7f00:1', '::ffff:a9fe:a9fe']) reject(host)
  // F4 IPv6。
  for (const host of ['fe90::1', 'fe80::1', 'fc00::1', '64:ff9b::a00:1', '2002:a00:1::', '::1', '::']) reject(host)
  allow('2606:4700::1111')
})

test('F5 validateAuthorizationResponse：授权地址与 publicUrl 命中过滤形态时抛 upload_authorization_invalid', () => {
  const valid: Record<string, unknown> = {
    method: 'PUT',
    url: 'https://storage.example.test/put/key',
    headers: { 'content-type': 'image/png' },
    publicUrl: 'https://media.example.test/objects/public.png',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxBytes: 1024 * 1024,
  }
  const meta = { filename: 'a.png', contentType: 'image/png', size: 128 }
  assert.doesNotThrow(() => MediaUpload.validateAuthorizationResponse({ ...valid }, meta))
  // F3 mapped：授权地址命中 ::ffff:0:0/96 → 拒绝。
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, url: 'https://[::ffff:10.0.0.1]/put' }, meta), /loopback\/private/u)
  // F1 主机名 + F4：publicUrl 命中 localhost 变体 → 拒绝。
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, publicUrl: 'https://localhost/p.png' }, meta), /loopback\/private/u)
  assert.throws(() => MediaUpload.validateAuthorizationResponse({ ...valid, publicUrl: 'https://[64:ff9b::a00:1]/p.png' }, meta), /loopback\/private/u)
})

// --- 启动清扫接线守卫（生产装配在 applyStartupStagingCleanup；缺登记 = 遗留暂存目录永不清） ---

test('启动暂存清扫接线：工厂启动即清扫；卸载按序等待 registry → staging → sweep', async () => {
  const ctx = new Context()
  // 清扫接线不触发授权；给纯内存的 TOS 桩满足 fakeWorkbench 的签名。
  const wb = fakeWorkbench({ tos: { url: '', puts: [], statusQueue: [], close: async () => undefined } })
  const state = MediaUpload.createUploaderState(() => ORIGIN, wb, { maxUploadBytes: 1024 * 1024 }, undefined)
  let sweepInvoked = 0
  let sweepSettled = false
  let releaseSweep: (() => void) | undefined
  const sweepGate = new Promise<void>(resolve => { releaseSweep = resolve })
  const order: string[] = []
  MediaUpload.applyStartupStagingCleanup(
    ctx,
    {
      registry: { destroy: async () => { order.push('registry'); await state.registry.destroy() } },
      staging: { destroy: async () => { order.push('staging'); await state.staging.destroy() } },
    },
    { warn: () => undefined },
    async () => {
      sweepInvoked += 1
      await sweepGate
      sweepSettled = true
      return { removed: [] }
    },
  )
  // 登记即清扫（启动时机，不等卸载）。
  assert.equal(sweepInvoked, 1)
  assert.equal(order.length, 0, '卸载前不 destroy')
  // 触发卸载：registry → staging 先行，sweep 未 settle 前卸载（dispose 本身）不返回。
  let disposeSettled = false
  const disposing = ctx.fiber.dispose()
  void disposing.then(() => { disposeSettled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(order, ['registry', 'staging'])
  assert.equal(sweepSettled, false, '清扫未结束，卸载等待中')
  assert.equal(disposeSettled, false, 'dispose 等待清扫 settle，不先行返回')
  releaseSweep?.()
  await disposing
  assert.equal(disposeSettled, true)
  assert.equal(sweepSettled, true)
  assert.equal(sweepInvoked, 1, '清扫只发起一次')
})
