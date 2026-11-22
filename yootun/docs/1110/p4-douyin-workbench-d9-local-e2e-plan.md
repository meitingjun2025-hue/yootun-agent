# P4 抖音工作台 D9 混合验证方案（生产认证冒烟 + 本地真实链路）

状态：**本地混合链路已执行（2026-11-22）；UI 样式细节转入用户真机验证阶段**。执行记录见文末 §12。

本方案细化 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §6.5 的 D9 中可在 WSL 本地完成的部分。D9 采用混合验证口径：生产 ixicai 网关只做认证与只读冒烟；账号、采集、排期、AI 报表、拆解、素材、基因库等业务真实链路全部走本地 tools.dofe.ai MCP 与本地 WSL 数据库 / 队列。它不替代 Windows 真机验收；该项仍按 §6.6 在打包产物安装后另行执行。方案结构参照 [10-wx-workbench-w5-local-e2e-plan.md](10-wx-workbench-w5-local-e2e-plan.md) 与 [13-xhs-workbench-x7-local-e2e-plan.md](13-xhs-workbench-x7-local-e2e-plan.md)（P2/P3 同型方案），差异由抖音工作台的实际范围与混合口径决定。

## 1. 验证目标与边界

本地验证要证明：

1. 生产 Workbench endpoint（`https://ixicai.cn/mcp/tools/yootun/v1/workbench`，不设本地覆盖）完成 MCP initialize 与只读冒烟：serverName 为 `yootun-workbench`，tools/list 精确 94 项，`workbench_douyin_*` 精确 33 项、`workbench_viral_*` 精确 22 项（抖音调用面 33 + 22 = 55），Catalog `yootun_business_*` 不混入，且一个 douyin 只读工具与一个 viral 只读工具真实读取成功；
2. 本地 tools.dofe.ai FastAPI + 本地 WSL PostgreSQL / Redis / RabbitMQ 承载全部业务读写：九域链路（账号、采集、作品、总览与单账号分析、发布排期、AI 报表、爆款拆解、素材看板、基因库、四类导出）在本地真实数据上闭环，写操作有受理、回执、失败与重试路径；
3. Desktop 抖音工作台能用系统 Chrome 打开真实创作者中心扫码页（`creator.douyin.com`），操作者扫码后完成登录、探活、本地状态落盘与账号列表呈现，采集数据写入本地库；
4. UI 在明暗主题、1120 / 880 / 640 px、键盘路径和 reduced-motion 下通过 7 Tab 全走查。

边界与禁令：

- 生产冒烟与本地业务链路是两个独立阶段：生产阶段只做 initialize / tools/list / 两个只读 tools/call；业务阶段不使用生产 Workbench endpoint；
- 不得混用「生产 endpoint + 本地 UI 写操作」；本地业务链路运行期间不得移除两个本地 MCP 覆盖环境变量；
- 生产阶段禁止：生产写操作、生产模型任务、生产下载、生产数据库变更、保存响应原文 / 账号身份 / Authorization 或 key；
- 本地依赖（PostgreSQL / Redis / RabbitMQ）已在本地 WSL 中运行；如本地依赖不可达，停下报告，不得回退到 docker-helm、生产 endpoint 或 mock；
- 不用 mock Host、mock Workbench server 或伪造业务数据替代真实链路；失败不得伪装成功；
- 不做 Windows 安装、升级、扫码和采集（§6.6 真机项，打包后由操作者执行）；
- 不把激活 key、扫码二维码、Cookie、storage_state、本地路径或完整账号身份写入证据文件；
- 不在真实链路未执行时把 D9 标为完成。

## 2. 前置条件

| 条件 | 要求 |
|---|---|
| 代码 | `yootun-agent` 位于 `feat/yootun-douyin-workbench-d9-integration`，工作区干净，D2–D8 检查与 D9A 集成检查全绿 |
| bundle | 抖音工作台已插入 yootun bundle（patch 行、dependencies、self-test 断言三处对账一致）；Catalog 未插入 |
| 激活 key | 操作者持有效 yootun 企业 key；key 只经 `read -rs` 进入环境变量并在 UI 中使用，不进入命令行历史、脚本文件或截图 |
| 本地依赖 | PostgreSQL、Redis、RabbitMQ 已在本地 WSL 运行；连接方式由 tools.dofe.ai 自行从其 `.env` 读取；本方案不在 `docker-helm.dofe.ai` 执行任何命令，也不由 yootun-agent 启动这些服务 |
| tools 配置 | `/home/ubuntu/projects/tools.dofe.ai/.env` 已含 `DATABASE_URL`、`REDIS_URL`、`RABBITMQ_URL`；tools.dofe.ai 应用读取 `.env` 中的完整连接值并连接数据库 / Redis / RabbitMQ；本地契约冒烟脚本仅在内存中解析这三个键的存在性与主机类别，不打印、不保存、不使用完整连接值；`.env` 值不得打印、复制、提交或改写 |
| 系统 Chrome | WSL 内 `google-chrome` 可执行，且 GUI 可展示扫码窗口 |
| 测试账号 | 可删除的测试抖音账号，已入驻创作者中心且有已发布作品；采集后仍无数据时记录阻塞，不改用假数据 |
| 操作者 | 用户在场扫码，并确认可以执行本地测试库的排期行新增/删除与素材 seed 写操作 |
| 工作树 | 执行期间 `git status` 干净；manifest 记录执行 commit |

证据目录固定为仓库根目录下的 `.ui-review/douyin-d9-smoke/`（生产冒烟）与 `.ui-review/douyin-workbench-d9-local/`（本地链路）。两目录均被 Git 忽略，只保存截图、脱敏 manifest、导出样品和临时脚本；后者中的 `dsh-home/`、`electron-user-data/`、`douyin-state/` 是敏感运行状态，验收结束后删除。

## 3. 本地拓扑

```text
Production auth smoke
  └─ https://ixicai.cn/mcp/tools/yootun/v1/workbench
      ├─ initialize
      ├─ tools/list
      └─ read-only tools/call

Local Desktop runtime
  ├─ yootun-access / activation → https://ixicai.cn
  ├─ douyin-workbench same-origin Host API
  │   └─ @yootun/dsh-workbench-mcp
  │       └─ YOOTUN_WORKBENCH_MCP_URL
  │           └─ http://127.0.0.1:8000/mcp/yootun-workbench
  ├─ @yootun/dsh-managed-mcp
  │   └─ YOOTUN_AGENT_MCP_URL
  │       └─ http://127.0.0.1:8000/mcp/yootun-agent
  └─ tools.dofe.ai FastAPI
      ├─ local WSL PostgreSQL
      ├─ local WSL Redis
      └─ local WSL RabbitMQ
```

说明：激活与模型目录仍走真实 ixicai 网关；Workbench / Agent 业务 MCP 走本地 tools.dofe.ai；Catalog 仅由诊断 MCP client 直连本地 `http://127.0.0.1:8000/mcp/yootun-catalog` 做隔离断言，不进入产品组合。

## 4. 阶段 A：生产认证与只读冒烟（脚本化，先于本地链路）

冒烟脚本已就位：`.ui-review/douyin-d9-smoke/prod-auth-smoke.mjs`（不入仓库）。限制：

- 必须使用生产 Workbench endpoint；脚本断言 `YOOTUN_WORKBENCH_MCP_URL === undefined` 且解析出的 URL 等于生产契约 URL，发现本地或未知覆盖立即失败；
- 不得调用写工具（脚本只调用下方两个只读工具）；
- 不得修改数据库、发起模型任务或下载文件；
- key 只能通过隐藏输入进入环境变量。

key 使用方式（在 yootun-agent 仓库根目录执行）：

```bash
cd /home/ubuntu/projects/yootun-agent
read -rs MODELS_API_KEY
export MODELS_API_KEY
npx tsx .ui-review/douyin-d9-smoke/prod-auth-smoke.mjs
unset MODELS_API_KEY
```

明确禁止：`MODELS_API_KEY=... command` 前缀传参；`echo` / `printf` 输出 key；把 key 写入脚本、manifest、截图、日志、仓库或聊天记录；把 Authorization 头写入任何文件。

| 检查 | 通过标准 |
|---|---|
| 覆盖检查 | `YOOTUN_WORKBENCH_MCP_URL` 未设置；`workbenchUrl()` 解析为 `https://ixicai.cn/mcp/tools/yootun/v1/workbench` |
| endpoint 可达 | connect 不抛传输错误；服务端要求 Models API key 属预期 |
| serverName | `yootun-workbench` |
| tools/list 总量 | 精确 94 项（与 `WORKBENCH_TOOL_WHITELIST` 全量对账） |
| douyin 子集 | 精确 33 项 `workbench_douyin_*`，无多无少（与 `WORKBENCH_GROUP_TOOLS.douyin` 对账） |
| viral 子集 | 精确 22 项 `workbench_viral_*`，无多无少（与 `WORKBENCH_GROUP_TOOLS.viral` 对账）；该分组仅属抖音 Workbench 调用面（33 + 22 = 55） |
| Catalog 边界 | `yootun_business_*` 0 混入（对 `CATALOG_TOOL_NAMES` 与前缀集合做差集）；`workbench_douyin_collect_run_cancel` 在白名单内但无 action 绑定（分册 15 G-1 缺口，现状记录，不算失败） |
| douyin 读通 | `workbench_douyin_report_list`（参数空对象）非 isError，返回 structuredContent |
| viral 读通 | `workbench_viral_rewrite_rules_list`（参数空对象）非 isError，返回 structuredContent |

manifest（`manifest-prod-auth.json`，0600）只允许记录：startedAt / finishedAt、commit、endpoint URL、serverName、tools/list 94 / douyin 33 / viral 22 / Catalog 排除结果、两个只读工具名、返回 structuredContent 的顶层键名、通过 / 失败状态、失败时的稳定错误类别。不得记录响应原文、业务数据、账号身份、Authorization 或 key。

## 5. 阶段 B：启动本地 tools.dofe.ai 应用与相关 worker

数据库、Redis、RabbitMQ 已经在本地 WSL 中运行，连接方式来自 `/home/ubuntu/projects/tools.dofe.ai/.env`（由 tools 应用自行读取）。不进入、不修改 `/home/ubuntu/projects/docker-helm.dofe.ai`。

在 tools 仓库准备并启动：

```bash
cd /home/ubuntu/projects/tools.dofe.ai
uv run alembic upgrade head
make app
```

按 D9 需要启动相关 worker，分别在独立终端执行：

```bash
cd /home/ubuntu/projects/tools.dofe.ai
make worker-douyin-operation
```

```bash
cd /home/ubuntu/projects/tools.dofe.ai
make worker-viral-video
```

如运行日志或任务路由显示还需要 default 队列，再另行启动 `make worker-default` 并在 manifest 记录原因。不启动无关 worker，不启动 Celery beat（除非实际任务路由明确需要并记录原因）。

健康检查与本地契约：

```bash
curl -sS http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8000/health/ready
```

通过标准：

1. `/health` 返回 `status: ok`；`/health/ready` 中 database、redis、rabbitmq 全部为 `ok`；
2. 本地 Workbench endpoint（`http://127.0.0.1:8000/mcp/yootun-workbench`）完成 initialize，serverName 为 `yootun-workbench`；
3. 本地 tools/list 精确 94、`workbench_douyin_*` 精确 33、`workbench_viral_*` 精确 22、Catalog 不进入 Workbench 调用面（本地契约冒烟脚本 `.ui-review/douyin-workbench-d9-local/local-contract-smoke.mjs` 承载）。

本地契约冒烟脚本的 key 边界：永不读取或转发 `MODELS_API_KEY`——执行前必须先 `unset MODELS_API_KEY`，key 仍在环境中（已设置且非空）时脚本立即失败（错误类别 `models_key_still_set`，提示 `run unset MODELS_API_KEY before local smoke`），不得继续；本地 Authorization 固定为非敏感占位值 `local-contract-smoke`。

如果 8000 端口不是 tools.dofe.ai 本地服务，停止并报告；不得改用生产 URL。本地依赖不可达时同样停止并报告，不得回退 docker-helm、生产 endpoint 或 mock。

## 6. 阶段 C：隔离 Desktop 运行态

在 `yootun-agent` 根目录启动已构建 Desktop；若构建产物缺失，先执行 `pnpm run build`。业务验证必须携带两个本地 MCP 覆盖；端口 `9335` 仅作示例，冲突时替换为未占用端口：

```bash
cd /home/ubuntu/projects/yootun-agent
mkdir -p .ui-review/douyin-workbench-d9-local

YOOTUN_WORKBENCH_MCP_URL=http://127.0.0.1:8000/mcp/yootun-workbench \
YOOTUN_AGENT_MCP_URL=http://127.0.0.1:8000/mcp/yootun-agent \
DOUYIN_OPERATION_STATE_DIR="$PWD/.ui-review/douyin-workbench-d9-local/douyin-state" \
DSH_HOME="$PWD/.ui-review/douyin-workbench-d9-local/dsh-home" \
DSH_DESKTOP_USER_DATA_DIR="$PWD/.ui-review/douyin-workbench-d9-local/electron-user-data" \
DSH_DESKTOP_RENDERER_DEBUG_PORT=9335 \
DSH_DESKTOP_OPEN_DEVTOOLS=0 \
pnpm run start:desktop
```

启动日志必须显示：

1. `DSH_HOME` 与 `userData` 均位于 `.ui-review/douyin-workbench-d9-local/`；
2. Workbench MCP endpoint 为本地 `127.0.0.1:8000`（两个本地 MCP 覆盖生效；业务链路期间不得移除）；如 endpoint 意外指向生产，立即停止；
3. renderer inspector 使用指定端口；
4. 侧栏出现「抖音工作台」入口（bundle 插入生效的最直接证据；缺失即停止并回查 bundle patch / dependencies / self-test 三处对账）。

Playwright 通过 `chromium.connectOverCDP('http://127.0.0.1:9335')` 连接 renderer。自动化脚本保存在证据目录，不进入仓库。

验收结束后退出与清理：正常退出 Desktop；确认 `douyin-state/`、`dsh-home/`、`electron-user-data/` 已不再被进程持有后整目录删除；保留截图、脱敏 manifest、导出样品与通过 / 失败汇总。任一本地测试账号执行「移除本地账号」并在本地库删除后再清理（见 C1 删除链路）。

## 7. 阶段 D：真实业务链路清单（C1–C9）

本阶段全部走本地真实数据：所有工具调用仍通过本地 MCP（不绕过 MCP 直连数据库）；所有写操作只写本地 WSL PostgreSQL；UI 数据与本地 MCP structuredContent 对账；需要数据库核对时只做本地只读查询；不把生产业务数据带入本地验证；不用 mock 数据、mock Host 或 mock Workbench server；失败不得伪装成功。下表「远端工具」列在此阶段均指本地 tools.dofe.ai 的 Workbench MCP 工具。

每条链路写明 UI 操作、远端工具与通过标准。任何一步失败时按失败态呈现并记录稳定错误码，不得伪装成功、不得改用 mock 数据、不得跳过继续标记后续步骤通过。

### C1 账号与会话：扫码登录、探活、账号列表

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 浏览器状态 | 打开抖音工作台，查顶部状态 | —（`browser.status` 本地） | Chrome 可用；缺失时顶部阻断提示并停止 |
| 扫码登录 | 「账号作品」Tab 左侧账号栏点击「添加账号」 | `workbench_douyin_account_save` | headed 系统 Chrome 打开 `creator.douyin.com` 真实页面；操作者扫插件打开的窗口，不扫截图或缓存图片；登录期间账号栏按钮呈等待扫码（aria-busy）与扫码提示 |
| 探活 | 账号卡「检测会话」 | `workbench_douyin_session_status_report` | 结果 ok；Cookie 命中不视为成功，必须读到稳定账号身份；本地 `douyin-state/profiles/<accountId>/` 与 0600 `storage-state/<accountId>.json` 存在 |
| 账号列表 | 「账号作品」Tab 左侧账号管理栏 | `workbench_douyin_account_list` | 本地状态、本地库资料与会话状态合并一致；UI 不显示本地路径、Cookie 或 storage_state |
| 删除（收尾） | 账号卡删除（两步确认） | `workbench_douyin_account_remove` | 确认弹层含账号名；本地清理成功后才在本地库删除；本地清理失败时停在失败态 |

### C2 创作者中心真实采集与恢复态

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 单账号采集 | 选测试账号点击「开始采集」（不点采集全部） | `workbench_douyin_collect_run_start` / `workbench_douyin_collect_run_set_list_meta` / `workbench_douyin_collect_run_heartbeat` / `workbench_douyin_collect_ingest_batch` / `workbench_douyin_collect_ingest_daily` / `workbench_douyin_collect_run_finish`（经 `collect.start` 编排） | 各阶段（probing / list / details / ingest / finishing / 终态）各截一张；终态 completed 或真实 partial；UI runId 与 `workbench_douyin_collect_run_get` 的 `run.run_id` 一致；批次与日度数据不把缺失补成 0 |
| 采集状态 | 采集期间查状态区 | —（`collect.status` 本地） | 进度与阶段一致；不显示假进度 |
| 恢复态 | 采集中途强退 Desktop 并重启 | `workbench_douyin_collect_run_get` | 重启后恢复提示出现，恢复态与本地库 run 状态一致；不重跑已完成批次、不把中断 run 标成 completed |

### C3 作品、总览与单账号分析

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 作品列表 | 「账号作品」Tab | `workbench_douyin_work_list` | 真实 `works[]`、snake_case 字段、null 显示占位不补 0；排序与筛选本地完成 |
| 作品详情 | 双击作品行 | `workbench_douyin_work_get` | 只消费 `{ work }` 包装；封面、指标、来源与本地库一致 |
| 作品趋势 | 详情内趋势区 | `workbench_douyin_work_trend` | 折线点与 `day` / 日度指标对齐 |
| 账号总览 | 「账号总览」Tab | `workbench_douyin_account_overview` | KPI 与本地库 totals 对齐；缺口不补 0 |
| 热门作品 | 总览热门区 | `workbench_douyin_hot_work_list` | 排行与本地库一致 |
| 单账号分析 | 总览下钻进入分析页 | `workbench_douyin_account_analysis` / `workbench_douyin_account_trend` | 下钻不新增顶级 Tab；分析与趋势和本地库一致 |
| 负责人与投流 | 作品/分析弹层保存 | `workbench_douyin_account_owner_set` / `workbench_douyin_work_promotion_save` | 幂等键生成；保存回执就近呈现；失败不改原值 |

### C4 发布排期：create / update / delete、账号切换互斥、乐观版本恢复

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 排期列表 | 「发布排期看板」Tab | `workbench_douyin_publish_schedule_list` | 行数据与本地库一致；多账号不串行 |
| 行新增 | 新建排期行并保存 | `workbench_douyin_publish_schedule_row_create` | 幂等键生成；新行入表且与本地库一致 |
| 整行保存 | 修改单元格后整行失焦保存 | `workbench_douyin_publish_schedule_row_update` | 乐观更新 + 失败回滚；保存中不可重复提交 |
| 行删除 | 删除按钮 + 二次确认 | `workbench_douyin_publish_schedule_row_delete` | 确认弹层含行标识；删除后列表与本地库一致 |
| 账号切换互斥 | 采集或保存进行中切换账号 | —（本地互斥） | 切换被阻断或先收尾当前账号，不产生跨账号写 |
| 乐观版本恢复 | 并行政动使版本冲突（另开窗口改同一行） | `workbench_douyin_publish_schedule_row_update` 返回冲突 | 冲突提示出现并可刷新到最新版本；不静默覆盖本地库 |

### C5 AI 分析与报表：受理、轮询、重建

AI 分析从「账号总览」下钻进入的单账号分析页发起；报表的列表、详情、重建在「AI 报表」Tab。不新增顶级 Tab，不改变现有导航。

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| AI 分析受理 | 「账号总览」账号行 Enter 下钻单账号分析页，点 AI 分析入口 | `workbench_douyin_account_ai_analysis_start` | 受理回执含任务标识与费用提示；不伪装即时完成 |
| 轮询 | 等待终态 | `workbench_douyin_account_ai_analysis_get` | 五态推进；失败显示稳定错误码，不吞错 |
| 报表列表 | 报表列表区 | `workbench_douyin_report_list` | 列表与本地库一致；长文本有摘要与锚点 |
| 报表详情 | 打开一份报表 | `workbench_douyin_report_get` | 指标与正文和本地库一致；可复制 |
| 重建 | 对已有报表点重建（确认弹层） | `workbench_douyin_report_regenerate` | 确认后新版本任务受理；失败路径呈现稳定码 |

### C6 爆款拆解：归档、下载、workflow、详情、导出

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 规则 | 「爆款拆解」Tab 规则区 | `workbench_viral_rewrite_rules_list` | 只读呈现与本地库一致 |
| 归档 | 提交链接归档 | `workbench_viral_archive_submit` / `workbench_viral_async_submit_get` | 受理 + 轮询终态；失败显示稳定码 |
| 下载 | 发起无水印下载 | `workbench_viral_douyin_download_url_start` / `workbench_viral_douyin_download_url_get` | 轮询到真实下载 URL 并在浏览器完成一次真实下载（样品入证据目录，不判断内容版权） |
| workflow | 发起拆解工作流 | `workbench_viral_workflow_start` / `workbench_viral_workflow_get` | 受理 + 轮询；跨 Tab 切换时轮询继续 |
| 详情 | 打开候选详情 | `workbench_viral_storyboards_list` / `workbench_viral_analysis_status_get` / `workbench_viral_candidates_list` | 8 步骤、6 KPI、五折叠卡与本地库一致；辅助源缺失降级呈现 |
| 导出 | 详情导出 | `workbench_viral_storyboard_export` | 产生真实下载文件（见 C9） |

### C7 素材看板：seed、手动采集、run 历史、facets、候选看板

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| seed 池 | 「爆款素材看板」Tab 查/增 seed | `workbench_viral_seeds_list` / `workbench_viral_keyword_seeds_upsert` / `workbench_viral_account_seeds_upsert` | 列表与本地库一致；upsert 幂等重放不产生重复 |
| 手动采集 | 发起 seed 搜索采集 | `workbench_viral_seed_search_submit` / `workbench_viral_async_submit_get` | 受理 + 轮询终态；`ACTIVE_RUN_EXISTS` 冲突呈现并阻断 |
| run 历史 | 查 run 历史 | `workbench_viral_runs_list` | 历史与服务端分页一致 |
| facets | 查看板 KPI 与 facets | `workbench_viral_dashboard_get` | facets 与已选条件一致；缺口不补 0 |
| 候选看板 | 查候选列表 | `workbench_viral_candidates_list` | 12 列真实数据；长文有 aria-label；服务端 total 分页 |

### C8 基因库：搜索、详情、人工修正、重建、失败列表

本页无轮询态：重建受理后经 `gene.search` 刷新观察状态，重开详情经 `gene.get` 取最新记录。

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 搜索 | 「爆款基因库」Tab 搜索/筛选 | `workbench_viral_knowledge_search` | 结果与筛选条件一致 |
| 详情 | 打开基因详情弹层（Modal） | `workbench_viral_knowledge_get` | 四态字段与本地库一致；缺失显示 — |
| 人工修正 | 详情弹层编辑标签/备注保存 | `workbench_viral_knowledge_update` | 幂等键绑定 recordId；同 recordId 同参数复用同键；保存后详情刷新 |
| 重建 | 详情弹层点重建（费用确认弹层） | `workbench_viral_knowledge_regenerate` | 确认含费用提示；受理后详情乐观置 pending 并经 `gene.search` 刷新观察（无轮询）；同一次受理失败或 `IDEMPOTENCY_OUTCOME_UNKNOWN` 的重试复用同 recordId 幂等键（不重复计费）；受理成功后键清空，后续新的用户点击生成新键 |
| 失败列表 | 失败警示胶囊打开失败列表弹层，逐项重试 | `workbench_viral_knowledge_list` | 失败记录呈现；逐项重试同键复用；受理后状态推进经 `gene.search` 观察 |

### C9 四类导出真实下载

| 导出 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 作品导出 | 「账号作品」导出 | `workbench_douyin_export` | 浏览器真实下载，文件非空、可打开 |
| 总览导出 | 「账号总览」导出 | `workbench_douyin_overview_export` | 同上 |
| 分析导出 | 单账号分析导出 | `workbench_douyin_account_analysis_export` | 同上 |
| 拆解导出 | 拆解详情导出 | `workbench_viral_storyboard_export` | 同上；导出失败就近呈现稳定码，不静默 |

导出样品保存在证据目录；manifest 只记录文件名、字节数与导出参数摘要，不记录导出内容中的完整身份。

## 8. 真实浏览器视觉与可达性矩阵

对 7 个顶级 Tab（账号总览 / 账号作品 / 发布排期看板 / 爆款素材看板 / 爆款拆解 / 爆款基因库 / AI 报表）执行：

| 条件 | 截图 |
|---|---|
| light/dark × 1120/880/640 px | 7 Tab 各一张，共 42 张 |

三档宽度以 `yootun-kit-page` 容器查询实际命中为准，不以浏览器 viewport 名称代替；manifest 记录容器宽度和主题状态。另补关键下钻与浮层：

1. 单账号分析下钻页：light/dark 1120px；
2. 作品详情与趋势弹层、负责人/投流弹层：light/dark 1120px，双击与 Enter 均可打开；
3. 发布排期行内编辑与删除确认弹层：light/dark 880px；
4. 素材候选 12 列表格与评分理由抽屉（Material 页 drawer）：light/dark 640px，表格确认横向滚动区域可获得键盘焦点，抽屉 Esc 关闭；
5. 拆解详情五折叠卡与基因详情弹层（Modal）：light/dark 1120px；
6. 长昵称与长标题截断：640px light，确认完整 aria-label；
7. 键盘与鼠标路径：tab 导航、ArrowRight/End 切顶级 Tab、作品行 Enter 与双击打开详情、弹层焦点陷阱与焦点回归、所有弹层与抽屉 Esc 关闭、表格滚动 region focus；
8. reduced-motion：Playwright `reducedMotion: 'reduce'` 下检查图表动画、轮询状态点、页面切换、弹层进出场计算样式中的 transition / animation 为 `0s` 或 `none`。

任何布局溢出、焦点丢失、不可读对比度、假数据或错误状态伪装都算失败；不在截图上手工修图，不用 mock 数据冒充真实结果。

## 9. 证据 manifest

三个 manifest，均 0600、只记脱敏字段：

生产认证冒烟 `.ui-review/douyin-d9-smoke/manifest-prod-auth.json`：startedAt / finishedAt、commit、endpoint URL、serverName、totalToolCount、douyinToolNames、viralToolNames、catalogExcluded、readThroughChecks（两个只读工具名与返回 structuredContent 顶层键名）、通过 / 失败、稳定错误类别。

本地契约冒烟 `.ui-review/douyin-workbench-d9-local/manifest-local-contract.json`：startedAt / finishedAt、commit、endpoint、health / ready 依赖状态、tools/list 计数与工具名、两个只读工具返回顶层键名、通过 / 失败、稳定错误类别。

业务与 UI 链路 `.ui-review/douyin-workbench-d9-local/manifest.json`：

| 字段 | 内容 |
|---|---|
| startedAt / finishedAt | Asia/Shanghai 时间 |
| yootunAgentCommit | `git rev-parse HEAD` |
| endpoints | 本地 Workbench / Agent MCP URL（不含凭据） |
| serverName | `yootun-workbench` |
| toolCounts | 本地 94 总量、douyin 33 / viral 22 子集与 Catalog 排除的校验结果 |
| accountIds | 脱敏账号 ID（仅本地保存，不入截图） |
| taskIds | runId / workflowId / reportId / candidateId 等任务标识（UI 与本地库一致性对账用） |
| exportSamples | 四类导出的文件名与字节数 |
| themeWidthCases | 主题、容器宽度、Tab、截图文件 |
| keyboardChecks | 每个路径的通过 / 失败 |
| reducedMotionChecks | 计算样式结果 |
| failures | 稳定错误码、复现步骤和关联截图 |

截图文件名使用 `NN-theme-width-tab.png`。不把带 token 的 Desktop URL、激活 key、Authorization、Cookie、storage_state、二维码、本地路径、未脱敏身份、`.env` 值、数据库 / Redis / RabbitMQ 连接串或响应原文写入任何 manifest。

## 10. 通过标准与立即停止条件

D9 判定通过要求全部成立：

1. 生产认证冒烟全部通过（覆盖检查、94 / 33 / 22 / 55 对账、Catalog 排除、两项只读读通）；
2. 本地 tools.dofe.ai 健康检查与本地契约冒烟通过（health / ready 三依赖 ok、initialize、94 / 33 / 22、Catalog 不混入）；
3. 操作者完成真实扫码，登录、探活、账号保存和本地状态迁移通过；
4. 单账号真实采集完成或得到真实 partial，恢复态与本地库一致；
5. C3–C8 九域链路全部走本地真实数据通过，写操作均有受理、回执、失败与重试路径；
6. 四类导出真实下载通过；
7. 明暗 × 三档宽度 × 7 Tab 共 42 张截图齐全，下钻与浮层补充截图齐全；
8. 键盘路径与 reduced-motion 检查通过；
9. 敏感运行状态与测试账号清理完成；
10. manifest 记录所有失败、阻塞和未覆盖项。

出现以下任一情况视为失败并立即停止，不继续扩大测试范围：

- 生产冒烟阶段出现 `YOOTUN_WORKBENCH_MCP_URL` 覆盖或 URL 解析异常；
- 业务链路阶段任一 MCP endpoint 意外指向生产，或本地 MCP 覆盖被移除；
- 本地依赖（数据库 / Redis / RabbitMQ / tools 应用）不可达且无法恢复——停下报告，不回退 docker-helm、生产 endpoint 或 mock；
- 任一链路显示假成功、假数据或吞掉稳定错误；
- 扫码身份不稳定、账号串号或跨账号数据互写；
- 系统 Chrome 打开非 `creator.douyin.com` 域名页面；
- tools/list 出现 Catalog `yootun_business_*` 混入或 douyin / viral 计数漂移；
- 状态目录串号（`DOUYIN_OPERATION_STATE_DIR` 未生效或写入缺省 `~/.dofe/` 目录）。

真实链路未执行或部分执行时，D9 保持「待执行 / 部分完成」状态，不得标为完成。

## 11. 仍需后续验证

本地混合链路通过后，D9 仍需：

1. 打包产物安装与启动检查（P5 §7.1 集成检查、§7.2 出包命令）；
2. Windows 真机扫码、采集、重启保留状态和升级验收（§6.6，由操作者执行）；
3. 分册 15 G-1 缺口（`workbench_douyin_collect_run_cancel` 无 action 绑定）按产品决策另行处理，不在本方案内补。

## 12. 执行记录（2026-11-22，本地混合链路）

### 12.1 已验证通过

| 阶段 | 结果 | 关键证据 |
|---|---|---|
| D9B-1 生产认证冒烟 | 通过 | 94 / douyin 33 / viral 22 / Catalog 排除；`report_list` + `rewrite_rules_list` 只读读通；manifest 0600 |
| D9B-2 本地 tools + 契约 | 通过 | health/ready 三依赖 ok；Workbench 94/33/22；Agent 39 与 managed-mcp 白名单一致无泄漏；Catalog 5（一个工具 outputSchema 不符 TS SDK 严格校验，服务端侧偏差，宽松读取记录） |
| D9B-3 隔离运行态 | 通过 | Electron 被 linux-x64 平台门拒绝（`desktop-build-paths.mjs` 仅 mac/win），经确认改用隔离 Web profile `douyind9`（base + web-app + yootun bundle）；侧栏入口出现；进程 env 双本地 MCP 覆盖生效、无 MODELS_API_KEY |
| C1 扫码登录 | 通过 | 账号「优惠豚汽车生活甄选馆」Signed in；accounts.json ok；storage-state 0600 / profiles 0700；UI 无路径/Cookie/storage_state 泄漏 |
| C2 采集与恢复态 | 通过 | 修复三缺陷后 run `9b3a914a`：本地/UI/服务端三方一致（completed、expected 21、ingested 21、seen 21）；审计 ingest_batch OK；关机中断后 G-2 恢复置 interrupted 不伪装 |
| C3 读+写链路 | 通过 | 12 列冻结、21 行、缺失 — 不补 0；下钻/返回保留筛选；负责人 `d9-test-owner`、投流 500/12/66.00/48.00 UI+DB 双对账 |
| C4 发布排期 | 通过（冲突制造未覆盖） | 行新增/编辑/二次确认删除 UI+DB 双对账（表 0 残留）；脏改动阻断账号切换互斥 ✓；表格高度固定修复后区域恒定；乐观版本冲突需双端并发，记未覆盖 |
| C5 AI 分析与报表 | 通过 | AI 分析诚实呈现 insufficient（未产生费用）；报表重建 v2 12 秒 succeeded（UI+DB 对账）；列表/详情真实数据 |
| C6 拆解全链路 | 通过 | 归档→8 步骤工作流 succeeded（ASR 真模型调用）→6 KPI 真实值→分镜表→导出 xlsx 16,360 B→直链下载 mp4 8,404,593 B（TOS 直取） |
| C7 素材看板 | 通过 | 新增测试关键词（唯一 Active）；手动采集 run `mcp-vv-seed-8ce0` succeeded（OneAPI search_video_v2 真实多页轮询）；候选 39 / S·A·B·C 1/3/10/25 真实渲染 |
| C8 基因库 | 详情/列表通过；重建未执行 | 拆解产物自动入库（AI draft）；facets 真实分布；失败卡（Retry extraction）呈现；详情修复后 3,188 字符全内容；重建按钮确认存在（Re-extract genes），执行留待真机 |
| C9 四类导出 | 拆解导出通过；其余转真机 | 拆解 xlsx 真实下载；作品/总览/分析导出与 trend 验证自动化中断，转用户真机 |

### 12.2 本轮发现并修复的缺陷（6 commit，全部客户端/插件侧，未改 tools 源码）

| # | 缺陷 | 修复 |
|---|---|---|
| 1 | `quoteLongNumbers` 不感知 JSON 字符串上下文，嵌套转义长数字被加引号破坏整页 JSON → 采集恒 0 作品误归因 invalid_json | 采集解析字符串感知 移植旧 parse.js 字符串感知状态机 |
| 2 | ingest_batch 载荷五处契约漂移（extra 键 / flat 互动率 / 原始 progress 键 / play_source 键名）→ 整批拒绝零入库且 UI 误示「采集完成」 | ingest 载荷契约回归 + collectOutcomeStatus 三态 回归冻结契约 + collectOutcomeStatus 三态 |
| 3 | 热词条目 `rawScore`→契约键 `raw_score` + 源字段误读 | 热词条目回归契约键 raw_score |
| 4 | archiveStart / workflowStart 缺冻结契约 `confirm:true` → Host 400 | 归档/工作流补风险确认位（重新改写/强制重试同走 startWorkflow 一并覆盖） |
| 5 | `readGeneRecord` 只读 `data.record` 包装，knowledge_get 实际平铺 data 顶层 → 详情弹层空白 | 基因详情投影兼容平铺 data 兼容两形态 |
| 6 | 服务端 account_trend `fromDay: DayStr = ""` 默认值与 pattern 自相矛盾 → 分析趋势 VALIDATION_ERROR | 分析趋势显式 30 天窗口 客户端显式携带 30 天窗口（不修 tools） |

另：UI 反馈修复 2 commit——排期页表格高度固定（排期页表格高度固定 三段 grid）+ kit page-shell content 补 flex（kit 壳层 content 补 flex，高度链断裂根因，三工作台 bundle 重建）。

### 12.3 环境事项

- 本地 WSL 补装 ffmpeg/ffprobe（viral 工作流音频/抽帧步系统依赖）；
- 首次归档（装依赖前）遗留的 failed local_ffmpeg asset 被后续归档去重复用，抽帧步读旧 `lastErrorCode` 秒败——按授权清理该视频的候选/工作流/拆解/模型任务/失败 asset 后全新重跑通过；
- `make` 不存在，tools 启动按 Makefile 底层命令 `uv run app` / `uv run worker-*` 等效执行；默认队列 worker 未启动（当前任务路由未要求）。

### 12.4 剩余项（转用户真机验证）

1. **UI 样式细节**：用户真机逐页截图反馈后修订（本轮仅修排期表格高度一处）；
2. C8 基因重建执行 + C9 作品/总览/分析三导出 + 分析 trend 修复效果复核（自动化中断于收尾段）；
3. 42 张视觉与可达性矩阵、reduced-motion、键盘路径全走查；
4. 观察项待真机复核：素材 run 历史终态判定时机（UI 曾在 run 进行中匹配到旧行 Completed）、报表版本菜单不自动刷新、基因重建按钮在长弹层中的滚动可见性；
5. C4 乐观版本冲突制造（需双端并发）、分册 15 G-1、Windows 真机与 P5 出包（§11）。
