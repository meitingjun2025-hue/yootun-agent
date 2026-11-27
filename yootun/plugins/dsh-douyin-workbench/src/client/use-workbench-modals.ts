/**
 * 抖音工作台页面级弹层与导出流（自 WorkbenchPage 迁入，行为逐字保持）：
 * 统一作品详情弹层（跨账号显式 accountId；序号守卫）、负责人弹层（保存后
 * 账号列表刷新 + 筛选唯一一次重查校准）、投流弹层（PROMOTION_ALREADY_EXISTS
 * 自动重拉转更新）、Excel 导出（当前账号全量作品）。五条数据流 machine 之外
 * 的页面级编排；宿主调用经 hostAction，反馈经 deps.notify。
 * @module
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { hostAction } from './api.ts'
import { attemptId, reasonText, type Translate } from './format.ts'
import { readWorkDetail, readWorkTrend, type AccountRow, type HotWorkRow, type WorkDetailView, type WorkRow } from './schema.ts'
import { downloadBase64, type OverviewFilters } from './OverviewPage.tsx'
import { workTrendRows } from './charts.tsx'
import type { PromotionModalData } from './WorkDetailModal.tsx'

/** 弹层/导出流的页面依赖（文案、反馈、账号目录与筛选写入由页面承担）。 */
export interface WorkbenchModalDeps {
  /** 页面翻译函数。 */
  t: Translate
  /** 页面 toast。 */
  notify(text: string, tone?: 'success'): void
  /** 账号列表刷新（负责人保存成功后）。 */
  refreshAccounts(): Promise<boolean>
  /** 账号目录（投流弹层的账号名投影）。 */
  accounts: AccountRow[]
  /** 当前选中账号（导出目标；null = 未选中）。 */
  selectedAccountId: string | null
  /** 负责人保存后的筛选校准写入（页面 reducer；updater 收到前一次定案）。 */
  applyOverviewFilters(update: (previous: OverviewFilters) => OverviewFilters): void
}

/** 弹层/导出流的状态与处理器（页面组合层解构使用）。 */
export interface WorkbenchModals {
  detailTarget: { accountId: string; row: WorkRow } | null
  detail: WorkDetailView | null
  detailState: 'loading' | 'ready' | 'error'
  trendRows: { day: string; value: number | null }[]
  openDetail(accountId: string, row: WorkRow): void
  closeDetail(): void
  /** 热门作品行 → 作品行（乐观展示基准），随后打开详情。 */
  openHotWork(accountId: string, work: HotWorkRow): void
  ownerModal: { accountId: string; accountName: string; ownerName: string } | null
  setOwnerModal(modal: { accountId: string; accountName: string; ownerName: string } | null): void
  ownerSaving: boolean
  saveOwner(input: { accountId: string; ownerName: string }): Promise<string | null>
  openPromotion(data: PromotionModalData): void
  promotionModal: (PromotionModalData & { accountName: string; staleRecovered: boolean }) | null
  setPromotionModal(modal: (PromotionModalData & { accountName: string; staleRecovered: boolean }) | null): void
  promotionSaving: boolean
  savePromotion(input: {
    accountId: string
    workId: string
    recordId: number | null
    playCount: number
    costAmount: string
    fansCount: number
    durationHours: string
  }): Promise<string | null>
  exporting: boolean
  exportWorks(): void
}

/**
 * 弹层与导出的页面级状态与副作用。
 * @param deps - 页面依赖。
 * @returns 详情/负责人/投流弹层与导出的状态与处理器。
 */
export function useWorkbenchModals(deps: WorkbenchModalDeps): WorkbenchModals {
  const { t, notify, refreshAccounts, accounts, selectedAccountId, applyOverviewFilters } = deps
  const [detailTarget, setDetailTarget] = useState<{ accountId: string; row: WorkRow } | null>(null)
  const [detail, setDetail] = useState<WorkDetailView | null>(null)
  const [detailState, setDetailState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [trendRows, setTrendRows] = useState<{ day: string; value: number | null }[]>([])
  const [ownerModal, setOwnerModal] = useState<{ accountId: string; accountName: string; ownerName: string } | null>(null)
  const [ownerSaving, setOwnerSaving] = useState(false)
  const [promotionModal, setPromotionModal] = useState<(PromotionModalData & { accountName: string; staleRecovered: boolean }) | null>(null)
  const [promotionSaving, setPromotionSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const detailSeqRef = useRef(0)
  // 负责人校准读取的账号目录快照（保存流程 await 刷新后读取，与原页 ref 口径一致）。
  const accountsRef = useRef(accounts)
  useEffect(() => { accountsRef.current = accounts }, [accounts])

  // ---- 统一作品详情弹层（跨账号显式 accountId；detailRequestRef 守卫） ----

  const openDetail = useCallback((accountId: string, row: WorkRow): void => {
    const seq = ++detailSeqRef.current
    setDetailTarget({ accountId, row })
    setDetail(null)
    setTrendRows([])
    setDetailState('loading')
    void hostAction('work.get', { accountId, workId: row.work_id }).then(res => {
      if (detailSeqRef.current !== seq) return
      setDetail(readWorkDetail(res))
      setDetailState('ready')
    }).catch(() => {
      if (detailSeqRef.current !== seq) return
      setDetail(null)
      setDetailState('error')
    })
    void hostAction('work.trend', { accountId, workId: row.work_id }).then(res => {
      if (detailSeqRef.current !== seq) return
      setTrendRows(workTrendRows(readWorkTrend(res)))
    }).catch(() => {
      if (detailSeqRef.current !== seq) return
      setTrendRows([])
    })
  }, [])

  const closeDetail = useCallback((): void => {
    detailSeqRef.current += 1
    setDetailTarget(null)
    setDetail(null)
    setTrendRows([])
    setDetailState('loading')
  }, [])

  /** 热门作品行 → 作品行（乐观展示基准）。 */
  const hotWorkToRow = useCallback((work: HotWorkRow): WorkRow => ({
    work_id: work.workId,
    title: work.title,
    url: null,
    cover_url: null,
    duration_s: null,
    publish_time: work.publishTime,
    latest_collected_at: null,
    play_count: work.playCount,
    collect_count: null,
    like_count: null,
    comment_count: null,
    bounce_rate_2s_pct: null,
    completion_rate_5s_pct: null,
    completion_rate_pct: null,
    fans_gain_count: work.fansGainCount,
    avg_watch_duration_s: null,
    avg_view_proportion_pct: null,
    promoted: work.promoted,
    visibility: null,
    data_gap: null,
  }), [])

  const openHotWork = useCallback((accountId: string, work: HotWorkRow): void => {
    openDetail(accountId, hotWorkToRow(work))
  }, [hotWorkToRow, openDetail])

  // ---- 负责人弹层（保存投影更新账号列表 + 筛选唯一一次重查校准） ----

  const saveOwner = useCallback(async (input: { accountId: string; ownerName: string }): Promise<string | null> => {
    setOwnerSaving(true)
    try {
      await hostAction('account.owner.set', {
        accountId: input.accountId,
        ownerName: input.ownerName,
        idempotencyKey: `douyin:account_owner_set:${attemptId()}`,
      })
    } catch (error) {
      setOwnerSaving(false)
      return error instanceof Error ? error.message : 'VALIDATION_ERROR'
    }
    setOwnerSaving(false)
    setOwnerModal(null)
    notify(t('owner.saved'), 'success')
    await refreshAccounts()
    // 筛选校准（RQ-2026-009 §6.5，基于刷新后账号目录 + 本次保存结果，重拉前
    // 一次定案）：旧 ownerName 失联 → 清空；已选账号不在目录或不在负责人名下
    // → 重置全部账号；随后 OverviewPage 的 filters effect 恰发一次查询。
    applyOverviewFilters(previous => {
      const candidates = new Set(accountsRef.current
        .map(row => row.ownerName?.trim())
        .filter((name): name is string => name !== undefined && name !== ''))
      const next = { ...previous }
      if (next.ownerName !== '' && !candidates.has(next.ownerName)) next.ownerName = ''
      const picked = next.accountIds[0]
      if (picked !== undefined && picked !== '') {
        const pickedRow = accountsRef.current.find(row => row.accountId === picked)
        const inOwnerScope = next.ownerName === ''
          || (pickedRow?.ownerName?.trim() === next.ownerName)
          || (picked === input.accountId && input.ownerName === next.ownerName)
        if (pickedRow === undefined || !inOwnerScope) next.accountIds = []
      }
      return next
    })
    return null
  }, [applyOverviewFilters, notify, refreshAccounts, t])

  // ---- 投流弹层（PROMOTION_ALREADY_EXISTS 自动重拉转更新） ----

  const openPromotion = useCallback((data: PromotionModalData): void => {
    const owner = accounts.find(row => row.accountId === data.accountId)
    setPromotionModal({ ...data, accountName: owner?.nickname ?? data.accountId, staleRecovered: false })
  }, [accounts])

  const savePromotion = useCallback(async (input: {
    accountId: string
    workId: string
    recordId: number | null
    playCount: number
    costAmount: string
    fansCount: number
    durationHours: string
  }): Promise<string | null> => {
    if (promotionModal === null) return 'PROMOTION_FIELD_REQUIRED'
    setPromotionSaving(true)
    try {
      await hostAction('work.promotion.save', {
        accountId: input.accountId,
        workId: input.workId,
        playCount: input.playCount,
        fansCount: input.fansCount,
        costAmount: input.costAmount,
        durationHours: input.durationHours,
        ...(input.recordId !== null ? { recordId: input.recordId } : {}),
        idempotencyKey: `douyin:work_promotion_save:${attemptId()}`,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'douyin_operation_request_failed'
      if (reason === 'PROMOTION_ALREADY_EXISTS') {
        // stale-add 自动恢复：重拉详情换入最新记录（挂载 key 变化重挂载预填）。
        let staleDetail: WorkDetailView | undefined
        try {
          staleDetail = readWorkDetail(await hostAction('work.get', { accountId: input.accountId, workId: input.workId }))
        } catch (_staleRecoveryFailed) {
          // stale-add 恢复是可选补偿；失败时保留原冲突错误与用户输入，不伪装恢复成功。
        }
        if (staleDetail !== undefined && staleDetail.promotion !== null) {
          setPromotionModal(previous => previous !== null ? {
            ...previous,
            recordId: staleDetail.promotion?.id ?? null,
            playCount: staleDetail.promotion?.playCount ?? '',
            costAmount: staleDetail.promotion?.costAmount ?? '',
            fansCount: staleDetail.promotion?.fansCount ?? '',
            durationHours: staleDetail.promotion?.durationHours ?? '',
            staleRecovered: true,
          } : previous)
          setPromotionSaving(false)
          return null
        }
      }
      setPromotionSaving(false)
      return reason
    }
    setPromotionSaving(false)
    setPromotionModal(null)
    notify(t('promotion.saved'), 'success')
    if (detailTarget !== null) openDetail(detailTarget.accountId, detailTarget.row)
    return null
  }, [detailTarget, notify, openDetail, promotionModal, t])

  // ---- 导出（当前账号全量作品） ----

  /** 导出 Excel（当前账号全量作品）。 */
  const exportWorks = useCallback((): void => {
    if (selectedAccountId === null) return
    setExporting(true)
    void (async () => {
      try {
        const res = await hostAction('export', { accountId: selectedAccountId })
        downloadBase64(
          typeof res.file_name === 'string' ? res.file_name : 'douyin-export.xlsx',
          typeof res.content_base64 === 'string' ? res.content_base64 : '',
          typeof res.mime_type === 'string' ? res.mime_type : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        )
      } catch (error) {
        notify(reasonText(error instanceof Error ? error.message : 'export_failed', t))
      } finally {
        setExporting(false)
      }
    })()
  }, [notify, selectedAccountId, t])

  return {
    detailTarget,
    detail,
    detailState,
    trendRows,
    openDetail,
    closeDetail,
    openHotWork,
    ownerModal,
    setOwnerModal,
    ownerSaving,
    saveOwner,
    openPromotion,
    promotionModal,
    setPromotionModal,
    promotionSaving,
    savePromotion,
    exporting,
    exportWorks,
  }
}
