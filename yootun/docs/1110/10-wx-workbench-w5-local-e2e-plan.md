# P2 视频号 W5 本地真实链路验证方案

状态：**待执行**（2026-11-19 起草）。

本方案细化 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §4.5 的 W5 中可在 WSL 本地完成的两部分：真实 Tools 服务 + 全部 yootun MCP 面调用，以及真实 Desktop UI + 系统 Chrome 扫码采集。它不替代生产 endpoint 冒烟和 Windows 真机验收；这两项仍按 §4.6 另行执行。

## 1. 验证目标与边界

本地验证要证明：

1. Agent、Workbench 与 Catalog 三面都连接本地 `tools.dofe.ai` 真实 FastMCP 服务，完成 initialize 与 tools/list；Workbench 另执行 tools/call，并覆盖视频号 19 项白名单内的读写链路；
2. Desktop 视频号工作台能用系统 Chrome 打开真实视频号助手扫码页，用户扫码后完成身份稳定、远端账号保存和本地状态迁移；
3. 手动触发的单账号采集能把真实作品、账号指标、粉丝趋势和画像写入本地 Tools 数据库，并在 UI 中呈现可核对的数据；
4. UI 在明暗主题、640 / 880 / 1120 px、键盘路径和 reduced-motion 下通过真实浏览器目检；
5. 删除链路按“本地清理成功后才远端删除”执行，并把本地测试凭证清理干净。

不在本方案内：

- 不连接生产 Agent、Workbench 或 Catalog MCP endpoint；
- 不做 Windows 安装、升级、扫码和采集；
- 不验证 macOS 打包产物；
- 不用 mock Host、mock Workbench server 或伪造业务数据替代真实扫码；
- 不把用户输入的激活 key、扫码二维码、Cookie、storage_state 或完整账号身份写入证据文件。

## 2. 前置条件

| 条件 | 要求 |
|---|---|
| 代码 | `yootun-agent` 位于 `feat/plugin-wx-workbench`，工作区干净，已通过 P2 本地完整检查 |
| Tools | `../tools.dofe.ai` 位于 dev 分支，`docs/1116/yootun-mcp.md` 与实现为当前单一事实源 |
| 依赖服务 | `../docker-helm.dofe.ai` 能提供 PostgreSQL、Redis、RabbitMQ |
| 系统 Chrome | WSL 内 `google-chrome` 可执行，且 GUI 可展示扫码窗口 |
| 激活 key | 操作者持有效 yootun 企业 key；key 只在 UI 中输入，不进入命令行、脚本或截图 |
| 测试账号 | 使用可删除的测试视频号，至少有一个已发布作品；若采集后仍无画像或作品，记录阻塞，不改用假数据 |
| 操作者 | 用户在场扫码，并确认可以执行本地测试库的账号删除 |

证据目录固定为仓库根目录下的 `.ui-review/wx-workbench-w5-local/`。该目录被 Git 忽略，只保存截图、脱敏 manifest 和临时脚本；其中的 `dsh-home/`、`electron-user-data/`、`wx-state/` 是敏感运行状态，验收结束后删除。

## 3. 本地拓扑

```text
Playwright Chromium
  ├─ CDP 连接 Desktop renderer
  │   └─ Desktop Host
  │       ├─ yootun-access 激活路由 → https://ixicai.cn
  │       ├─ wx-workbench 同源 Host API
  │       │   └─ Chrome / storage_state / runs.json
  │       ├─ @yootun/dsh-managed-mcp
  │       │   └─ YOOTUN_AGENT_MCP_URL
  │       │       └─ http://127.0.0.1:8000/mcp/yootun-agent
  │       └─ @yootun/dsh-workbench-mcp
  │           └─ YOOTUN_WORKBENCH_MCP_URL
  │               └─ http://127.0.0.1:8000/mcp/yootun-workbench
  └─ 诊断 MCP client
      └─ http://127.0.0.1:8000/mcp/yootun-catalog
```

三个 endpoint 都由本地 tools.dofe.ai FastAPI + PostgreSQL 提供。激活与模型目录不是 MCP 调用，仍走真实 yootun 网关。

本地 FastMCP 挂载路径是 `/mcp/yootun-agent`、`/mcp/yootun-workbench` 与 `/mcp/yootun-catalog`；生产公共路径 `/mcp/tools/yootun/v1/<face>` 由部署网关映射。本验证同时覆盖 Agent 与 Workbench 的 URL 环境变量；Catalog 不进入产品组合，只用诊断 MCP client 直连本地 endpoint。

## 4. 启动本地 Tools 服务

在 `../docker-helm.dofe.ai` 启动共享依赖：

```bash
docker compose up -d postgres redis rabbitmq
```

在 `../tools.dofe.ai` 首次准备环境时，从 `.env.example` 创建 `.env` 并填入本地开发配置；已有 `.env` 时不得覆盖。随后执行：

```bash
uv sync --extra dev
uv run alembic upgrade head
uv run app
```

服务保持在前台运行。另开终端检查：

```bash
curl -sS http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8000/health/ready
```

`health` 必须返回 `status: ok`；`health/ready` 中 database、redis、rabbitmq 必须均为 `ok`。若端口不是 8000，后续环境变量同步替换，不默认改用生产 URL。

## 5. 启动隔离的 Desktop 运行态

在 `yootun-agent` 根目录创建证据目录并启动已构建 Desktop；若构建产物缺失，先执行 `pnpm run build`。端口 `9333` 仅作示例，冲突时替换为未占用端口：

```bash
mkdir -p .ui-review/wx-workbench-w5-local
YOOTUN_WORKBENCH_MCP_URL=http://127.0.0.1:8000/mcp/yootun-workbench \
YOOTUN_AGENT_MCP_URL=http://127.0.0.1:8000/mcp/yootun-agent \
WX_CHANNELS_OPERATION_STATE_DIR="$PWD/.ui-review/wx-workbench-w5-local/wx-state" \
DSH_HOME="$PWD/.ui-review/wx-workbench-w5-local/dsh-home" \
DSH_DESKTOP_USER_DATA_DIR="$PWD/.ui-review/wx-workbench-w5-local/electron-user-data" \
DSH_DESKTOP_RENDERER_DEBUG_PORT=9333 \
DSH_DESKTOP_OPEN_DEVTOOLS=0 \
pnpm run start:desktop
```

启动日志必须显示：

1. `DSH_HOME` 与 `userData` 均位于 `.ui-review/wx-workbench-w5-local/`；
2. renderer inspector 使用指定端口；
3. Agent 与 Workbench endpoint 都没有回退到生产域名。

Playwright 通过 `chromium.connectOverCDP('http://127.0.0.1:9333')` 连接 renderer。自动化脚本保存在证据目录，不进入仓库。

## 6. 阶段 A：激活与本地 MCP 契约

### A1 激活门禁

1. Playwright 截取未激活门禁；
2. 操作者在 UI 中输入有效 yootun key；
3. 等待激活完成，截取解锁后的主界面；
4. 立即检查截图和日志中没有 key、Authorization、Cookie 或 storage_state。

激活路由访问真实 `ixicai.cn`；Agent 与 Workbench URL 仍保持本地覆盖，不能因为激活成功而重置环境。

### A2 Agent、Workbench 与 Catalog initialize / tools/list

激活后通过 Desktop 挂载本地 Agent 面，通过 Desktop UI 触发 `accounts.list`，并在证据脚本中直接用 MCP client 连接三个本地 endpoint 验证：

| 检查 | 通过标准 |
|---|---|
| Agent identity | `serverInfo.name === 'yootun-agent'`，tools/list 精确 36 项 `yootun_*` 工具 |
| Workbench identity | `serverInfo.name === 'yootun-workbench'`，tools/list 精确 90 项 |
| Catalog identity | `serverInfo.name === 'yootun-catalog'`，tools/list 精确 5 项 `yootun_business_*` 工具 |
| wx subset | Workbench 精确包含 19 个 `workbench_wx_*` 工具 |
| session isolation | 普通会话只注册 Agent 36，不出现 Workbench 90 或 Catalog 5 |
| catalog isolation | Agent 与 Workbench 列表均不出现 `yootun_business_*` |
| UI projection | 账号页无远端错误；服务不可用时必须显示 partial/error，不伪装空列表 |

manifest 记录两个仓库 HEAD、三个本地 Tools URL、MCP serverName、Agent 36 / Workbench 90 / Catalog 5 工具名哈希与 19 项 wx 工具名。工具输出只保留业务字段和稳定错误码。

## 7. 阶段 B：扫码登录与账号状态

1. 打开视频号工作台，确认 `browser.status` 为 available；
2. 点击“扫码登录”；Host 必须用 headed 系统 Chrome 打开真实视频号助手页面；
3. 操作者扫描插件打开的 Chrome 窗口，不扫描 Playwright 截图或缓存图片；
4. 登录期间 Desktop 显示等待扫码 / 等待确认；
5. 登录成功后等待账号列表刷新，记录测试账号的 finderId；
6. 执行 `account.probe`，结果必须为 ok；
7. 截取账号页与登录完成状态。

通过标准：

- Cookie 命中不视为成功，必须读到 `finderUsername` 并完成三次稳定身份确认；
- 本地 `wx-state/profiles/<accountId>/` 与 0600 `storage-state/<accountId>.json` 存在；
- `workbench_wx_account_save` 在本地 Tools 数据库创建账号；
- UI 不显示本地路径、Cookie 或 storage_state。

## 8. 阶段 C：手动单账号采集

选择测试账号，点击“开始采集”，不要启动“采集全部账号”。采集期间每次阶段变化各截一张：

1. probing；
2. list / list page；
3. details progress；
4. ingest batch progress；
5. account level；
6. finishing；
7. completed / partial / failed 终态。

终态后记录 UI 中的 attemptId、runId、状态、作品计数和错误码。通过标准：

- run 开始后 `runs.json` 已持久化远端 runId；
- UI runId 与 `workbench_wx_collect_run_get` 返回的 `run.run_id` 一致；
- 远端 run 状态与 UI 终态一致；
- `batches[]` 的 `batch_no` 稳定，`batch_type` 只出现 `works`、`account_metrics`、`fans_trend`、`fans_profile`，`batch_status` 只出现 `pending`、`succeeded`、`failed`；
- 批次失败对象不覆盖成功对象，UI 不把缺失值补成 0；
- 取消路径若单独执行，必须保留已完成批次并在本地与远端均呈 cancelled。

## 9. 阶段 D：真实数据读取与 UI 对账

采集完成后依次执行并截图：

| 页面 | Host action | 通过标准 |
|---|---|---|
| 总览 | `account.overview` | KPI 与 `metrics.totals`、`fans_trend.totals` 对齐；关注变化按 fans_trend 源定态 |
| 画像 | `fans.profile.get` | 只消费 `fans_profile` envelope；无画像显示 no_data，不渲染假分布 |
| 作品列表 | `works.list` | 真实 `works[]`、snake_case 字段、null 显示占位；排序与日期窗参数进入服务端 |
| 作品详情 | `work.get` | 只消费 `{ work }` 包装；封面、基础信息、核心指标、来源、留存、按日数据和缺口与远端一致 |
| 作品趋势 | `work.trend` | 只消费顶层 `snapshots[]`；Dialog 内折线点与 `day`、`daily_play_count` 对齐 |
| run 查询 | `run.get` | 显示 `{ run, batches }` 的字段与批次表；RUN_NOT_FOUND 与服务失败区分 |
| 账号页 | `accounts.list` | 本地状态、远端资料和会话状态合并一致 |

证据脚本保存每个 MCP structuredContent 的脱敏摘要，并与 UI 中可见值对账。账号头像、昵称和 finderId 在截图前遮挡；finderId 可保留在本地 manifest 中用于失败排查。

## 10. 阶段 E：删除链路与清理

所有读验证完成后再执行删除：

1. 点击删除账号，确认按钮必须包含测试账号名；
2. 确认后先执行 `account.removeLocal`；
3. 本地 `removed:true` 后才允许 `account.removeRemote`；
4. 截取删除成功状态；
5. 确认账号从本地 `accounts.json` 与远端 account_list 消失；
6. 删除证据目录中的 `dsh-home/`、`electron-user-data/`、`wx-state/`；
7. 保留截图、脱敏 manifest 和通过 / 失败汇总。

若本地清理失败，UI 必须停在对应失败态且不得调用远端删除；该结果记录为发现的问题，不得手工绕过。

## 11. 真实浏览器视觉与可达性矩阵

对作品数据、账号总览两个页面执行以下矩阵：

| 条件 | 截图 |
|---|---|
| light + 1120px | 两个页面各一张 |
| light + 880px | 两个页面各一张 |
| light + 640px | 两个页面各一张 |
| dark + 1120px | 两个页面各一张 |
| dark + 880px | 两个页面各一张 |
| dark + 640px | 两个页面各一张 |

三档宽度以 `yootun-kit-page` 容器查询实际命中为准，不以浏览器 viewport 名称代替；manifest 记录容器宽度和主题状态。另补：

1. 作品详情 Dialog：light/dark 1120px，双击和 Enter 均可打开；
2. run 批次表：light/dark 640px，确认横向滚动区域可获得键盘焦点；
3. 长账号名与长标题：640px light，确认截断与完整 aria-label；
4. 图表数据点 focus/hover：light 880px；
5. 键盘与鼠标路径：tab 导航、ArrowRight/End 切 tab、作品行 Enter 与双击打开详情、图表 mark focus、批次表滚动 region focus；
6. reduced-motion：Playwright `reducedMotion: 'reduce'` 下检查图表点、分布条、作品行和账号行计算样式中的 transition 为 `0s`。

任何布局溢出、焦点丢失、不可读对比度、假数据或错误状态伪装都算失败；不在截图上手工修图。

## 12. 证据 manifest

`.ui-review/wx-workbench-w5-local/manifest.json` 记录：

| 字段 | 内容 |
|---|---|
| startedAt / finishedAt | Asia/Shanghai 时间 |
| yootunAgentCommit | `git rev-parse HEAD` |
| toolsDofeCommit | Tools 仓库 `git rev-parse HEAD` |
| endpoints | 三个本地 MCP URL，不得包含凭据 |
| serverNames | `yootun-agent`、`yootun-workbench`、`yootun-catalog` |
| toolCounts | Agent 36、Workbench 90、Catalog 5 与 19 项 wx 子集校验结果 |
| accountId | 测试 finderId，仅本地保存 |
| runId | UI 与远端一致的 runId |
| runStatus | UI 与远端一致的终态 |
| themeWidthCases | 主题、容器宽度、tab、截图文件 |
| keyboardChecks | 每个路径的通过 / 失败 |
| reducedMotionChecks | 计算样式结果 |
| failures | 稳定错误码、复现步骤和关联截图 |

截图文件名使用 `NN-theme-width-tab.png`。不把带 token 的 Desktop URL、激活 key、Authorization、Cookie、storage_state、二维码或未脱敏身份写入 manifest。

## 13. 通过标准

本地 W5-A / W5-B 判定通过要求全部成立：

1. Tools 服务健康检查通过；
2. Agent 36、Workbench 90 / 19 与 Catalog 5 工具契约通过，且普通会话隔离成立；
3. 用户完成真实扫码，账号保存、探活和本地状态迁移通过；
4. 单账号真实采集完成或得到真实 partial 结果，且本地 run 与远端 run 一致；
5. 总览、画像、作品、详情、趋势、run 查询均用真实返回对账通过；
6. 明暗 × 三档宽度 × 两个页面截图齐全；
7. 键盘路径与 reduced-motion 检查通过；
8. 删除两步链路通过；
9. 敏感运行状态与测试账号清理完成；
10. manifest 记录所有失败、阻塞和未覆盖项。

出现以下任一情况立即停止，不继续删除或扩大测试范围：

- 任一 MCP endpoint 意外指向生产；
- 扫码身份不稳定或账号串号；
- 采集 runId 在本地与远端不一致；
- UI 显示假成功、假数据或吞掉稳定错误；
- 系统 Chrome 打不开、驱动缺失或 Host API 非同源拒绝。

## 14. 仍需后续验证

本地链路通过后，W5 仍需：

1. 生产 Workbench endpoint 冒烟：使用公共 URL，不设置本地覆盖；
2. 打包产物安装与启动检查；
3. Windows 真机扫码、采集、重启保留状态和升级验收；
4. 如本地测试账号无法产生画像或作品趋势，使用满足数据条件的测试账号补测，不用 fixture 代替。
