/**
 * Workbench 面 90 项白名单（tools.dofe.ai docs/1116/yootun-mcp.md §4 为单一
 * 事实源，分册 08 §5：任何白名单外工具直接拒绝，不尝试调用）。按工具名精确
 * 匹配；分组只用于白名单与调用方约束，不改变服务端 contract。契约变化时先
 * 更新 tools 文档，再同步本表与测试。
 * @module
 */

/** One Workbench tool group; a caller may only reach its allowed domains. */
export type WorkbenchDomain = 'wx' | 'xhs' | 'douyin' | 'viral' | 'tos'

/** The in-process caller identities; each Host passes its own, never another's. */
export type WorkbenchCaller = 'wx-workbench' | 'xhs-workbench' | 'douyin-workbench' | 'media-upload'

/** 视频号，19 项（§4.4）。 */
const WX_TOOLS: readonly string[] = Object.freeze([
  'workbench_wx_account_save',
  'workbench_wx_account_remove',
  'workbench_wx_session_status_report',
  'workbench_wx_collect_run_start',
  'workbench_wx_collect_run_set_list_meta',
  'workbench_wx_collect_run_heartbeat',
  'workbench_wx_collect_ingest_works',
  'workbench_wx_collect_ingest_account_metrics',
  'workbench_wx_collect_ingest_fans_trend',
  'workbench_wx_collect_ingest_fans_profile',
  'workbench_wx_collect_run_finish',
  'workbench_wx_collect_run_cancel',
  'workbench_wx_account_list',
  'workbench_wx_collect_run_get',
  'workbench_wx_work_list',
  'workbench_wx_work_get',
  'workbench_wx_work_trend',
  'workbench_wx_account_overview',
  'workbench_wx_fans_profile_get',
])

/** 小红书，19 项（§4.1）。 */
const XHS_TOOLS: readonly string[] = Object.freeze([
  'workbench_xhs_task_create',
  'workbench_xhs_task_get',
  'workbench_xhs_task_cancel',
  'workbench_xhs_result_get',
  'workbench_xhs_hotboard_overview',
  'workbench_xhs_hotboard_note_detail',
  'workbench_xhs_hotboard_note_tag_update',
  'workbench_xhs_hotboard_note_exclude',
  'workbench_xhs_hotboard_keywords_list',
  'workbench_xhs_hotboard_keyword_save',
  'workbench_xhs_hotboard_settings_get',
  'workbench_xhs_hotboard_settings_update',
  'workbench_xhs_hotboard_run_start',
  'workbench_xhs_hotboard_run_get',
  'workbench_xhs_hotboard_candidates_list',
  'workbench_xhs_hotboard_candidate_review',
  'workbench_xhs_hotboard_labels_list',
  'workbench_xhs_hotboard_label_review',
  'workbench_xhs_hotboard_label_save',
])

/** 抖音数据域，29 项（§4.2）。 */
const DOUYIN_TOOLS: readonly string[] = Object.freeze([
  'workbench_douyin_account_save',
  'workbench_douyin_account_remove',
  'workbench_douyin_session_status_report',
  'workbench_douyin_collect_run_start',
  'workbench_douyin_collect_run_set_list_meta',
  'workbench_douyin_collect_run_heartbeat',
  'workbench_douyin_collect_ingest_batch',
  'workbench_douyin_collect_ingest_daily',
  'workbench_douyin_collect_run_finish',
  'workbench_douyin_collect_run_cancel',
  'workbench_douyin_account_owner_set',
  'workbench_douyin_work_promotion_save',
  'workbench_douyin_account_list',
  'workbench_douyin_work_list',
  'workbench_douyin_work_get',
  'workbench_douyin_work_trend',
  'workbench_douyin_collect_run_get',
  'workbench_douyin_export',
  'workbench_douyin_account_overview',
  'workbench_douyin_account_analysis',
  'workbench_douyin_account_trend',
  'workbench_douyin_account_analysis_export',
  'workbench_douyin_hot_work_list',
  'workbench_douyin_overview_export',
  'workbench_douyin_account_ai_analysis_start',
  'workbench_douyin_account_ai_analysis_get',
  'workbench_douyin_report_list',
  'workbench_douyin_report_get',
  'workbench_douyin_report_regenerate',
])

/** 抖音工作台独占的 viral 能力，22 项（§4.3）。 */
const VIRAL_TOOLS: readonly string[] = Object.freeze([
  'workbench_viral_archive_submit',
  'workbench_viral_async_submit_get',
  'workbench_viral_douyin_download_url_start',
  'workbench_viral_douyin_download_url_get',
  'workbench_viral_workflow_start',
  'workbench_viral_workflow_get',
  'workbench_viral_candidates_list',
  'workbench_viral_storyboards_list',
  'workbench_viral_analysis_status_get',
  'workbench_viral_rewrite_rules_list',
  'workbench_viral_storyboard_export',
  'workbench_viral_seeds_list',
  'workbench_viral_keyword_seeds_upsert',
  'workbench_viral_account_seeds_upsert',
  'workbench_viral_seed_search_submit',
  'workbench_viral_dashboard_get',
  'workbench_viral_runs_list',
  'workbench_viral_knowledge_search',
  'workbench_viral_knowledge_get',
  'workbench_viral_knowledge_update',
  'workbench_viral_knowledge_regenerate',
  'workbench_viral_knowledge_list',
])

/** 上传授权，1 项（§4.5），仅 media-upload 可用。 */
const TOS_TOOLS: readonly string[] = Object.freeze(['workbench_tos_upload_authorize'])

/** Tools list by domain: 19 + 19 + 29 + 22 + 1 = 90. */
export const WORKBENCH_GROUP_TOOLS: Readonly<Record<WorkbenchDomain, ReadonlySet<string>>> = Object.freeze({
  wx: new Set(WX_TOOLS),
  xhs: new Set(XHS_TOOLS),
  douyin: new Set(DOUYIN_TOOLS),
  viral: new Set(VIRAL_TOOLS),
  tos: new Set(TOS_TOOLS),
})

/** The full 90-name contract as one flat set. */
export const WORKBENCH_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  ...WX_TOOLS, ...XHS_TOOLS, ...DOUYIN_TOOLS, ...VIRAL_TOOLS, ...TOS_TOOLS,
])

/** Each caller's reachable domains; nothing else passes the gate. */
export const CALLER_DOMAINS: Readonly<Record<WorkbenchCaller, readonly WorkbenchDomain[]>> = Object.freeze({
  'wx-workbench': ['wx'],
  'xhs-workbench': ['xhs'],
  'douyin-workbench': ['douyin', 'viral'],
  'media-upload': ['tos'],
})

/** Catalog 面 5 个 yootun_business_* 元工具永远不在 Workbench 白名单内（测试对照用）。 */
export const CATALOG_TOOL_NAMES: readonly string[] = Object.freeze([
  'yootun_business_capabilities_list',
  'yootun_business_capability_get',
  'yootun_business_service_categories_list',
  'yootun_business_tools_search',
  'yootun_business_tool_contract_get',
])

/**
 * Resolve one caller's allowed set.
 * @param caller - the calling Host's identity.
 * @returns the allowed tool names, or `undefined` for an unknown caller.
 */
export function allowedToolsFor(caller: WorkbenchCaller): ReadonlySet<string> | undefined {
  const domains = CALLER_DOMAINS[caller]
  if (domains === undefined) return undefined
  const allowed = new Set<string>()
  for (const domain of domains) {
    for (const name of WORKBENCH_GROUP_TOOLS[domain]) allowed.add(name)
  }
  return allowed
}
