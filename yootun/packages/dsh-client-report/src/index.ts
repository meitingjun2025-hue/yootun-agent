/**
 * 报表业务页共享包（纯 client，非插件）：两个工作台的 AI 报表页共用一份页面
 * 组件、读取器、组合趋势图、词典与样式。请求函数、错误文案、文件名前缀、幂
 * 等键前缀与作品卡指标布局由插件注入；本包不得被任何 Host 侧模块引用（桶导
 * 出会把组件与样式表带进宿主 bundle）。原子控件来自官方
 * `@deepseek-ai/dsh-client-ui-primitives`，数据卡与状态族来自
 * `@yootun/dsh-client-ui-kit`；词典 zh 为键集事实源，en 全量同步。
 * @module @yootun/dsh-client-report
 */

export { ReportPage, type ReportPageProps, type ReportWorkLayout } from './report-page.tsx'
export {
  readReportList, readReportDetail,
  type ReportListItem, type ReportMetric, type ReportWork, type ReportAccountRow, type ReportDetail,
} from './schema.ts'
export {
  NS, zh, en, REPORT_REASONS_ZH, REPORT_REASONS_EN, REPORT_ERROR_CODES,
  type ReportLocaleKey, type ReportTranslate, type ReportErrorCode, type ReportReasonKey,
} from './locales.ts'
