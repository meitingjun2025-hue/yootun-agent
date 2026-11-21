# 分册 15：P4 抖音工作台 D0 冻结基线（草案）

状态：**冻结基线草案，待用户确认冻结**（2026-11-21 起草）。本册是 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §6 P4 D0 的冻结基线总册：冻结点、Host action 矩阵、远端工具覆盖矩阵、状态目录 schema、错误码矩阵、UI 基线摘要、发布排期行为矩阵、测试对账与近期 delta。逐页 UI 契约在 [14-douyin-workbench-ui-layout-parity.md](14-douyin-workbench-ui-layout-parity.md)，服务端工具 schema 以 tools.dofe.ai dev 分支 `docs/1116/yootun-mcp.md` 为单一事实源，本册不复制参数与返回结构。用户确认冻结前本册不是开工依据；确认后旧客户端新增功能只进 §11 观察清单，不改本册。

## 1. 冻结点

- 读取日期 2026-11-21；旧插件仓库 `docker-helm.dofe.ai`，分支 `master`，工作树零未提交改动（`git status --porcelain` 为空）。
- 旧插件 `@dofe/dsh-yootun-douyin-operation` 版本 0.1.0；仓库最新提交为 2026-11-20 22:30（+08:00）的文档提交「yootun Agent 面计数 39/133（排期 list/create/update 追加）」，无裸 commit hash 记录。
- 冻结窗口内最后一个功能提交序列（2026-11-20 及之前）：排期看板真机交互与刷新体验迭代（多条 fix）、排期复选框列与工具栏修复、排期业务反馈五项优化（折叠/横排/排序/斑马纹/行底色统一）、浅色主题斑马纹可见性、yootun 计数文档同步。
- `schedule-ui.test.mjs` 工作区修改时间晚于其余测试文件（2026-11-20），与五项优化迭代同期，已包含在干净工作树内。
- 状态：待用户确认冻结。确认后进入 D1；确认前旧客户端任何新增 action、工具、页面或字段先登记 §11，不进入实现。

## 2. 公网契约复核（2026-11-21）

- `tools/list` 实测基线：Agent 39 项、Workbench 94 项、Catalog 5 项；公共入口 `https://ixicai.cn/mcp/tools/yootun/v1/{agent,workbench,catalog}`。
- 抖音工作台 Workbench 调用面 55 项 = `workbench_douyin_*` 33 项 + `workbench_viral_*` 22 项；`viral` 分组仅 douyin-workbench 可达。
- 发布排期在 Agent 面 3 项：`yootun_douyin_publish_schedule_list`（read）、`..._row_create` / `..._row_update`（task-write/ask）；`row_delete` 按产品决策不进 Agent 面，仅 Workbench 提供。
- 发布排期在 Workbench 面 4 项：`workbench_douyin_publish_schedule_list / row_create / row_update / row_delete`。
- P4 前置 Stage 0 已同步 `@yootun/dsh-managed-mcp`（guard 分类 39）与 `@yootun/dsh-workbench-mcp`（白名单 94、douyin 33）及双方测试。
- Catalog 5 个 `yootun_business_*` 元工具永不进入 Workbench 调用面：与白名单无交集，workbench-mcp 测试逐项拒绝锁定。

## 3. 旧 Host action 全量矩阵（56 项）

旧插件 `index.js` action 分发 switch 恰为 56 个（另有 default `unknown_action`），与 09 册 §6.1 冻结要求一致。新 Host 路由 `/api/desktop/yootun/douyin-workbench`，action 名与旧名一一对应（09 册 P2 先例：重译语义、不改名）。表列：输入字段 / 调用的 Workbench 工具 / 读写 / 幂等（键模板见 §8 与 tools-client 模板表）/ 轮询。Host 只做参数白名单裁剪与稳定错误收敛，不做业务 SQL；调用通道由旧 `douyin-operation` 域（`ctx.tools.execute`）改为 `@yootun/dsh-workbench-mcp`。

| # | action | 输入字段 | Workbench 工具 | 读写 | 幂等键模板（douyin: 前缀） | 轮询 |
|---|---|---|---|---|---|---|
| 1 | browser.status | — | —（本地 Chrome 探测） | R | — | — |
| 2 | accounts.list | — | `workbench_douyin_account_list` | R | — | — |
| 3 | account.beginLogin | accountId? | 登录后 `workbench_douyin_account_save` | W | account:{id}:{时间戳}（刻意时间戳） | loginStatus |
| 4 | account.loginStatus | accountId / loginKey | —（Host 内存登录 run） | R | — | 本身是轮询 |
| 5 | account.probe | accountId | （本地探测）+ `workbench_douyin_session_status_report` | W | session:{id}:{sessionSeq} | — |
| 6 | account.removeLocal | accountId | —（本地清理） | W | — | — |
| 7 | account.removeRemote | accountId | `workbench_douyin_account_remove`（confirm） | W | account_remove:{id}:{时间戳} | — |
| 8 | collect.start | accountId, maxPages? | `workbench_douyin_collect_run_start → collect_run_set_list_meta → collect_run_heartbeat → collect_ingest_batch → collect_ingest_daily → collect_run_finish` | W | run_start:{attempt}/list_meta:{runId}/heartbeat:{runId}:{seq}/ingest:{runId}:{batchNo}/daily:{runId}/run_finish:{runId} | collect.status |
| 9 | collect.status | accountId | —（Host 内存采集状态） | R | — | 本身是轮询 |
| 10 | collectAll.start | —（无参；候选本地筛选） | 同 #8（逐账号串行）+ 逐账号 probe 上报 | W | 同 #8 | collectAll.status |
| 11 | collectAll.status | — | —（Host 内存批量状态） | R | — | 本身是轮询 |
| 12 | works.list | accountId, includeNotInList? | `workbench_douyin_work_list` | R | — | — |
| 13 | work.get | accountId, workId | `workbench_douyin_work_get` | R | — | — |
| 14 | work.trend | accountId, workId | `workbench_douyin_work_trend` | R | — | — |
| 15 | run.get | runId | `workbench_douyin_collect_run_get` | R | — | — |
| 16 | export | accountId（format 固定 xlsx） | `workbench_douyin_export` | R（导出下载） | — | — |
| 17 | overview.get | accountIds≤200, publishFrom/To, ownerName?, sort?, topN?, hotType?, cursor?, limit?, ruleVersion? | `workbench_douyin_account_overview` | R | — | — |
| 18 | hotWorks.list | 同 #17（显式剔除 ownerName） | `workbench_douyin_hot_work_list` | R | — | — |
| 19 | overview.export | accountIds, publishFrom/To, ruleVersion（schema 仅四参） | `workbench_douyin_overview_export` | R（导出下载） | — | — |
| 20 | account.analysis | accountId, publishFrom/To?, sort?, ruleVersion? | `workbench_douyin_account_analysis` | R | — | — |
| 21 | account.trend | accountId, metric?（默认 play）, fromDay/toDay?, cohortDelta?, contractVersion? | `workbench_douyin_account_trend` | R | — | — |
| 22 | accountAnalysis.export | accountId, publishFrom/To?, ruleVersion? | `workbench_douyin_account_analysis_export` | R（导出下载） | — | — |
| 23 | aiAnalysis.start | accountId, idempotencyKey | `workbench_douyin_account_ai_analysis_start` | W | ai_analysis:{requestUuid} | aiAnalysis.get |
| 24 | aiAnalysis.get | accountId | `workbench_douyin_account_ai_analysis_get` | R | — | 本身是轮询 |
| 25 | breakdown.rewriteRules | — | `workbench_viral_rewrite_rules_list` | R | — | — |
| 26 | breakdown.archiveStart | shareUrl, idempotencyKey, confirm | `workbench_viral_archive_submit` | W | vv_archive:{requestUuid} | archiveStatus |
| 27 | breakdown.archiveStatus | runId | `workbench_viral_async_submit_get` | R | — | 本身是轮询 |
| 28 | breakdown.downloadStart | shareUrl, idempotencyKey | `workbench_viral_douyin_download_url_start` | W | vv_download:{requestUuid} | downloadStatus |
| 29 | breakdown.downloadStatus | jobId | `workbench_viral_douyin_download_url_get` | R | — | 本身是轮询 |
| 30 | breakdown.workflowStart | candidateId, idempotencyKey, confirm, rewriteRuleId?, force? | `workbench_viral_workflow_start` | W | vv_workflow:{requestUuid} | workflowStatus |
| 31 | breakdown.workflowStatus | workflowId 或 candidateId, limit≤20 | `workbench_viral_workflow_get` | R | — | 本身是轮询 |
| 32 | breakdown.detail | candidateId | `workbench_viral_storyboards_list` + `workbench_viral_analysis_status_get` + `workbench_viral_candidates_list` | R | — | — |
| 33 | breakdown.export | candidateId | `workbench_viral_storyboard_export` | R（导出下载） | — | — |
| 34 | breakdown.history | limit≤200（默认 10；递增全量拉，无游标） | `workbench_viral_workflow_get` | R | — | 加载更多 |
| 35 | report.list | reportType(daily/weekly), periodStart, status?, limit≤100, cursor?, allVersions? | `workbench_douyin_report_list` | R | — | 分页 |
| 36 | report.get | reportId | `workbench_douyin_report_get` | R | — | — |
| 37 | report.regenerate | reportId, idempotencyKey | `workbench_douyin_report_regenerate` | W | report_regenerate:{reportId}:{attemptUuid} | — |
| 38 | account.owner.set | accountId, ownerName（trim 后 ≤128，超长拒绝不截断）, idempotencyKey | `workbench_douyin_account_owner_set` | W | account_owner_set:{requestUuid} | — |
| 39 | work.promotion.save | accountId, workId, playCount, fansCount, costAmount（定点串 ≤999999999999.99）, durationHours（>0，≤999999.99）, recordId?, idempotencyKey | `workbench_douyin_work_promotion_save` | W | work_promotion_save:{requestUuid} | — |
| 40 | schedule.list | accountId | `workbench_douyin_publish_schedule_list` | R | — | — |
| 41 | schedule.rowCreate | accountId, confirm=true, idempotencyKey | `workbench_douyin_publish_schedule_row_create` | W | publish_schedule_create:{attemptUuid} | — |
| 42 | schedule.rowUpdate | accountId, rowId, expectedVersion, confirm=true, idempotencyKey + 10 业务字段整行 | `workbench_douyin_publish_schedule_row_update` | W | publish_schedule_update:{rowId}:{attemptUuid}（键内 rowId 必须与参数一致） | — |
| 43 | schedule.rowDelete | accountId, rowId, expectedVersion, confirm=true, idempotencyKey | `workbench_douyin_publish_schedule_row_delete` | W | publish_schedule_delete:{rowId}:{attemptUuid}（键内 rowId 必须与参数一致） | — |
| 44 | material.seeds.list | — | `workbench_viral_seeds_list` | R | — | — |
| 45 | material.keyword.upsert | keywords≤1000（每条 keyword≤128、priority P1–P5、status active/disabled、searchCount 1–100）, confirm=true, idempotencyKey | `workbench_viral_keyword_seeds_upsert` | W | vv_keyword_upsert:{requestUuid} | — |
| 46 | material.account.upsert | accounts≤1000（inputForm ∈ douyin_id/homepage_url/sec_user_id；homepage_url 限 HTTPS 抖音域）, displayName?, priority?, status?, maxVideos 1–100, confirm=true, idempotencyKey | `workbench_viral_account_seeds_upsert` | W | vv_account_upsert:{requestUuid} | — |
| 47 | material.collect.start | idempotencyKey, keywordLimit≤500?, accountLimit≤500?, priorities≤10?, candidateMinLevel S/A/B/C? | `workbench_viral_seed_search_submit` | W | vv_seed_search:{requestUuid} | collect.status |
| 48 | material.collect.status | runId | `workbench_viral_async_submit_get` | R | — | 本身是轮询 |
| 49 | material.videos.list | taskId?, runId?, minLevel?, sourceType?, candidateId?, awemeId?, storyboardStatus?, sortBy（9 枚举，默认 hot）, offset?, limit≤1000（默认 200）, q?, sourceKeyword?, accountSeedId?, publishedFrom/To?, tag?, scope='material', sourceKind? | `workbench_viral_candidates_list` | R | — | 分页 |
| 50 | material.runs.list | offset?, limit≤100（默认 20） | `workbench_viral_runs_list` | R | — | 分页 |
| 51 | material.facets | — | `workbench_viral_dashboard_get`（materialFacets.tags 投影） | R | — | — |
| 52 | gene.search | query≤128?, category?, geneTags?, adoptionStatus ∈ ai_draft/adopted/revised?, offset?, limit≤50 | `workbench_viral_knowledge_search` | R | — | — |
| 53 | gene.get | recordId | `workbench_viral_knowledge_get` | R | — | — |
| 54 | gene.update | recordId, idempotencyKey, geneTags?（空对象=清空）, manualNotes≤2000?, adoptionStatus? | `workbench_viral_knowledge_update` | W | vv_gene_upd:{recordId}:{attemptUuid} | — |
| 55 | gene.regenerate | recordId, idempotencyKey | `workbench_viral_knowledge_regenerate` | W | vv_gene_reg:{recordId}:{attemptUuid} | — |
| 56 | gene.list | geneStatus ∈ pending/running/succeeded/failed?, offset?, limit≤200 | `workbench_viral_knowledge_list` | R | — | — |

矩阵注记：#3 登录本身是设备端扫码长动作，Host 侧工具调用只有登录成功后的 `account_save` 上报；#5/#8/#10 的会话上报走 `session_status_report`；#26/#27 与 #47/#48 复用同一异步受理/轮询工具对；#32 为三源独立降级（storyboards 缺失即失败，分析状态与候选指标失败单独透出）；导出四 action（#16/#19/#22/#33）共用 base64/字节数自洽复核、文件名二次净化与响应上限防线。旧源码注释中「素材看板 9 个 action」为历史值，`material.dashboard` 已在 v1.8 移除，实际 8 个（#44–#51）。

## 4. 远端工具覆盖矩阵

### 4.1 抖音数据域：旧 route 33 项 → Workbench 33 项

旧 `douyin-operation` route（tools-client.js `TOOL_NAMES` 登记 33 项）与 `workbench_douyin_*` 33 项一一对应，全部被旧插件消费：

| 旧工具（douyin-operation） | workbench 工具 | 旧 Host action（§3 序号） |
|---|---|---|
| douyin_account_save | workbench_douyin_account_save | account.beginLogin（3）、采集自愈（8/10 内部） |
| douyin_account_remove | workbench_douyin_account_remove | account.removeRemote（7）、pending 清理（3/5/8/10 内部） |
| douyin_session_status_report | workbench_douyin_session_status_report | account.probe（5）、collect（8/10 内部） |
| douyin_collect_run_start | workbench_douyin_collect_run_start | collect.start（8）、collectAll.start（10） |
| douyin_collect_run_set_list_meta | workbench_douyin_collect_run_set_list_meta | 同上（含可选 publishSince） |
| douyin_collect_run_heartbeat | workbench_douyin_collect_run_heartbeat | 同上 |
| douyin_collect_ingest_batch | workbench_douyin_collect_ingest_batch | 同上 |
| douyin_collect_ingest_daily | workbench_douyin_collect_ingest_daily | 同上 |
| douyin_collect_run_finish | workbench_douyin_collect_run_finish | 同上 |
| douyin_collect_run_cancel | workbench_douyin_collect_run_cancel | 无 Host action（§11 缺口 G-1） |
| douyin_account_owner_set | workbench_douyin_account_owner_set | account.owner.set（38） |
| douyin_work_promotion_save | workbench_douyin_work_promotion_save | work.promotion.save（39） |
| douyin_publish_schedule_list | workbench_douyin_publish_schedule_list | schedule.list（40） |
| douyin_publish_schedule_row_create | workbench_douyin_publish_schedule_row_create | schedule.rowCreate（41） |
| douyin_publish_schedule_row_update | workbench_douyin_publish_schedule_row_update | schedule.rowUpdate（42） |
| douyin_publish_schedule_row_delete | workbench_douyin_publish_schedule_row_delete | schedule.rowDelete（43） |
| douyin_account_list | workbench_douyin_account_list | accounts.list（2）、采集会话恢复（8/10 内部） |
| douyin_work_list | workbench_douyin_work_list | works.list（12） |
| douyin_work_get | workbench_douyin_work_get | work.get（13） |
| douyin_work_trend | workbench_douyin_work_trend | work.trend（14） |
| douyin_collect_run_get | workbench_douyin_collect_run_get | run.get（15） |
| douyin_export | workbench_douyin_export | export（16） |
| douyin_account_overview | workbench_douyin_account_overview | overview.get（17） |
| douyin_hot_work_list | workbench_douyin_hot_work_list | hotWorks.list（18） |
| douyin_overview_export | workbench_douyin_overview_export | overview.export（19） |
| douyin_account_analysis | workbench_douyin_account_analysis | account.analysis（20） |
| douyin_account_trend | workbench_douyin_account_trend | account.trend（21） |
| douyin_account_analysis_export | workbench_douyin_account_analysis_export | accountAnalysis.export（22） |
| douyin_account_ai_analysis_start | workbench_douyin_account_ai_analysis_start | aiAnalysis.start（23） |
| douyin_account_ai_analysis_get | workbench_douyin_account_ai_analysis_get | aiAnalysis.get（24） |
| douyin_report_list | workbench_douyin_report_list | report.list（35） |
| douyin_report_get | workbench_douyin_report_get | report.get（36） |
| douyin_report_regenerate | workbench_douyin_report_regenerate | report.regenerate（37） |

### 4.2 viral 能力：22 项 → Workbench 22 项

旧 `viral-video` route 中旧抖音插件白名单内的 22 项与 `workbench_viral_*` 22 项一一对应；viral 分组仅 douyin-workbench 可达：

| 旧工具（viral-video） | workbench 工具 | 旧 Host action（§3 序号） |
|---|---|---|
| viral_video_archive_submit | workbench_viral_archive_submit | breakdown.archiveStart（26） |
| viral_video_async_submit_get | workbench_viral_async_submit_get | breakdown.archiveStatus（27）、material.collect.status（48） |
| viral_video_douyin_download_url_start | workbench_viral_douyin_download_url_start | breakdown.downloadStart（28） |
| viral_video_douyin_download_url_get | workbench_viral_douyin_download_url_get | breakdown.downloadStatus（29） |
| viral_video_workflow_start | workbench_viral_workflow_start | breakdown.workflowStart（30） |
| viral_video_workflow_get | workbench_viral_workflow_get | breakdown.workflowStatus（31）、breakdown.history（34） |
| viral_video_candidates_list | workbench_viral_candidates_list | breakdown.detail（32）、material.videos.list（49） |
| viral_video_storyboards_list | workbench_viral_storyboards_list | breakdown.detail（32） |
| viral_video_analysis_status_get | workbench_viral_analysis_status_get | breakdown.detail（32） |
| viral_video_rewrite_rules_list | workbench_viral_rewrite_rules_list | breakdown.rewriteRules（25） |
| viral_video_storyboard_export | workbench_viral_storyboard_export | breakdown.export（33） |
| viral_video_seeds_list | workbench_viral_seeds_list | material.seeds.list（44） |
| viral_video_keyword_seeds_upsert | workbench_viral_keyword_seeds_upsert | material.keyword.upsert（45） |
| viral_video_account_seeds_upsert | workbench_viral_account_seeds_upsert | material.account.upsert（46） |
| viral_video_seed_search_submit | workbench_viral_seed_search_submit | material.collect.start（47） |
| viral_video_dashboard_get | workbench_viral_dashboard_get | material.facets（51） |
| viral_video_runs_list | workbench_viral_runs_list | material.runs.list（50） |
| viral_video_knowledge_search | workbench_viral_knowledge_search | gene.search（52） |
| viral_video_knowledge_get | workbench_viral_knowledge_get | gene.get（53） |
| viral_video_knowledge_update | workbench_viral_knowledge_update | gene.update（54） |
| viral_video_knowledge_regenerate | workbench_viral_knowledge_regenerate | gene.regenerate（55） |
| viral_video_knowledge_list | workbench_viral_knowledge_list | gene.list（56） |

旧 route 中未被旧抖音工作台白名单收录的 14 个 viral 工具按 tools 文档 §4.6 继续留在旧 route、不进 Workbench 面。

### 4.3 Agent 面 39 项

Agent 面由 `@yootun/dsh-managed-mcp` 独占注册；抖音相关 15 项中排期 list 为 read、排期 create/update 为 task-write（会话 ask），其余 12 项 read。完整清单与 guard 分类在 managed-mcp `guard.ts`（39 项测试锁定）；源能力映射在 tools 文档 §3.2。本册不重复全表。

### 4.4 Catalog 面

`yootun-catalog` 5 个 `yootun_business_*` 元工具只描述 Agent 39 + Workbench 94 共 133 个业务工具；永不进入 Workbench 调用面（workbench-mcp 白名单无交集、测试逐项拒绝）与 Agent 面（guard 分类 unknown，fail-closed）。

## 5. 状态目录与 schema

- 目录：`~/.dofe/dsh-yootun-douyin-operation`；环境覆盖 `DOUYIN_OPERATION_STATE_DIR`（resolve 后使用）。新插件沿用该目录，不因包名变化迁移。
- `accounts.json`：`{ version: 1, accounts: { [accountId]: record } }`；record 字段：`accountId`、`sessionSeq`（单调递增，初始 0）、`sessionStatus`（ok/expired/unknown）、`sessionCheckedAt`、`nickname?`、`avatar?`（标准化 http(s) 串）、`fanCount?`、`promotedFrom?`（pending- 占位升级别名）、`lastLoginAt?`、`vaultRef`（`vault://douyin/<safeSegment(accountId)>` 不透明引用）。写入为 tmp + rename 原子替换，文件权限 0600；`STATE_VERSION` 恒 1，解析失败或无 accounts 键按空态处理，非 ENOENT 读取错误向上抛。
- `profiles/<safeSegment(accountId)>/`：每账号独立 Chrome Profile，目录 0700；登录后从 pending- 临时目录 rename 迁移到正式账号目录。
- `storage-state/<safeSegment(accountId)>.json`：Playwright storage_state 备份，0600；`hasStorageState` 以「文件存在且非空」判定；`clearLocalCredentials` 同时删 Profile、storage_state 与 accounts 记录。
- `safeSegment`：账号 ID 来自抖音侧不信任字符集，落盘前收敛 `[A-Za-z0-9._-]`，其余替换 `_`，空值归 `account`，上限 128。
- 会话序号：`nextSessionSeq` 每账号持久化自增；`markSessionOk` 支持 `floorSessionSeq`（远端当前 seq）对齐下限后再 +1，防多设备 stale 上报；`markSessionExpired` 在采集链路命中确定性过期时直接置 expired 并取下一序号。
- 锁与互斥：**旧插件无磁盘锁文件**。互斥全部是 Host 进程内语义：单账号采集控制器（每账号单 run）、批量控制器（单飞）、登录 run Map、批量与单账号互斥（`collect_busy`）。09 册 §12.4 要求的「崩溃或重启后 run 恢复」旧插件未实现——进程重启丢失本地采集状态，远端 run 仅可经 `collect_run_get` 查询（§11 缺口 G-2）。
- 权限与路径安全：Cookie 与 storage_state 只留设备端，不进响应、日志、tools 参数或审计；tools 只收 `vault://` 不透明引用与设备探测出的会话状态；chmod 失败容忍（Windows 语义有限）。
- 升级/兼容风险：pending- 占位账号升级需迁移 storage_state/Profile/记录并远端删除占位行（与在途采集互斥）；远端墓碑行（delete_state=remote_deleted）投影层过滤，不进账号列表；无法识别的旧状态保留原样并给可恢复错误，不批量改写；storage_state 权限保持 0600；删除账号先清本地再远端，本地清理失败阻断远端删除。

## 6. 错误码矩阵

错误三层投影，每层只回稳定码，不透传原始报文：

**本地校验层（Host 入参拒绝，不发请求）**：`method_not_allowed`、`body_too_large`、`unknown_action`、`account_id_required`、`work_id_required`、`run_id_required`、`share_url_required`、`candidate_id_required`、`job_id_required`、`report_id_required`、`row_id_invalid`、`version_invalid`、`idempotency_key_required`、`INVALID_IDEMPOTENCY_KEY`（键模板不符/键内 rowId 与参数行不一致）、`CONFIRMATION_REQUIRED`、`VALIDATION_ERROR`、`TOO_MANY_ACCOUNTS`（overview >200）、`INVALID_HOMEPAGE_URL`、`INVALID_SORT`、`OWNER_NAME_REQUIRED`、`OWNER_NAME_INVALID`（>128）、`PROMOTION_FIELD_REQUIRED`、`PROMOTION_VALUE_INVALID`（非法/超限定点串）、`collect_busy`（批量与单账号互斥）、`no_eligible_account`、`session_required`/`storage_state_missing`（采集前置）、`expected_work_count_out_of_range`（范围内 >10000）、`publish_since_required`（范围过滤发生却未声明 publishSince 的确定性失败）、`cleanup_failed`（本地清理残留）、`export_too_large`（宿主复核 1MB 内容 / 1.8MB 序列化上限）、base64 长度与声明字节数不自洽 → `export_failed`。

**Host 兜底层**：白名单外一律 `douyin_operation_request_failed`；工具未注册 `DOUYIN_TOOL_UNAVAILABLE`。编排层本地合成码：`session_invalid`（HTTP 200 + status_code=8，采集立即中止并上报 expired）、`batch_size_out_of_range`、`run_not_started`、`batch_no_out_of_range`、`expected_work_count_out_of_range`；页面 fetch 层 reason 映射：`login_timeout`、`login_failed`、`probe_failed`、`refresh_failed`、`account_save_failed`、`export_too_large`、`export_failed`；排期保存 fetch 超时本地合成为 `IDEMPOTENCY_OUTCOME_UNKNOWN` 并置行状态 unknown。新实现对应 workbench-mcp 稳定码投影（`workbench_tool_denied` / `workbench_not_activated` / `workbench_network_error` / `workbench_protocol_error` / `workbench_call_timeout` / `workbench_call_cancelled` / `workbench_call_failed` / `workbench_credential_unavailable` / `workbench_unavailable`）。

**服务端稳定层（tools-client `ALLOWED_ERROR_CODES` 白名单，isError envelope 收敛）**，按域分组：

- 账号/作品/采集：`ACCOUNT_NOT_FOUND`、`ACCOUNT_NOT_ACCESSIBLE`、`WORK_NOT_FOUND`、`RUN_NOT_FOUND`、`RUN_ACCOUNT_MISMATCH`、`RUN_NOT_RUNNING`、`RUN_STILL_ACTIVE`、`RUN_LIST_META_REQUIRED`、`HEARTBEAT_SEQ_REGRESSED`、`PUBLISH_SINCE_MISMATCH`、`DAILY_DAY_IN_FUTURE`、`UNAUTHORIZED`、`PAYLOAD_TOO_LARGE`。
- 通用幂等/校验：`INVALID_IDEMPOTENCY_KEY`、`IDEMPOTENCY_KEY_REQUIRED`、`CONFIRMATION_REQUIRED`、`VALIDATION_ERROR`、`IDEMPOTENCY_CONFLICT`、`IDEMPOTENCY_IN_PROGRESS`、`IDEMPOTENCY_OUTCOME_UNKNOWN`。
- 导出：`DOUYIN_EXPORT_TOO_LARGE`、`INVALID_CURSOR`、`INVALID_TIME_WINDOW`、`INVALID_METRIC`、`INVALID_SORT`、`CONTRACT_VERSION_MISMATCH`、`TREND_RANGE_TOO_LARGE`、`RULE_VERSION_MISMATCH`、`OVERVIEW_SAMPLE_TOO_LARGE`。
- AI 分析：`AI_ANALYSIS_RUNNING`、`AI_ANALYSIS_GLOBAL_CONCURRENCY_LIMIT`、`AI_ANALYSIS_INSUFFICIENT_DATA`、`AI_ANALYSIS_MODEL_FAILED`、`AI_ANALYSIS_SCHEMA_INVALID`、`AI_ANALYSIS_TIMEOUT`、`AI_ANALYSIS_ENQUEUE_FAILED`、`AI_ANALYSIS_MODEL_CONFIG_MISSING`、`AI_ANALYSIS_PROMPT_INVALID`。
- AI 报表：`REPORT_NOT_FOUND`、`REPORT_DISABLED`、`REPORT_INSUFFICIENT_DATA`、`REPORT_MODEL_FAILED`、`REPORT_SCHEMA_INVALID`、`REPORT_TIMEOUT`、`REPORT_TRUNCATED`、`REPORT_INPUT_TOO_LARGE`、`REPORT_PAYLOAD_TOO_LARGE`、`REPORT_ENQUEUE_FAILED`、`REPORT_MODEL_CONFIG_MISSING`、`REPORT_LEASE_EXPIRED`、`REPORT_PROMPT_INVALID`。
- 拆解与下载：`ASYNC_RUN_NOT_FOUND`、`UNKNOWN_REWRITE_RULE`（成功 envelope 内 errorCode）、`CANDIDATE_NOT_FOUND`、`STORYBOARD_NOT_READY`、`DOUYIN_DOWNLOAD_URL_MISSING`、`PROVIDER_ERROR`、`ONEAPI_BUDGET_EXHAUSTED`、`DOWNLOAD_JOB_NOT_FOUND`、`DOWNLOAD_JOB_TIMEOUT`、`DOWNLOAD_JOB_NOT_CLAIMABLE`、`DOUYIN_VIDEO_DOWNLOAD_FAILED`、`DOUYIN_TOS_UPLOAD_FAILED`、`TOS_PRESIGN_FAILED`。
- 素材看板：`VIRAL_VIDEO_NO_ACTIVE_SEEDS`、`VIRAL_VIDEO_ACTIVE_RUN_EXISTS`、`VIRAL_VIDEO_SEED_LIMIT_INVALID`、`VIRAL_VIDEO_SEARCH_DISPATCH_FAILED`。
- 负责人/投流：`OWNER_NAME_REQUIRED`、`OWNER_NAME_INVALID`、`PROMOTION_ALREADY_EXISTS`、`PROMOTION_NOT_FOUND`。
- 基因库：`KNOWLEDGE_NOT_FOUND`、`GENE_NOT_READY`、`GENE_EXTRACT_RUNNING`、`GENE_INPUT_MISSING`、`GENE_EXTRACT_MODEL_FAILED`、`GENE_EXTRACT_TIMEOUT`、`GENE_EXTRACT_PARSE_FAILED`、`GENE_EXTRACT_QUALITY_FAILED`、`GENE_EXTRACT_LEASE_EXPIRED`、`GENE_EXTRACT_DISABLED`。
- 发布排期：`SCHEDULE_ROW_NOT_FOUND`、`SCHEDULE_ROW_CONFLICT`、`SCHEDULE_VALIDATION_ERROR`。

**发布排期必覆盖六码**（新 Host 与 UI 必须逐条映射，不得弱化）：

| 稳定码 | 语义 | UI 行状态（rowStatusOnFailure） |
|---|---|---|
| SCHEDULE_ROW_NOT_FOUND | 行不存在或已被删除 | failed（保留输入，同键重试/刷新/放弃） |
| SCHEDULE_ROW_CONFLICT | 版本冲突（expectedVersion 不匹配） | conflict（输入只读，提示刷新） |
| SCHEDULE_VALIDATION_ERROR | 保存内容不合法（DTO 领域校验显式转换） | failed（保留输入） |
| IDEMPOTENCY_CONFLICT | 同键不同参数 | failed（提示刷新，禁止静默覆盖） |
| IDEMPOTENCY_IN_PROGRESS | 同请求在途 | saving 语义（稍后查看结果） |
| IDEMPOTENCY_OUTCOME_UNKNOWN | 结果未知 | unknown（只允许同键重试或刷新确认，禁止换新键） |

UI 文案映射沿用旧插件各模块的 reason→文案字典（schedule 的 `SCHEDULE_ERROR_REASON_COPY` 全表已在旧源码登记；report/gene/ai-analysis/拆解导出各有独立字典），新实现按 typed dictionary 重写键集，语义不裁剪。

## 7. UI 基线

布局、信息架构、功能与任务动线完全参考旧插件；视觉与 CSS 按本仓库规范重做。逐页契约、区域关系、交互与可达性要求以 [14 册](14-douyin-workbench-ui-layout-parity.md)为权威，本册只冻结骨架与证据面：

- 顶级 Tab 固定 7 个，顺序不增不减不重排：账号总览 / 账号作品 / 发布排期看板 / 爆款素材看板 / 爆款拆解 / 爆款基因库 / AI 报表。单账号分析是账号总览 Tab 内的下钻页，不是顶级 Tab；返回总览保留筛选。
- 页面骨架（PluginPageShell 内重译）：账号总览=筛选工具栏+KPI 行+账号列表/热门作品/分布+运营提醒+导出；账号作品=左账号管理栏+右作品面板（采集、进度、表格、详情弹层、导出、负责人/投流入口）；发布排期看板=工具栏+12 视觉列表格+底部账号栏+删除确认弹层；爆款素材看板=KPI+筛选+看板表格+评分理由抽屉+seed 管理（关键词/对标账号）+手动采集与 run 历史+失败明细弹层；爆款拆解=新建与下载区+历史列表+详情页（分段对照、分镜脚本、工作流状态、重仿写确认、强制重试、多 sheet 导出）；爆款基因库=筛选+已选条件条+KPI+失败记录入口+卡片墙+详情/编辑/重建弹层；AI 报表=列表（日报/周报）+详情（KPI、趋势、质量覆盖、洞察、版本切换、重建确认、导出）。
- 弹层与抽屉清单（冻结）：作品详情弹层（跨账号显式携带所属账号）、删除确认（排期）、seed 管理弹层、失败明细弹层、评分理由抽屉、基因详情/编辑/重建、报表详情、仿写规则选择、重新仿写确认、强制重试确认。宿主形态用官方 Modal/浮层体系，不恢复 sidebar footer 弹层。
- 导出清单（冻结）：作品导出（xlsx）、总览导出、账号分析导出、拆解详情多 sheet 导出、报表 HTML/PDF。全部走 base64→本地下载链路，文件名二次净化 + 强制前缀 + 尺寸自洽复核。
- 状态契约：每个操作具备 loading/empty/error/partial/disabled/focus/hover/pressed/selected；采集展示 running/completed/partial/failed/session_expired；AI 与报表展示受理/运行/失败/数据不足。
- 旧插件页面模块证据面：overview-ui、analysis-ui（单账号分析）、schedule-ui、material-ui、breakdown、gene-ui、report-ui、select-ui、ui-format、trend-chart、avatar；index/client 为宿主骨架。
- 禁止迁移：`ydo-*` 类名与旧 CSS、旧全局/inline style、旧固定色值与几何、旧 sidebar footer 弹层宿主形态、旧公共 MCP route 直连（14 册 §1/§11 红线）。

## 8. 发布排期行为矩阵

行为语义冻结自旧插件 `schedule-ui.js`、`index.js` schedule handler 与 RQ-2026-013 开发/验收文档；新实现不得裁剪任何一条。

**行字段与列顺序**：12 视觉列 = 序号 + 10 业务列 + 操作。业务列顺序固定：拍摄日期（date）、视频内容（textarea ≤2000）、拍摄情况（checkbox，副标「需要补拍或配音在下方补充」）、是否发布（checkbox）、成片/封面网盘链接（url ≤2048，副标「编导和账号主理人确认」）、备注（textarea ≤2000）、发布日期（date）、发布平台（多选 ≤3：小红书/抖音/视频号）、拍摄负责人（≤128）、剪辑负责人（≤128）。文本字段空串归 null、超长显式拒绝不截断；平台白名单重读 + 去重 + 固定顺序 xhs→douyin→wx_channels；`created_by`/`updated_by` 不进 UI。

**编辑与保存**：新增行成功后聚焦视频内容输入，失败不插本地伪行，在途禁连点并注册离开确认；文本/链接/负责人 blur 触发整行保存，checkbox 与平台 change 触发，date 字段 change 即保存（原生选择器关闭后 blur 不一定触发）；保存体必含整行业务字段 + expectedVersion，缺省≠保留旧值；idle 行失焦前先比较归一化业务快照，一致则不调用更新、不递增 rowVersion（no-op 判定）；保存中可继续输入进 dirty 快照，成功后如有差异用**新幂等键**补提交一次。

**rowVersion 乐观锁**：服务端 `SELECT … FOR UPDATE` 行锁 + expectedVersion 比对，不匹配报 `SCHEDULE_ROW_CONFLICT`；成功后 rowVersion +1 单调递增不回绕。rowId/rowVersion 在 UI/Host 边界用十进制字符串（Host 只放行 1..Number.MAX_SAFE_INTEGER；MCP 契约仍 1..2^63-1，双层边界刻意）；排序按十进制字符串数值序，不得先转 Number。

**幂等键**：create `douyin:publish_schedule_create:{attemptUuid}`（不嵌 rowId）；update/delete `douyin:publish_schedule_{update|delete}:{rowId}:{attemptUuid}`（键内 rowId 必须与参数行一致，防跨行重放，Host 与服务端双重校验）；attemptUuid 为 32 hex 或 8-4-4-4-12 UUID；同键同参重放返回首次结果，同键异参报 `IDEMPOTENCY_CONFLICT`；零副作用受理拒绝不烧键、可同键重试。create 重试键按 accountId 隔离保存（切回原账号复用同键恢复，切其他账号不复用）。

**行状态机**：`idle | saving | queued | failed | conflict | unknown`。saving 在途、继续编辑只更新 dirty 快照不发第二请求；queued 为 dirty 队列语义（由 saving+dirty 承载）；failed 确定性失败、保留输入、只允许同键重试/刷新整行/显式放弃；conflict（SCHEDULE_ROW_CONFLICT）输入只读、提示刷新；unknown（超时或 IDEMPOTENCY_OUTCOME_UNKNOWN）只允许同键重试或刷新确认，禁止换新键盲试。非 idle 行禁用删除；delete 在途整行只读且禁编辑保存。

**互斥**：账号切换互斥——任一行 saving/queued/unknown，或 failed/conflict 且持有未提交修改时禁止切换；整表刷新互斥——saving/queued 在途禁止刷新，failed/conflict/unknown 持 dirty 时禁止刷新（无 dirty 允许刷新，这是行级恢复路径）；delete 在途禁刷新。

**删除**：仅 idle 行可开二次确认弹层（显示行序号/内容与不可恢复提示）；确认后携带 confirm=true + 当前 expectedVersion + 新键；物理删除返回 `{deleted, row_id}` 不含 rowVersion；已删行不复活、墓碑语义与远端账号删除解耦（删账号不删排期）。

**放弃修改**：先用最近服务端快照立即还原本地内容（不等刷新），回 idle，再重拉列表；还原内容不得触发自动保存。

**展示规则**：已发布组折叠置顶（仅 idle 且 published 行参与折叠；在途/异常行保持可见直到落定；折叠状态会话内保留；全部已发布且收起显示提示行）；未发布组按发布日期升序（YYYY-MM-DD 同形字典序），无日期排组内最后，同日期按 rowId 十进制序稳定排序；斑马纹只作用于未发布组内、按组内奇偶计算，状态色优先于斑马纹，深浅主题下行背景/sticky 列/状态色一致（行底色由 td 承载：默认 base、斑马 layer-1、已发布成功色 12%、saving 品牌色 8%、error 错误色 8%）。

**数据边界**：list 按 id ASC 不分页，产品边界单账号 ≤200 行，未来 >500 必须另行游标分页不得默默截断；账号校验走 require_active_account（不存在 ACCOUNT_NOT_FOUND、墓碑 ACCOUNT_NOT_ACCESSIBLE）。

**异步轮询与超时（冻结）**：页面 fetch 统一 30s + `redirect: 'error'` + same-origin 凭证；工具调用默认 60s。轮询节奏：登录 2s、采集进度 1.5s、AI 分析 3s（优先服务端 pollIntervalSeconds）、拆解归档 3s、仿写工作流 5s（连续失败 5 次终止）、稳定下载 5s×210 次（对齐服务端 990s 软时限）、素材受理 3s；报表详情轮询 5s、离开页面停止。新实现轮询节奏保持同量级，具体值可按 Host 服务实现调整并在 D1 记录。

## 9. 测试与 E2E 对账

旧插件 `test/` 共 28 个 `*.mjs`（15 922 行）。类型事实：**无一文件需要真机 Chrome**——扫码/浏览器测试全部用假 page / fake chromium driver 编码真机回归结论（如 2026-10-17 死 Cookie 假成功回归锁）；「假 MCP」= 进程内 callTool stub / 假工具注册表 + 临时状态目录（mkdtemp）；动态悬停交互明确标注由真机 Playwright 截图另行验证。新实现**不复制旧测试代码**：按 `@yootun` 包结构、workbench 面（`@yootun/dsh-workbench-mcp` 假 server）与插件 UI/UX 规范重写，逐条迁移下表的行为验收点；旧测试中锁定的真机回归结论作为行为语义保留。

| 旧测试文件 | 覆盖行为（迁移为验收点） | 类型 | 新实现 |
|---|---|---|---|
| schedule-ui.test.mjs | 排期看板全量：12 列结构与顺序、toUiRow 投影丢弃 created_by/updated_by、非白名单平台不入投影、rowId 十进制串比较不走 Number、buildServerSnapshot 归一、失败码→行状态映射、conflict/unknown 只读、乐观锁版本覆盖与 dirty 补提交、dirty 队列、非 idle 禁删、账号切换互斥矩阵、错误码文案、无账号空态与失败态区分、账号栏 chip 选中态、墓碑账号过滤、刷新禁用矩阵（unknown/conflict 无 dirty 可恢复刷新）、create 失败不插伪行/在途禁连点/按账号隔离重试键/beforeunload、三入口整行保存、no-op 失焦、放弃修改先还原、删除确认仅 idle、迟到响应不跨账号串板、排序/折叠/斑马纹、className 白名单与无内联样式、受控输入 onChange 锚、复选框 td 回归锚 | UI 渲染 + 纯逻辑 | 全部重写（kit 组件 + typed dictionary 键集测试） |
| publish-since.test.mjs | 上海时区 cutoff 与服务端字面量同一时刻、cutoff 边界（前一秒不保留/恰为 cutoff 保留）、混合新旧作品页只采范围内、全部范围外不产生批次、publish_time 缺失不入库且 listComplete=false、翻页失败范围内部分保留、范围内未超 MAX 不中止、列表阶段失效无 partialCollected、详情阶段失效部分成果只含范围内、失效收尾 listMeta 带范围声明且 listComplete=false、恢复重发同值、缺省 payload 不含键、单账号与批量共用过滤路径 | 假 MCP server | 以 workbench 假 server 重写 |
| session.test.mjs | sessionid/sessionid_ss 识别、轮询超时、verify 探活通过才算登录并带出资料、死 Cookie 不假成功不落 storage_state（真机回归锁）、同源 fetch 读资料、扫码链路存 storage_state→迁 Profile、超时不写登录态、无 Chrome 不回退 Chromium、probe 无 storage_state 直接 expired、sessionSeq 单调（markSessionExpired 在最大值上继续、markSessionOk 先对齐远端下限）、removeLocalAccount 清理、资料迟到重试、真实 sec_uid 不落 pending、占位升级整体迁移且保留更大序号 | 纯逻辑（假 page + 临时目录） | 全部重写 |
| state.test.mjs | 目录默认与 DOUYIN_OPERATION_STATE_DIR 覆盖、safeSegment、sessionSeq 按账号单调、upsert 保留字段、Profile 迁移、storage_state 0600、删除三清、迁移源缺失不抛错 | 纯逻辑 | 全部重写 |
| tools-client.test.mjs | structuredContent/isError/content 三态错误拦截、白名单外收敛兜底码、safeErrorCode 容忍 `Error: ` 前缀、extractJsonEnvelope 三形态、toWireArgs 剔 undefined/非有限数值/-0 归一、session 键模板严格、拆解/素材/排期/采集范围各工具白名单与稳定码登记、受理键模板一致性 | 纯逻辑 | 以 workbench-mcp 白名单与稳定码投影重写等价锁 |
| plugin.test.mjs | 同源路由注册/405/未知 action 400、无 Chrome 提示不回传路径、本地远端账号合并本地优先、tools 不可用仍返本地、探测上报不含 Cookie、分段边界工具匹配、删除先本地后远端且失败阻断、登录状态机、头像 http(s) 白名单、account_save 失败透出 saveError、载荷无 undefined、collect 前置会话就绪、批量顺序执行/复用/互斥/no_eligible_account、幂等键 ≤128、占位升级与别名翻译、导出固定 xlsx + 双上限 + base64 自洽 + 文件名净化、overview 白名单、analysis/trend 白名单与契约版本码、aiAnalysis 模板、拆解全家桶（规则不含 prompt 正文、detail 三源降级、camelCase→snake_case 投影）、DOUYIN_TOOL_UNAVAILABLE 收敛、material 八 action 契约 | 假 MCP server | 按新 Host action 契约重写 |
| runner.test.mjs | 缺会话文件 session_required、成功链路分批入库结算、expired→ok 恢复先对齐下限、profile 不一致不恢复、远端已 ok 只同步 seq、服务端拒绝不误报、采集抛错收敛稳定码、ingest_failed、同账号单飞、自愈补 account_save（只带 vault:// 引用）、头像回写六条边界、列表阶段失效不建 run、user/info 阶段失效 partial 收尾、finishExpiredSession 有/无作品两分支、批量控制器九条（顺序/单飞/互斥/拦截原因/no_eligible_account）、日度入库失败不阻断并 emit dashboard_gap、dashboard 阶段过期作品照常入库 | 假 MCP server | 全部重写 |
| ingest.test.mjs | run_start→list_meta→分批→finish 键模板、runAttemptId 点击内复用重启复用、重复批次服务端去重、批内单作品失败隔离、run/account 不匹配与心跳回退确定性不重试、租约过期自动重建 run 重发 list_meta、空账号 run+元信息结算归服务端、list_meta 失败终止、listComplete=false 报 partial、重复 finish 返回 replayed、批次退避重试、batchSize 越界、取消幂等终止后可重开、resolveClientStatus 仅完整且成功数=预期才 completed、daily 键与 fansProfile、空 daily 无副作用、dashboard 主表优先浅合并、dashboard.gaps→dashboard_gap 事件 | 假 MCP server | 全部重写 |
| collector.test.mjs | 分页 12/页、跨页去重、五种不完整判定、status_code=8 全端点立即中止、partialListWorks 带出、详情拦截优先 + fetch 兜底、低播放 10001 记缺口、goto 退避、热词三态、超 expectedWorkCount 提前中止、dashboard 未来日丢弃/全占位记缺口不造 0、metrics_trend 直取口径、留存/跳出直取 | 纯逻辑（假 page） | 全部重写 |
| parse.test.mjs | fixture 契约、百分比/数值换算无 -0、19 位 aweme_id 不丢精度、会话失效不解析成空列表、item_compare 10001/10005 缺口语义、流量来源降序、画像前 8、进度曲线秒→百分比、趋势上限与越界、dashboard 13 指标×日合并、fans 六指标、隐私榜单物理剔除、metrics_trend 双指标只取 view_count、buildWorkPayload 三路合并缺口语义 | 纯逻辑（fixtures） | 按 fixture 语义重写（fixtures 可参照不复制） |
| chrome.test.mjs | 最小启动参数无自动化规避、平台 Chrome 候选路径、缺 Chrome 阻断不回退、驱动缺失可识别、独立 Profile | 纯逻辑 | 全部重写 |
| avatar.test.mjs | 图集 url_list 解析、危险协议与超长置 null、collector/session 同输入同输出、对象头像不透出 | 纯逻辑 | 全部重写 |
| gene-ui.test.mjs | gene.search/update 入参清洗与键模板、坏键拒绝、失败入口状态机、facets Top3+N、已选 chip、失败卡重试、未采集「—」、提取中禁用矩阵、className 白名单、受众/BGM 四态 | UI 渲染 | 按 kit 组件重写 |
| host-writes.test.mjs | owner.set 全量透传与超长拒绝、promotion 形状与 recordId、量级就地拒绝、overview.export schema 外丢弃、schedule 四 handler 白名单/confirm/键模板/键内 rowId 绑定/十进制串转正整数/非法入参 Host 拦截、业务错误透传 | 假 MCP server | 按新 Host 契约重写 |
| material-ui.test.mjs | 错误文案表、状态 pill、KPI 投影、筛选即查、候选表缺失「—」、封面 onError 降级、抽屉、采集弹框纯确认、账号表文案、评分理由逐条、关键词表、runs 表、activeRun 横幅、失败弹框两列、materialCandidateCount 回退、评分理由结构化对照卡、历史候选标注、client.js 接线（Tab/i18n/轮询守卫/幂等键模板）、确认弹框四分支、index 8 action 分发 | UI 渲染 | 按 kit 组件重写 |
| overview-owner-column.test.mjs / overview-owner-filter.test.mjs | 排行负责人列契约、窄容器 data-label、负责人选项去重中文排序「全部」恒首、空串不透传、导出参数收敛 | UI 渲染 | 重写 |
| owner-ui.test.mjs | 负责人弹框结构与校验、保存投影更新与竞态守卫、负责人失联清空选择、Esc 链、accounts.list 透传 ownerName | UI 渲染 | 重写 |
| promotion-ui.test.mjs | 表单校验分键、预填、提交契约（金额时长字符串/计数整数）、PROMOTION_ALREADY_EXISTS 文案、stale-add 恢复重拉转更新、详情守卫、三处投流入口 | UI 渲染 | 重写 |
| report-ui.test.mjs | 3 报表工具 + 13 稳定码、键模板两段、available=false 显示 —、环比涨红跌绿注明基准、账号表无收藏列、作品卡、AI 三分区、趋势 7/4 点 null 柱与断线退化、insufficient 空态四信号、pending/running 等待卡、printToPDF 桥与兜底、HTML 自包含导出、17 码中文文案、两级导航、详情轮询 5s 离开停止 | UI 渲染 | 按 kit/ChartFrame 重写 |
| select-ui.test.mjs | 自绘下拉 DOM listbox、键盘全路径、禁用态、连续按键、失焦成对关闭 | UI 渲染 | 官方 Menu 原子件替代，行为验收点迁移 |
| analysis-owner.test.mjs / report-owner.test.mjs / style-reuse.test.mjs / desktop-compat.test.mjs / render-smoke.test.mjs | 负责人行渲染与请求白名单、快照语义、只复用既有类无内联样式、Desktop 登记契约/CSS 命名空间/凭证卫生/Escape 焦点/aria-live、真实 React 渲染不抛错 | UI 渲染/源码契约 | 新实现等价锚：i18n 键集、无硬编码 copy、凭证卫生、Escape 焦点回归 |
| ui.test.mjs | 作品 Tab 切号缓存与序列号守卫、表格列序与指标文案契约、10 数值列排序三态循环、缺失恒最后、缺失显示 — 不造 0、百分比 clamp、缺口中文映射、链接白名单、会话过期专属文案、详情子页全部区块、导出下载链路、批量进度文案三态、观看趋势四状态、AI 分析折叠、总览下钻保留筛选、v2 账号目录、爆款分布前三配色、悬停层键齐全（动态行为真机截图另验） | UI 渲染 | 按 kit 组件重写并保留行为验收点 |

**真机验收项**（09 册 §6.6 承载，本册只列清单）：系统 Chrome 扫码登录、创作者中心真实采集（列表/详情/大盘三连）、采集范围 2026-06-01 边界、发布排期真实 create/update/delete 与账号切换互斥、素材手动采集真实受理与轮询、AI 分析与报表真实受理/轮询/重建、四类导出真实下载、明暗主题与三档宽度、动态悬停交互（旧基线由真机 Playwright 截图验证，新实现同口径）。

## 10. 近期新增功能 delta（2026-11-17 至冻结日）

| 变更 | 日期 | 事实 | 纳入 P4 |
|---|---|---|---|
| 发布排期看板（RQ-2026-013） | 2026-11-16 开发、上线后迭代至 11-20 | Host 4 action + 服务端 4 工具；行为矩阵见 §8 | 是（14 册 §6，不得裁剪） |
| 采集范围收敛（1117 方案） | 2026-11-17 | 所有抖音账号只采集 publish_time ≥ 2026-06-01 00:00:00 Asia/Shanghai（等价 2026-05-31T16:00:00Z）；过滤发生在详情采集前；publish_time 缺失不入库且 listComplete=false（publish_time_missing）；三种采集入口均生效；读路径零改动，存量 6 月前作品继续展示 | 是（账号作品页采集语义） |
| publishSince 语义 | 2026-11-17 | run 级可选参数=「本轮采集范围起点」；服务端固定字面量唯一受理（+08:00 变体拒绝 → PUBLISH_SINCE_MISMATCH 零副作用不烧键）；缺省 None=全量语义且不覆盖既有非空范围；范围化 run 的 listComplete 只表示范围内完整；范围内空列表结算 completed 并豁免可疑空采集；结算只对范围内未见且非 not_in_list 作品；诊断字段 publishSince/skippedBeforePublishSince/publishTimeMissing 纯计数 | 是（采集链路与 run 展示） |
| 排期业务反馈五项优化 | 2026-11-20 | ① 已发布折叠（§8 展示规则）② 发布平台横排（列宽 220、表格 min-width 2250）③ 未发布行发布日期升序 ④ 组内斑马纹（偶数行 layer-1）⑤ 行底色统一由 td 承载 + sticky 列随行同色 | 是（§8 已冻结） |
| P3 遗留修复代码化 | 2026-11-17 | no-op 失焦跳过、create 初始快照、SCHEDULE_VALIDATION_ERROR 稳定码转换、attemptUuid 正则收紧、放弃修改还原、create beforeunload、按账号隔离重试键、SchedulePage render smoke | 是（已并入 §8 行为矩阵） |
| legacy 快照基线机制切换 | 2026-11-17 | tools 侧 legacy snapshot 从 commit 指针改为内容 SHA-256；policy golden 155→159 | 否（tools 侧事实，仅记录） |
| yootun Workbench 收录排期四工具 | 2026-11-20 | 镜像名 workbench_douyin_publish_schedule_* 收录，90→94；裸名不出现在 yootun registry/taxonomy/policy/snapshot | 是（Stage 0 已同步桌面侧） |
| 浅色主题斑马纹可见性修复 | 2026-11-20 | 深浅主题观感仍可再调，旧仓库标记为遗留项 | 是（新实现按官方 token 重做时覆盖） |

## 11. 缺口与观察清单

- **G-1 collect.cancel**：`douyin_collect_run_cancel` 工具与幂等键模板（`douyin:run_cancel:{runId}`）已登记，且采集编排层（ingest.js 取消路径）有真实调用；但旧 Host action 分发 56 项中无独立取消入口（无 collect.cancel），页面不可主动取消进行中采集。09 册 §4.3 建议的新 action 清单含 collect.cancel。是否在新 Host 暴露用户可触发的取消由 D1 决定，本册不猜测实现。
- **G-2 run 恢复**：旧插件采集控制器状态是 Host 进程内存（runs Map / batch 单飞 / loginRuns），进程重启后在途 run 的本地状态丢失；远端 run 仅可经 collect_run_get 查询。09 册 §12.4 要求「崩溃或重启后 run 恢复」，旧基线没有该能力——新实现的状态恢复设计是 D1 交付物。
- **G-3 折叠态持久化**：已发布折叠状态旧基线是会话内内存态；新宿主是否跨会话保留由 D1/UI 决定。
- **G-4 排期分页**：单账号 >200 行的游标分页服务端未提供（产品边界内不裁剪）；若未来突破 500 行需先补 tools 契约再进桌面。
- **观察**：确认冻结后旧客户端新增功能一律登记本节并标注「是否迁入」，不提前实现；旧 route 与 yootun Workbench 是两套独立 registry，旧 route 新增工具不自动进 Workbench 94。

## 12. 验收记录要求

D0 验收记录按 09 册 §9 追加：实际改动范围、测试命令与结果、本册 §2 契约复核输出、用户冻结确认。确认冻结后本册与 14 册共同构成 D1–D9 的不可变基准；任何偏离在对应批次验收记录中登记理由。
