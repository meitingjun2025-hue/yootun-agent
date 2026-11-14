/** yootun 品牌占位：侧边栏品牌位（纯 mark）与会话首页 hero 层。 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { YootunHeroFrame, YootunHeroMark } from './HeroFrame.tsx'
import { YootunMark, YootunName } from './YootunMark.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * 占用品牌 slot：hero 框层与 hero 品牌 mark、侧边栏 mark（name 返回 null 隐藏文字名）。
 * 声明感知注册：先声明 slot 所属包，再在各所属包就绪后注册占位组件。
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame',
    id: 'yootun-hero',
  }, YootunHeroFrame))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, YootunHeroMark))
  // 侧边栏两 slot 采用与 hero 同型的直接注册（分册 06 第二轮真机反馈：嵌套
  // generator 形态在本桌面运行时未到达注册，直接形态已被 hero.brand.mark 证实可用）。
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
    name: 'sidebar.brand.mark',
  }, YootunMark))
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({
    name: 'sidebar.brand.name',
  }, YootunName))
}
