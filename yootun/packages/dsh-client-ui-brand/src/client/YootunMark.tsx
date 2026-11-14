/** 侧边栏品牌占位组件：yootun 潜水员头像位图（与首屏/快捷方式同一品牌形象；
    分册 06 第二轮真机反馈定案：原鲸尾单色 mark 与官方 FishLogo 视觉近似致误认，弃用）。 */
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import heroMarkUrl from './assets/hero-mark.png'

/**
 * 侧边栏品牌 mark：按宿主请求的方形尺寸渲染 yootun 潜水员头像。
 * @param props - Host-supplied mark presentation.
 * @returns the yootun mark.
 */
export function YootunMark({ size }: SidebarBrandMarkOwnerProps) {
  return <img src={heroMarkUrl} width={size} height={size} alt="" />
}

/**
 * 侧边栏品牌名占位：返回 null 隐藏文字名（纯 mark 方案），同时阻断宿主的通用文字 fallback。
 * @returns nothing — the brand row shows the mark only.
 */
export function YootunName() {
  return null
}
