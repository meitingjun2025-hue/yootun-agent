/**
 * machine 通用视图与基座类型：各插件以自己的 schema 投影实现 ports，视图
 * 类型由插件声明（machine 只要求可分类的字段）。
 * @module
 */

/** machine 的订阅基座：`get()` 变化时返回新引用（useSyncExternalStore 要求）。 */
export interface MachineStore<State> {
  get(): State
  subscribe(listener: () => void): () => void
}

/** 轮询器注入面（真实实现 setInterval；测试注入假时钟）。 */
export interface PollerSchedule {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}
