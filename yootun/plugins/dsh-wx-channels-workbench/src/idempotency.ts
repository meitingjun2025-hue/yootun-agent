/**
 * 幂等键模板（迁移旧 tools-client.js 口径）：键段语义由服务端校验
 * （run_start 的键后缀必须是 runId）；workbench 面沿用同一服务端业务层，
 * 键模板与旧 face 保持一致。账号存/删的键含时间戳（每次操作新键）。
 * @module
 */

/** 会话状态上报键：同一序号重投安全。 */
export const sessionIdempotencyKey = (accountId: string, seq: number): string => `wx_channels:session:${accountId}:${seq}`
/** run_start 键：键段必须是本次 runId（服务端 suffix 校验）。 */
export const runStartIdempotencyKey = (runAttemptId: string): string => `wx_channels:run_start:${runAttemptId}`
/** 列表元信息键：固定为 runId。 */
export const listMetaIdempotencyKey = (runId: string): string => `wx_channels:run_meta:${runId}`
/** 心跳键：seq 单调。 */
export const heartbeatIdempotencyKey = (runId: string, seq: number): string => `wx_channels:heartbeat:${runId}:${seq}`
/** works 批次键：(runId, batchNo) 账本去重；失败对象重投加 `:retry{n}`。 */
export const ingestWorksIdempotencyKey = (runId: string, batchNo: number): string => `wx_channels:ingest_works:${runId}:${batchNo}`
/** 账号级指标键：键嵌窗口。 */
export const ingestAccountMetricsIdempotencyKey = (runId: string, startDay: string, endDay: string): string =>
  `wx_channels:account_metrics:${runId}:${startDay}:${endDay}`
/** fans_trend 键：键嵌分块窗口。 */
export const ingestFansTrendIdempotencyKey = (runId: string, startDay: string, endDay: string): string =>
  `wx_channels:fans_trend:${runId}:${startDay}:${endDay}`
/** fans_profile 键：键嵌 day。 */
export const ingestFansProfileIdempotencyKey = (runId: string, day: string): string => `wx_channels:fans_profile:${runId}:${day}`
/** finish 键：固定为 runId。 */
export const runFinishIdempotencyKey = (runId: string): string => `wx_channels:run_finish:${runId}`
/** cancel 键：固定为 runId（幂等终止）。 */
export const runCancelIdempotencyKey = (runId: string): string => `wx_channels:run_cancel:${runId}`
/** 账号保存键：每次操作新键（upsert 幂等由 (accountId) 承载）。 */
export const accountSaveIdempotencyKey = (accountId: string, stamp = Date.now()): string => `wx_channels:account_save:${accountId}:${stamp}`
/** 账号删除键：每次操作新键。 */
export const accountRemoveIdempotencyKey = (accountId: string, stamp = Date.now()): string => `wx_channels:account_remove:${accountId}:${stamp}`
