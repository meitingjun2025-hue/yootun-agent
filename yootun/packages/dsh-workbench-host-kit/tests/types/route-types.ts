/**
 * 路由响应类型层检查（实施单 workbench-host-kit H4；无运行时断言，随包
 * `build` 的 `tsc -p tests/types/tsconfig.json` 执行）：handler 返回未登记
 * reason 码在 tsc 下报错（`@ts-expect-error` 未命中会反过来报错），已登记码
 * 与成功词汇正常通过。
 */
import { createActionRoute, type ActionHandler, type HandlerPayload } from '../../src/route.ts'

type Code = 'A_ROUTE_INVALID_REQUEST' | 'A_ROUTE_PAYLOAD_TOO_LARGE' | 'A_ROUTE_REFUSED'
type Success = 'ready' | 'started'

const goodPayload: HandlerPayload<Success, Code> = { status: 'ready', value: 1 }
const goodError: HandlerPayload<Success, Code> = { status: 'error', reason: 'A_ROUTE_REFUSED' }
void goodPayload
void goodError

// 未登记的 reason 码（不在 Code 白名单）必须编译报错。
const badHandler: ActionHandler<Success, Code> = async () =>
  // @ts-expect-error -- reason 必须是登记的稳定码白名单成员（H4）。
  ({ status: 'error', reason: 'NOT_REGISTERED' })
void badHandler

const okHandler: ActionHandler<Success, Code> = async () => ({ status: 'started' })
void okHandler

// createActionRoute 的 handlers 形状同样受约束（类型经显式注解固定，同插件
// buildRouteHandlers 的返回类型）：登记码通过，未登记码报错。
const registeredHandlers: Readonly<Record<string, ActionHandler<Success, Code>>> = { 'a.get': okHandler }
createActionRoute({
  expectedOrigin: () => 'http://127.0.0.1:1',
  actionSchemas: { 'a.get': {} },
  validate: () => ({}),
  handlers: registeredHandlers,
  codes: { invalidRequest: 'A_ROUTE_INVALID_REQUEST', payloadTooLarge: 'A_ROUTE_PAYLOAD_TOO_LARGE', routeCodePrefix: 'A_ROUTE' },
  safeCode: () => 'A_ROUTE_INVALID_REQUEST',
  isStableCode: code => code.startsWith('A_ROUTE'),
  maxBodyBytes: 1024,
})
const unregisteredHandlers: Readonly<Record<string, ActionHandler<Success, Code>>> = {
  // @ts-expect-error -- handler 返回的 reason 超出稳定码白名单即编译报错（H4）。
  'a.get': async () => ({ status: 'error', reason: 'NOT_REGISTERED' }),
}
void unregisteredHandlers
