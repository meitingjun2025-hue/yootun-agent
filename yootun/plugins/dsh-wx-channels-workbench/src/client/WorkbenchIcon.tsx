/**
 * 侧栏入口图标（几何对齐官方 16px 图标盒；无品牌素材）。
 * @module
 */
import type { ReactNode } from 'react'

/**
 * The sidebar row icon.
 * @param props.size - the sidebar's icon size (16px box).
 * @param props.active - whether the panel is selected.
 * @returns decorative play-panel icon.
 */
export function WorkbenchIcon(props: { size: number; active: boolean }): ReactNode {
  const size = props.size
  return (
    <svg width={size} height={size} viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <rect x='1.5' y='3.5' width='13' height='9' rx='1.5' stroke='currentColor' />
      <path d='M7 6.5l3 1.5-3 1.5v-3z' fill='currentColor' />
    </svg>
  )
}
