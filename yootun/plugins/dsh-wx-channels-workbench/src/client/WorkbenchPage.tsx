/**
 * 视频号工作台中央面板：browser.status 五态、登录流、账号选择与三个数据页
 * tab（作品数据 / 账号总览 / 报表）。作品数据页为左侧账号管理栏 + 右侧
 * 作品面板的两列布局；账号总览页隐藏账号栏、全宽；AI 报表页由共享包
 * `@yootun/dsh-client-report` 的 ReportPage 承载（请求与错误文案经本插件
 * 注入，作品卡扩展区渲染流量来源与最大流失点），不 keep-alive，切走即卸载。
 * 单账号采集进度在作品工具栏按钮下方就地呈现；全账号采集面板在账号管理栏。
 * 布局与组合层：五条数据流（登录、单账号采集、批量采集、作品查询、挂载恢复）
 * 在 flows.ts 的四 machine 里，由 use-workbench-page.tsx 订阅并接线（摘要流
 * 与选中驱动第二路轮询也在该 hook）。语言标签取 locale 座位的官方快照
 * active id（不再词典比对）。
 * @module
 */
import { type ReactNode } from 'react'
import { SegmentedTabs, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { ReportPage, en as reportEn, zh as reportZh, type ReportLocaleKey, type ReportWork, type ReportWorkLayout } from '@yootun/dsh-client-report'
import { DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import css from './workbench.module.css'
import { formatCount, formatPct, reportErrorText, type Translate } from './format.ts'
import { hostAction } from './api.ts'
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

/**
 * 报表作品卡的指标布局（wx-report-client 实施单 2.1）：主行播放/点赞/评论/
 * 净涨粉，次要行收藏/分享/完播率/平均播放时长/快速划过率，进度条完播率。
 * 播放/点赞/评论与完播率、平均播放时长经插件词典解析；净增粉丝、收藏、分享
 * 经共享包词典按语言取值。
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
      { key: 'completionRate', label: t('col.completion'), kind: 'percent' },
      { key: 'avgPlaySeconds', label: t('col.avgDuration'), kind: 'seconds' },
      { key: 'fastFlipRate', label: t('col.fastFlip'), kind: 'percent' },
    ],
    progress: { key: 'completionRate', kind: 'percent', label: t('col.completion') },
  }
}

/** 流量来源条目读取：name 非空字符串、plays 有限数字才保留。 */
function readTrafficSource(value: unknown): { name: string; plays: number }[] {
  if (!Array.isArray(value)) return []
  const rows: { name: string; plays: number }[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const plays = typeof record.plays === 'number' && Number.isFinite(record.plays) ? record.plays : null
    if (name === '' || plays === null) continue
    rows.push({ name, plays })
  }
  return rows
}

/** 留存曲线摘要读取：三个字段都是有限数字才返回，否则整条丢弃。 */
function readRetention(value: unknown): { durationSeconds: number; maxLostSecond: number; retentionAtMaxLostPct: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const durationSeconds = num(record.durationSeconds)
  const maxLostSecond = num(record.maxLostSecond)
  const retentionAtMaxLostPct = num(record.retentionAtMaxLostPct)
  return durationSeconds !== null && maxLostSecond !== null && retentionAtMaxLostPct !== null
    ? { durationSeconds, maxLostSecond, retentionAtMaxLostPct }
    : null
}

/** 秒数一位小数（与共享包作品卡 seconds 指标同口径）。 */
function secondsText(value: number): string {
  return String(Math.round(value * 10) / 10)
}

/**
 * 作品卡扩展区（视频号特有，wx-report-client 实施单 2.1/2.6）：流量来源
 * （`extra.trafficSource`，`{name, plays}` 数组）与最大流失点（`extra.retention`，
 * `{durationSeconds, maxLostSecond, retentionAtMaxLostPct}`）。数据在
 * `work.extra` 原样保留，由本插件自行校验：形状不符的项整条丢弃，两项都不可
 * 渲染时不输出任何节点（不留空位）；行构图与共享包作品卡次要行同款。
 */
function renderWorkExtra(work: ReportWork, t: Translate, localeTag: 'zh' | 'en'): ReactNode {
  const rows: string[] = []
  const traffic = readTrafficSource(work.extra.trafficSource)
  if (traffic.length > 0) {
    rows.push(`${t('report.extra.trafficSource')} ${traffic.map(item => `${item.name} ${formatCount(item.plays, localeTag)}`).join(' · ')}`)
  }
  const retention = readRetention(work.extra.retention)
  if (retention !== null) {
    rows.push(t('report.extra.maxLost', { seconds: secondsText(retention.maxLostSecond), percent: formatPct(retention.retentionAtMaxLostPct) }))
    rows.push(t('report.extra.duration', { seconds: secondsText(retention.durationSeconds) }))
  }
  if (rows.length === 0) return null
  return <p className={css.reportExtra}>{rows.map(text => <span key={text}>{text}</span>)}</p>
}

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
            {tab === 'works' && (
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
            )}
            {tab === 'overview' && (
              <OverviewPage
                t={t}
                localeTag={localeTag}
                accounts={accounts}
                filters={overviewFilters}
                onFiltersChange={setOverviewFilters}
              />
            )}
            {tab === 'report' && (
              <ReportPage
                request={hostAction}
                locale={localeTag}
                errorText={code => reportErrorText(code, t)}
                onNotice={text => { notify(text) }}
                filePrefix={t('report.filePrefix')}
                regenerateKeyPrefix='wx:report_regenerate'
                work={reportWorkLayout(t, localeTag)}
                renderWorkExtra={work => renderWorkExtra(work, t, localeTag)}
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
