/**
 * yootun 工作台 Host 共享库（纯 Node：不依赖 cordis、不注册服务、不含 React）。
 * 三工作台与 managed-mcp、media-upload 的 Host 侧基础能力唯一实现：同源路由
 * 信任判定与 action 分发、任务登记表、profile 锁、状态文件原子写与按 root 写
 * 队列、系统 Chrome 探测与浏览器生命周期。本文件只做再导出。
 * @module @yootun/dsh-workbench-host-kit
 */
export {
  permitted,
  readJsonBody,
  sendJson,
  createActionRoute,
  ROUTE_REFUSAL_REASONS,
  RouteBodyTooLargeError,
  type RouteRequest,
  type RouteResponse,
  type RouteRefusalReason,
  type ActionArgs,
  type ActionHandler,
  type HandlerPayload,
  type ActionRouteCodes,
  type ActionRouteOptions,
} from './route.ts'
export {
  createTaskRegistry,
  DEFAULT_DISPOSE_BUDGET_MS,
  type TaskRegistry,
  type AwaitSettledOutcome,
} from './task-registry.ts'
export {
  createProfileLocks,
  type ProfileLocks,
  type ProfileLockAttempt,
  type ProfileLockRelease,
} from './profile-locks.ts'
export {
  atomicWriteJson,
  rootQueues,
  runInRootQueue,
} from './state-store.ts'
export {
  chromeCandidates,
  resolveSystemChrome,
  LAUNCH_ARGS,
  ChromeMissingError,
  DriverMissingError,
  BrowserLaunchTimeoutError,
  closeContext,
  launchWithTimeout,
  browserCloseTimeoutMessage,
  DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
  DEFAULT_LAUNCH_TIMEOUT_MS,
} from './chrome.ts'
