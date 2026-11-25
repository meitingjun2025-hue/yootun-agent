/**
 * FilterMenu：单选筛选下拉（分册规范 §四；官方 Menu 单选、当前项 check）。
 * 触发按钮为官方 Button outline sm；可见文字标签可选。文案全部由调用方传入，
 * 本组件无 kit locale 依赖。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './filter-menu.module.css'

/** One selectable option in the filter menu. */
export interface FilterMenuItem {
  /** Stable option id (also the Menu item id). */
  id: string
  /** Localized option label. */
  label: string
}

export interface FilterMenuProps {
  /** Accessible name of the trigger button (announce what the filter picks). */
  label: string
  /** Visible prefix label before the trigger; omit to render none. */
  visibleLabel?: string
  /** Text shown on the closed trigger (the current selection's label). */
  currentLabel: string
  /** Selectable options. */
  items: readonly FilterMenuItem[]
  /** Currently selected option id. */
  selectedId: string
  /** Disables the trigger. */
  disabled?: boolean
  /** Extra class for the trigger button (page-local height/border/arrow styling). */
  triggerClassName?: string | undefined
  /** Called with the picked option id; the menu closes first. */
  onSelect: (id: string) => void
}

/**
 * Render the single-select filter dropdown.
 * @param props.label - trigger accessible name.
 * @param props.visibleLabel - optional visible prefix label.
 * @param props.currentLabel - trigger text.
 * @param props.items - selectable options.
 * @param props.selectedId - selected option id.
 * @param props.disabled - disable the trigger.
 * @param props.triggerClassName - extra trigger class.
 * @param props.onSelect - selection handler.
 * @returns the filter menu element.
 */
export function FilterMenu(props: FilterMenuProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <span className={css.filterGroup}>
      {props.visibleLabel !== undefined && (
        <span className={css.filterGroupLabel}>{props.visibleLabel}</span>
      )}
      <Menu
        open={open}
        anchor={(
          <Button
            variant="outline"
            size="sm"
            disabled={props.disabled}
            className={props.triggerClassName}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={props.label}
            onClick={() => {
              setOpen(value => !value)
            }}
          >
            {props.currentLabel}
          </Button>
        )}
        items={props.items.map(item => ({ id: item.id, label: item.label }))}
        selectedId={props.selectedId}
        onSelect={(id) => {
          setOpen(false)
          props.onSelect(id)
        }}
        onClose={() => {
          setOpen(false)
        }}
      />
    </span>
  )
}
