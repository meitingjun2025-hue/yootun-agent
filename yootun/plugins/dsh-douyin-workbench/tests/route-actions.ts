/**
 * 按键取 route action 处理函数的辅助：`buildRouteHandlers` 返回
 * `Record<string, ActionHandler>`，按键取值可能为 `undefined`，各测试直接
 * 调用会在类型检查下报错。统一经本辅助取值——键未注册即抛错并写明键名，
 * 不掩盖装配缺键的问题。
 * @module
 */
import type { ActionHandler } from '../src/index.ts'

/**
 * Read one action handler from a route handler table.
 * @param handlers - the table returned by `buildRouteHandlers`.
 * @param key - action key (a key of route.ts `ACTION_SCHEMAS`).
 * @returns the handler registered for the action.
 */
export function routeAction(handlers: Readonly<Record<string, ActionHandler>>, key: string): ActionHandler {
  const handler = handlers[key]
  if (handler === undefined) throw new Error(`route action 未注册：${key}`)
  return handler
}
