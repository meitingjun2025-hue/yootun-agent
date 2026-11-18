/**
 * 账号页：accounts.list + account.probe / account.promote / 会话过期重新扫码 /
 * 删除两步确认（先 account.removeLocal，成功后才 account.removeRemote；每一步
 * 失败短路并给出可解释 reason 与单步重试，不一键顺序调用两步）。
 * @module
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import type { AccountRow } from './WorkbenchPage.tsx'

/** 删除流程步进：idle → confirm → local → remote → done；每步失败短路可重试。 */
type DeleteStep =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'removingLocal' }
  | { kind: 'localFailed'; reason: string }
  | { kind: 'busy'; reason: string }
  | { kind: 'removingRemote' }
  | { kind: 'remoteFailed'; reason: string }
  | { kind: 'done' }

interface ProbeState { probing: boolean; result: { sessionStatus: string; reason: string | null } | null }
interface PromoteState { promoting: boolean; result: { promoted: boolean; reason: string | null } | null }

export interface AccountsTabProps {
  t: Translate
  accounts: AccountRow[]
  /** 删除/提升成功后刷新账号列表。 */
  onRemoved: () => Promise<void>
  /** 会话过期账号的重新扫码入口（转登录取） */
  onLoginRequested: (accountId: string) => void
  /** 选中账号（行名按钮）。 */
  onSelectAccount: (accountId: string) => void
}

/** 账号页组件。 */
export function AccountsTab(props: AccountsTabProps): ReactNode {
  const t = props.t
  const [deletes, setDeletes] = useState<Record<string, DeleteStep>>({})
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})
  const [promotes, setPromotes] = useState<Record<string, PromoteState>>({})

  const setDelete = useCallback((accountId: string, step: DeleteStep): void => {
    setDeletes(previous => ({ ...previous, [accountId]: step }))
  }, [])

  const confirmRemoveLocal = useCallback(async (accountId: string): Promise<void> => {
    setDelete(accountId, { kind: 'removingLocal' })
    let res: { removed?: unknown; reason?: unknown }
    try {
      res = await hostAction('account.removeLocal', { accountId })
    } catch (error) {
      setDelete(accountId, { kind: 'localFailed', reason: error instanceof Error ? error.message : 'unknown' })
      return
    }
    if (res.removed !== true) {
      // 本地未清理（如 collect_busy）：短路，绝不进入 removeRemote。
      setDelete(accountId, res.reason === 'collect_busy' ? { kind: 'busy', reason: 'collect_busy' } : { kind: 'localFailed', reason: typeof res.reason === 'string' ? res.reason : 'unknown' })
      return
    }
    await confirmRemoveRemote(accountId)
  }, [setDelete])

  const confirmRemoveRemote = useCallback(async (accountId: string): Promise<void> => {
    setDelete(accountId, { kind: 'removingRemote' })
    try {
      await hostAction('account.removeRemote', { accountId })
    } catch (error) {
      setDelete(accountId, { kind: 'remoteFailed', reason: error instanceof Error ? error.message : 'unknown' })
      return
    }
    setDelete(accountId, { kind: 'done' })
    await props.onRemoved()
  }, [props.onRemoved, setDelete])

  const probe = useCallback(async (accountId: string): Promise<void> => {
    setProbes(previous => ({ ...previous, [accountId]: { probing: true, result: null } }))
    try {
      const res = await hostAction('account.probe', { accountId })
      const result = {
        sessionStatus: typeof res.sessionStatus === 'string' ? res.sessionStatus : 'unknown',
        reason: typeof res.reason === 'string' ? res.reason : null,
      }
      setProbes(previous => ({ ...previous, [accountId]: { probing: false, result } }))
    } catch (error) {
      setProbes(previous => ({ ...previous, [accountId]: { probing: false, result: { sessionStatus: 'unknown', reason: error instanceof Error ? error.message : 'unknown' } } }))
    }
  }, [])

  const promote = useCallback(async (accountId: string): Promise<void> => {
    setPromotes(previous => ({ ...previous, [accountId]: { promoting: true, result: null } }))
    try {
      const res = await hostAction('account.promote', { accountId })
      const result = {
        promoted: res.promoted === true,
        reason: typeof res.reason === 'string' ? res.reason : null,
      }
      setPromotes(previous => ({ ...previous, [accountId]: { promoting: false, result } }))
      if (result.promoted) await props.onRemoved()
    } catch (error) {
      setPromotes(previous => ({ ...previous, [accountId]: { promoting: false, result: { promoted: false, reason: error instanceof Error ? error.message : 'unknown' } } }))
    }
  }, [props.onRemoved])

  return (
    <DataCard title={t('tab.accounts')} state='ready'>
      <ul className={css.accountList}>
        {props.accounts.map(row => {
          const step = deletes[row.accountId] ?? { kind: 'idle' }
          const probeState = probes[row.accountId] ?? null
          const promoteState = promotes[row.accountId] ?? null
          const displayName = row.nickname ?? row.accountId
          return (
            <li key={row.accountId} className={css.accountRow}>
              <button
                type='button'
                className={css.accountName}
                title={displayName}
                aria-label={displayName}
                onClick={() => { props.onSelectAccount(row.accountId) }}
              >
                {displayName}
              </button>
              <span className={css.accountIdText}>{row.accountId}</span>
              <StateDot state={row.sessionStatus === 'ok' ? 'done' : row.sessionStatus === 'expired' ? 'error' : 'idle'} />
              <span className={css.accountState}>
                {row.sessionStatus === 'ok' ? t('account.sessionOk')
                  : row.sessionStatus === 'expired' ? t('account.sessionExpired')
                  : row.sessionStatus === 'pending' ? t('account.pending')
                  : t('account.sessionUnknown')}
              </span>
              {row.localCredentialsMissing === true && (
                <span className={css.accountState} role='status'>{t('account.localMissing')}</span>
              )}
              <div className={css.accountActions}>
                <Button variant='ghost' size='sm' disabled={probeState?.probing === true}
                  onClick={() => { void probe(row.accountId) }}>
                  {probeState?.probing === true ? t('account.probing') : t('account.probe')}
                </Button>
                {row.isPending === true && (
                  <Button variant='ghost' size='sm' disabled={promoteState?.promoting === true}
                    onClick={() => { void promote(row.accountId) }}>
                    {promoteState?.promoting === true ? t('account.promoteBusy') : t('account.promote')}
                  </Button>
                )}
                {row.sessionStatus === 'expired' && (
                  <Button variant='ghost' size='sm' onClick={() => { props.onLoginRequested(row.accountId) }}>
                    {t('account.relogin')}
                  </Button>
                )}
                <Button variant='ghost' size='sm' className={css.dangerButton}
                  disabled={step.kind === 'removingLocal' || step.kind === 'removingRemote'}
                  onClick={() => { setDelete(row.accountId, { kind: 'confirm' }) }}>
                  {t('account.remove')}
                </Button>
              </div>
              {(step.kind === 'confirm' || step.kind === 'removingLocal' || step.kind === 'removingRemote'
                || step.kind === 'localFailed' || step.kind === 'busy' || step.kind === 'remoteFailed' || step.kind === 'done') && (
                <div className={css.deleteFlow} aria-label={t('account.removeConfirm')}>
                  <p className={css.deleteWarning}>{t('account.removeWarning')}</p>
                  {step.kind === 'confirm' && (
                    <div className={css.deleteActions}>
                      <Button variant='primary' size='sm' className={css.dangerButton}
                        aria-label={`${t('account.removeConfirm')}：${displayName}`}
                        onClick={() => { void confirmRemoveLocal(row.accountId) }}>
                        {`${t('account.removeConfirm')}：${displayName}`}
                      </Button>
                      <Button variant='ghost' size='sm' onClick={() => { setDelete(row.accountId, { kind: 'idle' }) }}>
                        {t('account.delete.cancel')}
                      </Button>
                    </div>
                  )}
                  {step.kind === 'removingLocal' && <p className={css.deleteWarning} role='status'>{t('account.delete.removingLocal')}</p>}
                  {step.kind === 'removingRemote' && <p className={css.deleteWarning} role='status'>{t('account.delete.removingRemote')}</p>}
                  {step.kind === 'busy' && (
                    <div className={css.deleteActions}>
                      <p className={css.deleteWarning} role='status'>{reasonText(step.reason, t)}</p>
                      <Button variant='ghost' size='sm' onClick={() => { setDelete(row.accountId, { kind: 'confirm' }) }}>
                        {t('state.retry')}
                      </Button>
                      <Button variant='ghost' size='sm' onClick={() => { setDelete(row.accountId, { kind: 'idle' }) }}>
                        {t('account.delete.cancel')}
                      </Button>
                    </div>
                  )}
                  {step.kind === 'localFailed' && (
                    <div className={css.deleteActions}>
                      <p className={css.deleteWarning} role='status'>{`${t('account.delete.localFailed')}：${reasonText(step.reason, t)}`}</p>
                      <Button variant='ghost' size='sm' onClick={() => { void confirmRemoveLocal(row.accountId) }}>
                        {t('account.delete.retryLocal')}
                      </Button>
                      <Button variant='ghost' size='sm' onClick={() => { setDelete(row.accountId, { kind: 'idle' }) }}>
                        {t('account.delete.cancel')}
                      </Button>
                    </div>
                  )}
                  {step.kind === 'remoteFailed' && (
                    <div className={css.deleteActions}>
                      <p className={css.deleteWarning} role='status'>{`${t('account.delete.remoteFailed')}：${reasonText(step.reason, t)}`}</p>
                      <Button variant='ghost' size='sm' onClick={() => { void confirmRemoveRemote(row.accountId) }}>
                        {t('account.delete.retryRemote')}
                      </Button>
                      <Button variant='ghost' size='sm' onClick={() => { setDelete(row.accountId, { kind: 'idle' }) }}>
                        {t('account.delete.cancel')}
                      </Button>
                    </div>
                  )}
                  {step.kind === 'done' && <p className={css.deleteWarning} role='status'>{t('account.removeSuccess')}</p>}
                </div>
              )}
              {probeState?.result !== null && probeState?.result !== undefined && (
                <p className={css.accountState} role='status'>
                  {`${t('account.probe')}: ${probeState.result.sessionStatus === 'ok' ? t('account.sessionOk') : probeState.result.sessionStatus === 'expired' ? t('account.sessionExpired') : t('account.sessionUnknown')}`}
                  {probeState.result.reason !== null && ` · ${reasonText(probeState.result.reason, t)}`}
                </p>
              )}
              {promoteState?.result !== null && promoteState?.result !== undefined && (
                <p className={css.accountState} role='status'>
                  {promoteState.result.promoted ? t('account.promoted') : `${t('account.promoteBlocked')}${promoteState.result.reason !== null ? ` · ${reasonText(promoteState.result.reason, t)}` : ''}`}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </DataCard>
  )
}
