/**
 * Workbench 面固定连接契约（分册 08 §0/§5）：serverName 与服务端 domain 同名、
 * URL 面固定。激活 namespace、凭证引用与租户头单一来源是接入层的生成常量
 * （yootun/brand/brand.json），这里只 re-export，不复制第二套定义。
 * @module
 */
import { TENANT } from '@yootun/dsh-client-ui-access/src/access-constants.ts'

export { ACCESS_CREDENTIAL_REF, ACCESS_NAMESPACE } from '@yootun/dsh-client-ui-access/src/access-constants.ts'

/** Workbench 面 serverName（与 Tools 服务端 domain 同名，无版本号）。 */
export const WORKBENCH_SERVER_NAME = 'yootun-workbench'

/**
 * Workbench 面 MCP endpoint。缺省即生产契约 URL（公共契约固定，face=workbench）；
 * `YOOTUN_WORKBENCH_MCP_URL` 只供测试与内网联调覆盖，产品组合不设置该变量。
 * 惰性读取：连接时求值，避免模块加载顺序固化测试覆盖值。
 * @returns the Workbench-face endpoint URL.
 */
export function workbenchUrl(): string {
  return process.env.YOOTUN_WORKBENCH_MCP_URL ?? 'https://ixicai.cn/mcp/tools/yootun/v1/workbench'
}

/** MCP client 对服务端表明的身份（与 serverName 区分：这是 client info）。 */
export const CLIENT_INFO_NAME = 'yootun-workbench-host'

/** 公司头：网关按租户路由（与 llm provider 的 X-Company-Code 同值）。 */
export const TENANT_CODE = TENANT
