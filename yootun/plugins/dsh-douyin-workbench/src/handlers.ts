/**
 * Host action 实现（依赖注入面 + 处理器表；分批扩充）。D2 批：browser.status /
 * accounts.list / 登录三态 / probe（含 pending 提升）/ 删除两步 / 采集单账号与
 * 批量（互斥 collect_busy、runs.json G-2 恢复投影）。D3–D5：作品/总览/导出/
 * 排期/AI 分析报表/负责人投流。D6–D8：breakdown 10 + material 8 + gene 5
 * （viral 域直通与窄投影）。登录/采集均为进程内 AbortController 生命周期
 * （dispose 统一 abort + 等待 settle）；Workbench 调用经 douyin-workbench
 * caller；稳定错误码收敛不透传原文。
 * @module
 */
import { normalizeAvatarUrl } from './avatar.ts'
import { isStableCode, safeCode, DouyinError, type StableErrorCode } from './errors.ts'
import { accountRemoveIdempotencyKey, accountSaveIdempotencyKey } from './idempotency.ts'
import { createTaskRegistry, type TaskRegistry } from './lifecycle.ts'
import { tryWithProfileLock, withProfileLock } from './locks.ts'
import { readRuns, recoverInterruptedRuns, removeAccountRuns, updateRun, type RunRecord } from './runs.ts'
import {
  isPendingAccountId, launchChromeSession, loginWithQrCode, promotePendingAccount,
  refreshSessionState, removeLocalAccount, type ChromeFactory, type DouyinProfile,
} from './session.ts'
import { getAccount, hasStorageState, paths, readAccounts } from './state.ts'
import {
  batchCandidates, createBatchCollectController, createCollectController, reportSessionStatus,
  type BatchStatus, type CollectResult, type RunnerDeps,
} from './runner.ts'
import type { ActionArgs, ActionHandler, HandlerPayload } from './route.ts'
import type { WorkbenchFace } from './workbench.ts'

/** 登录 run（进程内；页面轮询 loginStatus；终态读取一次即清理）。 */
export interface LoginRun {
  key: string
  status: 'waiting' | 'ok' | 'timeout' | 'failed'
  accountId: string | null
  error: string | null
  saveError: string | null
  startedAt: string
}

/** 登录 run 的白名单投影（旧 projectLogin：五字段，无 phase/qrNeeded）。 */
function projectLogin(run: LoginRun): Record<string, unknown> {
  return { loginKey: run.key, status: run.status, accountId: run.accountId, error: run.error, saveError: run.saveError }
}

/** Host 依赖注入面（handlers；测试可整体替换）。 */
export interface DouyinHandlerDeps {
  root: string
  callTool: (tool: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ structuredContent: unknown; content: unknown }>
  browserStatusFn: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  logger: { warn(message: string, error?: unknown): void }
  disposing: boolean
  signals: Map<string, AbortController>
  taskRegistry: TaskRegistry
  chromeFactory: ChromeFactory | undefined
  loginRuns: Map<string, LoginRun>
  maxPages: number
  /** 批量采集并发度（阶段 2 worker 数；1..5）。 */
  batchConcurrency: number
  /** 启动恢复（G-2）：running→interrupted 标记；业务 action 在它 settle 前等待。 */
  startupReady: Promise<void>
  /** 启动恢复失败（runs.json 语义损坏）的稳定码；非 null 时业务 action 拒绝。 */
  startupError: StableErrorCode | null
  /** pending 提升接缝（缺省 promotePendingAccount；测试注入受控实现）。 */
  promote: (input: { accountId: string; root: string; chromeFactory?: ChromeFactory | undefined }) => Promise<{ promoted: boolean; accountId: string; reason?: string }>
}

/** 从 Workbench face 构建直接调用通道（handlers 用；caller 前缀校验已在 workbench.ts；signal 原样透传）。 */
function callerOf(face: { callTool(caller: 'douyin-workbench', domain: 'douyin' | 'viral', name: string, args: unknown, signal?: AbortSignal): Promise<{ structuredContent: unknown; content: unknown }> }) {
  return async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ structuredContent: unknown; content: unknown }> => {
    const domain = tool.startsWith('workbench_douyin_') ? 'douyin' : tool.startsWith('workbench_viral_') ? 'viral' : undefined
    if (domain === undefined) throw new DouyinError('DOUYIN_TOOL_UNAVAILABLE', `tool "${tool}" is outside the douyin/viral groups`)
    return face.callTool('douyin-workbench', domain, tool, args, signal)
  }
}

/** 启动恢复接缝（G-2）：缺省 recoverInterruptedRuns；测试可注入受控实现。 */
export type StartupRecovery = (root: string) => Promise<number>

/**
 * Assemble handler deps（controllers 之外的部分）。构造即启动 G-2 恢复
 * （running→interrupted，不阻塞 route 注册）；业务 action 在恢复 settle 前
 * 等待，恢复失败（runs.json 语义损坏）后业务 action 一律 run_state_corrupt。
 * @param options.root - state root.
 * @param options.face - the shared Workbench MCP connector.
 * @param options.browserStatusFn - browser capability probe.
 * @param options.logger - diagnostic logger.
 * @param options.chromeFactory - Chrome launcher seam (tests).
 * @param options.maxPages - default collect page budget.
 * @param options.batchConcurrency - batch collect concurrency (defaults to 3).
 * @param options.taskRegistry - task registry (defaults to a fresh one).
 * @param options.recovery - startup recovery seam (defaults to recoverInterruptedRuns).
 * @returns the deps shared by handlers.
 */
export function createHandlerDeps(options: {
  root: string
  face: WorkbenchFace
  browserStatusFn: () => Promise<{ chromeAvailable: boolean; driverAvailable: boolean; platform: string; hint: string | null }>
  logger?: { warn(message: string, error?: unknown): void }
  chromeFactory?: ChromeFactory
  maxPages?: number
  batchConcurrency?: number
  taskRegistry?: TaskRegistry
  recovery?: StartupRecovery
  /** pending 提升接缝（测试注入；生产缺省 promotePendingAccount）。 */
  promote?: DouyinHandlerDeps['promote']
}): DouyinHandlerDeps {
  const taskRegistry = options.taskRegistry ?? createTaskRegistry()
  const deps: DouyinHandlerDeps = {
    root: options.root,
    callTool: callerOf(options.face),
    browserStatusFn: options.browserStatusFn,
    logger: options.logger ?? { warn: () => undefined },
    disposing: false,
    signals: new Map(),
    taskRegistry,
    chromeFactory: options.chromeFactory ?? launchChromeSession,
    loginRuns: new Map(),
    maxPages: options.maxPages ?? 1000,
    batchConcurrency: options.batchConcurrency ?? 3,
    startupError: null,
    startupReady: Promise.resolve(),
    promote: options.promote ?? ((input: { accountId: string; root: string; chromeFactory?: ChromeFactory | undefined }) =>
      promotePendingAccount({ accountId: input.accountId, root: input.root, chromeFactory: input.chromeFactory })),
  }
  // G-2 启动恢复：立即启动（不阻塞 route 注册），完成前业务 action 等待。
  // recovery promise 纳入任务登记表：dispose 等它 settle——pending 期间
  // activeCount ≥ 1，release 前 dispose 不返回，返回后不再有 runs.json 写入。
  // 错误在链内吞掉并记 startupError（不产生 unhandled rejection）。
  const run = (options.recovery ?? recoverInterruptedRuns)(options.root)
  deps.startupReady = run.then(() => undefined, (error: unknown) => {
    deps.startupError = safeCode(error)
    deps.logger.warn('douyin startup run recovery failed', error)
  })
  deps.taskRegistry.track(deps.startupReady)
  return deps
}

/** 账号行投影（旧 projectAccounts 合并语义；墓碑过滤、本地优先）。 */
export function projectAccounts(local: { accountId: string; nickname?: string | undefined; avatar?: string | undefined; fanCount?: number | undefined; sessionStatus?: string | undefined; sessionCheckedAt?: string | undefined }[], remote: Record<string, unknown>[]): { accounts: Record<string, unknown>[]; remoteError: string | null } {
  const merged = new Map<string, Record<string, unknown>>()
  for (const item of local) {
    merged.set(item.accountId, {
      accountId: item.accountId,
      nickname: item.nickname ?? null,
      avatar: normalizeAvatarUrl(item.avatar),
      fanCount: typeof item.fanCount === 'number' && Number.isFinite(item.fanCount) ? item.fanCount : null,
      sessionStatus: item.sessionStatus ?? 'unknown',
      sessionCheckedAt: item.sessionCheckedAt ?? null,
      lastCollectedAt: null,
      ownerName: null,
      deleteState: 'none',
      local: true,
      isPending: isPendingAccountId(item.accountId),
    })
  }
  for (const row of remote) {
    const accountId = typeof row.account_id === 'string' ? row.account_id.trim() : ''
    if (accountId === '') continue
    // 墓碑行不进可用列表（remote_deleted 是远端删除残留）。
    if (row.delete_state === 'remote_deleted') continue
    const ownerName = typeof row.owner_name === 'string' && row.owner_name.trim() !== '' ? row.owner_name.trim().slice(0, 128) : null
    const existing = merged.get(accountId)
    if (existing === undefined) {
      merged.set(accountId, {
        accountId,
        nickname: typeof row.nickname === 'string' && row.nickname !== '' ? row.nickname : null,
        avatar: normalizeAvatarUrl(row.avatar),
        fanCount: Number.isFinite(Number(row.fan_count)) ? Number(row.fan_count) : null,
        sessionStatus: typeof row.session_status === 'string' && row.session_status !== '' ? row.session_status : 'unknown',
        sessionCheckedAt: typeof row.session_checked_at === 'string' && row.session_checked_at !== '' ? row.session_checked_at : null,
        lastCollectedAt: typeof row.last_collected_at === 'string' && row.last_collected_at !== '' ? row.last_collected_at : null,
        ownerName,
        deleteState: typeof row.delete_state === 'string' && row.delete_state !== '' ? row.delete_state : 'none',
        local: false,
        isPending: isPendingAccountId(accountId),
      })
      continue
    }
    existing.nickname = existing.nickname ?? (typeof row.nickname === 'string' && row.nickname !== '' ? row.nickname : null)
    existing.avatar = existing.avatar ?? normalizeAvatarUrl(row.avatar)
    existing.fanCount = existing.fanCount ?? (Number.isFinite(Number(row.fan_count)) ? Number(row.fan_count) : null)
    existing.sessionStatus = existing.sessionStatus !== 'unknown' ? existing.sessionStatus : (typeof row.session_status === 'string' && row.session_status !== '' ? row.session_status : 'unknown')
    existing.sessionCheckedAt = existing.sessionCheckedAt ?? (typeof row.session_checked_at === 'string' && row.session_checked_at !== '' ? row.session_checked_at : null)
    existing.lastCollectedAt = typeof row.last_collected_at === 'string' && row.last_collected_at !== '' ? row.last_collected_at : null
    existing.ownerName = ownerName
    existing.deleteState = typeof row.delete_state === 'string' && row.delete_state !== '' ? row.delete_state : 'none'
  }
  return { accounts: [...merged.values()].sort((a, b) => String(a.accountId).localeCompare(String(b.accountId))), remoteError: null }
}

/** 别名翻译：残留占位 ID → 真实 ID（promotedFrom 反查；只翻译不升级）。 */
export async function resolveAccountAlias(accountId: string, root: string): Promise<string> {
  const local = await readAccounts(root).catch(() => ({ version: 1, accounts: {} }))
  for (const record of Object.values(local.accounts)) {
    if (record.promotedFrom === accountId && record.accountId !== accountId) return record.accountId
  }
  return accountId
}

/** pending 提升结果（promoted 时附带远端占位行清理回执）。 */
export interface ResolveAccountOutcome {
  accountId: string
  promoted: boolean
  saveError: string | null
  remoteCleanup: string | null
}

/**
 * 占位账号解析（旧 resolveAccountId）：非 pending 原样返回；有在途采集不升级；
 * 升级成功后幂等补 account_save（真实 ID）并远端墓碑清理占位行（失败不阻断）。
 */
export async function resolveAccountId(deps: DouyinHandlerDeps, collectHasRunning: (accountId: string) => boolean, accountId: string, signal?: AbortSignal): Promise<ResolveAccountOutcome> {
  if (!isPendingAccountId(accountId)) return { accountId, promoted: false, saveError: null, remoteCleanup: null }
  if (collectHasRunning(accountId)) return { accountId, promoted: false, saveError: null, remoteCleanup: null }
  const promoted = await deps.promote({ accountId, root: deps.root, chromeFactory: deps.chromeFactory })
  if (!promoted.promoted) return { accountId, promoted: false, saveError: null, remoteCleanup: null }
  const realId = promoted.accountId
  let saveError: string | null = null
  try {
    const record = await getAccount(realId, deps.root).catch(() => undefined)
    const payload: Record<string, unknown> = {
      accountId: realId,
      sessionRef: paths(deps.root).vaultRef(realId),
      idempotencyKey: accountSaveIdempotencyKey(realId),
    }
    if (typeof record?.nickname === 'string' && record.nickname !== '') payload.nickname = record.nickname
    if (typeof record?.fanCount === 'number' && Number.isFinite(record.fanCount)) payload.fanCount = record.fanCount
    await deps.callTool('workbench_douyin_account_save', payload, signal)
  } catch (error) {
    saveError = safeCode(error)
  }
  let remoteCleanup = 'removed'
  try {
    await deps.callTool('workbench_douyin_account_remove', {
      accountId,
      confirm: true,
      idempotencyKey: accountRemoveIdempotencyKey(accountId),
    }, signal)
  } catch (error) {
    remoteCleanup = safeCode(error)
  }
  return { accountId: realId, promoted: true, saveError, remoteCleanup }
}

/** 导出内容上限（原始 1MB / 序列化响应 1.8MB；旧 §6 冻结）。 */
export const EXPORT_MAX_CONTENT_BYTES = 1_000_000
export const EXPORT_MAX_RESPONSE_BYTES = 1_800_000

const FILENAME_INVALID = /[/\\:*?"<>|\u0000-\u001f\u007f]/g
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 文件名净化：非法字符替换、去首空白点、128 截断、前缀+扩展校验兜底。 */
export function projectFileName(raw: unknown, prefix: string, fallback: string): string {
  if (typeof raw !== 'string' || raw === '') return fallback
  let name = raw.replaceAll(FILENAME_INVALID, '_').replace(/^[\s.]+/u, '').slice(0, 128).trim()
  if (!name.startsWith(prefix) || !name.endsWith('.xlsx')) name = fallback
  return name
}

/** 导出四 action 的公共载荷校验与投影（base64/字节数自洽 + 双上限）。 */
async function callExport(deps: DouyinHandlerDeps, tool: string, args: Record<string, unknown>, options: {
  prefix: string
  fallback: string
  /** 服务端码 → 本地稳定码映射（值必须是稳定码白名单成员）。 */
  errorMap?: Partial<Record<string, StableErrorCode>>
  /** 请求级取消（dispose 取消在途导出）。 */
  signal?: AbortSignal
}): Promise<HandlerPayload> {
  let payload: Record<string, unknown>
  try {
    const outcome = await deps.callTool(tool, args, options.signal)
    payload = outcome.structuredContent && typeof outcome.structuredContent === 'object'
      ? outcome.structuredContent as Record<string, unknown>
      : {}
  } catch (error) {
    const code = safeCode(error)
    const mapped = options.errorMap?.[code]
    if (mapped !== undefined) throw new DouyinError(mapped, code)
    if (code === 'DOUYIN_EXPORT_TOO_LARGE') throw new DouyinError('export_too_large', code)
    throw new DouyinError('export_failed', code)
  }
  const base64 = payload.content_base64 ?? payload.contentBase64
  const contentBytes = payload.content_bytes ?? payload.sizeBytes
  if (typeof base64 !== 'string' || base64 === '' || typeof contentBytes !== 'number' || !Number.isFinite(contentBytes) || contentBytes <= 0) {
    throw new DouyinError('export_failed', 'invalid export payload')
  }
  if (contentBytes > EXPORT_MAX_CONTENT_BYTES) throw new DouyinError('export_too_large', 'content too large')
  // base64 长度与声明字节数必须自洽（截断/篡改防御）。
  if (base64.length !== Math.ceil(contentBytes / 3) * 4) throw new DouyinError('export_failed', 'base64 size mismatch')
  const fileName = projectFileName(payload.file_name ?? payload.fileName, options.prefix, options.fallback)
  const mimeType = payload.mime_type ?? payload.mimeType
  const projected: HandlerPayload = {
    status: 'ready',
    file_name: fileName,
    mime_type: typeof mimeType === 'string' && mimeType !== '' ? mimeType : XLSX_MIME,
    content_base64: base64,
    content_bytes: contentBytes,
    row_counts: payload.row_counts ?? null,
  }
  if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > EXPORT_MAX_RESPONSE_BYTES) {
    throw new DouyinError('export_too_large', 'response too large')
  }
  return projected
}

/** 只带已定义参数（route 层已剔空；此处组装远端 args，undefined 不出网）。 */
function definedArgs(args: ActionArgs, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = args[key]
    if (value === undefined) continue
    if (Array.isArray(value) && value.length === 0) continue
    out[key] = value
  }
  return out
}

/** workflow 行投影：服务端蛇形 candidate_id 归一为 candidateId，其余字段原样。 */
function projectWorkflowItem(item: unknown): Record<string, unknown> {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return {}
  const { candidate_id: candidateId, ...rest } = item as Record<string, unknown>
  return candidateId !== undefined ? { ...rest, candidateId } : rest
}

/** workflow_get 载荷投影：items 逐行归一 + total（缺失回退本页计数）。 */
function projectWorkflowItems(payload: unknown): { items: Record<string, unknown>[]; total: number } {
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const items = Array.isArray(record.items) ? record.items.map(projectWorkflowItem) : []
  const total = Number(record.total)
  return { items, total: Number.isFinite(total) ? total : items.length }
}

/**
 * 登录成功后的后续链路（beginLogin 内联提取，生产路径零变化；测试可直调）：
 * 顺序冻结——先 account_save（saveError 透出），再翻 ok，最后会话上报。每个
 * 阶段 await 前检查 login signal：abort 后不再发起后续调用（含 session
 * report）；本地登录态（storage_state/profile 迁移已在 loginWithQrCode 内
 * 完成）一律保留不清理；run 稳定落 failed + login_aborted（既有稳定码）。
 * 日志只记稳定码，不含 Cookie/storage_state/本地路径。
 */
export async function completeLoginAfterSuccess(
  deps: DouyinHandlerDeps,
  signal: AbortSignal,
  run: LoginRun,
  result: { status: 'ok'; accountId: string; profile: DouyinProfile | null } | { status: 'timeout' } | { status: 'failed'; reason: string },
): Promise<void> {
  if (result.status !== 'ok') {
    if (result.status === 'timeout') {
      run.status = 'timeout'
      run.error = 'login_timeout'
    } else {
      run.status = 'failed'
      run.error = result.reason
    }
    return
  }
  run.accountId = result.accountId
  // abort 检查走函数边界（const 收窄不跨 await）。
  const aborted = (): boolean => signal.aborted
  if (aborted()) {
    run.status = 'failed'
    run.error = 'login_aborted'
    return
  }
  // ① account_save（携带 login signal；失败记 saveError 不阻断翻态）。
  try {
    const payload: Record<string, unknown> = {
      accountId: result.accountId,
      sessionRef: paths(deps.root).vaultRef(result.accountId),
      idempotencyKey: accountSaveIdempotencyKey(result.accountId),
    }
    const profile: DouyinProfile | null = result.profile
    if (profile?.nickname != null) payload.nickname = profile.nickname
    if (profile?.avatar != null) payload.avatar = profile.avatar
    if (profile?.fanCount != null) payload.fanCount = profile.fanCount
    await deps.callTool('workbench_douyin_account_save', payload, signal)
    run.saveError = null
  } catch (error) {
    run.saveError = safeCode(error)
    deps.logger.warn('douyin account_save after login failed', error)
  }
  if (aborted()) {
    run.status = 'failed'
    run.error = 'login_aborted'
    return
  }
  run.status = 'ok'
  // ② 会话上报（新 seq；携带 login signal；失败不影响 run 终态）。
  try {
    const state = await refreshSessionState({ accountId: result.accountId, root: deps.root, chromeFactory: deps.chromeFactory, signal })
    if (aborted()) return
    const report = await reportSessionStatus(
      { callTool: deps.callTool, root: deps.root, chromeFactory: deps.chromeFactory, maxPages: deps.maxPages, logger: { warn: (message: string) => { deps.logger.warn(message) } } },
      result.accountId,
      state,
      signal,
    )
    if (!report.ok) deps.logger.warn(`douyin session report after login failed: ${report.error ?? ''}`)
  } catch (error) {
    deps.logger.warn('douyin session report after login failed', error)
  }
}

/** 全量 action 处理器表（57 项：分册 15 §3 的 56 项 + collect.running）。 */
export function buildDouyinHandlers(deps: DouyinHandlerDeps, controllers: {
  collect: ReturnType<typeof createCollectController>
  batch: ReturnType<typeof createBatchCollectController>
}): Record<string, ActionHandler> {
  const asString = (args: ActionArgs, key: string): string => typeof args[key] === 'string' ? args[key] as string : ''
  let actionSeq = 0
  const guard = (handler: ActionHandler): ActionHandler => async (args: ActionArgs, _requestSignal?: AbortSignal) => {
    // 请求进入即登记 signal 与任务追踪（覆盖 startup 等待期）：dispose 竞态下
    // 等待中的请求也被 abort——恢复 settle 后复查 disposing/aborted，绝不发出
    // Workbench 调用；dispose 等待 recovery 与在途/等待中的请求共同 settle。
    actionSeq += 1
    const controller = new AbortController()
    const signalKey = `action:${String(actionSeq)}`
    deps.signals.set(signalKey, controller)
    try {
      return await deps.taskRegistry.runTracked(async () => {
        // G-2：业务 action 等待启动恢复 settle（route 注册不被阻塞）。
        await deps.startupReady
        if (deps.startupError !== null) {
          // runs.json 语义损坏：不得继续读写采集状态（文件保持原样，绝不改写）。
          throw new DouyinError(deps.startupError, 'startup run recovery failed')
        }
        if (deps.disposing || controller.signal.aborted) {
          throw new DouyinError('plugin_disposing', 'plugin is disposing')
        }
        return handler(args, controller.signal)
      })
    } finally {
      if (deps.signals.get(signalKey) === controller) deps.signals.delete(signalKey)
    }
  }
  const runnerDeps: RunnerDeps = {
    callTool: deps.callTool,
    root: deps.root,
    chromeFactory: deps.chromeFactory,
    maxPages: deps.maxPages,
    logger: { warn: message => { deps.logger.warn(message) } },
  }
  /** 远端调用 → {status:'ready', data: payload} 直通投影（signal 透传）。 */
  const passthrough = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<HandlerPayload> => {
    const outcome = await deps.callTool(tool, args, signal)
    const payload = outcome.structuredContent
    return { status: 'ready', data: payload && typeof payload === 'object' ? payload : {} }
  }

  const handlers: Record<string, ActionHandler> = {
    'browser.status': async () => {
      const status = await deps.browserStatusFn()
      return { status: 'ready', chromeAvailable: status.chromeAvailable, driverAvailable: status.driverAvailable, platform: status.platform, hint: status.hint }
    },

    'accounts.list': async (_args, signal) => {
      const local = await readAccounts(deps.root)
      let remote: Record<string, unknown>[] = []
      let remoteError: string | null = null
      try {
        const outcome = await deps.callTool('workbench_douyin_account_list', {}, signal)
        const payload = outcome.structuredContent
        remote = payload && typeof payload === 'object' && Array.isArray((payload as { accounts?: unknown }).accounts)
          ? (payload as { accounts: Record<string, unknown>[] }).accounts
          : []
      } catch (error) {
        remoteError = safeCode(error)
      }
      const projected = projectAccounts(Object.values(local.accounts), remote)
      return { status: 'ready', accounts: projected.accounts, remoteError }
    },

    'account.beginLogin': async args => {
      const requested = asString(args, 'accountId')
      const key = requested !== '' ? requested : `pending-${String(Date.now())}`
      const existing = deps.loginRuns.get(key)
      if (existing !== undefined && existing.status === 'waiting') {
        return { status: 'ready', login: projectLogin(existing) }
      }
      if (existing !== undefined) deps.loginRuns.delete(key)
      const run: LoginRun = { key, status: 'waiting', accountId: requested !== '' ? requested : null, error: null, saveError: null, startedAt: new Date().toISOString() }
      deps.loginRuns.set(key, run)
      const controller = new AbortController()
      deps.signals.set(`login:${key}`, controller)
      deps.taskRegistry.track(loginWithQrCode({
        accountId: requested,
        root: deps.root,
        signal: controller.signal,
        chromeFactory: deps.chromeFactory,
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      }).then(result => completeLoginAfterSuccess(deps, controller.signal, run, result))
        .catch((error: unknown) => {
          run.status = 'failed'
          run.error = safeCode(error)
        })
        .finally(() => {
          if (deps.signals.get(`login:${key}`) === controller) deps.signals.delete(`login:${key}`)
        }))
      return { status: 'ready', login: projectLogin(run) }
    },

    'account.loginStatus': async args => {
      const key = asString(args, 'accountId') || asString(args, 'loginKey')
      const run = deps.loginRuns.get(key)
      if (run === undefined) {
        return { status: 'ready', login: { loginKey: key, status: 'idle', accountId: key !== '' ? key : null, error: null, saveError: null } }
      }
      // 终态读取一次即清理（页面在首个非 waiting 轮询停止）。
      if (run.status !== 'waiting') deps.loginRuns.delete(run.key)
      return { status: 'ready', login: projectLogin(run) }
    },

    'account.probe': async (args, signal) => {
      const requested = asString(args, 'accountId')
      const resolved = await resolveAccountId(deps, id => controllers.collect.status(id) !== null && (controllers.collect.status(id)?.status === 'running'), requested, signal)
      const session = await withProfileLock(resolved.accountId, () =>
        refreshSessionState({ accountId: resolved.accountId, root: deps.root, chromeFactory: deps.chromeFactory, signal }))
      const report = await reportSessionStatus(runnerDeps, resolved.accountId, session, signal)
      return {
        status: 'ready',
        accountId: resolved.accountId,
        promoted: resolved.promoted,
        saveError: resolved.saveError,
        remoteCleanup: resolved.remoteCleanup,
        sessionStatus: session.sessionStatus,
        sessionCheckedAt: session.checkedAt,
        sessionSeq: session.sessionSeq,
        reported: report.ok,
        reportError: report.error,
      }
    },

    'account.removeLocal': async args => {
      const accountId = asString(args, 'accountId')
      // try 锁：collect/登录迁移持锁时立即 collect_busy，不排队等长采集。
      const attempt = await tryWithProfileLock(accountId, () => removeLocalAccount({ accountId, root: deps.root }))
      if (!attempt.acquired) return { status: 'error', reason: 'collect_busy' }
      const removed = attempt.result.removed
      // 清理 runs.json 中该账号全部 run 记录（排期数据不级联，runs 属设备端）。
      await removeAccountRuns(deps.root, accountId).catch(error => {
        deps.logger.warn(`douyin runs.json cleanup failed (${accountId})`, error)
      })
      if (!removed) return { status: 'error', reason: 'cleanup_failed', accountId }
      return { status: 'ready', accountId, localCleared: true }
    },

    'account.removeRemote': async (args, signal) => {
      const accountId = asString(args, 'accountId')
      const outcome = await deps.callTool('workbench_douyin_account_remove', {
        accountId,
        confirm: true,
        idempotencyKey: accountRemoveIdempotencyKey(accountId),
      }, signal)
      const payload = outcome.structuredContent
      const deleteState = payload && typeof payload === 'object' && typeof (payload as { deleteState?: unknown }).deleteState === 'string'
        ? (payload as { deleteState: string }).deleteState
        : 'remote_deleted'
      return { status: 'ready', accountId, deleteState }
    },

    'collect.start': async (args, requestSignal) => {
      const requested = asString(args, 'accountId')
      // 前置阶段（pending 提升的 account_save/account_remove）携带请求级
      // signal；每个 await 后复查——abort 返回稳定 collect_cancelled，不启动
      // 后台采集、不创建 collect: 信号。
      const resolved = await resolveAccountId(deps, () => controllers.collect.hasRunning() || controllers.batch.hasRunning(), requested, requestSignal)
      // abort 检查走函数边界（const 收窄不跨 await）。
      const reqAborted = (): boolean => requestSignal?.aborted === true
      if (reqAborted()) throw new DouyinError('collect_cancelled', 'collect.start aborted')
      // 就绪检查（storage_state 前置）。
      const usable = await hasStorageState(resolved.accountId, deps.root)
      if (reqAborted()) throw new DouyinError('collect_cancelled', 'collect.start aborted')
      if (!usable) return { status: 'error', reason: 'session_required' }
      const maxPages = typeof args.maxPages === 'number' ? args.maxPages : deps.maxPages
      // 后台采集使用 collect controller 信号（不消费请求级 signal——本 action
      // 启动后台任务后立即返回）；登记进 deps.signals 供 dispose abort，run
      // settle 后清理。
      const controller = new AbortController()
      const signalKey = `collect:${resolved.accountId}`
      deps.signals.set(signalKey, controller)
      const started = controllers.collect.start({
        accountId: resolved.accountId,
        options: { maxPages, signal: controller.signal },
      })
      if (!started.started) {
        if (deps.signals.get(signalKey) === controller) deps.signals.delete(signalKey)
        return { status: 'error', reason: started.reason ?? 'collect_busy' }
      }
      deps.taskRegistry.track(controllers.collect.wait(resolved.accountId).then(() => undefined, () => undefined).then(() => {
        if (deps.signals.get(signalKey) === controller) deps.signals.delete(signalKey)
      }))
      const record = controllers.collect.status(resolved.accountId)
      return {
        status: 'ready',
        collect: record,
        ...(resolved.promoted ? { promoted: true, saveError: resolved.saveError, remoteCleanup: resolved.remoteCleanup } : {}),
      }
    },

    'collect.status': async (args, signal) => {
      const alias = await resolveAccountAlias(asString(args, 'accountId'), deps.root)
      const record = controllers.collect.status(alias)
      // G-2：内存态丢失（重启）时给 runs.json 最近一条记录 + 恢复判定。
      if (record === null) {
        let runs: Record<string, RunRecord>
        try {
          runs = await readRuns(deps.root)
        } catch (error) {
          // 语义损坏（启动恢复后的新损坏/并发外写）：稳定拒绝，不改写文件。
          return { status: 'error', reason: safeCode(error) }
        }
        const last = Object.values(runs)
          .filter(run => run.accountId === alias)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
        if (last === undefined) return { status: 'ready', collect: null }
        if (last.status !== 'interrupted' && last.status !== 'running') {
          return { status: 'ready', collect: null, lastRun: last }
        }
        // interrupted / running-without-memory：无 runId 无法安全对账。
        if (last.runId === null || last.runId === '') {
          return { status: 'ready', collect: null, recovery: 'recovery_required', lastRun: last }
        }
        // 远端终态查询：终态 → 同步本地 runs.json；仍 running / 查询失败 →
        // recovery_required（不伪造本地 running）。
        try {
          const outcome = await deps.callTool('workbench_douyin_collect_run_get', { runId: last.runId }, signal)
          const payload = outcome.structuredContent && typeof outcome.structuredContent === 'object' ? outcome.structuredContent as Record<string, unknown> : {}
          const run = payload.run && typeof payload.run === 'object' ? payload.run as Record<string, unknown> : {}
          const remoteStatus = typeof run.status === 'string' ? run.status : null
          const terminal = remoteStatus !== null && remoteStatus !== 'running' && remoteStatus !== 'pending'
          if (!terminal) {
            return { status: 'ready', collect: null, recovery: 'recovery_required', lastRun: last, remoteStatus }
          }
          const synced: RunRecord['status'] = remoteStatus === 'completed' || remoteStatus === 'partial' || remoteStatus === 'failed' || remoteStatus === 'cancelled' || remoteStatus === 'interrupted'
            ? remoteStatus
            : 'failed'
          let updated: RunRecord = last
          try {
            updated = await updateRun(deps.root, last.accountId, last.attemptId, { status: synced, finishedAt: new Date().toISOString() })
          } catch (error) {
            deps.logger.warn(`douyin runs.json remote-terminal sync failed (${last.attemptId})`, error)
          }
          return { status: 'ready', collect: null, recovery: 'recovery_required', lastRun: updated, remoteStatus }
        } catch (error) {
          deps.logger.warn('douyin collect_run_get during recovery failed', error)
          return { status: 'ready', collect: null, recovery: 'recovery_required', lastRun: last }
        }
      }
      return { status: 'ready', collect: record }
    },

    // 挂载恢复（只读）：当前运行中的单账号采集（任意账号）+ 批量运行标记。
    'collect.running': async () => ({ status: 'ready', collect: controllers.collect.running(), batchRunning: controllers.batch.running }),

    'collectAll.start': async (_args, requestSignal) => {
      // 前置候选筛选携带请求级 signal（abort → collect_cancelled，不启动 batch）。
      const accounts = await batchCandidates(runnerDeps, requestSignal)
      // batch 正式启动前创建后台 controller（请求级 signal 随 handler 返回清理，
      // 后台归 dispose 管理；采集取消只经该信号）。
      const controller = new AbortController()
      const started = controllers.batch.start(accounts, { signal: controller.signal })
      if (!started.started) {
        const reason = started.reason ?? 'collect_busy'
        const payload: HandlerPayload = { status: 'error', reason: isStableCode(reason) ? reason : 'collect_busy' }
        if (started.skipped !== undefined) return { ...payload, skipped: started.skipped }
        return payload
      }
      const batchStatus = controllers.batch.status
      const batchKey = `collect:batch:${batchStatus.batchId ?? 'unknown'}`
      deps.signals.set(batchKey, controller)
      const runPromise = started.runPromise ?? Promise.resolve()
      deps.taskRegistry.track(runPromise.then(() => undefined).then(() => {
        if (deps.signals.get(batchKey) === controller) deps.signals.delete(batchKey)
      }))
      return { status: 'ready', batch: controllers.batch.status }
    },

    'collectAll.status': async () => ({ status: 'ready', batch: controllers.batch.status }),

    // ---- D3：作品 / 总览 / 导出 / 排期 ----

    'works.list': async (args, signal) => {
      const accountId = await resolveAccountAlias(asString(args, 'accountId'), deps.root)
      const outcome = await deps.callTool('workbench_douyin_work_list', {
        accountId,
        includeNotInList: args.includeNotInList === true,
      }, signal)
      const payload = outcome.structuredContent && typeof outcome.structuredContent === 'object' ? outcome.structuredContent as Record<string, unknown> : {}
      return {
        status: 'ready',
        accountId,
        works: Array.isArray(payload.works) ? payload.works : [],
        total: typeof payload.total === 'number' ? payload.total : 0,
      }
    },

    'work.get': async (args, signal) => passthrough('workbench_douyin_work_get', { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), workId: asString(args, 'workId') }, signal),
    'work.trend': async (args, signal) => passthrough('workbench_douyin_work_trend', { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), workId: asString(args, 'workId') }, signal),
    'run.get': async (args, signal) => passthrough('workbench_douyin_collect_run_get', { runId: asString(args, 'runId') }, signal),

    'export': async (args, signal) => callExport(deps, 'workbench_douyin_export', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      format: 'xlsx',
    }, { prefix: 'douyin-export', fallback: 'douyin-export.xlsx', ...(signal !== undefined ? { signal } : {}) }),

    'overview.get': async (args, signal) => {
      const toolArgs = definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'ownerName', 'sort', 'topN', 'hotType', 'cursor', 'limit', 'ruleVersion'])
      const outcome = await deps.callTool('workbench_douyin_account_overview', toolArgs, signal)
      return { status: 'ready', overview: outcome.structuredContent }
    },

    'hotWorks.list': async (args, signal) => {
      // 与 overview.get 同参面但无 ownerName（旧 hot_work_list DTO 不收负责人）。
      const toolArgs = definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'sort', 'topN', 'hotType', 'cursor', 'limit', 'ruleVersion'])
      const outcome = await deps.callTool('workbench_douyin_hot_work_list', toolArgs, signal)
      return { status: 'ready', hotWorks: outcome.structuredContent }
    },

    'overview.export': async (args, signal) => callExport(deps, 'workbench_douyin_overview_export', definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'ruleVersion']), {
      prefix: 'douyin-overview-',
      fallback: 'douyin-overview-export.xlsx',
      errorMap: { TOO_MANY_ACCOUNTS: 'overview_too_many_accounts' },
      ...(signal !== undefined ? { signal } : {}),
    }),

    'account.analysis': async (args, signal) => {
      const toolArgs = { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), ...definedArgs(args, ['publishFrom', 'publishTo', 'sort', 'ruleVersion']) }
      const outcome = await deps.callTool('workbench_douyin_account_analysis', toolArgs, signal)
      return { status: 'ready', analysis: outcome.structuredContent }
    },

    'account.trend': async (args, signal) => {
      const toolArgs: Record<string, unknown> = {
        accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
        metric: asString(args, 'metric') !== '' ? asString(args, 'metric') : 'play',
        ...definedArgs(args, ['fromDay', 'toDay', 'contractVersion']),
      }
      if (args.cohortDelta === true) toolArgs.cohortDelta = true
      const outcome = await deps.callTool('workbench_douyin_account_trend', toolArgs, signal)
      return { status: 'ready', trend: outcome.structuredContent }
    },

    'accountAnalysis.export': async (args, signal) => callExport(deps, 'workbench_douyin_account_analysis_export', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      ...definedArgs(args, ['publishFrom', 'publishTo', 'ruleVersion']),
    }, { prefix: 'douyin-account-analysis-', fallback: 'douyin-account-analysis-report.xlsx', ...(signal !== undefined ? { signal } : {}) }),

    'schedule.list': async (args, signal) => passthrough('workbench_douyin_publish_schedule_list', { accountId: asString(args, 'accountId') }, signal),

    'schedule.rowCreate': async (args, signal) => passthrough('workbench_douyin_publish_schedule_row_create', {
      accountId: asString(args, 'accountId'),
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    'schedule.rowUpdate': async (args, signal) => {
      // 缺失业务字段显式转 null、整行提交（route 层已剔空串与非法枚举）。
      const row = {
        accountId: asString(args, 'accountId'),
        rowId: args.rowId as number,
        expectedVersion: args.expectedVersion as number,
        shootingDate: typeof args.shootingDate === 'string' ? args.shootingDate : null,
        videoContent: typeof args.videoContent === 'string' ? args.videoContent : null,
        shootingStatus: args.shootingStatus === true,
        published: args.published === true,
        assetLink: typeof args.assetLink === 'string' ? args.assetLink : null,
        note: typeof args.note === 'string' ? args.note : null,
        publishDate: typeof args.publishDate === 'string' ? args.publishDate : null,
        publishPlatforms: Array.isArray(args.publishPlatforms) ? args.publishPlatforms : [],
        shootingOwner: typeof args.shootingOwner === 'string' ? args.shootingOwner : null,
        editingOwner: typeof args.editingOwner === 'string' ? args.editingOwner : null,
        confirm: true,
        idempotencyKey: asString(args, 'idempotencyKey'),
      }
      return passthrough('workbench_douyin_publish_schedule_row_update', row, signal)
    },

    'schedule.rowDelete': async (args, signal) => passthrough('workbench_douyin_publish_schedule_row_delete', {
      accountId: asString(args, 'accountId'),
      rowId: args.rowId as number,
      expectedVersion: args.expectedVersion as number,
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    // ---- D4：AI 分析与报表 ----

    'aiAnalysis.start': async (args, signal) => passthrough('workbench_douyin_account_ai_analysis_start', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    'aiAnalysis.get': async (args, signal) => {
      // 展平单层投影：aiStatus 是运行态，analysis=null 表示从未分析。
      const outcome = await deps.callTool('workbench_douyin_account_ai_analysis_get', {
        accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      }, signal)
      const payload = outcome.structuredContent && typeof outcome.structuredContent === 'object' ? outcome.structuredContent as Record<string, unknown> : {}
      return { status: 'ready', aiStatus: payload.status ?? null, analysis: payload.analysis ?? null }
    },

    'report.list': async (args, signal) => passthrough('workbench_douyin_report_list', definedArgs(args, ['reportType', 'periodStart', 'status', 'limit', 'cursor', 'allVersions']), signal),
    'report.get': async (args, signal) => passthrough('workbench_douyin_report_get', { reportId: asString(args, 'reportId') }, signal),
    'report.regenerate': async (args, signal) => passthrough('workbench_douyin_report_regenerate', {
      reportId: asString(args, 'reportId'),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    // ---- D5：负责人与投流 ----

    'account.owner.set': async (args, signal) => passthrough('workbench_douyin_account_owner_set', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      ownerName: asString(args, 'ownerName'),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    'work.promotion.save': async (args, signal) => {
      const payload: Record<string, unknown> = {
        accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
        workId: asString(args, 'workId'),
        playCount: args.playCount as number,
        fansCount: args.fansCount as number,
        costAmount: asString(args, 'costAmount'),
        durationHours: asString(args, 'durationHours'),
        idempotencyKey: asString(args, 'idempotencyKey'),
      }
      // recordId 仅显式携带（stale-add 恢复路径由页面重拉后带 recordId 转更新）。
      if (typeof args.recordId === 'number') payload.recordId = args.recordId
      return passthrough('workbench_douyin_work_promotion_save', payload, signal)
    },

    // ---- D6：爆款拆解（viral 域 10 action） ----

    'breakdown.rewriteRules': async (_args, signal) => {
      const outcome = await deps.callTool('workbench_viral_rewrite_rules_list', {}, signal)
      const payload = outcome.structuredContent
      // items 只含 rewriteRuleId/name/description：prompt 正文留在服务端配置，不下发。
      const items = payload !== null && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
        ? (payload as { items: Record<string, unknown>[] }).items
        : []
      return { status: 'ready', rules: items, total: items.length }
    },

    // 服务端从幂等键摘要派生 runId：同键重放返回同一 run 回执，不重复下载/入库。
    'breakdown.archiveStart': async (args, signal) => {
      const outcome = await deps.callTool('workbench_viral_archive_submit', {
        douyinVideoUrl: asString(args, 'shareUrl'),
        confirm: true,
        idempotencyKey: asString(args, 'idempotencyKey'),
      }, signal)
      return { status: 'ready', archive: outcome.structuredContent }
    },

    'breakdown.archiveStatus': async (args, signal) => {
      const outcome = await deps.callTool('workbench_viral_async_submit_get', { runId: asString(args, 'runId') }, signal)
      return { status: 'ready', archive: outcome.structuredContent }
    },

    'breakdown.downloadStart': async (args, signal) => {
      const outcome = await deps.callTool('workbench_viral_douyin_download_url_start', {
        douyinVideoUrl: asString(args, 'shareUrl'),
        idempotencyKey: asString(args, 'idempotencyKey'),
      }, signal)
      return { status: 'ready', download: outcome.structuredContent }
    },

    'breakdown.downloadStatus': async (args, signal) => {
      const outcome = await deps.callTool('workbench_viral_douyin_download_url_get', { jobId: asString(args, 'jobId') }, signal)
      return { status: 'ready', download: outcome.structuredContent }
    },

    'breakdown.workflowStart': async (args, signal) => {
      // 规则单选可选：不传 = 默认改写链路；force 仅显式 true 透传（失败终态强制
      // 重试，服务端重置可恢复失败并重新投递）。
      const toolArgs: Record<string, unknown> = {
        candidateId: asString(args, 'candidateId'),
        idempotencyKey: asString(args, 'idempotencyKey'),
        confirm: true,
      }
      if (typeof args.rewriteRuleId === 'string' && args.rewriteRuleId !== '') toolArgs.rewriteRuleId = args.rewriteRuleId
      if (args.force === true) toolArgs.force = true
      const outcome = await deps.callTool('workbench_viral_workflow_start', toolArgs, signal)
      return { status: 'ready', workflow: outcome.structuredContent }
    },

    'breakdown.workflowStatus': async (args, signal) => {
      // 优先 workflowId 精确查询（同候选可并存多条工作流；candidateId「最新一条」
      // 不保证是本次受理目标）。
      const toolArgs: Record<string, unknown> = {}
      if (typeof args.workflowId === 'string' && args.workflowId !== '') toolArgs.workflowId = args.workflowId
      else if (typeof args.candidateId === 'string' && args.candidateId !== '') toolArgs.candidateId = args.candidateId
      if (typeof args.limit === 'number') toolArgs.limit = args.limit
      const outcome = await deps.callTool('workbench_viral_workflow_get', toolArgs, signal)
      const projected = projectWorkflowItems(outcome.structuredContent)
      return { status: 'ready', workflows: projected.items, total: projected.total }
    },

    'breakdown.detail': async (args, signal) => {
      const candidateId = asString(args, 'candidateId')
      // 三源独立降级：storyboards 是详情主体（失败即整单失败，不渲染假详情）；
      // analysis 步骤状态与候选公开指标是辅助源，失败单独透出稳定码。
      let storyboards: Record<string, unknown>[]
      try {
        const outcome = await deps.callTool('workbench_viral_storyboards_list', { candidateId, limit: 20 }, signal)
        const payload = outcome.structuredContent
        storyboards = payload !== null && typeof payload === 'object' && Array.isArray((payload as { items?: unknown }).items)
          ? (payload as { items: Record<string, unknown>[] }).items
          : []
      } catch (error) {
        throw new DouyinError(safeCode(error), 'storyboards_list failed')
      }
      let analysis: unknown = null
      let analysisError: string | null = null
      try {
        const outcome = await deps.callTool('workbench_viral_analysis_status_get', { candidateId }, signal)
        analysis = outcome.structuredContent
      } catch (error) {
        analysisError = safeCode(error)
      }
      let candidate: Record<string, unknown> | null = null
      let candidateError: string | null = null
      try {
        const outcome = await deps.callTool('workbench_viral_candidates_list', { candidateId, limit: 1 }, signal)
        const payload = outcome.structuredContent
        candidate = payload !== null && typeof payload === 'object' && Array.isArray((payload as { candidates?: unknown }).candidates)
          ? ((payload as { candidates: Record<string, unknown>[] }).candidates[0] ?? null)
          : null
      } catch (error) {
        candidateError = safeCode(error)
      }
      return { status: 'ready', storyboards, analysis, analysisError, candidate, candidateError }
    },

    'breakdown.export': async (args, signal) => callExport(deps, 'workbench_viral_storyboard_export', {
      candidateId: asString(args, 'candidateId'),
    }, {
      prefix: 'douyin-storyboard-',
      fallback: 'douyin-storyboard-export.xlsx',
      // 服务端码原样透出（UI 有专属文案：候选不存在 / 故事板未就绪）。
      errorMap: { CANDIDATE_NOT_FOUND: 'CANDIDATE_NOT_FOUND', STORYBOARD_NOT_READY: 'STORYBOARD_NOT_READY' },
      ...(signal !== undefined ? { signal } : {}),
    }),

    // 上限 200 与「加载更多」一致：服务端无游标，翻页只能 limit 递增全量拉；
    // hasStoryboard 用 status=succeeded 保守判定（双成功后置位，标 true 必有内容）。
    'breakdown.history': async (args, signal) => {
      const outcome = await deps.callTool('workbench_viral_workflow_get', {
        limit: typeof args.limit === 'number' ? args.limit : 10,
      }, signal)
      const projected = projectWorkflowItems(outcome.structuredContent)
      const history = projected.items.map(item => ({ ...item, hasStoryboard: item.status === 'succeeded' }))
      return { status: 'ready', history, total: projected.total }
    },

    // ---- D7：爆款素材看板（viral 域 8 action） ----

    'material.seeds.list': async (_args, signal) => passthrough('workbench_viral_seeds_list', {}, signal),

    // seed upsert 逐项 schema（route 层已校验 per-item 字段/枚举/范围）；
    // 未提交字段保留服务端原值（显式提交语义）。
    'material.keyword.upsert': async (args, signal) => passthrough('workbench_viral_keyword_seeds_upsert', {
      keywords: args.keywords,
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    'material.account.upsert': async (args, signal) => passthrough('workbench_viral_account_seeds_upsert', {
      accounts: args.accounts,
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    // 手动采集是远端异步任务（非本地 Chrome）：只受理，页面轮询 collect.status。
    'material.collect.start': async (args, signal) => passthrough('workbench_viral_seed_search_submit', definedArgs(args, ['idempotencyKey', 'keywordLimit', 'accountLimit', 'priorities', 'candidateMinLevel']), signal),

    'material.collect.status': async (args, signal) => passthrough('workbench_viral_async_submit_get', {
      runId: asString(args, 'runId'),
    }, signal),

    'material.videos.list': async (args, signal) => {
      // 固定素材域语义：scope 恒为 'material'（route schema 只放行该值；缺省同样固定）。
      const toolArgs: Record<string, unknown> = {
        scope: 'material',
        sortBy: typeof args.sortBy === 'string' && args.sortBy !== '' ? args.sortBy : 'hot',
        limit: typeof args.limit === 'number' ? args.limit : 200,
        ...definedArgs(args, ['taskId', 'runId', 'minLevel', 'sourceType', 'candidateId', 'awemeId', 'storyboardStatus', 'q', 'sourceKeyword', 'accountSeedId', 'publishedFrom', 'publishedTo', 'tag', 'sourceKind']),
      }
      if (typeof args.offset === 'number') toolArgs.offset = args.offset
      return passthrough('workbench_viral_candidates_list', toolArgs, signal)
    },

    'material.runs.list': async (args, signal) => {
      const toolArgs: Record<string, unknown> = { limit: typeof args.limit === 'number' ? args.limit : 20 }
      if (typeof args.offset === 'number') toolArgs.offset = args.offset
      return passthrough('workbench_viral_runs_list', toolArgs, signal)
    },

    // 窄投影：dashboard_get 的 materialFacets.tags（天然限定素材域，不随 taskId 收窄）。
    'material.facets': async (_args, signal) => {
      const outcome = await deps.callTool('workbench_viral_dashboard_get', {}, signal)
      const payload = outcome.structuredContent
      const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
      const facets = record.materialFacets !== null && typeof record.materialFacets === 'object' && !Array.isArray(record.materialFacets)
        ? record.materialFacets as Record<string, unknown>
        : {}
      const tags = Array.isArray(facets.tags) ? facets.tags : []
      return { status: 'ready', tags }
    },

    // ---- D8：爆款基因库（viral 域 5 action） ----

    'gene.search': async (args, signal) => passthrough('workbench_viral_knowledge_search', definedArgs(args, ['query', 'category', 'geneTags', 'adoptionStatus', 'offset', 'limit']), signal),

    'gene.get': async (args, signal) => passthrough('workbench_viral_knowledge_get', {
      recordId: asString(args, 'recordId'),
    }, signal),

    // update 是同步幂等写：geneTags 空对象 = 整体清空全部标签；幂等键绑定 recordId
    // （route 层模板校验）。失败原样投影，Host 不自动重试、不换键。
    'gene.update': async (args, signal) => passthrough('workbench_viral_knowledge_update', definedArgs(args, ['recordId', 'idempotencyKey', 'geneTags', 'manualNotes', 'adoptionStatus']), signal),

    // regenerate 是模型/异步能力（可能产生费用）：幂等键绑定 recordId，同键重试。
    'gene.regenerate': async (args, signal) => passthrough('workbench_viral_knowledge_regenerate', {
      recordId: asString(args, 'recordId'),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }, signal),

    'gene.list': async (args, signal) => passthrough('workbench_viral_knowledge_list', definedArgs(args, ['geneStatus', 'offset', 'limit']), signal),
  }

  const guarded: Record<string, ActionHandler> = {}
  for (const [action, handler] of Object.entries(handlers)) {
    guarded[action] = guard(handler)
  }
  return guarded
}

export type { BatchStatus, CollectResult, RunRecord }
