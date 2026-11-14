/**
 * yootun 企业接入层 host 半。职责两项：
 * 1. 暴露 `yootun-access` 设置 namespace 的 Config schema（settings 服务按活跃
 *    entry id 收集 namespace，client 半经 configForms 读写，见分册 03 A/C 部分）；
 * 2. 注册同源激活 API 路由（validate/models）：本地 client 页面同源调用，
 *    host 转发 ixicai.cn 并携带租户头，浏览器侧无跨域暴露（旧桌面壳
 *    dofe-access-route 的 0.2.2 形态迁移）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'
import { handleDofeModelsRequest, handleDofeValidateRequest } from './route.ts'

/** Cordis function-plugin name. */
export const name = 'yootun-ui-access'

/** Host services required before the routes register. */
export const inject = ['webServer']

/** `yootun-access` 设置 section 的字段：授权事实与激活写入面（client 半 CAS 提交）。 */
export interface Config {
  /** 本机已完成一次成功激活（门禁解锁的必要条件之一）。 */
  setupComplete: boolean
  /** 写入时的激活契约版本；门禁要求与构建期注入的版本一致。 */
  validationVersion: number
  /** managed MCP 挂载的门禁输入；激活流程固定写空数组（分册 03 A 部分）。 */
  enabledPlugins: string[]
  /** 激活时选择的默认模型 id。 */
  modelId: string
}

export const Config = z.object({
  setupComplete: z.boolean().default(false).volatile(),
  validationVersion: z.number().default(0).volatile(),
  enabledPlugins: z.array(z.string()).default([]).volatile(),
  modelId: z.string().default('').volatile(),
})

/**
 * Register the same-origin activation routes. The expected origin reads at
 * request time: the webServer binds its port during service init, so the value
 * is stable before any request can reach a handler.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact', path: '/api/desktop/dofe/validate',
      handler: (req: IncomingMessage, res: ServerResponse): Promise<void> =>
        handleDofeValidateRequest(req, res, ctx.webServer.getOrigin()),
    }),
    'yootun-ui-access: validate route',
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact', path: '/api/desktop/dofe/models',
      handler: (req: IncomingMessage, res: ServerResponse): Promise<void> =>
        handleDofeModelsRequest(req, res, ctx.webServer.getOrigin()),
    }),
    'yootun-ui-access: models route',
  )
}
