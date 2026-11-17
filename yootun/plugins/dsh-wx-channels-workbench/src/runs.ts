/**
 * 采集 run 持久化（runs.json）：一次采集全程（start/progress/终态）更新同一条
 * 记录，key 是稳定 attemptId（run 启动时生成，进度与终态都引用它）——不再有
 * 「pending 占位 + 远端 runId 另立两条」的分裂；重启时 running → interrupted
 * 是真实中断（running 记录只在 run 真正启动后存在）。所有 read-modify-write
 * 走 per-root 串行队列，并发调用不丢更新。文件写入与 accounts.json 同口径
 * （0600 原子写）。每条记录为白名单投影，无凭证/路径。
 * @module
 */
import { readFile, rename, writeFile, chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 一条采集 run 的持久化记录（白名单投影，无凭证/路径）。 */
export interface RunRecord {
  accountId: string
  /** 稳定 attemptId：runs.json 的 key，run 全生命周期（start/progress/终态）不变。 */
  attemptId: string
  /** 远端 runId（服务端 run 启动后回填；启动前/取消时为 null）。 */
  runId: string | null
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
  startedAt: string
  finishedAt: string | null
  progress: Record<string, unknown>
  error: string | null
}

const RUNS_VERSION = 1

/** 构建指定 root 的 runs.json 路径。 */
export function runsFilePath(root: string): string {
  return join(root, 'runs.json')
}

/** 生成一次采集的稳定 attemptId（同账号多次采集各不相同）。 */
export function createAttemptId(accountId: string): string {
  return `${accountId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 记录规范化：缺字段兜底（兼容手工编辑/旧数据），attemptId 以 key 为准。 */
function normalizeRunRecord(key: string, value: unknown): RunRecord {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<RunRecord> : {}
  const status = record.status
  return {
    accountId: typeof record.accountId === 'string' ? record.accountId : '',
    attemptId: key,
    runId: typeof record.runId === 'string' && record.runId !== '' ? record.runId : null,
    status: status === 'running' || status === 'completed' || status === 'partial' || status === 'failed' || status === 'cancelled' || status === 'interrupted' ? status : 'failed',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    progress: record.progress && typeof record.progress === 'object' && !Array.isArray(record.progress) ? record.progress : {},
    error: typeof record.error === 'string' ? record.error : null,
  }
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
    const rawRuns = (parsed as { runs: Record<string, unknown> }).runs
    const runs: Record<string, RunRecord> = {}
    for (const [key, value] of Object.entries(rawRuns)) {
      runs[key] = normalizeRunRecord(key, value)
    }
    return runs
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

/** per-root 串行队列：并发 updateRun / recoverInterruptedRuns / removeAccountRuns 不丢更新。 */
const rootQueues = new Map<string, Promise<unknown>>()

function withRootLock<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = rootQueues.get(root) ?? Promise.resolve()
  const current = previous.then(task, task)
  rootQueues.set(root, current.catch(() => undefined))
  return current
}

/**
 * 一次采集的统一写入入口：read-modify-write 走 root 串行队列。记录不存在时以
 * running 语义创建（accountId/attemptId 必填，startedAt 取当前时间）；存在时
 * 只合并 patch 提供的字段，其余（startedAt 等）原样保留——start/progress/
 * completed/partial/failed/cancelled 因此始终落在同一条记录上。
 * @param root - state root.
 * @param accountId - the account the run belongs to.
 * @param attemptId - stable run key.
 * @param patch - fields to merge (accountId/attemptId cannot be overridden).
 * @returns the merged record after this write.
 */
export async function updateRun(root: string, accountId: string, attemptId: string, patch: Partial<Omit<RunRecord, 'accountId' | 'attemptId'>>): Promise<RunRecord> {
  return withRootLock(root, async () => {
    const runs = await readRuns(root)
    const existing = runs[attemptId]
    const base: RunRecord = existing ?? {
      accountId,
      attemptId,
      runId: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      progress: {},
    }
    const record: RunRecord = { ...base, ...patch, accountId: base.accountId, attemptId }
    runs[attemptId] = record
    await writeRuns(root, runs)
    return record
  })
}

/**
 * 启动恢复：status=running 的记录标为 interrupted（数据保留），由用户决定
 * 是否重新采集。不删任何记录。running 记录只在 run 真正启动后存在，因此
 * interrupted 不是幻影。
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

/**
 * 按 accountId 一次性清理该账号全部 run 记录（root 串行队列内的原子
 * read-modify-write：清理期间其他账号的并发写入不丢失、本账号无漏删窗口）。
 * @param root - state root.
 * @param accountId - the account whose runs are removed.
 * @returns the number of removed records.
 */
export async function removeAccountRuns(root: string, accountId: string): Promise<number> {
  return withRootLock(root, async () => {
    const runs = await readRuns(root)
    const kept: Record<string, RunRecord> = {}
    let removed = 0
    for (const [key, record] of Object.entries(runs)) {
      if (record.accountId === accountId) removed += 1
      else kept[key] = record
    }
    if (removed > 0) await writeRuns(root, kept)
    return removed
  })
}
