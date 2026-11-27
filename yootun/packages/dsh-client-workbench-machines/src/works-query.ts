/**
 * 作品查询 machine：服务端分页排序，缓存键 = 账号|排序|方向|页；命中缓存先
 * 同步出缓存（W1）再后台刷新；序号 + 账号 + 查询键三重守卫，过期响应整体
 * 丢弃（W2）；请求失败且该账号已有行 → partial、无行 → error（W3）。
 * @module
 */
import { createLatest, type LatestGuard } from './guards.ts'
import type { MachineStore } from './types.ts'

/** 排序态（key/方向由消费方声明，machine 只把它并进缓存键）。 */
export interface WorksSortLike {
  key?: string | null
  direction?: 'asc' | 'desc' | string | null
}

/** 作品页查询结果（行与总数由适配层投影；summary 随页透传，缓存命中一并还原）。 */
export interface WorksPageLike<WorkRow, Summary = undefined> {
  rows: WorkRow[]
  total: number
  summary?: Summary
}

/** 作品查询 machine 的注入面。 */
export interface WorksQueryPorts<WorkRow, Summary = undefined> {
  /** 拉取一页作品（works.list），失败时抛出。 */
  list(query: { accountId: string; sortKey: string; order: 'asc' | 'desc'; limit: number; offset: number }): Promise<WorksPageLike<WorkRow, Summary>>
  /** 每页条数（缺省 10）。 */
  pageSize: number
}

/** 作品查询 machine 状态。 */
export interface WorksQueryState<WorkRow, Summary = undefined> {
  rows: WorkRow[]
  total: number
  /** 最近一次落屏页的适配层摘要（页未带摘要投影时为 null）。 */
  summary: Summary | null
  /** 最近一次 load 的目标账号（页面切号判定用；'' = 尚未加载）。 */
  accountId: string
  /** loading / ready / error / partial（同账号已有行 + 本次失败）。 */
  loadState: 'loading' | 'ready' | 'error' | 'partial'
  /** 请求在途。 */
  busy: boolean
}

/** 作品查询 machine。 */
export interface WorksQuery<WorkRow, Summary = undefined> extends MachineStore<WorksQueryState<WorkRow, Summary>> {
  /**
   * 拉取一页（无 override 时取当前排序态与页码；排序/翻页变化由调用方显式
   * 传）。命中缓存先即时渲染再后台刷新；切换账号清空已渲染行。
   * @param accountId - 目标账号。
   * @param override - 显式页码/排序（排序与翻页入口传）。
   */
  load(accountId: string, override?: { page?: number; sort?: WorksSortLike }): Promise<boolean>
  /** 使该账号的缓存失效（采集完成后数据可能变化）。 */
  invalidateCache(accountId: string): void
}

/**
 * Create a works query machine. 查询键 = 账号|排序|方向|页；同账号晚返回的旧
 * 结果被守卫丢弃；换账号清空行（不做跨账号复用）。
 * @param ports - 注入面。
 * @returns the machine.
 */
export function createWorksQuery<WorkRow, Summary = undefined>(ports: WorksQueryPorts<WorkRow, Summary>): WorksQuery<WorkRow, Summary> {
  let state: WorksQueryState<WorkRow, Summary> = { rows: [], total: 0, summary: null, accountId: '', loadState: 'loading', busy: false }
  const listeners = new Set<() => void>()
  const guard: LatestGuard = createLatest()
  const cache = new Map<string, WorksPageLike<WorkRow, Summary>>()
  let sortKey = 'publish_time'
  let direction: 'asc' | 'desc' = 'desc'
  let page = 1
  let queryKey = ''
  let accountId = ''
  /** 已落屏行所属账号：partial 保留只对同账号成立。 */
  let rowsAccount = ''

  const set = (next: WorksQueryState<WorkRow, Summary>): void => {
    state = next
    listeners.forEach(listener => listener())
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    async load(targetAccount, override) {
      const sort = override?.sort
      if (sort !== undefined) {
        sortKey = sort.key ?? 'publish_time'
        direction = sort.direction === 'asc' ? 'asc' : 'desc'
      }
      page = Math.max(1, override?.page ?? page)
      const order = direction
      const key = `${targetAccount}|${sortKey}|${order}|${page}`
      const seq = guard.take()
      accountId = targetAccount
      queryKey = key
      const cached = cache.get(key)
      const resume = rowsAccount === targetAccount
      if (cached !== undefined) {
        rowsAccount = targetAccount
        set({ rows: cached.rows, total: cached.total, summary: cached.summary === undefined ? null : cached.summary, accountId: targetAccount, loadState: 'ready', busy: true })
      } else if (!resume) {
        rowsAccount = ''
        set({ rows: [], total: 0, summary: null, accountId: targetAccount, loadState: 'loading', busy: true })
      } else {
        set({ ...state, accountId: targetAccount, busy: true })
      }
      try {
        const view = await ports.list({
          accountId: targetAccount,
          sortKey,
          order,
          limit: ports.pageSize,
          offset: (page - 1) * ports.pageSize,
        })
        if (!guard.isCurrent(seq) || accountId !== targetAccount || queryKey !== key) return true
        cache.set(key, view)
        rowsAccount = targetAccount
        set({ rows: view.rows, total: view.total, summary: view.summary === undefined ? null : view.summary, accountId: targetAccount, loadState: 'ready', busy: false })
        return true
      } catch {
        if (!guard.isCurrent(seq) || accountId !== targetAccount || queryKey !== key) return true
        const sameAccountRows = rowsAccount === targetAccount && state.rows.length > 0
        set({ ...state, loadState: sameAccountRows ? 'partial' : 'error', busy: false })
        return false
      }
    },

    invalidateCache(targetAccount) {
      for (const key of [...cache.keys()]) {
        if (key.startsWith(`${targetAccount}|`)) cache.delete(key)
      }
    },
  }
}
