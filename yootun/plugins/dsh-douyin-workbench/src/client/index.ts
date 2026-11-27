/**
 * 抖音工作台 client 半：root `main` 中央面板 + `sidebar.panellist` 入口
 * （plugin-ui-ux §2.1：一个业务域一个面板、locale-aware 名称、order；与
 * wx/xhs 工作台面板相邻位）。词典 zh 为键集事实源；页面组件经 ctx.effect 注册
 * 并在卸载时释放。
 * @module
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { zh, en, NS, type DouyinLocaleKey } from './locales.ts'
import './kit-styles.ts'
import { WorkbenchIcon } from './WorkbenchIcon.tsx'
import { WorkbenchPage, type WorkbenchPageProps } from './WorkbenchPage.tsx'

export { HOST_PATH, hostAction, type HostResponse } from './api.ts'
export { NS, zh, en, type DouyinLocaleKey } from './locales.ts'
export { WorkbenchPage, type WorkbenchLocale, type WorkbenchPageProps, type Translate } from './WorkbenchPage.tsx'
export { validatePromotionForm, type PromotionInvalidKey } from './PromotionModal.tsx'
export { progressTextOf } from './WorksPanel.tsx'
export {
  batchReasonKey, deltaText, domainErrorText,
  fanDelta, formatAgeBucket, formatCount, formatDateTime, formatDuration, formatPercent, formatSeconds,
  genderLabel, gapFieldLabel, gapReasonText, hotLabelText, nextWorkSort, retentionStatus,
  retentionStatusKey, safeHttpUrl, safeWorkUrl, shiftDay, trafficSourceLabel,
  DEFAULT_WORK_SORT, localeTagOf, type WorkSortKey, type WorkSortState,
} from './format.ts'
export {
  comparePublishDate, compareRowId, buildServerSnapshot, readAccounts, readBatchStatus,
  readBrowserState, readCollectStatus, readLogin, readOverview, readAnalysis, readAccountTrend,
  readAiAnalysis, readReportDetail, readReportList, readScheduleRow, readScheduleRows,
  readWorkDetail, readWorkRows, readWorksPage, readWorkTrend, toScheduleUiRow, SCHEDULE_PLATFORMS,
  type AccountRow, type BatchView, type CollectView, type ScheduleUiRow, type WorkRow,
  type WorksPage, type WorksSummary,
} from './schema.ts'
export { accountTrendRows, workTrendRows } from './charts.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 抖音工作台文案。 */
    'yootun.douyinWorkbench': DouyinLocaleKey
  }
}

/** 中央面板 id（branded）。 */
export const PANEL_ID = 'douyin-workbench' as MainPanelId
/** sidebar 入口 order（与 wx/xhs 工作台并列的自有面板位）。 */
export const PANEL_ORDER = 52

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Mount the central panel and the sidebar entry.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'yootun-douyin-workbench: dictionaries')

  // WorkbenchPage 的 locale 座位：箭头包装 ctx.locale 的同名方法（类实例解构
  // 后 this 丢失），getSnapshot 返回官方冻结快照对象本身（引用稳定，uSES 要求）。
  const locale: WorkbenchPageProps['locale'] = {
    subscribe: (fn) => ctx.locale.subscribe(fn),
    getSnapshot: () => ctx.locale.getSnapshot(),
  }

  const injected = (): WorkbenchPageProps => ({
    locale,
    t: (key, values) => {
      const text = t(key)
      if (values === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (match, token: string) => {
        const value = values[token]
        return value === undefined ? match : String(value)
      })
    },
  })

  ctx.effect(() => {
    const withdrawMain = ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main',
      key: PANEL_ID,
      locale: NS,
      inject: injected,
    }, WorkbenchPage))
    const withdrawEntry = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: PANEL_ORDER,
      locale: NS,
      label: () => t('panel'),
    }, WorkbenchIcon))
    return () => {
      withdrawEntry()
      withdrawMain()
    }
  }, 'yootun-douyin-workbench: main + panellist')
}
