/**
 * Host action 实现（依赖注入面 + 处理器表；分批扩充）。D2 批：browser.status /
 * accounts.list / 登录三态 / probe（含 pending 提升）/ 删除两步 / 采集单账号与
 * 批量（互斥 collect_busy、runs.json G-2 恢复投影）。登录/采集均为进程内
 * AbortController 生命周期（dispose 统一 abort + 等待 settle）；Workbench 调用
 * 经 douyin-workbench caller；稳定错误码收敛不透传原文。
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
  /** 启动恢复（G-2）：running→interrupted 标记；业务 action 在它 settle 前等待。 */
  startupReady: Promise<void>
  /** 启动恢复失败（runs.json 语义损坏）的稳定码；非 null 时业务 action 拒绝。 */
  startupError: StableErrorCode | null
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
  taskRegistry?: TaskRegistry
  recovery?: StartupRecovery
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
    startupError: null,
    startupReady: Promise.resolve(),
  }
  // G-2 启动恢复：立即启动（不阻塞 route 注册），完成前业务 action 等待。
  const run = (options.recovery ?? recoverInterruptedRuns)(options.root)
  deps.startupReady = run.then(() => undefined, (error: unknown) => {
    deps.startupError = safeCode(error)
    deps.logger.warn('douyin startup run recovery failed', error)
  })
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
export async function resolveAccountId(deps: DouyinHandlerDeps, collectHasRunning: (accountId: string) => boolean, accountId: string): Promise<ResolveAccountOutcome> {
  if (!isPendingAccountId(accountId)) return { accountId, promoted: false, saveError: null, remoteCleanup: null }
  if (collectHasRunning(accountId)) return { accountId, promoted: false, saveError: null, remoteCleanup: null }
  const promoted = await promotePendingAccount({ accountId, root: deps.root, chromeFactory: deps.chromeFactory })
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
    await deps.callTool('workbench_douyin_account_save', payload)
  } catch (error) {
    saveError = safeCode(error)
  }
  let remoteCleanup = 'removed'
  try {
    await deps.callTool('workbench_douyin_account_remove', {
      accountId,
      confirm: true,
      idempotencyKey: accountRemoveIdempotencyKey(accountId),
    })
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
}): Promise<HandlerPayload> {
  let payload: Record<string, unknown>
  try {
    const outcome = await deps.callTool(tool, args)
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
  const projected: HandlerPayload = {
    status: 'ready',
    file_name: fileName,
    mime_type: typeof payload.mime_type === 'string' && payload.mime_type !== '' ? payload.mime_type : XLSX_MIME,
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

/** D2–D5 全量 action 处理器表（33 项全量；D6–D8 缺席即 unknown_action）。 */
export function buildDouyinHandlers(deps: DouyinHandlerDeps, controllers: {
  collect: ReturnType<typeof createCollectController>
  batch: ReturnType<typeof createBatchCollectController>
}): Record<string, ActionHandler> {
  const asString = (args: ActionArgs, key: string): string => typeof args[key] === 'string' ? args[key] as string : ''
  const guard = (handler: ActionHandler): ActionHandler => async (args: ActionArgs) => {
    if (deps.disposing) throw new DouyinError('plugin_disposing', 'plugin is disposing')
    // G-2：业务 action 等待启动恢复 settle（route 注册不被阻塞；recovery 期间
    // 任何 collect.start 都进不了控制器，无竞态）。
    await deps.startupReady
    if (deps.startupError !== null) {
      // runs.json 语义损坏：不得继续读写采集状态（文件保持原样，绝不改写）。
      throw new DouyinError(deps.startupError, 'startup run recovery failed')
    }
    return deps.taskRegistry.runTracked(() => handler(args))
  }
  const runnerDeps: RunnerDeps = {
    callTool: deps.callTool,
    root: deps.root,
    chromeFactory: deps.chromeFactory,
    maxPages: deps.maxPages,
    logger: { warn: message => { deps.logger.warn(message) } },
  }
  /** 远端调用 → {status:'ready', data: payload} 直通投影。 */
  const passthrough = async (tool: string, args: Record<string, unknown>): Promise<HandlerPayload> => {
    const outcome = await deps.callTool(tool, args)
    const payload = outcome.structuredContent
    return { status: 'ready', data: payload && typeof payload === 'object' ? payload : {} }
  }

  const handlers: Record<string, ActionHandler> = {
    'browser.status': async () => {
      const status = await deps.browserStatusFn()
      return { status: 'ready', chromeAvailable: status.chromeAvailable, driverAvailable: status.driverAvailable, platform: status.platform, hint: status.hint }
    },

    'accounts.list': async () => {
      const local = await readAccounts(deps.root)
      let remote: Record<string, unknown>[] = []
      let remoteError: string | null = null
      try {
        const outcome = await deps.callTool('workbench_douyin_account_list', {})
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
      }).then(async result => {
        if (result.status === 'ok') {
          run.accountId = result.accountId
          // 顺序冻结：先 account_save（saveError 透出），再翻 ok（页面在首个
          // 非 waiting 轮询即停止，先翻 ok 会让 saveError 永远丢失）。
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
            await deps.callTool('workbench_douyin_account_save', payload)
            run.saveError = null
          } catch (error) {
            run.saveError = safeCode(error)
            deps.logger.warn('douyin account_save after login failed', error)
          }
          run.status = 'ok'
          // 登录成功后的会话上报（新 seq；失败不影响 run 终态）。
          try {
            const state = await refreshSessionState({ accountId: result.accountId, root: deps.root, chromeFactory: deps.chromeFactory })
            const report = await reportSessionStatus(runnerDeps, result.accountId, state)
            if (!report.ok) deps.logger.warn(`douyin session report after login failed: ${report.error ?? ''}`)
          } catch (error) {
            deps.logger.warn('douyin session report after login failed', error)
          }
        } else if (result.status === 'timeout') {
          run.status = 'timeout'
          run.error = 'login_timeout'
        } else {
          run.status = 'failed'
          run.error = result.reason
        }
      }).catch((error: unknown) => {
        run.status = 'failed'
        run.error = safeCode(error)
      }).finally(() => {
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

    'account.probe': async args => {
      const requested = asString(args, 'accountId')
      const resolved = await resolveAccountId(deps, id => controllers.collect.status(id) !== null && (controllers.collect.status(id)?.status === 'running'), requested)
      const session = await withProfileLock(resolved.accountId, () =>
        refreshSessionState({ accountId: resolved.accountId, root: deps.root, chromeFactory: deps.chromeFactory }))
      const report = await reportSessionStatus(runnerDeps, resolved.accountId, session)
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

    'account.removeRemote': async args => {
      const accountId = asString(args, 'accountId')
      const outcome = await deps.callTool('workbench_douyin_account_remove', {
        accountId,
        confirm: true,
        idempotencyKey: accountRemoveIdempotencyKey(accountId),
      })
      const payload = outcome.structuredContent
      const deleteState = payload && typeof payload === 'object' && typeof (payload as { deleteState?: unknown }).deleteState === 'string'
        ? (payload as { deleteState: string }).deleteState
        : 'remote_deleted'
      return { status: 'ready', accountId, deleteState }
    },

    'collect.start': async args => {
      const requested = asString(args, 'accountId')
      const resolved = await resolveAccountId(deps, () => controllers.collect.hasRunning() || controllers.batch.hasRunning(), requested)
      // 就绪检查（storage_state 前置）。
      const usable = await hasStorageState(resolved.accountId, deps.root)
      if (!usable) return { status: 'error', reason: 'session_required' }
      const maxPages = typeof args.maxPages === 'number' ? args.maxPages : deps.maxPages
      const started = controllers.collect.start({
        accountId: resolved.accountId,
        options: { maxPages },
      })
      if (!started.started) {
        return { status: 'error', reason: started.reason ?? 'collect_busy' }
      }
      const record = controllers.collect.status(resolved.accountId)
      return {
        status: 'ready',
        collect: record,
        ...(resolved.promoted ? { promoted: true, saveError: resolved.saveError, remoteCleanup: resolved.remoteCleanup } : {}),
      }
    },

    'collect.status': async args => {
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
          const outcome = await deps.callTool('workbench_douyin_collect_run_get', { runId: last.runId })
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

    'collectAll.start': async () => {
      const accounts = await batchCandidates(runnerDeps)
      const started = controllers.batch.start(accounts)
      if (!started.started) {
        const reason = started.reason ?? 'collect_busy'
        const payload: HandlerPayload = { status: 'error', reason: isStableCode(reason) ? reason : 'collect_busy' }
        if (started.skipped !== undefined) return { ...payload, skipped: started.skipped }
        return payload
      }
      return { status: 'ready', batch: controllers.batch.status }
    },

    'collectAll.status': async () => ({ status: 'ready', batch: controllers.batch.status }),

    // ---- D3：作品 / 总览 / 导出 / 排期 ----

    'works.list': async args => {
      const accountId = await resolveAccountAlias(asString(args, 'accountId'), deps.root)
      const outcome = await deps.callTool('workbench_douyin_work_list', {
        accountId,
        includeNotInList: args.includeNotInList === true,
      })
      const payload = outcome.structuredContent && typeof outcome.structuredContent === 'object' ? outcome.structuredContent as Record<string, unknown> : {}
      return {
        status: 'ready',
        accountId,
        works: Array.isArray(payload.works) ? payload.works : [],
        total: typeof payload.total === 'number' ? payload.total : 0,
      }
    },

    'work.get': async args => passthrough('workbench_douyin_work_get', { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), workId: asString(args, 'workId') }),
    'work.trend': async args => passthrough('workbench_douyin_work_trend', { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), workId: asString(args, 'workId') }),
    'run.get': async args => passthrough('workbench_douyin_collect_run_get', { runId: asString(args, 'runId') }),

    'export': async args => callExport(deps, 'workbench_douyin_export', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      format: 'xlsx',
    }, { prefix: 'douyin-export', fallback: 'douyin-export.xlsx' }),

    'overview.get': async args => {
      const toolArgs = definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'ownerName', 'sort', 'topN', 'hotType', 'cursor', 'limit', 'ruleVersion'])
      const outcome = await deps.callTool('workbench_douyin_account_overview', toolArgs)
      return { status: 'ready', overview: outcome.structuredContent }
    },

    'hotWorks.list': async args => {
      // 与 overview.get 同参面但无 ownerName（旧 hot_work_list DTO 不收负责人）。
      const toolArgs = definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'sort', 'topN', 'hotType', 'cursor', 'limit', 'ruleVersion'])
      const outcome = await deps.callTool('workbench_douyin_hot_work_list', toolArgs)
      return { status: 'ready', hotWorks: outcome.structuredContent }
    },

    'overview.export': async args => callExport(deps, 'workbench_douyin_overview_export', definedArgs(args, ['accountIds', 'publishFrom', 'publishTo', 'ruleVersion']), {
      prefix: 'douyin-overview-',
      fallback: 'douyin-overview-export.xlsx',
      errorMap: { TOO_MANY_ACCOUNTS: 'overview_too_many_accounts' },
    }),

    'account.analysis': async args => {
      const toolArgs = { accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root), ...definedArgs(args, ['publishFrom', 'publishTo', 'sort', 'ruleVersion']) }
      const outcome = await deps.callTool('workbench_douyin_account_analysis', toolArgs)
      return { status: 'ready', analysis: outcome.structuredContent }
    },

    'account.trend': async args => {
      const toolArgs: Record<string, unknown> = {
        accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
        metric: asString(args, 'metric') !== '' ? asString(args, 'metric') : 'play',
        ...definedArgs(args, ['fromDay', 'toDay', 'contractVersion']),
      }
      if (args.cohortDelta === true) toolArgs.cohortDelta = true
      const outcome = await deps.callTool('workbench_douyin_account_trend', toolArgs)
      return { status: 'ready', trend: outcome.structuredContent }
    },

    'accountAnalysis.export': async args => callExport(deps, 'workbench_douyin_account_analysis_export', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      ...definedArgs(args, ['publishFrom', 'publishTo', 'ruleVersion']),
    }, { prefix: 'douyin-account-analysis-', fallback: 'douyin-account-analysis-report.xlsx' }),

    'schedule.list': async args => passthrough('workbench_douyin_publish_schedule_list', { accountId: asString(args, 'accountId') }),

    'schedule.rowCreate': async args => passthrough('workbench_douyin_publish_schedule_row_create', {
      accountId: asString(args, 'accountId'),
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }),

    'schedule.rowUpdate': async args => {
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
      return passthrough('workbench_douyin_publish_schedule_row_update', row)
    },

    'schedule.rowDelete': async args => passthrough('workbench_douyin_publish_schedule_row_delete', {
      accountId: asString(args, 'accountId'),
      rowId: args.rowId as number,
      expectedVersion: args.expectedVersion as number,
      confirm: true,
      idempotencyKey: asString(args, 'idempotencyKey'),
    }),

    // ---- D4：AI 分析与报表 ----

    'aiAnalysis.start': async args => passthrough('workbench_douyin_account_ai_analysis_start', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }),

    'aiAnalysis.get': async args => {
      // 展平单层投影：aiStatus 是运行态，analysis=null 表示从未分析。
      const outcome = await deps.callTool('workbench_douyin_account_ai_analysis_get', {
        accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      })
      const payload = outcome.structuredContent && typeof outcome.structuredContent === 'object' ? outcome.structuredContent as Record<string, unknown> : {}
      return { status: 'ready', aiStatus: payload.status ?? null, analysis: payload.analysis ?? null }
    },

    'report.list': async args => passthrough('workbench_douyin_report_list', definedArgs(args, ['reportType', 'periodStart', 'status', 'limit', 'cursor', 'allVersions'])),
    'report.get': async args => passthrough('workbench_douyin_report_get', { reportId: asString(args, 'reportId') }),
    'report.regenerate': async args => passthrough('workbench_douyin_report_regenerate', {
      reportId: asString(args, 'reportId'),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }),

    // ---- D5：负责人与投流 ----

    'account.owner.set': async args => passthrough('workbench_douyin_account_owner_set', {
      accountId: await resolveAccountAlias(asString(args, 'accountId'), deps.root),
      ownerName: asString(args, 'ownerName'),
      idempotencyKey: asString(args, 'idempotencyKey'),
    }),

    'work.promotion.save': async args => {
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
      return passthrough('workbench_douyin_work_promotion_save', payload)
    },
  }

  const guarded: Record<string, ActionHandler> = {}
  for (const [action, handler] of Object.entries(handlers)) {
    guarded[action] = guard(handler)
  }
  return guarded
}

export type { BatchStatus, CollectResult, RunRecord }
