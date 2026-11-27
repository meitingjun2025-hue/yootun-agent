/**
 * 采集 run 持久化（runs.json）：一次采集全程（start/progress/终态）更新同一条
 * 记录，key 是稳定 attemptId（run 启动时生成，进度与终态都引用它）——不再有
 * 「pending 占位 + 远端 runId 另立两条」的分裂；重启时 running → interrupted
 * 是真实中断（running 记录只在 run 真正启动后存在）。所有 read-modify-write
 * 走 per-root 串行队列，并发调用不丢更新。文件写入与 accounts.json 同口径
 * （0600 原子写）。每条记录为白名单投影，无凭证/路径。
 * @module
 */
import { mkdir, readFile } from 'node:fs/promises'
import { atomicWriteJson, runInRootQueue } from '@yootun/dsh-workbench-host-kit'
import { dirname, join } from 'node:path'
import { WxError } from './errors.ts'

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

/**
 * 记录语义校验：结构非法（缺必填字段/类型不符/未知 status）抛
 * `run_state_corrupt`——绝不静默修补（把非法记录改写回文件会掩盖真实状态）。
 * 合法旧字段可兼容：runId/finishedAt/progress/error 缺失按空值语义补齐；
 * attemptId 恒以 key 为准（与 updateRun 的写入语义一致，记录内值不采信）。
 */
function parseRunRecord(key: string, value: unknown): RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WxError('run_state_corrupt', `runs.json record "${key}" is not an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.accountId !== 'string') {
    throw new WxError('run_state_corrupt', `runs.json record "${key}": accountId must be a string`)
  }
  if (typeof record.startedAt !== 'string') {
    throw new WxError('run_state_corrupt', `runs.json record "${key}": startedAt must be a string`)
  }
  const status = record.status
  if (status !== 'running' && status !== 'completed' && status !== 'partial' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') {
    throw new WxError('run_state_corrupt', `runs.json record "${key}": unknown status ${JSON.stringify(status)}`)
  }
  for (const field of ['attemptId', 'runId', 'finishedAt', 'error'] as const) {
    const raw = record[field]
    if (raw !== undefined && raw !== null && typeof raw !== 'string') {
      throw new WxError('run_state_corrupt', `runs.json record "${key}": ${field} must be a string or null`)
    }
  }
  const progress = record.progress
  if (progress !== undefined && (!progress || typeof progress !== 'object' || Array.isArray(progress))) {
    throw new WxError('run_state_corrupt', `runs.json record "${key}": progress must be an object`)
  }
  const runId = typeof record.runId === 'string' && record.runId !== '' ? record.runId : null
  return {
    accountId: record.accountId,
    attemptId: key,
    runId,
    status,
    startedAt: record.startedAt,
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : null,
    progress: progress && typeof progress === 'object' && !Array.isArray(progress) ? progress as Record<string, unknown> : {},
    error: typeof record.error === 'string' ? record.error : null,
  }
}

/**
 * 读全部 run 记录。文件不存在返回空 map（正常态）；JSON 语法错误、顶层
 * shape 无法识别、version 缺失/类型错/不等于 {@link RUNS_VERSION}、runs 非
 * 对象、任何记录结构非法 → 抛 `run_state_corrupt` 稳定错误，原文件保持
 * 原样（updateRun / recoverInterruptedRuns / removeAccountRuns 因此全部
 * 失败，绝不覆盖损坏文件）。
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
    throw new WxError('run_state_corrupt', `runs.json is not valid JSON: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WxError('run_state_corrupt', 'runs.json top-level shape is not recognized (not an object)')
  }
  const version = (parsed as { version?: unknown }).version
  if (version !== RUNS_VERSION) {
    throw new WxError('run_state_corrupt', `runs.json version must be ${String(RUNS_VERSION)}, got ${JSON.stringify(version)}`)
  }
  const rawRuns = (parsed as { runs: unknown }).runs
  if (!rawRuns || typeof rawRuns !== 'object' || Array.isArray(rawRuns)) {
    throw new WxError('run_state_corrupt', 'runs.json "runs" must be an object')
  }
  const runs: Record<string, RunRecord> = {}
  for (const [key, value] of Object.entries(rawRuns)) {
    runs[key] = parseRunRecord(key, value)
  }
  return runs
}

/** 原子 0600 写全部 run 记录（kit 原子写；tmp 名带 pid 与随机段）。 */
async function writeRuns(root: string, runs: Record<string, RunRecord>): Promise<void> {
  const file = runsFilePath(root)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await atomicWriteJson(file, { version: RUNS_VERSION, runs })
}

/**
 * 在 per-root 串行队列内运行 `task`（组合多步 runs 操作的公开入口；测试用它
 * 构造确定性挂起场景）。队列实现为 kit 的进程级实例——同 root 的 accounts 与
 * runs 写入、以及同进程的多个插件实例共用同一条串行链。
 */
export { runInRootQueue } from '@yootun/dsh-workbench-host-kit'

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
  return runInRootQueue(root, async () => {
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
 * @returns the interruption summary（count 与去重的 accountIds，供中断横幅）.
 */
/** 启动中断摘要（横幅的操作范围；accountIds 去重）。 */
export interface InterruptedRunsSummary {
  /** 本次被标记为 interrupted 的去重账号数（与 accountIds 一致）。 */
  count: number
  /** 被中断的账号（去重；与 2.5 横幅的「重新采集 / 重新采集全部」范围对应）。 */
  accountIds: string[]
}

export async function recoverInterruptedRuns(root: string): Promise<InterruptedRunsSummary> {
  return runInRootQueue(root, async () => {
    const runs = await readRuns(root)
    const accountIds = new Set<string>()
    for (const record of Object.values(runs)) {
      if (record.status === 'running') {
        record.status = 'interrupted'
        record.finishedAt = new Date().toISOString()
        accountIds.add(record.accountId)
      }
    }
    if (accountIds.size > 0) await writeRuns(root, runs)
    return { count: accountIds.size, accountIds: [...accountIds].sort() }
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
  return runInRootQueue(root, async () => {
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
