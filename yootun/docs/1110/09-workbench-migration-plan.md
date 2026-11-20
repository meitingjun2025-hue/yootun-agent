# 分册 09：内置工作台迁移开发计划（2026-11-16）

## 0. 定位与固定顺序

本册把 [08-plugin-mcp.md](08-plugin-mcp.md) 的三工作台方案拆成可执行的开发顺序、交付边界和验收口径。服务端契约已经完成并部署：Agent 36 项、Workbench 90 项、Catalog 5 项，公共入口为 `https://ixicai.cn/mcp/tools/yootun/v1/{agent,workbench,catalog}`。

迁移顺序固定为：

```text
P1 桌面共用基础设施
P2 视频号工作台
P3 小红书工作台
P4 抖音工作台
P5 三工作台集成验收与出包
```

顺序依据：

1. 视频号链路最短：19 个远端工具、无模型费用、无异步 Models 任务，适合先验证 Host 私有 MCP、Chrome 采集状态机、本地状态目录和新工作台 UI；
2. 小红书依赖上传、采集、任务、爆款看板和发布，适合在共用组件与私有 MCP 验证后第二个落地；
3. 抖音旧客户端这两天仍会新增功能，最后迁移可以减少重复基线和返工；在正式开工前必须重新勘察旧插件并冻结迁移基线。

不允许调整顺序。前一个批次未完成本地验收、review 和 merge 前，不开工下一个批次的产品代码。等待期间可以维护抖音变更观察清单，但不把未验收功能提前写入产品实现。

## 1. 分支与交付节奏

| 批次 | 建议分支 | 交付物 | 合并方式 |
|---|---|---|---|
| P1 | `feat/plugin-workbench-infrastructure` | workspace、UI kit、Agent/Workbench 连接器、上传能力、打包闭包 | `merge --no-ff` 回 main |
| P2 | `feat/plugin-wx-workbench` | 视频号内置工作台 | `merge --no-ff` 回 main |
| P3 | `feat/plugin-xhs-workbench` | 小红书内置工作台 | `merge --no-ff` 回 main |
| P4 | `feat/plugin-douyin-workbench` | 抖音内置工作台 | `merge --no-ff` 回 main |
| P5 | `feat/plugin-workbench-release` | 集成验收、出包与真机清单 | `merge --no-ff` 回 main |

每个编码批次按可独立交付的阶段提交，提交信息使用中文 Conventional Commits。所有阶段先本地 commit；是否 push 由用户决定。每批完成后执行官方目录对账，任何 `yootun/` 外的改动必须已登记在 [../inline-changes.md](../inline-changes.md)。

## 2. 共用工程边界

### 2.1 仓库分区

新增包放在两个分区：

```text
yootun/packages/dsh-client-ui-kit/
yootun/plugins/dsh-managed-mcp/
yootun/plugins/dsh-workbench-mcp/
yootun/plugins/dsh-media-upload/
yootun/plugins/dsh-wx-channels-workbench/
yootun/plugins/dsh-xhs-workbench/
yootun/plugins/dsh-douyin-workbench/
```

包名：

```text
@yootun/dsh-client-ui-kit
@yootun/dsh-managed-mcp
@yootun/dsh-workbench-mcp
@yootun/dsh-media-upload
@yootun/dsh-wx-channels-workbench
@yootun/dsh-xhs-workbench
@yootun/dsh-douyin-workbench
```

`pnpm-workspace.yaml` 现有 `yootun/packages/*` 覆盖 UI kit；需要扩展登记 `yootun/plugins/*`。这是官方文件改动，必须先扩展 inline 登记簿 #1，再修改 workspace。改动后刷新 lockfile，并跑 `pnpm install --frozen-lockfile`、constraints 和 lint。

### 2.2 旧插件的使用方式

旧仓库只读：

```text
docker-helm.dofe.ai/plugins/dsh-yootun-wx-channels-operation
docker-helm.dofe.ai/plugins/dsh-yootun-xhs-operation
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation
docker-helm.dofe.ai/plugins/dsh-yootun-tos-upload
```

允许迁移：

- Host 状态机；
- Chrome 扫码和采集流程；
- 解析与校验逻辑；
- 稳定错误码；
- 本地状态兼容规则；
- 业务数据投影。
- 布局、信息架构与任务动线：各工作台 UI 的产品基准以旧插件为准。

不得迁移：

- 旧视觉样式、CSS、类名与实现技术；
- `md-*` / `lc-*` 社区插件组件；
- 旧 sidebar footer 弹层形态；
- 与旧公共 MCP route 的直接依赖；
- 未在 08 册登记的业务能力。

旧插件的测试、fixture 和 E2E 脚本是行为参照；新实现必须用 `@yootun` 包结构、新私有 MCP 名称和插件 UI/UX 规范重写测试。

「布局对齐旧插件」与「视觉按新规范重做」同时成立：不得以前者为借口迁移旧 CSS，也不得以后者为借口重新发明导航、页面结构或任务动线。P2 曾因缺少该口径导致布局返工（见 [11-wx-workbench-ui-layout-parity.md](11-wx-workbench-ui-layout-parity.md)）；P3 / P4 的 UI 契约必须先落到对应布局对齐册，再开工产品代码。

### 2.3 内置启用策略

三个工作台最终内置自动启用，不恢复激活页插件勾选。批次采用渐进插入：

1. P1 只交付基础包，不把未完成工作台插入 bundle；
2. P2 验收后在 yootun bundle 插入视频号；
3. P3 验收后插入小红书；
4. P4 验收后插入抖音；
5. P5 做三入口完整集成验收。

这样避免半成品工作台进入安装包，也让每次打包闭包变更可预期。

### 2.4 本地状态兼容

继续使用旧目录，用户升级后不需要重新扫码：

```text
~/.dofe/dsh-yootun-wx-channels-operation
~/.dofe/dsh-yootun-xhs-operation
~/.dofe/dsh-yootun-douyin-operation
```

新插件不得因为包名变化改用新目录。环境覆盖沿用：

```text
WX_CHANNELS_OPERATION_STATE_DIR
XHS_OPERATION_STATE_DIR
DOUYIN_OPERATION_STATE_DIR
```

状态迁移要求：

- 首次启动只做只读探测；
- 无法识别的旧状态保留原样并显示可恢复错误；
- 不批量搬移或改写用户 profile;
- storage_state 权限保持 0600;
- 删除账号时先清本地 profile 和凭证，再调用远端删除；
- 状态格式变化必须提供版本探测和回退路径。

### 2.5 安全基线

所有工作台复用同一边界：

- `MODELS_API_KEY` 只经 Host credential store 解析；
- 浏览器页面不读取 key、Cookie、storage_state 或本地路径；
- Workbench MCP client 不注册进 `ctx.tools`;
- 每个 Host route 校验 loopback、来源信任（显式 Origin 精确匹配、显式 `sec-fetch-site: cross-site` 拒绝；Desktop `forwardWebRequest` 转发剥离两枚标记时放行，对齐官方 connection fence）、method、body 大小、action 和未知字段；
- Tools 调用只使用 `workbench_*` 白名单；
- Agent 面只由 `@yootun/dsh-managed-mcp` 注册；
- Catalog 面默认不挂载；
- 日志和 UI 只输出稳定错误码。

## 3. P1：桌面共用基础设施

### 3.1 交付范围

P1 是唯一允许“无完整业务工作台”的编码批次，交付以下能力：

1. workspace 与打包闭包；
2. `@yootun/dsh-client-ui-kit` 首批组件；
3. `@yootun/dsh-managed-mcp`;
4. `@yootun/dsh-workbench-mcp`;
5. `@yootun/dsh-media-upload`;
6. yootun bundle 的插入机制；
7. 假 MCP server 与连接器测试；
8. 三工作台的空壳路由不做产品暴露。

### 3.2 `@yootun/dsh-client-ui-kit`

首批组件只按真实消费者建立：

```text
PluginPageShell
PluginHeader
FilterBar
DataCard
KpiCard
ChartFrame
ChartLegend
ChartTooltip
DataState
AssistantDock
OperationReceipts
```

实现要求：

- 原子控件全部来自官方 primitives；
- 颜色、间距、圆角、阴影、动效映射官方 token 或集中 `--yt-*` 语义变量；
- 每个组件提供 loading、empty、error、partial、disabled、focus、hover、pressed、selected 状态；
- 640 / 880 / 1120 px 三档布局；
- `prefers-reduced-motion` 降级；
- zh/en typed dictionary；
- 无 Tailwind、全局 reset、`!important` 或 body 选择器；
- 图表优先 SVG/CSS，确需库时先做包体与可达性评审。

P1 不预先造超出视频号需求的组件。视频号完成后，第二个插件复用时再抽取新形态。

### 3.3 `@yootun/dsh-managed-mcp`

职责：

- 只挂 Agent 面；
- 依赖官方 `@deepseek-ai/dsh-mcp-client`;
- 将 36 个 `yootun_*` 工具注册进 `ctx.tools`;
- serverName 固定 `yootun-agent`;
- URL 固定 `https://ixicai.cn/mcp/tools/yootun/v1/agent`;
- Authorization 使用 credential ref，诊断脱敏；
- 遵守 `yootun-access` 激活门禁；
- key 更新或移除时重建或销毁 client;
- 注册 `tools/pre-execute` guard，对写操作和可能计费操作 ask 或 deny。

验收时用假 MCP server 锁定：未激活零连接、激活后仅 Agent 面、工具数 36、无 Workbench / Catalog、卸载无残留。

### 3.4 `@yootun/dsh-workbench-mcp`

职责：

- 直接使用 MCP SDK Streamable HTTP client;
- 不使用官方 `dsh-mcp-client`，避免进入 `ctx.tools`;
- 对外提供按工作台受限的服务；
- URL 固定 `https://ixicai.cn/mcp/tools/yootun/v1/workbench`;
- serverName 期望 `yootun-workbench`;
- 缓存 initialize / tools/list；
- 每个调用显式超时、取消和稳定错误投影；
- credential 变更后失效缓存；
- 插件卸载关闭全部连接和 in-flight 请求。

服务接口按 08 册执行，内部白名单按工作台分组：

```text
wx:     workbench_wx_*
xhs:    workbench_xhs_*
douyin: workbench_douyin_*
viral:  workbench_viral_*（仅 douyin）
tos:    workbench_tos_upload_authorize（仅 xhs media-upload）
```

验收要求 90 项精确匹配、跨分组拒绝、Catalog 元工具拒绝、超时取消和生命周期无泄漏。

### 3.5 `@yootun/dsh-media-upload`

迁移旧上传链路的 Host 语义，保留：

- 原生文件选择器；
- MIME、大小、普通文件、TOCTOU 校验；
- 只上传 filename、contentType、size;
- 预签名 URL 不进入浏览器响应、日志或会话；
- 成功只返回公网 URL 和非敏感元信息。

授权工具固定：

```text
workbench_tos_upload_authorize
```

本地同源路由保留：

```text
/_dsh/uploader/pick-file
/_dsh/uploader/uploadStart
/_dsh/uploader/uploadStatus
/_dsh/uploader/media
```

会话工具保留 `media_upload`，但不接受调用方传入本地路径。P1 用假授权和假上传 server 测全状态机，真实 TOS 外呼留到 P3 部署验收。

### 3.6 打包闭包

P1 需要证明：

- `pnpm --filter '@yootun/*' run build` 覆盖新包；
- desktop package set 收录 plugin 包；
- 安装包包含 Host 与 client 运行时依赖；
- bundle patch 插入顺序在 web-app 之后；
- 官方无品牌构建不受影响；
- lockfile 与 workspace 一致。

P1 完成后，后续每个工作台只追加自己的 bundle 行，不再改打包机制。

## 4. P2：视频号工作台

### 4.1 迁移目标

包名：

```text
@yootun/dsh-wx-channels-workbench
```

入口名称：

```text
视频号工作台
```

Host 路由：

```text
/api/desktop/yootun/wx-workbench
```

首批次交付用户可完成：

- 扫码登录；
- 账号列表、会话探活与本地状态管理；
- 单账号采集和全账号采集；
- 采集进度、失败、取消和 run 查询；
- 作品列表、详情和趋势；
- 账号总览；
- 粉丝画像；
- 账号删除与本地凭证清理。

视频号不接 AssistantDock 的模型外呼，首版只保留上下文准备和后续扩展位，避免把最小链路与模型费用混在同一验收批次。

### 4.2 远端工具面

Tools 服务端提供 19 个 `workbench_wx_*` 工具：

```text
workbench_wx_account_save
workbench_wx_account_remove
workbench_wx_session_status_report
workbench_wx_collect_run_start
workbench_wx_collect_run_set_list_meta
workbench_wx_collect_run_heartbeat
workbench_wx_collect_ingest_works
workbench_wx_collect_ingest_account_metrics
workbench_wx_collect_ingest_fans_trend
workbench_wx_collect_ingest_fans_profile
workbench_wx_collect_run_finish
workbench_wx_collect_run_cancel
workbench_wx_account_list
workbench_wx_collect_run_get
workbench_wx_work_list
workbench_wx_work_get
workbench_wx_work_trend
workbench_wx_account_overview
workbench_wx_fans_profile_get
```

工具参数与成功投影以 tools dev 分支 `docs/1116/yootun-mcp.md` 为单一事实源。桌面文档不复制 schema，本批实现只登记调用边界和 UI 消费字段。

### 4.3 Host action 契约

新 Host action 从旧插件行为重译，建议保留以下语义：

```text
browser.status
accounts.list
account.beginLogin
account.loginStatus
account.refreshLoginQr
account.probe
account.promote
account.removeLocal
account.removeRemote
collect.start
collect.status
collect.cancel
collectAll.start
collectAll.status
collectAll.cancel
run.get
works.list
work.get
work.trend
account.overview
fans.profile.get
```

实现要求：

- 每个 action 显式 allowlist；
- 输入用 schema 校验并拒绝未知字段；
- 长任务进程内状态机可取消、可查询、可恢复；
- 扫码 run 与采集 run 分离；
- 同账号 profile 锁防并发；
- 心跳序号回退、批次不一致、run 非运行态按稳定码投影；
- 远端失败不自动清理本地凭证；
- 本地清理失败不调用远端删除。

### 4.4 UI 信息架构

页面使用中央面板：

```text
PluginPageShell
├─ PluginHeader：标题、描述与浏览器 / 全局辅助状态
├─ SegmentedTabs：作品数据 / 账号总览
├─ 作品数据：左侧账号管理栏 + 右侧作品工具栏 / 摘要卡 / 作品表格
├─ 作品详情：双击或 Enter 打开 Modal
├─ 账号总览：全部视频指标 / 关注者增长 / 关注者画像
└─ DataState：加载、空态、错误、部分数据
```

布局、信息架构和交互动线按 [11-wx-workbench-ui-layout-parity.md](11-wx-workbench-ui-layout-parity.md) 对齐旧插件；视觉、CSS、token、文案和无障碍按新版规范重做。

必须覆盖：

- 账号会话过期提示与重新扫码；
- 单账号采集进度；
- 全账号串行或受控并发策略；
- 采集失败后保留已完成批次；
- 无画像时显示 no_data，不伪造空分布；
- 长账号 ID 与长标题截断与完整可访问名称。

### 4.5 实施阶段

```text
W0 基线复核：旧插件 action、状态目录、fixture、E2E、稳定错误码逐项列表
W1 Host 骨架：包、patch、webServer、action schema、错误投影
W2 状态与登录：旧目录探测、Chrome profile、扫码、会话探活、本地删除
W3 采集链路：run、心跳、四类入库、finish、cancel、恢复
W4 数据页：账号、作品、详情、趋势、总览、画像
W5 集成：真实 Workbench MCP、打包、明暗与三档宽度、真机验收
W6 布局回正：旧布局与交互动线迁移，新版视觉规范重做
```

W5 的本地真实 Tools、真实扫码采集和真实浏览器目检按 [10-wx-workbench-w5-local-e2e-plan.md](10-wx-workbench-w5-local-e2e-plan.md) 执行；生产 endpoint 冒烟与 Windows 真机验收仍由本册 §4.6 验收。

### 4.6 测试与验收

P2 至少交付：

- Host action 契约测试；
- Chrome 与状态机单测；
- 采集批次和失败恢复测试；
- Workbench MCP 假 server 测试；
- 真实线上 Workbench endpoint 冒烟；
- UI 组件逻辑测试；
- zh/en 键集测试；
- 明暗主题与 640 / 880 / 1120 px 目检；
- 键盘路径和 reduced-motion 目检；
- 打包闭包测试；
- Windows 真机扫码与采集验收。

验收通过标准：

1. 旧目录可识别，用户不重新扫码；
2. 采集完成远端 run 与本地进度一致；
3. 断网或中断后可恢复且不重复批次；
4. 删除账号先清本地再远端，失败路径可解释；
5. 页面不出现 Cookie、storage_state、本地路径或 Authorization;
6. 普通会话仍只见 Agent 36，不见 Workbench 90;
7. 视频号工作台只调用 19 个 `workbench_wx_*` 白名单。

## 5. P3：小红书工作台

### 5.1 迁移目标

包名：

```text
@yootun/dsh-xhs-workbench
```

入口名称：

```text
小红书工作台
```

Host 路由：

```text
/api/desktop/yootun/xhs-workbench
```

交付用户可完成：

- 扫码登录与账号管理；
- 笔记采集；
- 素材选择、上传和公网 URL 生成；
- 仿写任务创建、轮询、取消、结果读取；
- 爆款看板浏览、关键词、设置、运行和审核；
- 标签管理；
- 草稿发布；
- 工作台助手与操作回执。

P3 建立在 P2 的私有 MCP 和 P1 的上传能力之上。上传链路未通过假授权测试前，不得开始任务创建 UI。

### 5.2 远端工具面

小红书使用 19 个 `workbench_xhs_*` 工具；上传另用：

```text
workbench_tos_upload_authorize
```

工具分组：

```text
任务：task_create / task_get / task_cancel / result_get
看板读：overview / note_detail / keywords / settings_get / run_get / candidates / labels
看板写：note_tag_update / note_exclude / keyword_save / settings_update / run_start / candidate_review / label_review / label_save
上传：tos_upload_authorize
```

所有写操作必须在 Host 侧生成或校验幂等键。同一用户点击重试复用原键，重新发起生成新键；不得把 UI 时间戳直接当唯一业务语义。

### 5.3 Host action 契约

建议 action 分组：

```text
browser.status
accounts.list
account.beginLogin / loginStatus / probe / removeLocal
collect.start / collect.status
upload.pick / upload.start / upload.status / upload.media
task.create / status / result / cancel
hotboard.overview / noteDetail / keywords / keywordSave
hotboard.settings / settingsUpdate
hotboard.runStart / runGet
hotboard.candidates / candidateReview
hotboard.labels / labelReview / labelSave
publish.start / publish.status
assistant.chat / stop
```

上传和发布不得复用一个模糊 action；每个 action 有独立 schema 和错误码。

### 5.4 UI 信息架构

布局、信息架构和任务动线按 [12-xhs-workbench-ui-layout-parity.md](12-xhs-workbench-ui-layout-parity.md) 对齐旧插件；视觉、CSS、token、文案和无障碍按新版规范重做。

```text
PluginPageShell
├─ PluginHeader：标题、描述与浏览器状态
├─ SegmentedTabs：爆款仿写 / 账号管理 / 车衣爆款看板
├─ 爆款仿写：左侧素材区（图片 / 视频）+ 对标区，右侧文案内容区
├─ 账号管理：左侧账号列表，右侧采集工具栏 + 账号信息与基本数据
├─ 车衣爆款看板：案例看板 / 关键词与扩词 / 标签与 AI 标记 / 采集与规则
└─ DataState：加载、空态、错误、部分数据
```

不得把「素材」或「发布」做成顶级 tab：素材选择与上传属于爆款仿写页左栏，发布入口属于文案结果区。上表的 FilterBar / KpiCard / DataCard 等是能力提示，具体落位以 12 册逐页契约为准。

爆款仿写页必须保留：

- 素材选择与上传进度；
- 上传失败不丢表单；
- 任务轮询与取消；
- 生成结果单版可编辑与重新生成确认（版本数固定 1 版，对齐旧插件）；
- 失败原因与重试路径；
- 草稿发布状态。

车衣爆款看板页必须保留：

- 手动采集运行；
- 候选审核；
- 关键词和标签管理；
- 规则配置只读展示（scheduleEnabled 徽标；旧插件 2026-10-13 裁决，页面不提供编辑入口，写操作回执覆盖打标 / 排除 / 关键词 / 候选 / 标签 / 运行）；
- 操作失败时原数据不变。

### 5.5 实施阶段

```text
X0 基线复核：旧 xhs 插件、上传插件、任务/看板契约、状态目录；复核并冻结 12 册布局对齐方案
X1 Host 骨架：action schema、状态目录、错误投影
X2 登录与采集：扫码、账号、笔记采集、本地凭证清理
X3 上传接入：media-upload 服务、公网 URL、失败与重试
X4 任务链路：素材表单、task create、轮询、结果、取消
X5 看板链路：overview、候选、关键词、标签、设置、运行
X6 发布与助手：草稿发布、AssistantDock、回执和撤销
X7 集成：打包、真实线上验收、UI 三档与真机
```

### 5.6 测试与验收

P3 至少交付：

- 上传状态机和 TOCTOU 测试；
- 授权响应 HTTPS、host、过期时间、大小、Content-Type 校验测试；
- 任务幂等、重放、冲突和取消测试；
- 看板写操作 confirm 与幂等键测试；
- 发布失败保留原状态测试；
- AssistantDock 模型成功、失败、停止和草稿保留测试；
- Host 同源与 action 测试；
- UI / i18n / 主题 / 键盘测试；
- 打包闭包测试；
- Windows 真机完整链路验收。

验收通过标准：

1. 视频文件或图片上传后得到可用公网 URL;
2. 同一任务重试不重复计费；
3. 生成结果按版本展示，用户可复制和重新发起；
4. 看板写操作都有回执，失败不改变原数据；
5. 助手只能通过 Host 模型链调用，不能读取凭证；
6. 小红书只访问 `workbench_xhs_*` 与 `workbench_tos_upload_authorize`;
7. 未激活或无 key 时无远端请求。

## 6. P4：抖音工作台

### 6.1 延迟与基线冻结

抖音旧客户端仍在新增功能，因此 P4 开工前置条件为：

1. P2、P3 已合并 main 并完成真机验收；
2. 旧抖音插件功能变更进入明确冻结点；
3. 重新读取旧插件 master 或指定发布 commit;
4. 输出变更基线：Host action、远端工具、状态 schema、UI Tab、测试、E2E、近期新增功能；
5. 与用户确认冻结点后再开工。

在等待期间只维护“抖音变更观察清单”，记录新增 action、工具、页面和数据字段，不提前实现。旧客户端独立新增功能不改变 P1–P3 范围；只有确认未来要迁入新桌面时，才进入观察清单。

旧 route 与 yootun Workbench 是两套独立 registry，不会同步注册。旧客户端在 `/mcp/tools/douyin-operation` 或 `/mcp/tools/viral-video` 新增工具，不会自动进入 Workbench 90。D0 必须同时导出旧 route tools/list 与 `WORKBENCH_TOOLS` 做覆盖矩阵；发现缺口时先补 tools dev 与 08 册，再进入桌面实现。

### 6.2 迁移目标

包名：

```text
@yootun/dsh-douyin-workbench
```

入口名称：

```text
抖音工作台
```

Host 路由：

```text
/api/desktop/yootun/douyin-workbench
```

交付能力按域分组：

1. 账号与会话：扫码、探活、删除、状态上报；
2. 创作者中心采集：run、心跳、批次、日度数据、finish、cancel;
3. 作品数据：列表、详情、趋势、导出；
4. 账号洞察：总览、单账号分析、趋势、导出、热门作品；
5. AI 分析与报表：AI 分析受理与轮询、报表列表、详情、重建；
6. 归属与投放：负责人设置、投流保存；
7. 爆款拆解：归档、下载、工作流、故事板、状态、导出；
8. 素材看板：seed 池、手动采集、run 历史、候选与 facets;
9. 爆款基因知识库：搜索、详情、列表、更新、重建。

### 6.3 远端工具面

抖音工作台独占两组：

```text
workbench_douyin_*：29 项
workbench_viral_*：22 项
```

合计 51 项。其他工作台不得访问 `workbench_viral_*`。

工具 owner 必须在 Host 服务定义中分组：

```text
douyin-account
douyin-collect
douyin-read
douyin-analysis
douyin-report
douyin-owner
viral-breakdown
viral-material
viral-gene
```

分组只用于白名单和 UI 权限，不改变 tools 服务端 contract。

### 6.4 UI 信息架构

下表是能力域提示，不是导航定案。顶级导航与各页结构必须以旧插件冻结基线为产品基准，D0 交付等价的布局对齐文档并经用户确认后才能开工 UI；视觉与 CSS 按新版规范重做。

```text
PluginPageShell
├─ PluginHeader：账号、会话、采集、导出
├─ SegmentedTabs：总览 / 作品 / 分析 / 报表 / 爆款 / 素材 / 知识库
├─ FilterBar：账号、时间、状态、负责人、来源、标签
├─ KpiCard：播放、互动、粉丝、热门命中、素材池、知识库
├─ ChartFrame：趋势、构成、对比、报表指标
├─ DataCard：作品排行、异常采集、报告列表、候选
├─ OperationReceipts：AI、报表、素材、知识库写操作
└─ AssistantDock：当前账号 / 作品 / 报告 / 候选上下文
```

由于信息域最多，P4 必须先做导航层级裁剪：

- 顶层 Tab 不超过 7 个；
- 每层任务路径不超过三步；
- 相邻低频操作合并到详情页；
- 每个图表回答一个业务问题；
- 报表与知识库长文本提供摘要、锚点和复制路径；
- 所有模型或异步操作显示费用或任务状态提示。

### 6.5 实施阶段

```text
D0 冻结基线：旧插件 delta、新增 action、tools 覆盖矩阵、布局对齐文档、用户确认
D1 Host 骨架：action schema、状态目录、错误模型
D2 登录与采集：扫码、run、心跳、批次、日度、finish、cancel
D3 作品与总览：列表、详情、趋势、导出、热门作品
D4 分析与报表：单账号分析、AI 分析、报表列表 / 详情 / 重建
D5 归属与基础写：负责人、投流、幂等和回执
D6 爆款拆解：归档、下载、工作流、故事板、导出
D7 素材看板：seed 池、手动采集、run 历史、facets
D8 知识库：搜索、详情、列表、更新、重建、回执
D9 助手与集成：AssistantDock、真实线上 MCP、打包、真机
```

### 6.6 测试与验收

P4 至少交付：

- 51 项白名单精确测试；
- 采集与日度数据边界测试；
- AI 分析和报表异步受理 / 轮询 / 失败测试；
- 归档、下载、工作流和知识库写操作幂等测试；
- 大列表分页、导出和响应大小边界测试；
- viral 分组仅抖音可访问测试；
- 长导航、长文本、长数字和图表联动测试；
- 明暗主题、键盘、reduced-motion、三档宽度测试；
- 打包闭包和 Windows 真机测试；
- 旧状态目录升级测试。

验收通过标准：

1. 抖音扫码与采集状态和旧插件冻结基线等价；
2. 创作者中心数据、AI 报表和爆款域在 UI 中可闭环；
3. 51 项白名单外全部拒绝；
4. 任何模型或异步操作都有受理、状态、失败和重试路径；
5. 新增旧客户端冻结点功能已逐项对账，不遗漏；
6. 抖音工作台不暴露 Catalog 工具，不影响普通会话 Agent 面。

## 7. P5：集成验收与出包

P5 不新增产品功能，只做三工作台收敛。

### 7.1 集成检查

1. yootun bundle 只包含预期插件；
2. 三个工作台内置启用；
3. 普通会话 Agent tools/list 精确 36;
4. Workbench client 不进入 `ctx.tools`;
5. Catalog 默认不挂载；
6. 三个 Host API 互不访问对方白名单；
7. 状态目录分别探测，不发生串号；
8. 所有写操作回执、幂等和失败路径可解释；
9. 打包闭包完整；
10. 升级安装后页面无 inert 残留；
11. 旧安装目录与用户数据不冲突。

### 7.2 出包命令

最小验证命令：

```bash
pnpm --filter '@yootun/*' run build
pnpm run build
```

按影响面补充：

```bash
pnpm run lint
pnpm run constraints
pnpm run typecheck
```

出包后执行 Windows 真机验收；macOS 至少完成包构建与启动冒烟，无法真机验收的项目明确记录。

### 7.3 最终验收清单

- [ ] P1 连接器与上传能力通过；
- [ ] 视频号真实扫码、采集、查询、删除链路通过；
- [ ] 小红书上传、任务、看板、发布链路通过；
- [ ] 抖音冻结基线全部对账；
- [ ] 抖音 29 + viral 22 白名单精确通过；
- [ ] Agent / Workbench / Catalog 隔离通过；
- [ ] 三个工作台 UI 规范评审通过；
- [ ] 主题、键盘、响应式、reduced-motion 通过；
- [ ] 打包闭包与安装包启动通过；
- [ ] 升级后旧状态保留且页面可操作；
- [ ] 官方目录对账零簿外；
- [ ] 所有已知遗留项和部署风险已记录。

## 8. 风险与止损

| 风险 | 判断信号 | 处理 |
|---|---|---|
| 官方插件 API 不支持预期挂载或生命周期 | P1 假插件无法稳定 mount/dispose | 停止业务批次，先做官方机制验证和文档修订 |
| Workbench 私有连接不可复用 | P1 并发或生命周期测试泄漏 | 收敛为每工作台独立 client，仍保持不进 `ctx.tools` |
| UI kit 过度抽象 | 组件无第二消费者却预做配置 | 删除 speculative API，保留视频号实际需要的最小面 |
| UI 信息架构偏离旧插件 | UI 契约只列组件栈，或出现旧插件不存在的顶级导航 | UI 代码开工前先交付布局对齐册（P2 见 11 册、P3 见 12 册、P4 在 D0 交付），复审对照旧源码逐页核对 |
| 旧状态不可识别 | P2 只读探测失败 | 不改写旧状态，提供导出 / 手动恢复说明 |
| Chrome 采集行为漂移 | 真机无法定位选择器或会话失效 | 先修设备端适配，不改 Tools 契约 |
| 上传授权校验失败 | P3 假授权或线上 TOS 返回异常 | 阻断任务创建，上传链路不得伪造成功 |
| 小红书写操作幂等冲突 | 重试返回 IDEMPOTENCY_CONFLICT | UI 保留原回执并引导刷新，不自动换键重发 |
| 抖音冻结点继续变化 | D0 清单无法闭合 | 继续观察，不开 P4 产品代码 |
| 抖音新增工具未进 Workbench 90 | D0 覆盖矩阵有缺口 | 先补 tools dev 与 08 册，再回桌面批次 |
| 模型助手写数据 | Assistant 输出直接改变业务状态 | 阻断发布，改为生成操作请求，用户确认后 Host 执行 |

## 9. 文档与验收记录

每批交付时在本目录追加该批验收记录，记录：

1. 实际改动范围；
2. 测试命令与结果；
3. UI 目检截图或清单；
4. 真机验收结果；
5. 遗留风险；
6. 是否更新 inline 登记簿。

验收记录不复制 tools schema；远端契约变化先更新 tools 文档，再引用其 dev 或发布版本。
