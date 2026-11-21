/**
 * 账号管理页（12 册 §4；旧 client.js AccountsPage/AccountSummary 重译；布局
 * 结构与样式逐字对齐视频号 AccountSidebar/WorksPanel）：左侧账号管理栏
 * （标题+采集全部 → 账号卡片列表[头像/昵称/最近同步/会话状态行 + 按状态
 * 分流的 ghost sm 操作：检测或重新登录 + 红字移除本地] → 通栏添加账号）；
 * 右栏通知条 + 工具栏（采集本账号全部 primary sm/刷新 outline sm/上次采集
 * 时间）+ 基本数据卡（指标缺失显示缺口提示，不补 0）。Chrome 缺失时页面
 * 顶部阻断提示。
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
 * Render the accounts page (左栏账号列表 | 右栏工具栏与基本数据卡).
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
  const capturedAt = selected?.summary?.capturedAt ?? null

  return (
    <div className={css.accountsLayout}>
      {state.chromeAvailable === false && (
        <p className={css.accountsChromeBlock} role='alert'>{t('accounts.chromeBlock')}</p>
      )}
      <aside className={css.sidebar} aria-label={t('accounts.title')}>
        {/* 侧栏结构与样式逐字对齐视频号 AccountSidebar。 */}
        <div className={css.sidebarHead}>
          <h2 className={css.sidebarTitle}>{t('accounts.title')}</h2>
          {/* 采集全部：占位按钮，功能后续接入（置灰防误触）。 */}
          <Button variant='primary' size='sm' disabled title={t('accounts.collectAllSoon')}>
            {t('accounts.collectAll')}
          </Button>
        </div>
        <div className={css.accountList}>
          {state.listError !== null && <p className={css.sidebarHint} role='alert'>{t(state.listError as Parameters<Translate>[0])}</p>}
          {state.accounts.length === 0
            ? <p className={css.sidebarHint}>{state.loading ? t('state.loading') : t('accounts.empty')}</p>
            : state.accounts.map(account => {
              const name = account.nickname ?? account.accountId
              const probing = state.probing.has(account.accountId)
              return (
                <article key={account.accountId} className={css.accountCard} aria-current={account.accountId === state.selectedId ? 'true' : undefined}>
                  <button type='button' className={css.accountCardMain} onClick={() => { machine.select(account.accountId) }}>
                    <span className={css.accountAvatar} aria-hidden='true'>
                      {account.avatar !== null
                        ? <img className={css.accountAvatarImg} src={account.avatar} alt='' loading='lazy' referrerPolicy='no-referrer' />
                        : name.slice(0, 2)}
                    </span>
                    <span className={css.accountCardBody}>
                      <span className={css.accountName} title={name}>{name}</span>
                      <span className={css.accountMeta}>
                        {account.lastCollectedAt !== null
                          ? t('accounts.syncLabel', { time: formatDateTime(account.lastCollectedAt) })
                          : '—'}
                      </span>
                      <span className={css.accountStateLine}>
                        <StateDot state={account.sessionStatus === 'ok' ? 'done' : account.sessionStatus === 'expired' ? 'error' : 'idle'} />
                        <span>{account.sessionStatus === 'ok' ? t('accounts.statusOk') : account.sessionStatus === 'expired' ? t('accounts.statusExpired') : t('accounts.statusUnknown')}</span>
                      </span>
                    </span>
                  </button>
                  {/* 操作按会话状态分流（视频号同款）：ok=检测、expired/unknown=重新登录、移除恒在（红字）。 */}
                  <div className={css.accountActions}>
                    {account.sessionStatus === 'ok'
                      ? (
                        <Button variant='ghost' size='sm' disabled={probing || anyRunning}
                          onClick={() => { void machine.probeNow(account.accountId) }}>
                          {probing ? t('accounts.probing') : t('accounts.probe')}
                        </Button>
                      )
                      : (
                        <Button variant='ghost' size='sm' disabled={loginWaiting || anyRunning}
                          onClick={() => { void machine.beginLoginFlow({ accountId: account.accountId }) }}>
                          {t('accounts.relogin')}
                        </Button>
                      )}
                    <Button variant='ghost' size='sm' className={css.dangerButton} disabled={anyRunning}
                      onClick={() => { setRemoving(account) }}>
                      {t('accounts.removeLocal')}
                    </Button>
                  </div>
                </article>
              )
            })}
        </div>
        <Button variant='primary' className={css.addAccountButton} disabled={loginWaiting}
          onClick={() => { void machine.beginLoginFlow({}) }}>
          {t('accounts.add')}
        </Button>
        {loginWaiting && (
          <p className={css.sidebarHint} role='status'>
            <StateDot state='ongoing' /> {t('accounts.loginWaiting')}
          </p>
        )}
      </aside>
      <div className={css.accountsMain}>
        {state.notice !== null && <NoticeBar notice={state.notice} machine={machine} t={t} />}
        {selected !== null
          ? (
              <>
                {/* 右栏工具栏（对齐视频号）：采集本账号 + 刷新（浅灰实心）+ 最近采集时间。 */}
                <div className={css.accountsMainBar}>
                  <Button
                    variant='primary'
                    size='sm'
                    aria-busy={collectRunning || undefined}
                    disabled={collectRunning || anyRunning}
                    onClick={() => { void machine.startCollectFlow(selected.accountId) }}
                  >
                    {collectRunning
                      ? t('accounts.collecting', { pages: state.collect?.pagesDone ?? 0, notes: state.collect?.notesTotal ?? 0 })
                      : t('accounts.collectData')}
                  </Button>
                  {/* 刷新按钮对齐视频号：outline sm + 文案「刷新」。 */}
                  <Button
                    variant='outline'
                    size='sm'
                    disabled={anyRunning}
                    aria-busy={collectRunning || undefined}
                    onClick={() => { void machine.probeNow(selected.accountId) }}
                  >
                    {t('accounts.refreshData')}
                  </Button>
                  {capturedAt !== null && capturedAt !== undefined && (
                    <span className={css.toolbarNote}>{t('accounts.lastCollected', { time: formatDateTime(capturedAt) })}</span>
                  )}
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

/** 右栏基本数据卡（账号信息不重复展示：昵称与授权状态在左栏卡片；缺口提示不补 0）。 */
function AccountSummary(props: { account: AccountRow; t: Translate }): ReactNode {
  const { account, t } = props
  const summary = account.summary ?? null
  const totals = summary?.totals ?? { plays: undefined, likes: undefined, collects: undefined, comments: undefined, shares: undefined } as Record<string, number | undefined>
  const gaps = summary?.gaps ?? {} as Record<string, number | undefined>
  const stats: Array<{ key: Parameters<Translate>[0]; value: string; gap: number | undefined }> = [
    { key: 'accounts.statNotes', value: summary !== null ? formatCount(summary.notesCount) : '—', gap: undefined },
    { key: 'accounts.statPlays', value: formatCount(totals.plays), gap: gaps.plays },
    { key: 'accounts.statLikes', value: formatCount(totals.likes), gap: gaps.likes },
    { key: 'accounts.statCollects', value: formatCount(totals.collects), gap: gaps.collects },
    { key: 'accounts.statComments', value: formatCount(totals.comments), gap: gaps.comments },
    { key: 'accounts.statShares', value: formatCount(totals.shares), gap: gaps.shares },
  ]
  return (
    <section className={css.accountsCard} aria-label={t('accounts.basicData')}>
      <h3 className={css.hbPanelTitle}>{t('accounts.basicData')}</h3>
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
  )
}

/** 计数展示：≥1w 缩写为 x.xw（去尾零）；非法/缺失 → —（不补 0，不编造）。 */
function formatCount(value: unknown): string {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return '—'
  if (num >= 10_000) {
    const w = num / 10_000
    const text = w >= 100 ? String(Math.round(w)) : w.toFixed(1).replace(/\.0$/u, '')
    return `${text}w`
  }
  return String(num)
}

/** ISO → `YYYY-MM-DD HH:mm`；非法 → —。 */
function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
