/**
 * 采集 run 持久化（G-2，分册 15 §11：旧插件采集状态是进程内存，进程重启丢
 * 失——新实现把 run 生命周期落盘 runs.json）：一次采集全程（start/progress/
 * 终态）更新同一条记录，key 是稳定 attemptId（同时是 run_start 幂等键的键段，
 * `douyin:run_start:{attemptId}`）；重启后 running → interrupted 是真实中断
 * （running 记录只在 run 真正启动后存在），远端终态经 `collect_run_get`
 * （workbench_douyin_collect_run_get）查询投影，查询不了给稳定
 * `recovery_required`，不伪造 running。所有 read-modify-write 走 per-root 串行
 * 队列；原子 0600 写；记录为白名单投影，无 Cookie / storage_state / 本地路径。
 * @module
 */
import { readFile, rename, writeFile, chmod, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DouyinError } from './errors.ts'

/** 一条采集 run 的持久化记录（白名单投影，无凭证/路径）。 */
export interface RunRecord {
  accountId: string
  /** 稳定 attemptId：runs.json 的 key、run_start 幂等键键段，run 全生命周期不变。 */
  attemptId: string
  /** 远端 runId（服务端 run 启动后回填；启动前/取消时为 null）。 */
  runId: string | null
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted'
  /** 采集编排阶段（probing/list/details/ingest/finishing…，白名单投影）。 */
  phase: string | null
  /** 本轮采集范围起点（固定 2026-05-31T16:00:00Z 字面量；空 run 亦声明）。 */
  publishSince: string | null
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

/** 生成一次采集的稳定 attemptId（同账号多次采集各不相同；32 位 hex 兼容键模板）。 */
export function createAttemptId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`.padEnd(24, '0').slice(0, 24)
}

/**
 * 记录语义校验：结构非法（缺必填字段/类型不符/未知 status）抛
 * `run_state_corrupt`——绝不静默修补（把非法记录改写回文件会掩盖真实状态）。
 * attemptId 恒以 key 为准（与 updateRun 的写入语义一致，记录内值不采信）。
 */
function parseRunRecord(key: string, value: unknown): RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DouyinError('run_state_corrupt', `runs.json record "${key}" is not an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.accountId !== 'string') {
    throw new DouyinError('run_state_corrupt', `runs.json record "${key}": accountId must be a string`)
  }
  if (typeof record.startedAt !== 'string') {
    throw new DouyinError('run_state_corrupt', `runs.json record "${key}": startedAt must be a string`)
  }
  const status = record.status
  if (status !== 'running' && status !== 'completed' && status !== 'partial' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') {
    throw new DouyinError('run_state_corrupt', `runs.json record "${key}": unknown status ${JSON.stringify(status)}`)
  }
  for (const field of ['attemptId', 'runId', 'phase', 'publishSince', 'finishedAt', 'error'] as const) {
    const raw = record[field]
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new DouyinError('run_state_corrupt', `runs.json record "${key}": ${field} must be a string or null`)
    }
  }
  const progress = record.progress
  if (progress !== undefined && (!progress || typeof progress !== 'object' || Array.isArray(progress))) {
    throw new DouyinError('run_state_corrupt', `runs.json record "${key}": progress must be an object`)
  }
  return {
    accountId: record.accountId,
    attemptId: key,
    runId: typeof record.runId === 'string' && record.runId !== '' ? record.runId : null,
    status,
    phase: typeof record.phase === 'string' && record.phase !== '' ? record.phase : null,
    publishSince: typeof record.publishSince === 'string' && record.publishSince !== '' ? record.publishSince : null,
    startedAt: record.startedAt,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    progress: progress && typeof progress === 'object' && !Array.isArray(progress) ? progress as Record<string, unknown> : {},
    error: typeof record.error === 'string' ? record.error : null,
  }
}

/**
 * 读全部 run 记录。文件不存在返回空 map（正常态）；JSON 语法错误、顶层
 * shape 无法识别、version 不等于 {@link RUNS_VERSION}、runs 非对象、任何记录
 * 结构非法 → 抛 `run_state_corrupt` 稳定错误，原文件保持原样。
 */
export async function readRuns(root: string): Promise<Record<string, RunRecord>> {
  const file = runsFilePath(root)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new DouyinError('run_state_corrupt', `runs.json is not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DouyinError('run_state_corrupt', 'runs.json top-level shape is not recognized (not an object)')
  }
  const version = (parsed as { version?: unknown }).version
  if (version !== RUNS_VERSION) {
    throw new DouyinError('run_state_corrupt', `runs.json version must be ${String(RUNS_VERSION)}, got ${JSON.stringify(version)}`)
  }
  const rawRuns = (parsed as { runs: unknown }).runs
  if (!rawRuns || typeof rawRuns !== 'object' || Array.isArray(rawRuns)) {
    throw new DouyinError('run_state_corrupt', 'runs.json "runs" must be an object')
  }
  const runs: Record<string, RunRecord> = {}
  for (const [key, value] of Object.entries(rawRuns)) {
    runs[key] = parseRunRecord(key, value)
  }
  return runs
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
 * 在 per-root 串行队列内运行 `task`（组合多步 runs 操作的公开入口；测试用它
 * 构造确定性挂起场景）。
 */
export function runInRootQueue<T>(root: string, task: () => Promise<T>): Promise<T> {
  return withRootLock(root, task)
}

/**
 * 一次采集的统一写入入口：read-modify-write 走 root 串行队列。记录不存在时以
 * running 语义创建（accountId/attemptId 必填，startedAt 取当前时间）；存在时
 * 只合并 patch 提供的字段，其余（startedAt 等）原样保留。
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
      phase: null,
      publishSince: null,
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
 * 启动恢复：status=running 的记录标为 interrupted（数据保留），远端终态由
 * collect.status 经 collect_run_get 查询投影。不删任何记录、不伪造 running。
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
 * read-modify-write；删除账号时调用，排期数据不随账号删除级联——本文件只
 * 管 runs）。
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
