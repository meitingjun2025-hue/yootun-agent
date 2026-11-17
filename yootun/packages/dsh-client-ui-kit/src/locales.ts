/**
 * yootun 组件库 locale 词典：zh 为 key-set source of truth，en 全量同步
 * （分册规范 §七）。组件自身的固定文案全部经本词典；业务标题、数值与
 * 系列名是调用方 props，不进词典。
 * @module
 */

export const zh = {
  'chart.regionLabel': '图表',
  'chart.legendLabel': '图例',
  'state.loading': '正在加载…',
  'state.empty': '暂无数据',
  'state.error': '加载失败',
  'state.retry': '重试',
  'state.partial': '部分数据已展示，其余内容加载失败',
  'filter.label': '筛选',
  'filter.searchLabel': '搜索',
  'filter.searchClear': '清空搜索',
  'filter.clear': '清除',
  'filter.clearAll': '清除全部',
  'kpi.delta.up': '上升',
  'kpi.delta.down': '下降',
  'kpi.delta.flat': '持平',
  'legend.toggleOn': '隐藏系列 {series}',
  'legend.toggleOff': '显示系列 {series}',
  'dock.title': '插件助手',
  'dock.close': '收起',
  'dock.clear': '清空对话',
  'dock.status.live': '可用',
  'dock.status.loading': '连接中',
  'dock.status.unavailable': '暂不可用',
  'dock.context.remove': '移除引用 {context}',
  'dock.suggestTitle': '试试这样问',
  'dock.placeholder': '输入问题…',
  'dock.send': '发送',
  'dock.stop': '停止',
  'dock.sendDisabled.empty': '输入内容后再发送',
  'dock.sendDisabled.busy': '正在回复，可先停止',
  'dock.sendDisabled.model': '模型暂不可用',
  'dock.sendDisabled.unauthorized': '未激活，无法使用助手',
  'receipts.title': '操作回执',
  'receipts.undo': '撤销',
  'receipts.undone': '已撤销',
  'receipts.kind.success': '成功',
  'receipts.kind.failed': '失败',
  'receipts.kind.info': '说明',
} as const

/** The zh key set is the source of truth; en must match it exactly. */
export type YtKitLocaleKey = keyof typeof zh

export const en: Record<YtKitLocaleKey, string> = {
  'chart.regionLabel': 'Chart',
  'chart.legendLabel': 'Legend',
  'state.loading': 'Loading…',
  'state.empty': 'No data',
  'state.error': 'Failed to load',
  'state.retry': 'Retry',
  'state.partial': 'Partial data shown; the rest failed to load',
  'filter.label': 'Filters',
  'filter.searchLabel': 'Search',
  'filter.searchClear': 'Clear search',
  'filter.clear': 'Clear',
  'filter.clearAll': 'Clear all',
  'kpi.delta.up': 'up',
  'kpi.delta.down': 'down',
  'kpi.delta.flat': 'flat',
  'legend.toggleOn': 'Hide series {series}',
  'legend.toggleOff': 'Show series {series}',
  'dock.title': 'Plugin assistant',
  'dock.close': 'Collapse',
  'dock.clear': 'Clear conversation',
  'dock.status.live': 'Available',
  'dock.status.loading': 'Connecting',
  'dock.status.unavailable': 'Unavailable',
  'dock.context.remove': 'Remove reference {context}',
  'dock.suggestTitle': 'Try asking',
  'dock.placeholder': 'Type a question…',
  'dock.send': 'Send',
  'dock.stop': 'Stop',
  'dock.sendDisabled.empty': 'Type a question first',
  'dock.sendDisabled.busy': 'A reply is running; stop it first',
  'dock.sendDisabled.model': 'The model is unavailable',
  'dock.sendDisabled.unauthorized': 'Not activated; the assistant is unavailable',
  'receipts.title': 'Operation receipts',
  'receipts.undo': 'Undo',
  'receipts.undone': 'Undone',
  'receipts.kind.success': 'Success',
  'receipts.kind.failed': 'Failed',
  'receipts.kind.info': 'Notice',
}

/** Dictionary namespace owned by this library. */
export const NS = 'yootun.kit'

/** Placeholder tokens each zh/en pair must declare consistently. */
export const LOCALE_PLACEHOLDERS: Readonly<Partial<Record<YtKitLocaleKey, readonly string[]>>> = {
  'legend.toggleOn': ['{series}'],
  'legend.toggleOff': ['{series}'],
  'dock.context.remove': ['{context}'],
}
