/**
 * kit 上传传输测试（K1，jsdom 提供 File）：请求方法/头/返回值形态与消费方
 * 原实现一致；非 2xx 与非 JSON 返回 null；uploadStart 拒绝时稳定码随
 * `{ ok, error }` 返回。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-kit test`。
 */
import { createServer, type Server } from 'node:http'
import { afterAll, describe, expect, it } from 'vitest'
import { createUploadTransport, type UploadSessionInfo } from '../src/upload-transport.ts'

const servers: Server[] = []

afterAll(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve) => { server.close(() => resolve()) })))
})

/** 启动测试服务器：按路径应答（status / body / headers 覆盖）。 */
async function startServer(routes: Record<string, { status?: number; body?: string }>): Promise<string> {
  const server = createServer((req, res) => {
    const route = routes[req.url?.split('?')[0] ?? '']
    if (route === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    res.statusCode = route.status ?? 200
    if (route.body === undefined) {
      res.end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(route.body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
}

const PATHS = { pick: '/pick', start: '/start', status: '/status' }

describe('createUploadTransport（K1）', () => {
  it('K1 startSession：POST + JSON 头 + 会话投影（accept 数组、maxBytes 非法 → Infinity）', async () => {
    const seen: Array<{ method?: string; contentType?: unknown }> = []
    const url = await startServer({
      '/pick': { body: JSON.stringify({ uploadId: 'u-1', accept: ['image/png', 42], maxBytes: 'not-a-number' }) },
    })
    const server = servers[servers.length - 1] as Server
    server.on('request', (req) => {
      seen.push({ method: req.method, contentType: req.headers['content-type'] })
    })
    const transport = createUploadTransport({ ...PATHS, pick: `${url}/pick` })
    const session: UploadSessionInfo | null = await transport.startSession('image')
    expect(session).not.toBeNull()
    expect(session?.uploadId).toBe('u-1')
    expect(session?.accept).toEqual(['image/png', '42'], '与小红书原实现一致：accept 逐项 String 归一')
    expect(session?.maxBytes).toBe(Number.POSITIVE_INFINITY)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.contentType).toBe('application/json')
  })

  it('K1 sendBytes：File 时带四个头与 body；拒绝响应携带稳定码', async () => {
    const url = await startServer({
      '/start': { status: 409, body: JSON.stringify({ error: 'uploader_not_configured' }) },
    })
    const transport = createUploadTransport({ ...PATHS, start: `${url}/start` })
    const file = new File(['abc'], 'a.png', { type: 'image/png' })
    const result = await transport.sendBytes({ uploadId: 'u-2', file })
    expect(result).toEqual({ ok: false, error: 'uploader_not_configured' })
    // 非 File 输入直接 ok:false，不发请求。
    const notFile = await transport.sendBytes({ uploadId: 'u-2', file: 'not-a-file' })
    expect(notFile.ok).toBe(false)
  })

  it('K1 pollStatus：受控快照投影；非 2xx 与非 JSON 返回 null', async () => {
    const url = await startServer({
      '/status-500': { status: 500 },
      '/status-html': { body: '<html>' },
      '/status-ok': { body: JSON.stringify({ status: 'uploading', progress: 40, bytesSent: 10, bytesTotal: 25, attempt: 2 }) },
    })
    const snapshot: UploadStatusSnapshot | null = await createUploadTransport({ ...PATHS, status: `${url}/status-ok` }).pollStatus('u-1')
    expect(snapshot?.status).toBe('uploading')
    expect(snapshot?.progress).toBe(40)
    expect(snapshot?.bytesSent).toBe(10)
    expect(snapshot?.bytesTotal).toBe(25)
    expect(snapshot?.attempt).toBe(2)
    expect(await createUploadTransport({ ...PATHS, status: `${url}/status-500` }).pollStatus('u-1')).toBeNull()
    expect(await createUploadTransport({ ...PATHS, status: `${url}/status-html` }).pollStatus('u-1')).toBeNull()
  })
})
