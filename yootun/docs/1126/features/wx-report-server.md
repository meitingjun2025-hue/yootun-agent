# wx-report-视频号 AI 报表服务端 实施单

状态：实施中（2026-11-26 开始，特性分支 `feat/wx-report-server`） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台已有机构级 AI 日报与周报（定时生成、手动重建、历史版本）。视频号工作台只有账号数据 Tab 的多账号汇总总览（[1124 多账号总览单](../../1124/features/wx-workbench-multi-account-overview.md)），没有报表。

视频号的数据现状（CI 备份库，2026-11-26 只读核对）：

| 项 | 现状 |
|---|---|
| 账号 | 3 个，会话状态均正常 |
| 账号日度指标 | 每个账号 35 到 45 天连续 |
| 关注者日表 | 每个账号约 330 天连续 |
| 作品 | 103 条，累计播放中位数 686、最高约 5.7 万，没有达到 10 万的 |
| 完播率、平均播放时长、快速划过率 | 只有作品累计值，按日快照里为空 |
| 涨粉来源 | 约 8 成的日表行有，各来源加总等于当日新增关注 |
| 作品流量来源 | 全部作品都有，累计口径 |
| 账号流量来源 | 约一成的日表行有，是近 30 天滚动窗口的快照 |
| 企业微信点击与加微 | 全空（采集缺口） |

### 0.2 目标

视频号新增与抖音同构的 AI 报表：机构级日报与周报、定时生成、手动重建、历史版本。数据口径与多账号总览同源，使用视频号专属的提示词，异步任务走视频号专属队列 `tools.wx_channels_operation`。

本单只做服务端。桌面端的报表页与智能体工具在 [wx-report-client.md](wx-report-client.md)。前置单是 [report-kernel-extraction.md](report-kernel-extraction.md)：本单的服务层以第二个平台适配接入内核，不复制机制代码。内核单开发完成时尚未合入 `dev`，本单的特性分支从内核单的特性分支切出，两单一并合入（2026-11-26 回填）。

## 1. 范围

做：

- 新表 `wx_channels_report`、实体与迁移；
- 视频号模块配置文件与 `[report]` 配置模型；
- 视频号报表提示词文件；
- 平台适配 `services/wx_channels_operation/reports.py`（取数、口径、模型输入）；
- Celery：运行、定时补建、对账三个任务，beat 三条，专属队列常量，任务模块登记；
- 工具：旧域 3 个源能力，yootun Workbench 面 3 个，yootun Agent 面 2 个只读；
- 登记：能力清单、策略、分类、yootun registry、快照、计数断言、契约文档、基线白名单；
- 部署：专属 worker、部署流水线（三条全量部署与一条按服务热更新）与校验脚本、CI 覆盖与切换脚本、路由声明；
- 测试：服务层、工具层、部署校验。

不做：

- 关注者画像不进模型输入、不进报表页面（2026-11-26 决定：视频号与抖音的画像用法后期统一调整）；
- 不做 PDF 导出，也不做服务端 HTML 导出（导出在桌面端完成，见 [wx-report-client.md](wx-report-client.md)）；
- 不做本地验证页与 HTTP 路由：抖音的 `/v1/douyin-report` 与静态页是 RQ-2026-006 时期的浏览器验证手段，不属于 MCP 合同面，视频号直接用桌面端验收；
- Agent 面不提供「重新生成」（对齐抖音：Agent 面只有两个只读工具）；
- 完播率、平均播放时长、快速划过率不做周期 KPI（日度没有这三项数据，只有作品累计值）；
- 不改采集，不改既有视频号工具的入参与出参。

## 2. 契约增量

### 2.1 工具清单

| 面 | 工具名 | 入参 | 出参 | 读/写 | 进普通会话 |
|---|---|---|---|---|---|
| 旧域（源能力） | `wx_channels_report_list` | 同 `workbench_wx_report_list` | `{ items, nextCursor }` | 读 | — |
| 旧域（源能力） | `wx_channels_report_get` | `reportId` | `{ report }` | 读 | — |
| 旧域（源能力） | `wx_channels_report_regenerate` | `reportId`、`idempotencyKey` | `{ reportId, version, status, reused, pollIntervalSeconds }` | 写 | — |
| Workbench | `workbench_wx_report_list` | `reportType?`、`periodStart?`、`status?`、`limit?`、`cursor?`、`allVersions?` | 同源能力 | 读 | 否 |
| Workbench | `workbench_wx_report_get` | `reportId` | 同源能力 | 读 | 否 |
| Workbench | `workbench_wx_report_regenerate` | `reportId`、`idempotencyKey` | 同源能力 | 写（模型计费、派生异步任务） | 否 |
| Agent | `yootun_wx_reports_list` | 同 `workbench_wx_report_list` | 同源能力 | 读 | 是 |
| Agent | `yootun_wx_report_get` | `reportId` | 同源能力 | 读 | 是 |

入参约束与抖音同名工具逐字段相同：`reportType` 取 `daily` 或 `weekly`；`periodStart` 为 `YYYY-MM-DD`；`status` 取 `pending`、`running`、`succeeded`、`failed`、`insufficient` 之一；`limit` 为 1 到 100，缺省 20；`cursor` 1 到 512 字符；`reportId` 与 `idempotencyKey` 1 到 128，去除首尾空白。错误码见 2.7。yootun 两个面的 `inputSchema` 与 `outputSchema` 必须与源能力逐字段一致（`tests/yootun/test_schema_parity.py` 的要求）。工具描述按契约规范写明是否写业务数据、是否产生模型费用、是否派生异步任务、幂等键格式。

tools 契约文档对齐：`docs/1116/yootun-mcp.md` §3.2（视频号 Agent 清单 6 → 8）、§4.4（视频号 Workbench 清单 20 → 23）、§8 与 §11 的当前计数（Agent 39 → 41、Workbench 95 → 98、Catalog 134 → 139），待同步。

### 2.2 出参结构

元数据与抖音相同：`reportId`、`reportType`、`periodStart`、`periodEnd`（开区间）、`status`、`version`、`isCurrent`、`createdAt`、`finishedAt`、`summary`、`errorCode`、`coreAvailable`、`coverageSummary`、`resultJson`。`resultJson` 是 `{ data, ai }` 两层。

`data` 层的键与抖音相同：`period`、`generatedAt`、`coverage`、`coreMetrics`、`accounts`、`works`、`worksOmittedCount`、`anomalies`、`trendSeries`。桌面端的共享渲染组件只依赖这些键。与抖音的差异只在行内字段：

| 位置 | 差异 | 原因 |
|---|---|---|
| `accounts[]` | 没有 `ownerName` | 视频号账号没有负责人字段 |
| `works[].metrics` | 指标键见 2.4，另带 `trafficSource` 与 `retention` | 平台指标不同 |

`ai` 层与抖音完全相同：`{ summary, facts, inferences, recommendations, limitations }`。

### 2.3 核心指标与账号范围

| 项 | 口径 |
|---|---|
| 账号范围 | `delete_state = 'none'` 的全部账号，按 `account_id` 排序，与多账号总览的缺省账号集合一致；不设排除前缀 |
| 周期 | 上海自然日与自然周，`period_end` 为开区间（与抖音相同） |
| 窗口边界 | 复用 `queries.py` 的行查询（闭区间）时，末日取 `period_end` 的前一天 |
| 播放增量 `plays` | 周期内账号日度播放有值行求和，全缺为空 |
| 净增粉丝 `netFans` | 周期内关注者日表净增有值行求和 |
| 互动总量 `interactions` | 点赞 + 评论 + 分享，不含收藏；在账号的周期聚合层判断，任一分量为空则该账号不计入，全部账号都不计则为空 |
| 互动率 `interactionRate` | 互动总量 ÷ 播放增量，百分数保留 1 位小数；分母为 0 或空时为空 |
| 发布 `publishes` | 周期内发布的作品数，复用 `queries.py` 的窗口计数函数，与总览的作品数同口径 |
| 矩阵总粉丝 `totalFans` | 日报：各账号最新非空关注者总数之和，窗口内无行时回退账号记录值；周报：期初与期末双口径，规则与抖音相同 |
| 环比 | 本周期对上一周期；任一侧为空或上期为 0 时为空 |
| 爆款 | 作品累计播放不低于 `[report].hot_play_threshold`（缺省 10000）；这是报表的独立口径，与总览的相对口径不同 |

每个核心指标条目的形状与抖音相同：`key`、`label`、`value`、`prevValue`、`changePct`、`available`、`goodDirection`、`note`；`key` 依次为 `plays`、`netFans`、`interactions`、`interactionRate`、`publishes`、`totalFans`。

### 2.4 作品行

日报取周期内发布的全部作品；周报取周期内发布、按累计播放降序的前 `[report].max_top_works` 条，超出部分计入 `worksOmittedCount`。

| 键 | 取值 |
|---|---|
| `workId`、`accountId`、`nickname`、`title`、`publishTime`、`isHot` | 与抖音同名键语义相同 |
| `metrics.plays`、`likes`、`comments`、`collects`、`shares` | 作品当前值（累计）；`shares` 取分享数，转发聊天和朋友圈与它恒等，不重复计 |
| `metrics.fansGain` | 该作品带来的全部视频关注增量 |
| `metrics.completionRate`、`avgPlaySeconds`、`fastFlipRate` | 作品累计值，缺失为空 |
| `trafficSource` | `{ name, plays }` 数组，取作品流量来源里除「全部」之外的来源，按播放降序 |
| `retention` | `{ durationSeconds, maxLostSecond, maxLostRatePct }`，取自留存曲线的视频时长、最大流失秒与该秒的留存率；没有曲线为空 |

### 2.5 覆盖、异常与趋势

| 项 | 规则 |
|---|---|
| 四信号 | 账号日度指标行数、作品按日快照行数、关注者画像行数、周期内发布作品数 |
| 数据不足 | 账号日度指标行数为 0 即判不足，不调模型；四信号全空为 `no_signals`，否则为 `daily_missing` |
| 覆盖摘要 | 结构与抖音相同；覆盖账号数为四信号任一有数据的账号数 |
| 异常 | 三条规则与抖音相同：会话过期（高）、周期末尾连续净掉粉天数达到阈值（中）、距最近发布的天数达到阈值（低） |
| 趋势 | 日报近 7 天含本周期，周报近 4 周含本周期；柱为播放增量，线为净增粉丝；缺采日为空，不补 0 |

### 2.6 模型输入

形状与抖音同构：`{ period, metrics, accounts, works, coverage, anomalies }`，另加三个键；没有 `fansProfile`。

| 键 | 内容 |
|---|---|
| `metrics` | 五个核心计数指标各带本期、上期与环比；`totalFans`；两个参考指标 `collects`（周期收藏求和）与 `socialActions`（状态封面、状态引用、设为铃声三项周期求和），各带环比 |
| `accounts` | 同 `data.accounts` |
| `works` | 同 `data.works`（已裁剪到前 N 条） |
| `coverage`、`anomalies` | 同 `data` |
| `fanSource` | 周期内各来源的新增关注数，按来源名给出本期与上期（来自关注者日表的来源趋势，逐日求和） |
| `trafficSourceAccount` | 周期内最新一日有账号级流量来源快照的账号，含快照日期；没有的账号不出现 |
| `lowBasePlays` | 取自配置，提示词据此降低低基数比率的解读强度 |

输入超过 `[report].max_input_bytes` 时按播放降序逐条裁剪 `works`；裁空仍超限则为 `REPORT_INPUT_TOO_LARGE`。

### 2.7 稳定码

与抖音相同的一组：`REPORT_NOT_FOUND`、`REPORT_DISABLED`、`REPORT_INSUFFICIENT_DATA`、`REPORT_MODEL_FAILED`、`REPORT_SCHEMA_INVALID`、`REPORT_TIMEOUT`、`REPORT_TRUNCATED`、`REPORT_INPUT_TOO_LARGE`、`REPORT_PAYLOAD_TOO_LARGE`、`REPORT_ENQUEUE_FAILED`、`REPORT_MODEL_CONFIG_MISSING`、`REPORT_LEASE_EXPIRED`、`REPORT_PROMPT_INVALID`，以及 `INVALID_CURSOR`、`INVALID_IDEMPOTENCY_KEY`、`IDEMPOTENCY_CONFLICT`。取值与抖音逐字相同，桌面端的错误码白名单可以直接复用。

### 2.8 幂等键

「重新生成」的键模板为 `wx:report_regenerate:{reportId}:{attemptUuid}`，由页面生成，同一次点击的重试复用同一个 UUID。服务端校验前缀与两段非空；同键不同参数由幂等收据收敛为 `IDEMPOTENCY_CONFLICT`。同周期已有生成中的版本时返回 `reused = true`，不重复投递。

### 2.9 配置、队列与调度

新文件 `config/modules/wx_channels_operation.toml`（字段约束与预算闭合校验对齐抖音的 `[report]`）：

```toml
[report]
enabled = true
timezone = "Asia/Shanghai"
# 日报每天 11:00，周报周一 12:00（与抖音相同）。
daily_hour = 11
weekly_day_of_week = 1
weekly_hour = 12
model = "minimax-m3"
request_timeout_seconds = 180
max_output_tokens = 6000
max_attempts = 3
# 预算闭合：最坏 3 × 180 = 540 秒 < 软时限 660 秒 < 硬时限 720 秒 < 租约 780 秒。
task_soft_time_limit_seconds = 660
task_time_limit_seconds = 720
lease_seconds = 780
dispatch_timeout_seconds = 180
dispatch_max_attempts = 3
reconcile_interval_seconds = 60
max_top_works = 10
hot_play_threshold = 10000
low_base_plays = 1000
max_input_bytes = 262144
max_payload_bytes = 524288
max_catchup_periods = 14

[report.alerts]
consecutive_fan_loss_days = 2
inactive_publish_days = 7
```

| 项 | 内容 |
|---|---|
| 队列 | `tools.wx_channels_operation`，新增常量 `WX_CHANNELS_OPERATION_QUEUE` |
| 运行任务 | `tools_dofe.wx_channels_report_run`，软时限 660 秒、硬时限 720 秒；任务 id 由 `report_id` 确定性派生，可以重投 |
| 定时任务 | `tools_dofe.wx_channels_report_schedule`，队列 `tools.maintenance`；beat 两条：日报每天 `daily_hour` 点、周报周一 `weekly_hour` 点；任务内按时刻守卫，未到时刻不建行 |
| 对账任务 | `tools_dofe.wx_channels_report_reconcile`，队列 `tools.maintenance`，每 `reconcile_interval_seconds` 秒 |
| 首次上线 | 库内没有历史行时只建最近一个到期周期，不回溯补历史（与抖音相同） |
| 模型调用元数据 | `domain = "wx_channels_operation"`，`delegation_step_id = "wx-channels-report:{reportId}"` |
| 配置与提示词的装载 | `config/` 目录在部署时整目录只读挂载进全部 tools 容器，新增的 toml 与提示词文件无需登记即可见 |

### 2.10 计数变化

| 清单 | 变化 |
|---|---|
| 旧域 `wx_channels_operation` 工具数 | 20 → 23 |
| yootun Agent 面 | 39 → 41 |
| yootun Workbench 面 | 95 → 98 |
| yootun Catalog 面描述的业务工具数 | 134 → 139 |
| 旧域基线白名单 `ALLOWED_NEW_TOOLS` | 追加 3 个旧域工具名 |

## 3. 影响面

tools.dofe.ai：

| 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|
| `alembic/versions/20261126_0092_wx_channels_report.py`（新） | 建表与索引，写法对齐抖音报表的迁移；编号以动代码时的迁移头为准 | 是 | 纯新增，可以完整回退 |
| `src/tools_dofe/models/entities.py` | `WxChannelsReportRecord`，继承内核的报表列 Mixin | 是 | 内核以模型类为参数 |
| `src/tools_dofe/core/config/wx_channels_operation.py`（新） | `[report]` 配置模型与加载函数 | 是 | 配置显式校验 |
| `config/modules/wx_channels_operation.toml`（新） | 2.9 的配置 | 是 | 可调参数不写死在代码里 |
| `config/modules/wx_channels_operation_report_prompt.md`（新） | 提示词，首行 `promptVersion: wx-report-v1`（附录 A） | 是 | 平台专属提示词 |
| `src/tools_dofe/services/wx_channels_operation/reports.py`（新） | 平台适配与对外函数 | 是 | 本单主体 |
| `src/tools_dofe/services/wx_channels_operation/constants.py` | 队列常量、幂等操作名、幂等键前缀 | 是 | 常量归属各域 |
| `src/tools_dofe/services/wx_channels_operation/queries.py` | 两个行查询函数提供包内公开别名，原私有名保留 | 是 | 报表复用同一份行查询，既有调用零改动 |
| `src/tools_dofe/services/wx_channels_operation/common.py` | 幂等键结构校验函数 | 是 | 2.8 |
| `src/tools_dofe/mcp/domains/wx_channels_operation/schemas.py`（新） | 三个入参模型 | 是 | 显式 schema |
| `src/tools_dofe/mcp/domains/wx_channels_operation/server.py` | 三个源工具与注册；服务描述里「一期不调用模型」改为如实描述 | 是 | 源能力 |
| `src/tools_dofe/mcp/capabilities.py`、`service_policies.py`、`service_taxonomy.json` | 登记三个源工具（两个读、一个写，`risk=medium`、`confirm=false`，对齐抖音的报表重建） | 是 | 禁止未登记就注册 |
| `src/tools_dofe/mcp/domains/yootun/agent/server.py` | 两个只读工具 | 是 | Agent 面 |
| `src/tools_dofe/mcp/domains/yootun/workbench/server.py` | 三个工具、分发表与已实现清单 | 是 | Workbench 面 |
| `src/tools_dofe/mcp/domains/yootun/registry.py`、`policies.py`、`service_taxonomy.json` | 名称、源能力映射、读写标记 | 是 | yootun 登记 |
| `docs/superpowers/catalogs/yootun-service-catalog-snapshot.json`、`service-catalog-snapshot.json` | 重新导出 | 是 | 快照与注册一致 |
| `src/tools_dofe/tasks/wx_channels_operation.py`（新）、`tasks/celery_app.py` | 三个任务、`include` 登记、beat 三条 | 是 | 异步与调度 |
| `docs/1116/yootun-mcp.md` | 2.1 的清单与计数 | 是 | 契约唯一来源 |
| `tests/wx_channels_operation/test_reports.py`（新） | 服务层用例（附录 B） | 是 | 新代码的用例 |
| `tests/yootun/test_workbench_wx_reports.py`（新）、`test_agent_wx_reports.py`（新） | 三个 Workbench 工具与两个 Agent 工具的行为 | 是 | 行为与审计 |
| `tests/yootun/test_contract.py`、`test_agent_coverage.py`、`test_workbench_coverage.py`、`test_catalog_face.py`、`test_agent_tools.py`、`test_workbench_wx_tos.py`、`test_dev_baseline_parity.py` | 计数与白名单 | 是 | 计数随清单变化 |
| `tests/mcp/test_yootun_sdk_probe.py`、`test_service_catalog_snapshot.py`、`test_douyin_publish_schedule_tools.py`、`test_capability_manifest.py`、`test_policy_snapshot.py` | 计数、清单与快照 | 是 | 同上 |
| `AGENTS.md` 视频号数据域说明 | 「全部不调模型、无 Celery 队列」改为如实描述 | 是 | 仓库导航 |

docker-helm.dofe.ai：

| 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|
| `docker-compose.yml` | 新增 `tools-worker-wx-channels-operation`：继承通用 worker，消费 `tools.wx_channels_operation`，停止宽限期 12 分钟，池类型与并发度可由环境变量覆盖 | 是 | 新异步任务队列 |
| `jenkins/Jenkinsfile.deploy`、`Jenkinsfile.remote-deploy`、`Jenkinsfile.local` | 部署服务列表、全量服务的精确比较串、启动与等待、状态查询各加一项 | 是 | 不加则流水线不部署该 worker |
| `jenkins/Jenkinsfile.service-local` | 新增视频号 worker 的服务变量与热更新分支 | 是 | 按服务热更新 |
| `jenkins/check-service-registry-pipelines.sh`、`check-remote-deploy-pipeline.sh`、`check-registry-deploy-pipeline.sh` | 对应的包含断言与先后断言 | 是 | 流水线守卫 |
| `runtime/verify-ci-public-mcp-workers.sh` | 新 worker 的命令、健康与进程数检查 | 是 | 运行时校验 |
| `runtime/ci-external-models.override.yml`、`runtime/switch-ci-to-external-models.sh` | 新 worker 的模型网关环境变量与切换列表 | 是 | worker 需要模型网关密钥 |
| `runtime/mcp-gateway/route-registry.yml` | 视频号路由 `model` 与 `async` 由 `false` 改为 `true`，说明改为如实描述；yootun Workbench 路由说明里「不新增队列」改为指向本单 | 是 | 路由声明与事实一致 |
| `runtime/mcp-gateway/verify-routes.sh` | 视频号旧域的核对清单加 `wx_channels_report_get`；yootun Agent 与 Workbench 的核对清单各加一个报表工具 | 是 | 部署后 `tools/list` 核对 |
| `AGENTS.md`、`CLAUDE.md` 视频号域说明 | 补报表与专属队列一句 | 是 | 部署仓导航 |

路由声明说明：`model` 与 `async` 两个字段没有脚本程序化消费，网关的模型上下文注入由共享的 Tools location 统一处理；改这两个值是让声明与事实一致，不改变网关行为。

yootun-agent：本单不改桌面端代码；`yootun/docs/1126/00-overview.md` 的索引行状态随第 4 节回填。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | | `feat/wx-report-server` | 前置：内核单开发完成；本单分支自 `feat/report-kernel-extraction` 切出，两单一并合入 `dev` |
| docker-helm 部署测试环境 | | | 部署后 `tools/list` 核对 8 个新工具名（旧域 3、Agent 2、Workbench 3） |
| yootun-agent 合入 `main` | — | — | 不涉及 |
| 发版 | | | 随 [wx-report-client.md](wx-report-client.md) 一并发版 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [ ] tools：`uv run pytest tests/wx_channels_operation tests/yootun tests/mcp -q` 通过；`tests/douyin_operation` 的既有用例断言未改；
- [ ] tools：本地启动后核对三个面的 `tools/list`，2.1 的工具都出现，计数等于 2.10；
- [ ] tools：附录 C 的口径对账全部一致；迁移在一次性测试库上完成升级与回退各一次，不改动备份库；
- [ ] docker-helm：`bash jenkins/check-service-registry-pipelines.sh`、`bash jenkins/check-remote-deploy-pipeline.sh`、`bash jenkins/check-registry-deploy-pipeline.sh`、`bash jenkins/check-yootun-mcp-routing.sh` 通过；
- [ ] docker-helm：测试环境 `bash runtime/mcp-gateway/verify-routes.sh` 通过；专属 worker 健康，且只消费 `tools.wx_channels_operation`。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| S1 | 部署后查看专属 worker | worker 的名称与队列名与本单一致；通用 worker 的日志里没有视频号报表任务 |
| S2 | 等到一次日报生成（次日 11:00 之后），或由开发侧在测试环境手动触发一次 | 出现一条视频号日报，状态为已生成；记录的模型为 `minimax-m3`，提示词版本为 `wx-report-v1` |
| S3 | 把该日报的 KPI 与账号数据 Tab 同一天的汇总对照 | 播放增量、净增粉丝、发布三个数与总览一致；互动总量等于点赞、评论、分享之和 |
| S4 | 调用一次「重新生成」（入口取决于 [wx-report-client.md](wx-report-client.md) 的进度），再用同一个幂等键调用一次 | 第一次生成第 2 版，第 1 版保留；第二次返回同一个结果，不产生新版本 |
| S5（可选） | 停掉专属 worker 后触发一次生成，过两个对账周期再启动 | 报表最终为生成失败，不停留在生成中 |

### 5.3 本地联调记录

待填（合入前回填：`tools/list` 计数、口径对账结果、迁移升降级结果）。

## 附录 A：提示词

文件 `config/modules/wx_channels_operation_report_prompt.md`。输出要求 8 条与抖音逐字相同（只输出一个 JSON 对象、数字必须来自输入、事实与推断和建议分开、每类最多 5 条、`limitations` 为字符串数组、覆盖不足只说明不推演、全中文且不出现技术键名、措辞中性），下面只列与抖音不同的部分。

```
promptVersion: wx-report-v1

# 视频号运营 AI 报表（日报/周报）

你是新媒体运营数据分析助手。根据下方输入的视频号矩阵已采集事实数据（日报=单日
指标与本期作品，周报=区间求和与本期作品），输出结构化 JSON 分析结论。

## 平台机制（分析视角，不是判定规则）

视频号官方公示的推荐以社交好友关系推荐为主、平台算法推荐为辅：用户点赞、评论、
分享后，内容进入其好友的「朋友♡」入口，多位好友推荐的内容会提升曝光排序；社交
推荐的数据反馈好，才进一步进入公域推荐。平台未公开任何权重和阈值。按这个顺序
分析：先看内容是否被用户拿去社交，再看公域推荐是否承接，最后看主页与关注转化。
不得把任何数值当作官方及格线，不得断言因果。

## 输入口径

- NULL 表示未采集/未暴露（不是 0），缺采账号的指标显示为缺失。
- 计数列为当日增量或周期内求和；比率列为本周期计算值。
- works 里的完播率、平均播放时长、快速划过率、最大流失点是作品发布以来的累计值，
  不是本周期增量，只能用于作品之间比较。
- trafficSource 是单条作品的累计播放来源；trafficSourceAccount 是账号近 30 天滚动
  窗口的快照，可能缺失，缺失时不分析来源结构。
- fanSource 是周期内各来源的新增关注数。
- 互动总量 = 点赞 + 评论 + 分享，不含收藏；任一分量缺失则整条不计。
- 报表爆款为独立简化口径（播放 ≥ 阈值），与总览页的相对口径不同。
- lowBasePlays：播放增量低于该值时，比率的波动不做强解读。

## 分析框架

按四层依次看，某层数据缺失就跳过，并在 limitations 说明：

1. 社交扩散：分享与分享率、点赞、涨粉来源中「分享」「朋友♡」的占比；
   状态封面、状态引用、设为铃声（socialActions）出现非零值时一并提及。
2. 流量来源：头部作品的「推荐」「分享」「朋友♡」「主页」「订阅号消息」占比；
   账号快照可用时补充整体结构。说明流量主要来自算法推荐、社交裂变还是私域。
3. 内容承接：头部作品之间比较完播率、平均播放时长、快速划过率、最大流失点。
   时长相近的作品互比，时长差异大的不直接比完播率。
4. 关注转化：净增粉丝、涨粉来源中「主页」的占比、播放与涨粉是否同向。

## 比较基准

- 只和账号自己比：本周期对上一周期，本期作品对同账号其他作品。
- 只表述相对变化及幅度，不引用外部绝对阈值评判好坏。

## 建议方向参考

- 分享占比高、推荐占比低，播放停在好友量级：内容缺转发理由，建议补「有用、有感、
  有收获」的表达。
- 分享少、点赞正常：内容有认可但缺社交理由，建议结论前置或加可转发的要点。
- 最大流失点在前几秒：开头没留住人，建议前几秒给结论或冲突。
- 播放可以但涨粉少、涨粉来源里「主页」占比低：主页承接弱，建议简介引导关注、
  置顶代表作、做系列内容。
建议必须对应输入中的具体数值，数据不支持时不写。

## 输出 JSON 结构

（与抖音相同：summary、facts、inferences、recommendations、limitations）

## 输出要求

（与抖音 8 条逐字相同）
```

## 附录 B：服务层测试矩阵

| ID | 断言 |
|---|---|
| D1 | 周期：日报为昨日单日，周报为周一到下周一的开区间；上一周期同理 |
| D2 | 核心指标：播放、净增粉丝、发布与逐日求和一致；某账号缺行时不计入，全部缺行为空 |
| D3 | 互动：点赞、评论、分享任一为空的账号不计入；全部为空时互动总量与互动率为空；互动率保留 1 位小数，播放为 0 时为空 |
| D4 | 发布数与 `queries.py` 的窗口计数在同一夹具上相等 |
| D5 | 矩阵总粉丝：日报取最新非空行，窗口内无行时回退账号记录值；周报期初取周期开始的前一天，无行顺延周期内最早有值行 |
| D6 | 作品行：日报取周期内全部发布；周报按播放降序取前 N 条，超出计入 `worksOmittedCount`；爆款按配置阈值判定 |
| D7 | 作品行：流量来源去掉「全部」并按播放降序；留存取最大流失秒与该秒留存率，没有曲线为空 |
| D8 | 数据不足：日度行数为 0 时落 `insufficient` 且不调模型；四信号全空为 `no_signals`，否则为 `daily_missing` |
| D9 | 部分账号缺采：报表正常生成，缺采账号标为不可用并出现在缺采清单里 |
| D10 | 异常：会话过期、连续净掉粉、长期未发布三条规则各自触发与不触发 |
| D11 | 模型输入：涨粉来源各来源之和等于周期新增关注；账号流量来源只含周期内有快照的账号 |
| D12 | 输入超预算：按播放降序裁剪作品；裁空仍超限为 `REPORT_INPUT_TOO_LARGE` |
| D13 | 重建：非当前版本入口解析到同周期的当前版本；已有生成中的版本返回 `reused`；成功后旧版本保留且当前版本翻转 |
| D14 | 列表：默认只返回当前版本；全版本模式返回全部；游标翻页不重不漏；非法游标为 `INVALID_CURSOR` |
| D15 | 状态机：认领是唯一防重门；软时限、业务异常、未知异常都落到终态；对账回收过期租约、重投超期未消费、超限终结 |
| D16 | 调度：未到时刻不建行；停机补偿不超过 `max_catchup_periods`；首次上线不回溯 |
| D17 | 提示词：文件缺失或首行没有版本号为 `REPORT_PROMPT_INVALID`；版本号写入报表记录 |
| D18 | 模型输入里没有 `fansProfile` 键 |

工具层（`tests/yootun/`）：

| ID | 断言 |
|---|---|
| T1 | 三个面的 `tools/list` 都出现 2.1 的工具，计数等于 2.10 |
| T2 | Agent 两个只读工具：空库返回空列表与 `REPORT_NOT_FOUND`；审计的 domain 与 tool 为 yootun 的新名；不产生模型费用 |
| T3 | Workbench「重新生成」：同键重放返回稳定结果；同键不同参数为 `IDEMPOTENCY_CONFLICT`；键模板非法为 `INVALID_IDEMPOTENCY_KEY`；真实创建才投递，重放不重复投递 |
| T4 | 源工具与 yootun 面工具的 `inputSchema`、`outputSchema` 逐字段一致 |
| T5 | 未知参数被拒绝；错误里没有 SQL、traceback 与模型原始响应 |

## 附录 C：口径对账方法

在备份库上只读执行。用 SQL 独立聚合（不引用实现代码），与 `build_report_data` 的输出逐字段比对。

| 场景 | 比对点 |
|---|---|
| 日报：最近 7 个有数据的周期各一次 | 六个核心指标、账号明细、作品行、趋势序列 |
| 周报：最近 2 个完整自然周 | 同上，另加期初与期末粉丝 |
| 某天一个账号缺采（2026-11-25 的「赛恩的房车日记」） | 另两个账号的指标正确，该账号标为缺采，报表正常生成 |
| 某账号点赞、评论、分享有一天为空 | 互动不计入该账号 |
| 某一周没有任何账号发布作品 | 发布为 0，作品列表为空，不判数据不足 |
| 日度表最早一天之前的周期 | 判数据不足，不调模型 |

与多账号总览的对账：同一时间窗下，`plays`、`netFans`、`publishes` 与 `workbench_wx_accounts_overview` 的 `summary.totals`、`summary.fans_totals`、作品数相等。

发布数边界的已知事实：`queries.py` 的窗口计数以不带时区的零点为边界，依赖数据库会话时区为 `Asia/Shanghai`。CI 备份库的会话时区是上海，103 条作品在「上海零点边界」与「不带时区边界」下的日期归属一致。本单复用该函数，不另立口径。
