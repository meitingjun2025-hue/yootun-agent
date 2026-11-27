# P3 小红书工作台 X0 基线清单（2026-11-20）

X0 基线复核交付物，配套 [12-xhs-workbench-ui-layout-parity.md](12-xhs-workbench-ui-layout-parity.md)（本批已按复核结论修订）。基点为 2026-11-20 的 main（最新提交为 wx-workbench 路由信任对齐官方 connection fence 的修复），分支 `feat/plugin-xhs-workbench`。事实源：

- 旧插件（只读）：`docker-helm.dofe.ai/plugins/dsh-yootun-xhs-operation`（index.js / src/client.js / src/hotboard-ui.js / src/session.js / src/collector.js / src/publisher.js / src/state.js / src/chrome.js / test/*.mjs）
- 服务端契约（只读）：`tools.dofe.ai` `src/tools_dofe/mcp/domains/yootun/workbench/server.py`（L1165–L1694 xhs 19 项）、`src/tools_dofe/mcp/domains/xhs_operation/schemas.py`（请求模型）、`src/tools_dofe/services/xhs_operation/workflow.py`（任务投影）、`hotboard_mcp.py`（看板投影）、`tests/yootun/test_workbench_xhs.py`
- 新侧模板：`yootun/plugins/dsh-wx-channels-workbench`（route/errors/index/handlers 模式）、`yootun/plugins/dsh-workbench-mcp`（`xhs-workbench` caller → `xhs` 组 19 项白名单，whitelist.ts L140）、`yootun/plugins/dsh-media-upload`（四条 `/_dsh/uploader/*` 同源路由）

看板截图证据：12 册开放决策 #3 定为「以源码为准」——本环境无法运行旧插件补拍三页 × 明暗截图，布局证据以第 1 节所列源码文件为准。

## 1. 12 册复核结论

逐页对照旧插件源码后，12 册以下各处与旧插件实际不符，已在本批修订（先修订再冻结）：

| # | 12 册原稿 | 旧插件实际（源码位置） | 修订 |
|---|---|---|---|
| R1 | §5.2 关键词与扩词只有「关键词面板」，且列含「预算信息」「编辑关键词」 | KeywordsPage = 正式关键词管理 + AI 扩词候选审核两个面板（hotboard-ui.js L782–L863）；关键词列为 关键词/类目/状态/来源/操作，仅 新增 + 启用/停用，无编辑、无预算列 | §5.2 重写为双面板；删除预算信息与编辑入口表述 |
| R2 | §5.3 标签与 AI 标记含「候选审核面板（待审核案例）」 | 扩词候选审核在「关键词与扩词」页；「标签与 AI 标记」页 = AI 候选标签提案审核（接受/拒绝/合并 + 合并目标选择，hotboard-ui.js L885–L932）+ 正式标签库（标签列表 + 新增/编辑卡 + 启用/退役，L933–L1005） | §5.3 重写；候选审核面板归位 §5.2 |
| R3 | §5.4 规则面板含「可编辑设置（保存前确认，显示变更回执）」 | 配置全只读（hotboard-ui.js L1007–L1044，2026-10-13 用户裁决：页面可编辑项在执行链路不生效，DB settings 仅 scheduleEnabled 真实生效；服务端 settings_update 仅受理 scheduleEnabled，其余返回 `XHS_HOTBOARD_SETTING_TOML_MANAGED`，server.py L1451–L1474） | §5.4 改为只读配置展示；`hotboard.settingsUpdate` Host action 保留（对齐旧 Host 与 09 册 action 面），UI 不调用 |
| R4 | §5.1 筛选行「综合分区间」 | 旧 UI 只有「评分下限」scoreMin 输入（hotboard-ui.js L702–L704）；scoreMax Host/server 支持但不进 UI | §5.1 改为「综合分下限」 |
| R5 | §3.3 结果卡未列只读附属字段 | versions 附带只读 封面文案/评论引导/图文分页文案（client.js L798–L800） | §3.3 补只读行说明 |
| R6 | §4.2 未提采集截断提示 | 采集触达页数上限时 truncated=true，页面显示 warn 通知条（client.js L994、collectTruncated 文案） | §4.2 补截断警示 |

其余各页（总骨架三 tab、仿写两栏、素材/对标/提交行、右栏五态、账号双栏、看板四子区与 1100px 表格转卡、容器断点 1120/900/640、写操作确认与幂等键）复核一致，无遗漏需补。生成版本数固定 1 为已定案；图片上传上限 9 为已定案（2026-11-20 用户指令：功能完全参考旧插件；服务端 schema 允许 18，仅记录差异不采用）。

## 2. 旧 action → 新 action 映射

新 Host 路由 `/api/desktop/yootun/xhs-workbench`（POST 单端点），action 命名对齐 09 册 §5.3。旧路由 `/api/desktop/yootun/xhs-operation` 行为冻结，新桌面不引用。

| 旧 action（index.js） | 新 action | 备注 |
|---|---|---|
| `create` / `status` / `result` / `cancel` | `task.create` / `task.status` / `task.result` / `task.cancel` | task.create 写操作（confirm + 幂等键）；task.cancel 写操作；幂等键由 Host 生成/校验 |
| `browser.status` | `browser.status` | chromeAvailable/driverAvailable/platform/hint |
| `accounts.list` | `accounts.list` | 本地投影 + 快照摘要 |
| `account.beginLogin` / `account.loginStatus` / `account.probe` / `account.removeLocal` | 同名 | 扫码 run 幂等（waiting 复用）；profile 锁 |
| `collect.start` / `collect.status` | 同名 | 幂等键重放既有 run；页数/笔记进度；truncated |
| `publish.start` / `publish.status` | 同名 | 打开创作者中心发布页（target=image/video）；幂等键；浏览器保持打开锁随 context close 释放 |
| `hotboard.overview` / `noteDetail` / `noteTagUpdate` / `noteExclude` / `keywords` / `keywordSave` / `settings` / `settingsUpdate` / `runStart` / `runGet` / `candidates` / `candidateReview` / `labels` / `labelReview` / `labelSave` | 同名 | 与 `workbench_xhs_hotboard_*` 一一映射；写操作 confirm + 幂等键（§3 对账表） |
| （旧 client 直连）`/_dsh/uploader/pick-file` / `uploadStart` / `uploadStatus` / `media` | `upload.pick` / `upload.start` / `upload.status` / `upload.media` | 上传一律经 `@yootun/dsh-media-upload`：其既有四条同源路由承载这四组语义（1:1），schema/审计/错误码由 media-upload 自带；xhs Host 不重复代理（决策点 D-2） |

幂等键口径（09 册 §5.2）：写操作 Host 侧生成或校验；同一用户点击重试复用原键，重新发起生成新键。具体落法：任务键随任务实例保存（重试取消/重放复用）；采集/发布键随 run 保存；看板写键随确认弹层发起的一次写操作生成（重试同一次操作复用，重新发起新操作新键）；UI 时间戳不作为业务键。

## 3. 19 工具 schema 对账表

请求字段全部照抄 `workbench/server.py` 签名；响应投影以 `hotboard_mcp.py` / `workflow.py` 与旧 Host 投影（index.js）为准。读操作走 `{data, meta}` 信封（hotboard_mcp.py L213 `_envelope`），写操作走 `{ok, updatedCount, idempotentReplay, ...}`。`IdempotencyKey`：1–128 字符去空白（domains/common.py L49）。任何字段不得自造。

| 工具 | Host action | 请求字段 | 响应关键字段 | 写 |
|---|---|---|---|---|
| `workbench_xhs_task_create` | task.create | mediaType(images/video/text)、confirm、idempotencyKey、references≤5{source,url≤2048,title≤200,body≤5000,tags≤20×50}、videoUrl≤2048、imageUrls≤18×2048、coverIndex≥0、theme≤500、direction≤500、videoUnderstanding、accounts≤5{name≤200,…}、factOverrides、versionCount 1–3（新 UI 固定传 1） | `{taskId, status}`；同键同参重放返回最新投影，同键异参 `IDEMPOTENCY_CONFLICT`（test_workbench_xhs.py L48–L73） | 是 |
| `workbench_xhs_task_get` | task.status | taskId 1–64 | `{taskId, mediaType, status, currentStep, nextStep, errorCode, errorMessage, createdAt, updatedAt, steps[], assetAnalysis?, detailResolution?}`（workflow.py L442–L483） | 否 |
| `workbench_xhs_task_cancel` | task.cancel | taskId、confirm、idempotencyKey | 取消投影（status=cancel_requested，Driver 落 cancelled） | 是 |
| `workbench_xhs_result_get` | task.result | taskId 1–64 | 未完成 `{taskId, status, errorCode}`；succeeded `{taskId, status, versions[1–3], styleVersion, promptVersion, model, qualityReport, rawTranscript?, correctedTranscript?}`；version 内 UI 消费 `{version,title,body,tags,coverCopy,leadGuide,issues,pages}`（workflow.py L542–L581；旧投影 client.js L1124–L1149） | 否 |
| `workbench_xhs_hotboard_overview` | hotboard.overview | window(7d/30d/90d,默认30d)、page/pageSize 1–100、keyword≤128、style≤64、color≤64、noteWord≤64、commentWord≤64、scoreMin/scoreMax 0–100、sort(score/publishTime/collect/like/comment/share)、onlyMain(默认true)、onlyTagged | data `{kpis{totalCases,coverageRate,duplicateGroupCount,lowQualityCount,aiTaggedRate,lastCollectedAt,nextRun{scheduleEnabled,cron},failedKeywordCount}, filterOptions{keywords,styles,colors,noteWords,commentWords,scoreShortcuts,windows}, runStatus{runId,status,runType,startedAt,deadlineAt}?, notes[], pagination{}} + meta`（hotboard_mcp.py L546–L648） | 否 |
| `workbench_xhs_hotboard_note_detail` | hotboard.noteDetail | noteId 1–128 | data `{note{title,authorName,noteType,publishTime,link,body,…}, metrics{likeCount,collectCount,commentCount,shareCount,interactionTotal,score7d,score30d,score90d}, currentTags[], images{coverUrl,imageUrls}, similarNotes[], wordStats[]}` | 否 |
| `workbench_xhs_hotboard_note_tag_update` | hotboard.noteTagUpdate | noteId、tagType(style/color)、labelCode≤64、confirm、idempotencyKey | `{ok, updatedCount, idempotentReplay}` | 是 |
| `workbench_xhs_hotboard_note_exclude` | hotboard.noteExclude | noteId、confirm、idempotencyKey | `{ok, updatedCount, idempotentReplay}`（单向过滤，无取消） | 是 |
| `workbench_xhs_hotboard_keywords_list` | hotboard.keywords | category(product/scene)?、status(active/disabled)?、source(built_in/manual/agent)?、keyword≤128?、page/pageSize | data `{keywords[{keywordId,keyword,category,status,source}]} + meta` | 否 |
| `workbench_xhs_hotboard_keyword_save` | hotboard.keywordSave | action(create/update/enable/disable)、confirm、idempotencyKey、keywordId?≤64、keyword?≤128、category? | `{ok, updatedCount, idempotentReplay}`；输入校验前置不烧键（test L192–L222） | 是 |
| `workbench_xhs_hotboard_settings_get` | hotboard.settings | 无参 | data `{scheduleEnabled, fullScheduleCron, publishWindowDays, perKeywordLimit, commentTopN, commentMaxPerNote, minInteractionTotal, dedupHammingThreshold, minValidSample, searchMaxCallsPerDay, commentMaxCallsPerDay, detailMaxCallsPerRun, ruleVersion}` | 否 |
| `workbench_xhs_hotboard_settings_update` | hotboard.settingsUpdate | settings{仅 scheduleEnabled 受理}、confirm、idempotencyKey | `{ok,…}`；TOML 管辖字段返回 `XHS_HOTBOARD_SETTING_TOML_MANAGED`。UI 只读不调用（R3） | 是 |
| `workbench_xhs_hotboard_run_start` | hotboard.runStart | confirm、idempotencyKey、runType(incremental)、includeComments | `{ok, created, idempotentReplay, run{runId,status}}`；额度预检 fail-closed；重放不重复投递（test L235–L262） | 是 |
| `workbench_xhs_hotboard_run_get` | hotboard.runGet | runId?≤64（缺省=最近 run） | data `{run{status,runType,startedAt,finishedAt,errorCode,activeKeywordCount,successKeywordCount,failedKeywordCount,noResultKeywordCount,collectedNoteCount,qualifiedNoteCount,duplicateNoteCount,lowQualityNoteCount,aiTaggedCount,aiPendingCount}, keywordRuns[{keyword,status,collectedCount,qualifiedCount,errorCode}], failedKeywords[{keyword,errorCode}], remainingSearchBudget}` | 否 |
| `workbench_xhs_hotboard_candidates_list` | hotboard.candidates | status(pending/accepted/rejected/expired)?、category?、dateRange[from,to]（YYYY-MM-DD）、keyword?、page/pageSize | data `{candidates[{candidateId,keyword,category,score,reason,status,generatedAt}]} + meta` | 否 |
| `workbench_xhs_hotboard_candidate_review` | hotboard.candidateReview | action(accepted/rejected)、candidateIds 1–50×1–64、confirm、idempotencyKey | `{ok, updatedCount, idempotentReplay, results[{candidateId,ok,errorCode}]}`（行级失败披露） | 是 |
| `workbench_xhs_hotboard_labels_list` | hotboard.labels | tagType(style/color)?、status(active/retired)?、source(business_seed/ai/manual)?、keyword?、proposalStatus(pending/auto_activated/accepted/rejected/merged/expired)?、page/pageSize | data `{labels[{labelId,name,code,aliases,tagType,status,definition,source}], proposals[{proposalId,proposedLabel,tagType,confidence,evidenceNoteCount,status}]} + meta`（两段各自分页） | 否 |
| `workbench_xhs_hotboard_label_review` | hotboard.labelReview | action(accept/reject/merge/enable/retire)、confirm、idempotencyKey、proposalId?/labelId?/targetLabelId?≤64 | `{ok, updatedCount, idempotentReplay}`；参数组合校验前置不烧键 | 是 |
| `workbench_xhs_hotboard_label_save` | hotboard.labelSave | confirm、idempotencyKey、labelId?、tagType?、code?≤64、name?≤128、aliases≤20×128、definition?≤2000 | `{ok, updatedCount, idempotentReplay}`；新增不改 code/tagType（编辑锁定） | 是 |

服务端支持但新 UI 不开放（布局对齐旧插件，仅记录）：`mediaType="text"`、`factOverrides`、references 的 title/body/tags 字段（旧 UI 只传 url/name）、keyword_save 的 update 子动作、scoreMax 筛选输入、settingsUpdate。这些仍走 Host schema 白名单口径——UI 不发，Host schema 也不放行 UI 侧对应字段（对齐旧插件「页面只开放」投影原则）。

## 4. 状态目录探测项（X2 消费）

沿用旧目录，只读探测，不改写旧状态：

- 根目录：`~/.dofe/dsh-yootun-xhs-operation`；env 覆盖 `XHS_OPERATION_STATE_DIR`（state.js L22–L28）
- `accounts.json`：`{version:1, accounts:{<accountId>:{accountId,nickname,avatar,sessionStatus(ok/expired/unknown),sessionCheckedAt,sessionSeq,lastLoginAt,lastCollectedAt}}}`；读失败 ENOENT 视为空、其余抛错（state.js L71–L82）
- `profiles/<seg>/`：每账号独立 Chrome Profile（0700），登录/probe/采集/发布共用
- `storage-state/<seg>.json`：备份（0600，永不外发）；probe 前置检查 `hasStorageState`（缺失 → expired/storage_state_missing）
- `data/<seg>/notes-<stamp>.json`：采集快照（0600，不入库不经 MCP，Q10）；快照 schema `{schemaVersion:1, accountId, capturedAt, source:'creator-web', notes[], truncated?}`，行 `{contentId,title,noteType,publishedAt,metrics{plays,likes,collects,comments,shares},coverUrl,sticky}`
- `safeSegment`：账号 ID 转 `%xx` 转义、160 上限，`.`/`..` 拒绝为 `account`（防目录穿越，state.js L44–L56）
- `pending-` 前缀占位账号：登录未解析出账号 ID 时的临时身份，成功后 moveProfile/moveStorageState 迁移（目标存在绝不覆盖）
- 版本探测：`version` 字段 + 无法识别状态保留原样并报可恢复错误；不批量搬移、不改写
- 删除账号：先清本地（profile/storage_state/快照/accounts 记录）再远端动作；本地清理失败不调远端

Chrome 链路迁移项（X2）：系统 Chrome 探测（无 Chromium 回退、无 stealth 参数，LAUNCH_ARGS 仅 --no-sandbox/--disable-dev-shm-usage）、扫码登录（creator.xiaohongshu.com/login，10 分钟上限，Cookie 名 customerClientId/galaxy_creator_session_id/access-token-creator.xiaohongshu.com/customer-sso-sid，验证码即失败 CAPTCHA_DETECTED 绝不绕过）、user/info 接口探测为会话判定主口径（登录页视觉兜底含 reload 复验）、采集（笔记管理页 `_webmsxyw` 签名 fetch 翻页，签名缺失 fail-loud，页间隔 ≥1s，30 页上限 truncated 可辨）、发布（有头打开 publish/publish?from=menu&target=image|video，浏览器保持打开，锁随 context close 释放）。

## 5. 错误码清单（X1 消费，建 `XhsError` + 稳定码白名单）

路由级（新前缀，对齐 wx 模板）：`XHS_ROUTE_UNKNOWN_ACTION`、`XHS_ROUTE_INVALID_REQUEST`、`XHS_ROUTE_PAYLOAD_TOO_LARGE`、`XHS_ROUTE_REFUSED`。

设备端本地码（沿用旧插件 LOCAL_ERROR_CODES，index.js L40–L52）：`GOOGLE_CHROME_MISSING`、`PLAYWRIGHT_DRIVER_MISSING`、`SESSION_EXPIRED`、`LOGIN_TIMEOUT`、`CAPTCHA_DETECTED`、`COLLECT_FAILED`、`PROFILE_BUSY`、`PUBLISH_FAILED`、`IDEMPOTENCY_KEY_REQUIRED`、`PROBE_FAILED`、`LOGIN_FAILED`。

服务端任务链码（白名单透传，index.js L1165）：`TASK_NOT_FOUND`、`TASK_STATE_CONFLICT`、`RESULT_NOT_READY`、`CONFIRMATION_REQUIRED`、`VALIDATION_ERROR`、`STEP_INPUT_TOO_LARGE`、`ASSET_NOT_FOUND`、`PROVIDER_ERROR`、`IDEMPOTENCY_CONFLICT`、`IDEMPOTENCY_IN_PROGRESS`、`IDEMPOTENCY_OUTCOME_UNKNOWN`；收敛兜底 `xhs_operation_request_failed`。

看板码（白名单透传，index.js L620–L635）：`XHS_HOTBOARD_INVALID_ARGUMENT`、`XHS_HOTBOARD_NOT_FOUND`、`XHS_HOTBOARD_ACTIVE_RUN_EXISTS`、`XHS_HOTBOARD_BUDGET_EXHAUSTED`、`XHS_HOTBOARD_KEYWORD_EMPTY`、`XHS_HOTBOARD_KEYWORD_CONFLICT`、`XHS_HOTBOARD_EVIDENCE_INSUFFICIENT`、`XHS_HOTBOARD_LABEL_CONFLICT`、`XHS_HOTBOARD_AI_SCHEMA_INVALID`、`XHS_HOTBOARD_PROVIDER_FAILED`、`XHS_HOTBOARD_SETTING_TOML_MANAGED`、`XHS_HOTBOARD_INTERNAL_ERROR`（+ 通用 `CONFIRMATION_REQUIRED`/`VALIDATION_ERROR`）。

run 负载内部码（UI 文案映射，hotboard-ui.js L153–L159）：`DETAIL_BUDGET_EXHAUSTED`、`DETAIL_DEADLINE_EXCEEDED`、`COMMENT_BUDGET_EXHAUSTED`、`SOFT_DEADLINE_EXCEEDED`、`SCORE_UPDATE_FAILED`。

上传链路码：由 `@yootun/dsh-media-upload` 既有错误模型自带（X3 直接投影，不在 xhs 域重定义）。UI 只显示稳定码对应的本地化文案，原始错误、预签名 URL、本地路径、Cookie、storage_state 不进 UI/日志/审计。

## 6. 测试与行为参照（旧 test/*.mjs → 新测试计划）

| 旧测试 | 迁移行为 | 新落点 |
|---|---|---|
| task-machine.test.mjs | 任务状态机：创建→轮询→读结果→终态、暂态失败重试、stop 不取消、resume、取消确认后置 cancelled | X4 包级单测（纯逻辑机） |
| upload-machine.test.mjs | per-asset 上传机：进度轮询、done/failed/not_found（仅从未 done 才 failed）、移除/stopAll/resume、组内 hasUploading 拦截 | X3（fetch media-upload 路由） |
| accounts-hub.test.mjs | 账号 hub：登录/采集 2s 轮询、终态清理收敛 idle、Chrome 阻断、probe/移除/采集幂等 | X2 |
| hotboard-ui.test.mjs | 看板 hub：筛选草稿跨页保留、active run 轮询与终态刷新、写操作 pending 计数、行级失败披露 partial 文案 | X5 |
| route.test.mjs | 同源校验、action 白名单、body 上限、错误收敛 | X1（对齐 wx host.test.ts 模式） |
| session/collector/publisher/state/plugin.test.mjs | 登录/采集/发布/状态目录行为 | X2（Chrome 状态机与 safeSegment/0600 权限断言） |

## 7. 阶段映射

X1 Host 骨架消费 §2/§5；X2 登录采集消费 §4；X3 上传消费 §2 上传行与 §6；X4 任务链消费 §3 前四行 + 12 册 §3；X5 看板消费 §3 hotboard 各行 + 12 册 §5；X6 发布/账号管理消费 §2 publish 行 + 12 册 §3.3/§4；X7 集成验收按 09 册 §5.6，本地真实链路按 [13-xhs-workbench-x7-local-e2e-plan.md](13-xhs-workbench-x7-local-e2e-plan.md) 执行（bundle 插入已于 X7 完成：patch 条目 + bundle dependencies + self-test 插入面断言更新）。

## 8. 决策点与风险

| # | 决策/风险 | 状态 |
|---|---|---|
| D-1 | 12 册 R1–R6 修订后冻结；版本数固定 1；图片上传上限 9（对齐旧插件，2026-11-20 用户指令定案，服务端 schema 允许 18 仅记录差异） | 已冻结（X0 复审核实 R1–R6；D-4 见 12 册 §8 决策点 4） |
| D-2 | 上传语义落在 media-upload 既有同源路由（upload.* 1:1），xhs Host 不重复代理 | 已批（2026-11-20 X0 复审） |
| D-3 | `hotboard.settingsUpdate` action 保留但 UI 只读（R3）；「设置变更回执」在只读口径下无 UI 触发面，看板写回执覆盖打标/排除/关键词/候选/标签/运行六类 | 已批（2026-11-20 X0 复审；action 与单测已随 X1 批落地） |
| D-5 | 设备端审计：旧插件 `ctx.yootunAudit`（create/cancel/终态/collect/publish/hotboard 写审计）不迁移——新客户端不做 yootunAudit 服务 / outbox / 补传 / 审计 UI；现阶段只依赖 ixicai 网关调用面（激活、Models、Workbench MCP），现状为服务端 MCP 审计（domain `yootun-workbench`，tools 侧对每次工具调用落审计）+ Host 结构化日志；操作审计留待后期 Yootun 独立建设时统一规划 | 已定案（2026-11-20 用户拍板） |
| R-A | 旧「无头采集后可能触发会话吊销」行为（collector.js 注）：probe/发布报 SESSION_EXPIRED 时引导重新扫码，不做自动重连 | 迁移口径不变 |
| D-6 | 工作台助手：P3 不做（2026-11-20 用户拍板，助手为用户后期独立优化项，现阶段聚焦旧客户端功能完整迁移）；09 册 P3 交付目标 / action 面 / 验收与风险表已同步去除，kit 通用 AssistantDock 组件保持未消费 |
| R-B | 登录终态 run 读一次即清理等旧实现细节按新 TaskRegistry/lifecycle 模式重写。**2026-11-27 偏离**（[1126/features/mount-restore-and-login-alignment.md](../1126/features/mount-restore-and-login-alignment.md) 2.3）：终态改为保留 30 分钟、读取时顺带清理（三工作台统一），`disposeHostTasks` 清空登录与采集记录表；`collect.status` 增按账号查询与终态保留（2.1/2.2） | 有意偏离（有意偏离登记） |
| D-7 | repo 级 hygiene 纳入 X7 检查面：xhs 生产代码 12 处空 catch 当批修复（命名 error + 单语句 try）；仓库 `no-unknown-casts` baseline 登记测试假对象定型断言 17 处（dsh-xhs tests 6 / dsh-wx tests 5 + src 1 / dsh-media-upload tests 4，P1/P2 交付时未登记的既有形态），后续批次只减不增；`rescope-vendor` 失败 4 文件均为上游 master 既有残留（apps/docs/packages/experimental，分支区间零改动），不在 P3 修复范围 | 已执行（2026-11-20 X7） |
| R-C | 生产 Workbench endpoint 冒烟：无 key 探测已证 endpoint 可达、MCP 协议响应、服务端要求 Models API key（-32001）；完整冒烟（serverName + 2026-11-21 后 94 项契约 + 19 项 xhs 子集 + settings 读通）待操作者提供 key 后按 13 册 §3 执行；真实扫码 / 发布 / 上传公网 URL / 未激活零远端请求等真机项同步留待 13 册阶段 C–F | 待 key 与操作者在场扫码 |
