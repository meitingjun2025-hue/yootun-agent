/**
 * 抖音工作台中央面板：顶级导航 4 组（数据/创作/素材与知识/报表），数据与
 * 素材与知识两组带组内二级 SegmentedControl；页面值仍为 7 个，D6/D7/D8 三
 * 页首次访问后 keep-alive（非当前页用 hidden 从可访问树移除；Breakdown
 * archive/workflow 轮询跨页继续，Material 离开停/重进恢复，Gene 无轮询、
 * 重进重拉；未访问过的页不 eager mount；inactive 期间官方 Modal portal
 * 不泄漏，open 状态保留待切回恢复）。布局与组合层：五条数据流（登录、单
 * 账号采集、批量采集、作品查询、挂载恢复）在 flows.ts 的四 machine 里，
 * 由 use-workbench-page.tsx 订阅并接线；弹层与导出在 use-workbench-modals.ts
 * （统一详情、负责人、投流、Excel）。AI 报表 Tab 由共享包
 * `@yootun/dsh-client-report` 的 ReportPage 承载（请求与错误文案经本插件
 * 注入）。语言标签取 locale 座位的官方快照 active id（不再词典比对）；素材
 * 看板「去拆解」经 breakdownPrefill 跨页
 * 预填链接（不自动开始）。
 * @module
 */
import { type ReactNode } from 'react'
import { SegmentedControl, SegmentedTabs, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { ReportPage, en as reportEn, zh as reportZh, type ReportLocaleKey, type ReportWorkLayout } from '@yootun/dsh-client-report'
import { DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import css from './workbench.module.css'
import { domainErrorText, type Translate } from './format.ts'
import { hostAction } from './api.ts'
import { AccountSidebar } from './AccountSidebar.tsx'
import { AnalysisPage } from './AnalysisPage.tsx'
import { BreakdownPage } from './BreakdownPage.tsx'
import { GenePage } from './GenePage.tsx'
import { MaterialPage } from './MaterialPage.tsx'
import { OwnerModal } from './OwnerModal.tsx'
import { OverviewPage } from './OverviewPage.tsx'
import { PromotionModal } from './PromotionModal.tsx'
import { SchedulePage } from './SchedulePage.tsx'
import { useDouyinWorkbenchPage } from './use-workbench-page.tsx'
import { WorkDetailModal } from './WorkDetailModal.tsx'
import { WorksPanel } from './WorksPanel.tsx'

export type { Translate } from './format.ts'
export type { AccountRow, CollectView } from './schema.ts'
export type { GroupTabItem, SubTabItem, TabGroup, TabItem, TabValue, WorkbenchUiAction, WorkbenchUiState } from './workbench-ui.ts'

/**
 * 报表作品卡的指标布局（与既有作品卡一一对应）：主行播放/点赞/评论/净涨粉，
 * 次要行收藏/分享/5s 完播/2s 跳出/平均观看时长，进度条 5s 完播率。共用词条
 * （播放/点赞/评论）经插件词典解析；报表词条（净增粉丝与次要行 label）经
 * 共享包词典按语言取值，次要行渲染文本与迁移前的词典模板替换逐字一致。
 */
function reportWorkLayout(t: Translate, localeTag: 'zh' | 'en'): ReportWorkLayout {
  const r: Record<ReportLocaleKey, string> = localeTag === 'zh' ? reportZh : reportEn
  return {
    primary: [
      { key: 'plays', label: t('col.play') },
      { key: 'likes', label: t('col.like') },
      { key: 'comments', label: t('col.comment') },
      { key: 'fansGain', label: r['report.col.netFans'] },
    ],
    secondary: [
      { key: 'collects', label: r['report.work.collect'], kind: 'count' },
      { key: 'shares', label: r['report.work.share'], kind: 'count' },
      { key: 'completion5s', label: r['report.work.completion5s'], kind: 'percent' },
      { key: 'bounce2s', label: r['report.work.bounce2s'], kind: 'percent' },
      { key: 'avgWatchSeconds', label: r['report.work.avgWatch'], kind: 'seconds' },
    ],
    progress: { key: 'completion5s', kind: 'percent', label: r['report.work.completion5s'] },
  }
}

/** locale 服务的订阅座位（官方 LocaleFace 的 subscribe/getSnapshot 投影）。 */
export interface WorkbenchLocale {
  /** 快照变化通知；返回退订函数。 */
  subscribe(fn: () => void): () => void
  /** 当前快照（两次变化之间引用稳定）。 */
  getSnapshot(): { active: string }
}

export interface WorkbenchPageProps { t: Translate; locale: WorkbenchLocale }

/** 页面组件：4 组导航（组内二级段）与数据流 machine 的组合。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const {
    t, localeTag, kitTranslate,
    tab, group, groupTabs, subTabs, subLabel, panelLabelledBy,
    accounts, accountsState, selectedAccountId, selectedAccount, activeAccountId,
    worksSort, worksPage, overviewFilters, analysisAccountId, breakdownPrefill, visitedTabs,
    interrupted, bannerDismissed, refreshing, refreshFailedParts, toast,
    collectRecord, collectBusy, collectStartReason, batch, batchBusy, collectingAccountIds, loginActive,
    browserBlocking, works, worksState, worksTotal, worksBusy, worksSummary,
    headerStatus, rangeLabel,
    selectTab, selectGroup, openAccountAnalysis, beginLogin, startCollect, startBatch, loadWorks, changeWorksSort, changeWorksPage,
    refreshAll, refreshAccounts, notify,
    setToast, setOverviewFilters, setSelectedAccountId, setAnalysisAccountId, setBreakdownPrefill, setBannerDismissed,
    detailTarget, detail, detailState, trendRows, openDetail, closeDetail, openHotWork,
    ownerModal, setOwnerModal, ownerSaving, saveOwner, openPromotion, promotionModal, setPromotionModal, promotionSaving, savePromotion,
    exporting, exportWorks,
  } = useDouyinWorkbenchPage(props)
  // 「数据」组两个页面共用账号管理栏；总览页点账号卡 = 选中并进入单账号分析。
  const dataLayoutVisible = tab === 'works' || (tab === 'overview' && analysisAccountId === null)

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
          <SegmentedTabs items={groupTabs} value={group} onChange={selectGroup} label={t('panel')} />
        </div>
        {subTabs !== null && (
          <div className={css.subTabsRow}>
            <SegmentedControl id='dy-tab-sub' value={tab} options={subTabs} onChange={selectTab} label={subLabel} />
          </div>
        )}

        <DataState
          state={accountsState === 'ready' || (accountsState === 'error' && accounts.length > 0) ? 'ready' : accountsState}
          shape='rows'
          onRetry={() => { void refreshAccounts() }}
        >
          <div id='dy-panel-body' role='tabpanel' aria-labelledby={panelLabelledBy} className={css.panelBodyFlex}>
            {dataLayoutVisible && (
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
                  onSelect={tab === 'overview' ? openAccountAnalysis : setSelectedAccountId}
                  onCollectAll={startBatch}
                  onRelogin={beginLogin}
                  onAddAccount={beginLogin}
                  onAccountsChanged={refreshAccounts}
                  onNotice={notify}
                />
                <section className={css.worksPanel} aria-label={tab === 'works' ? t('tab.works') : t('tab.overview')}>
                  {tab === 'overview' && analysisAccountId === null && (
                    <OverviewPage
                      t={t}
                      localeTag={localeTag}
                      filters={overviewFilters}
                      onFiltersChange={setOverviewFilters}
                      onOpenAccount={openAccountAnalysis}
                      onOpenWork={openHotWork}
                      onNotice={notify}
                    />
                  )}
                  {tab === 'works' && (
                    <>
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
                    </>
                  )}
                </section>
              </div>
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
              <ReportPage
                request={hostAction}
                locale={localeTag}
                errorText={code => domainErrorText('report', code, t)}
                onNotice={notify}
                filePrefix={t('report.filePrefix')}
                regenerateKeyPrefix='douyin:report_regenerate'
                requestFailedCode='douyin_operation_request_failed'
                work={reportWorkLayout(t, localeTag)}
              />
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
