/**
 * Same-origin activation API routes forwarding to the ixicai.cn gateway. The
 * browser never talks to the gateway directly: these handlers keep the key on
 * the host side of the exchange and attach the tenant header themselves, so
 * the renderer sees neither CORS nor the raw gateway contract. Request-side
 * checks follow the old desktop shell's dofe-access-route (loopback peer,
 * same-origin fetch metadata, JSON body ceiling); the wire protocol is fixed
 * to Anthropic Messages because the 0.2.2 llm-deepseek adapter is the only
 * managed carrier (分册 03 B-3 查证定案).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TENANT, TENANT_ID } from './access-constants.ts'

/** Gateway origins the routes forward to. Service-owned endpoints, zero client changes. */
const TENANT_CONTEXT_URL = 'https://ixicai.cn/api/internal/auth/context'
const MODEL_CATALOG_URL = 'https://ixicai.cn/api/v1/models?protocol=anthropic'

/** Gateway request headers carried on every forwarded call. */
const GATEWAY_HEADERS: Readonly<Record<string, string>> = Object.freeze({ 'X-Company-Code': TENANT })

const MAX_BODY_BYTES = 16 * 1024
const GATEWAY_TIMEOUT_MS = 10_000

/** Why an activation step failed; the client maps each to localized copy. */
export type AccessFailureReason = 'invalid_key' | 'tenant_mismatch' | 'tenant_unavailable'

export interface ValidateResult {
  valid: boolean
  reason?: AccessFailureReason
}

export interface ModelsResult {
  models: GatewayModel[]
  reason?: AccessFailureReason
}

/** One catalog row the gateway advertises for the Messages protocol. */
export interface GatewayModel {
  id: string
  name: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: ('text' | 'image')[]
}

/** Model ids the gateway lists that are not conversation models. */
const NON_CHAT_MODEL_PATTERN = /(?:voice|speech|tts|stt|audio|seedance|seedream|embedding|rerank|moderation|music|video-generation|image-generation)/iu

function finish(res: ServerResponse, status: number, value: object): void {
  res.statusCode = status
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

/**
 * Whether the request may reach the gateway through this host: loopback peer,
 * the local client page's origin, browser same-origin fetch metadata, and a
 * JSON body. Non-browser callers have no origin and fail this check.
 * @param req - incoming request.
 * @param expectedOrigin - the local webServer origin the client page is served from.
 * @returns whether the exchange may proceed.
 */
function permitted(req: IncomingMessage, expectedOrigin: string): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopback = address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
  return loopback
    && req.headers.origin === expectedOrigin
    && (req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin')
    && req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

async function readRequest(req: IncomingMessage): Promise<{ key: string } | undefined> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'key')) return undefined
    if (typeof record.key !== 'string') return undefined
    const key = record.key.trim()
    return key.length > 0 && key.length <= 4096 ? { key } : undefined
  } catch {
    return undefined
  }
}

/**
 * Verify the key belongs to this product's tenant through the gateway's
 * internal auth context. A gateway that cannot confirm the tenant fails the
 * activation rather than granting it.
 * @param key - model_api_key the user entered.
 * @param fetcher - outbound fetch; injectable for tests.
 * @returns ok, or why the tenant check failed.
 */
async function verifyTenant(key: string, fetcher: typeof fetch): Promise<{ ok: true } | { ok: false; reason: AccessFailureReason }> {
  try {
    const response = await fetcher(TENANT_CONTEXT_URL, {
      headers: { ...GATEWAY_HEADERS, Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    })
    if (!response.ok) return { ok: false, reason: 'invalid_key' }
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'tenant_unavailable' }
    const record = value as Record<string, unknown>
    const data = record.data !== undefined && typeof record.data === 'object' && !Array.isArray(record.data)
      ? record.data as Record<string, unknown>
      : undefined
    const candidates = [record, data, record.tenant, data?.tenant]
      .filter((candidate): candidate is Record<string, unknown> =>
        candidate !== undefined && typeof candidate === 'object' && !Array.isArray(candidate))
    const tenantId = candidates
      .flatMap(candidate => [candidate.tenantId, candidate.tenant_id, candidate.id])
      .find(candidate => typeof candidate === 'string' && candidate.trim().length > 0)
    if (typeof tenantId === 'string' && tenantId.trim().length > 0) {
      return tenantId.trim().toLowerCase() === TENANT_ID.toLowerCase() ? { ok: true } : { ok: false, reason: 'tenant_mismatch' }
    }
    const tenantSlug = candidates
      .flatMap(candidate => [candidate.tenantSlug, candidate.tenant_slug, candidate.slug])
      .find(candidate => typeof candidate === 'string' && candidate.trim().length > 0)
    if (typeof tenantSlug !== 'string' || tenantSlug.trim().length === 0) return { ok: false, reason: 'tenant_unavailable' }
    return tenantSlug.trim().toLowerCase() === TENANT.toLowerCase() ? { ok: true } : { ok: false, reason: 'tenant_mismatch' }
  } catch {
    return { ok: false, reason: 'tenant_unavailable' }
  }
}

/** Convert one raw gateway row into the catalog shape, dropping non-conversation entries. */
function catalogRow(row: Record<string, unknown>): GatewayModel | undefined {
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id.length === 0 || NON_CHAT_MODEL_PATTERN.test(id)) return undefined
  return {
    id,
    name: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name : id,
    ...(typeof row.description === 'string' && row.description.length > 0 ? { description: row.description } : {}),
    ...(typeof row.contextWindow === 'number' && Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0
      ? { contextWindow: row.contextWindow } : {}),
    ...(typeof row.maxTokens === 'number' && Number.isSafeInteger(row.maxTokens) && row.maxTokens > 0
      ? { maxTokens: row.maxTokens } : {}),
    ...(Array.isArray(row.inputModalities)
      ? { inputModalities: row.inputModalities.filter((item): item is 'text' | 'image' => item === 'text' || item === 'image') }
      : {}),
  }
}

/** Parse a gateway listing response into deduplicated catalog rows. */
export function parseModelCatalog(value: unknown): GatewayModel[] {
  const rows = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : []
  const seen = new Set<string>()
  const models: GatewayModel[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const model = catalogRow(row as Record<string, unknown>)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    models.push(model)
  }
  return models
}

/** Fetch and parse the Messages-protocol model catalog for one key. */
async function loadModels(key: string, fetcher: typeof fetch): Promise<GatewayModel[]> {
  const response = await fetcher(MODEL_CATALOG_URL, {
    headers: { ...GATEWAY_HEADERS, Authorization: `Bearer ${key}`, Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  })
  if (!response.ok) return []
  return parseModelCatalog(await response.json())
}

/**
 * Same-origin key validation: tenant check, then a catalog probe that proves
 * the key can actually reach a model. Every outcome answers 200 with a JSON
 * verdict — transport-level failures degrade to `valid: false`.
 * @param req - incoming request.
 * @param res - response owned for the whole exchange.
 * @param expectedOrigin - the local client page origin.
 * @param fetcher - outbound fetch; injectable for tests.
 */
export async function handleDofeValidateRequest(
  req: IncomingMessage, res: ServerResponse, expectedOrigin: string, fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (req.method !== 'POST') return finish(res, 405, { valid: false })
  if (!permitted(req, expectedOrigin)) return finish(res, 403, { valid: false })
  const request = await readRequest(req)
  if (request === undefined) return finish(res, 400, { valid: false })
  try {
    const tenant = await verifyTenant(request.key, fetcher)
    if (!tenant.ok) return finish(res, 200, { valid: false, reason: tenant.reason })
    const models = await loadModels(request.key, fetcher)
    finish(res, 200, models.length > 0 ? { valid: true } : { valid: false, reason: 'invalid_key' })
  } catch {
    finish(res, 200, { valid: false, reason: 'invalid_key' })
  }
}

/**
 * Same-origin model catalog route with the same request-side checks; the
 * renderer saw the key in the form, so no stored-credential path exists here.
 * @param req - incoming request.
 * @param res - response owned for the whole exchange.
 * @param expectedOrigin - the local client page origin.
 * @param fetcher - outbound fetch; injectable for tests.
 */
export async function handleDofeModelsRequest(
  req: IncomingMessage, res: ServerResponse, expectedOrigin: string, fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (req.method !== 'POST') return finish(res, 405, { models: [] })
  if (!permitted(req, expectedOrigin)) return finish(res, 403, { models: [] })
  const request = await readRequest(req)
  if (request === undefined) return finish(res, 400, { models: [] })
  try {
    const tenant = await verifyTenant(request.key, fetcher)
    if (!tenant.ok) return finish(res, 200, { models: [], reason: tenant.reason })
    finish(res, 200, { models: await loadModels(request.key, fetcher) })
  } catch {
    finish(res, 200, { models: [], reason: 'invalid_key' })
  }
}
