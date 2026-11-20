/**
 * 已实现 14 项 action 的 Host 实现（依赖注入面 + 处理器表）。登录/采集均为
 * 进程内 AbortController 生命周期（dispose 统一 abort + 等待 settle）；profile
 * 互斥按旧口径即时占（登录/采集全程持锁，probe/删除 try 语义立即拒绝）。响应
 * 形状沿用旧路由契约（status: ready/started/created/error），client 半按同形状
 * 重译。Workbench 调用经 `ctx.yootunWorkbench`（settings 对 + 任务四项已接入；
 * hotboard 其余随 X5、publish/assistant 随 X6 批次接入）。
 * @module
 */
import type { BrowserStatus, ChromeFactory } from './chrome.ts'
import { safeCode, SERVER_HOTBOARD_ERROR_CODES, SERVER_COMMON_ERROR_CODES, STABLE_ERROR_CODES } from './errors.ts'
import { acquireProfileLock, isProfileLocked, tryWithProfileLock, type ProfileLockRelease } from './locks.ts'
import { createTaskRegistry, type TaskRegistry } from './lifecycle.ts'
import { CollectError, collectNotes, summarizeSnapshot, type SnapshotSummary } from './collector.ts'
import {
  isPendingAccountId, loginWithQrCode, probeSession, removeLocalAccount,
  type AccountProfile, type LoginResult, type RemoveLocalResult,
} from './session.ts'
import { LOGIN_TIMEOUT_MS } from './session.ts'
import { latestSnapshot, readAccounts, type SnapshotNote } from './state.ts'
import type { XhsWorkbenchFace } from './workbench.ts'
import type { ActionArgs, ActionHandler } from './route.ts'

/** MCP 错误信封 → 受控 reason 白名单（白名单外一律收敛，不透传原文）。 */
const HOTBOARD_REASON_CODES: ReadonlySet<string> = new Set([...SERVER_HOTBOARD_ERROR_CODES, ...SERVER_COMMON_ERROR_CODES, 'XHS_HOTBOARD_INTERNAL_ERROR'])

/** settings 受控字段白名单（旧 index.js HOTBOARD_SETTINGS_* 同口径）；值域/cron
 * 深校验在 tools 侧，Host 只做键白名单与值类型粗校验。 */
const HOTBOARD_SETTINGS_BOOL: ReadonlySet<string> = new Set(['scheduleEnabled', 'manualIncrementEnabled', 'commentSampleEnabled', 'manualCommentDefaultEnabled'])
const HOTBOARD_SETTINGS_NUMBER: ReadonlySet<string> = new Set(['publishWindowDays', 'perKeywordLimit', 'commentTopN', 'commentMaxPerNote', 'minInteractionTotal', 'dedupHammingThreshold', 'minValidSample', 'searchMaxCallsPerDay', 'commentMaxCallsPerDay', 'detailMaxCallsPerRun'])
const HOTBOARD_SETTINGS_KEYS: ReadonlySet<string> = new Set([...HOTBOARD_SETTINGS_BOOL, ...HOTBOARD_SETTINGS_NUMBER, 'fullScheduleCron'])

/** 登录等待状态（页面轮询 loginStatus；终态读取一次即清理）。 */
export interface LoginRun {
  key: string
  status: 'waiting' | 'ok' | 'timeout' | 'failed'
  accountId: string | null
  nickname: string | null
  avatar: string | null
  error: string | null
  release: ProfileLockRelease
}

/** 单账号采集 run（进程内；页面 2s 轮询 collect.status）。 */
export interface CollectRun {
  collectId: string
  accountId: string
  status: 'running' | 'completed' | 'failed'
  pagesDone: number
  notesTotal: number
  truncated: boolean
  summary: SnapshotSummary | null
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
  /** 扫码登录等待上限（测试注入短值；生产为 10 分钟旧口径）。 */
  loginTimeoutMs: number
  loginRuns: Map<string, LoginRun>
  loginSignals: Map<string, AbortController>
  probeSignals: Map<string, AbortController>
  collectSignals: Map<string, AbortController>
  collectRuns: Map<string, CollectRun>
  /** 创建型幂等：idempotencyKey → collectId 重放既有 run（旧 index.js 口径）。 */
  collectIdempotency: Map<string, string>
}

/**
 * Assemble the Host deps.
 * @param options - root/workbench/browserStatus/logger/chromeFactory/registry seams.
 * @returns the deps bundle.
 */
export function createXhsHostDeps(options: {
  root: string
  workbench: XhsWorkbenchFace
  browserStatusFn: () => Promise<BrowserStatus>
  logger: { warn(message: string): void }
  chromeFactory?: ChromeFactory
  taskRegistry?: TaskRegistry
}): XhsHostDeps {
  return {
    root: options.root,
    workbench: options.workbench,
    browserStatusFn: options.browserStatusFn,
    logger: options.logger,
    chromeFactory: options.chromeFactory,
    taskRegistry: options.taskRegistry ?? createTaskRegistry(),
    disposing: false,
    loginTimeoutMs: LOGIN_TIMEOUT_MS,
    loginRuns: new Map(),
    loginSignals: new Map(),
    probeSignals: new Map(),
    collectSignals: new Map(),
    collectRuns: new Map(),
    collectIdempotency: new Map(),
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

/** MCP 错误信封（payload.error.code）→ 受控 reason；白名单外收敛 INTERNAL。 */
function hotboardErrorReason(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null
  const error = payload.error
  if (error === null || typeof error !== 'object') return null
  const code = typeof (error as Record<string, unknown>).code === 'string' ? (error as Record<string, unknown>).code as string : ''
  return HOTBOARD_REASON_CODES.has(code) ? code : 'XHS_HOTBOARD_INTERNAL_ERROR'
}

/** 抛错形态的 Workbench 业务失败 → 受控 reason（message 可能为错误信封 JSON）。 */
function safeHotboardToolError(error: unknown): string {
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

function hotboardReasonOf(error: unknown): string {
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

/** 本地浏览器/采集错误 → 受控错误码（白名单外收敛 LOGIN_FAILED 等）。 */
function localErrorCode(error: unknown, fallback: string): string {
  const code = safeCode(error)
  return (STABLE_ERROR_CODES as readonly string[]).includes(code) ? code : fallback
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
      for (const run of deps.loginRuns.values()) {
        if (run.status !== 'waiting') continue
        if (requested !== '' ? run.key === requested : isPendingAccountId(run.key)) {
          return { status: 'ready', login: projectLogin(run) }
        }
      }
      const runKey = requested !== '' ? requested : `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      // Profile 互斥：重新登录锁显式账号；新增账号锁 pending 键（即时占语义）。
      const release = acquireProfileLock(runKey)
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
        isResolvedBusy: isProfileLocked,
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      }).then(async (result: LoginResult) => {
        if (result.status === 'ok') {
          run.status = 'ok'
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
          // 错误码收敛到受控白名单：不透出原始异常名。
          run.error = result.status === 'timeout'
            ? 'LOGIN_TIMEOUT'
            : (STABLE_ERROR_CODES as readonly string[]).includes(result.reason) ? result.reason : 'LOGIN_FAILED'
        }
      }).catch((error: unknown) => {
        run.status = 'failed'
        run.error = localErrorCode(error, 'LOGIN_FAILED')
      }).finally(() => {
        release()
        if (deps.loginSignals.get(runKey) === controller) deps.loginSignals.delete(runKey)
      }))
      return { status: 'ready', login: projectLogin(run) }
    },

    'account.loginStatus': async args => {
      const key = stringValue(args, 'loginId') || stringValue(args, 'accountId')
      const run = key !== '' ? deps.loginRuns.get(key) : undefined
      if (run === undefined) {
        // 无进行中登录：返回 idle（页面刷新后直接查账号列表即可）。
        return { status: 'ready', login: { status: 'idle', loginId: key !== '' ? key : null } }
      }
      if (run.status !== 'waiting') {
        // 终态 run 保留供 loginStatus 查询一次，读取后即清理。
        deps.loginRuns.delete(run.key)
        if (run.accountId !== null && run.accountId !== run.key) deps.loginRuns.delete(run.accountId)
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
        const attempt = await tryWithProfileLock(accountId, () =>
          probeSession({ accountId, root: deps.root, chromeFactory: deps.chromeFactory, signal: controller.signal }))
        if (!attempt.acquired) return { status: 'error', reason: 'PROFILE_BUSY' }
        const result = attempt.result
        if (result.status === 'ok' || result.status === 'expired') {
          return { status: 'ready', accountId, sessionStatus: result.status }
        }
        // unknown（浏览器/驱动异常）→ 受控 PROBE_FAILED / 专码，不透出原始异常名。
        const reason = (STABLE_ERROR_CODES as readonly string[]).includes(result.reason ?? '')
          ? result.reason as string
          : 'PROBE_FAILED'
        return { status: 'error', reason }
      } finally {
        if (deps.probeSignals.get(accountId) === controller) deps.probeSignals.delete(accountId)
      }
    },

    'account.removeLocal': async args => {
      const accountId = stringValue(args, 'accountId')
      if (accountId === '') return { status: 'error', reason: 'account_id_required' }
      // 移除会递归删除该账号的 Profile/storage_state/快照：与登录/probe/采集互斥，
      // 否则运行中的浏览器操作会在被删目录上继续写（僵尸账号）。占用即拒绝。
      const attempt = await tryWithProfileLock(accountId, () => removeLocalAccount({ accountId, root: deps.root }))
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
      if (deps.collectIdempotency.has(idempotencyKey)) {
        // 幂等重放：返回既有 run 的当前状态（不重复创建采集任务）。
        const run = deps.collectRuns.get(deps.collectIdempotency.get(idempotencyKey) ?? '')
        if (run !== undefined) return { status: 'started', collectId: run.collectId, collect: projectCollect(run) }
      }
      // Profile 互斥：采集（无头复用 Profile）与其他浏览器操作互斥；占用即拒绝。
      const release = acquireProfileLock(accountId)
      if (release === null) return { status: 'error', reason: 'PROFILE_BUSY' }
      const collectId = `col-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const run: CollectRun = { collectId, accountId, status: 'running', pagesDone: 0, notesTotal: 0, truncated: false, summary: null, error: null, release }
      deps.collectRuns.set(collectId, run)
      deps.collectIdempotency.set(idempotencyKey, collectId)
      const controller = new AbortController()
      deps.collectSignals.set(collectId, controller)
      // 采集是后台长动作：立即返回 started，结果落设备端快照（不入库，Q10）。
      deps.taskRegistry.track(collectNotes({
        accountId,
        root: deps.root,
        chromeFactory: deps.chromeFactory,
        signal: controller.signal,
        onProgress: progress => {
          if (deps.collectRuns.get(collectId) !== run) return
          run.pagesDone = Number.isFinite(progress.pagesDone) ? progress.pagesDone : run.pagesDone
          run.notesTotal = Number.isFinite(progress.notesTotal) ? progress.notesTotal : run.notesTotal
        },
      }).then(result => {
        run.status = 'completed'
        run.pagesDone = result.pagesDone
        run.notesTotal = result.notesTotal
        run.summary = result.summary
        run.truncated = result.truncated === true
      }).catch((error: unknown) => {
        run.status = 'failed'
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
      const collectId = stringValue(args, 'collectId')
      const run = collectId !== '' ? deps.collectRuns.get(collectId) : undefined
      if (run === undefined) return { status: 'error', reason: 'collect_id_required' }
      return { status: 'ready', collect: projectCollect(run) }
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
      if (args.confirm !== true) return { status: 'error', reason: 'confirmation_required' }
      const idempotencyKey = stringValue(args, 'idempotencyKey')
      if (idempotencyKey === '') return { status: 'error', reason: 'idempotency_key_required' }
      const settings = validateSettingsObject(args.settings)
      if (settings === null) return { status: 'error', reason: 'XHS_HOTBOARD_INVALID_ARGUMENT' }
      let payload: Record<string, unknown>
      try {
        payload = await callWorkbench(deps, 'workbench_xhs_hotboard_settings_update', { settings, confirm: true, idempotencyKey })
      } catch (error) {
        const reason = safeHotboardToolError(error)
        deps.logger.warn(`yootun xhs hotboard settingsUpdate failed: ${reason}`)
        return { status: 'error', reason }
      }
      const errorReason = hotboardErrorReason(payload)
      if (errorReason !== null) return { status: 'error', reason: errorReason }
      return { status: 'ready', ...projectHotboardWrite(payload) }
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
