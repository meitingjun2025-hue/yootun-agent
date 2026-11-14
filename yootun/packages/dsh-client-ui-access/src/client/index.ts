/**
 * yootun 接入 client 半：locale 词典、全屏门禁挂载、settings.section 区块。
 * 门禁与设置区块都跟随 `yootun-access` namespace 的在服状态（whileServed）：
 * 包被禁用或宿主未提供该 section 时两者都不出现（分册 03 F 部分的同机制语义）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { AccessSection } from './section.tsx'
import { mountGate } from './gate.tsx'
import { en, NS, zh, type AccessLocaleKey } from './locales.ts'
import { ACCESS_NAMESPACE } from '../access-constants.ts'
import type { AccessForms, AccessSettings, CredentialsFace } from './logic.ts'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/** `llm-deepseek` section 的写入面（激活流程覆写网关默认目录）。 */
/** `agent-default-model` section 的写入面。 */
type DefaultModelForm = ConfigForm<{ provider: string; model: string }>

/**
 * Mount the access gate and the settings section while the Host serves the
 * `yootun-access` namespace.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'yootun-ui-access: dictionaries')

  const forms: AccessForms = {
    access: ctx.configForms.get<AccessSettings>(ACCESS_NAMESPACE),
    defaultModel: ctx.configForms.get('agent-default-model') as DefaultModelForm,
  }
  const credentials: CredentialsFace = {
    describe: refs => ctx.remote.credentials.describe(refs),
    set: (ref, value) => ctx.remote.credentials.set(ref, value),
    unset: ref => ctx.remote.credentials.unset(ref),
  }
  const injected = (): { forms: AccessForms; credentials: CredentialsFace; t: typeof t } => ({ forms, credentials, t })

  ctx.effect(
    () => ctx.configForms.whileServed([ACCESS_NAMESPACE], () => mountGate({ forms, credentials, t })),
    'yootun-ui-access: mandatory gate',
  )
  ctx.effect(
    () => ctx.configForms.whileServed([ACCESS_NAMESPACE], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: ACCESS_NAMESPACE,
      order: 20,
      label: () => t('nav'),
      locale: NS,
      inject: injected,
    }, AccessSection))),
    'yootun-ui-access: settings section',
  )
}

export type { AccessLocaleKey }
