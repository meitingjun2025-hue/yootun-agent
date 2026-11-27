/**
 * yootun 工作台数据流 machine 共享核心（纯 client：无 React、无 DOM 依赖）。
 * 登录、单账号采集、批量采集、作品查询四个 machine 的状态与竞态守卫；插件
 * 以 ports 适配层接入各自的 schema 投影（抖音/视频号 flows.ts）。页面用
 * useSyncExternalStore 订阅（machine 2.2 通用形态）。
 * @module
 */
export { createPoller, type Poller, type PollerOptions, type PollerSchedule } from './polling.ts'
export { createLatest, type LatestGuard } from './guards.ts'
export type { MachineStore, PollerSchedule as PollerScheduleBase } from './types.ts'
export {
  createLoginMachine,
  type LoginMachine,
  type LoginMachinePorts,
  type LoginState,
} from './login-machine.ts'
export {
  createCollectMachine,
  type CollectMachine,
  type CollectMachinePorts,
  type CollectState,
} from './collect-machine.ts'
export {
  createBatchMachine,
  pollBatchOnce,
  type BatchMachine,
  type BatchMachinePorts,
  type BatchPollerDeps,
  type BatchState,
} from './batch-machine.ts'
export {
  createWorksQuery,
  type WorksQuery,
  type WorksQueryPorts,
  type WorksQueryState,
  type WorksPageLike,
  type WorksSortLike,
} from './works-query.ts'
