/**
 * Agent 面 MCP 固定连接契约（分册 08 §0/§4）：serverName 与服务端 domain
 * 同名、URL 面固定。激活 namespace、凭证引用与租户头单一来源是接入层的
 * 生成常量（yootun/brand/brand.json），这里只 re-export，不复制第二套定义。
 * @module
 */
import { ACCESS_AGENT_STATUS_PATH as GATEWAY_AGENT_STATUS_PATH, ACCESS_CREDENTIAL_REF as GATEWAY_CREDENTIAL_REF, ACCESS_NAMESPACE as GATEWAY_ACCESS_NAMESPACE, TENANT } from '@yootun/dsh-client-ui-access/src/access-constants.ts'

/** Agent 面 serverName（与 Tools 服务端 domain 同名，无版本号）。 */
export const AGENT_SERVER_NAME = 'yootun-agent'

/**
 * Agent 面 MCP endpoint。缺省即生产契约 URL（公共契约固定，face=agent）；
 * `YOOTUN_AGENT_MCP_URL` 只供测试与内网联调覆盖，产品组合不设置该变量。
 * 惰性读取：挂载时求值，避免模块加载顺序固化测试覆盖值。
 * @returns the Agent-face endpoint URL.
 */
export function agentUrl(): string {
  return process.env.YOOTUN_AGENT_MCP_URL ?? 'https://ixicai.cn/mcp/tools/yootun/v1/agent'
}

/** 托管模型凭证引用（credentials store 与 Authorization 模板共用此名）。 */
export const ACCESS_CREDENTIAL_REF = GATEWAY_CREDENTIAL_REF

/** 激活设置 namespace（接入层 host 半的 Config entry id）。 */
export const ACCESS_NAMESPACE = GATEWAY_ACCESS_NAMESPACE

/** 公司头：网关按租户路由（与 llm provider 的 X-Company-Code 同值）。 */
export const TENANT_CODE = TENANT

/** Agent 面状态路由路径（设置页「智能体工具」轮询；单一来源同生成常量）。 */
export const STATUS_PATH = GATEWAY_AGENT_STATUS_PATH

/** dsh-mcp-client 公共工具名前缀：`mcp__<serverName>__<rawName>`。 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** 禁止进入普通会话的 yootun 面：Workbench 与 Catalog 只属工作台 Host。 */
export const FORBIDDEN_SERVER_NAMES: ReadonlySet<string> = new Set(['yootun-workbench', 'yootun-catalog'])
