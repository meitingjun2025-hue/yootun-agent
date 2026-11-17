/**
 * 会话写操作 guard 的工具分类（分册 08 §4.3）。分类只依据公开工具名，
 * 不读取参数、不改业务 schema。清单与 Tools 服务端 Agent 面契约
 * （docs/1116/yootun-mcp.md §3.2，36 项）一一对应；契约变化时先更新
 * 服务端文档与本表。读工具直接允许；任务型写/可能计费工具 ask；
 * 未识别的 yootun Agent 工具 deny（fail-closed）。
 * @module
 */

/** One agent tool's session policy class. */
export type AgentToolClass = 'read' | 'task-write' | 'unknown'

/** Task-type writes and model-fee incurring tools: always `ask` in sessions. */
const TASK_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'yootun_xhs_creative_task_start',
  'yootun_xhs_creative_task_retry',
  'yootun_xhs_creative_task_cancel',
])

/** Read-only product tools; the remainder of the 36-tool Agent contract. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  // 小红书（13 项中除任务写三外的 10 项）
  'yootun_xhs_reference_search',
  'yootun_xhs_account_search',
  'yootun_xhs_reference_select',
  'yootun_xhs_creative_task_get',
  'yootun_xhs_creative_task_result_get',
  'yootun_xhs_style_get',
  'yootun_xhs_hotboard_overview_get',
  'yootun_xhs_hotboard_note_detail_get',
  'yootun_xhs_hotboard_keywords_list',
  'yootun_xhs_hotboard_run_get',
  // 抖音（12 项只读）
  'yootun_douyin_accounts_list',
  'yootun_douyin_works_list',
  'yootun_douyin_work_get',
  'yootun_douyin_work_trend_get',
  'yootun_douyin_collection_run_get',
  'yootun_douyin_account_overview_get',
  'yootun_douyin_account_analysis_get',
  'yootun_douyin_account_trend_get',
  'yootun_douyin_hot_works_list',
  'yootun_douyin_analysis_task_get',
  'yootun_douyin_reports_list',
  'yootun_douyin_report_get',
  // 视频号（6 项只读）
  'yootun_wx_accounts_list',
  'yootun_wx_works_list',
  'yootun_wx_work_get',
  'yootun_wx_work_trend_get',
  'yootun_wx_account_overview_get',
  'yootun_wx_fans_profile_get',
  // 爆款与知识（5 项只读）
  'yootun_viral_rewrite_rules_list',
  'yootun_viral_knowledge_search',
  'yootun_viral_knowledge_get',
  'yootun_viral_knowledge_list',
  'yootun_viral_material_board_get',
])

/**
 * Classify one raw Agent tool name (the `__`-stripped name after the
 * `mcp__yootun-agent` prefix).
 * @param rawName - the server-side tool name.
 * @returns the session policy class; anything unlisted is `unknown`.
 */
export function classifyAgentTool(rawName: string): AgentToolClass {
  if (TASK_WRITE_TOOLS.has(rawName)) return 'task-write'
  if (READ_TOOLS.has(rawName)) return 'read'
  return 'unknown'
}

/** The full 36-name Agent contract (read + task-write); the fixture server and contract locks consume it. */
export const AGENT_TOOL_NAMES: readonly string[] = Object.freeze([...TASK_WRITE_TOOLS, ...READ_TOOLS])
