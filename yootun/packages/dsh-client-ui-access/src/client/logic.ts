/**
 * 激活流程逻辑层（旧 dsh-yootun-ui client.js 的 0.2.2 形态迁移）：写入顺序在
 * 旧版基础上插入托管 provider 目录合并（失败不阻断），门禁判定区分「未知」
 * 态供三态渲染；settings CAS 与恢复由官方 ConfigFormController 内置，网络
 * 访问走 host 同源路由。
 */
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE, ACCESS_VALIDATE_PATH, ACCESS_MODELS_PATH, REQUEST_TIMEOUT_MS, VALIDATION_VERSION } from '../access-constants.ts'
import type { GatewayModel } from '../route.ts'
import type { AccessLocaleKey } from './locales.ts'

/** `yootun-access` section 的值面（host 半 Config schema 的序列化形态）。 */
export interface AccessSettings {
  setupComplete: boolean
  validationVersion: number
  enabledPlugins: string[]
  modelId: string
}

/** `llm-pi-ai` 设置分区的读取面（目录写入只用到 provider `yootun` 的 models 路径）。 */
export interface ProviderModelsSection {
  providers: Record<string, { models: Array<{ id: string }> }>
}

/** 激活写入涉及的设置 namespace 的表单面；`models` 为托管 provider 分区，注册面不可用时为 undefined。 */
export interface AccessForms {
  access: ConfigForm<AccessSettings>
  defaultModel: ConfigForm<{ provider: string; model: string }>
  models: ConfigForm<ProviderModelsSection> | undefined
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
  if (models.length > 0) return { models }
  const listingReason = typeof payload.reason === 'string' ? payload.reason : undefined
  return listingReason !== undefined ? { models: [], reason: listingReason } : { models: [], reason: 'invalid_key' }
}

/**
 * The managed provider's current model list（patch 静态目录 + 既往激活写入），
 * read from the client mirror; empty while the section is unserved or its
 * snapshot is not ready.
 * @param forms - the activation forms; `models` carries the managed provider section.
 * @returns the provider's model entries in stored order.
 */
export function existingProviderModels(forms: AccessForms): Array<{ id: string }> {
  const models = forms.models?.getSnapshot().value?.providers.yootun?.models
  return Array.isArray(models) ? models : []
}

/**
 * Whether the managed provider's stored list is readable right now. The
 * unreadable case（分区缺省或快照未就绪）skips the catalog-sync block instead
 * of refusing activation on unverifiable data — only a read list can prove a
 * model undeclared.
 * @param forms - the activation forms.
 * @returns whether {@link existingProviderModels} reflects a served section.
 */
export function providerCatalogReadable(forms: AccessForms): boolean {
  return forms.models?.getSnapshot().value !== undefined
}

/** 按模型 id 去重取并集：分区现有项在前，实时目录追加在后（只增不删）。 */
function mergeModelLists(existing: ReadonlyArray<{ id: string }>, catalog: readonly GatewayModel[]): Array<{ id: string }> {
  const merged: Array<{ id: string }> = []
  const seen = new Set<string>()
  for (const model of [...existing, ...catalog]) {
    if (model.id.length === 0 || seen.has(model.id)) continue
    seen.add(model.id)
    merged.push({ id: model.id })
  }
  return merged
}

/**
 * Whether the managed provider's stored list declares a model. Catalog sync is
 * additive: a live-catalog model absent from this list can only be activated
 * when the sync write succeeded.
 * @param modelId - the model chosen for activation.
 * @param providerModels - {@link existingProviderModels} result.
 * @returns whether the provider already declares the model.
 */
export function providerDeclaresModel(modelId: string, providerModels: ReadonlyArray<{ id: string }>): boolean {
  return providerModels.some(model => model.id === modelId)
}

/**
 * Write the merged catalog into the managed provider's models list. An
 * unserved section, a refused write, or a transport rejection skips the step
 * (provider 仍有 patch 的静态目录兜底) — the activation continues regardless.
 * @param forms - the activation forms.
 * @param merged - the deduplicated union to store.
 * @returns whether the write committed.
 */
async function syncProviderCatalog(forms: AccessForms, merged: Array<{ id: string }>): Promise<boolean> {
  if (forms.models === undefined) return false
  try {
    return await forms.models.mutate([
      { op: 'set', path: ['providers', 'yootun', 'models'], value: merged },
    ] satisfies SettingsPathOpView[])
  } catch {
    // 分区不在服或传输失败时 ConfigForm 以 rejection 结束（refusal 才是 false）：
    // 跳过目录写入，不让 provider 分区缺位阻断激活。
    return false
  }
}

/** {@link saveActivation} 的结果：激活是否完成、目录是否写入 provider、本次的目标列表。 */
export interface ActivationOutcome {
  /** 授权是否已提交（门禁解锁的全部写入完成）。 */
  ok: boolean
  /** 目录合并是否写入 provider；false 时 provider 仍有 patch 的静态目录兜底。 */
  catalogSynced: boolean
  /** 本次写入（或因失败未写入）的合并列表：现有项在前、实时目录追加在后。 */
  catalog: Array<{ id: string }>
}

/**
 * The activation write sequence. Order-sensitive by contract: the managed key
 * and catalog facts commit first, authorization last, so a partial write can
 * never unlock the gate without a usable key (分册 03 C 部分语义). The catalog
 * step merges the live gateway directory into the provider's stored list,
 * additive only（现有项在前）；when that write fails for a model the readable
 * provider list verifiably does not declare, the sequence stops before the
 * default-model write — activating onto a provider-undeclared model is
 * refused instead of unlocking the gate to a model no provider route serves.
 * An unreadable list（分区缺省）skips without blocking, per the read-failure
 * semantics of the catalog step.
 * @param forms - the activation forms.
 * @param credentials - the credential seam.
 * @param key - the verified key.
 * @param modelId - the chosen default model.
 * @param catalog - the live gateway catalog for this key.
 * @returns the outcome: commit state, catalog sync state, and the merged list.
 */
export async function saveActivation(
  forms: AccessForms, credentials: CredentialsFace, key: string, modelId: string, catalog: readonly GatewayModel[],
): Promise<ActivationOutcome> {
  await credentials.set(ACCESS_CREDENTIAL_REF, key)
  const existing = existingProviderModels(forms)
  const merged = mergeModelLists(existing, catalog)
  const catalogSynced = await syncProviderCatalog(forms, merged)
  // 目录写失败的提交裁决：列表可读且所选模型确不在内 → 在默认模型写入前中止，
  // 避免授权提交到 provider 未声明的模型上；列表不可读（分区缺省）按「读取
  // 失败不阻断」放行，provider 仍有 patch 静态目录兜底。
  if (!catalogSynced && providerCatalogReadable(forms) && !providerDeclaresModel(modelId, existing)) {
    return { ok: false, catalogSynced, catalog: merged }
  }
  const defaultModelWritten = await forms.defaultModel.mutate([
    { op: 'set', path: ['provider'], value: 'yootun' },
    { op: 'set', path: ['model'], value: modelId },
  ] satisfies SettingsPathOpView[])
  if (!defaultModelWritten) return { ok: false, catalogSynced, catalog: merged }
  // Authorization commits last so a partial write never unlocks the gate.
  const authorized = await forms.access.mutate([
    { op: 'set', path: ['setupComplete'], value: true },
    { op: 'set', path: ['validationVersion'], value: Number(VALIDATION_VERSION) },
    { op: 'set', path: ['enabledPlugins'], value: [] },
    { op: 'set', path: ['modelId'], value: modelId },
  ] satisfies SettingsPathOpView[])
  return { ok: authorized, catalogSynced, catalog: merged }
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
 * The gate verdict. Known inputs keep the fail-closed semantics（任一已知输入
 * 不满足即未授权）; a missing input — the access section not served yet or the
 * credential probe still pending — reads as unknown, so the gate can render
 * its mask-only state instead of flashing the card at every startup.
 * @param settings - the access section value, or undefined while unavailable.
 * @param credentialConfigured - whether the credential store holds the key; undefined while the probe is pending.
 * @returns true or false when both inputs are known, undefined when either is missing.
 */
export function isAuthorized(settings: AccessSettings | undefined, credentialConfigured: boolean | undefined): boolean | undefined {
  if (credentialConfigured === undefined || settings === undefined) return undefined
  return credentialConfigured && settings.setupComplete === true && settings.validationVersion === Number(VALIDATION_VERSION)
}

/** 门禁未知态回落为卡片的等待时长（毫秒）：判定输入挂起时不能让用户面对没有入口的遮罩。 */
export const GATE_UNKNOWN_FALLBACK_MS = 5_000

/** 门禁渲染相位：unknown 只渲染遮罩层，card 渲染激活卡片，open 不渲染任何层。 */
export type GatePhase = 'unknown' | 'card' | 'open'

/**
 * 门禁渲染相位。已授权 → open；未授权 → card；判定输入未就绪 → unknown，
 * 回落计时到点后同样按 card 处理，授权回包让已回落的卡片立即消失。
 * @param authorized - {@link isAuthorized} 结果（undefined = 输入未就绪）。
 * @param fallbackElapsed - 未知态回落计时是否已到点。
 * @returns the phase to render.
 */
export function gatePhase(authorized: boolean | undefined, fallbackElapsed: boolean): GatePhase {
  if (authorized === true) return 'open'
  return authorized === false || fallbackElapsed ? 'card' : 'unknown'
}

/** 可替换的定时器面（测试注入假时钟）。 */
export interface TimeoutScheduler {
  /**
   * Arm one timeout.
   * @param delayMs - fire-after duration.
   * @param handler - fire callback.
   * @returns the canceller revoking an untriggered timeout.
   */
  schedule(delayMs: number, handler: () => void): () => void
}

/** `setTimeout` / `clearTimeout` 的 {@link TimeoutScheduler} 适配。 */
export const timeoutScheduler: TimeoutScheduler = {
  schedule: (delayMs, handler) => {
    const timer = setTimeout(handler, delayMs)
    return () => { clearTimeout(timer) }
  },
}

/**
 * Map a same-origin route failure reason to its dictionary key. `invalid_key`
 * and unknown reasons fall to the caller's existing copy（表单的 modelError /
 * invalid 兜底）; the other reasons carry their own copy.
 * @param reason - the route's failure reason, undefined when absent.
 * @param refusedFallback - dictionary key rendering a gateway rejection.
 * @returns the dictionary key rendering the failure.
 */
export function accessFailureKey(reason: string | undefined, refusedFallback: AccessLocaleKey): AccessLocaleKey {
  if (reason === 'tenant_mismatch') return 'tenantMismatch'
  if (reason === 'tenant_unavailable') return 'tenantUnavailable'
  if (reason === 'network_unavailable') return 'networkUnavailable'
  return refusedFallback
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

export { ACCESS_NAMESPACE }
