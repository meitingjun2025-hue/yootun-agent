/**
 * 激活门禁（分册 08 §5.2 内部步骤 2/3）：与 Agent 面同口径——
 * `yootun-access.setupComplete`、`validationVersion` 与品牌构建内联版本精确
 * 一致、`MODELS_API_KEY` 可解析且非空。服务缺席或任一条件不成立即 fail-closed。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { VALIDATION_VERSION } from '@yootun/dsh-client-ui-access/src/access-constants.ts'
import { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from './constants.ts'

/** The plugin's consumed slice of the `yootun-access` settings value. */
export interface AccessSnapshot {
  setupComplete: boolean
  validationVersion: number
}

/**
 * Validate a settings namespace value into the consumed slice; malformed
 * snapshots deactivate instead of guessing.
 * @param value - the namespace's live config value.
 * @returns the snapshot, or `undefined` when the shape is not usable.
 */
export function readAccessSnapshot(value: unknown): AccessSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as { setupComplete?: unknown; validationVersion?: unknown }
  if (typeof record.setupComplete !== 'boolean' || typeof record.validationVersion !== 'number') return undefined
  return { setupComplete: record.setupComplete, validationVersion: record.validationVersion }
}

/** The gate's service inputs as the service consumes them. */
export interface ActivationServices {
  settings: { describe(): Array<{ ns: string; value: unknown }> } | undefined
  credentials: CredentialProvider | undefined
}

/**
 * Read the gate's service inputs from the context.
 * @param ctx - the service context.
 * @returns the services, either of which may be absent.
 */
export function activationServices(ctx: Context): ActivationServices {
  return { settings: ctx.get('settings'), credentials: ctx.get('credentials') }
}

/**
 * Evaluate the activation gate; the only async step is credential resolution.
 * @param services - the gate's service inputs.
 * @returns whether Workbench calls may proceed.
 */
export async function isActivated(services: ActivationServices): Promise<boolean> {
  if (services.settings === undefined || services.credentials === undefined) return false
  const descriptor = services.settings.describe().find(row => row.ns === ACCESS_NAMESPACE)
  const snapshot = readAccessSnapshot(descriptor?.value)
  if (snapshot === undefined || !snapshot.setupComplete) return false
  if (snapshot.validationVersion !== Number(VALIDATION_VERSION)) return false
  let resolved
  try {
    resolved = await services.credentials.resolve(credentialRef(ACCESS_CREDENTIAL_REF))
  } catch {
    // provider 存储层异常按未激活处理（fail-closed），原始错误不外抛。
    return false
  }
  return resolved !== undefined && resolved.value !== ''
}
