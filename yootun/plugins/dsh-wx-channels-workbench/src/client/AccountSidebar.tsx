/**
 * 左侧账号管理栏（作品数据页 280px 侧栏）：标题行「账号管理 + 采集全部」→
 * 批量采集面板（仅运行中或有终态结果时）→ 账号卡片列表 → 添加账号宽主按钮 →
 * 登录中 / 浏览器缺失提示。账号卡片：头像或安全占位、昵称（缺省账号 ID）、
 * 关注者数、最近同步时间、会话状态、选中态、本地凭证缺失 / pending 标记，
 * 操作按会话状态分流（检测会话 / 重新扫码 / 提升 / 删除两步确认）。删除保持
 * 两步：本地清理成功后才远端删除，每步失败短路并可单步重试。
 * @module
 */
import { useCallback, useState, type ReactNode } from 'react'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { hostAction } from './api.ts'
import { formatCount, formatDateTime, reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import type { AccountRow } from './WorkbenchPage.tsx'
import type { BatchItemView, BatchStatusView } from './schema.ts'

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

export interface AccountSidebarProps {
  t: Translate
  /** 计数格式化的展示 locale（账号卡关注者数）。 */
  localeTag: string
  accounts: AccountRow[]
  selectedId: string | null
  /** chrome / driver 缺失：采集与登录入口禁用并提示。 */
  browserBlocked: boolean
  /** 登录进行中：添加账号禁用（不重复开浏览器抢轮询）。 */
  loginActive: boolean
  /** 单账号采集运行中。 */
  collectBusy: boolean
  /** 单账号采集运行中的账号（无运行中采集为 null）；账号栏状态点数据源之一。 */
  collectingAccountId: string | null
  batch: BatchStatusView | null
  onSelect: (accountId: string) => void
  onCollectAll: () => void
  onCancelBatch: () => void
  onRelogin: () => void
  onAddAccount: () => void
  /** 删除 / 提升成功后的账号列表刷新（由页面注入）。 */
  onAccountsChanged: () => Promise<unknown>
  /** 删除 / 提升等终态提示（页面 toast）。 */
  onNotice: (text: string) => void
}

/** 头像 URL 防御与旧口径一致：仅 http(s)。 */
function safeAvatarSrc(value: string | null): string | null {
  if (value === null) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

/** 会话状态 → 状态点 + 文案（墓碑账号独立标注，不可操作）。 */
function sessionView(row: AccountRow, t: Translate): { dot: 'done' | 'error' | 'idle'; text: string } {
  if (row.deleteState === 'remote_deleted') return { dot: 'idle', text: t('account.state.tombstone') }
  if (row.sessionStatus === 'ok') return { dot: 'done', text: t('account.state.ok') }
  if (row.sessionStatus === 'expired') return { dot: 'error', text: t('account.state.expired') }
  return { dot: 'idle', text: t('account.state.unknown') }
}

/** 账号管理栏组件。 */
export function AccountSidebar(props: AccountSidebarProps): ReactNode {
  const t = props.t
  const [deletes, setDeletes] = useState<Record<string, DeleteStep>>({})
  const [probing, setProbing] = useState<Record<string, boolean>>({})
  const [promoting, setPromoting] = useState<Record<string, boolean>>({})

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
      props.onNotice(error instanceof Error ? error.message : t('error.default'))
    } finally {
      setProbing(previous => ({ ...previous, [accountId]: false }))
      await props.onAccountsChanged()
    }
  }, [props, t])

  const promote = useCallback(async (accountId: string): Promise<void> => {
    setPromoting(previous => ({ ...previous, [accountId]: true }))
    try {
      const res = await hostAction('account.promote', { accountId })
      if (res.promoted === true) {
        props.onNotice(t('account.promoted'))
        await props.onAccountsChanged()
      } else {
        props.onNotice(res.reason === undefined ? t('account.promoteBlocked') : reasonText(String(res.reason), t))
      }
    } catch (error) {
      props.onNotice(error instanceof Error ? error.message : t('error.default'))
    } finally {
      setPromoting(previous => ({ ...previous, [accountId]: false }))
    }
  }, [props, t])

  const batchRunning = props.batch !== null && props.batch.ready !== true && props.batch.phase !== 'finished'
  // 采集中状态点：单账号采集的账号 + 批量当前账号；只作展示，不改变卡片点击与选中。
  const collectingIds = new Set<string>()
  if (props.collectingAccountId !== null) collectingIds.add(props.collectingAccountId)
  const batchCurrentId = batchRunning && props.batch !== null ? props.batch.currentAccountId : null
  if (batchCurrentId !== null) collectingIds.add(batchCurrentId)
  const collectable = props.accounts.some(row => row.deleteState !== 'remote_deleted' && row.sessionStatus === 'ok')
  // 动作依赖拆分：探活 / 提升 / 重新扫码都要打开系统 Chrome（probe →
  // refreshSessionState、promote → probeSession、relogin → 扫码窗口），随
  // chromeLocked 禁用；登录进行中不再叠开浏览器，随 loginActive 只禁重新扫码。
  // 删除只走本地 / 远端清理，不依赖 Chrome，也不受登录态影响。
  const collectLocked = props.collectBusy || batchRunning
  const chromeLocked = props.browserBlocked

  const batchPanel = batchPanelOf(props, batchRunning, t)

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
      {batchPanel}
      <div className={css.accountList}>
        {props.accounts.length === 0
          ? <p className={css.sidebarHint}>{t('account.empty')}</p>
          : props.accounts.map(row => (
            <AccountCard
              key={row.accountId}
              t={t}
              localeTag={props.localeTag}
              row={row}
              selected={row.accountId === props.selectedId}
              collectLocked={collectLocked}
              collecting={collectingIds.has(row.accountId)}
              chromeLocked={chromeLocked}
              loginActive={props.loginActive}
              deleteStep={deletes[row.accountId] ?? { kind: 'idle' }}
              probing={probing[row.accountId] === true}
              promoting={promoting[row.accountId] === true}
              onSelect={props.onSelect}
              onProbe={probe}
              onPromote={promote}
              onRelogin={props.onRelogin}
              onRemove={accountId => { setDelete(accountId, { kind: 'confirm' }) }}
              onRemoveCancel={accountId => { setDelete(accountId, { kind: 'idle' }) }}
              onRemoveConfirm={confirmRemoveLocal}
              onRemoveRetryLocal={confirmRemoveLocal}
              onRemoveRetryRemote={confirmRemoveRemote}
            />
          ))}
      </div>
      <Button
        variant='primary'
        size='md'
        className={css.addAccountButton}
        disabled={props.browserBlocked || props.loginActive}
        onClick={props.onAddAccount}
      >
        {props.loginActive ? t('account.addBusy') : t('account.add')}
      </Button>
      {props.loginActive && <p className={css.sidebarHint} role='status'>{t('account.loginHint')}</p>}
      {props.browserBlocked && <p className={css.sidebarHint} role='alert'>{t('browser.blockedHint')}</p>}
    </aside>
  )
}

/** 单张账号卡片：主体切换选中，操作行按会话状态分流。 */
function AccountCard(props: {
  t: Translate
  /** 计数格式化的展示 locale（关注者数）。 */
  localeTag: string
  row: AccountRow
  selected: boolean
  /** 采集 / 批量互斥：与宿主账号状态冲突的卡上操作禁用。 */
  collectLocked: boolean
  /** 该账号正在采集（单账号运行中或批量当前账号）：会话徽标旁显示采集中状态点。 */
  collecting: boolean
  /** chrome / 驱动缺失：探活 / 提升 / 重新扫码都要开 Chrome，一并禁用。 */
  chromeLocked: boolean
  /** 登录进行中：只禁会再开浏览器的重新扫码。 */
  loginActive: boolean
  deleteStep: DeleteStep
  probing: boolean
  promoting: boolean
  onSelect: (accountId: string) => void
  onProbe: (accountId: string) => Promise<void>
  onPromote: (accountId: string) => Promise<void>
  onRelogin: () => void
  onRemove: (accountId: string) => void
  onRemoveCancel: (accountId: string) => void
  onRemoveConfirm: (accountId: string) => Promise<void>
  onRemoveRetryLocal: (accountId: string) => Promise<void>
  onRemoveRetryRemote: (accountId: string) => Promise<void>
}): ReactNode {
  const t = props.t
  const row = props.row
  const name = row.nickname ?? row.accountId
  const session = sessionView(row, t)
  const tombstone = row.deleteState === 'remote_deleted'
  const syncTime = row.lastCollectedAt ?? row.sessionCheckedAt
  const step = props.deleteStep
  const flowVisible = step.kind !== 'idle' && step.kind !== 'done'
  const reopenLocked = props.collectLocked || props.chromeLocked || props.loginActive
  return (
    <article className={css.accountCard} aria-current={props.selected ? 'true' : undefined}>
      <button
        type='button'
        className={css.accountCardMain}
        onClick={() => { props.onSelect(row.accountId) }}
      >
        <span className={css.accountAvatar} aria-hidden='true'>
          {safeAvatarSrc(row.avatar) !== null
            ? <img className={css.accountAvatarImg} src={safeAvatarSrc(row.avatar) as string} alt='' loading='lazy' referrerPolicy='no-referrer' />
            : name.slice(0, 2)}
        </span>
        <span className={css.accountCardBody}>
          <span className={css.accountName} title={name}>{name}</span>
          <span className={css.accountMeta}>
            {t('account.followers', { count: formatCount(row.followerTotalCount, props.localeTag) })}
            {' · '}
            {t('account.lastSync', { time: formatDateTime(syncTime) ?? '—' })}
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
            {row.isPending && <span className={css.accountFlag}>{t('account.pending')}</span>}
            {row.localCredentialsMissing === true && <span className={css.accountFlag}>{t('account.localMissing')}</span>}
          </span>
        </span>
      </button>
      <div className={css.accountActions}>
        {row.sessionStatus === 'ok' && !tombstone && (
          <Button variant='ghost' size='sm' disabled={props.collectLocked || props.chromeLocked || props.probing}
            onClick={() => { void props.onProbe(row.accountId) }}>
            {props.probing ? t('account.probing') : t('account.probe')}
          </Button>
        )}
        {(row.sessionStatus === 'expired' || row.sessionStatus === 'unknown') && !tombstone && (
          <Button variant='ghost' size='sm' disabled={reopenLocked} onClick={props.onRelogin}>
            {t('account.relogin')}
          </Button>
        )}
        {row.isPending && (
          <Button variant='ghost' size='sm' disabled={props.collectLocked || props.chromeLocked || props.promoting}
            onClick={() => { void props.onPromote(row.accountId) }}>
            {props.promoting ? t('account.promoteBusy') : t('account.promote')}
          </Button>
        )}
        <Button variant='ghost' size='sm' className={css.dangerButton} disabled={props.collectLocked}
          onClick={() => { props.onRemove(row.accountId) }}>
          {t('account.remove')}
        </Button>
      </div>
      {flowVisible && (
        <div className={css.deleteFlow} aria-label={t('account.removeConfirm')}>
          <p className={css.deleteWarning}>{t('account.removeWarning')}</p>
          {step.kind === 'confirm' && (
            <div className={css.deleteActions}>
              <Button variant='primary' size='sm' className={css.dangerButton}
                aria-label={t('account.removeConfirmNamed', { name })}
                onClick={() => { void props.onRemoveConfirm(row.accountId) }}>
                {t('account.removeConfirmNamed', { name })}
              </Button>
              <Button variant='ghost' size='sm' onClick={() => { props.onRemoveCancel(row.accountId) }}>
                {t('account.delete.cancel')}
              </Button>
            </div>
          )}
          {step.kind === 'removingLocal' && <p className={css.deleteWarning} role='status'>{t('account.delete.removingLocal')}</p>}
          {step.kind === 'removingRemote' && <p className={css.deleteWarning} role='status'>{t('account.delete.removingRemote')}</p>}
          {step.kind === 'busy' && (
            <div className={css.deleteActions}>
              <p className={css.deleteWarning} role='status'>{reasonText(step.reason, t)}</p>
              <Button variant='ghost' size='sm' onClick={() => { props.onRemove(row.accountId) }}>{t('state.retry')}</Button>
              <Button variant='ghost' size='sm' onClick={() => { props.onRemoveCancel(row.accountId) }}>{t('account.delete.cancel')}</Button>
            </div>
          )}
          {step.kind === 'localFailed' && (
            <div className={css.deleteActions}>
              <p className={css.deleteWarning} role='status'>{`${t('account.delete.localFailed')}：${reasonText(step.reason, t)}`}</p>
              <Button variant='ghost' size='sm' onClick={() => { void props.onRemoveRetryLocal(row.accountId) }}>
                {t('account.delete.retryLocal')}
              </Button>
              <Button variant='ghost' size='sm' onClick={() => { props.onRemoveCancel(row.accountId) }}>
                {t('account.delete.cancel')}
              </Button>
            </div>
          )}
          {step.kind === 'remoteFailed' && (
            <div className={css.deleteActions}>
              <p className={css.deleteWarning} role='status'>{`${t('account.delete.remoteFailed')}：${reasonText(step.reason, t)}`}</p>
              <Button variant='ghost' size='sm' onClick={() => { void props.onRemoveRetryRemote(row.accountId) }}>
                {t('account.delete.retryRemote')}
              </Button>
              <Button variant='ghost' size='sm' onClick={() => { props.onRemoveCancel(row.accountId) }}>
                {t('account.delete.cancel')}
              </Button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * 批量采集面板：挂在标题行下方、账号列表上方；运行中显示总进度 + 当前账号 +
 * 细粒度进度 + 四类计数；终态显示汇总与失败 / 跳过 / 部分完成账号逐行稳定原因。
 */
function batchPanelOf(props: AccountSidebarProps, running: boolean, t: Translate): ReactNode {
  const batch = props.batch
  if (batch === null) return null
  if (!running && batch.phase !== 'finished') return null
  const total = batch.total ?? 0
  const index = Math.min(total, (batch.currentAccountIndex ?? 0) + 1)
  const progressText = running
    ? (batch.phase === 'probing'
        ? (total > 0 ? t('batch.progress.checking', { index, total }) : t('batch.progress.fallback'))
        : batch.phase === 'collecting' || batch.phase === 'stopping'
          ? (total > 0 ? t('batch.progress.collecting', { index, total }) : t('batch.progress.fallback'))
          : t('batch.progress.fallback'))
    : null
  const current = batch.currentAccountId === null
    ? null
    : t('batch.current', { name: accountNameOf(props.accounts, batch.currentAccountId) })
  // 未完成明细必须包含 partial（部分作品缺失），否则汇总与明细自相矛盾。
  const unfinished: BatchItemView[] = running
    ? []
    : batch.items.filter(item => item.status === 'failed' || item.status === 'skipped' || item.status === 'partial')
  const summaryError = (batch.failedCount ?? 0) > 0 || (batch.skippedCount ?? 0) > 0
  const summaryPartial = !summaryError && (batch.partialCount ?? 0) > 0
  return (
    <div
      className={css.batchPanel}
      role={running ? 'status' : undefined}
      aria-live={running ? 'polite' : undefined}
      aria-busy={running || undefined}
    >
      {running && (
        <>
          <p className={css.batchProgress}>
            <StateDot state='ongoing' />
            <span>{progressText}</span>
          </p>
          {current !== null && <p className={css.batchLine}>{current}</p>}
          <p className={css.batchLine}>
            {t('batch.counts', {
              completed: batch.completedCount ?? 0,
              partial: batch.partialCount ?? 0,
              failed: batch.failedCount ?? 0,
              skipped: batch.skippedCount ?? 0,
            })}
          </p>
          <Button variant='ghost' size='sm' onClick={props.onCancelBatch}>{t('batch.cancel')}</Button>
        </>
      )}
      {!running && batch.phase === 'finished' && (
        <>
          <p
            className={css.batchSummary}
            data-tone={summaryError ? 'error' : summaryPartial ? 'partial' : 'ok'}
            role='status'
          >
            {t('batch.summaryLine', {
              completed: batch.completedCount ?? 0,
              partial: batch.partialCount ?? 0,
              failed: batch.failedCount ?? 0,
              skipped: batch.skippedCount ?? 0,
            })}
          </p>
          {unfinished.length > 0 && (
            <div className={css.batchDetail}>
              {unfinished.map(item => (
                <p key={item.accountId} className={css.batchItem}>
                  <span className={css.batchItemName}>{accountNameOf(props.accounts, item.accountId)}</span>
                  <span className={css.batchItemReason}>{item.reason === null ? t('collect.reason.unknown') : reasonText(item.reason, t)}</span>
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** 账号名投影：昵称缺省回退账号 ID。 */
function accountNameOf(accounts: readonly AccountRow[], accountId: string): string {
  return accounts.find(row => row.accountId === accountId)?.nickname ?? accountId
}
