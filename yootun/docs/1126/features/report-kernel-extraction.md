# infra-report-服务端报表通用内核抽取 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音运营 AI 报表（日报、周报）的服务端实现集中在 `src/tools_dofe/services/douyin_operation/reports.py`（2242 行），由三部分组成：

| 部分 | 内容 | 与平台的关系 |
|---|---|---|
| 机制 | 周期计算、状态机与租约认领、投递与对账、定时补建、重建与版本翻转、列表游标、模型调用与重试、输出校验、提示词加载、输入哈希与字节预算 | 与平台无关，但全部直接写在抖音实体 `DouyinOperationReportRecord`、抖音配置 `report_config()` 与抖音 Celery 任务上 |
| 取数与口径 | 账号范围、日度矩阵、互动口径、期初期末粉丝、四信号、覆盖摘要、异常规则、趋势序列、作品行 | 抖音特有 |
| 模型输入 | 核心指标、AI 参考指标、周报画像快照 | 抖音特有 |

视频号要新增同构的报表（[wx-report-server.md](wx-report-server.md)）。如果为视频号复制一份机制代码，租约、对账、重投这些最容易出错的逻辑会变成两份并各自演化。

### 0.2 目标

把机制抽成平台无关的内核，抖音改为「平台适配 + 调用内核」。合入条件是抖音报表的对外行为逐字节不变：既有测试断言零改动，备份库上切换前后的读取结果与数据层重算结果一致。

## 1. 范围

做：

- 新建包 `src/tools_dofe/services/reporting/`，承载与平台无关的机制；
- 报表记录的列声明抽成 Mixin，抖音实体改为继承它（表名、约束名、索引名、既有迁移都不变）；
- 抖音 `reports.py` 保留全部现有公开函数的名字、签名与返回值，内部改为调用内核；
- 新增只读对比脚本，作为合入前的一致性验收手段（附录 B）。

不做：

- 不新增、不修改任何 MCP 工具与 HTTP 路由；
- 不改 `result_json` 的结构、提示词、配置字段、Celery 任务名与队列、异常规则与阈值；
- 不给报表实体补委托模式列（见 2.4）；
- 不在本单实现视频号，视频号在 [wx-report-server.md](wx-report-server.md) 以第二个平台适配接入；
- 不改 docker-helm 与 yootun-agent 的代码。

## 2. 契约增量

MCP 工具：无。

### 2.1 内核与平台的分界

| 归属 | 内容 |
|---|---|
| 内核 | 周期函数（日报周期、周报周期、上一周期、周期的时间边界）；输出契约（AI 结论的校验模型、条目模型、行数上限与校验函数）；认领与终态（认领、清租约、失败、成功并翻转当前版本、数据不足落库）；投递与对账（入队、派发、投递状态回写、租约回收、超期重投、超限终结）；定时补建；重建与版本（追加版本、响应投影、游标编解码、元数据投影、列表、详情）；主流程编排（配置与密钥检查、认领、数据不足判定、组装、预算裁剪、模型重试、落库）；模型调用（网关客户端、截断即停、代码围栏剥离、可重试判定、截止预算下的重试）；提示词加载（首行版本号，缺失即失败）；输入哈希、提示词拼装、字节预算裁剪 |
| 平台 | 记录模型类；委托绑定的命名空间；模型调用元数据里的域标识；投递函数（绑定各自的 Celery 任务与队列）；提示词文件路径；配置对象；账号范围；四信号；覆盖摘要；数据层组装（`result_json.data`）；模型输入组装 |

### 2.2 平台适配接口

内核的每个入口都接收一个平台适配对象，字段如下（名称以实施为准，语义不变）：

| 字段 | 用途 | 抖音取值 |
|---|---|---|
| `model` | 报表记录模型类，内核的全部查询与更新经它构造 | `DouyinOperationReportRecord` |
| `job_namespace` | 委托绑定的命名空间 | `douyin-report` |
| `metadata_domain` | 模型调用元数据里的 `domain` | `douyin_operation` |
| `enqueue` | 把一个 `report_id` 投递到本平台的运行任务 | 现有入队函数的函数体（任务名与队列不变） |
| `prompt_rel_path` | 提示词文件相对路径 | `config/modules/douyin_operation_report_prompt.md` |
| `config` | 配置对象，字段见 2.3 | `report_config()` |
| `effective_accounts` | 账号范围 | 现有同名函数 |
| `signals` | 四信号计数 | 现有 `insufficient_signals` |
| `coverage` | 覆盖摘要 | 现有 `build_coverage` |
| `build_data` | 组装 `result_json.data` | 现有 `build_report_data` |
| `build_ai_input` | 组装模型输入 | 现有同名函数 |

### 2.3 配置对象

内核只依赖配置对象的下列字段，不依赖它来自哪个模块：`enabled`、`model`、`request_timeout_seconds`、`max_output_tokens`、`max_attempts`、`task_soft_time_limit_seconds`、`task_time_limit_seconds`、`lease_seconds`、`dispatch_timeout_seconds`、`dispatch_max_attempts`、`reconcile_interval_seconds`、`max_input_bytes`、`max_payload_bytes`、`max_catchup_periods`。抖音配置的其余字段（调度时刻、爆款阈值、头部作品条数、异常阈值、账号排除前缀）只在平台适配内使用。

### 2.4 保持不变的两处现状

| 现状 | 处理 |
|---|---|
| 抖音报表实体没有委托模式列：重建函数对该属性的赋值不落库，主流程按 `getattr(..., "legacy")` 读取，委托绑定实际不生效 | 内核保持同样的读写方式与默认值。补列会改变运行路径，不在本单 |
| 建行时的输入占位哈希 | 由平台适配提供，取值与现值逐字节相同 |

### 2.5 模块划分

| 模块 | 内容 |
|---|---|
| `periods.py` | 周期函数、时区、日期标签 |
| `schema.py` | 输出契约模型与校验 |
| `store.py` | 记录列 Mixin、状态与投递状态常量、稳定错误码常量 |
| `model.py` | 模型调用、截断即停、代码围栏剥离、可重试判定、截止预算下的重试 |
| `prompt.py` | 提示词加载与拼装、输入哈希、字节预算裁剪 |
| `lifecycle.py` | 认领、终态、主流程编排、任务异常落库 |
| `dispatch.py` | 入队、派发、投递状态回写、对账 |
| `schedule.py` | 定时补建 |
| `versions.py` | 重建、版本翻转、响应投影、游标、元数据、列表、详情 |

抖音常量模块里的 `REPORT_*` 稳定码在内核 `store.py` 定义一份，抖音常量模块改为引用同名对象，取值不变。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | `src/tools_dofe/services/reporting/`（新） | 内核包，9 个模块 | 是 | 本单主体 |
| tools.dofe.ai | `src/tools_dofe/models/entities.py` | 报表列声明抽成 Mixin，`DouyinOperationReportRecord` 改为继承 | 是 | 内核以模型类为参数 |
| tools.dofe.ai | `src/tools_dofe/services/douyin_operation/reports.py` | 平台适配与内核委托；公开符号不变 | 是 | 本单主体 |
| tools.dofe.ai | `src/tools_dofe/services/douyin_operation/constants.py` | `REPORT_*` 改为引用内核常量，取值不变 | 是 | 单一事实源 |
| tools.dofe.ai | `scripts/compare_douyin_report_parity.py`（新） | 只读对比脚本 | 是 | 附录 B 的验收手段 |
| tools.dofe.ai | `tests/reporting/`（新） | 内核单测，以内存库上的最小平台适配为夹具 | 是 | 新代码的用例 |
| tools.dofe.ai | `tests/douyin_operation/test_reports.py`、`test_report_server_contract.py`、`test_report_owner_snapshot.py` | 不改 | — | 零改动是合入条件 |
| tools.dofe.ai | `AGENTS.md` 抖音数据域说明 | 一句话说明报表机制在 `services/reporting/` | 是 | 仓库导航 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由、队列、环境变量变化 |
| yootun-agent | — | 无 | 否 | 无契约变化 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | | `feat/report-kernel-extraction` | 待填 |
| docker-helm 部署测试环境 | — | — | 本单无部署变化；随 [wx-report-server.md](wx-report-server.md) 一并部署 |
| yootun-agent 合入 `main` | — | — | 不涉及 |
| 发版 | | | 随视频号报表一并发版 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [ ] 既有测试零改动：`git diff --stat -- tests/douyin_operation/test_reports.py tests/douyin_operation/test_report_server_contract.py tests/douyin_operation/test_report_owner_snapshot.py` 无输出；`uv run pytest tests/douyin_operation tests/yootun tests/mcp -q` 通过；
- [ ] `uv run pytest tests/reporting -q` 通过；
- [ ] 附录 B 的对比脚本在备份库上的结果：读取结果差异 0，数据层重算差异 0；
- [ ] `make lint` 通过；
- [ ] `grep -n "DouyinOperationReportRecord" src/tools_dofe/services/reporting/*.py` 无输出：内核不认识任何平台的实体。

### 5.2 真机验收（用户执行）

抖音报表的既有操作与切换前一致。

| # | 步骤 | 预期 |
|---|---|---|
| K1 | 打开抖音「AI 报表」，切换日报与周报，翻页 | 列表内容、状态标签、覆盖账号数与切换前一致 |
| K2 | 打开最近一份周报，切换历史版本 | 各版本的 KPI、趋势、账号表、作品卡、洞察逐项一致 |
| K3 | 对一份旧报表点「重新生成」并确认 | 生成新版本，旧版本保留，新版本成为当前版本 |
| K4 | 下一个工作日 11:00 之后查看 | 新的日报出现，状态为已生成或数据不足 |

### 5.3 本地联调记录

待填（合入前回填：对比脚本的输出摘要、备份库里的报表条数）。

## 附录 A：抖音 `reports.py` 的符号去向

| 现有符号（调用方） | 去向 |
|---|---|
| `run_report`、`mark_report_failed`（任务模块）；`claim_report`（模块内部与测试） | 留在 `reports.py`，转调内核的认领与编排 |
| `schedule_reports`、`dispatch_pending`、`reconcile_reports`（任务模块、MCP 适配层） | 留在 `reports.py`，转调内核的调度与投递 |
| `regenerate_report`、`regenerate_response_projection`、`list_reports`、`get_report`（MCP 适配层） | 留在 `reports.py`，转调内核的版本与查询 |
| `build_report_data`、`build_ai_input`、`build_coverage`、`detect_anomalies`、`build_trend_series`、`insufficient_signals`、`effective_accounts`、`load_fans_profile_snapshot`（测试与内部） | 留在 `reports.py`，属于平台适配 |
| `canonical_input_hash`、`load_report_prompt`（测试） | 留在 `reports.py` 作为转导出，测试不必改 import |
| 其余私有函数 | 按 2.1 的分界迁入内核或留在平台适配 |

原则：`reports.py` 现有被外部引用的名字一个不删，调用方与测试零改动。

## 附录 B：一致性对比方法

对比在 CI 备份库上只读执行。数据库连接取 `tools.dofe.ai` 的 `.env`，会话设为只读；脚本不调用模型、不写库。

| 对比项 | 方法 | 通过标准 |
|---|---|---|
| 读取结果 | 对库内全部抖音报表（2026-11-26 为 93 条）逐条调用 `get_report`；按日报与周报、默认列表与全版本两种方式、每页 20 条翻到底调用 `list_reports`；输出按 canonical JSON（键排序、紧凑分隔）落到文件 | 切换前后的两个文件 `cmp` 无差异 |
| 数据层重算 | 对最近 14 个日报周期与最近 4 个周报周期调用 `build_report_data` 与 `build_ai_input`，剔除 `generatedAt` 与 `checkedAt` 两个随时刻变化的字段后落到文件 | 切换前后的两个文件 `cmp` 无差异 |

切换前的基线用 `git worktree` 检出切换前的提交、运行同一脚本得到。脚本、两份输出与 `cmp` 结果存放在仓库外，摘要记入 5.3。

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 内核对实体的依赖方式 | 以记录模型类为参数，两平台实体共用列声明 Mixin | 引入仓储接口对象，逐方法转发 |
| 抖音调用方 | 公开符号原地保留，内部转调 | 调用方全部改为直接 import 内核 |
| 视频号接入时机 | 本单只切抖音，视频号在下一单以第二个平台适配接入 | 两个平台在同一单完成 |
