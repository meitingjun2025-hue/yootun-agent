/**
 * FilterBar：筛选条（分册规范 §二/§四）。可清空搜索框 + 可清除筛选 chip +
 * 追加控件插槽；筛选 chip 显示已选值与数量，「全部」与具体 chip 不重复计数
 * 由调用方保证。清空后焦点不丢失（搜索清空按钮保持输入聚焦）。
 * @module
 */
import { useRef, type ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { useKitLocale } from './kit-locale.ts'
import css from './filter-bar.module.css'

/** One active filter chip with its optional match count. */
export interface FilterChip {
  /** Stable chip id (also the DOM key). */
  id: string
  /** Localized chip label showing the active value. */
  label: string
  /** Match count rendered inside the chip; omit when not countable. */
  count?: number
  /** Clear handler for this single chip. */
  onClear: () => void
}

export interface FilterBarProps {
  /** Search box state; omit to render no search field. */
  search?: {
    value: string
    placeholder: string
    onChange: (value: string) => void
  }
  /** Active filter chips; each clears independently. */
  chips?: readonly FilterChip[]
  /** Clears every chip at once; hidden when all chips are gone. */
  onClearAll?: () => void
  /** Extra controls (sort pickers, segmented filters) in the trailing slot. */
  children?: ReactNode
}

/**
 * Render the filter bar.
 * @param props.search - search state.
 * @param props.chips - active chips.
 * @param props.onClearAll - clear-everything handler.
 * @param props.children - trailing controls.
 * @returns the filter bar element.
 */
export function FilterBar({ search, chips, onClearAll, children }: FilterBarProps): ReactNode {
  const t = useKitLocale()
  const inputRef = useRef<HTMLInputElement>(null)
  const activeChips = chips ?? []
  const hasSearch = search !== undefined
  const hasContent = hasSearch || activeChips.length > 0 || children !== undefined
  if (!hasContent) return null
  return (
    <div className={css.bar} role="group" aria-label={t('filter.label')}>
      {hasSearch && (
        <div className={css.search}>
          <Input
            ref={inputRef}
            type="search"
            value={search.value}
            placeholder={search.placeholder}
            aria-label={t('filter.searchLabel')}
            onChange={event => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && search.value !== '') {
                event.stopPropagation()
                search.onChange('')
              }
            }}
          />
          {search.value !== '' && (
            <button
              type="button"
              className={css.clearButton}
              aria-label={t('filter.searchClear')}
              onClick={() => {
                search.onChange('')
                inputRef.current?.focus()
              }}
            >
              ×
            </button>
          )}
        </div>
      )}
      {activeChips.length > 0 && (
        <div className={css.chips}>
          {activeChips.map(chip => (
            <span key={chip.id} className={css.chip}>
              <span className={css.chipLabel}>
                {chip.label}
                {chip.count !== undefined && <span className={css.chipCount}>{chip.count}</span>}
              </span>
              <button
                type="button"
                className={css.chipClear}
                aria-label={`${t('filter.clear')}: ${chip.label}`}
                onClick={chip.onClear}
              >
                ×
              </button>
            </span>
          ))}
          {onClearAll !== undefined && (
            <button type="button" className={css.clearAll} onClick={onClearAll}>
              {t('filter.clearAll')}
            </button>
          )}
        </div>
      )}
      {children !== undefined && <div className={css.trailing}>{children}</div>}
    </div>
  )
}
