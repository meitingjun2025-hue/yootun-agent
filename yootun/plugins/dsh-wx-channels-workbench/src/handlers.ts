/**
 * 19+4 项 action 的 Host 实现（依赖注入面 + 处理器表）。登录/采集/批量均为
 * 进程内 AbortController 生命周期（dispose 统一 abort + 等待 settle）；
 * 单账号采集按账号控制器维护（同账号单飞、账号间并发），与批量互斥经
 * `batchHasRunning` 钩子 + batchReserved 同步预留守卫。所有 Workbench 调用经
 * `ctx.yootunWorkbench.callTool`。
 * @module
 */
import type { BrowserStatus } from './chrome.ts'
import { DEFAULT_BROWSER_CLOSE_TIMEOUT_MS, DEFAULT_LAUNCH_TIMEOUT_MS } from './chrome.ts'
import { safeCode, WxError } from './errors.ts'
import {
  accountRemoveIdempotencyKey, accountSaveIdempotencyKey, sessionIdempotencyKey,
} from './idempotency.ts'
import { isPendingAccountId, loginWithQrCode, removeLocalAccount, type ChromeFactory } from './session.ts'
import { createProfileLocks, type ProfileLocks } from '@yootun/dsh-workbench-host-kit'
import { DEFAULT_DISPOSE_BUDGET_MS, createTaskRegistry, type TaskRegistry } from './lifecycle.ts'
import { hasStorageState, readAccounts, getAccount, paths } from './state.ts'
import { checkCollectionReadiness, type CollectController } from './runner.ts'
import { readRuns, removeAccountRuns, type RunRecord } from './runs.ts'
import type { BatchStatus } from './collect-all.ts'
import type { WxWorkbenchFace } from './ingest.ts'
import type { ActionArgs, ActionHandler, HandlerPayload } from './route.ts'

/** 登录进行中状态集合（只有进行中的登录才复用；终态必须允许重新发起）。 */
const ACTIVE_LOGIN_STATES = new Set(['waiting_qr', 'waiting_confirm'])
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const LOGIN_RECORD_TTL_MS = 30 * 60 * 1000

interface LoginRun {
  state: 'waiting_qr' | 'waiting_confirm' | 'ok' | 'timeout' | 'failed'
  accountId: string | null
  profile: { nickname: string | null; avatar: string | null; feedsCount: number | null } | null
  startedAt: string
  updatedAt: string | null
  reason: string | null
  attemptId: number
  controller: AbortController
}

/** Host 依赖注入面（测试可整体替换）。 */
export interface WxHostDeps {
  root: string
  workbench: WxWorkbenchFace
  browserStatusFn: () => Promise<BrowserStatus>
  logger: { warn(message: string): void }
  /** Chrome launcher seam（测试注入；undefined = launchChrome 真实实现）。 */
  chromeFactory: ChromeFactory | undefined
  /** 任务登记表：登录/采集/probe/promote/写盘等后台 promise 统一登记，dispose 等待。 */
  taskRegistry: TaskRegistry
  /** 账号 profile 锁实例（随 deps 创建；经 options / controller deps 透传）。 */
  locks: ProfileLocks
  /** dispose 开始后 route handler 稳定拒绝新 action（稳定码 plugin_disposing）。 */
  disposing: boolean
  /** 卸载预算毫秒（Config.disposeBudgetMs 透传；dispose 收口用）。 */
  disposeBudgetMs: number
  /** context.close 的等待预算毫秒（Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs: number
  /** Chrome 启动预算毫秒（Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs: number
  loginRuns: Map<string, LoginRun>
  collectLeaseHeld: boolean
  batchReserved: boolean
  collectSignals: Map<string, AbortController>
  loginSignals: Map<string, AbortController>
  batchSignal: AbortController | undefined
  setBatch(batch: unknown): void
  onDispose: ((abortAll: () => void, settle: Promise<void>) => void) | undefined
}

export function createWxHostDeps(options: {
  root: string
  workbench: WxWorkbenchFace
  browserStatusFn: () => Promise<BrowserStatus>
  logger: { warn(message: string): void }
  chromeFactory?: ChromeFactory
  taskRegistry?: TaskRegistry
  /** 卸载预算毫秒（缺省 20000；Config.disposeBudgetMs 透传）。 */
  disposeBudgetMs?: number
  /** 关闭预算毫秒（缺省 8000；Config.browserCloseTimeoutMs 透传）。 */
  browserCloseTimeoutMs?: number
  /** 启动预算毫秒（缺省 60000；Config.launchTimeoutMs 透传）。 */
  launchTimeoutMs?: number
}): WxHostDeps {
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
    loginRuns: new Map(),
    collectLeaseHeld: false,
    batchReserved: false,
    collectSignals: new Map(),
    loginSignals: new Map(),
    batchSignal: undefined,
    setBatch: () => undefined,
    onDispose: undefined,
  }
}

async function callWx(deps: WxHostDeps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await deps.workbench.callTool('wx-workbench', 'wx', name, args)
  const payload = outcome.structuredContent
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function compat(deps: WxHostDeps, name: string, args: Record<string, unknown>): Promise<HandlerPayload> {
  return callWx(deps, name, args)
    .then((result): HandlerPayload => ({ status: 'ok', ...result }))
    .catch((error: unknown): HandlerPayload => ({ status: 'error', reason: safeCode(error) }))
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function filterUndefined(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && value !== '') result[key] = value
  }
  return result
}

export function buildRouteHandlers(deps: WxHostDeps, batch: {
  readonly status: BatchStatus
  readonly running: boolean
  start(accountIds: string[]): Promise<{ started: boolean; reason?: string; batchId?: string; accounts?: number }>
  stop(): void
}, collect: CollectController): Record<string, ActionHandler> {
  const asString = (args: ActionArgs, key: string): string => (typeof args[key] === 'string' ? args[key] as string : '')
  const asInteger = (args: ActionArgs, key: string): number | undefined => (typeof args[key] === 'number' ? args[key] as number : undefined)

  const workbenchActions: Record<string, (args: ActionArgs) => [string, Record<string, unknown>]> = {
    'works.list': args => ['workbench_wx_work_list', filterUndefined({
      accountId: asString(args, 'accountId'),
      sort: asString(args, 'sort'),
      order: asString(args, 'order'),
      publishedFrom: asString(args, 'publishedFrom'),
      publishedTo: asString(args, 'publishedTo'),
      limit: asInteger(args, 'limit'),
      offset: asInteger(args, 'offset'),
    })],
    'work.get': args => ['workbench_wx_work_get', { accountId: asString(args, 'accountId'), workId: asString(args, 'workId') }],
    'work.trend': args => ['workbench_wx_work_trend', { accountId: asString(args, 'accountId'), workId: asString(args, 'workId') }],
    'account.overview': args => ['workbench_wx_account_overview', filterUndefined({ accountId: asString(args, 'accountId'), window: asString(args, 'window') })],
    'fans.profile.get': args => ['workbench_wx_fans_profile_get', { accountId: asString(args, 'accountId') }],
    // 多账号汇总：accountIds 仅在显式选账号时下传；fromDay/toDay 仅在 custom 窗口
    // 下透传（非 custom 携带日期由服务端 DTO validator 拒绝，Host 侧先过滤）。
    'overview.accounts': args => ['workbench_wx_accounts_overview', {
      ...(asString(args, 'accountId') !== '' ? { accountIds: [asString(args, 'accountId')] } : {}),
      window: asString(args, 'window'),
      ...(asString(args, 'fromDay') !== '' && asString(args, 'window') === 'custom' ? { fromDay: asString(args, 'fromDay') } : {}),
      ...(asString(args, 'toDay') !== '' && asString(args, 'window') === 'custom' ? { toDay: asString(args, 'toDay') } : {}),
      // sort 缺省交给 tools（空串透传会被 Literal 拒绝为 VALIDATION_ERROR）。
      ...(asString(args, 'sort') !== '' ? { sort: asString(args, 'sort') } : {}),
      ...(asString(args, 'sessionStatus') !== '' ? { sessionStatus: asString(args, 'sessionStatus') } : {}),
    }],
    'run.get': args => ['workbench_wx_collect_run_get', { runId: asString(args, 'runId') }],
  }
  const runPassthrough = async (action: string, args: ActionArgs): Promise<HandlerPayload> => {
    const build = workbenchActions[action]
    // handler 表只由 route 按 ACTION_SCHEMAS 分发命中，此分支不可达；保持
    // fail loud（稳定码收敛在 route），不伪造半实现。
    if (build === undefined) throw new WxError('WX_ROUTE_UNKNOWN_ACTION', `action "${action}" has no workbench binding`)
    const pair = build(args)
    return compat(deps, pair[0], pair[1])
  }

  const handlers: Record<string, ActionHandler> = {
    'browser.status': async () => ({ status: 'ok', ...(await deps.browserStatusFn()) }),

    'accounts.list': async () => {
      const local = await readAccounts(deps.root)
      const locals = Object.values(local.accounts)
      let remote: Array<Record<string, unknown>> = []
      let remoteOk = true
      try {
        const result = await callWx(deps, 'workbench_wx_account_list', {})
        remote = Array.isArray(result.accounts) ? result.accounts as Array<Record<string, unknown>> : []
      } catch (error: unknown) {
        void error
        remoteOk = false
      }
      const seen = new Set<string>()
      const accounts: Array<Record<string, unknown>> = []
      for (const record of locals) {
        seen.add(record.accountId)
        const row = remote.find(item => item.account_id === record.accountId) ?? null
        const rowRecord = (row ?? {}) as Record<string, unknown>
        // 两个投影字段同源：一次磁盘探测，避免每账号重复读 storage_state。
        const hasCredentials = await hasStorageState(record.accountId, deps.root)
        accounts.push({
          accountId: record.accountId,
          nickname: record.nickname ?? stringValue(rowRecord.nickname),
          avatar: record.avatar ?? stringValue(rowRecord.avatar),
          feedCount: record.feedCount ?? numberValue(rowRecord.feed_count),
          followerTotalCount: record.followerTotalCount ?? numberValue(rowRecord.follower_total_count),
          sessionStatus: record.sessionStatus ?? 'unknown',
          sessionCheckedAt: record.sessionCheckedAt ?? null,
          lastCollectedAt: stringValue(rowRecord.last_collected_at),
          deleteState: stringValue(rowRecord.delete_state) ?? 'none',
          isPending: isPendingAccountId(record.accountId),
          hasStorageState: hasCredentials,
          localCredentialsMissing: !hasCredentials,
        })
      }
      for (const row of remote) {
        const remoteId = stringValue(row.account_id)
        if (remoteId === null || seen.has(remoteId)) continue
        if (row.delete_state === 'remote_deleted') continue
        accounts.push({
          accountId: remoteId,
          nickname: stringValue(row.nickname),
          avatar: stringValue(row.avatar),
          feedCount: numberValue(row.feed_count),
          followerTotalCount: numberValue(row.follower_total_count),
          sessionStatus: 'unknown',
          sessionCheckedAt: null,
          lastCollectedAt: stringValue(row.last_collected_at),
          deleteState: stringValue(row.delete_state) ?? 'none',
          isPending: false,
          hasStorageState: false,
          localCredentialsMissing: true,
        })
      }
      return { status: 'ok', accounts, remoteOk }
    },

    'account.beginLogin': async args => {
      const key = asString(args, 'accountId') !== '' ? asString(args, 'accountId') : `pending-${String(Date.now())}`
      const existing = deps.loginRuns.get(key)
      if (existing !== undefined && ACTIVE_LOGIN_STATES.has(existing.state)) {
        return { status: 'ok', loginKey: key, state: existing.state }
      }
      if (existing !== undefined) deps.loginRuns.delete(key)
      const nowMs = Date.now()
      for (const [runKey, entry] of deps.loginRuns) {
        if (!ACTIVE_LOGIN_STATES.has(entry.state) && nowMs - Date.parse(entry.startedAt || '0') > LOGIN_RECORD_TTL_MS) {
          deps.loginRuns.delete(runKey)
        }
      }
      const attemptId = 0
      const controller = new AbortController()
      const run: LoginRun = {
        state: 'waiting_qr', accountId: null, profile: null,
        startedAt: new Date().toISOString(), updatedAt: null, reason: null, attemptId,
        controller,
      }
      deps.loginRuns.set(key, run)
      deps.loginSignals.set(key, controller)
      // 登录任务（含晚 factory 清理 promise）纳入登记表，dispose 统一等待。
      deps.taskRegistry.track(loginWithQrCode({
        accountId: key, root: deps.root, timeoutMs: LOGIN_TIMEOUT_MS,
        locks: deps.locks,
        signal: controller.signal,
        chromeFactory: deps.chromeFactory,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
        onPage: async () => {
          if (run.attemptId !== attemptId) return
          run.state = 'waiting_confirm'
          run.updatedAt = new Date().toISOString()
        },
      }).then(async result => {
        if (run.attemptId !== attemptId) return
        run.updatedAt = new Date().toISOString()
        if (result.status === 'ok') {
          run.accountId = result.accountId
          run.profile = { nickname: result.profile?.nickname ?? null, avatar: result.profile?.avatar ?? null, feedsCount: result.profile?.feedsCount ?? null }
          try {
            const profile = result.profile
            const saveArgs: Record<string, unknown> = {
              accountId: result.accountId,
              sessionRef: paths(deps.root).vaultRef(result.accountId),
              idempotencyKey: accountSaveIdempotencyKey(result.accountId),
            }
            if (profile?.nickname !== undefined && profile.nickname !== null) saveArgs.nickname = profile.nickname
            if (profile?.avatar !== undefined && profile.avatar !== null) saveArgs.avatar = profile.avatar
            if (profile?.fansCount !== null && profile?.fansCount !== undefined) saveArgs.followerTotalCount = profile.fansCount
            if (profile?.feedsCount !== null && profile?.feedsCount !== undefined) saveArgs.feedCount = profile.feedsCount
            if (profile?.isMasterFinder !== null && profile?.isMasterFinder !== undefined) saveArgs.isMasterFinder = profile.isMasterFinder
            await callWx(deps, 'workbench_wx_account_save', saveArgs)
            const record = await getAccount(result.accountId, deps.root).catch(() => undefined)
            const seq = Number(record?.sessionSeq ?? 0)
            if (seq > 0) {
              await callWx(deps, 'workbench_wx_session_status_report', {
                accountId: result.accountId,
                sessionStatus: 'ok',
                sessionSeq: seq,
                checkedAt: new Date().toISOString(),
                sessionRef: paths(deps.root).vaultRef(result.accountId),
                idempotencyKey: sessionIdempotencyKey(result.accountId, seq),
              })
            }
            run.reason = null
          } catch (error: unknown) {
            run.reason = safeCode(error)
          }
          run.state = 'ok'
        } else if (result.status === 'timeout') {
          run.state = 'timeout'
          run.reason = 'login_timeout'
        } else {
          run.state = 'failed'
          run.reason = result.reason || 'login_failed'
        }
      }).catch((error: unknown) => {
        if (run.attemptId !== attemptId) return
        run.state = 'failed'
        run.reason = safeCode(error) === 'WX_TOOL_UNAVAILABLE' ? 'login_aborted' : safeCode(error)
      }).finally(() => {
        if (deps.loginSignals.get(key) === controller) deps.loginSignals.delete(key)
      }))
      return { status: 'ok', loginKey: key, state: run.state }
    },

    'account.loginStatus': async args => {
      const run = deps.loginRuns.get(asString(args, 'accountId'))
      if (run === undefined) return { status: 'ok', state: 'idle' }
      return {
        status: 'ok', state: run.state, accountId: run.accountId, profile: run.profile,
        reason: run.reason, startedAt: run.startedAt, updatedAt: run.updatedAt,
      }
    },

    'account.refreshLoginQr': async args => {
      const accountId = asString(args, 'accountId')
      const run = deps.loginRuns.get(accountId)
      if (run === undefined || run.state === 'ok') {
        return { status: 'error', reason: 'refresh_not_allowed', state: run?.state ?? 'idle' }
      }
      // abort 旧流程（loginWithQrCode 信号关窗+停轮询+清临时 profile，P2-12）。
      const oldController = deps.loginSignals.get(accountId)
      oldController?.abort()
      run.attemptId += 1
      run.state = 'waiting_qr'
      run.reason = null
      run.updatedAt = new Date().toISOString()
      const attemptId = run.attemptId
      const controller = new AbortController()
      run.controller = controller
      deps.loginSignals.set(accountId, controller)
      deps.taskRegistry.track(loginWithQrCode({
        accountId, root: deps.root, timeoutMs: LOGIN_TIMEOUT_MS,
        locks: deps.locks,
        signal: controller.signal,
        chromeFactory: deps.chromeFactory,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
        onPage: async () => {
          if (run.attemptId !== attemptId) return
          run.state = 'waiting_confirm'
          run.updatedAt = new Date().toISOString()
        },
      }).then(result => {
        if (run.attemptId !== attemptId) return
        run.updatedAt = new Date().toISOString()
        if (result.status === 'ok') {
          run.state = 'ok'
          run.accountId = result.accountId
          run.profile = { nickname: result.profile?.nickname ?? null, avatar: result.profile?.avatar ?? null, feedsCount: result.profile?.feedsCount ?? null }
        } else if (result.status === 'timeout') {
          run.state = 'timeout'
          run.reason = 'login_timeout'
        } else {
          run.state = 'failed'
          run.reason = result.reason || 'login_failed'
        }
      }).catch((error: unknown) => {
        if (run.attemptId !== attemptId) return
        run.state = 'failed'
        run.reason = safeCode(error) === 'WX_TOOL_UNAVAILABLE' ? 'login_aborted' : safeCode(error)
      }).finally(() => {
        if (deps.loginSignals.get(accountId) === controller) deps.loginSignals.delete(accountId)
      }))
      return { status: 'ok', loginKey: accountId, state: run.state }
    },

    'account.probe': async args => {
      const { probeAndReport } = await import('./probe.ts')
      const probe = await deps.taskRegistry.runTracked(() => probeAndReport(deps.workbench, asString(args, 'accountId'), deps.root, deps.locks, deps.chromeFactory, {
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      }))
      return { status: 'ok', sessionStatus: probe.sessionStatus, reason: probe.reason, reported: probe.reported }
    },

    'account.promote': async args => {
      const { promotePendingAccount } = await import('./session.ts')
      return { status: 'ok', ...await deps.taskRegistry.runTracked(() => promotePendingAccount({
        accountId: asString(args, 'accountId'),
        root: deps.root,
        locks: deps.locks,
        chromeFactory: deps.chromeFactory,
        launchTimeoutMs: deps.launchTimeoutMs,
        browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
        onBrowserCloseTimeout: message => { deps.logger.warn(message) },
        trackCleanup: promise => { deps.taskRegistry.track(promise) },
      })) }
    },

    'account.removeLocal': async args => {
      const accountId = asString(args, 'accountId')
      // 危险写操作前置复查：dispose 开始后不得进入新的删除副作用（已在途的
      // handler 由 guard 层 runTracked 登记等待）。复查与 tryWithProfileLock
      // 之间保持同步（removeLocalAccount 为静态导入），无 await 窗口。
      if (deps.disposing) return { status: 'error', reason: 'plugin_disposing' }
      // try 锁：collect/登录迁移持有 profile 时立即返回 collect_busy，不排队等
      // 长采集，也不删除任何本地凭证（先检查后执行不可靠，必须由锁原子裁决）。
      const attempt = await deps.locks.tryWithProfileLock(accountId, () => removeLocalAccount({ accountId, root: deps.root }))
      if (!attempt.acquired) return { status: 'ok', removed: false, reason: 'collect_busy' }
      const result = attempt.result
      // 清理 runs.json 中该账号全部 run 记录：root 队列内一次性原子清理，
      // 无「队列外 readRuns 快照 + 逐条 removeRun」的漏删/竞态窗口。
      await removeAccountRuns(deps.root, accountId).catch((error: unknown) => {
        deps.logger.warn(`wx runs.json cleanup failed (${accountId}): ${safeCode(error)}`)
      })
      return { status: 'ok', ...result }
    },

    'account.removeRemote': async args => {
      const accountId = asString(args, 'accountId')
      if (await hasStorageState(accountId, deps.root)) {
        return { status: 'error', reason: 'LOCAL_CLEARED_REQUIRED' }
      }
      // 远端删除前置复查：dispose 开始后不得进入新的远端副作用。
      if (deps.disposing) return { status: 'error', reason: 'plugin_disposing' }
      const result = await callWx(deps, 'workbench_wx_account_remove', {
        accountId, confirm: true, localCleared: true,
        idempotencyKey: accountRemoveIdempotencyKey(accountId),
      })
      return { status: 'ok', ...result }
    },

    'collect.start': async args => {
      const { probeAndReport } = await import('./probe.ts')
      const accountId = asString(args, 'accountId')
      // 页面路径：就绪检查 → 实测上报（同步等待，记录 progress.phase='probing'）
      // → dispose 复查 → 启动。探测不通过返回 started:false 与原因；同账号
      // 运行中或批量运行中（含 batchReserved 预留窗）由控制器/钩子拒绝
      // collect_busy（口径见实施单 2.2）。
      const started = await collect.start({
        accountId,
        newAttempt: args.newAttempt === true,
        probe: async () => {
          const readiness = await checkCollectionReadiness({ accountId, root: deps.root, busy: false })
          if (!readiness.ready) return { ok: false, reason: readiness.reason ?? 'session_required' }
          const session = await probeAndReport(deps.workbench, accountId, deps.root, deps.locks, deps.chromeFactory, {
            launchTimeoutMs: deps.launchTimeoutMs,
            browserCloseTimeoutMs: deps.browserCloseTimeoutMs,
            onBrowserCloseTimeout: message => { deps.logger.warn(message) },
            trackCleanup: promise => { deps.taskRegistry.track(promise) },
          })
          return session.sessionStatus === 'ok'
            ? { ok: true, reason: null, probe: session.probe }
            : { ok: false, reason: session.sessionStatus === 'expired' ? 'session_required' : 'probe_failed' }
        },
        beforeLaunch: () => (deps.disposing ? 'plugin_disposing' : null),
      })
      if (!started.started) return { status: 'ok', started: false, reason: started.reason ?? 'collect_failed' }
      return { status: 'ok', started: true }
    },

    'collect.status': async args => {
      // 合并内存实时态与持久化态：lastRun 是 runs.json 中最近启动的一条完整
      // 记录——进程重启后内存记录为空，lastRun 提供上次 run 的终态投影
      // （attemptId/runId/status/finishedAt/error）。读失败（如 runs.json 语义
      // 损坏）不伪装成空记录：稳定 reason 暴露给调用方。
      let lastRun: RunRecord | null = null
      let reason: string | null = null
      try {
        const runs = await readRuns(deps.root)
        lastRun = Object.values(runs)
          .filter(record => record.startedAt !== '')
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0] ?? null
      } catch (error) {
        reason = safeCode(error)
      }
      // busy 现在表示「任一账号运行中」；按账号查询时 collect 是该账号最近
      // 一条记录（运行中或终态），未传账号时是首个运行中记录（无则 null）。
      const accountId = asString(args, 'accountId')
      return {
        status: 'ok',
        busy: collect.hasRunning(),
        collect: accountId !== '' ? collect.status(accountId) : collect.running(),
        runningAccountIds: collect.runningAccountIds(),
        lastRun,
        ...(reason !== null ? { reason } : {}),
      }
    },

    'collect.running': async () => ({
      status: 'ok',
      collect: collect.running(),
      batchRunning: batch.running,
    }),

    'collect.cancel': async args => {
      const accountId = asString(args, 'accountId')
      if (!collect.cancel(accountId)) return { status: 'ok', cancelled: false, reason: 'not_running' }
      return { status: 'ok', cancelled: true }
    },

    'collectAll.start': async () => {
      if (batch.running || collect.hasRunning() || deps.batchReserved) {
        return { status: 'ok', started: false, reason: 'collect_busy' }
      }
      deps.batchReserved = true
      let started: { started: boolean; reason?: string; batchId?: string; accounts?: number }
      try {
        const local = await readAccounts(deps.root)
        // dispose 可能在 readAccounts 期间完成：batch.start 前复查，避免整次
        // run 在 dispose 返回后才启动、无人等待。
        if (deps.disposing) return { status: 'ok', started: false, reason: 'plugin_disposing' }
        const accountIds = Object.values(local.accounts)
          .filter(record => !isPendingAccountId(record.accountId))
          .map(record => record.accountId)
        started = await batch.start(accountIds)
      } finally {
        deps.batchReserved = false
      }
      if (!started.started) return { status: 'ok', started: false, reason: started.reason }
      return { status: 'ok', started: true, batchId: started.batchId, accounts: started.accounts, batch: batch.status }
    },

    'collectAll.status': async () => ({ status: 'ok', ...batch.status }),

    'collectAll.cancel': async () => {
      batch.stop()
      return { status: 'ok', cancelled: true }
    },

    'run.get': args => runPassthrough('run.get', args),
    'works.list': args => runPassthrough('works.list', args),
    'work.get': args => runPassthrough('work.get', args),
    'work.trend': args => runPassthrough('work.trend', args),
    'account.overview': args => runPassthrough('account.overview', args),
    'fans.profile.get': args => runPassthrough('fans.profile.get', args),
    'overview.accounts': args => runPassthrough('overview.accounts', args),
  }
  // dispose 开始后统一稳定拒绝新 action（不登记）；已通过 guard 的在途 action
  // 一律经 runTracked 登记——dispose 等待其 settle（collect/login 另有 abort
  // 链路，probe/promote/读路径/远端调用被等待收敛）。
  const guarded: Record<string, ActionHandler> = {}
  for (const [action, handler] of Object.entries(handlers)) {
    guarded[action] = async (args: ActionArgs) => {
      if (deps.disposing) return { status: 'error', reason: 'plugin_disposing' }
      return deps.taskRegistry.runTracked(() => handler(args))
    }
  }
  return guarded
}
