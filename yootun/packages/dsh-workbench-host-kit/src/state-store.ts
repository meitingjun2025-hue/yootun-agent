/**
 * 状态文件原子写与按 root 写队列（进程级唯一实例）：tmp(pid+随机) 同目录
 * rename 的 0600 原子写，加上按 root 串行的 read-modify-write 队列。写队列是
 * 文件级事实、进程内共享：同一 root 被同进程的两个插件实例写时，串行化必须
 * 跨实例成立；锁实例则随插件实例创建（见 profile-locks）。
 * @module
 */
import { chmod, rename, writeFile } from 'node:fs/promises'

/**
 * Atomic 0600 JSON write: tmp(pid+rand) in the same directory → rename →
 * chmod（best-effort；Windows 上 chmod 语义有限）. 同机同进程并发写时固定 tmp
 * 名会被交错覆盖（wx P3-1 同款），pid+随机段隔离；rename 保证半截文件永不出
 * 现在最终路径。序列化口径固定为两空格缩进 + 单个结尾换行（三工作台状态文件
 * 现状格式）。
 * @param file - target file path（所在目录须已存在）。
 * @param value - JSON value to persist.
 */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => undefined)
}

/**
 * per-root 串行队列（进程级唯一实例，有意共享）：并发 read-modify-write 排队
 * 执行，不丢更新；任务抛错后队列继续；空闲即回收 Map entry，避免动态 root
 * 累积。按文件级事实共享——同一 root 的两份插件实例写同一文件时串行化仍成立。
 */
export const rootQueues = new Map<string, Promise<unknown>>()

/**
 * Serialize a read-modify-write task per root（锁内不得再对同一 root 调
 * `runInRootQueue`，否则同 root 死锁）。序列保证：任务按调用顺序执行，前序
 * 任务失败不阻断后续任务。
 * @param root - state root directory.
 * @param task - the exclusive operation.
 * @returns the task's result; rejection propagates to the caller.
 */
export function runInRootQueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve()
  const current = previous.then(task, task)
  const release = current.catch(() => undefined).then(() => {
    // 空闲即回收 entry；新任务仍排在 release 之后，顺序不变。
    if (rootQueues.get(root) === release) rootQueues.delete(root)
  })
  rootQueues.set(root, release)
  return current
}
