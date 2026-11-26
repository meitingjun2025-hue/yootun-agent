/**
 * 会话状态上报与标记（旧 runner/session 协同面）：probe/refresh 的会话状态经
 * workbench `workbench_wx_session_status_report` 上报（幂等键=accountId+seq）。
 * @module
 */
import { safeCode } from './errors.ts'
import {
  bumpSessionSeqWith, getAccount, nextSessionSeq, paths, type AccountRecord,
} from './state.ts'
import { refreshSessionState, type RefreshedSession } from './session.ts'
import type { ProfileLocks } from '@yootun/dsh-workbench-host-kit'
import { sessionIdempotencyKey } from './idempotency.ts'
import type { WxWorkbenchFace } from './ingest.ts'

export { refreshSessionState, type RefreshedSession } from './session.ts'

/** 上报会话状态到 Workbench（幂等键 accountId+seq；失败不抛，返回 ok:false）。 */
export async function reportSessionStatus(workbench: WxWorkbenchFace, accountId: string, state: RefreshedSession): Promise<{ ok: boolean; reason: string | null }> {
  try {
    await workbench.callTool('wx-workbench', 'wx', 'workbench_wx_session_status_report', {
      accountId,
      sessionStatus: state.sessionStatus,
      sessionSeq: state.sessionSeq,
      checkedAt: state.checkedAt,
      sessionRef: state.vaultRef,
      idempotencyKey: sessionIdempotencyKey(accountId, state.sessionSeq),
    })
    return { ok: true, reason: null }
  } catch (error) {
    return { ok: false, reason: safeCode(error) }
  }
}

/** 会话拉回 ok（floor 对齐远端下限）并返回上报投影。 */
export async function markSessionOk(options: { accountId: string; root: string; floorSessionSeq?: number }): Promise<RefreshedSession> {
  const seq = await nextSessionSeq(options.accountId, options.root)
  const floor = Math.max(seq - 1, options.floorSessionSeq ?? 0)
  const { record } = await bumpSessionSeqWith(options.accountId, {
    sessionStatus: 'ok',
    sessionCheckedAt: new Date().toISOString(),
  }, floor, options.root)
  return projectRecord(options.accountId, options.root, record, seq, 'ok', null)
}

/** 会话标记 expired（细分原因保留：account_mismatch 等可行动文案可达）。 */
export async function markSessionExpired(options: { accountId: string; root: string; reason?: string }): Promise<RefreshedSession> {
  const seq = await nextSessionSeq(options.accountId, options.root)
  const { record } = await bumpSessionSeqWith(options.accountId, {
    sessionStatus: 'expired',
    sessionCheckedAt: new Date().toISOString(),
  }, seq - 1, options.root)
  return projectRecord(options.accountId, options.root, record, record.sessionSeq ?? seq, 'expired', options.reason ?? 'session_invalid')
}

function projectRecord(accountId: string, root: string, record: AccountRecord, seq: number, status: RefreshedSession['sessionStatus'], reason: string | null): RefreshedSession {
  return {
    sessionStatus: status,
    reason,
    sessionSeq: seq,
    checkedAt: record.sessionCheckedAt ?? new Date().toISOString(),
    vaultRef: paths(root).vaultRef(accountId),
    accountId,
    sessionStatusReported: false,
  }
}

/**
 * 便捷组合：探测 + 上报（批量控制器 probe 注入用）。
 * @param budgets - 生命周期预算透传（Config.browserCloseTimeoutMs /
 *   Config.launchTimeoutMs + 告警与登记接缝；缺省走 chrome.ts / session.ts 常量）。
 */
export async function probeAndReport(
  workbench: WxWorkbenchFace,
  accountId: string,
  root: string,
  locks: ProfileLocks,
  chromeFactory?: import('./session.ts').ChromeFactory,
  budgets?: {
    launchTimeoutMs?: number | undefined
    browserCloseTimeoutMs?: number | undefined
    onBrowserCloseTimeout?: ((message: string) => void) | undefined
    trackCleanup?: ((promise: Promise<void>) => void) | undefined
  },
): Promise<{ sessionStatus: string; reason: string | null; reported: boolean }> {
  const state = await locks.withProfileLock(accountId, () => refreshSessionState({
    accountId,
    root,
    chromeFactory,
    ...(budgets?.launchTimeoutMs !== undefined ? { launchTimeoutMs: budgets.launchTimeoutMs } : {}),
    ...(budgets?.browserCloseTimeoutMs !== undefined ? { browserCloseTimeoutMs: budgets.browserCloseTimeoutMs } : {}),
    ...(budgets?.onBrowserCloseTimeout !== undefined ? { onBrowserCloseTimeout: budgets.onBrowserCloseTimeout } : {}),
    ...(budgets?.trackCleanup !== undefined ? { trackCleanup: budgets.trackCleanup } : {}),
  }))
  const reported = await reportSessionStatus(workbench, accountId, state)
  return { sessionStatus: state.sessionStatus, reason: state.reason, reported: reported.ok }
}

export { getAccount }
