/** 侧边栏品牌占位组件：mark 以位图呈现（分册 06 问题 4 修复路径 B，与 hero mark 同型）。 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import sidebarMarkUrl from './assets/sidebar-mark.png'
import css from './brand.module.css'

/**
 * 侧边栏品牌 mark：按宿主请求的方形尺寸渲染 yootun 鲸尾图形；
 * 暗色主题经 CSS filter 反白（源素材为深墨单色，见 brand.module.css）。
 * @param props - Host-supplied mark presentation.
 * @returns the yootun mark.
 */
export function YootunMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img src={sidebarMarkUrl} width={size} height={size} className={css.mark} alt="" />
}

/**
 * 侧边栏品牌名占位：返回 null 隐藏文字名（纯 mark 方案），同时阻断宿主的通用文字 fallback。
 * @returns nothing — the brand row shows the mark only.
 */
export function YootunName() {
  return null
}
