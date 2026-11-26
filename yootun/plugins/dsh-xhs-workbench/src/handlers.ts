/**
 * 已实现 30 项 action 的 Host 实现（与 route.ts allowlist 同数；依赖注入面 + 处理器表）。登录/采集均为
 * 进程内 AbortController 生命周期（dispose 统一 abort + 等待 settle）；profile
 * 互斥按旧口径即时占（登录/采集全程持锁，probe/删除 try 语义立即拒绝）。响应
 * 形状沿用旧路由契约（status: ready/started/created/error），client 半按同形状
 * 重译。Workbench 调用经 `ctx.yootunWorkbench`（settings 对 + 任务四项已接入；
 * hotboard 其余随 X5、publish 随 X6 批次接入（assistant 已定案不做，D-6））。
 * @module
 */
import type { BrowserStatus, ChromeFactory } from './chrome.ts'
import { DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS } from './chrome.ts'
import { safeCode, STABLE_ERROR_CODES, type StableErrorCode } from './errors.ts'
import { createProfileLocks, type ProfileLockRelease } from '@yootun/dsh-workbench-host-kit'
import { DEFAULT_DISPOSE_BUDGET_MS, createTaskRegistry, type TaskRegistry } from './lifecycle.ts'
import { CollectError, collectNotes, summarizeSnapshot, type SnapshotSummary } from './collector.ts'
import { PublishError, publishDraft } from './publisher.ts'
import {
  isPendingAccountId, loginWithQrCode, probeSession, removeLocalAccount,
  type AccountProfile, type LoginResult, type RemoveLocalResult,
} from './session.ts'
import { LOGIN_TIMEOUT_MS } from './session.ts'
import { latestSnapshot, readAccounts, type SnapshotNote } from './state.ts'
import type { XhsWorkbenchFace } from './workbench.ts'
import type { ActionArgs, ActionHandler, HandlerPayload } from './route.ts'

/** MCP 错误信封 → 受控 reason 白名单（白名单外一律收敛，不透传原文）。 */


/** 看板枚举白名单（与 server.py Literal 一致；旧 HOTBOARD_ENUMS 同表）。 */
const HOTBOARD_ENUMS = Object.freeze({
  window: new Set(['7d', '30d', '90d']),
  sort: new Set(['score', 'publishTime', 'collect', 'like', 'comment', 'share']),
  keywordCategory: new Set(['product', 'scene']),
  keywordStatus: new Set(['active', 'disabled']),
  keywordSource: new Set(['built_in', 'manual', 'agent']),
  candidateStatus: new Set(['pending', 'accepted', 'rejected', 'expired']),
  labelStatus: new Set(['active', 'retired']),
  labelSource: new Set(['business_seed', 'ai', 'manual']),
  proposalStatus: new Set(['pending', 'auto_activated', 'accepted', 'rejected', 'merged', 'expired']),
  tagType: new Set(['style', 'color']),
  keywordAction: new Set(['create', 'update', 'enable', 'disable']),
  candidateAction: new Set(['accepted', 'rejected']),
  labelReviewAction: new Set(['accept', 'reject', 'merge', 'enable', 'retire']),
  runType: new Set(['incremental']),
})

/** ID 宽松校验：hex-ish 字符集 + 长度（完整 UUID 语义由 tools 侧兜底；旧 cleanHotboardId 同口径）。 */
function cleanHotboardId(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null
  const id = value.trim().slice(0, max)
  if (id === '' || !/^[0-9a-f][0-9a-f-]*$/iu.test(id)) return null
  return id
}

/** 分页参数清洗（1-100；缺省不落字段；非法返回 null → INVALID_ARGUMENT）。 */
function hotboardPage(args: ActionArgs, key: string): number | null | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > 100) return null
  return num
}

/** 枚举参数清洗（白名单外 null；空串缺省）。 */
function hotboardEnum(args: ActionArgs, key: string, set: ReadonlySet<string>): string | null | undefined {
  const value = args[key]
  if (value === undefined || value === '') return undefined
  return typeof value === 'string' && set.has(value) ? value : null
}

/** 字符串参数清洗（非空截断；空串缺省）。 */
function hotboardStr(args: ActionArgs, key: string, max: number): string | null | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const text = value.trim().slice(0, max)
  return text === '' ? undefined : text
}

/** settings 受控字段白名单（旧 index.js HOTBOARD_SETTINGS_* 同口径）；值域/cron
 * 深校验在 tools 侧，Host 只做键白名单与值类型粗校验。 */
const HOTBOARD_SETTINGS_BOOL: ReadonlySet<string> = new Set(['scheduleEnabled', 'manualIncrementEnabled', 'commentSampleEnabled', 'manualCommentDefaultEnabled'])
const HOTBOARD_SETTINGS_NUMBER: ReadonlySet<string> = new Set(['publishWindowDays', 'perKeywordLimit', 'commentTopN', 'commentMaxPerNote', 'minInteractionTotal', 'dedupHammingThreshold', 'minValidSample', 'searchMaxCallsPerDay', 'commentMaxCallsPerDay', 'detailMaxCallsPerRun'])
const HOTBOARD_SETTINGS_KEYS: ReadonlySet<string> = new Set([...HOTBOARD_SETTINGS_BOOL, ...HOTBOARD_SETTINGS_NUMBER, 'fullScheduleCron'])

/** error 分支响应（reason 必须是稳定码白名单成员；HandlerPayload 判别联合）。 */
function errorPayload(reason: StableErrorCode, extra: Record<string, unknown> = {}): HandlerPayload {
  return { status: 'error', reason, ...extra }
}

/** 字符串码 → 稳定码（白名单成员直通，否则落 fallback；调用点已按白名单过滤）。 */
function stableOr(code: string, fallback: StableErrorCode): StableErrorCode {
  return (STABLE_ERROR_CODES as readonly string[]).includes(code) ? code as StableErrorCode : fallback
}

/** 登录等待状态（页面轮询 loginStatus；终态保留 30 分钟供重复读取，2.3）。 */
export interface LoginRun {
  key: string
  status: 'waiting' | 'ok' | 'timeout' | 'failed'
  accountId: string | null
  nickname: string | null
  avatar: string | null
  error: string | null
  release: ProfileLockRelease
  /** 进入终态的时刻（Date.now()；终态保留 30 分钟的计龄起点）。 */
  settledAt?: number
}

/** 单账号采集 run（进程内；页面 2s 轮询 collect.status）。 */
export interface CollectRun {
  collectId: string
  accountId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  pagesDone: number
  notesTotal: number
  truncated: boolean
  summary: SnapshotSummary | null
  error: string | null
  release: ProfileLockRelease
  /** 进入终态的时刻（Date.now()；2.2 终态保留 30 分钟的计龄起点）。 */
  settledAt?: number
}

/** 发布 run（进程内；浏览器保持打开，锁随 context close 释放）。 */
export interface PublishRun {
  publishId: string
  accountId: string
  status: 'running' | 'completed' | 'failed'
  step: 'prepare' | 'open' | 'done'
  error: string | null
  release: ProfileLockRelease
}

/** Host 依赖注入面（测试可整体替换）。 */
export interface XhsHostDeps {
  root: string
  workbench: XhsWorkbenchFace
  browserStatusFn: () => Promise<BrowserStatus>
  logger: { warn(message: string): void }
  /** Chrome launcher seam（测试注入；undefined = launchChrome 真实实现）。 */
  chromeFactory: ChromeFactory | undefined
  /** 任务登记表：登录/采集/probe/晚 factory 清理等后台 promise 统一登记，dispose 等待。 */
  taskRegistry: TaskRegistry
  /** dispose 开始后 route handler 稳定拒绝新 action（稳定码 plugin_disposing）。 */
  disposing: boolean
  /** 卸载预算毫秒（Config.disposeBudgetMs 透传；dispose 收口用）。 */
  disposeBudgetMs: number
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs: number
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs: number
  /** 扫码登录等待上限（测试注入短值；生产为 10 分钟旧口径）。 */
  loginTimeoutMs: number
  /** 账号 profile 锁实例（登录/probe/采集/发布互斥；即时占语义入口在此暴露）。 */
  locks: ReturnType<typeof createProfileLocks>
  loginRuns: Map<string, LoginRun>
  loginSignals: Map<string, AbortController>
  probeSignals: Map<string, AbortController>
  collectSignals: Map<string, AbortController>
  collectRuns: Map<string, CollectRun>
  /** 创建型幂等：idempotencyKey → collectId 重放既有 run（旧 index.js 口径）。 */
  collectIdempotency: Map<string, string>
  /** 账号 → 最近一条 run 的 collectId（2.1 按账号查询的索引）。 */
  collectLatestByAccount: Map<string, string>
  /** 发布 run（进程内；页面 2s 轮询 publish.status）。 */
  publishRuns: Map<string, PublishRun>
  /** 创建型幂等：idempotencyKey → publishId（旧 index.js 口径）。 */
  publishIdempotency: Map<string, string>
}

/**
 * Assemble the Host deps.
 * @param options - root/workbench/browserStatus/logger/chromeFactory/registry seams.
 * @param options.disposeBudgetMs - dispose wait budget (Config.disposeBudgetMs; defaults to 20000).
 * @param options.browserCloseTimeoutMs - browser close budget (Config.browserCloseTimeoutMs; defaults to 8000).
 * @param options.launchTimeoutMs - Chrome launch budget (Config.launchTimeoutMs; defaults to 60000).
 * @returns the deps bundle.
 */
export function createXhsHostDeps(options: {
  root: string
  workbench: XhsWorkbenchFace
  browserStatusFn: () => Promise<BrowserStatus>
  logger: { warn(message: string): void }
  chromeFactory?: ChromeFactory
  taskRegistry?: TaskRegistry
  disposeBudgetMs?: number
  browserCloseTimeoutMs?: number
  launchTimeoutMs?: number
}): XhsHostDeps {
  return {
    root: options.root,
    workbench: options.workbench,
    browserStatusFn: options.browserStatusFn,
    logger: options.logger,
    chromeFactory: options.chromeFactory,
    taskRegistry: options.taskRegistry ?? createTaskRegistry(),
    locks: createProfileLocks(),
    disposing: false,
    disposeBudgetMs: options.disposeBudgetMs ?? DEFAULT_DISPOSE_BUDGET_MS,
    browserCloseTimeoutMs: options.browserCloseTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
    launchTimeoutMs: options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
    loginRuns: new Map(),
    loginSignals: new Map(),
    probeSignals: new Map(),
    collectSignals: new Map(),
    collectRuns: new Map(),
    collectIdempotency: new Map(),
    collectLatestByAccount: new Map(),
    publishRuns: new Map(),
    publishIdempotency: new Map(),
  }
}

/** 头像 URL 白名单化：仅放行 http(s) 绝对地址，超长与危险协议一律置 null。 */
function projectAvatar(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (!/^https?:\/\//iu.test(candidate)) return null
  return candidate.slice(0, 2048)
}

/** 最新采集快照的本地聚合投影（不入库，页面直读）；无快照不落字段。 */
async function projectSnapshotSummary(deps: XhsHostDeps, accountId: string): Promise<{
  notesCount: number
  totals: SnapshotSummary['totals']
  gaps: SnapshotSummary['gaps']
  capturedAt: string | null
} | null> {
  try {
    const snapshot = await latestSnapshot(accountId, deps.root)
    if (snapshot === null) return null
    const summary = summarizeSnapshot(snapshot)
    return { notesCount: summary.notesCount, totals: summary.totals, gaps: summary.gaps, capturedAt: summary.capturedAt }
  } catch {
    return null
  }
}

function projectLogin(run: LoginRun): Record<string, unknown> {
  return {
    loginId: run.key,
    status: run.status,
    accountId: run.accountId,
    nickname: run.nickname,
    avatar: run.avatar,
    reason: run.error,
  }
}

function projectCollect(run: CollectRun): Record<string, unknown> {
  return {
    collectId: run.collectId,
    accountId: run.accountId,
    collectStatus: run.status,
    pagesDone: run.pagesDone,
    notesTotal: run.notesTotal,
    truncated: run.truncated,
    summary: run.summary,
    error: run.error,
  }
}

/** 发布 run 投影（旧 projectPublish 同口径）。 */
function projectPublish(run: PublishRun): Record<string, unknown> {
  return {
    publishId: run.publishId,
    accountId: run.accountId,
    publishStatus: run.status,
    step: run.step,
    error: run.error,
  }
}

function stringValue(args: ActionArgs, key: string): string {
  return typeof args[key] === 'string' ? args[key] as string : ''
}

function stringArrayValue(args: ActionArgs, key: string): string[] {
  const value = args[key]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value !== '') return value
  return null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 任务步骤行投影（旧 projectSteps 同口径）：失败行携带受控错误码/原因短语。 */
function projectSteps(list: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(list)) return []
  const out: Array<Record<string, unknown>> = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const step = typeof record.step === 'string' ? record.step.trim().slice(0, 64) : ''
    if (step === '') continue
    const entry: Record<string, unknown> = { step, status: typeof record.status === 'string' ? record.status.trim().slice(0, 24) : '' }
    const errorCode = typeof record.errorCode === 'string' ? record.errorCode.trim().slice(0, 64) : ''
    const errorMessage = typeof record.errorMessage === 'string' ? record.errorMessage.trim().slice(0, 512) : ''
    if (errorCode !== '') entry.errorCode = errorCode
    if (errorMessage !== '') entry.errorMessage = errorMessage
    out.push(entry)
  }
  return out
}

/** 版本投影（旧 projectVersions 同口径）：只保留服务端已校验的展示字段。 */
function projectVersions(list: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(list)) return []
  const out: Array<Record<string, unknown>> = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const version: Record<string, unknown> = {
      version: firstString(record.version) ?? '?',
      title: firstString(record.title) ?? '',
      body: firstString(record.body) ?? '',
      tags: Array.isArray(record.tags) ? record.tags.map(value => String(value)).slice(0, 20) : [],
      coverCopy: firstString(record.coverCopy) ?? '',
      leadGuide: firstString(record.leadGuide) ?? '',
    }
    if (Array.isArray(record.issues)) {
      const issues = record.issues.map(value => String(value).slice(0, 64)).filter(Boolean).slice(0, 10)
      if (issues.length > 0) version.issues = issues
    }
    if (Array.isArray(record.pages)) {
      const pages: Array<Record<string, unknown>> = []
      for (const page of record.pages) {
        if (page === null || typeof page !== 'object') continue
        const index = numberOrNull((page as Record<string, unknown>).pageIndex)
        if (index === null) continue
        pages.push({ pageIndex: index, copy: firstString((page as Record<string, unknown>).copy) ?? '' })
        if (pages.length >= 18) break
      }
      if (pages.length > 0) version.pages = pages
    }
    out.push(version)
    if (out.length >= 3) break
  }
  return out
}

/** Workbench 调用的 structuredContent 投影（非对象信封归一为空对象）。 */
async function callWorkbench(deps: XhsHostDeps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await deps.workbench.callTool('xhs-workbench', 'xhs', name, args)
  const payload: unknown = outcome.structuredContent
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

/** 写响应只保留受控字段（不透传服务端内部诊断字段；旧 index.js projectHotboardWrite
 * 同口径）：results 行级失败披露只放行 candidateId/ok/errorCode 三键、截 50 条防大响应；
 * run 只投影 runId/status。 */
export function projectHotboardWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['ok', 'updatedCount', 'idempotentReplay', 'changed', 'conflictWithActive', 'created']) {
    if (payload[key] !== undefined) out[key] = payload[key]
  }
  if (Array.isArray(payload.results) && payload.results.length > 0) {
    const results = payload.results as Array<Record<string, unknown> | null>
    out.results = results.slice(0, 50).map(item => ({
      candidateId: typeof item?.candidateId === 'string' && item.candidateId.trim() !== '' ? item.candidateId.trim().slice(0, 64) : null,
      ok: item?.ok === true,
      errorCode: typeof item?.errorCode === 'string' && item.errorCode.trim() !== '' ? item.errorCode.trim().slice(0, 64) : null,
    }))
  }
  const run = payload.run
  if (run !== null && typeof run === 'object') {
    const record = run as Record<string, unknown>
    out.run = {
      runId: String(record.runId ?? '').slice(0, 64),
      status: typeof record.status === 'string' && record.status.trim() !== '' ? record.status.trim().slice(0, 32) : null,
    }
  }
  return out
}

/** MCP 错误信封（payload.error.code）→ 受控 reason；信封存在时白名单外一律收敛
 * INTERNAL（绝不把未知错误信封当数据透传），无信封返回 null。 */
function hotboardErrorReason(payload: Record<string, unknown> | null): StableErrorCode | null {
  if (payload === null) return null
  const error = payload.error
  if (error === null || typeof error !== 'object') return null
  const code = typeof (error as Record<string, unknown>).code === 'string' ? (error as Record<string, unknown>).code as string : ''
  if (code === '') return null
  return stableOr(code, 'XHS_HOTBOARD_INTERNAL_ERROR')
}

/** 抛错形态的 Workbench 业务失败 → 受控 reason（message 可能为错误信封 JSON）。 */
function safeHotboardToolError(error: unknown): StableErrorCode {
  const message = error instanceof Error ? error.message : ''
  let parsedEnvelope: unknown
  try {
    parsedEnvelope = JSON.parse(message)
  } catch {
    // message 非 JSON：落到下方白名单判断。
    parsedEnvelope = undefined
  }
  if (parsedEnvelope !== null && typeof parsedEnvelope === 'object') {
    return hotboardErrorReason(parsedEnvelope as Record<string, unknown>) ?? hotboardReasonOf(error)
  }
  return hotboardReasonOf(error)
}

function hotboardReasonOf(error: unknown): StableErrorCode {
  if (typeof error !== 'object' || error === null) return 'XHS_HOTBOARD_INTERNAL_ERROR'
  const payload = (error as { payload?: unknown }).payload
  if (payload !== null && typeof payload === 'object') {
    return hotboardErrorReason(payload as Record<string, unknown>) ?? 'XHS_HOTBOARD_INTERNAL_ERROR'
  }
  return 'XHS_HOTBOARD_INTERNAL_ERROR'
}

/** settingsUpdate 的 Host 侧键白名单与值类型粗校验（旧 hotboardArgs 同口径）。
 * @returns 合法 settings 原样返回；非法返回 null（投影 XHS_HOTBOARD_INVALID_ARGUMENT）。 */
function validateSettingsObject(settings: unknown): Record<string, unknown> | null {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return null
  const record = settings as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 0 || keys.length > HOTBOARD_SETTINGS_KEYS.size) return null
  for (const key of keys) {
    if (!HOTBOARD_SETTINGS_KEYS.has(key)) return null
    const value = record[key]
    if (key === 'fullScheduleCron') {
      if (typeof value !== 'string' || value.trim() === '' || value.length > 64) return null
    } else if (HOTBOARD_SETTINGS_BOOL.has(key)) {
      if (typeof value !== 'boolean') return null
    } else if (!Number.isFinite(Number(value)) || typeof value === 'boolean') return null
  }
  return record
}

/** 写操作确定性前置结果：要么已定型拒绝，要么携带幂等键继续。 */
type WritePre =
  | { idempotencyKey: string }
  | { payload: HandlerPayload }

/** 写操作确定性前置（旧 handleHotboard 同口径）：confirm 显式 true + 幂等键必填，
 * 失败不烧键。参数清洗失败统一落 XHS_HOTBOARD_INVALID_ARGUMENT（pre.payload）。 */
function hotboardWritePre(args: ActionArgs): WritePre {
  if (args.confirm !== true) return { payload: errorPayload('confirmation_required') }
  const idempotencyKey = stringValue(args, 'idempotencyKey')
  if (idempotencyKey === '') return { payload: errorPayload('idempotency_key_required') }
  return { idempotencyKey }
}

/** 看板读投影：`{data, meta}` 白名单透传；无信封时按原对象兜底（旧 handleHotboard 读分支）。 */
async function hotboardRead(deps: XhsHostDeps, tool: string, args: Record<string, unknown>): Promise<HandlerPayload> {
  let payload: Record<string, unknown>
  try {
    payload = await callWorkbench(deps, tool, args)
  } catch (error) {
    const reason = safeHotboardToolError(error)
    deps.logger.warn(`yootun xhs ${tool} failed: ${reason}`)
    return errorPayload(reason)
  }
  const errorReason = hotboardErrorReason(payload)
  if (errorReason !== null) return errorPayload(errorReason)
  const data = 'data' in payload ? payload.data : payload
  const meta = 'meta' in payload ? payload.meta : null
  return { status: 'ready', data, meta }
}

/** 看板写投影：confirm/idempotencyKey 注入 + projectHotboardWrite 受控字段（旧写分支）。 */
async function hotboardWrite(deps: XhsHostDeps, tool: string, args: Record<string, unknown>, idempotencyKey: string): Promise<HandlerPayload> {
  let payload: Record<string, unknown>
  try {
    payload = await callWorkbench(deps, tool, { ...args, confirm: true, idempotencyKey })
  } catch (error) {
    const reason = safeHotboardToolError(error)
    deps.logger.warn(`yootun xhs ${tool} failed: ${reason}`)
    return errorPayload(reason)
  }
  const errorReason = hotboardErrorReason(payload)
  if (errorReason !== null) return errorPayload(errorReason)
  return { status: 'ready', ...projectHotboardWrite(payload) }
}

/** 本地浏览器/采集错误 → 受控错误码（白名单外收敛 LOGIN_FAILED 等）。 */
function localErrorCode(error: unknown, fallback: string): string {
  const code = safeCode(error)
  return (STABLE_ERROR_CODES as readonly string[]).includes(code) ? code : fallback
}

/** 登录终态记录保留时长（2.3；三工作台统一口径，视频号同名常量）。 */
const LOGIN_RECORD_TTL_MS = 30 * 60 * 1000

/** 采集终态记录保留时长（2.2；下一次 collect.start / collect.status 时清理）。 */
const COLLECT_RECORD_TTL_MS = 30 * 60 * 1000

/**
 * 清理已过期的登录终态记录（2.3 读取时顺带清理，不依赖定时器）：pending 键与
 * resolvedId 指向同一条 run 时两者同时清理。
 */
function sweepLoginRuns(deps: XhsHostDeps, nowMs: number): void {
  const expired = new Set<LoginRun>()
  for (const run of deps.loginRuns.values()) {
    if (run.status !== 'waiting' && run.settledAt !== undefined && nowMs - run.settledAt > LOGIN_RECORD_TTL_MS) expired.add(run)
  }
  if (expired.size === 0) return
  for (const [key, run] of deps.loginRuns) {
    if (expired.has(run)) deps.loginRuns.delete(key)
  }
}

/**
 * 清理已过期的采集终态 run（2.2）：删除 run、其幂等映射与账号索引（索引只在
 * 仍指向该 run 时删除）；运行中的 run 不清理。
 */
function sweepCollectRuns(deps: XhsHostDeps, nowMs: number): void {
  const expired = new Set<CollectRun>()
  for (const run of deps.collectRuns.values()) {
    if (run.status !== 'running' && run.settledAt !== undefined && nowMs - run.settledAt > COLLECT_RECORD_TTL_MS) expired.add(run)
  }
  if (expired.size === 0) return
  for (const [key, run] of deps.collectRuns) {
    if (expired.has(run)) deps.collectRuns.delete(key)
  }
  for (const [key, collectId] of deps.collectIdempotency) {
    if (!deps.collectRuns.has(collectId)) deps.collectIdempotency.delete(key)
  }
  for (const [accountId, collectId] of deps.collectLatestByAccount) {
    if (!deps.collectRuns.has(collectId)) deps.collectLatestByAccount.delete(accountId)
  }
}

/**
 * Build the action handler table (X1+X2: browser/accounts/login/probe/remove/
 * collect). Each handler is wrapped with the disposing guard and the task
 * registry (dispose waits for in-flight actions to settle).
 * @param deps - the host deps bundle.
 * @returns the handler table covering the route allowlist.
 */
export function buildRouteHandlers(deps: XhsHostDeps): Record<string, ActionHandler> {
  const handlers: Record<string, ActionHandler> = {
    'browser.status': async () => {
      const status = await deps.browserStatusFn()
      return {
        status: 'ready',
        chromeAvailable: status.chromeAvailable,
        driverAvailable: status.driverAvailable,
        platform: status.platform,
        // 阻断文案由 UI 呈现；此处只给布尔与平台，不回传设备路径细节。
        hint: status.chromeAvailable ? null : 'install_google_chrome',
      }
    },

    'accounts.list': async () => {
      const local = await readAccounts(deps.root)
      // 发布窗口投影：存在 running 发布 run 即该账号浏览器窗口仍打开；run 落终态
      // （context close）后标识自然消失，不另起轮询。
      const openAccounts = new Set([...deps.publishRuns.values()].filter(publishRun => publishRun.status === 'running').map(publishRun => publishRun.accountId))
      const accounts: Array<Record<string, unknown>> = []
      for (const record of Object.values(local.accounts)) {
        if (record === null || typeof record !== 'object' || typeof record.accountId !== 'string' || record.accountId === '') continue
        const entry: Record<string, unknown> = {
          accountId: record.accountId.slice(0, 128),
          nickname: typeof record.nickname === 'string' && record.nickname !== '' ? record.nickname.slice(0, 256) : null,
          avatar: projectAvatar(record.avatar),
          sessionStatus: record.sessionStatus ?? 'unknown',
          sessionCheckedAt: record.sessionCheckedAt ?? null,
          lastCollectedAt: record.lastCollectedAt ?? null,
          publishWindowOpen: openAccounts.has(record.accountId),
        }
        const summary = await projectSnapshotSummary(deps, record.accountId)
        if (summary !== null) entry.summary = summary
        accounts.push(entry)
      }
      accounts.sort((a, b) => String(a.accountId).localeCompare(String(b.accountId)))
      return { status: 'ready', accounts }
    },

    'account.beginLogin': async args => {
      const requested = stringValue(args, 'accountId')
      // 重复调用返回既有 waiting run（幂等；页面刷新重试不重复弹窗）：
      // 显式账号按 accountId 匹配；新增账号（无 accountId）全进程同时只开一个扫码 run。
      sweepLoginRuns(deps, Date.now())
      for (const run of deps.loginRuns.values()) {
        if (run.status !== 'waiting') continue
        if (requested !== '' ? run.key === requested : isPendingAccountId(run.key)) {
          return { status: 'ready', login: projectLogin(run) }
        }
      }
      const runKey = requested !== '' ? requested : `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // Profile 互斥：重新登录锁显式账号；新增账号锁 pending 键（即时占语义）。
      const release = deps.locks.acquireProfileLock(runKey)
      if (release === null) return { status: 'error', reason: 'PROFILE_BUSY' }
      const run: LoginRun = { key: runKey, status: 'waiting', accountId: null, nickname: null, avatar: null, error: null, release }
      deps.loginRuns.set(runKey, run)
      const controller = new AbortController()
      deps.loginSignals.set(runKey, controller)
      // 登录是有头长动作：立即返回 waiting，后台完成后写回 run（页面轮询 loginStatus）。
      deps.taskRegistry.track(loginWithQrCode({
        ...(requested !== '' ? { accountId: requested } : {}),
        root: deps.root,
        timeoutMs: deps.loginTimeoutMs,
        signal: controller.signal,
        chromeFactory: deps.chromeFactory,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        isResolvedBusy: accountId => deps.locks.isProfileLocked(accountId),
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      }).then(async (result: LoginResult) => {
        if (result.status === 'ok') {
          run.status = 'ok'
          run.settledAt = Date.now()
          run.accountId = result.accountId
          run.nickname = result.profile?.nickname ?? null
          run.avatar = result.profile?.avatar ?? null
          if (runKey !== run.accountId) {
            // pending run 以 resolvedId 补映射供 loginStatus 查询；若该账号已有
            // 进行中的显式登录 run，绝不覆盖（登录页按 loginId 各查各的）。
            const existing = deps.loginRuns.get(run.accountId)
            if (existing === undefined || existing.status !== 'waiting') deps.loginRuns.set(run.accountId, run)
          }
        } else {
          run.status = result.status === 'timeout' ? 'timeout' : 'failed'
          run.settledAt = Date.now()
          // 错误码收敛到受控白名单：不透出原始异常名。
          run.error = result.status === 'timeout'
            ? 'LOGIN_TIMEOUT'
            : (STABLE_ERROR_CODES as readonly string[]).includes(result.reason) ? result.reason : 'LOGIN_FAILED'
        }
      }).catch((error: unknown) => {
        run.status = 'failed'
        run.settledAt = Date.now()
        run.error = localErrorCode(error, 'LOGIN_FAILED')
      }).finally(() => {
        release()
        if (deps.loginSignals.get(runKey) === controller) deps.loginSignals.delete(runKey)
      }))
      return { status: 'ready', login: projectLogin(run) }
    },

    'account.loginStatus': async args => {
      // 2.3 读取时顺带清理过期终态记录（幂等：重复读取同一终态结果一致）。
      sweepLoginRuns(deps, Date.now())
      const key = stringValue(args, 'loginId') || stringValue(args, 'accountId')
      const run = key !== '' ? deps.loginRuns.get(key) : undefined
      if (run === undefined) {
        // 只在「没有记录或记录已过期」时返回 idle（2.3）。
        return { status: 'ready', login: { status: 'idle', loginId: key !== '' ? key : null } }
      }
      return { status: 'ready', login: projectLogin(run) }
    },

    'account.probe': async args => {
      const accountId = stringValue(args, 'accountId')
      if (accountId === '') return { status: 'error', reason: 'account_id_required' }
      // Profile 互斥：probe（有头复用 Profile）与其他浏览器操作互斥；占用即拒绝。
      // probe 信号随 dispose abort（在途探测被等待收敛）。
      const controller = new AbortController()
      deps.probeSignals.set(accountId, controller)
      try {
        const attempt = await deps.locks.tryWithProfileLock(accountId, () =>
          probeSession({
            accountId,
            root: deps.root,
            chromeFactory: deps.chromeFactory,
            signal: controller.signal,
            launchTimeoutMs: deps.launchTimeoutMs,
            browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
            onBrowserCloseTimeout: message => { deps.logger.warn(message) },
            trackCleanup: promise => { deps.taskRegistry.track(promise) },
          }))
        if (!attempt.acquired) return { status: 'error', reason: 'PROFILE_BUSY' }
        const result = attempt.result
        if (result.status === 'ok' || result.status === 'expired') {
          return { status: 'ready', accountId, sessionStatus: result.status }
        }
        // unknown（浏览器/驱动异常）→ 受控 PROBE_FAILED / 专码，不透出原始异常名。
        return errorPayload(stableOr(result.reason ?? '', 'PROBE_FAILED'))
      } finally {
        if (deps.probeSignals.get(accountId) === controller) deps.probeSignals.delete(accountId)
      }
    },

    'account.removeLocal': async args => {
      const accountId = stringValue(args, 'accountId')
      if (accountId === '') return { status: 'error', reason: 'account_id_required' }
      // 移除会递归删除该账号的 Profile/storage_state/快照：与登录/probe/采集互斥，
      // 否则运行中的浏览器操作会在被删目录上继续写（僵尸账号）。占用即拒绝。
      const attempt = await deps.locks.tryWithProfileLock(accountId, () => removeLocalAccount({ accountId, root: deps.root }))
      if (!attempt.acquired) return { status: 'error', reason: 'PROFILE_BUSY' }
      const result: RemoveLocalResult = attempt.result
      // 幂等删除：源不存在也视为已清除（removed 布尔仅反映删除动作执行成功）。
      return { status: 'ready', accountId, removed: { profile: result.cleared.profile !== false, storageState: result.cleared.storageState !== false } }
    },

    'collect.start': async args => {
      const accountId = stringValue(args, 'accountId')
      if (accountId === '') return { status: 'error', reason: 'account_id_required' }
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      // 幂等键必填：采集是有副作用操作（写本地快照）。
      if (idempotencyKey === '') return { status: 'error', reason: 'idempotency_key_required' }
      // 2.2 入口清理：终态超保留期的 run 连同幂等映射与账号索引一起清。
      sweepCollectRuns(deps, Date.now())
      if (deps.collectIdempotency.has(idempotencyKey)) {
        // 幂等重放：返回既有 run 的当前状态（不重复创建采集任务）。
        const run = deps.collectRuns.get(deps.collectIdempotency.get(idempotencyKey) ?? '')
        if (run !== undefined) return { status: 'started', collectId: run.collectId, collect: projectCollect(run) }
      }
      // Profile 互斥：采集（无头复用 Profile）与其他浏览器操作互斥；占用即拒绝。
      const release = deps.locks.acquireProfileLock(accountId)
      if (release === null) return { status: 'error', reason: 'PROFILE_BUSY' }
      const collectId = `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run: CollectRun = { collectId, accountId, status: 'running', pagesDone: 0, notesTotal: 0, truncated: false, summary: null, error: null, release }
      deps.collectRuns.set(collectId, run)
      deps.collectIdempotency.set(idempotencyKey, collectId)
      // 2.1 按账号查询的最近 run 索引（同一账号新 run 覆盖旧索引）。
      deps.collectLatestByAccount.set(accountId, collectId)
      const controller = new AbortController()
      deps.collectSignals.set(collectId, controller)
      // 采集是后台长动作：立即返回 started，结果落设备端快照（不入库，Q10）。
      deps.taskRegistry.track(collectNotes({
        accountId,
        root: deps.root,
        chromeFactory: deps.chromeFactory,
        signal: controller.signal,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
        onProgress: progress => {
          if (deps.collectRuns.get(collectId) !== run) return
          run.pagesDone = Number.isFinite(progress.pagesDone) ? progress.pagesDone : run.pagesDone
          run.notesTotal = Number.isFinite(progress.notesTotal) ? progress.notesTotal : run.notesTotal
        },
      }).then(result => {
        // 迟到成功不覆盖取消终态（快照检查点之后的极小窗口内 abort 已受理）：
        // 投影保持 cancelled，不回写已完成摘要。
        if (controller.signal.aborted === true) {
          run.status = 'cancelled'
          run.settledAt = Date.now()
          run.error = 'collect_cancelled'
          return
        }
        run.status = 'completed'
        run.settledAt = Date.now()
        run.pagesDone = result.pagesDone
        run.notesTotal = result.notesTotal
        run.summary = result.summary
        run.truncated = result.truncated === true
      }).catch((error: unknown) => {
        // 取消终态只认本 run 的 abort 信号：collect.cancel 已直接置 cancelled /
        // collect_cancelled；abort 后仍抛出的带码 CollectError（如迟到的
        // SESSION_EXPIRED）不得改判为普通失败（XH4）。非取消失败维持 failed 原码。
        if (controller.signal.aborted === true) {
          run.status = 'cancelled'
          run.settledAt = Date.now()
          run.error = 'collect_cancelled'
          return
        }
        if (run.status === 'cancelled') return
        run.status = 'failed'
        run.settledAt = Date.now()
        run.error = error instanceof CollectError && (STABLE_ERROR_CODES as readonly string[]).includes(error.code)
          ? error.code
          : localErrorCode(error, 'COLLECT_FAILED')
      }).finally(() => {
        release()
        if (deps.collectSignals.get(collectId) === controller) deps.collectSignals.delete(collectId)
      }))
      return { status: 'started', collectId, collect: projectCollect(run) }
    },

    'collect.status': async args => {
      // 2.2 入口清理（与 collect.start 同口径）。
      sweepCollectRuns(deps, Date.now())
      const collectId = stringValue(args, 'collectId')
      const accountId = stringValue(args, 'accountId')
      if (collectId === '' && accountId === '') return { status: 'error', reason: 'collect_id_required' }
      // 都给时以 collectId 为准（2.1）；按 collectId 查不到维持既有 collect_id_required
      // （页面轮询依赖它判定「宿主重启后 run 丢失」）。
      if (collectId !== '') {
        const run = deps.collectRuns.get(collectId)
        if (run === undefined) return { status: 'error', reason: 'collect_id_required' }
        return { status: 'ready', collect: projectCollect(run) }
      }
      // 2.1 按账号查询：运行中的优先；否则最近结束且仍在保留期内的；都没有 → collect: null。
      const latest = deps.collectLatestByAccount.get(accountId)
      const run = latest !== undefined ? deps.collectRuns.get(latest) : undefined
      return { status: 'ready', collect: run === undefined ? null : projectCollect(run) }
    },

    // 采集取消（1126 xhs-collect-cancel-and-publish-state §2.1）：abort 该 run 的
    // controller 并同步落取消终态；锁由采集 promise 的既有 finally 释放。
    'collect.cancel': async args => {
      const collectId = stringValue(args, 'collectId')
      const run = collectId !== '' ? deps.collectRuns.get(collectId) : undefined
      // 未知 run 与 collect.status 同口径。
      if (run === undefined) return { status: 'error', reason: 'collect_id_required' }
      if (run.status !== 'running') {
        // 已是终态：原样返回既有投影，不改写（取消与自然结束竞争时幂等）。
        return { status: 'ready', collect: projectCollect(run) }
      }
      deps.collectSignals.get(collectId)?.abort()
      run.status = 'cancelled'
      run.settledAt = Date.now()
      run.error = 'collect_cancelled'
      return { status: 'ready', collect: projectCollect(run) }
    },

    // ---- 发布（X6；旧 index.js handlePublishStart/handlePublishStatus 同口径重译，
    // 发布降级版：只打开创作者中心发布页，浏览器保持打开由用户手动发布）----

    'publish.start': async args => {
      const accountId = stringValue(args, 'accountId')
      if (accountId === '') return { status: 'error', reason: 'account_id_required' }
      // 发布页目标 Tab（图文/视频）：默认 image，仅接受这两个枚举。
      const target = stringValue(args, 'target') === '' ? 'image' : stringValue(args, 'target')
      if (target !== 'image' && target !== 'video') return { status: 'error', reason: 'invalid_target' }
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      if (idempotencyKey === '') return { status: 'error', reason: 'idempotency_key_required' }
      if (deps.publishIdempotency.has(idempotencyKey)) {
        // 幂等重放：返回既有 run 的当前状态（不重复打开浏览器）。
        const run = deps.publishRuns.get(deps.publishIdempotency.get(idempotencyKey) ?? '')
        if (run !== undefined) return { status: 'started', publishId: run.publishId, publish: projectPublish(run) }
      }
      // Profile 互斥：发布（有头）与登录/probe/采集互斥；占用即拒绝。
      const release = deps.locks.acquireProfileLock(accountId)
      if (release === null) return { status: 'error', reason: 'PROFILE_BUSY' }
      const publishId = `pub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run: PublishRun = { publishId, accountId, status: 'running', step: 'prepare', error: null, release }
      deps.publishRuns.set(publishId, run)
      deps.publishIdempotency.set(idempotencyKey, publishId)
      // 打开发布页是后台动作：立即返回 started。完成后浏览器保持打开（README §5.3）
      // ——互斥锁随浏览器窗口生命周期：onContext 挂钩后由 context close 释放；
      // 早期失败（context 未创建，含启动超预算）由 finally 释放（审查 P1）。
      // 发布 promise 纳入任务登记表（dispose 等待；含迟到的启动清理）。
      let contextHooked = false
      deps.taskRegistry.track(publishDraft({
        accountId,
        target: target as 'image' | 'video',
        root: deps.root,
        chromeFactory: deps.chromeFactory,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
        onStep: step => {
          if (deps.publishRuns.get(publishId) !== run) return
          run.step = step
        },
        onContext: context => {
          contextHooked = true
          context.once('close', () => { release() })
        },
      })).then(() => {
        run.status = 'completed'
        run.step = 'done'
      }).catch((error: unknown) => {
        run.status = 'failed'
        run.error = error instanceof PublishError && (STABLE_ERROR_CODES as readonly string[]).includes(error.code)
          ? error.code
          : localErrorCode(error, 'PUBLISH_FAILED')
      }).finally(() => {
        if (!contextHooked) release()
      })
      return { status: 'started', publishId, publish: projectPublish(run) }
    },

    'publish.status': async args => {
      const publishId = stringValue(args, 'publishId')
      const run = publishId !== '' ? deps.publishRuns.get(publishId) : undefined
      if (run === undefined) return { status: 'error', reason: 'publish_id_required' }
      return { status: 'ready', publish: projectPublish(run) }
    },

    // 任务四项（X4；旧 index.js handleCreate/Status/Result/Cancel 同口径重译）。
    // 单版可编辑（已定案）：versionCount 固定传 1；文本媒体/事实补充等服务端
    // 支持但旧 UI 未开放的能力不投影（基线清单 §3）。
    'task.create': async args => {
      const mediaType = stringValue(args, 'mediaType')
      if (mediaType !== 'images' && mediaType !== 'video') return { status: 'error', reason: 'invalid_media_type' }
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      if (idempotencyKey === '') return { status: 'error', reason: 'idempotency_key_required' }
      // theme/direction 清洗同旧 cleanOptional（trim + 限长已在 schema 层）。
      const theme = stringValue(args, 'theme').trim()
      const direction = stringValue(args, 'direction').trim()
      // 对标笔记/账号：页面只开放 { source:'manual', url } / { name }（旧投影）。
      const refNote = stringValue(args, 'refNote')
      const refAccount = stringValue(args, 'refAccount')
      const references = refNote !== '' ? [{ source: 'manual', url: refNote }] : []
      const accounts = refAccount !== '' ? [{ name: refAccount }] : []
      const taskArgs: Record<string, unknown> = {
        mediaType, confirm: true, references, accounts, versionCount: 1, idempotencyKey,
      }
      if (theme !== '') taskArgs.theme = theme
      if (direction !== '') taskArgs.direction = direction
      if (mediaType === 'images') {
        const imageUrls = stringArrayValue(args, 'imageUrls')
        if (imageUrls.length === 0) return { status: 'error', reason: 'image_urls_required' }
        taskArgs.imageUrls = imageUrls
        taskArgs.coverIndex = 0
      } else {
        const videoUrl = stringValue(args, 'videoUrl')
        if (videoUrl === '') return { status: 'error', reason: 'video_url_required' }
        taskArgs.videoUrl = videoUrl
        taskArgs.videoUnderstanding = args.videoUnderstanding === true
      }
      const payload = await callWorkbench(deps, 'workbench_xhs_task_create', taskArgs)
      const taskId = firstString(payload.taskId, payload.task_ref, payload.taskRef)
      if (taskId === null) return { status: 'error', reason: 'create_failed_no_task' }
      return {
        status: 'created',
        taskId,
        idempotencyKey,
        mediaType,
        versionCount: 1,
        taskStatus: firstString(payload.status) ?? 'queued',
      }
    },

    'task.status': async args => {
      const taskId = stringValue(args, 'taskId')
      if (taskId === '') return { status: 'error', reason: 'task_id_required' }
      const payload = await callWorkbench(deps, 'workbench_xhs_task_get', { taskId })
      return {
        status: 'ready',
        taskId,
        taskStatus: firstString(payload.status) ?? 'unknown',
        currentStep: firstString(payload.currentStep),
        nextStep: firstString(payload.nextStep),
        errorCode: firstString(payload.errorCode),
        errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage.trim().slice(0, 512) : '',
        steps: projectSteps(payload.steps),
      }
    },

    'task.result': async args => {
      const taskId = stringValue(args, 'taskId')
      if (taskId === '') return { status: 'error', reason: 'task_id_required' }
      const payload = await callWorkbench(deps, 'workbench_xhs_result_get', { taskId })
      const taskStatus = firstString(payload.status) ?? 'unknown'
      const versions = projectVersions(payload.versions)
      // 契约（单版可编辑）：succeeded 必须返回 1-3 套文案；越界按读取失败处理，
      // 避免空白或静默异常版本数（旧 handleResult 同口径）。
      if (taskStatus === 'succeeded' && (versions.length < 1 || versions.length > 3)) {
        return { status: 'error', reason: 'versions_unavailable', taskId, taskStatus }
      }
      return { status: 'ready', taskId, taskStatus, versions }
    },

    'task.cancel': async args => {
      const taskId = stringValue(args, 'taskId')
      if (taskId === '') return { status: 'error', reason: 'task_id_required' }
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      if (idempotencyKey === '') return { status: 'error', reason: 'idempotency_key_required' }
      const payload = await callWorkbench(deps, 'workbench_xhs_task_cancel', { taskId, confirm: true, idempotencyKey })
      // 服务端取消是「请求取消」：透传投影状态给前端（旧口径）。
      return { status: 'ready', taskId, taskStatus: firstString(payload.status) ?? 'cancel_requested' }
    },

    // 车衣爆款看板 settings 读/写对（D-3：UI 只读展示，settingsUpdate action 保留
    // 对齐旧 Host 与 09 册 action 面；写操作 confirm + 幂等键，确定性校验前置不烧键）。
    'hotboard.settings': async () => {
      let payload: Record<string, unknown>
      try {
        payload = await callWorkbench(deps, 'workbench_xhs_hotboard_settings_get', {})
      } catch (error) {
        deps.logger.warn(`yootun xhs hotboard settings failed: ${safeHotboardToolError(error)}`)
        return { status: 'error', reason: safeHotboardToolError(error) }
      }
      const errorReason = hotboardErrorReason(payload)
      if (errorReason !== null) return { status: 'error', reason: errorReason }
      const data = 'data' in payload ? payload.data : payload
      const meta = 'meta' in payload ? payload.meta : null
      return { status: 'ready', data, meta }
    },

    'hotboard.settingsUpdate': async args => {
      // 写操作：confirm 必须显式 true，幂等键必填（旧 index.js handleHotboard 口径）。
      if (args.confirm !== true) return errorPayload('confirmation_required')
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      if (idempotencyKey === '') return errorPayload('idempotency_key_required')
      const settings = validateSettingsObject(args.settings)
      if (settings === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      let payload: Record<string, unknown>
      try {
        payload = await callWorkbench(deps, 'workbench_xhs_hotboard_settings_update', { settings, confirm: true, idempotencyKey })
      } catch (error) {
        const reason = safeHotboardToolError(error)
        deps.logger.warn(`yootun xhs hotboard settingsUpdate failed: ${reason}`)
        return errorPayload(reason)
      }
      const errorReason = hotboardErrorReason(payload)
      if (errorReason !== null) return errorPayload(errorReason)
      return { status: 'ready', ...projectHotboardWrite(payload) }
    },

    // ---- 看板剩余 12 action（X5；旧 index.js HOTBOARD_ACTIONS/hotboardArgs/handleHotboard 同口径重译）----

    'hotboard.overview': async args => {
      const page = hotboardPage(args, 'page')
      if (page === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const pageSize = hotboardPage(args, 'pageSize')
      if (pageSize === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = {
        window: hotboardEnum(args, 'window', HOTBOARD_ENUMS.window) ?? '30d',
      }
      if (page !== undefined) toolArgs.page = page
      if (pageSize !== undefined) toolArgs.pageSize = pageSize
      const sort = hotboardEnum(args, 'sort', HOTBOARD_ENUMS.sort)
      if (sort === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (sort !== undefined) toolArgs.sort = sort
      for (const [key, max] of [['keyword', 128], ['style', 64], ['color', 64], ['noteWord', 64], ['commentWord', 64]] as const) {
        const value = hotboardStr(args, key, max)
        if (value === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
        if (value !== undefined) toolArgs[key] = value
      }
      for (const key of ['scoreMin', 'scoreMax'] as const) {
        const value = args[key]
        if (value === undefined) continue
        const num = Number(value)
        if (!Number.isFinite(num) || num < 0 || num > 100) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
        toolArgs[key] = num
      }
      if (args.onlyMain !== undefined) toolArgs.onlyMain = args.onlyMain === true
      if (args.onlyTagged !== undefined) toolArgs.onlyTagged = args.onlyTagged === true
      return await hotboardRead(deps, 'workbench_xhs_hotboard_overview', toolArgs)
    },

    'hotboard.noteDetail': async args => {
      const noteId = hotboardStr(args, 'noteId', 128)
      if (noteId === null || noteId === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      return await hotboardRead(deps, 'workbench_xhs_hotboard_note_detail', { noteId })
    },

    'hotboard.noteTagUpdate': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const noteId = hotboardStr(args, 'noteId', 128)
      if (noteId === null || noteId === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const tagType = hotboardEnum(args, 'tagType', HOTBOARD_ENUMS.tagType)
      if (tagType === null || tagType === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const labelCode = hotboardStr(args, 'labelCode', 64)
      if (labelCode === null || labelCode === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_note_tag_update', { noteId, tagType, labelCode }, pre.idempotencyKey)
    },

    'hotboard.noteExclude': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const noteId = hotboardStr(args, 'noteId', 128)
      if (noteId === null || noteId === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_note_exclude', { noteId }, pre.idempotencyKey)
    },

    'hotboard.keywords': async args => {
      const page = hotboardPage(args, 'page')
      if (page === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const pageSize = hotboardPage(args, 'pageSize')
      if (pageSize === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = {}
      if (page !== undefined) toolArgs.page = page
      if (pageSize !== undefined) toolArgs.pageSize = pageSize
      const category = hotboardEnum(args, 'category', HOTBOARD_ENUMS.keywordCategory)
      if (category === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (category !== undefined) toolArgs.category = category
      const status = hotboardEnum(args, 'status', HOTBOARD_ENUMS.keywordStatus)
      if (status === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (status !== undefined) toolArgs.status = status
      const source = hotboardEnum(args, 'source', HOTBOARD_ENUMS.keywordSource)
      if (source === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (source !== undefined) toolArgs.source = source
      const keyword = hotboardStr(args, 'keyword', 128)
      if (keyword === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (keyword !== undefined) toolArgs.keyword = keyword
      return await hotboardRead(deps, 'workbench_xhs_hotboard_keywords_list', toolArgs)
    },

    'hotboard.keywordSave': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const action = hotboardEnum(args, 'op', HOTBOARD_ENUMS.keywordAction)
      if (action === null || action === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = { action }
      const keywordId = args.keywordId !== undefined && args.keywordId !== null ? cleanHotboardId(args.keywordId) : undefined
      if (keywordId === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (keywordId !== undefined) toolArgs.keywordId = keywordId
      const keyword = hotboardStr(args, 'keyword', 128)
      if (keyword === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (keyword !== undefined) toolArgs.keyword = keyword
      const category = hotboardEnum(args, 'category', HOTBOARD_ENUMS.keywordCategory)
      if (category === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (category !== undefined) toolArgs.category = category
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_keyword_save', toolArgs, pre.idempotencyKey)
    },

    'hotboard.runStart': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const runType = hotboardEnum(args, 'runType', HOTBOARD_ENUMS.runType) ?? 'incremental'
      const toolArgs: Record<string, unknown> = { runType }
      if (args.includeComments !== undefined) toolArgs.includeComments = args.includeComments === true
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_run_start', toolArgs, pre.idempotencyKey)
    },

    'hotboard.runGet': async args => {
      const runId = args.runId !== undefined && args.runId !== null ? cleanHotboardId(args.runId) : undefined
      if (runId === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = {}
      if (runId !== undefined) toolArgs.runId = runId
      return await hotboardRead(deps, 'workbench_xhs_hotboard_run_get', toolArgs)
    },

    'hotboard.candidates': async args => {
      const page = hotboardPage(args, 'page')
      if (page === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const pageSize = hotboardPage(args, 'pageSize')
      if (pageSize === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = {}
      if (page !== undefined) toolArgs.page = page
      if (pageSize !== undefined) toolArgs.pageSize = pageSize
      const status = hotboardEnum(args, 'status', HOTBOARD_ENUMS.candidateStatus)
      if (status === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (status !== undefined) toolArgs.status = status
      const category = hotboardEnum(args, 'category', HOTBOARD_ENUMS.keywordCategory)
      if (category === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (category !== undefined) toolArgs.category = category
      const keyword = hotboardStr(args, 'keyword', 128)
      if (keyword === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (keyword !== undefined) toolArgs.keyword = keyword
      // dateRange=[from,to]（YYYY-MM-DD）起止都填写才透传（review MINOR-3 口径）。
      const dateFrom = hotboardStr(args, 'dateFrom', 10)
      const dateTo = hotboardStr(args, 'dateTo', 10)
      if (dateFrom === null || dateTo === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (dateFrom !== undefined && dateTo !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/u.test(dateTo)) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
        toolArgs.dateRange = [dateFrom, dateTo]
      }
      return await hotboardRead(deps, 'workbench_xhs_hotboard_candidates_list', toolArgs)
    },

    'hotboard.candidateReview': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const action = hotboardEnum(args, 'op', HOTBOARD_ENUMS.candidateAction)
      if (action === null || action === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const candidateIds = Array.isArray(args.candidateIds) ? args.candidateIds : []
      if (candidateIds.length === 0) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const ids = candidateIds.map(item => cleanHotboardId(item))
      if (ids.some(id => id === null)) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_candidate_review', { action, candidateIds: ids }, pre.idempotencyKey)
    },

    'hotboard.labels': async args => {
      const page = hotboardPage(args, 'page')
      if (page === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const pageSize = hotboardPage(args, 'pageSize')
      if (pageSize === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = {}
      if (page !== undefined) toolArgs.page = page
      if (pageSize !== undefined) toolArgs.pageSize = pageSize
      const tagType = hotboardEnum(args, 'tagType', HOTBOARD_ENUMS.tagType)
      if (tagType === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (tagType !== undefined) toolArgs.tagType = tagType
      const status = hotboardEnum(args, 'status', HOTBOARD_ENUMS.labelStatus)
      if (status === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (status !== undefined) toolArgs.status = status
      const source = hotboardEnum(args, 'source', HOTBOARD_ENUMS.labelSource)
      if (source === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (source !== undefined) toolArgs.source = source
      const proposalStatus = hotboardEnum(args, 'proposalStatus', HOTBOARD_ENUMS.proposalStatus)
      if (proposalStatus === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (proposalStatus !== undefined) toolArgs.proposalStatus = proposalStatus
      const keyword = hotboardStr(args, 'keyword', 128)
      if (keyword === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (keyword !== undefined) toolArgs.keyword = keyword
      return await hotboardRead(deps, 'workbench_xhs_hotboard_labels_list', toolArgs)
    },

    'hotboard.labelReview': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const action = hotboardEnum(args, 'op', HOTBOARD_ENUMS.labelReviewAction)
      if (action === null || action === undefined) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      const toolArgs: Record<string, unknown> = { action }
      for (const key of ['proposalId', 'labelId', 'targetLabelId'] as const) {
        const value = args[key]
        if (value === undefined || value === null || value === '') continue
        const id = cleanHotboardId(value)
        if (id === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
        toolArgs[key] = id
      }
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_label_review', toolArgs, pre.idempotencyKey)
    },

    'hotboard.labelSave': async args => {
      const pre = hotboardWritePre(args)
      if ('payload' in pre) return pre.payload
      const toolArgs: Record<string, unknown> = {}
      const labelId = args.labelId !== undefined && args.labelId !== null ? cleanHotboardId(args.labelId) : undefined
      if (labelId === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (labelId !== undefined) toolArgs.labelId = labelId
      const tagType = hotboardEnum(args, 'tagType', HOTBOARD_ENUMS.tagType)
      if (tagType === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (tagType !== undefined) toolArgs.tagType = tagType
      const code = hotboardStr(args, 'code', 64)
      if (code === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (code !== undefined) toolArgs.code = code
      const name = hotboardStr(args, 'name', 128)
      if (name === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (name !== undefined) toolArgs.name = name
      if (args.aliases !== undefined && args.aliases !== null) {
        const aliases = Array.isArray(args.aliases) ? args.aliases : []
        if (aliases.length === 0) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
        toolArgs.aliases = aliases
      }
      const definition = hotboardStr(args, 'definition', 2000)
      if (definition === null) return errorPayload('XHS_HOTBOARD_INVALID_ARGUMENT')
      if (definition !== undefined) toolArgs.definition = definition
      return await hotboardWrite(deps, 'workbench_xhs_hotboard_label_save', toolArgs, pre.idempotencyKey)
    },
  }
  // dispose 开始后统一稳定拒绝新 action（不登记）；已通过 guard 的在途 action
  // 一律经 runTracked 登记——dispose 等待其 settle（登录/采集另有 abort 链路，
  // probe/读路径被等待收敛）。
  const guarded: Record<string, ActionHandler> = {}
  for (const [action, handler] of Object.entries(handlers)) {
    guarded[action] = async (args: ActionArgs) => {
      if (deps.disposing) return { status: 'error', reason: 'plugin_disposing' }
      return deps.taskRegistry.runTracked(() => handler(args))
    }
  }
  return guarded
}

export type { AccountProfile, SnapshotNote }
