/**
 * 会话写操作 guard 的工具分类（分册 08 §4.3）。分类只依据公开工具名，
 * 不读取参数、不改业务 schema。READ_TOOLS / TASK_WRITE_TOOLS 是已分类的
 * 免审批 / 固定审批名单，不是准入闸门：未分类的 yootun Agent 工具由 guard
 * 以 `ask` 交人工确认（不入表也能用，只是每次调用弹审批）。工具清单以
 * tools.dofe.ai `docs/1116/yootun-mcp.md` 为准；新工具按其会话策略决定
 * 是否入表。
 * @module
 */

/** One agent tool's session policy class. */
export type AgentToolClass = 'read' | 'task-write' | 'unknown'

/** Task-type writes and model-fee incurring tools: always `ask` in sessions. */
const TASK_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'yootun_xhs_creative_task_start',
  'yootun_xhs_creative_task_retry',
  'yootun_xhs_creative_task_cancel',
  // 抖音发布排期：同步幂等写（分册 08 §4.3）
  'yootun_douyin_publish_schedule_row_create',
  'yootun_douyin_publish_schedule_row_update',
])

/** Read-only product tools, classified for direct allow. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  // 小红书
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
  // 抖音（含发布排期 list）
  'yootun_douyin_accounts_list',
  'yootun_douyin_works_list',
  'yootun_douyin_work_get',
  'yootun_douyin_work_trend_get',
  'yootun_douyin_collection_run_get',
  'yootun_douyin_account_overview_get',
  'yootun_douyin_account_analysis_get',
  'yootun_douyin_account_trend_get',
  'yootun_douyin_hot_works_list',
  'yootun_douyin_publish_schedule_list',
  'yootun_douyin_analysis_task_get',
  'yootun_douyin_reports_list',
  'yootun_douyin_report_get',
  // 视频号
  'yootun_wx_accounts_list',
  'yootun_wx_works_list',
  'yootun_wx_work_get',
  'yootun_wx_work_trend_get',
  'yootun_wx_account_overview_get',
  'yootun_wx_fans_profile_get',
  // 爆款与知识
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

/** The currently classified Agent tool names (read + task-write); fixture servers and registration assertions consume it. */
export const AGENT_TOOL_NAMES: readonly string[] = Object.freeze([...TASK_WRITE_TOOLS, ...READ_TOOLS])
