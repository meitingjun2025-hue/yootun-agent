/**
 * Pager：列表分页控件。信息文案 + 上一页/下一页两枚官方 Button 同行排布，
 * 窄容器换行。页数由 `total` 与 `pageSize` 计算；`total` 未知（null）显示统计
 * 加载中文案并禁用两枚按钮，单页内容只渲染信息文案。回调只在目标页不同于
 * 当前页且落在 1..pages 内时触发；排序或筛选变化时由调用方自行回到第 1 页。
 * @module
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import css from './pager.module.css'

export interface PagerProps {
  /** Current page, 1-based. */
  page: number
  /** Fixed page size; the control offers no way to change it. */
  pageSize: number
  /** Server-side total; null while totals are loading or unknown. */
  total: number | null
  /** Page-change callback (1-based target). */
  onPage: (page: number) => void
  /** A page request is in flight; both buttons are disabled. */
  busy?: boolean
}

/**
 * Render the pagination row for one list region.
 * @param props.page - current 1-based page.
 * @param props.pageSize - fixed page size.
 * @param props.total - server-side total; null while loading.
 * @param props.onPage - page-change callback; only valid page changes invoke it.
 * @param props.busy - disables both buttons while a page request is in flight.
 * @returns the pagination element.
 */
export function Pager({ page, pageSize, total, onPage, busy = false }: PagerProps): ReactNode {
  const t = useKitLocale()
  const pages = total === null ? null : Math.max(1, Math.ceil(total / pageSize))
  /** Fire the callback only for an in-range page other than the current one. */
  const goTo = (target: number): void => {
    if (pages !== null && target !== page && target >= 1 && target <= pages) onPage(target)
  }
  const prevDisabled = total === null || busy || page <= 1
  const nextDisabled = total === null || busy || pages === null || page >= pages
  return (
    <nav className={css.pager} aria-label={t('pager.label')}>
      <span className={css.info}>
        {total === null || pages === null ? t('pager.loading') : t('pager.info', { total, page, pages })}
      </span>
      {(pages === null || pages > 1) && (
        <>
          <Button variant="ghost" size="sm" disabled={prevDisabled} onClick={() => { goTo(page - 1) }}>{t('pager.prev')}</Button>
          <Button variant="ghost" size="sm" disabled={nextDisabled} onClick={() => { goTo(page + 1) }}>{t('pager.next')}</Button>
        </>
      )}
    </nav>
  )
}
