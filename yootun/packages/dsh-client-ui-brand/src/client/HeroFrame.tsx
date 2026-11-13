/** 会话首页品牌层：hero 态的渐变微光背景、品牌落款与 headline 前的品牌头像。 */
import type { HeroBrandMarkOwnerProps, HeroFrameOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ReactNode } from 'react'
import { BRAND_EYEBROW } from './brand-constants.ts'
import heroMarkUrl from './assets/hero-mark.png'
import css from './hero.module.css'

/** Frame owner state and the wrapped content. */
export type YootunHeroFrameProps = HeroFrameOwnerProps & { children: ReactNode }

/**
 * 包裹会话滚动体；空白首页时在内容下方挂品牌渐变微光与落款。
 * 布局中性：外壳 display:contents，装饰层均 aria-hidden 且不接收指针事件。
 * @param props - the home state and the wrapped scroll body.
 * @returns a layout-neutral frame around the children.
 */
export function YootunHeroFrame({ hero, children }: YootunHeroFrameProps) {
  return (
    <div className={css.layer}>
      {hero && (
        <>
          <div className={css.glow} aria-hidden="true" />
          <div className={css.eyebrow} aria-hidden="true">{BRAND_EYEBROW}</div>
        </>
      )}
      {children}
    </div>
  )
}

/**
 * 首页 headline 前的品牌头像（替代官方小鱼 fallback）。
 * @param props - Host-supplied mark presentation; className 保留宿主几何类。
 * @returns the yootun hero mark.
 */
export function YootunHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img src={heroMarkUrl} width={size} height={size} className={className} alt="" />
}
