# P4 抖音工作台 D6–D8 UI parity 矩阵

状态：D6–D8 开工锚定（2026-11-22）。上游基准：[p4-douyin-workbench-baseline.md](p4-douyin-workbench-baseline.md)（D0 冻结）、[14-douyin-workbench-ui-layout-parity.md](14-douyin-workbench-ui-layout-parity.md) 与 [p4-douyin-workbench-d2-d5-ui-parity.md](p4-douyin-workbench-d2-d5-ui-parity.md)（D2–D5 先例）。本册逐区域锚定「旧页面 → 新落位」：旧插件 `breakdown.js` / `material-ui.js` / `gene-ui.js` 决定页面结构、功能与任务动线；本仓库决定视觉语言（kit 组件 + 官方 primitives + `--dsw-*`/`--yt-chart-*` token + CSS Modules）。每个按钮先分语义层级再选组件；相邻不同语义按钮不得同为白底。从本分支起，D6–D8 三个 Tab 面板为真实实现（不再是 DataState「未接入」占位）。

## 0. 总骨架

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 爆款拆解 Tab（breakdown.js 386-590） | 两区结构：新建与下载区 + 拆解历史列表；历史行进入详情页（view-detail）；详情页含候选指标 / 原文分段 / 仿写分段 / 分镜脚本 / 工作流状态 / 重仿写 / 强制重试 / 导出 | ydo-ov-panel 白卡 + 主/次按钮 | WorkbenchPage `breakdown` Tab 全宽；`BreakdownPage.tsx`（新建区 + 历史表）与 `BreakdownDetailPage`（同文件内切换） | `DataCard` 分区 + 插件局部 CSS Modules（`bd*` 前缀）；表单官方 `Input`/`Button` | Tab 结构测试：新建区 + 历史表同屏、详情态返回列表 |
| 爆款素材看板 Tab（material-ui.js 916-997） | 四子页下划线页签：素材看板 / 关键词管理 / 对标账号 / 采集记录；看板 = 筛选置顶 + KPI + 候选表 + 评分理由抽屉；种子页 = 表 + 新增/编辑/启停弹层；采集页 = 手动采集 + run 历史 + 失败明细弹层 | ydo-mat-tabs 下划线页签 + ydo-mat-* | WorkbenchPage `material` Tab 全宽；`MaterialPage.tsx` 内二级 SegmentedControl（4 子页，≤4 选项合规） | `SegmentedControl`（页内二级，非 tablist）+ `DataCard` + 局部 CSS Modules（`mat*` 前缀） | 子页 4 项顺序冻结；跨子页跳转（查看看板）受控提升 |
| 爆款基因库 Tab（gene-ui.js 711-830） | 页头（标题 + 失败警示胶囊）+ 检索工具栏（query/品类/采纳态/重置）+ KPI 四卡 + 动态 facets 面板（Top3 + 展开）+ 已选条件条 + 卡片墙 + 加载更多 + 详情/编辑/重建弹层 + 失败列表弹层 | ydo-gene-* 维度色 chip + 复用 mat/report 卡 | WorkbenchPage `gene` Tab 全宽；`GenePage.tsx` | `KpiCard` + `FilterBar` chips + 局部 CSS Modules（`gene*` 前缀，维度色映射 `--yt-chart-*`） | 筛选请求竞态收口；加载更多 offset 递增 |

三级 Tab 层级约束：D7 四子页用页内 `SegmentedControl`（plugin-ui-ux §4.3「第二层改为 SegmentedControl」），不与顶级 SegmentedTabs 构成双层等宽大 tab。

## 1. 爆款拆解：新建与下载区

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 新建拆解（breakdown.js 386-475） | 抖音链接输入（Enter 提交）+ 仿写规则单选卡组（可选，再点取消）+「开始拆解」主按钮（归档受理→3s 轮询 archiveStatus→completed 自动发起工作流）+ 归档进行中 role=status 横幅 | ydo-primary 主按钮 + 规则 radio 卡 | BreakdownPage 新建 DataCard | 输入官方 `Input`；开始拆解=`Button variant=primary`；规则卡 radiogroup 局部 CSS；受理横幅 `StateDot ongoing` + role=status + aria-busy | 开始拆解 primary + 进行中 disabled+aria-busy；失败保留输入与错误码文案 |
| 下载直链（412-457 + 479-511） | 「下载直链」次按钮：downloadStart 受理（幂等键）→ 5s 轮询 downloadStatus（≤210 次对齐服务端 990s 软时限）→ ready 弹出直链弹窗（主链接 + 备用播放链接 + 说明），failed 透出 errorCode 文案 | ydo-secondary 次按钮 + 弹窗 | 新建卡内独立行；`BreakdownDownloadModal` | 下载直链=`Button ghost`（次操作，与主按钮相邻不同 variant）；弹窗官方 `Modal`；链接 `<a target=_blank rel=noreferrer>` 仅白名单域 | 空链接点击给非空提示不发起；下载中 disabled+aria-busy；链接白名单 douyin.com/iesdouyin.com |
| 规则清单（846-851 + 363-380） | rewriteRules 只读（id/name/description，prompt 不下发）；加载失败就近错误 + 重试；空态提示 | radio 卡组 | 新建卡内规则区 | 失败 `role=alert` + 重试 `Button ghost sm`；空态 hint 文案 | 失败可重试；规则不含 prompt 正文（Host 投影已裁） |

## 2. 爆款拆解：历史列表与详情

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 历史列表（513-590） | 标题「拆解记录（团队共享，按时间倒序）」+ 状态筛选（全部/进行中/已成功/未成功，纯前端 tone 归一过滤）+ 5 列表（视频/状态/仿写规则/当前步骤/时间）+ 加载更多（limit 递增 ≤200，默认 10）+ 行点击/Enter 开详情 | 表格 + FilterSelect 下拉 | 历史记录 DataCard | 表格复用 dataTable 底盘；状态筛选官方 `Menu`；行键盘可达（Enter/Space） | 状态筛选四值；hasStoryboard 标记（status=succeeded 保守判定）；加载更多 limit 递增；行 aria-label 含标题 |
| 详情工具栏（637-657） | 返回列表（停全部轮询 + 刷新历史 + 补启动挂起工作流）/ 导出 Excel（仅 succeeded 且 storyboard 就绪可点）/ 重新改写（pending 中禁用） | secondary ×3 靠左 + rewrite 靠右 | 详情页顶工具栏 | 返回/导出/重新改写均 `Button ghost`（同级次操作；重仿写弹层内确认才 primary）；导出带下载图标 | 导出非 succeeded 禁用；返回后历史刷新；导出错误不替换页面（就近 alert） |
| 详情头部（659-684） | 标题/@作者/发布时间/原视频链接（白名单域）+ 状态徽标 + 8 步进度条（当前步高亮、失败整体灰态）+ 失败文案（errorCode→文案字典）+ 强制重试入口（仅 status=failed） | ydo-bd-head 白卡 + 步骤条 | 详情头部 DataCard | 状态 `Tag tone=success/error/warning/neutral`；步骤条局部 CSS（data-state=active/done/todo + `aria-current=step`）；失败 `role=alert` | 8 步名称与顺序冻结；forceRetry 仅 failed 终态；needs_input 区分文案 |
| 候选公开指标 KPI（237-250） | 6 卡：播放/点赞/评论/收藏/分享/互动率（(赞+评+转+藏)/播放 ×100 两位小数）；缺失 — | ydo-bd-kpi 6 卡 | 详情 KPI 行 | 6× `KpiCard`；缺失「—」不补 0 | 六卡齐全；缺失 — |
| 原文拆解折叠卡（695-704） | originalVideoAnalysis：summary 引用 + 分段表（时间/角色(hook/build/turn/cta 色标)/画面/口播） | ydo-ai-card 折叠卡 | 详情折叠区 | `DisclosureRow` 等价折叠（局部 CSS + aria-expanded）；角色 Tag 局部色 | 默认展开；分段四列；角色四枚举 + 其他 |
| 口播全文折叠卡（705-711） | analysis.candidates[0].products.asr.transcript 全文引用；digest 显示字数 | 折叠卡 | 详情折叠区 | 同上 | 缺失「暂未生成」 |
| 改写分镜折叠卡（712-722） | rewrittenStoryboard：summary + 仿写分段卡（角色/时间/来源段落 #n 标注/原片段引用/新口播/画面提示）+ digest 段数与规则名 | 折叠卡 | 详情折叠区 | 同上；来源段落标注纯文本 | 默认展开；sourceSegmentIndexes 装配原片段 |
| 拍摄脚本折叠卡（723-727 + 313-327） | shotScript（status=succeeded 才有 markdown）：Markdown 九列表解析为普通表格（无 HTML 注入面）+ 表外段落；digest 景别配额「远2/中3/近1/特1」 | 折叠卡 + 横向滚动表 | 详情折叠区 | 表格纯文本渲染；缺省「暂未生成」 | 表格解析 head/rows/paragraphs；非 succeeded 显示等待文案 |
| 规则回显折叠卡（728-744） | input.rewriteRuleId/Prompt 回显：规则 pill + 描述 + prompt 原文；无规则显示「默认」 | 折叠卡 | 详情折叠区 | `Tag` + hint | 默认规则文案 |

## 3. 爆款拆解：重新仿写与异步语义

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 重新仿写确认（765-784） | 「重新改写」→ 弹层（规则单选，null=默认链路）+ 取消/开始改写；每次点击新幂等键 `douyin:vv_workflow:{uuid}`；新规则版本=新记录 | ydo-bd-modal 560px | 官方 `Modal` + `BreakdownRulePicker` 复用 | 取消=`ghost`；开始改写=`primary`（弹层内主操作）+ 提交中 disabled+aria-busy | 必须确认；不自动换键重发；Esc 关闭回归焦点 |
| 重新仿写动线（4018-4040） | workflowStart 受理：succeeded（幂等重放）直接拉明细；queued/running/waiting 启动 5s 轮询（优先 retryAfterSeconds，连续 5 次失败停）；failed/needs_input/invalid_input/idempotency_conflict 是同步失败 payload 进详情失败文案 | 受理态切换 | BreakdownPage 轮询 effect | 轮询 interval 常量本地锁定；终态 succeeded 重拉明细 | 终态停轮询；连续失败上限；未知码不误报成功 |
| 强制重试（4209-4218） | status=failed 终态一键重跑：force=true 让服务端重置可恢复失败；规则 natural key 保持一致（workflow_get 恒带 rewriteRuleId 键；同步失败 payload 缺键时回退会话上次所选） | secondary 按钮 | 详情失败区 | 强制重试=`Button ghost`；二次确认弹层（RiskConfirmation 风格） | 仅 failed 可见；force 透传；natural key 一致性 |
| 归档→工作流自动链（4044-4102） | 归档 completed → 刷新历史 → 有 candidateId 且用户不在他详情页则自动 startBdWorkflow；用户在详情页则挂起，返回列表时补启动；failed/cancelled/partial_failed 给归档失败文案 | 状态横幅 + 自动链 | BreakdownPage | 挂起补启动语义保留 | completed 自动链；终态错误文案 |
| 导出（4226-4243） | breakdown.export：CANDIDATE_NOT_FOUND/STORYBOARD_NOT_READY 原样透出文案，其余收敛 export_failed/export_too_large；成功 base64 下载 | 工具栏下载按钮 | 详情工具栏 | `Button ghost` + icon；下载经 `downloadBase64` | 导出错误独立轻提示不替换页面；base64 下载链路 |

## 4. 素材看板：KPI 与筛选

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| KPI 五卡（283-325） | 候选素材（当前筛选 total）/ S-A-B-C 档候选（hotLevelSummary 优先，回退最新批次）/ 本轮新增入库（发现+入库 foot）/ 晋升候选（去重跳过 foot）/ 最近采集（时间+状态） | ydo-mat-kpi 5 卡 | 看板子页 KPI 行 | 5× `KpiCard`；KPI total 用服务端 total，失败时随看板置 —（不沿用旧筛选口径） | 缺失 — 不补 0；筛选失败 KPI 同步降级 |
| 筛选条（331-377） | 搜索 q（300ms 防抖）/ 最低档位（S/A/B/C 及以上）/ 来源类型（keyword/account/both）/ 发布时间（7d/30d/90d/all）/ 标签（facets 计数）/ 排序（9 枚举默认 hot）；变化即查无按钮 | select 下拉行 | 看板子页顶部 FilterBar | 官方 `Menu` 替代原生 select；日期范围换算 publishedFrom/To；筛选变化 offset 归零 + 序号收口 | 6 筛选齐全；q 防抖仅搜索词；最新请求收口 |
| 筛选竞态 | materialSeqRef 序号守卫：过期响应丢弃；失败 total/levelSummary 一并置空 | 无（逻辑层） | MaterialPage state | seq ref 守卫 | 过期响应不覆盖 |

## 5. 素材看板：候选表格与评分理由

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 候选表 12 列（383-491） | 封面（80×80 onError 降级占位）/ 视频（标题链接开系统浏览器 + 标签行缺失显示「标签未返回」warn 色）/ 热度评分（分数+S/A/B/C 档 pill）/ 播放/点赞/评论/收藏/分享（万化）/ 互动率（×100 两位）/ 发布日期 / 命中来源（关键词/对标账号徽标）/ 操作（评分理由实底 mini + 去拆解灰底 mini；操作列 sticky 右） | 高密度表 + 档位实色 pill | 看板子页 DataCard 表格 | dataTable 底盘 + 局部 `mat*` CSS；档位 `Tag`（danger/warning/info/neutral 语义色 + 文字）；长标题/昵称 ellipsis + 完整 aria-label；操作列 sticky | 12 列齐全；缺失 — ；档位色附文字；sticky 操作列 |
| 评分理由抽屉（497-567） | 基础信息（评分/档位/规则版本中文映射/发布日期/视频链接）+ 评分明细表（维度/观测值/加分阈值/得分 pill：+N分 success、未采集 muted、还差 X、0 分）+ 命中理由逐条列表；Esc/遮罩关闭 | 右侧 drawer 420px | `MaterialReasonDrawer`（aside role=dialog aria-modal） | 官方浮层形态 + 局部 CSS；明细表 dataTable；pill 语义色附文字 | 互动率=（赞+评+转+藏）/播放 明细口径注记；结构化对照四态 |
| 去拆解预填（395-406） | 有 shareUrl → 切爆款拆解 Tab 并预填链接聚焦，不自动开始；缺链接置灰 + title 提示 | mini 按钮 | 行操作 | `Button ghost sm` + disabled 原因 title/aria；跨 Tab 预填经 WorkbenchPage 回调 | 只预填不自动归档；无链接禁用 |

## 6. 素材看板：seed 管理

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 关键词 seed 表（573-605） | 6 列：关键词/状态 pill/优先级/单轮搜索/最近更新/操作（编辑 mini + 启用灰底/禁用实底 mini）；副标「禁用后不参与下一轮手动采集；历史 run 仍可追溯」；新增关键词主按钮 | 表 + mini 按钮 | 关键词子页 DataCard | 新增=`Button primary`（子页唯一主操作）；编辑/启停=`ghost sm`；状态 `Tag` | 空态指引文案；启停按钮语义区分 |
| 对标账号 seed 表（607-643） | 7 列：显示名/账号输入（2 行截断 title 全文）/ 输入类型（抖音号/主页链接/sec_user_id）/ 解析状态（已解析/解析失败 error/未解析）/ 状态/最近采集/操作；行 title 透出 lastResolutionError | 表 + mini 按钮 | 对标账号子页 DataCard | 同上；解析失败 `Tag tone=error` | 7 列齐全；解析失败就近提示 |
| seed 弹窗（650-731） | 新增/编辑两态：关键词（keyword 编辑锁定 + 优先级 + 状态）；账号（显示名/输入类型编辑锁定/账号输入/优先级/状态/每次采集上限可选）；失败保留输入 + 错误文案；确认保存 primary | ydo-mat-modal | 官方 `Modal` + `Input`/`Menu` | 取消=`ghost`；确认保存=`primary`+saving disabled+aria-busy | 编辑锁定字段 disabled；幂等键 `douyin:vv_{keyword|account}_upsert:{uuid}`；homepage_url HTTPS 抖音域校验文案 |
| 启停二次确认（893-912） | 禁用/启用确认弹层（文案分支 keyword/account × active/disabled）；确认/取消 | ydo-confirm | 官方 `Modal` | 确认=`primary`；取消=`ghost` | 启停只带身份键 + status（未提交字段保留原值） |

## 7. 素材看板：手动采集与运行历史

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 采集入口与横幅（737-755） | 刷新（次）+ 立即采集（主，activeRun 在途禁用）；activeRun 横幅：spinner + 「采集任务进行中」+ 状态 pill + 开始时间 + 完成后自动刷新提示 + 查看看板链接 | 主/次按钮 + warn 横幅 | 采集记录子页工具栏 | 立即采集=`Button primary`；刷新=`ghost`；横幅 `StateDot ongoing` + role=status | 在途禁用不自动重发；VIRAL_VIDEO_ACTIVE_RUN_EXISTS 冲突文案并恢复轮询 |
| 采集确认弹窗（816-837） | 纯确认式无输入字段：启用关键词/启用对标账号/预计任务数（未加载 —）只读统计 + 外部数据服务提示（单 seed 失败不中断；不自动触发下载/归档/拆解）；确认采集 primary | ydo-mat-modal | 官方 `Modal` | 取消=`ghost`；确认采集=`primary`+提交中 disabled+aria-busy | 确认后才受理；幂等键 `douyin:vv_seed_search:{uuid}` |
| run 历史 9 列表（737-808） | 状态 pill（5 态）/ 开始时间 / 耗时（X分Y秒）/ 关键词数 / 账号数 / 任务成功/失败 / 新增/晋升 / 档位分布（S N · A N…）/ 操作（查看看板 link + 失败明细 danger link）；失败明细按钮按 run 状态/计数判定；failed 且无候选隐藏查看看板 | 表 + link 按钮 | 采集记录子页 DataCard | 状态 `Tag` 五态；查看看板=`ghost sm`；失败明细=error 语义按钮 | 9 列齐全；按钮可见性判定 |
| run 轮询与终态刷新（2938-2969） | 受理即轮询 3s（隐藏页签暂停、连续 5 次失败停）；nextAction≠poll_status 终态 → 刷新 runs/board/seeds/facets；resume 从最新行恢复（失败返回 null 不误清横幅） | 无（逻辑层） | MaterialPage 轮询 effect | interval 常量本地锁定 | 终态四源刷新；resume 语义 |
| 失败明细弹窗（843-877） | 批次/状态/开始时间/耗时/失败数量 + run 级失败原因（code:message 脱敏）+ 失败关键词/账号两列表；无 seed 明细时给 run 级解释 | ydo-mat-modal | 官方 `Modal` | 关闭=`ghost`；错误文案 `role=alert` | 失败原因逐项可解释 |

## 8. 基因库：搜索与筛选

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 检索工具栏（751-773） | query 全文检索（400ms 防抖）+ 品类下拉（facets.category 计数）+ 采纳状态下拉（全部/AI 草稿/已采纳/已修正）+ 重置按钮 | ydo-toolbar | GenePage 顶部 FilterBar | 官方 `Input`（可清空）+ `Menu`；重置=`ghost` | 三筛选 + 重置；防抖仅 query |
| 动态 facets 面板（777-797） | 按维度分组 chip（维度色 hue）+ 计数 + aria-pressed 选中态 + Top3 默认 + 「+N/收起」展开（隐藏 ≤2 默认展开）+ 面板整体收起/展开 | ydo-gene-chip 维度色 | 基因标签筛选 DataCard | chip=局部 CSS（维度色映射 `--yt-chart-1..9` 语义类别色，色彩不承载唯一信息，chip 恒有文字）；展开 `aria-expanded` | Top3+N 展开；chip 选中/移除 |
| 已选条件条（319-338） | 每个已选「维度·标签」chip（点击移除 ✕）+ 清空全部；空时整条隐藏 | ydo-gene-selected | facets 卡尾部 | chip 局部 CSS + aria-live=polite | 移除单项/清空全部 |

## 9. 基因库：KPI 与卡片墙

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| KPI 四卡（340-370） | 知识条目（total）/ 本周新增（last7d）/ 已采纳+已修正比例（adoptedRatio ×100）/ 提取失败待重试（failedCount：=0 中性、>0 标红可点开失败列表）；stats 失败整行 — | ydo-mat-kpi | GenePage KPI 行 | 4× `KpiCard`；失败入口=`Button ghost` + error 语义类 + 计数徽标 | stats 失败 — 不造 0；失败 >0 才可点 |
| 失败警示胶囊（741-749） | 页头「基因提取失败 N」（failedCount>0 才显示）→ 打开失败列表弹窗 | ydo-gene-alert error | GenePage 页头 | error 语义按钮（`Tag tone=error` + 计数）+ 完整 aria-label | =0 隐藏 |
| 基因卡片（253-287） | 封面（onError 降级 + 时长角标）/ 标题（awemeId 合法时链接 douyin.com/video/{id}）/ 作者/发布日期/状态 pill（AI 草稿/已采纳/已修正/提取失败/提取中）/ 标签 chip ≤6（失败显示失败提示）/ 播放/点赞/收藏三指标 / 操作（failed 重试提取 + 查看详情） | ydo-report-work-card | 卡片墙 grid | 卡片局部 CSS（`gene*` 前缀）；指标 `KpiCard` 缩微形态或 dl；查看详情=`ghost sm`；重试提取=error 语义 + 确认 | 缺失 — / 未采集不造 0；封面降级占位；卡片密度对齐旧插件（≥240px 自适应列） |
| 加载更多（807-816） | 「共 N 条 · 当前展示 M 条（加载中…）」+ 加载更多（offset+limit 递增，hasMore 为止） | ydo-mat-meta | 卡片墙尾 | `Button ghost` + disabled（!hasMore/loading） | offset 递增不重置；空态文案 |

## 10. 基因库：详情 / 编辑 / 重建

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 详情弹层头部（634-666） | 封面 + 标题 + 作者/发布/播放/点赞/评论/收藏 meta + 原视频链接 + 标签 chip 全量 + 状态 pill；loading/错误态分别呈现 | ydo-ai-modal | 官方 `Modal`（720 档） | meta 行局部 CSS；链接白名单 | loading/错误/数据三态 |
| 基因标签与依据（429-453） | 每维度：维度名（audience 附「AI 推断」pill）+ 标签 chip + 依据列表（label：basis）；全空显示提示（failed 区分文案） | ydo-gene-dims | 详情分区 | 维度色 chip 同卡片墙；依据列表 | 依据逐条；audience AI 推断标注 |
| 完整拆解报告（372-426） | 报告网格：整体摘要/开头钩子/节奏判断/目标受众/卖点/改写提示（列表顿号连接）/ 受众画像（AI 推断，四态：内容/旧快照待刷新/拆解升级失败/模型未输出/信息不足）/ BGM 风格（风格/节奏/情绪/配合，同四态）/ 分镜段数；缺失显示「未采集」 | ydo-mat-failure-grid | 详情分区 | dl 网格局部 CSS | 字段采集四态文案；缺失「未采集」 |
| 人工编辑面板（457-587） | 标签修正（每维度 ≤maxLabels：chip 移除 + 输入添加，非 succeeded 仅备注可编辑、pending/running 整区禁用）/ 备注 textarea ≤2000 / 采纳状态三段（AI 草稿/已采纳/已修正 + 语义说明）/ 保存修正 primary（saving disabled）/ 编辑记录本期「系统」注记 | ydo-gene-dims 表单 | 详情分区 | 官方 `Input`/textarea 局部 CSS/`SegmentedControl`；保存=`primary`+saving 态 | geneStatus 非 succeeded 仅备注；pending/running 禁用矩阵；保存幂等键 `douyin:vv_gene_upd:{recordId}:{uuid}`；空对象=清空标签 |
| 重建确认（682-700） | 「重新提取基因」→ 确认组（覆盖 AI 标签回到草稿、人工备注保留的警示 + 确认/取消）；regenerate 受理后收起确认组防重复；可能产生费用/异步等待须明示；failed 卡片与失败列表的「重试提取」同链路 | secondary + 确认组 | 详情分区 | 重试/重新提取=`ghost` 入口 + 确认按钮 `primary`；警示文案含费用与异步语义 | 同键重试不换键；pending/running 禁用入口；GENE_EXTRACT_RUNNING 拒绝文案 |
| 失败列表弹窗（590-620） | 失败条目卡：标题 + 失败码（第 N 次尝试；拆解结果不受影响）+ 摘要 + 逐项「重试提取」（retryingId 禁点）；列表/重试错误分别呈现 | ydo-ai-modal | 官方 `Modal` | 重试=`ghost sm`+retrying disabled | 逐项重试；错误双通道 |

## 11. 按钮 / 状态语义映射表（语义层级强制）

| 按钮 | 语义 | 新视觉 |
|---|---|---|
| 开始拆解 / 开始改写（弹层确认）/ 确认保存（seed）/ 确认采集 / 保存修正 / 确认重新提取 / 确认（启停确认） | 主操作 | `Button variant=primary` |
| 下载直链 / 刷新（run 历史）/ 查看看板 / 查看详情 / 重试提取入口 / 重新提取基因入口 / 返回列表 / 重置 / 加载更多 / 加载更多（拆解）/ 重试（规则）/ 关闭 / 取消 / 清空全部 | 次操作 | `Button variant=ghost`（+icon） |
| 失败明细（run 行）/ 基因提取失败胶囊 / 重试提取（failed 卡片） | 危险/警示入口 | error token 文本 + `Tag tone=error`；操作按钮本体 ghost + error 语义类 |
| 启用（灰底→实底）/ 禁用（实底→灰底）seed 行操作 | 行内开关注册 | `ghost sm`（禁用）/ `ghost sm` + primary 语义类（启用）；相邻编辑 ghost 区分 |
| 评分理由 / 去拆解（候选行） | 行内信息/跳转 | `ghost sm` 两枚（信息 vs 跳转），与 danger 入口可辨 |
| 采集中 / 提交中 / 保存中 / 下载中 / 导出中 / 重试中 / 受理中 | 进行中 | disabled + `aria-busy` + spinner/busy 文案 |
| 提取中 / AI 草稿 / 已采纳 / 已修正 / 提取失败 / 已完成 / 部分完成 / 失败 / 排队中 | 状态 | `Tag tone=success/warning/error/neutral` + `StateDot`（附文字） |
| 拆解工作流状态（succeeded/failed/cancelled/needs_input/queued/running/waiting…） | 状态 | `Tag` tone 映射（ok/error/warn/running 归一；未登记按 running 不误报） |

红线：相邻不同语义按钮不得同为白底（primary 与 ghost 相邻成对）；danger 入口永远带确认或警示路径；状态色不得只靠颜色。

## 12. 无法对应项登记

无。截至本册编写日，旧插件 D0 冻结范围内 D6–D8 的全部页面区域均有上表落位。两处旧契约内部说明性差异已核对非缺口：①旧 keyword upsert 允许显式透传内部 `category` 字段（UI 从不展示也不发送），D1 route schema 逐项字段集不含 category，与旧 UI 实际提交面一致；②旧 `material.dashboard` action 已在 v1.8 移除（D0 §3 注记），facets 走 dashboard_get 窄投影。

## 13. 验收锚点 → 测试对账

每个锚点在 `tests/client/douyin-d678.test.tsx` 与 `tests/client/douyin-client.test.tsx`（结构/键盘/词典断言）及 `tests/d6|d7|d8.test.ts`（Host 行为）对账：纯函数（tone 归一/历史筛选/脚本表格解析）、拆解新建区与下载空链接、历史 5 列与状态筛选、详情工具栏/8 步骤/6 KPI/五折叠卡/导出错误就近/辅助源降级/强制重试与重仿写确认、看板 12 列与长文 aria-label/服务端 total 分页/筛选 offset 收口/评分理由四态/seed 弹窗锁定与启停确认/采集确认与 ACTIVE_RUN_EXISTS 冲突/失败明细/去拆解预填/KPI 降级 —、基因 facets 与已选条件/卡片缺失 —/详情四态字段/编辑同键/重建费用确认/失败列表重试、zh/en 键集、Esc 回归焦点。真实浏览器视觉矩阵、真机扫码/采集/模型链路留给 D9 集成验收，不以占位测试伪造。
