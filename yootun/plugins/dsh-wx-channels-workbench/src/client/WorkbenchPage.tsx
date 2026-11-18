/**
 * 视频号工作台中央面板：browser.status 五态门（loading / available / chrome
 * missing / driver missing / Host API error，API error 不伪造成 chrome 缺失）、
 * 登录流、账号选择与四个数据页 tab（总览 / 作品 / 采集 / 账号）。数据页由
 * OverviewTab / WorksTab / CollectTab / AccountsTab 承担。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  createKitTranslate, DataCard, DataState, KpiCard, KitLocaleProvider, PluginHeader, PluginPageShell,
} from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import { reasonText, type Translate } from './format.ts'
import css from './workbench.module.css'
import { zh as wxZh } from './locales.ts'
import { readBrowserState, type BrowserState } from './schema.ts'
import { AccountsTab } from './AccountsTab.tsx'
import { CollectTab } from './CollectTab.tsx'
import { OverviewTab } from './OverviewTab.tsx'
import { WorksTab } from './WorksTab.tsx'

export type { Translate } from './format.ts'

export interface AccountRow {
  accountId: string
  nickname: string | null
  feedCount: number | null
  sessionStatus: string
  isPending: boolean
  hasStorageState: boolean
  localCredentialsMissing?: boolean
}

/** 登录卡状态（key 是 account.beginLogin 返回的 loginKey）。 */
interface LoginCardState { key: string; state: string; reason: string | null }

export interface WorkbenchPageProps { t: Translate }

type TabValue = 'overview' | 'works' | 'collect' | 'accounts'
type LoadState = 'loading' | 'empty' | 'error' | 'ready'

interface TabItem { value: TabValue; label: string; id: string; panelId: string }

/** 页面组件：全量接线 Host API。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<TabValue>('overview')
  const [browser, setBrowser] = useState<BrowserState>('loading')
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [dataState, setDataState] = useState<LoadState>('loading')
  const [remoteOk, setRemoteOk] = useState(true)
  const [loginState, setLoginState] = useState<LoginCardState | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // kit 组件内部文案跟随插件已解析语言（词典逐键不同，逐键等价判定可靠）。
  const kitTranslate = t('panel') === wxZh.panel ? createKitTranslate(kitZh) : createKitTranslate(kitEn)

  const refreshAccounts = useCallback(async (): Promise<void> => {
    try {
      const res = await hostAction('accounts.list')
      setAccounts(Array.isArray(res.accounts) ? res.accounts as AccountRow[] : [])
      setRemoteOk(res.remoteOk !== false)
      setDataState('ready')
    } catch { setDataState('error') }
  }, [])

  useEffect(() => {
    void refreshAccounts()
    return () => {
      if (loginPollRef.current !== null) { clearInterval(loginPollRef.current); loginPollRef.current = null }
    }
  }, [refreshAccounts])

  const checkBrowser = useCallback((): void => {
    setBrowser('loading')
    hostAction('browser.status').then(res => {
      setBrowser(readBrowserState(res))
    }).catch(() => { setBrowser('api_error') })
  }, [])

  useEffect(() => { checkBrowser() }, [checkBrowser])

  const startLoginPolling = useCallback((key: string): void => {
    setLoginState({ key, state: 'waiting_qr', reason: null })
    if (loginPollRef.current !== null) clearInterval(loginPollRef.current)
    loginPollRef.current = setInterval(() => {
      void hostAction('account.loginStatus', { accountId: key }).then(res => {
        const state = String(res.state ?? 'idle')
        setLoginState({
          key,
          state,
          reason: res.reason !== undefined && res.reason !== null ? String(res.reason) : null,
        })
        if (state === 'ok' || state === 'timeout' || state === 'failed') {
          if (loginPollRef.current !== null) { clearInterval(loginPollRef.current); loginPollRef.current = null }
          void refreshAccounts()
        }
      }).catch(() => undefined)
    }, 2000)
  }, [refreshAccounts])

  const beginLogin = useCallback(async (accountId?: string): Promise<void> => {
    try {
      const res = await hostAction('account.beginLogin', accountId !== undefined ? { accountId } : {})
      if (typeof res.loginKey === 'string') startLoginPolling(res.loginKey)
    } catch (error) {
      setLoginState({ key: accountId ?? '', state: 'failed', reason: error instanceof Error ? error.message : 'unknown' })
    }
  }, [startLoginPolling])

  const refreshQr = useCallback(async (): Promise<void> => {
    if (loginState === null) return
    await hostAction('account.refreshLoginQr', { accountId: loginState.key }).catch(() => undefined)
    startLoginPolling(loginState.key)
  }, [loginState, startLoginPolling])

  const activeAccountId = selectedAccountId
    ?? accounts.find(row => row.sessionStatus === 'ok' && !row.isPending)?.accountId
    ?? accounts[0]?.accountId
    ?? ''

  const selectAccount = useCallback((accountId: string): void => {
    setSelectedAccountId(accountId)
  }, [])

  const browserBlocking = browser === 'chrome_missing' || browser === 'driver_missing'
  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'overview', label: t('tab.overview'), id: 'wx-tab-overview', panelId: 'wx-panel-overview' },
    { value: 'works', label: t('tab.works'), id: 'wx-tab-works', panelId: 'wx-panel-works' },
    { value: 'collect', label: t('tab.collect'), id: 'wx-tab-collect', panelId: 'wx-panel-collect' },
    { value: 'accounts', label: t('tab.accounts'), id: 'wx-tab-accounts', panelId: 'wx-panel-accounts' },
  ]
  const sessionOk = accounts.filter(row => row.sessionStatus === 'ok').length

  // 阻断门：仅 chrome / driver 缺失整页阻断；API error 不伪装成缺失。
  if (browserBlocking) {
    return (
      <PluginPageShell label={t('panel')}>
        <KitLocaleProvider value={kitTranslate}>
          <div className={css.blockingGate} role='alert'>
            <p>{browser === 'chrome_missing' ? t('browser.missing') : t('browser.driverMissing')}</p>
            <p>{browser === 'chrome_missing' ? t('error.CHROME') : t('error.CHROME_DRIVER')}</p>
            <Button variant='outline' size='sm' onClick={checkBrowser}>{t('browser.recheck')}</Button>
          </div>
        </KitLocaleProvider>
      </PluginPageShell>
    )
  }

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={remoteOk ? `${t('account.sessionOk')}: ${String(sessionOk)}` : t('state.partial')}
            primaryAction={<Button variant='primary' size='md' onClick={() => { void beginLogin() }}>{t('account.scan')}</Button>}
            actions={<Button variant='ghost' size='md' onClick={() => { void refreshAccounts() }} aria-label={t('header.refresh')}>{t('header.refresh')}</Button>}
          />
        )}
      >
        {browser === 'loading' && (
          <div className={css.browserBar} role='status'>
            <span>{t('browser.checking')}</span>
          </div>
        )}
        {browser === 'api_error' && (
          <div className={css.reasonBanner} role='alert'>
            <span className={css.reasonText}>{t('browser.apiError')}</span>
            <Button variant='outline' size='sm' onClick={checkBrowser}>{t('browser.recheck')}</Button>
          </div>
        )}
        {browser === 'available' && (
          <div className={css.browserBar} role='status'>
            <span>{t('browser.ok')}</span>
          </div>
        )}
        {loginState !== null && loginState.state !== 'ok' && (
          <DataCard title={t('login.loginKey')} state='ready'>
            <div className={css.loginCard}>
              <span>{loginText(loginState.state, t)}</span>
              {loginState.reason !== null && (
                <span className={css.loginReason}>{`${t('login.reason')}: ${reasonText(loginState.reason, t)}`}</span>
              )}
              {(loginState.state === 'waiting_qr' || loginState.state === 'waiting_confirm') && (
                <Button variant='ghost' size='sm' onClick={() => { void refreshQr() }}>{t('login.refreshQr')}</Button>
              )}
              {(loginState.state === 'timeout' || loginState.state === 'failed') && (
                <Button variant='ghost' size='sm' onClick={() => { void beginLogin() }}>{t('account.scan')}</Button>
              )}
            </div>
          </DataCard>
        )}
        <div className={css.tabs}>
          <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('panel')} />
        </div>
        <div id='wx-panel-body' role='tabpanel' aria-label={t('panel')}>
          <DataState state={dataState === 'ready' ? (accounts.length === 0 ? 'empty' : 'ready') : dataState} shape='rows' onRetry={() => { void refreshAccounts() }}>
            <div className={css.kpis}>
              <KpiCard label={t('kpi.works')} value={String(accounts.reduce((sum, row) => sum + (row.feedCount ?? 0), 0))} />
              <KpiCard label={t('account.sessionOk')} value={String(sessionOk)} />
              <KpiCard label={t('tab.accounts')} value={String(accounts.length)} />
              <KpiCard label={t('account.sessionExpired')} value={String(accounts.filter(row => row.sessionStatus === 'expired').length)} />
            </div>
            {tab === 'overview' && (
              accounts.length === 0
                ? <DataCard title={t('tab.overview')} state='empty'><p className={css.collectStatus}>{t('account.select')}</p></DataCard>
                : <OverviewTab t={t} accounts={accounts} activeAccountId={activeAccountId} onSelectAccount={selectAccount} />
            )}
            {tab === 'works' && (
              activeAccountId === ''
                ? <DataCard title={t('works.title')} state='empty'><p className={css.collectStatus}>{t('account.select')}</p></DataCard>
                : <WorksTab t={t} activeAccountId={activeAccountId} />
            )}
            {tab === 'collect' && <CollectTab t={t} activeAccountId={activeAccountId} />}
            {tab === 'accounts' && (
              <AccountsTab
                t={t}
                accounts={accounts}
                onRemoved={refreshAccounts}
                onLoginRequested={accountId => { void beginLogin(accountId) }}
                onSelectAccount={selectAccount}
              />
            )}
          </DataState>
        </div>
      </PluginPageShell>
    </KitLocaleProvider>
  )
}

/** 登录流状态 → 文案（含终态 reason 由调用方单独呈现）。 */
function loginText(state: string, t: Translate): string {
  switch (state) {
    case 'waiting_qr': return t('login.state.waiting_qr')
    case 'waiting_confirm': return t('login.state.waiting_confirm')
    case 'ok': return t('login.state.ok')
    case 'timeout': return t('login.state.timeout')
    case 'failed': return t('login.state.failed')
    default: return t('login.state.idle')
  }
}
