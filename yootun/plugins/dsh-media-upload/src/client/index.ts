/**
 * media-upload client 半（函数插件）：登记词典命名空间并在 shell.overlay
 * 注册「上传请求」承接卡片。卡片轮询 Host 的 pending 路由发现
 * media_upload 会话工具创建的上传会话；页面自己发起的上传（pick-file，
 * origin page）不出现在 pending，不触发卡片。
 * @module
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { NS, en, zh, type HandoffLocaleKey } from './locales.ts'
import { HandoffCard } from './handoff-card.tsx'

export { NS, zh, en, type HandoffLocaleKey } from './locales.ts'
export { HandoffCard, type HandoffCardProps } from './handoff-card.tsx'
export { pendingUploads, cancelUpload, sendUploadBytes, pollUploadStatus, type PendingUploadSession, type UploadStatusSnapshot } from './upload-api.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** media_upload 承接卡片文案。 */
    'yootun.mediaUpload': HandoffLocaleKey
  }
}

/** Cordis function-plugin name. */
export const name = 'yootun-media-upload-client'

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the dictionary namespace and the shell.overlay handoff card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'yootun-media-upload-client: dictionaries')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'yootun-media-upload.handoff',
    locale: NS,
  }, HandoffCard)), 'yootun-media-upload-client: shell.overlay handoff card')
}
