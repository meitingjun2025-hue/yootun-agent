/**
 * 视频号工作台中央面板：全量接线 browser.status / 登录流 / 账号管理 /
 * 单账号采集 / 批量采集 / 作品 / 总览 / 画像。
 * @module
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataCard, DataState, KpiCard, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import css from './workbench.module.css'
import type { WxLocaleKey } from './locales.ts'

export type Translate = (key: WxLocaleKey, values?: Record<string, string | number>) => string

export interface AccountRow {
  accountId: string
  nickname: string | null
  feedCount: number | null
  sessionStatus: string
  isPending: boolean
  hasStorageState: boolean
  localCredentialsMissing?: boolean
}

interface CollectRecord { accountId?: string; status?: string; progress?: Record<string, unknown>; error?: string | null }
interface BatchStatusData { ready?: boolean; phase?: string; currentAccountId?: string | null; completedCount?: number; partialCount?: number; failedCount?: number; skippedCount?: number; total?: number }
interface WorkRow { work_id?: string; workId?: string; title?: string | null; play_count?: number | null; playCount?: number | null; like_count?: number | null; likeCount?: number | null; publish_time?: string | null; publishTime?: string | null }

export interface WorkbenchPageProps { t: Translate }

type TabValue = 'overview' | 'works' | 'collect' | 'accounts'
type LoadState = 'loading' | 'empty' | 'error' | 'partial' | 'ready'

/** 页面组件：全量接线 Host API。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const t = props.t
  const [tab, setTab] = useState<TabValue>('overview')
  const [browser, setBrowser] = useState<{ chrome: string; driver: string } | null>(null)
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [dataState, setDataState] = useState<LoadState>('loading')
  const [remoteOk, setRemoteOk] = useState(true)
  const [loginKey, setLoginKey] = useState<string | null>(null)
  const [loginState, setLoginState] = useState<string>('idle')
  const [loginReason, setLoginReason] = useState<string | null>(null)
  const [collect, setCollect] = useState<CollectRecord | null>(null)
  const [collectBusy, setCollectBusy] = useState(false)
  const [batch, setBatch] = useState<BatchStatusData | null>(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null)
  const [works, setWorks] = useState<WorkRow[]>([])
  const [worksState, setWorksState] = useState<LoadState>('loading')
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null)
  const [overviewState, setOverviewState] = useState<LoadState>('loading')
  const [portrait, setPortrait] = useState<Record<string, unknown> | null>(null)
  const [portraitState, setPortraitState] = useState<LoadState>('loading')
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const collectPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeAccountId = selectedAccountId ?? accounts.find(row => row.sessionStatus === 'ok' && !row.isPending)?.accountId ?? ''

  const refreshAccounts = useCallback(async (): Promise<void> => {
    try {
      const res = await hostAction('accounts.list')
      setAccounts(Array.isArray(res.accounts) ? res.accounts as AccountRow[] : [])
      setRemoteOk(res.remoteOk !== false)
      setDataState('ready')
    } catch { setDataState('error') }
  }, [])

  useEffect(() => {
    void hostAction('browser.status').then(res => {
      setBrowser({ chrome: String(res.chrome ?? 'missing'), driver: String(res.driver ?? 'missing') })
    }).catch(() => setBrowser({ chrome: 'missing', driver: 'missing' }))
    void refreshAccounts()
  }, [refreshAccounts])

  const startLoginPolling = useCallback((key: string): void => {
    setLoginKey(key)
    setLoginState('waiting_qr')
    if (loginPollRef.current !== null) clearInterval(loginPollRef.current)
    loginPollRef.current = setInterval(() => {
      void hostAction('account.loginStatus', { accountId: key }).then(res => {
        const s = String(res.state ?? 'idle')
        setLoginState(s)
        setLoginReason(res.reason !== undefined && res.reason !== null ? String(res.reason) : null)
        if (s === 'ok' || s === 'timeout' || s === 'failed') {
          if (loginPollRef.current !== null) { clearInterval(loginPollRef.current); loginPollRef.current = null }
          void refreshAccounts()
        }
      }).catch(() => undefined)
    }, 2000)
  }, [refreshAccounts])

  const beginLogin = useCallback(async (): Promise<void> => {
    const res = await hostAction('account.beginLogin', {})
    if (typeof res.loginKey === 'string') startLoginPolling(res.loginKey)
  }, [startLoginPolling])

  const refreshQr = useCallback(async (): Promise<void> => {
    const key = loginKey ?? ''
    if (key !== '') {
      await hostAction('account.refreshLoginQr', { accountId: key })
      setLoginState('waiting_qr')
      // 重新启动轮询。
      startLoginPolling(key)
    }
  }, [loginKey, startLoginPolling])

  useEffect(() => () => {
    if (loginPollRef.current !== null) clearInterval(loginPollRef.current)
    if (collectPollRef.current !== null) clearInterval(collectPollRef.current)
    if (batchPollRef.current !== null) clearInterval(batchPollRef.current)
  }, [])

  const loadWorks = useCallback(async (accountId: string): Promise<void> => {
    setWorksState('loading')
    try {
      const res = await hostAction('works.list', { accountId })
      setWorks(Array.isArray(res.works) ? res.works as WorkRow[] : [])
      setWorksState('ready')
    } catch { setWorksState('error') }
  }, [])

  const loadOverview = useCallback(async (accountId: string): Promise<void> => {
    setOverviewState('loading')
    try {
      const res = await hostAction('account.overview', { accountId })
      setOverview(res)
      setOverviewState('ready')
    } catch { setOverviewState('error') }
  }, [])

  const loadPortrait = useCallback(async (accountId: string): Promise<void> => {
    setPortraitState('loading')
    try {
      const res = await hostAction('fans.profile.get', { accountId })
      setPortrait(res)
      setPortraitState('ready')
    } catch { setPortraitState('error') }
  }, [])


  useEffect(() => {
    if (tab === 'works' && activeAccountId !== '') void loadWorks(activeAccountId)
    if (tab === 'overview' && activeAccountId !== '') { void loadOverview(activeAccountId); void loadPortrait(activeAccountId) }
  }, [tab, activeAccountId, loadWorks, loadOverview, loadPortrait])

  const startCollect = useCallback(async (accountId: string): Promise<void> => {
    await hostAction('collect.start', { accountId })
    setCollectBusy(true)
    if (collectPollRef.current !== null) clearInterval(collectPollRef.current)
    collectPollRef.current = setInterval(() => {
      void hostAction('collect.status', {}).then(res => {
        const record = res.collect as CollectRecord | null
        setCollect(record)
        setCollectBusy(res.busy === true)
        if (res.busy !== true) {
          if (collectPollRef.current !== null) { clearInterval(collectPollRef.current); collectPollRef.current = null }
          void refreshAccounts()
        }
      }).catch(() => undefined)
    }, 2000)
  }, [refreshAccounts])

  const cancelCollect = useCallback(async (accountId: string): Promise<void> => {
    await hostAction('collect.cancel', { accountId })
  }, [])

  const startBatch = useCallback(async (): Promise<void> => {
    await hostAction('collectAll.start', {})
    setBatchRunning(true)
    if (batchPollRef.current !== null) clearInterval(batchPollRef.current)
    batchPollRef.current = setInterval(() => {
      void hostAction('collectAll.status', {}).then(res => {
        setBatch(res as unknown as BatchStatusData)
        setBatchRunning(res.ready !== true)
        if (res.ready === true) {
          if (batchPollRef.current !== null) { clearInterval(batchPollRef.current); batchPollRef.current = null }
          void refreshAccounts()
        }
      }).catch(() => undefined)
    }, 2000)
  }, [refreshAccounts])

  const cancelBatch = useCallback(async (): Promise<void> => {
    await hostAction('collectAll.cancel', {})
  }, [])

  const removeAccount = useCallback(async (accountId: string): Promise<void> => {
    await hostAction('account.removeLocal', { accountId })
    await hostAction('account.removeRemote', { accountId })
    await refreshAccounts()
  }, [refreshAccounts])

  const browserBlocking = browser !== null && (browser.chrome === 'missing' || browser.driver === 'missing')
  const tabs = [
    { value: 'overview' as const, label: t('tab.overview'), id: 'wx-tab-overview', panelId: 'wx-panel-overview' },
    { value: 'works' as const, label: t('tab.works'), id: 'wx-tab-works', panelId: 'wx-panel-works' },
    { value: 'collect' as const, label: t('tab.collect'), id: 'wx-tab-collect', panelId: 'wx-panel-collect' },
    { value: 'accounts' as const, label: t('tab.accounts'), id: 'wx-tab-accounts', panelId: 'wx-panel-accounts' },
  ]
  const worksTotal = accounts.reduce((sum, row) => sum + (row.feedCount ?? 0), 0)
  const sessionOk = accounts.filter(row => row.sessionStatus === 'ok').length

  // 阻断门。
  if (browserBlocking) {
    return (
      <PluginPageShell label={t('panel')}>
        <div className={css.blockingGate} role='alert'>
          <p>{browser?.chrome === 'missing' ? t('browser.missing') : t('browser.driverMissing')}</p>
          <p>{t('error.CHROME')}</p>
        </div>
      </PluginPageShell>
    )
  }

  // overview 字段提取（tools 返回 metrics.totals / fans_trend.totals）。
  const overviewRecord = overview as Record<string, unknown> | null
  const metrics = overviewRecord?.metrics as { totals?: Record<string, unknown> } | undefined
  const totals = metrics?.totals ?? {}
  const fansTotals = (overviewRecord?.fans_trend as { totals?: Record<string, unknown> } | undefined)?.totals ?? {}

  const portraitRecord = portrait as Record<string, unknown> | null
  const fansProfile = portraitRecord?.fans_profile as Record<string, unknown> | undefined

  return (
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
      {loginState !== 'idle' && loginState !== 'ok' && (
        <DataCard title={t('login.loginKey')} state='ready'>
          <div className={css.loginCard}>
            <span>{t(`login.state.${loginState}` as WxLocaleKey)}</span>
            {loginReason !== null && <span className={css.loginReason}>{`${t('login.reason')}: ${loginReason}`}</span>}
            <Button variant='ghost' size='sm' onClick={() => { void refreshQr() }}>{t('login.refreshQr')}</Button>
          </div>
        </DataCard>
      )}
      <div className={css.tabs}>
        <SegmentedTabs items={tabs as unknown as readonly [{ value: TabValue; label: string; id: string; panelId: string }, ...Array<{ value: TabValue; label: string; id: string; panelId: string }>]} value={tab} onChange={setTab} label={t('panel')} />
      </div>
      <div id='wx-panel-body' role='tabpanel' aria-label={t('panel')}>
        <DataState state={dataState === 'ready' ? (accounts.length === 0 ? 'empty' : 'ready') : dataState} shape='rows' onRetry={() => { void refreshAccounts() }}>
          <div className={css.kpis}>
            <KpiCard label={t('kpi.works')} value={String(worksTotal)} />
            <KpiCard label={t('account.sessionOk')} value={String(sessionOk)} />
            <KpiCard label={t('tab.accounts')} value={String(accounts.length)} />
            <KpiCard label={t('account.sessionExpired')} value={String(accounts.filter(row => row.sessionStatus === 'expired').length)} />
          </div>
          {tab === 'overview' && activeAccountId !== '' && (
            <>
              <DataCard title={t('overview.trend')} state={overviewState === 'ready' ? 'ready' : overviewState === 'error' ? 'error' : 'loading'} onRetry={() => { void loadOverview(activeAccountId) }}>
                {overviewState === 'ready' && (
                  <div className={css.kpis}>
                    <KpiCard label={t('kpi.play')} value={String(totals.play_count ?? totals.totalPlay ?? '—')} />
                    <KpiCard label={t('kpi.like')} value={String(totals.like_count ?? totals.totalLike ?? '—')} />
                    <KpiCard label={t('kpi.follow')} value={String(fansTotals.follower_net_count ?? fansTotals.followerChange ?? '—')} />
                    <KpiCard label={t('kpi.works')} value={String(totals.work_count ?? worksTotal)} />
                  </div>
                )}
              </DataCard>
              <DataCard title={t('overview.portrait')} state={portraitState === 'ready' ? (fansProfile !== undefined && fansProfile.age != null ? 'ready' : 'empty') : portraitState} onRetry={() => { void loadPortrait(activeAccountId) }}>
                {portraitState === 'ready' && (
                  fansProfile !== undefined && fansProfile.age != null
                    ? <div className={css.collectStatus}>{t('portrait.age')}: {String((fansProfile.age as Array<{ key: string }>).length)} 项</div>
                    : <div className={css.collectStatus}>{t('portrait.noData')}</div>
                )}
              </DataCard>
            </>
          )}
          {tab === 'overview' && activeAccountId === '' && (
            <DataCard title={t('tab.overview')} state='empty'>
              <div className={css.collectStatus}>{t('account.select')}</div>
            </DataCard>
          )}
          {tab === 'works' && activeAccountId !== '' && (
            <DataCard title={t('works.title')} state={worksState === 'ready' ? (works.length === 0 ? 'empty' : 'ready') : worksState} onRetry={() => { void loadWorks(activeAccountId) }}>
              <ul className={css.workList}>
                {works.map(row => {
                  const wid = row.work_id ?? row.workId ?? ''
                  const title = row.title ?? wid
                  const play = row.play_count ?? row.playCount ?? '—'
                  const pub = row.publish_time ?? row.publishTime ?? ''
                  return (
                    <li key={wid} className={css.workRow} title={title}>
                      <span className={css.workTitle}>{title}</span>
                      <span className={css.workMeta}>{String(play)} · {pub}</span>
                    </li>
                  )
                })}
              </ul>
            </DataCard>
          )}
          {tab === 'works' && activeAccountId === '' && (
            <DataCard title={t('works.title')} state='empty'>
              <div className={css.collectStatus}>{t('account.select')}</div>
            </DataCard>
          )}
          {tab === 'collect' && (
            <DataCard title={t('collect.progress')} state='ready'
              actions={(
                <>
                  <Button variant='ghost' size='sm' disabled={batchRunning} onClick={() => { void startBatch() }}>{t('collect.collectAll')}</Button>
                  <Button variant='ghost' size='sm' disabled={!batchRunning} onClick={() => { void cancelBatch() }}>{t('collect.cancel')}</Button>
                </>
              )}
            >
              <div className={css.collectStatus}>
                {collectBusy && collect !== null && (
                  <p>{collect.accountId}: {collect.status ?? ''}</p>
                )}
                {batchRunning && batch !== null && (
                  <p>{t('collect.batch.current')}: {batch.currentAccountId ?? '—'} · {t('collect.batch.total', { total: batch.total ?? 0 })}</p>
                )}
              </div>
              <Button variant='ghost' size='sm' disabled={activeAccountId === '' || collectBusy} onClick={() => { void startCollect(activeAccountId) }}>{t('collect.start')}</Button>
              <Button variant='ghost' size='sm' disabled={activeAccountId === '' || !collectBusy} onClick={() => { void cancelCollect(activeAccountId) }}>{t('collect.cancel')}</Button>
            </DataCard>
          )}
          {tab === 'accounts' && (
            <DataCard title={t('tab.accounts')} state='ready'>
              <ul className={css.accountList}>
                {accounts.map(row => (
                  <li key={row.accountId} className={css.accountRow}>
                    <button type='button' className={css.accountName} title={row.nickname ?? row.accountId} onClick={() => setSelectedAccountId(row.accountId)}>
                      {row.nickname ?? row.accountId}
                    </button>
                    <span className={css.accountIdText}>{row.accountId}</span>
                    <StateDot state={row.sessionStatus === 'ok' ? 'done' : row.sessionStatus === 'expired' ? 'error' : 'idle'} />
                    <span className={css.accountState}>{row.sessionStatus === 'ok' ? t('account.sessionOk') : row.sessionStatus === 'expired' ? t('account.sessionExpired') : t('account.sessionUnknown')}</span>
                    {row.localCredentialsMissing === true && <span className={css.accountState}>{t('account.localMissing')}</span>}
                    <Button variant='ghost' size='sm' onClick={() => { void removeAccount(row.accountId) }}
                      aria-label={`${t('account.remove')}: ${row.nickname ?? row.accountId}`}>
                      {t('account.remove')}
                    </Button>
                  </li>
                ))}
              </ul>
            </DataCard>
          )}
        </DataState>
      </div>
    </PluginPageShell>
  )
}
