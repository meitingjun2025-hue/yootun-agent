/**
 * 单账号采集 progress 投影 → 就地进度文案（数据形状由宿主 runner 投影）：
 * probing / list / list_page / details / ingest / account_level 给阶段提示，
 * 其余（含未知）给兜底「采集中…」，不虚构百分比。
 * @module
 */
import type { Translate } from './format.ts'

/** progress.phase → 文案（列表页码 / 详情进度 / 入库批次带数值）。 */
export function progressTextOf(progress: Record<string, unknown> | null | undefined, t: Translate): string {
  if (progress === null || progress === undefined) return t('collect.progress.fallback')
  const phase = progress.phase
  switch (phase) {
    case 'probing':
    case 'account_sync':
      return t('collect.progress.probing')
    case 'list':
      return typeof progress.collected === 'number' && Number.isFinite(progress.collected)
        ? t('collect.progress.listCollected', { count: progress.collected })
        : t('collect.progress.list')
    case 'list_page':
      return t('collect.progress.listPage', { page: numberOrZero(progress.page) })
    case 'details':
      return t('collect.progress.details', { done: numberOrZero(progress.done), total: numberOrZero(progress.total) })
    case 'ingest':
      return t('collect.progress.ingest', {
        batchNo: numberOrZero(progress.batchNo),
        totalBatches: numberOrZero(progress.totalBatches),
        succeeded: numberOrZero(progress.succeeded),
        expected: numberOrZero(progress.expected),
      })
    case 'account_level':
      return t('collect.progress.accountLevel')
    default:
      return t('collect.progress.fallback')
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
