/**
 * 抖音工作台页面 UI 态（自 WorkbenchPage 迁出）：Tab keep-alive、browser
 * 五态、账号目录与选中、作品排序/翻页镜像、总览筛选、中断横幅、toast。
 * 数据流（登录/单账号采集/批量采集/作品查询/挂载恢复）在 flows.ts 的四
 * machine 里，经 useSyncExternalStore 订阅；本模块只持有布局与提示态。
 * @module
 */
import { DEFAULT_WORK_SORT, type WorkSortState } from './format.ts'
import { DEFAULT_OVERVIEW_FILTERS, type OverviewFilters } from './OverviewPage.tsx'
import type { AccountRow, BrowserState, InterruptedView } from './schema.ts'

/** 页面值固定 7 个（账号总览/账号作品/发布排期看板/爆款素材看板/爆款拆解/爆款基因库/AI 报表）。 */
export type TabValue = 'overview' | 'works' | 'schedule' | 'material' | 'breakdown' | 'gene' | 'report'

/** 顶级导航分组（4 组：数据/创作/素材与知识/报表；组内顺序即二级顺序）。 */
export type TabGroup = 'data' | 'create' | 'material' | 'report'

/** 组 → 组内页面（首个为选中该组时的默认页）。 */
export const GROUP_TABS: Readonly<Record<TabGroup, readonly [TabValue, ...TabValue[]]>> = {
  data: ['works', 'overview'],
  create: ['schedule'],
  material: ['material', 'breakdown', 'gene'],
  report: ['report'],
}

/** 由页面值反查所属组。 */
export function groupOf(tab: TabValue): TabGroup {
  for (const group of Object.keys(GROUP_TABS) as TabGroup[]) {
    if (GROUP_TABS[group].includes(tab)) return group
  }
  return 'report'
}

/**
 * 组内页面 → 二级段选项（页数 ≤1 的组不渲染二级控件，返回 null）。
 * @param group - 顶级组。
 * @param label - 页面值的词典文案。
 * @returns the segment options in group order, or null.
 */
export function subTabsOf(group: TabGroup, label: (page: TabValue) => string): readonly [SubTabItem, ...SubTabItem[]] | null {
  const [first, ...rest] = GROUP_TABS[group]
  if (first === undefined || rest.length === 0) return null
  return [{ value: first, label: label(first) }, ...rest.map(page => ({ value: page, label: label(page) }))]
}

/** SegmentedTabs 条目（id/panelId 供 aria 关联）。 */
export interface TabItem { value: TabValue; label: string; id: string; panelId: string }
/** 顶级组条目（SegmentedTabs 的 Value 泛型为 TabGroup）。 */
export interface GroupTabItem { value: TabGroup; label: string; id: string; panelId: string }
/** 二级页面段（SegmentedControlOption 形态）。 */
export interface SubTabItem { value: TabValue; label: string }
/** 账号目录读取态。 */
export type LoadState = 'loading' | 'ready' | 'error'
export type { BrowserState } from './schema.ts'

/** 页面级 toast。 */
export interface ToastState { text: string; tone: 'success' | undefined; seq: number }

/** 页面 UI 态（数据流 machine 之外的布局与提示态）。 */
export interface WorkbenchUiState {
  tab: TabValue
  browser: BrowserState
  accounts: AccountRow[]
  accountsState: LoadState
  selectedAccountId: string | null
  /** 作品排序/翻页镜像（machine 持真值；WorksPanel 展示用）。 */
  worksSort: WorkSortState
  worksPage: number
  refreshing: boolean
  refreshFailedParts: string[]
  overviewFilters: OverviewFilters
  analysisAccountId: string | null
  /** 素材看板「去拆解」跨 Tab 预填：切爆款拆解 Tab 并带入链接（不自动开始）。 */
  breakdownPrefill: string | null
  /** D6–D8 keep-alive：首次访问后保持 mounted，未访问过的 Tab 不 eager mount。 */
  visitedTabs: readonly TabValue[]
  /** 各组最近一次所在页面（切走再切回恢复上页；组内重选才回默认页）。 */
  lastPageByGroup: Readonly<Record<TabGroup, TabValue>>
  /** 2.5 中断横幅：Host 启动中断摘要；关闭标记为页面会话内，不持久化。 */
  interrupted: InterruptedView | null
  bannerDismissed: boolean
  toast: ToastState | null
  toastSeq: number
}

/** 页面 UI 态动作。 */
export type WorkbenchUiAction =
  | { type: 'selectTab'; value: TabValue }
  | { type: 'selectGroup'; group: TabGroup }
  | { type: 'browser'; state: BrowserState }
  | { type: 'accountsLoaded'; rows: AccountRow[] }
  | { type: 'accountsFailed' }
  | { type: 'selectAccount'; accountId: string | null }
  | { type: 'worksSort'; sort: WorkSortState }
  | { type: 'worksPage'; page: number }
  | { type: 'filters'; filters: OverviewFilters }
  | { type: 'filtersCalibrate'; update: (previous: OverviewFilters) => OverviewFilters }
  | { type: 'analysis'; accountId: string | null }
  | { type: 'breakdownPrefill'; url: string | null }
  | { type: 'interrupted'; view: InterruptedView | null }
  | { type: 'started' }
  | { type: 'bannerDismissed' }
  | { type: 'refreshStart' }
  | { type: 'refreshDone'; failedParts: string[] }
  | { type: 'notify'; text: string; tone: 'success' | undefined }
  | { type: 'toastDone' }

/** 页面 UI 态初值。应用启动默认落在「账号作品」（账号管理栏与所选账号的
 * 作品列表是日常最常用的一屏）；已访问集合同步以 works 起步。 */
export function initialWorkbenchUi(): WorkbenchUiState {
  return {
    tab: 'works',
    browser: 'loading',
    accounts: [],
    accountsState: 'loading',
    selectedAccountId: null,
    worksSort: DEFAULT_WORK_SORT,
    worksPage: 1,
    refreshing: false,
    refreshFailedParts: [],
    overviewFilters: DEFAULT_OVERVIEW_FILTERS,
    analysisAccountId: null,
    breakdownPrefill: null,
    visitedTabs: ['works'],
    lastPageByGroup: { data: 'works', create: 'schedule', material: 'material', report: 'report' },
    interrupted: null,
    bannerDismissed: false,
    toast: null,
    toastSeq: 0,
  }
}

/**
 * 页面 UI 态归约。账号目录就绪时保持仍有效的选中账号，否则回退第一个可用
 * 账号（原页 refreshAccounts 的 setSelectedAccountId 口径）。
 * @param state - 前一次状态。
 * @param action - 动作。
 * @returns the next state.
 */
export function workbenchReducer(state: WorkbenchUiState, action: WorkbenchUiAction): WorkbenchUiState {
  switch (action.type) {
    case 'selectTab':
      return {
        ...state,
        tab: action.value,
        visitedTabs: state.visitedTabs.includes(action.value) ? state.visitedTabs : [...state.visitedTabs, action.value],
        lastPageByGroup: { ...state.lastPageByGroup, [groupOf(action.value)]: action.value },
      }
    case 'selectGroup': {
      // 点顶级组：组内重选 → 回该组默认页；从别的组切回 → 恢复该组上一次页面。
      const target = state.lastPageByGroup[action.group]
      const next = groupOf(state.tab) === action.group ? GROUP_TABS[action.group][0] : target
      return workbenchReducer(state, { type: 'selectTab', value: next })
    }
    case 'browser':
      return { ...state, browser: action.state }
    case 'accountsLoaded': {
      const keep = state.selectedAccountId !== null && action.rows.some(row => row.accountId === state.selectedAccountId)
      const fallback = keep
        ? state.selectedAccountId
        : action.rows.find(row => row.deleteState !== 'remote_deleted')?.accountId ?? null
      return { ...state, accounts: action.rows, accountsState: 'ready', selectedAccountId: fallback }
    }
    case 'accountsFailed':
      return { ...state, accountsState: 'error' }
    case 'selectAccount':
      return { ...state, selectedAccountId: action.accountId }
    case 'worksSort':
      return { ...state, worksSort: action.sort }
    case 'worksPage':
      return { ...state, worksPage: action.page }
    case 'filters':
      return { ...state, overviewFilters: action.filters }
    case 'filtersCalibrate':
      return { ...state, overviewFilters: action.update(state.overviewFilters) }
    case 'analysis':
      return { ...state, analysisAccountId: action.accountId }
    case 'breakdownPrefill':
      return { ...state, breakdownPrefill: action.url }
    case 'interrupted':
      return { ...state, interrupted: action.view }
    case 'started':
      // 启动成功：Host 已清启动中断摘要，页面横幅随之收起并重置关闭标记。
      return { ...state, interrupted: null, bannerDismissed: false }
    case 'bannerDismissed':
      return { ...state, bannerDismissed: true }
    case 'refreshStart':
      return { ...state, refreshing: true, refreshFailedParts: [] }
    case 'refreshDone':
      return { ...state, refreshing: false, refreshFailedParts: action.failedParts }
    case 'notify': {
      const seq = state.toastSeq + 1
      return { ...state, toastSeq: seq, toast: { text: action.text, tone: action.tone, seq } }
    }
    case 'toastDone':
      return { ...state, toast: null }
    default: {
      const exhaustive: never = action
      void exhaustive
      return state
    }
  }
}
