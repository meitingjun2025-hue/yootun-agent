/**
 * 激活门禁（分册 08 §4.2）：三条件全部成立才挂载 Agent 面 client——
 * `yootun-access.setupComplete`、`validationVersion` 与品牌构建内联版本
 * 精确一致、`MODELS_API_KEY` 可解析且非空。任何条件缺失或服务缺席一律
 * fail-closed：不创建 client、不发网络请求。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { VALIDATION_VERSION } from '@yootun/dsh-client-ui-access/src/access-constants.ts'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from './constants.ts'

/** The plugin's consumed slice of the `yootun-access` settings value. */
export interface AccessSnapshot {
  setupComplete: boolean
  validationVersion: number
}

/**
 * Validate a settings namespace value into the consumed slice. Settings
 * values reach this plugin as JSON-shaped `unknown`, so the read site — not
 * the type system — rejects malformed snapshots.
 * @param value - the namespace's live config value.
 * @returns the snapshot, or `undefined` when the shape is not usable.
 */
export function readAccessSnapshot(value: unknown): AccessSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { setupComplete?: unknown; validationVersion?: unknown }
  if (typeof record.setupComplete !== 'boolean' || typeof record.validationVersion !== 'number') return undefined
  return { setupComplete: record.setupComplete, validationVersion: record.validationVersion }
}

/** The services the gate consults, resolved through the same-process store. */
export interface ActivationServices {
  /** The settings projection this plugin reads its activation facts through. */
  settings: { describe(): Array<{ ns: string; value: unknown }> } | undefined
  credentials: CredentialProvider | undefined
}

/**
 * Read the gate's service inputs from the context. Both services are
 * composition-provided; a missing one deactivates rather than guessing.
 * @param ctx - the plugin context.
 * @returns the services, either of which may be absent.
 */
export function activationServices(ctx: Context): ActivationServices {
  return {
    settings: ctx.get('settings'),
    credentials: ctx.get('credentials'),
  }
}

/**
 * Evaluate the activation gate. Credential resolution is the only async step;
 * a configured-but-empty value counts as absent.
 * @param services - the gate's service inputs.
 * @param resolve - credential resolver; injectable for tests.
 * @returns whether the Agent face may mount.
 */
export async function isActivated(
  services: ActivationServices,
  resolve: (ref: CredentialRef) => Promise<{ value: string } | undefined> =
    async ref => await services.credentials?.resolve(ref),
): Promise<boolean> {
  if (services.settings === undefined || services.credentials === undefined) return false
  const descriptor = services.settings.describe().find(row => row.ns === ACCESS_NAMESPACE)
  const snapshot = readAccessSnapshot(descriptor?.value)
  if (snapshot === undefined || !snapshot.setupComplete) return false
  if (snapshot.validationVersion !== Number(VALIDATION_VERSION)) return false
  const resolved = await resolve(credentialRef(ACCESS_CREDENTIAL_REF))
  return resolved !== undefined && resolved.value !== ''
}
