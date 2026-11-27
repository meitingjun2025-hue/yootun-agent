/**
 * 抖音工作台中央面板：7 Tab 固定顺序，D6/D7/D8 三 Tab 首次访问后 keep-alive
 * （非当前 Tab 用 hidden 从可访问树移除；Breakdown archive/workflow 轮询跨
 * Tab 继续，Material 离开停/重进恢复，Gene 无轮询、重进重拉；未访问过的
 * Tab 不 eager mount；inactive 期间官方 Modal portal 不泄漏，open 状态保留
 * 待切回恢复）。布局与组合层：五条数据流（登录、单账号采集、批量采集、作
 * 品查询、挂载恢复）在 flows.ts 的四 machine 里，由 use-workbench-page.ts
 * 订阅并接线；弹层与导出在 use-workbench-modals.ts（统一详情、负责人、投
 * 流、Excel）。语言标签取 locale 座位的官方快照 active id（不再词典比对）；
 * 素材看板「去拆解」经 breakdownPrefill 跨 Tab 预填链接（不自动开始）。
 * @module
 */
import { type ReactNode } from 'react'
import { SegmentedTabs, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import css from './workbench.module.css'
import { type Translate } from './format.ts'
import { AccountSidebar } from './AccountSidebar.tsx'
import { AnalysisPage } from './AnalysisPage.tsx'
import { BreakdownPage } from './BreakdownPage.tsx'
import { GenePage } from './GenePage.tsx'
import { MaterialPage } from './MaterialPage.tsx'
import { OwnerModal } from './OwnerModal.tsx'
import { OverviewPage } from './OverviewPage.tsx'
import { PromotionModal } from './PromotionModal.tsx'
import { ReportPage } from './ReportPage.tsx'
import { SchedulePage } from './SchedulePage.tsx'
import { useDouyinWorkbenchPage } from './use-workbench-page.tsx'
import { WorkDetailModal } from './WorkDetailModal.tsx'
import { WorksPanel } from './WorksPanel.tsx'

export type { Translate } from './format.ts'
export type { AccountRow, CollectView } from './schema.ts'
export type { TabItem, WorkbenchUiAction, WorkbenchUiState } from './workbench-ui.ts'

/** locale 服务的订阅座位（官方 LocaleFace 的 subscribe/getSnapshot 投影）。 */
export interface WorkbenchLocale {
  /** 快照变化通知；返回退订函数。 */
  subscribe(fn: () => void): () => void
  /** 当前快照（两次变化之间引用稳定）。 */
  getSnapshot(): { active: string }
}

export interface WorkbenchPageProps { t: Translate; locale: WorkbenchLocale }

/** 页面组件：7 Tab 布局与数据流 machine 的组合。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const {
    t, localeTag, kitTranslate,
    tab, accounts, accountsState, selectedAccountId, selectedAccount, activeAccountId,
    worksSort, worksPage, overviewFilters, analysisAccountId, breakdownPrefill, visitedTabs,
    interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
    collectRecord, collectBusy, collectStartReason, batch, batchBusy, collectingAccountIds, loginActive,
    browserBlocking, works, worksState, worksTotal, worksBusy, worksSummary,
    tabs, headerStatus, rangeLabel,
    selectTab, beginLogin, startCollect, startBatch, loadWorks, changeWorksSort, changeWorksPage,
    refreshAll, refreshAccounts, notify,
    setToast, setOverviewFilters, setSelectedAccountId, setAnalysisAccountId, setBreakdownPrefill, setBannerDismissed,
    detailTarget, detail, detailState, trendRows, openDetail, closeDetail, openHotWork,
    ownerModal, setOwnerModal, ownerSaving, saveOwner, openPromotion, promotionModal, setPromotionModal, promotionSaving, savePromotion,
    exporting, exportWorks,
  } = useDouyinWorkbenchPage(props)

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={t('panel.subtitle')}
            status={headerStatus}
          />
        )}
      >
        <div className={css.tabsRow}>
          <SegmentedTabs items={tabs} value={tab} onChange={selectTab} label={t('panel')} />
        </div>

        <DataState
          state={accountsState === 'ready' || (accountsState === 'error' && accounts.length > 0) ? 'ready' : accountsState}
          shape='rows'
          onRetry={() => { void refreshAccounts() }}
        >
          <div id='dy-panel-body' role='tabpanel' aria-label={t('panel')} className={css.panelBodyFlex}>
            {tab === 'overview' && analysisAccountId === null && (
              <OverviewPage
                t={t}
                localeTag={localeTag}
                filters={overviewFilters}
                onFiltersChange={setOverviewFilters}
                onOpenAccount={setAnalysisAccountId}
                onOpenWork={openHotWork}
                onNotice={notify}
              />
            )}
            {tab === 'overview' && analysisAccountId !== null && (
              <AnalysisPage
                t={t}
                localeTag={localeTag}
                accountId={analysisAccountId}
                rangeLabel={rangeLabel}
                onBack={() => { setAnalysisAccountId(null) }}
                onOpenWork={openHotWork}
                onNotice={notify}
              />
            )}
            {tab === 'works' && (
              <div className={css.worksLayout}>
                <AccountSidebar
                  t={t}
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  browserBlocked={browserBlocking}
                  loginActive={loginActive}
                  collectBusy={collectBusy}
                  batchBusy={batchBusy}
                  batch={batch}
                  collectingAccountIds={collectingAccountIds}
                  onSelect={setSelectedAccountId}
                  onCollectAll={startBatch}
                  onRelogin={beginLogin}
                  onAddAccount={beginLogin}
                  onAccountsChanged={refreshAccounts}
                  onNotice={notify}
                />
                <section className={css.worksPanel} aria-label={t('tab.works')}>
                  {bannerDismissed === false && interrupted !== null && batchBusy === false && (
                    <div className={css.interruptedBanner} role="status">
                      <span className={css.interruptedText}>
                        {interrupted.count >= 2 ? t('run.interruptedBanner', { count: interrupted.count }) : t('run.interruptedBannerOne')}
                      </span>
                      <span className={css.interruptedActions}>
                        {selectedAccountId !== null && interrupted.accountIds.includes(selectedAccountId) && (
                          <button
                            type="button"
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
                            type="button"
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
                          type="button"
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
                    worksPage={worksPage}
                    worksTotal={worksTotal}
                    worksSummary={worksSummary}
                    worksBusy={worksBusy}
                    onSortChange={changeWorksSort}
                    onPageChange={changeWorksPage}
                    onRetryWorks={() => { if (activeAccountId !== '') void loadWorks(activeAccountId) }}
                    collectBusy={collectBusy}
                    collectRecord={collectRecord}
                    collectStartReason={collectStartReason}
                    onStartCollect={startCollect}
                    batchRunning={batchBusy}
                    browserBlocked={browserBlocking}
                    refreshing={refreshing}
                    refreshFailedParts={refreshFailedParts}
                    onRefresh={() => { refreshAll(activeAccountId) }}
                    exporting={exporting}
                    onExport={exportWorks}
                    onOpenOwner={() => {
                      if (selectedAccount === null) return
                      setOwnerModal({
                        accountId: selectedAccount.accountId,
                        accountName: selectedAccount.nickname ?? selectedAccount.accountId,
                        ownerName: selectedAccount.ownerName ?? '',
                      })
                    }}
                    onOpenWork={openDetail}
                  />
                </section>
              </div>
            )}
            {tab === 'schedule' && (
              <SchedulePage t={t} accounts={accounts} accountsState={accountsState} />
            )}
            {visitedTabs.includes('material') && (
              <div className={css.tabPanel} hidden={tab !== 'material'}>
                <MaterialPage
                  t={t}
                  localeTag={localeTag}
                  active={tab === 'material'}
                  onNotice={notify}
                  onStartBreakdown={shareUrl => { selectTab('breakdown'); setBreakdownPrefill(shareUrl) }}
                />
              </div>
            )}
            {visitedTabs.includes('breakdown') && (
              <div className={css.tabPanel} hidden={tab !== 'breakdown'}>
                <BreakdownPage
                  t={t}
                  active={tab === 'breakdown'}
                  onNotice={notify}
                  prefill={breakdownPrefill}
                  onPrefillConsumed={() => { setBreakdownPrefill(null) }}
                />
              </div>
            )}
            {visitedTabs.includes('gene') && (
              <div className={css.tabPanel} hidden={tab !== 'gene'}>
                <GenePage t={t} localeTag={localeTag} active={tab === 'gene'} onNotice={notify} />
              </div>
            )}
            {tab === 'report' && (
              <ReportPage t={t} localeTag={localeTag} onNotice={notify} />
            )}
          </div>
        </DataState>

        <WorkDetailModal
          t={t}
          localeTag={localeTag}
          target={detailTarget}
          detail={detail}
          detailState={detailState}
          trend={trendRows}
          onRetry={() => { if (detailTarget !== null) openDetail(detailTarget.accountId, detailTarget.row) }}
          onClose={closeDetail}
          onOpenPromotion={openPromotion}
        />
        {ownerModal !== null && (
          <OwnerModal t={t} modal={ownerModal} saving={ownerSaving} onConfirm={saveOwner} onClose={() => { setOwnerModal(null) }} />
        )}
        {promotionModal !== null && (
          <PromotionModal
            key={promotionModal.recordId !== null ? `promotion-${promotionModal.recordId}` : 'promotion-new'}
            t={t}
            modal={promotionModal}
            saving={promotionSaving}
            onConfirm={savePromotion}
            onClose={() => { setPromotionModal(null) }}
          />
        )}
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
