/**
 * Workbench 面 caller×domain 域级放行（分册 08 §5）：工具名形如
 * `workbench_<domain>_<rest>` 且 `<domain>` 属于该 caller 的域即放行。
 * yootun-agent 不持有 Workbench 工具名清单，工具清单以 tools.dofe.ai
 * `docs/1116/yootun-mcp.md` 为准；服务端新增 `workbench_*` 工具时本文件
 * 零改动，域门通过但服务端未广播的工具在调用时按 `workbench_tool_unavailable`
 * 投影。
 * @module
 */

/** One Workbench tool group; a caller may only reach its allowed domains. */
export type WorkbenchDomain = 'wx' | 'xhs' | 'douyin' | 'viral' | 'tos'

/** The in-process caller identities; each Host passes its own, never another's. */
export type WorkbenchCaller = 'wx-workbench' | 'xhs-workbench' | 'douyin-workbench' | 'media-upload'

/** All legal domains; mirrors the {@link WorkbenchDomain} union for name parsing. */
const DOMAINS: readonly WorkbenchDomain[] = ['wx', 'xhs', 'douyin', 'viral', 'tos']

/** Mandatory name prefix of every Workbench-face tool. */
export const WORKBENCH_TOOL_PREFIX = 'workbench_'

/** Each caller's reachable domains; nothing else passes the gate. */
export const CALLER_DOMAINS: Readonly<Record<WorkbenchCaller, readonly WorkbenchDomain[]>> = Object.freeze({
  'wx-workbench': ['wx'],
  'xhs-workbench': ['xhs'],
  'douyin-workbench': ['douyin', 'viral'],
  'media-upload': ['tos'],
})

/** Catalog 面 yootun_business_* 元工具永远不满足 Workbench 域门（测试对照用）。 */
export const CATALOG_TOOL_NAMES: readonly string[] = Object.freeze([
  'yootun_business_capabilities_list',
  'yootun_business_capability_get',
  'yootun_business_service_categories_list',
  'yootun_business_tools_search',
  'yootun_business_tool_contract_get',
])

/**
 * Whether one parsed name segment is a legal Workbench domain.
 * @param value - the candidate segment.
 * @returns `true` when the segment names a {@link WorkbenchDomain}.
 */
function isWorkbenchDomain(value: string): value is WorkbenchDomain {
  return (DOMAINS as readonly string[]).includes(value)
}

/**
 * Parse one tool name's Workbench domain: `workbench_<domain>_<rest>` with a
 * non-empty rest; the rest is taken verbatim (its own underscores belong to it).
 * @param name - raw tool name.
 * @returns the domain, or `undefined` when the name does not parse into one.
 */
export function domainOf(name: string): WorkbenchDomain | undefined {
  if (!name.startsWith(WORKBENCH_TOOL_PREFIX)) return undefined
  const rest = name.slice(WORKBENCH_TOOL_PREFIX.length)
  const separator = rest.indexOf('_')
  if (separator <= 0) return undefined
  const domain = rest.slice(0, separator)
  if (!isWorkbenchDomain(domain)) return undefined
  if (rest.slice(separator + 1) === '') return undefined
  return domain
}

/**
 * Whether one tool name passes the caller's domain gate.
 * @param caller - the calling Host's identity; unknown callers pass nothing.
 * @param name - raw tool name.
 * @returns `true` only when the name parses to a domain inside the caller's {@link CALLER_DOMAINS}.
 */
export function isAllowedFor(caller: WorkbenchCaller, name: string): boolean {
  const domain = domainOf(name)
  if (domain === undefined) return false
  const domains = CALLER_DOMAINS[caller]
  return domains?.includes(domain) ?? false
}
