/**
 * yootun 插件 UI 复合组件库（纯 client 库，非插件）：所有业务工作台 client 半
 * 共用的复合形态（分册规范 §8.1，含分页控件）。原子控件一律来自官方
 * `@deepseek-ai/dsh-client-ui-primitives`；颜色、间距、圆角、阴影、动效只映射
 * 官方 `--dsw-*` token 或本包集中定义的 `--yt-*` 语义变量；词典 zh 为键集
 * 事实源，en 全量同步。无 Tailwind、无全局 CSS、无 `!important`、无 body 选择器。
 * @module @yootun/dsh-client-ui-kit
 */

export { PluginPageShell, type PluginPageShellProps } from './page-shell.tsx'
export { PluginHeader, type PluginHeaderProps } from './plugin-header.tsx'
export { FilterBar, type FilterBarProps, type FilterChip } from './filter-bar.tsx'
export {
  FilterMenu,
  type FilterMenuItem,
  type FilterMenuProps,
} from './filter-menu.tsx'
export { DataCard, type DataCardProps } from './data-card.tsx'
export { KpiCard, type KpiCardProps, type KpiDeltaDirection } from './kpi-card.tsx'
export { Pager, type PagerProps } from './pager.tsx'
export { ChartFrame, type ChartFrameProps } from './chart-frame.tsx'
export { ChartLegend, type ChartLegendItem, type ChartLegendProps } from './chart-legend.tsx'
export { ChartTooltip, type ChartTooltipProps, type ChartTooltipRow } from './chart-tooltip.tsx'
export { DataState, type DataStateKind, type DataStateProps, type DataStateShape } from './data-state.tsx'
export { ReasonButton, type ReasonButtonProps } from './reason-button.tsx'
export { isOnInteractiveTarget, type GestureEventLike } from './row-gesture.ts'
export { AssistantDock, type AssistantContextChip, type AssistantDockProps, type AssistantMessage, type AssistantStatus } from './assistant-dock.tsx'
export { OperationReceipts, type OperationReceipt, type OperationReceiptsProps, type ReceiptKind } from './operation-receipts.tsx'
export { KitLocaleProvider, createKitTranslate, useKitLocale, type YtTranslate } from './kit-locale.ts'
export { NS, en, zh, LOCALE_PLACEHOLDERS, type YtKitLocaleKey } from './locales.ts'
export { YT_CHART_VARS, ytChartStyle, type YtChartColor } from './tokens.ts'
export {
  CHART_HEIGHT_MAX_PX, CHART_HEIGHT_MIN_PX, clampChartHeight, placeTooltip,
  type TooltipGeometry, type TooltipPlacement,
} from './chart-logic.ts'
export {
  composerKeyAction, sendDisabledReason, shouldStickToBottom,
  type ComposerKeyAction,
} from './composer-logic.ts'
export { HostActionError, createHostAction, type HostActionOptions, type HostResponse } from './host-action.ts'
export { createUploadTransport, type UploadTransportPaths, type UploadSessionInfo, type UploadStatusSnapshot } from './upload-transport.ts'
