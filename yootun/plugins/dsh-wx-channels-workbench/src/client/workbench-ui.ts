/**
 * 视频号工作台页面 UI 态与视图类型（自 WorkbenchPage 迁出）：两 tab、
 * browser 五态、账号目录与选中、作品排序/翻页镜像、总览筛选、中断横幅、
 * toast，以及选中驱动轮询路的记录与运行中集合投影。五条数据流（登录/
 * 单账号采集/批量采集/作品查询/挂载恢复）在 flows.ts 的四 machine 里，
 * 经 useSyncExternalStore 订阅；本模块只持有布局与提示态。
 * @module
 */
import { DEFAULT_OVERVIEW_FILTERS, type OverviewFilters } from './OverviewPage.tsx'
import { DEFAULT_SORT_STATE, type SortState } from './works-format.ts'
import type { BrowserState, InterruptedView } from './schema.ts'

export type { BrowserState } from './schema.ts'

/** 账号卡片视图（accounts.list 投影）。 */
export interface AccountRow {
  accountId: string
  nickname: string | null
  avatar: string | null
  feedCount: number | null
  followerTotalCount: number | null
  sessionStatus: string
  sessionCheckedAt: string | null
  lastCollectedAt: string | null
  deleteState: string
  isPending: boolean
  hasStorageState: boolean
  localCredentialsMissing?: boolean
}

/** 单账号采集状态投影（collect.status 的 collect 字段）。 */
export interface SingleCollectRecord {
  accountId: string | null
  status: string | null
  progress: Record<string, unknown> | null
  error: string | null
}

/** 作品列表页大小（固定 10，不提供页大小选择）。 */
export const WORKS_PAGE_SIZE = 10

/** 采集/登录/批量共用轮询间隔毫秒。 */
export const POLL_MS = 1200

/** 三 tab 固定顺序（作品数据 → 账号总览 → 报表）。 */
export type TabValue = 'works' | 'overview' | 'report'

/** SegmentedTabs 条目（id/panelId 供 aria 关联）。 */
export interface TabItem { value: TabValue; label: string; id: string; panelId: string }
/** 账号目录读取态。 */
export type LoadState = 'loading' | 'ready' | 'error'

/** 页面级 toast：短暂成功 / 失败反馈（进度与刷新提示在各自就地位置）。 */
export interface ToastState { text: string; tone: 'success' | undefined; seq: number }

/** 页面 UI 态（数据流 machine 之外的布局与提示态）。 */
export interface WorkbenchUiState {
  tab: TabValue
  browser: BrowserState
  accounts: AccountRow[]
  remoteOk: boolean
  accountsState: LoadState
  selectedAccountId: string | null
  /** 作品排序/翻页镜像（machine 持真值；WorksPanel 展示用）。 */
  worksSort: SortState
  worksPage: number
  refreshing: boolean
  refreshFailedParts: string[]
  /** 账号总览筛选（页面级持有，切 tab 保留；表格行选中同走这套筛选）。 */
  overviewFilters: OverviewFilters
  /** 2.5 中断横幅：Host 启动中断摘要；关闭标记为页面会话内，不持久化。 */
  interrupted: InterruptedView | null
  bannerDismissed: boolean
  toast: ToastState | null
  toastSeq: number
  /** 选中驱动轮询路的运行中记录（发起/恢复路记录在 collect machine）。 */
  selectedRecord: SingleCollectRecord | null
  /** 选中驱动轮询路的运行中集合投影（响应即权威替换）。 */
  runningIds: string[]
}

/** 页面 UI 态动作。 */
export type WorkbenchUiAction =
  | { type: 'selectTab'; value: TabValue }
  | { type: 'browser'; state: BrowserState }
  | { type: 'accountsLoaded'; rows: AccountRow[]; remoteOk: boolean }
  | { type: 'accountsFailed' }
  | { type: 'selectAccount'; accountId: string | null }
  | { type: 'worksSort'; sort: SortState }
  | { type: 'worksPage'; page: number }
  | { type: 'filters'; filters: OverviewFilters }
  | { type: 'interrupted'; view: InterruptedView | null }
  | { type: 'started' }
  | { type: 'bannerDismissed' }
  | { type: 'refreshStart' }
  | { type: 'refreshDone'; failedParts: string[] }
  | { type: 'notify'; text: string; tone: 'success' | undefined }
  | { type: 'toastDone' }
  | { type: 'selectedRecord'; record: SingleCollectRecord | null }
  | { type: 'runningIds'; ids: string[] }

/** 页面 UI 态初值。 */
export function initialWorkbenchUi(): WorkbenchUiState {
  return {
    tab: 'works',
    browser: 'loading',
    accounts: [],
    remoteOk: true,
    accountsState: 'loading',
    selectedAccountId: null,
    worksSort: DEFAULT_SORT_STATE,
    worksPage: 1,
    refreshing: false,
    refreshFailedParts: [],
    overviewFilters: DEFAULT_OVERVIEW_FILTERS,
    interrupted: null,
    bannerDismissed: false,
    toast: null,
    toastSeq: 0,
    selectedRecord: null,
    runningIds: [],
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
      return { ...state, tab: action.value }
    case 'browser':
      return { ...state, browser: action.state }
    case 'accountsLoaded': {
      const keep = state.selectedAccountId !== null && action.rows.some(row => row.accountId === state.selectedAccountId)
      const fallback = keep
        ? state.selectedAccountId
        : action.rows.find(row => row.deleteState !== 'remote_deleted')?.accountId ?? null
      return { ...state, accounts: action.rows, remoteOk: action.remoteOk, accountsState: 'ready', selectedAccountId: fallback }
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
    case 'selectedRecord':
      return { ...state, selectedRecord: action.record }
    case 'runningIds':
      return { ...state, runningIds: action.ids }
    default: {
      const exhaustive: never = action
      void exhaustive
      return state
    }
  }
}
