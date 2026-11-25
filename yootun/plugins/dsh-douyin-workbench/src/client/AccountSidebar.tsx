/**
 * 左侧账号管理栏（账号作品页 280px 侧栏；对齐旧工作台布局）：标题行「账号
 * 管理 + 采集全部（primary）」→ 批量进度面板（运行中三行 + 终态三态汇总 +
 * 未完成明细六类原因）→ 账号卡片列表 → 添加账号宽主按钮（等待扫码… +
 * aria-busy + 扫码提示 role=status）→ 空态。账号卡：头像安全化（http(s)
 * 白名单失败降级昵称首字符）、昵称、粉丝、会话徽标 StateDot、采集运行中状态点
 * （ongoing + 文案，数据源为页面投影）、按会话状态分流
 * 的检测会话/重新扫码（ghost）、删除（danger error-token 文本 + 两步确认
 * RiskConfirmation：removeLocal 成功才 removeRemote，cleanup_failed 重试块，
 * RUN_STILL_ACTIVE 专属文案）。
 * @module
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, RiskConfirmation, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostAction } from './api.ts'
import { avatarFallbackChar, batchReasonKey, formatCount, formatDateTime, reasonText, safeHttpUrl, type Translate } from './format.ts'
import css from './workbench.module.css'
import type { AccountRow } from './WorkbenchPage.tsx'
import type { BatchView } from './schema.ts'

/** 删除流程步进：idle → confirm → local → remote → done；每步失败短路可重试。 */
type DeleteStep =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'removingLocal' }
  | { kind: 'localFailed'; reason: string }
  | { kind: 'removingRemote' }
  | { kind: 'remoteFailed'; reason: string }
  | { kind: 'done' }

export interface AccountSidebarProps {
  t: Translate
  accounts: AccountRow[]
  selectedId: string | null
  /** chrome / driver 缺失：登录与采集入口禁用并提示。 */
  browserBlocked: boolean
  /** 登录进行中：添加账号禁用（不重复开浏览器抢轮询）。 */
  loginActive: boolean
  /** 单账号采集运行中。 */
  collectBusy: boolean
  /** 批量对采集入口的占用（批量运行中，或挂载恢复的批量确认查询在途）。 */
  batchBusy: boolean
  batch: BatchView | null
  /** 正在采集的账号（单账号运行投影 + 批量运行中条目；状态点数据源）。 */
  collectingAccountIds: readonly string[]
  onSelect: (accountId: string) => void
  onCollectAll: () => void
  onRelogin: () => void
  onAddAccount: () => void
  /** 删除 / 探活成功后的账号列表刷新（由页面注入）。 */
  onAccountsChanged: () => Promise<unknown>
  /** 终态提示（页面 toast）。 */
  onNotice: (text: string) => void
}

/** 会话状态 → 状态点 + 文案。 */
function sessionView(row: AccountRow, t: Translate): { dot: 'done' | 'error' | 'idle'; text: string } {
  if (row.sessionStatus === 'ok') return { dot: 'done', text: t('account.state.ok') }
  if (row.sessionStatus === 'expired') return { dot: 'error', text: t('account.state.expired') }
  return { dot: 'idle', text: t('account.state.unknown') }
}

/** 账号管理栏组件。 */
export function AccountSidebar(props: AccountSidebarProps): ReactNode {
  const t = props.t
  const [deletes, setDeletes] = useState<Record<string, DeleteStep>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [deleteAck, setDeleteAck] = useState(false)

  const setDelete = useCallback((accountId: string, step: DeleteStep): void => {
    setDeletes(previous => ({ ...previous, [accountId]: step }))
  }, [])

  const confirmRemoveLocal = useCallback(async (accountId: string): Promise<void> => {
    setDelete(accountId, { kind: 'removingLocal' })
    // 本地未清理（collect_busy / RUN_STILL_ACTIVE / cleanup_failed）由 Host 以
    // error envelope 拒绝：hostAction 抛稳定 reason，此处短路绝不进入远端删除。
    try {
      await hostAction('account.removeLocal', { accountId })
    } catch (error) {
      setDelete(accountId, { kind: 'localFailed', reason: error instanceof Error ? error.message : 'cleanup_failed' })
      return
    }
    await confirmRemoveRemote(accountId)
  }, [setDelete])

  const confirmRemoveRemote = useCallback(async (accountId: string): Promise<void> => {
    setDelete(accountId, { kind: 'removingRemote' })
    try {
      await hostAction('account.removeRemote', { accountId })
    } catch (error) {
      setDelete(accountId, { kind: 'remoteFailed', reason: error instanceof Error ? error.message : 'douyin_operation_request_failed' })
      return
    }
    setDelete(accountId, { kind: 'done' })
    setDeleteAck(false)
    props.onNotice(t('account.removeSuccess'))
    await props.onAccountsChanged()
  }, [props, setDelete, t])

  const probe = useCallback(async (accountId: string): Promise<void> => {
    setProbing(previous => ({ ...previous, [accountId]: true }))
    try {
      const res = await hostAction('account.probe', { accountId })
      const sessionStatus = typeof res.sessionStatus === 'string' ? res.sessionStatus : 'unknown'
      props.onNotice(sessionStatus === 'ok' ? t('account.probeOk') : sessionStatus === 'expired' ? t('account.probeExpired') : t('account.state.unknown'))
    } catch (error) {
      props.onNotice(error instanceof Error ? reasonText(error.message, t) : t('error.default'))
    } finally {
      setProbing(previous => ({ ...previous, [accountId]: false }))
      await props.onAccountsChanged()
    }
  }, [props, t])

  const batchRunning = props.batch !== null && props.batch.status === 'running'
  const collectable = props.accounts.some(row => row.sessionStatus === 'ok' && !row.isPending)
  const collectLocked = props.collectBusy || props.batchBusy

  return (
    <aside className={css.sidebar} aria-label={t('account.title')}>
      <div className={css.sidebarHead}>
        <h2 className={css.sidebarTitle}>{t('account.title')}</h2>
        <Button
          variant='primary'
          size='sm'
          disabled={collectLocked || props.browserBlocked || !collectable}
          title={collectable ? undefined : t('account.collectAllBlocked')}
          onClick={props.onCollectAll}
        >
          {batchRunning ? t('account.collectAllRunning') : t('account.collectAll')}
        </Button>
      </div>
      <BatchPanel t={t} batch={props.batch} accounts={props.accounts} />
      <div className={css.accountList}>
        {props.accounts.length === 0
          ? <p className={css.sidebarHint}>{t('account.empty')}</p>
          : props.accounts.map(row => (
            <AccountCard
              key={row.accountId}
              t={t}
              row={row}
              selected={row.accountId === props.selectedId}
              collecting={props.collectingAccountIds.includes(row.accountId)}
              collectLocked={collectLocked}
              browserBlocked={props.browserBlocked}
              loginActive={props.loginActive}
              deleteStep={deletes[row.accountId] ?? { kind: 'idle' }}
              probing={probing[row.accountId] === true}
              onSelect={props.onSelect}
              onProbe={probe}
              onRelogin={props.onRelogin}
              onRemove={accountId => {
                setDeleteAck(false)
                setDelete(accountId, { kind: 'confirm' })
              }}
              onRemoveCancel={accountId => { setDelete(accountId, { kind: 'idle' }); setDeleteAck(false) }}
              onRemoveConfirm={confirmRemoveLocal}
              onRemoveRetryLocal={confirmRemoveLocal}
              onRemoveRetryRemote={confirmRemoveRemote}
              deleteAck={deleteAck}
              onDeleteAckChange={setDeleteAck}
            />
          ))}
      </div>
      <Button
        variant='primary'
        size='md'
        className={css.addAccountButton}
        disabled={props.browserBlocked || props.loginActive}
        aria-busy={props.loginActive || undefined}
        onClick={props.onAddAccount}
      >
        {props.loginActive ? t('account.addBusy') : t('account.add')}
      </Button>
      {props.loginActive && <p className={css.sidebarHint} role='status'>{t('account.scanHint')}</p>}
      {props.browserBlocked && <p className={css.sidebarHint} role='alert'>{t('browser.blockedHint')}</p>}
    </aside>
  )
}

/** 单张账号卡片：主体切换选中，操作行按会话状态分流。 */
function AccountCard(props: {
  t: Translate
  row: AccountRow
  selected: boolean
  /** 本账号正在采集（会话徽标旁显示「采集中」状态点）。 */
  collecting: boolean
  collectLocked: boolean
  browserBlocked: boolean
  loginActive: boolean
  deleteStep: DeleteStep
  probing: boolean
  onSelect: (accountId: string) => void
  onProbe: (accountId: string) => Promise<void>
  onRelogin: () => void
  onRemove: (accountId: string) => void
  onRemoveCancel: (accountId: string) => void
  onRemoveConfirm: (accountId: string) => Promise<void>
  onRemoveRetryLocal: (accountId: string) => Promise<void>
  onRemoveRetryRemote: (accountId: string) => Promise<void>
  deleteAck: boolean
  onDeleteAckChange: (acknowledged: boolean) => void
}): ReactNode {
  const t = props.t
  const row = props.row
  const name = row.nickname ?? row.accountId
  const session = sessionView(row, t)
  const avatarSrc = safeHttpUrl(row.avatar)
  const step = props.deleteStep
  const reopenLocked = props.collectLocked || props.browserBlocked || props.loginActive
  return (
    <article className={css.accountCard} aria-current={props.selected ? 'true' : undefined}>
      <button
        type='button'
        className={css.accountCardMain}
        onClick={() => { props.onSelect(row.accountId) }}
      >
        <span className={css.accountAvatar} aria-hidden='true'>
          {avatarSrc !== null
            ? <img className={css.accountAvatarImg} src={avatarSrc} alt='' loading='lazy' referrerPolicy='no-referrer' />
            : avatarFallbackChar(name)}
        </span>
        <span className={css.accountCardBody}>
          <span className={css.accountName} title={name}>{name}</span>
          <span className={css.accountMeta}>
            {t('account.followers', { count: formatCount(row.fanCount) })}
            {' · '}
            {formatDateTime(row.lastCollectedAt)}
          </span>
          <span className={css.accountStateLine}>
            <StateDot state={session.dot} />
            <span>{session.text}</span>
            {props.collecting && (
              <>
                <StateDot state='ongoing' />
                <span>{t('account.collecting')}</span>
              </>
            )}
          </span>
        </span>
      </button>
      <div className={css.accountActions}>
        {row.sessionStatus === 'ok' && (
          <Button variant='ghost' size='sm' disabled={props.collectLocked || props.browserBlocked || props.probing}
            onClick={() => { void props.onProbe(row.accountId) }}>
            {props.probing ? t('account.probing') : t('account.probe')}
          </Button>
        )}
        {(row.sessionStatus === 'expired' || row.sessionStatus === 'unknown') && (
          <Button variant='ghost' size='sm' disabled={reopenLocked} onClick={props.onRelogin}>
            {t('account.relogin')}
          </Button>
        )}
        <Button variant='ghost' size='sm' className={css.dangerButton} disabled={props.collectLocked}
          onClick={() => { props.onRemove(row.accountId) }}>
          {t('account.remove')}
        </Button>
      </div>
      {step.kind === 'confirm' && (
        <RiskConfirmation
          open
          title={t('account.removeConfirmTitle')}
          description={t('account.removeWarning')}
          acknowledgeLabel={t('account.removeWarning')}
          cancelLabel={t('account.delete.cancel')}
          closeLabel={t('dialog.close')}
          confirmLabel={t('account.delete.confirm')}
          acknowledged={props.deleteAck}
          onAcknowledgedChange={props.onDeleteAckChange}
          onCancel={() => { props.onRemoveCancel(row.accountId) }}
          onConfirm={() => { void props.onRemoveConfirm(row.accountId) }}
        />
      )}
      {step.kind === 'removingLocal' && <p className={css.deleteStatus} role='status'>{t('account.delete.removingLocal')}</p>}
      {step.kind === 'removingRemote' && <p className={css.deleteStatus} role='status'>{t('account.delete.removingRemote')}</p>}
      {(step.kind === 'localFailed' || step.kind === 'remoteFailed') && (
        <div className={css.deleteRetry} role='alert'>
          <p className={css.deleteErrorText}>{reasonText(step.reason, t)}</p>
          <div className={css.deleteActions}>
            {step.kind === 'localFailed' && (
              <Button variant='ghost' size='sm' onClick={() => { void props.onRemoveRetryLocal(row.accountId) }}>
                {t('account.delete.retryLocal')}
              </Button>
            )}
            {step.kind === 'remoteFailed' && (
              <Button variant='ghost' size='sm' onClick={() => { void props.onRemoveRetryRemote(row.accountId) }}>
                {t('account.delete.retryRemote')}
              </Button>
            )}
            <Button variant='ghost' size='sm' onClick={() => { props.onRemoveCancel(row.accountId) }}>
              {t('account.delete.cancel')}
            </Button>
          </div>
        </div>
      )}
    </article>
  )
}

/**
 * 批量采集面板：运行中显示总进度 + 当前账号 + 细粒度进度 + 三类计数；终态
 * 三态汇总（完成/部分完成/未完成）+ 未完成明细（六类原因文案）。
 */
function BatchPanel(props: { t: Translate; batch: BatchView | null; accounts: AccountRow[] }): ReactNode {
  const batch = props.batch
  const t = props.t
  if (batch === null || batch.status === null) return null
  const running = batch.status === 'running'
  const nameOf = (accountId: string): string =>
    props.accounts.find(row => row.accountId === accountId)?.nickname ?? accountId
  const progress = running
    ? batch.phase === 'probing'
      ? t('batch.progress.checking', { index: Math.min(batch.total, batch.probedCount + batch.skippedCount), total: batch.total })
      : batch.total > 0
        ? t('batch.progress.collecting', { index: Math.min(batch.runnableTotal, batch.runnableDone + 1), total: batch.runnableTotal })
        : t('batch.progress.fallback')
    : null
  const summaryKey = batch.status === 'completed' ? 'batch.summary.completed'
    : batch.status === 'partial' ? 'batch.summary.partial'
      : 'batch.summary.failed'
  const unfinished = running ? [] : batch.items.filter(item => item.status === 'failed' || item.status === 'partial' || item.status === 'skipped')
  return (
    <div
      className={css.batchPanel}
      role={running ? 'status' : undefined}
      aria-live={running ? 'polite' : undefined}
      aria-busy={running || undefined}
      data-tone={running ? 'running' : batch.status}
    >
      {running && (
        <>
          <p className={css.batchProgress}><StateDot state='ongoing' />{progress}</p>
          {batch.currentAccountId !== null && (
            <p className={css.batchLine}>{t('batch.current', { name: nameOf(batch.currentAccountId) })}</p>
          )}
          <p className={css.batchLine}>
            {t('batch.counts', { completed: batch.completedCount, partial: batch.partialCount, failed: batch.failedCount, skipped: batch.skippedCount })}
          </p>
        </>
      )}
      {!running && (
        <>
          <p className={css.batchSummary} data-tone={batch.status === 'completed' ? 'ok' : batch.status === 'partial' ? 'partial' : 'error'} role='status'>
            {t(summaryKey, { completed: batch.completedCount, partial: batch.partialCount, failed: batch.failedCount, skipped: batch.skippedCount })}
          </p>
          {unfinished.length > 0 && (
            <div className={css.batchDetail}>
              <p className={css.batchLine}>{t('batch.unfinishedTitle')}</p>
              {unfinished.map(item => (
                <p key={item.accountId} className={css.batchItem}>
                  <span className={css.batchItemName}>{nameOf(item.accountId)}</span>
                  <span className={css.batchItemReason}>{t(batchReasonKey(item.reason))}</span>
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
