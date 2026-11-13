/** 侧边栏品牌占位组件：单色 mark 以 CSS mask 呈现，颜色走宿主语义 token，明暗主题自适应。 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './brand.module.css'

/**
 * 侧边栏品牌 mark：按宿主请求的方形尺寸渲染 yootun 鲸尾图形。
 * @param props - Host-supplied mark presentation.
 * @returns the yootun mark.
 */
export function YootunMark({ size }: SidebarBrandMarkOwnerProps) {
  return <span className={css.mark} style={{ width: size, height: size }} aria-hidden="true" />
}

/**
 * 侧边栏品牌名占位：返回 null 隐藏文字名（纯 mark 方案），同时阻断宿主的通用文字 fallback。
 * @returns nothing — the brand row shows the mark only.
 */
export function YootunName() {
  return null
}
