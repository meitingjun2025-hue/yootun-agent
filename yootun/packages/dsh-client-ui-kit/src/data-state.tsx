/**
 * DataState：数据的四态呈现（loading / empty / error / partial / ready）。
 * 骨架形状与最终内容形状匹配（rows / chart / value / block，分册规范 §四）；
 * error 保留已加载数据并提供 Retry；partial 在内容上方追加警告条。
 * @module
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import css from './data-state.module.css'

/** The four presentational states plus the settled `ready`. */
export type DataStateKind = 'loading' | 'empty' | 'error' | 'partial' | 'ready'

/** Skeleton shapes matched to the settled content's silhouette. */
export type DataStateShape = 'rows' | 'chart' | 'value' | 'block'

export interface DataStateProps {
  /** Which state to present; `ready` and `partial` render children. */
  state: DataStateKind
  /** Skeleton silhouette used while loading. */
  shape?: DataStateShape
  /** Settled content; rendered for `ready` and `partial`. */
  children?: ReactNode
  /** Extra context rendered under the `empty` label (e.g. a next-step action). */
  emptyAction?: ReactNode
  /** Replacement copy for the `empty` label; omitting it keeps the kit `state.empty` copy. */
  emptyLabel?: ReactNode | undefined
  /** Retry handler for the `error` state; omitting it hides the button. */
  onRetry?: (() => void) | undefined
  /** Which skeleton rows count as "long" — only `rows` uses it. */
  skeletonRows?: number
}

/**
 * Present one data region's state with a shape-matched skeleton.
 * @param props.state - current state.
 * @param props.shape - skeleton silhouette (default `block`).
 * @param props.children - settled content.
 * @param props.emptyAction - next-step affordance for `empty`.
 * @param props.emptyLabel - `empty` label override (default the kit `state.empty` copy).
 * @param props.onRetry - error retry; hidden when absent.
 * @param props.skeletonRows - row-skeleton line count (default 4).
 * @returns the state presentation; children pass through when settled.
 */
export function DataState({ state, shape = 'block', children, emptyAction, emptyLabel, onRetry, skeletonRows = 4 }: DataStateProps): ReactNode {
  const t = useKitLocale()
  if (state === 'ready') return children
  if (state === 'partial') {
    return (
      <div className={css.partial}>
        <p className={css.partialNote} role="status">{t('state.partial')}</p>
        {children}
      </div>
    )
  }
  if (state === 'loading') {
    return (
      <div className={css.loading} role="status" aria-busy="true">
        {shape === 'rows' && (
          <div className={css.rowSkeleton}>
            {Array.from({ length: Math.max(1, skeletonRows) }, (_, index) => (
              <span key={index} className={css.rowLine} style={{ width: `${72 - (index % 3) * 14}%` }} />
            ))}
          </div>
        )}
        {shape === 'chart' && <div className={css.chartSkeleton} />}
        {shape === 'value' && <span className={css.valueSkeleton} />}
        {shape === 'block' && <div className={css.blockSkeleton} />}
        <span className={css.srOnly}>{t('state.loading')}</span>
      </div>
    )
  }
  if (state === 'empty') {
    return (
      <div className={css.notice}>
        <p className={css.noticeText}>{emptyLabel ?? t('state.empty')}</p>
        {emptyAction}
      </div>
    )
  }
  return (
    <div className={css.notice} role="alert">
      <p className={css.noticeText}>{t('state.error')}</p>
      {onRetry !== undefined && <Button variant="outline" size="sm" onClick={onRetry}>{t('state.retry')}</Button>}
    </div>
  )
}
