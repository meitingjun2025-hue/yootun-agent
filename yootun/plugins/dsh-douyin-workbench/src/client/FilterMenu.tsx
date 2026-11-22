/**
 * 筛选下拉（官方 Menu 单选、当前项 check）：D6–D8 三页（拆解状态筛选 / 素材
 * 看板 6 筛选 / 基因库品类与采纳态）共用的插件场景层组件，替代原生 select。
 * @module
 */
import { useState, type ReactNode } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

/** 单选筛选下拉（锚点 Button outline sm；选项带 check）。 */
export function FilterMenu(props: {
  label: string
  currentLabel: string
  items: readonly { id: string; label: string }[]
  selectedId: string
  disabled?: boolean
  onSelect: (id: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      anchor={(
        <Button
          variant='outline'
          size='sm'
          disabled={props.disabled}
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
  )
}
