/**
 * 筛选下拉（官方 Menu 单选、当前项 check）：D6–D8 三页（拆解状态筛选 / 素材
 * 看板 6 筛选 / 基因库品类与采纳态）共用的插件场景层组件，替代原生 select。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './workbench.module.css'

/** 单选筛选下拉（锚点 Button outline sm；选项带 check）。 */
export function FilterMenu(props: {
  label: string
  /** 可见文字标签（对齐旧插件「账号: / 发布时间:」前置描述；缺省不渲染）。 */
  visibleLabel?: string
  currentLabel: string
  items: readonly { id: string; label: string }[]
  selectedId: string
  disabled?: boolean
  /** 触发按钮附加类（页面按旧插件筛选条样式定制：高度 / 边框 / 下拉箭头）。 */
  triggerClassName?: string | undefined
  onSelect: (id: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <span className={css.filterGroup}>
      {props.visibleLabel !== undefined && <span className={css.filterGroupLabel}>{props.visibleLabel}</span>}
      <Menu
        open={open}
        anchor={(
        <Button
          variant='outline'
          size='sm'
          disabled={props.disabled}
          className={props.triggerClassName}
          aria-haspopup='menu'
          aria-expanded={open}
          aria-label={props.label}
          onClick={() => { setOpen(value => !value) }}
        >
          {props.currentLabel}
        </Button>
      )}
      items={props.items.map(item => ({ id: item.id, label: item.label }))}
      selectedId={props.selectedId}
      onSelect={id => {
        setOpen(false)
        props.onSelect(id)
      }}
        onClose={() => { setOpen(false) }}
      />
    </span>
  )
}
