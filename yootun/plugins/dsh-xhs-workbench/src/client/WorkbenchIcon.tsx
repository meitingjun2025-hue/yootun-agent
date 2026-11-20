/**
 * 侧栏入口图标（几何对齐官方 16px 图标盒；笔记图形，无品牌素材）。
 * @module
 */
import type { ReactNode } from 'react'

/**
 * The sidebar row icon.
 * @param props.size - the sidebar's icon size (16px box).
 * @param props.active - whether the panel is selected.
 * @returns decorative note-page icon.
 */
export function WorkbenchIcon(props: { size: number; active: boolean }): ReactNode {
  const size = props.size
  return (
    <svg width={size} height={size} viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <rect x='2.5' y='2.5' width='11' height='11' rx='1.5' stroke='currentColor' />
      <path d='M5 6h6M5 8.5h6M5 11h3.5' stroke='currentColor' strokeLinecap='round' />
    </svg>
  )
}
