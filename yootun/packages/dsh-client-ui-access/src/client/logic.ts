/**
 * 激活流程逻辑层（旧 dsh-yootun-ui client.js 的 0.2.2 形态迁移）：写入顺序、
 * 授权撤销与门禁判定语义保持旧版；settings CAS 与恢复由官方
 * ConfigFormController 内置，网络访问走 host 同源路由。
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE, ACCESS_VALIDATE_PATH, ACCESS_MODELS_PATH, REQUEST_TIMEOUT_MS, VALIDATION_VERSION } from '../access-constants.ts'
import type { GatewayModel } from '../route.ts'

/** `yootun-access` section 的值面（host 半 Config schema 的序列化形态）。 */
export interface AccessSettings {
  setupComplete: boolean
  validationVersion: number
  enabledPlugins: string[]
  modelId: string
}

/** 激活写入涉及的三个设置 namespace 的表单面。 */
export interface AccessForms {
  access: ConfigForm<AccessSettings>
  llm: ConfigForm<{ models: GatewayModel[] }>
  defaultModel: ConfigForm<{ provider: string; model: string }>
}

/** 激活流程用到的 credentials 远程面（describe/set/unset，Result 包装形态）。 */
export interface CredentialsFace {
  describe(refs: string[]): Promise<{ ok: boolean; value?: Record<string, { configured: boolean }> }>
  set(ref: string, value: string): Promise<{ ok: boolean }>
  unset(ref: string): Promise<{ ok: boolean }>
}

/** Same-origin POST with the shared bounded timeout; same-origin and no redirect by contract. */
export async function jsonPost(path: string, body: object): Promise<{ ok: boolean; value: unknown }> {
  const response = await fetch(path, {
    method: 'POST', credentials: 'same-origin', redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  return { ok: response.ok, value: await response.json() }
}

/**
 * Validate one key through the same-origin route and load its model catalog.
 * @param key - the entered model_api_key.
 * @returns the catalog, or why validation failed; `models` is empty on failure.
 */
export async function validateAndLoadModels(key: string): Promise<{ models: GatewayModel[]; reason?: string }> {
  const verdict = await jsonPost(ACCESS_VALIDATE_PATH, { key })
  const record = typeof verdict.value === 'object' && verdict.value !== null ? verdict.value as Record<string, unknown> : {}
  if (!verdict.ok || record.valid !== true) {
    const reason = typeof record.reason === 'string' ? record.reason : undefined
    return { models: [], ...(reason !== undefined ? { reason } : {}) }
  }
  const listing = await jsonPost(ACCESS_MODELS_PATH, { key })
  const payload = typeof listing.value === 'object' && listing.value !== null ? listing.value as Record<string, unknown> : {}
  const models = Array.isArray(payload.models) ? payload.models as GatewayModel[] : []
  return models.length > 0 ? { models } : { models: [], reason: 'invalid_key' }
}

/**
 * The activation write sequence. Order-sensitive by contract: the managed key
 * and model facts commit first, authorization last, so a partial write can
 * never unlock the gate without a usable key (分册 03 C 部分语义).
 * @param forms - the three namespace forms.
 * @param credentials - the credential seam.
 * @param key - the verified key.
 * @param models - the loaded catalog written over the patch fallback.
 * @param modelId - the chosen default model.
 * @returns whether every write committed.
 */
export async function saveActivation(
  forms: AccessForms, credentials: CredentialsFace, key: string, models: readonly GatewayModel[], modelId: string,
): Promise<boolean> {
  const modelConfig = models.map(model => ({
    id: model.id, name: model.name, ...(model.description !== undefined ? { description: model.description } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    inputModalities: model.inputModalities ?? ['text'],
  }))
  const llmWritten = await forms.llm.mutate([{ op: 'set', path: ['models'], value: modelConfig }] satisfies SettingsPathOpView[])
  if (!llmWritten) return false
  await credentials.set(ACCESS_CREDENTIAL_REF, key)
  const defaultModelWritten = await forms.defaultModel.mutate([
    { op: 'set', path: ['provider'], value: 'deepseek-official' },
    { op: 'set', path: ['model'], value: modelId },
  ] satisfies SettingsPathOpView[])
  if (!defaultModelWritten) return false
  // Authorization commits last so a partial write never unlocks the gate.
  return await forms.access.mutate([
    { op: 'set', path: ['setupComplete'], value: true },
    { op: 'set', path: ['validationVersion'], value: Number(VALIDATION_VERSION) },
    { op: 'set', path: ['enabledPlugins'], value: [] },
    { op: 'set', path: ['modelId'], value: modelId },
  ] satisfies SettingsPathOpView[])
}

/**
 * Revoke authorization before removing the credential, so a partial removal
 * can never leave an unlocked gate without a key.
 * @param forms - the access namespace form.
 * @param credentials - the credential seam.
 * @returns whether both writes committed.
 */
export async function removeAccess(forms: Pick<AccessForms, 'access'>, credentials: CredentialsFace): Promise<boolean> {
  const revoked = await forms.access.mutate([
    { op: 'set', path: ['setupComplete'], value: false },
    { op: 'set', path: ['validationVersion'], value: 0 },
    { op: 'set', path: ['modelId'], value: '' },
  ] satisfies SettingsPathOpView[])
  if (!revoked) return false
  await credentials.unset(ACCESS_CREDENTIAL_REF)
  return true
}

/**
 * The gate verdict. Fail-closed: any unavailable piece (settings section not
 * served, credential seam unreachable) reads as not authorized.
 * @param settings - the access section value, or undefined while unavailable.
 * @param credentialConfigured - whether the credential store holds the key.
 * @returns whether the main UI may unlock.
 */
export function isAuthorized(settings: AccessSettings | undefined, credentialConfigured: boolean): boolean {
  return credentialConfigured === true
    && settings?.setupComplete === true
    && settings.validationVersion === Number(VALIDATION_VERSION)
}

/**
 * Whether the credential store currently holds the managed key. Fail-closed:
 * a seam failure or rejection reads as unconfigured（门禁与设置区块共用）.
 * @param credentials - the credential seam.
 * @returns whether the key is configured.
 */
export async function describeKeyConfigured(credentials: CredentialsFace): Promise<boolean> {
  try {
    const response = await credentials.describe([ACCESS_CREDENTIAL_REF])
    return response.ok === true && response.value?.[ACCESS_CREDENTIAL_REF]?.configured === true
  } catch {
    return false
  }
}

/** Inert the application root and lock body scroll; the disposer restores both. */
export function blockApplicationRoot(): () => void {
  const root = document.getElementById('root')
  const previousInert = root?.inert
  const previousOverflow = document.body.style.overflow
  if (root !== null) root.inert = true
  document.body.style.overflow = 'hidden'
  return () => {
    if (root !== null) root.inert = previousInert ?? false
    document.body.style.overflow = previousOverflow
  }
}

export { ACCESS_NAMESPACE }
