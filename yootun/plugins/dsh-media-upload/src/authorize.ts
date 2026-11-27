/**
 * 上传授权编排（迁移旧 authorize.js 语义，授权入口改为 Workbench 面工具）：
 * 只把 filename、contentType、size 三个元数据交给
 * `workbench_tos_upload_authorize`，换取 PUT 预签名授权，并做严格响应校验。
 * 授权响应里的预签名 URL 只在宿主进程内用于直传，绝不进入浏览器响应、
 * 日志或会话；公网 URL 在校验后随结果返回。
 * @module
 */
import { AUTHORIZE_TOOL_NAME } from './constants.ts'
import { BlockList } from 'node:net'
import { MediaUploadError, mapServerErrorCode } from './errors.ts'
import { normalizeMime } from './mime.ts'
import type { ToolCallOutcome } from '@yootun/dsh-workbench-mcp'
import type { WorkbenchMcpError } from '@yootun/dsh-workbench-mcp'

/** The workbench connector face this plugin consumes (structural; the real service satisfies it). */
export interface WorkbenchFace {
  callTool(caller: 'media-upload', domain: 'tos', name: string, args: unknown, signal?: AbortSignal): Promise<ToolCallOutcome>
}

/** The validated authorization: presigned PUT target plus the public result URL. */
export interface UploadAuthorization {
  method: 'PUT'
  /** Presigned PUT URL; secret, host-internal only. */
  url: string
  headers: Record<string, string>
  /** Public URL delivered to callers after success. */
  publicUrl: string
  expiresAt: string
  maxBytes: number
}

/** Metadata-only authorize request (never paths, never credentials). */
export interface AuthorizeMeta {
  filename: string
  contentType: string
  size: number
}

/** Test seam for loopback fake-TOS servers; production never passes it. */
export interface AuthorizeValidationOverrides {
  /** Allow http:// and loopback/private hosts (fake-TOS tests only). */
  transport?: 'strict' | 'loopback-test'
}

// 2.4 内网地址块表（node:net BlockList；构造不抛，模块加载时执行一次）。
// IPv4 与 IPv6 分表：混入同一 BlockList 时 node 会把 IPv4 查询归一进
// `::ffff:0:0/96`（该段覆盖全部映射 IPv4），公网 IPv4 会被误判。
const BLOCKED_V4 = (() => {
  const list = new BlockList()
  for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) {
    list.addSubnet(net as string, bits as number, 'ipv4')
  }
  return list
})()

const BLOCKED_V6 = (() => {
  const list = new BlockList()
  for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16]]) {
    list.addSubnet(net as string, bits as number, 'ipv6')
  }
  return list
})()

/**
 * Whether a hostname points at loopback / private / link-local / CGNAT / ULA /
 * multicast / mapped / NAT64 / 6to4 space; such hosts must never appear in an
 * authorization URL. 判定输入是 `URL.hostname`：去方括号、转小写、去掉结尾的
 * 点之后按 2.4 表判断（主机名规则；含 `:` 按 IPv6、四个数字段按 IPv4 走
 * BlockList；其余名称不命中）。
 * @param hostname - URL hostname.
 * @returns whether the host is forbidden.
 */
export function isForbiddenPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '').replace(/\.$/u, '').trim()
  if (host === '') return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.includes(':')) {
    try {
      return BLOCKED_V6.check(host, 'ipv6')
    } catch {
      return false
    }
  }
  const v4 = host.split('.')
  if (v4.length === 4 && v4.every(part => /^\d{1,3}$/u.test(part))) {
    try {
      return BLOCKED_V4.check(host, 'ipv4')
    } catch {
      return false
    }
  }
  return false
}

/** Case-insensitive header lookup over the authorize response's headers object. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === lower && typeof value === 'string') return value
  }
  return undefined
}

function safeUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * Validate an authorization response. Any defect throws
 * `upload_authorization_invalid`; the raw response is never surfaced.
 * @param resp - parsed authorization payload from the Workbench tool.
 * @param meta - the metadata that was authorized (size/contentType).
 * @param overrides - test seam; production callers omit it.
 * @returns the validated authorization.
 * @throws {MediaUploadError} `upload_authorization_invalid`.
 */
export function validateAuthorizationResponse(resp: unknown, meta: AuthorizeMeta, overrides: AuthorizeValidationOverrides = {}): UploadAuthorization {
  const invalid = (message: string): MediaUploadError => new MediaUploadError('upload_authorization_invalid', message)
  const testMode = overrides.transport === 'loopback-test'
  if (typeof resp !== 'object' || resp === null) throw invalid('authorization response is not an object')
  const record = resp as Record<string, unknown>
  if (record.method !== 'PUT') throw invalid(`authorization method must be PUT, got "${String(record.method)}"`)

  const url = safeUrl(record.url)
  if (url === undefined) throw invalid('authorization url is missing or malformed')
  if (!testMode && url.protocol !== 'https:') throw invalid('authorization url must be HTTPS')
  if (!testMode && isForbiddenPublicHost(url.hostname)) throw invalid('authorization url must not point at loopback/private space')

  const publicUrl = safeUrl(record.publicUrl)
  if (publicUrl === undefined) throw invalid('publicUrl is missing or malformed')
  if (publicUrl.protocol !== 'https:') throw invalid('publicUrl must be HTTPS')
  if (isForbiddenPublicHost(publicUrl.hostname)) throw invalid('publicUrl must not point at loopback/private space')

  const expiresAt = Date.parse(String(record.expiresAt))
  if (!Number.isFinite(expiresAt)) throw invalid('expiresAt must be a valid date')
  if (expiresAt <= Date.now()) throw invalid('expiresAt must be in the future')

  const maxBytes = Number(record.maxBytes)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(maxBytes)) throw invalid('maxBytes must be a positive integer')
  if (meta.size > maxBytes) throw invalid('file size exceeds the authorized maxBytes')

  const expectedType = normalizeMime(meta.contentType)
  if (normalizeMime(headerValue(record.headers, 'content-type')) !== expectedType) {
    throw invalid('authorized Content-Type does not match the local declaration')
  }
  return {
    method: 'PUT',
    url: record.url as string,
    headers: (typeof record.headers === 'object' && record.headers !== null)
      ? Object.fromEntries(Object.entries(record.headers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : {},
    publicUrl: record.publicUrl as string,
    expiresAt: String(record.expiresAt),
    maxBytes,
  }
}

/**
 * Authorize one upload through the Workbench face and validate the response.
 * @param workbench - the Workbench connector face.
 * @param meta - metadata-only request.
 * @param signal - cancellation (tool execution or plugin disposal).
 * @param overrides - test seam; production callers omit it.
 * @returns the validated authorization.
 * @throws {MediaUploadError} stable public codes only.
 */
export async function authorizeUpload(
  workbench: WorkbenchFace,
  meta: AuthorizeMeta,
  signal: AbortSignal | undefined,
  overrides: AuthorizeValidationOverrides = {},
): Promise<UploadAuthorization> {
  let outcome: ToolCallOutcome
  try {
    outcome = await workbench.callTool('media-upload', 'tos', AUTHORIZE_TOOL_NAME, {
      filename: meta.filename,
      contentType: meta.contentType,
      size: meta.size,
    }, signal)
  } catch (error: unknown) {
    const workbenchError = error as WorkbenchMcpError
    if (error instanceof Error && error.name === 'AbortError') throw new MediaUploadError('user_cancelled', 'authorize cancelled')
    const code = typeof workbenchError?.code === 'string' ? workbenchError.code : ''
    if (code === 'workbench_call_timeout') throw new MediaUploadError('upload_timeout', 'authorize timed out')
    if (code === 'workbench_call_cancelled') throw new MediaUploadError('user_cancelled', 'authorize cancelled')
    if (code === 'workbench_call_failed') throw new MediaUploadError(mapServerErrorCode(workbenchError.payload), 'authorize rejected by server')
    if (code === 'workbench_not_activated' || code === 'workbench_tool_denied' || code === 'workbench_unauthorized') {
      throw new MediaUploadError('uploader_not_configured', 'upload authorization is not available in this composition')
    }
    // 网络/协议/服务端故障（workbench_server_error）/卸载统一按存储不可用投影
    // （上传链路不得伪造成功）。
    throw new MediaUploadError('storage_unavailable', 'authorize is unavailable')
  }
  const parsed = outcome.structuredContent ?? parseContentBlocks(outcome.content)
  return validateAuthorizationResponse(parsed, meta, overrides)
}

/**
 * Extract the first JSON object from text content blocks (tolerating code
 * fences), mirroring the legacy contract for servers without structured output.
 * @param content - the tool result's content blocks.
 * @returns the parsed object, or undefined.
 */
function parseContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined
  const text = content
    .map(block => typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text : '')
    .join('\n')
    .trim()
  if (text === '') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text)
  const body = fenced === null ? text : fenced[1] ?? text
  try {
    const parsed: unknown = JSON.parse(body.trim())
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}
