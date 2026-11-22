/**
 * 侧栏入口图标（几何对齐官方 16px 图标盒；无品牌素材）。
 * @module
 */
import type { ReactNode } from 'react'

/**
 * The sidebar row icon.
 * @param props.size - the sidebar's icon size (16px box).
 * @param props.active - whether the panel is selected.
 * @returns decorative short-video panel icon.
 */
export function WorkbenchIcon(props: { size: number; active: boolean }): ReactNode {
  const size = props.size
  return (
    <svg width={size} height={size} viewBox='0 0 16 16' fill='none' aria-hidden='true'>
      <rect x='1.5' y='2.5' width='13' height='11' rx='2' stroke='currentColor' />
      <path d='M5.5 2.5v11M10.5 2.5v11' stroke='currentColor' strokeOpacity='0.55' />
      <path d='M3 5.5h1.2M3 8h1.2M3 10.5h1.2' stroke='currentColor' strokeWidth='1.2' strokeLinecap='round' />
    </svg>
  )
}
