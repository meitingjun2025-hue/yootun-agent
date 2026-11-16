/**
 * yootun Workbench 面私有 MCP 连接器（`ctx.yootunWorkbench`）：三个工作台
 * Host 共享的 Streamable HTTP client，直接使用 MCP SDK、不注册 `ctx.tools`，
 * 普通会话不可见。90 项白名单、按调用方分组约束与生命周期随本批次交付。
 * @module @yootun/dsh-workbench-mcp
 */

import { Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The yootun Workbench MCP connector. */
    yootunWorkbench: YootunWorkbenchMcp
  }
}

/**
 * The shared private Workbench MCP connector service.
 */
export default class YootunWorkbenchMcp extends Service {
  /**
   * @param ctx - the service context.
   */
  constructor(ctx: Context) {
    super(ctx, 'yootunWorkbench')
  }
}
