/**
 * 采集 run 持久化（runs.json）：崩溃或重启后 run 恢复。每条 run 记录含
 * accountId / runId / status / startedAt / finishedAt / progress / error。
 * 启动时读取：status=running 的记录标记为 interrupted（保留已完成批次投影），
 * 由用户决定是否重新采集。文件写入与 accounts.json 同口径（0600 原子写）。
 * @module
 */
import { readFile, rename, stat, writeFile, chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一条采集 run 的持久化记录（白名单投影，无凭证/路径）。 */
export interface RunRecord {
  accountId: string
  runId: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  error: string | null
  progress: Record<string, unknown>
}

const RUNS_VERSION = 1

/** 构建指定 root 的 runs.json 路径。 */
export function runsFilePath(root: string): string {
  return join(root, 'runs.json')
}

/** 读全部 run 记录（文件不存在返回空 map；损坏抛错不改写）。 */
export async function readRuns(root: string): Promise<Record<string, RunRecord>> {
  const file = runsFilePath(root)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !(parsed as { runs?: unknown }).runs) {
      return {}
    }
    return (parsed as { runs: Record<string, RunRecord> }).runs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

/** 原子 0600 写全部 run 记录。 */
async function writeRuns(root: string, runs: Record<string, RunRecord>): Promise<void> {
  const file = runsFilePath(root)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${String(process.pid)}-${String(Math.random()).slice(2, 8)}`
  await writeFile(tmp, `${JSON.stringify({ version: RUNS_VERSION, runs }, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  await chmod(file, 0o600).catch(() => undefined)
}

/** per-root 串行队列：并发 upsertRun / recoverInterruptedRuns / removeRun 不丢更新。 */
const rootQueues = new Map<string, Promise<unknown>>()

function withRootLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve()
  const current = previous.then(task, task)
  rootQueues.set(root, current.catch(() => undefined))
  return current
}

/**
 * 登记或更新一条 run 记录（root 级串行写，防并发丢更新）。
 * @param root - state root.
 * @param record - the run record to upsert (keyed by runId).
 */
export async function upsertRun(root: string, record: RunRecord): Promise<void> {
  return withRootLock(root, async () => {
    const runs = await readRuns(root)
    runs[record.runId] = record
    await writeRuns(root, runs)
  })
}

/**
 * 启动恢复：status=running 的记录标为 interrupted（数据保留），由用户决定
 * 是否重新采集。不删任何记录。
 * @param root - state root.
 * @returns the number of records marked interrupted.
 */
export async function recoverInterruptedRuns(root: string): Promise<number> {
  return withRootLock(root, async () => {
    const runs = await readRuns(root)
    let count = 0
    for (const record of Object.values(runs)) {
      if (record.status === 'running') {
        record.status = 'interrupted'
        record.finishedAt = new Date().toISOString()
        count += 1
      }
    }
    if (count > 0) await writeRuns(root, runs)
    return count
  })
}

/** 删除一条 run 记录（账号删除时清理；root 级串行）。 */
export async function removeRun(root: string, runId: string): Promise<void> {
  return withRootLock(root, async () => {
    const runs = await readRuns(root)
    delete runs[runId]
    await writeRuns(root, runs)
  })
}

// stat 保留（与原导入一致，当前用于 possible future size check）。
void stat
