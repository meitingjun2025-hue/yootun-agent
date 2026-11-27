/**
 * 视频号工作台中央面板：browser.status 五态、登录流、账号选择与两个数据页
 * tab（作品数据 / 账号总览）。作品数据页为左侧账号管理栏 + 右侧作品面板的
 * 两列布局；账号总览页隐藏账号栏、全宽。单账号采集进度在作品工具栏按钮下
 * 方就地呈现；全账号采集面板在账号管理栏。布局与组合层：五条数据流（登录、
 * 单账号采集、批量采集、作品查询、挂载恢复）在 flows.ts 的四 machine 里，
 * 由 use-workbench-page.tsx 订阅并接线（摘要流与选中驱动第二路轮询也在该
 * hook）。语言标签取 locale 座位的官方快照 active id（不再词典比对）。
 * @module
 */
import { type ReactNode } from 'react'
import { SegmentedTabs, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import css from './workbench.module.css'
import type { Translate } from './format.ts'
import { AccountSidebar } from './AccountSidebar.tsx'
import { OverviewPage } from './OverviewPage.tsx'
import { useWxWorkbenchPage } from './use-workbench-page.tsx'
import { WorksPanel } from './WorksPanel.tsx'

export type { Translate } from './format.ts'
export { WORKS_PAGE_SIZE } from './workbench-ui.ts'
export type { AccountRow, SingleCollectRecord, WorkbenchUiAction, WorkbenchUiState } from './workbench-ui.ts'

/** locale 服务的订阅座位（官方 LocaleFace 的 subscribe/getSnapshot 投影）。 */
export interface WorkbenchLocale {
  /** 快照变化通知；返回退订函数。 */
  subscribe(fn: () => void): () => void
  /** 当前快照（两次变化之间引用稳定）。 */
  getSnapshot(): { active: string }
}

export interface WorkbenchPageProps { t: Translate; locale: WorkbenchLocale }

/** 页面组件：两 tab 布局与数据流 machine 的组合。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const {
    t, localeTag, kitTranslate,
    tab, setTab, accounts, remoteOk, accountsState, selectedAccountId,
    worksSort, worksPage, overviewFilters, interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
    loginActive, collectRecord, collectStartReason, batch, collectingIds, collectBusy,
    browserBlocking, works, worksState, worksTotal, worksLatestCollectedAt, worksCompletionRate, worksBusy,
    summary, summaryState, summaryRefreshing,
    tabs, headerStatus,
    beginLogin, startCollect, cancelCollect, startBatch, cancelBatch,
    loadWorks, loadSummary, handleWorksSortChange, handleWorksPageChange, refreshAll, refreshAccounts, notify,
    setToast, setOverviewFilters, setSelectedAccountId, setBannerDismissed,
    activeAccountId, selectedAccount,
  } = useWxWorkbenchPage(props)

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={remoteOk ? t('panel.subtitle') : t('state.partial')}
            status={headerStatus}
          />
        )}
      >
        <div className={css.tabs}>
          <SegmentedTabs items={tabs} value={tab} onChange={setTab} label={t('panel')} />
        </div>

        <DataState
          state={accountsState === 'ready' || (accountsState === 'error' && accounts.length > 0) ? 'ready' : accountsState}
          shape='rows'
          onRetry={() => { void refreshAccounts() }}
        >
          <div id='wx-panel-body' role='tabpanel' aria-label={t('panel')}>
            {tab === 'works' ? (
              <div className={css.worksLayout}>
                <AccountSidebar
                  t={t}
                  localeTag={localeTag}
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  browserBlocked={browserBlocking}
                  loginActive={loginActive}
                  collectingIds={collectingIds}
                  batch={batch}
                  onSelect={setSelectedAccountId}
                  onCollectAll={startBatch}
                  onCancelBatch={cancelBatch}
                  onRelogin={beginLogin}
                  onAddAccount={beginLogin}
                  onAccountsChanged={refreshAccounts}
                  onNotice={text => { notify(text) }}
                />
                <section className={css.worksPanel} aria-label={t('tab.works')}>
                  {bannerDismissed === false && interrupted !== null && !(batch !== null && batch.ready === false) && (
                    <div className={css.interruptedBanner} role='status'>
                      <span className={css.interruptedText}>
                        {interrupted.count >= 2 ? t('run.interruptedBanner', { count: interrupted.count }) : t('run.interruptedBannerOne')}
                      </span>
                      <span className={css.interruptedActions}>
                        {selectedAccountId !== null && interrupted.accountIds.includes(selectedAccountId) && (
                          <button
                            type='button'
                            className={css.interruptedButton}
                            onClick={() => {
                              setBannerDismissed(true)
                              startCollect(selectedAccountId)
                            }}
                          >
                            {t('run.recollect')}
                          </button>
                        )}
                        {interrupted.count >= 2 && (
                          <button
                            type='button'
                            className={css.interruptedButton}
                            onClick={() => {
                              setBannerDismissed(true)
                              startBatch()
                            }}
                          >
                            {t('run.recollectAll')}
                          </button>
                        )}
                        <button
                          type='button'
                          className={css.interruptedClose}
                          aria-label={t('run.dismissBanner')}
                          onClick={() => { setBannerDismissed(true) }}
                        >
                          ×
                        </button>
                      </span>
                    </div>
                  )}
                  <WorksPanel
                    t={t}
                    localeTag={localeTag}
                    accountId={activeAccountId}
                    account={selectedAccount}
                    works={works}
                    worksState={worksState}
                    worksSort={worksSort}
                    onSortChange={handleWorksSortChange}
                    worksPage={worksPage}
                    worksTotal={worksTotal}
                    worksLatestCollectedAt={worksLatestCollectedAt}
                    worksCompletionRate={worksCompletionRate}
                    worksBusy={worksBusy}
                    onPageChange={handleWorksPageChange}
                    onRetryWorks={() => { if (activeAccountId !== '') void loadWorks(activeAccountId) }}
                    summary={summary}
                    summaryState={summaryState}
                    summaryRefreshing={summaryRefreshing}
                    onRetrySummary={() => { if (activeAccountId !== '') void loadSummary(activeAccountId) }}
                    collectBusy={collectBusy}
                    collectRecord={collectRecord}
                    collectStartReason={collectStartReason}
                    onStartCollect={startCollect}
                    onCancelCollect={cancelCollect}
                    batchRunning={batch !== null && batch.ready !== true && batch.phase !== 'finished'}
                    refreshing={refreshing}
                    refreshFailedParts={refreshFailedParts}
                    onRefresh={() => { refreshAll(activeAccountId) }}
                    browserBlocked={browserBlocking}
                  />
                </section>
              </div>
            ) : (
              <OverviewPage
                t={t}
                localeTag={localeTag}
                accounts={accounts}
                filters={overviewFilters}
                onFiltersChange={setOverviewFilters}
              />
            )}
          </div>
        </DataState>
        {toast !== null && (
          <Toast
            key={toast.seq}
            {...(toast.tone === 'success' ? { tone: 'success' as const } : {})}
            text={toast.text}
            onDone={() => { setToast(null) }}
          />
        )}
      </PluginPageShell>
    </KitLocaleProvider>
  )
}
