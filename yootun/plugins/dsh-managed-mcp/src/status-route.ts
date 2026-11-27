/**
 * `POST /api/desktop/yootun/agent-status`：设置页「智能体工具」行的只读同源
 * 状态路由。信任判定与 yootun 其余同源路由同口径（loopback 远端为基线，
 * 显式 `sec-fetch-site: cross-site` 拒绝，显式 Origin 精确匹配，Desktop
 * 转发剥掉两枚标记时放行）；体可省略，有体时必须是空对象；插件卸载中
 * 503。响应只含监督器快照字段，不含 key、URL 或任何凭证相关信息；路由只
 * 读快照，不触发任何网络请求。请求/响应采用 Node HTTP 对象的结构子集，
 * 测试可无 cast 构造替身。
 * @module
 */
import type { IncomingHttpHeaders } from 'node:http'
import { permitted } from '@yootun/dsh-workbench-host-kit'
import type { AgentFaceSnapshot } from './supervisor.ts'

/** 请求体上限（bytes；与视频号路由同口径）。 */
export const MAX_BODY_BYTES = 64 * 1024

/** 状态路由的最小请求面（Node `IncomingMessage` 的结构子集）。 */
export interface StatusRouteRequest {
  /** HTTP 方法；缺失按非 POST 处理。 */
  readonly method?: string | undefined
  /** 远端地址（信任判定的 loopback 基线）。 */
  readonly socket: { readonly remoteAddress?: string | undefined }
  /** 请求头（Origin / Sec-Fetch-Site 信任标记）。 */
  readonly headers: IncomingHttpHeaders
  /** 请求体流（空体契约的唯一读取途径）。 */
  [Symbol.asyncIterator](): AsyncIterator<string | Buffer>
}

/** 状态路由的最小响应面（Node `ServerResponse` 的结构子集）。 */
export interface StatusRouteResponse {
  /** HTTP 状态码（由本路由写入）。 */
  statusCode: number
  /** 写一个响应头。 */
  setHeader(name: string, value: string): void
  /** 结束响应（JSON 文本）。 */
  end(body?: string | undefined): void
}

/** 状态路由的快照来源（`AgentSupervisor` 的投影面）。 */
export interface AgentStatusSnapshotSource {
  /** 读取当前只读快照。 */
  snapshot(): AgentFaceSnapshot
}

// 同源信任判定与 yootun 其余 Host 路由同口径（kit 单一实现：loopback 基线、
// 显式 cross-site 拒绝、显式 Origin 精确匹配、Desktop forwardWebRequest 剥掉
// 两枚标记的形态放行）。
export { permitted } from '@yootun/dsh-workbench-host-kit'

/**
 * Read the request body under the size cap and require the empty-body
 * contract: either no bytes at all or a single empty JSON object.
 * @param req - incoming request.
 * @returns whether the body is acceptable.
 */
async function isEmptyBody(req: StatusRouteRequest): Promise<boolean> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) return false
    chunks.push(bytes)
  }
  if (chunks.length === 0) return true
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0
  } catch (error: unknown) {
    // JSON 解析失败即违反空对象契约，body 为空时不会进入本分支。
    void error
    return false
  }
}

function send(res: StatusRouteResponse, code: number, payload: object): void {
  res.statusCode = code
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(payload))
}

/**
 * Build the agent-status route handler: POST only, the same trust decision as
 * the Workbench-face routes, the empty-body contract, 503 while the plugin is
 * disposing, and a read-only snapshot payload.
 * @param expectedOrigin - origin provider (the local webServer binds during init).
 * @param source - snapshot source (the supervisor's projection).
 * @param isDisposing - whether the plugin is currently unloading.
 * @returns the webServer route handler.
 */
export function createAgentStatusRouteHandler(
  expectedOrigin: () => string,
  source: AgentStatusSnapshotSource,
  isDisposing: () => boolean,
): (req: StatusRouteRequest, res: StatusRouteResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, { status: 'error', reason: 'invalid_request' })
    if (!permitted(req, expectedOrigin())) return send(res, 403, { status: 'error', reason: 'forbidden' })
    if (isDisposing()) return send(res, 503, { status: 'error', reason: 'plugin_disposing' })
    if (!await isEmptyBody(req)) return send(res, 400, { status: 'error', reason: 'invalid_request' })
    send(res, 200, { status: 'ok', ...source.snapshot() })
  }
}
