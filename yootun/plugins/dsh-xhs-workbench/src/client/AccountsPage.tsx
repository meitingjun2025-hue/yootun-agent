/**
 * 账号管理页（12 册 §4；旧 client.js AccountsPage/AccountSummary 重译）：
 * Chrome 缺失时页面顶部阻断提示；左栏账号列表（添加账号/重新登录/检测/移除
 * 确认、状态徽标、探测与采集中禁用）；右栏通知条 + 工具栏（采集数据/刷新数据，
 * 运行中显示页数与笔记进度、truncated 警示）+ 账号信息卡 + 基本数据卡
 * （指标缺失显示缺口提示，不补 0）。
 * @module
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { createAccountsMachineWithHost, type AccountRow, type AccountsMachine, type AccountsNotice } from './accounts-machine.ts'



class AccountHolder {
  private machine: AccountsMachine | null = null
  get(): AccountsMachine | null {
    return this.machine
  }
  set(machine: AccountsMachine): void {
    this.machine = machine
  }
}

const accountsHolder = new AccountHolder()

function getAccountsMachine(): AccountsMachine {
  const existing = accountsHolder.get()
  if (existing !== null) return existing
  const machine = createAccountsMachineWithHost()
  accountsHolder.set(machine)
  return machine
}

export interface AccountsPageProps { t: Translate }

/**
 * Render the accounts page (账号列表 | 账号主区).
 * @param props - page translator.
 * @returns the page node.
 */
export function AccountsPage(props: AccountsPageProps): ReactNode {
  const t = props.t
  const machine = getAccountsMachine()
  const state = useSyncExternalStore(machine.subscribe, machine.get, machine.get)
  const [removing, setRemoving] = useState<AccountRow | null>(null)

  // 账号页生命周期：进入时拉列表/恢复轮询，离开时停轮询（单例状态跨切换保留）。
  useEffect(() => {
    machine.init()
    return () => { machine.stop() }
  }, [machine])

  const selected = state.accounts.find(item => item.accountId === state.selectedId) ?? null
  const loginWaiting = state.login !== null && state.login.status === 'waiting'
  const collectRunning = state.collect !== null && state.collect.collectStatus === 'running' && (state.collect.accountId === (selected?.accountId ?? ''))
  const anyRunning = loginWaiting || (state.collect !== null && state.collect.collectStatus === 'running') || state.probing.size > 0

  return (
    <div className={css.accountsLayout}>
      {state.chromeAvailable === false && (
        <p className={css.accountsChromeBlock} role='alert'>{t('accounts.chromeBlock')}</p>
      )}
      <aside className={css.accountsList} aria-label={t('accounts.title')}>
        <div className={css.accountsListHead}>
          <h2 className={css.sectionTitle}>{t('accounts.title')}</h2>
          <Button variant='primary' disabled={loginWaiting}
            onClick={() => { void machine.beginLoginFlow({}) }}>
            {t('accounts.add')}
          </Button>
        </div>
        <p className={css.hint}>{t('accounts.hint')}</p>
        {loginWaiting && (
          <p className={css.accountsLoginWaiting} role='status'>
            <StateDot state='ongoing' /> {t('accounts.loginWaiting')}
          </p>
        )}
        {state.listError !== null && <p className={css.errorText} role='alert'>{t(state.listError as Parameters<Translate>[0])}</p>}
        {state.accounts.length === 0
          ? <p className={css.hint}>{state.loading ? t('state.loading') : t('accounts.empty')}</p>
          : (
              <ul className={css.accountsItems}>
                {state.accounts.map(account => (
                  <li key={account.accountId}>
                    <button
                      type='button'
                      className={`${css.accountsItem} ${account.accountId === state.selectedId ? css.accountsItemActive : ''}`}
                      aria-current={account.accountId === state.selectedId || undefined}
                      onClick={() => { machine.select(account.accountId) }}
                    >
                      {account.avatar !== null
                        ? <img className={css.accountsAvatar} src={account.avatar} alt='' />
                        : <span className={`${css.accountsAvatar} ${css.accountsAvatarFallback}`} aria-hidden='true'>{(account.nickname ?? account.accountId ?? '?').slice(0, 1)}</span>}
                      <span className={css.accountsMeta}>
                        <span className={css.accountsName}>{account.nickname ?? account.accountId}</span>
                        <span className={css.accountsId}>{account.accountId}</span>
                      </span>
                      <StatusBadge status={account.sessionStatus} probing={state.probing.has(account.accountId)} t={t} />
                    </button>
                    <div className={css.accountsActions}>
                      <Button variant='ghost' disabled={state.probing.has(account.accountId) || anyRunning}
                        onClick={() => { void machine.probeNow(account.accountId) }}>
                        {state.probing.has(account.accountId) ? t('accounts.probing') : t('accounts.probe')}
                      </Button>
                      <Button variant='ghost' disabled={loginWaiting || anyRunning}
                        onClick={() => { void machine.beginLoginFlow({ accountId: account.accountId }) }}>
                        {t('accounts.relogin')}
                      </Button>
                      <Button variant='ghost' disabled={anyRunning} onClick={() => { setRemoving(account) }}>
                        {t('accounts.removeLocal')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
      </aside>
      <div className={css.accountsMain}>
        {state.notice !== null && <NoticeBar notice={state.notice} machine={machine} t={t} />}
        {selected !== null
          ? (
              <>
                <div className={css.actionRow}>
                  <Button
                    variant='primary'
                    disabled={collectRunning || anyRunning}
                    onClick={() => { void machine.startCollectFlow(selected.accountId) }}
                  >
                    {collectRunning
                      ? t('accounts.collecting', { pages: state.collect?.pagesDone ?? 0, notes: state.collect?.notesTotal ?? 0 })
                      : t('accounts.collectData')}
                  </Button>
                  <Button variant='ghost' disabled={anyRunning}
                    onClick={() => { void machine.probeNow(selected.accountId) }}>
                    {t('accounts.refreshData')}
                  </Button>
                </div>
                <AccountSummary account={selected} t={t} />
              </>
            )
          : (
              <div className={css.stateBlock} role='status'>
                <p>{state.loading ? t('state.loading') : t('accounts.empty')}</p>
              </div>
            )}
      </div>
      <Modal
        open={removing !== null}
        onClose={() => { setRemoving(null) }}
        title={t('accounts.removeLocal')}
        closeLabel={t('hb.closeDrawer')}
      >
        <p className={css.confirmText}>{t('accounts.removeConfirm')}</p>
        <div className={css.actionRow}>
          <Button variant='primary' onClick={() => {
            if (removing !== null) void machine.removeAccount(removing.accountId)
            setRemoving(null)
          }}>
            {t('action.confirmYes')}
          </Button>
          <Button variant='ghost' onClick={() => { setRemoving(null) }}>{t('action.confirmNo')}</Button>
        </div>
      </Modal>
    </div>
  )
}

/** 会话状态徽标：ok/expired/unknown，检测中显示探测态（颜色不作唯一信息）。 */
function StatusBadge(props: { status: string; probing: boolean; t: Translate }): ReactNode {
  const key = props.probing
    ? 'accounts.statusProbing'
    : props.status === 'ok' ? 'accounts.statusOk' : props.status === 'expired' ? 'accounts.statusExpired' : 'accounts.statusUnknown'
  const state = props.probing
    ? 'ongoing'
    : props.status === 'ok' ? 'done' : props.status === 'expired' ? 'error' : 'idle'
  return (
    <span className={css.hbBadgeWrap}>
      <StateDot state={state} />
      {props.t(key)}
    </span>
  )
}

/** 通知条：成功/警告/错误均可关闭；错误走稳定码文案映射（不透出原始码）。 */
function NoticeBar(props: { notice: AccountsNotice; machine: AccountsMachine; t: Translate }): ReactNode {
  const { notice, machine, t } = props
  const text = notice.reason !== undefined ? reasonText(notice.reason, t) : t(notice.key as Parameters<Translate>[0])
  return (
    <div
      className={notice.kind === 'error' ? css.accountsNoticeError : notice.kind === 'warn' ? css.accountsNoticeWarn : css.accountsNoticeOk}
      role={notice.kind === 'error' ? 'alert' : 'status'}
    >
      <span>{text}</span>
      <button type='button' className={css.hbNoticeClose} aria-label={t('hb.close')} onClick={() => { machine.dismissNotice() }}>×</button>
    </div>
  )
}

/** 右栏双卡：账号信息（昵称/账号 ID/授权状态）+ 基本数据（缺口提示，不补 0）。 */
function AccountSummary(props: { account: AccountRow; t: Translate }): ReactNode {
  const { account, t } = props
  const summary = account.summary ?? null
  const totals = summary?.totals ?? { plays: undefined, likes: undefined, collects: undefined, comments: undefined, shares: undefined } as Record<string, number | undefined>
  const gaps = summary?.gaps ?? {} as Record<string, number | undefined>
  const stats: Array<{ key: Parameters<Translate>[0]; value: string; gap: number | undefined }> = [
    { key: 'accounts.statNotes', value: summary !== null ? String(summary.notesCount) : '—', gap: undefined },
    { key: 'accounts.statPlays', value: formatCount(totals.plays), gap: gaps.plays },
    { key: 'accounts.statLikes', value: formatCount(totals.likes), gap: gaps.likes },
    { key: 'accounts.statCollects', value: formatCount(totals.collects), gap: gaps.collects },
    { key: 'accounts.statComments', value: formatCount(totals.comments), gap: gaps.comments },
    { key: 'accounts.statShares', value: formatCount(totals.shares), gap: gaps.shares },
  ]
  return (
    <div className={css.accountsDetail}>
      <section className={css.accountsCard} aria-label={t('accounts.accountInfo')}>
        <h3 className={css.hbPanelTitle}>{t('accounts.accountInfo')}</h3>
        <dl className={css.accountsKv}>
          <div><dt>{t('accounts.nickname')}</dt><dd>{account.nickname ?? '—'}</dd></div>
          <div><dt>{t('accounts.accountId')}</dt><dd className={css.hbMono}>{account.accountId}</dd></div>
          <div><dt>{t('accounts.authStatus')}</dt><dd><StatusBadge status={account.sessionStatus} probing={false} t={t} /></dd></div>
        </dl>
      </section>
      <section className={css.accountsCard} aria-label={t('accounts.basicData')}>
        <div className={css.accountsCardHead}>
          <h3 className={css.hbPanelTitle}>{t('accounts.basicData')}</h3>
          <p className={css.hint}>
            {summary?.capturedAt !== null && summary?.capturedAt !== undefined
              ? t('accounts.lastCollected', { time: formatDateTime(summary.capturedAt) })
              : t('accounts.neverCollected')}
          </p>
        </div>
        <div className={css.accountsStats}>
          {stats.map(stat => (
            <div key={stat.key} className={css.accountsStat}>
              <span className={css.accountsStatLabel}>{t(stat.key)}</span>
              <span className={css.accountsStatValue}>{stat.value}</span>
              {stat.gap !== undefined && stat.gap > 0 && (
                <span className={css.accountsStatGap}>{t('accounts.gapHint', { count: stat.gap })}</span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

/** 计数展示：非法/缺失 → —（不补 0，不编造）。 */
function formatCount(value: unknown): string {
  const num = Number(value)
  return Number.isFinite(num) && num >= 0 ? String(num) : '—'
}

/** ISO → `YYYY-MM-DD HH:mm`；非法 → —。 */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
