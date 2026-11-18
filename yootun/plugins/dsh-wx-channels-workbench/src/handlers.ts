/**
 * 19+2 项 action 的 Host 实现（依赖注入面 + 处理器表）。登录/采集/批量均为
 * 进程内 AbortController 生命周期（dispose 统一 abort + 等待 settle）；
 * collect 与 batch 互斥沿用旧插件三态同步守卫。所有 Workbench 调用经
 * `ctx.yootunWorkbench.callTool`。
 * @module
 */
import type { BrowserStatus } from './chrome.ts'
import { safeCode } from './errors.ts'
import {
  accountRemoveIdempotencyKey, accountSaveIdempotencyKey, sessionIdempotencyKey,
} from './idempotency.ts'
import { isPendingAccountId, loginWithQrCode, type ChromeFactory } from './session.ts'
import { tryWithProfileLock } from './locks.ts'
import { hasStorageState, readAccounts, getAccount, paths } from './state.ts'
import { checkCollectionReadiness, progressFromEvent } from './runner.ts'
import { createAttemptId, readRuns, removeAccountRuns, updateRun, type RunRecord } from './runs.ts'
import type { BatchStatus } from './collect-all.ts'
import type { WxWorkbenchFace } from './ingest.ts'
import type { ActionArgs, ActionHandler } from './route.ts'

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
  loginRuns: Map<string, LoginRun>
  collectBusy: boolean
  collectLeaseHeld: boolean
  batchReserved: boolean
  collectRecord: Record<string, unknown> | null
  collectSignals: Map<string, AbortController>
  loginSignals: Map<string, AbortController>
  batchSignal: AbortController | undefined
  setBatch(batch: unknown): void
  onDispose: ((abortAll: () => void, settle: Promise<void>) => void) | undefined
}

export function createWxHostDeps(options: { root: string; workbench: WxWorkbenchFace; browserStatusFn: () => Promise<BrowserStatus>; logger: { warn(message: string): void }; chromeFactory?: ChromeFactory }): WxHostDeps {
  return {
    root: options.root,
    workbench: options.workbench,
    browserStatusFn: options.browserStatusFn,
    logger: options.logger,
    chromeFactory: options.chromeFactory,
    loginRuns: new Map(),
    collectBusy: false,
    collectLeaseHeld: false,
    batchReserved: false,
    collectRecord: null,
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

function compat(deps: WxHostDeps, name: string, args: Record<string, unknown>): Promise<{ status: string } & Record<string, unknown>> {
  return callWx(deps, name, args)
    .then(result => ({ status: 'ok', ...result }))
    .catch((error: unknown) => ({ status: 'error', reason: safeCode(error) }))
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
}): Record<string, ActionHandler> {
  const asString = (args: ActionArgs, key: string): string => (typeof args[key] === 'string' ? args[key] as string : '')

  const workbenchActions: Record<string, (args: ActionArgs) => [string, Record<string, unknown>]> = {
    'works.list': args => ['workbench_wx_work_list', filterUndefined({ accountId: asString(args, 'accountId'), sort: asString(args, 'sort'), order: asString(args, 'order') })],
    'work.get': args => ['workbench_wx_work_get', { accountId: asString(args, 'accountId'), workId: asString(args, 'workId') }],
    'work.trend': args => ['workbench_wx_work_trend', { accountId: asString(args, 'accountId'), workId: asString(args, 'workId') }],
    'account.overview': args => ['workbench_wx_account_overview', filterUndefined({ accountId: asString(args, 'accountId'), window: asString(args, 'window') })],
    'fans.profile.get': args => ['workbench_wx_fans_profile_get', { accountId: asString(args, 'accountId') }],
    'run.get': args => ['workbench_wx_collect_run_get', { runId: asString(args, 'runId') }],
  }
  const runPassthrough = async (action: string, args: ActionArgs): Promise<object> => {
    const build = workbenchActions[action]
    if (build === undefined) return { status: 'error', reason: 'unknown_action' }
    const pair = build(args)
    return compat(deps, pair[0], pair[1])
  }

  return {
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
          hasStorageState: await hasStorageState(record.accountId, deps.root),
          localCredentialsMissing: !(await hasStorageState(record.accountId, deps.root)),
        })
      }
      for (const row of remote) {
        const remoteId = stringValue(row.account_id)
        if (remoteId === null || seen.has(remoteId)) continue
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
      void loginWithQrCode({
        accountId: key, root: deps.root, timeoutMs: LOGIN_TIMEOUT_MS,
        signal: controller.signal,
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
      })
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
      void loginWithQrCode({
        accountId, root: deps.root, timeoutMs: LOGIN_TIMEOUT_MS,
        signal: controller.signal,
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
      })
      return { status: 'ok', loginKey: accountId, state: run.state }
    },

    'account.probe': async args => {
      const { probeAndReport } = await import('./probe.ts')
      const probe = await probeAndReport(deps.workbench, asString(args, 'accountId'), deps.root, deps.chromeFactory)
      return { status: 'ok', sessionStatus: probe.sessionStatus, reason: probe.reason, reported: probe.reported }
    },

    'account.promote': async args => {
      const { promotePendingAccount } = await import('./session.ts')
      return { status: 'ok', ...await promotePendingAccount({ accountId: asString(args, 'accountId'), root: deps.root, chromeFactory: deps.chromeFactory }) }
    },

    'account.removeLocal': async args => {
      const accountId = asString(args, 'accountId')
      const { removeLocalAccount } = await import('./session.ts')
      // try 锁：collect/登录迁移持有 profile 时立即返回 collect_busy，不排队等
      // 长采集，也不删除任何本地凭证（先检查后执行不可靠，必须由锁原子裁决）。
      const attempt = await tryWithProfileLock(accountId, () => removeLocalAccount({ accountId, root: deps.root }))
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
      const result = await callWx(deps, 'workbench_wx_account_remove', {
        accountId, confirm: true, localCleared: true,
        idempotencyKey: accountRemoveIdempotencyKey(accountId),
      })
      return { status: 'ok', ...result }
    },

    'collect.start': async args => {
      const { runCollection } = await import('./runner.ts')
      const { probeAndReport } = await import('./probe.ts')
      const accountId = asString(args, 'accountId')
      if (deps.collectBusy || batch.running || deps.batchReserved) {
        return { status: 'ok', started: false, reason: 'collect_busy' }
      }
      deps.collectBusy = true
      deps.collectRecord = {
        accountId, attemptId: null, status: 'not_started', startedAt: new Date().toISOString(),
        finishedAt: null, error: null, progress: { phase: 'probing' }, result: null,
      }
      let started = false
      let attemptId = ''
      try {
        const readiness = await checkCollectionReadiness({ accountId, root: deps.root, busy: false })
        if (!readiness.ready) {
          return { status: 'ok', started: false, reason: readiness.reason ?? 'session_required' }
        }
        const session = await probeAndReport(deps.workbench, accountId, deps.root, deps.chromeFactory)
        if (session.sessionStatus !== 'ok') {
          return { status: 'ok', started: false, reason: session.sessionStatus === 'expired' ? 'session_required' : 'probe_failed' }
        }
        // 稳定 attemptId：内存 collectRecord 与 runs.json 从此引用同一条记录。
        attemptId = createAttemptId(accountId)
        const controller = new AbortController()
        deps.collectSignals.set(accountId, controller)
        const record = deps.collectRecord as Record<string, unknown>
        record.attemptId = attemptId
        record.status = 'running'
        record.startedAt = new Date().toISOString()
        started = true
        // runs.json 的唯一写入方是 runner（running 记录在采集锁内启动时创建，
        // progress/终态更新同一条）；这里只维护内存实时态。
        void runCollection({
          workbench: deps.workbench, accountId, root: deps.root, attemptId,
          chromeFactory: deps.chromeFactory,
          newAttempt: args.newAttempt === true,
          onProgress: event => {
            const progress = progressFromEvent(event)
            if (progress !== null) record.progress = progress
          },
          logger: deps.logger,
          signal: controller.signal,
        }).then(result => {
          record.status = result.status === 'completed' || result.status === 'partial' ? result.status : result.reason === 'collect_cancelled' ? 'cancelled' : 'failed'
          record.error = record.status === 'failed' ? result.reason ?? 'collect_failed' : null
          record.result = { runId: result.runId, works: result.works ?? 0 }
          record.finishedAt = new Date().toISOString()
        }).catch((error: unknown) => {
          record.status = 'failed'
          record.error = safeCode(error)
          record.finishedAt = new Date().toISOString()
          // 兜底终态（runner 自身已 catch 一切；此处只覆盖磁盘级穿透）。
          // 写失败再 warn：终态可见性不允许静默。
          void updateRun(deps.root, accountId, attemptId, { status: 'failed', finishedAt: new Date().toISOString(), error: record.error as string | null }).catch((persistError: unknown) => {
            deps.logger.warn(`wx runs.json final state write failed (${attemptId}): ${safeCode(persistError)}`)
          })
        }).finally(() => {
          deps.collectBusy = false
          deps.collectSignals.delete(accountId)
        })
        return { status: 'ok', started: true }
      } finally {
        // 所有 failed-to-start 路径统一复位：collectBusy / collectSignals / record。
        if (!started) {
          deps.collectBusy = false
          deps.collectSignals.delete(accountId)
          const record = deps.collectRecord as Record<string, unknown> | null
          if (record !== null && record.status === 'not_started') {
            record.status = 'failed'
            record.error = 'start_failed'
            record.finishedAt = new Date().toISOString()
          }
        }
      }
    },

    'collect.status': async () => {
      // 合并内存实时态与持久化态：lastRun 是 runs.json 中最近启动的一条完整
      // 记录——进程重启后内存 collectRecord 为 null，lastRun 提供上次 run 的
      // 终态投影（attemptId/runId/status/finishedAt/error）。读失败（如
      // runs.json 语义损坏）不伪装成空记录：稳定 reason 暴露给调用方。
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
      return { status: 'ok', busy: deps.collectBusy, collect: deps.collectRecord, lastRun, ...(reason !== null ? { reason } : {}) }
    },

    'collect.cancel': async args => {
      const accountId = asString(args, 'accountId')
      const controller = deps.collectSignals.get(accountId)
      if (controller === undefined) return { status: 'ok', cancelled: false, reason: 'not_running' }
      controller.abort()
      return { status: 'ok', cancelled: true }
    },

    'collectAll.start': async () => {
      if (batch.running || deps.collectBusy || deps.batchReserved) {
        return { status: 'ok', started: false, reason: 'collect_busy' }
      }
      deps.batchReserved = true
      let started: { started: boolean; reason?: string; batchId?: string; accounts?: number }
      try {
        const local = await readAccounts(deps.root)
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
  }
}
