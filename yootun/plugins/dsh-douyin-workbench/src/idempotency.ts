/**
 * Workbench 写操作幂等键模板（分册 15 §3/§8 冻结的旧 tools-client.js 模板）：
 * 服务端按模板前缀校验，键形不符直接拒绝；`douyin:` 前缀统一。页面写 action
 * 的键由页面生成并经 route 层模板校验（route.ts idempotency 契约）；本模块
 * 只承载 Host 自身发起的编排写（session 上报 / account_save / account_remove /
 * 采集 run 链）。attemptUuid 为 32 位小写 hex。
 * @module
 */
import { randomBytes } from 'node:crypto'

/** 生成 32 位小写 hex 的 attemptUuid（route 层键模板的白名单后缀）。 */
export function attemptUuid(): string {
  return randomBytes(16).toString('hex')
}

/** 会话状态上报键：同一序号重投安全，不含 checkedAt。 */
export const sessionIdempotencyKey = (accountId: string, seq: number): string => `douyin:session:${accountId}:${String(seq)}`

/** account_save 键：刻意时间戳（upsert 幂等由 accountId 承载）。 */
export const accountSaveIdempotencyKey = (accountId: string, stamp = Date.now()): string => `douyin:account:${accountId}:${String(stamp)}`

/** account_remove 键：每次操作新键。 */
export const accountRemoveIdempotencyKey = (accountId: string, stamp = Date.now()): string => `douyin:account_remove:${accountId}:${String(stamp)}`

/** run_start 键：键段必须是本次 runAttemptId（服务端 suffix 校验）。 */
export const runStartIdempotencyKey = (runAttemptId: string): string => `douyin:run_start:${runAttemptId}`

/** 列表元信息键：固定为 runId。 */
export const listMetaIdempotencyKey = (runId: string): string => `douyin:list_meta:${runId}`

/** 心跳键：seq 单调。 */
export const heartbeatIdempotencyKey = (runId: string, seq: number): string => `douyin:heartbeat:${runId}:${String(seq)}`

/** works 批次键：(runId, batchNo) 服务端账本去重，同键重投安全。 */
export const ingestBatchIdempotencyKey = (runId: string, batchNo: number): string => `douyin:ingest:${runId}:${String(batchNo)}`

/** 日度入库键：固定为 runId。 */
export const ingestDailyIdempotencyKey = (runId: string): string => `douyin:daily:${runId}`

/** run_finish 键：固定为 runId。 */
export const runFinishIdempotencyKey = (runId: string): string => `douyin:run_finish:${runId}`
