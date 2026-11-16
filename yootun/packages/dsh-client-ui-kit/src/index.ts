/**
 * yootun 插件 UI 复合组件库（纯 client 库，非插件）：所有业务工作台 client 半
 * 共用的复合形态。原子控件一律来自官方 `@deepseek-ai/dsh-client-ui-primitives`；
 * 颜色、间距、圆角、阴影、动效只映射官方 `--dsw-*` token 或本包集中的
 * `--yt-*` 语义变量；组件实际内容随真实消费者（P2 视频号工作台）分批交付。
 * @module @yootun/dsh-client-ui-kit
 */

/** UI kit library root — components land with their first real consumers. */
export const UI_KIT_VERSION = '0.2.2-rc.3' as const
