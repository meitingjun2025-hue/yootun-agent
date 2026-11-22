# P4 抖音工作台 D9 本地真实链路验证方案

状态：**起草待执行**（2026-11-22 起草；完整执行前置条件：有效 yootun key 与操作者在场扫码）。

本方案细化 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) §6.5 的 D9 中可在 WSL 本地完成的部分：生产 Workbench endpoint 冒烟、真实 Desktop UI + 系统 Chrome 扫码与创作者中心采集、九域真实业务链路、7 Tab 视觉与可达性矩阵。它不替代 Windows 真机验收；该项仍按 §6.6 在打包产物安装后另行执行。方案结构参照 [10-wx-workbench-w5-local-e2e-plan.md](10-wx-workbench-w5-local-e2e-plan.md) 与 [13-xhs-workbench-x7-local-e2e-plan.md](13-xhs-workbench-x7-local-e2e-plan.md)（P2/P3 同型方案），差异由抖音工作台的实际范围决定。

## 1. 验证目标与边界

本地验证要证明：

1. 生产 Workbench endpoint（`https://ixicai.cn/mcp/tools/yootun/v1/workbench`，不设本地覆盖）完成 initialize 与 tools/list，契约精确 94 项，其中 `workbench_douyin_*` 精确 33 项、`workbench_viral_*` 精确 22 项，与 `dsh-workbench-mcp` 白名单的抖音调用面 55 项一致；至少一项 douyin 读工具与一项 viral 读工具真实读通；
2. Desktop 抖音工作台能用系统 Chrome 打开真实创作者中心扫码页（`creator.douyin.com`），操作者扫码后完成登录、探活、本地状态落盘与账号列表呈现；
3. 创作者中心真实采集（run、心跳、批次、日度、finish）闭环，重启后的恢复态与远端 run 一致；
4. 作品、总览、单账号分析、发布排期、AI 报表、爆款拆解、素材看板、基因库九域全部走真实数据，写操作有受理、回执、失败与重试路径；
5. 四类导出（作品、总览、单账号分析、拆解故事板）产生真实下载文件；
6. UI 在明暗主题、1120 / 880 / 640 px、键盘路径和 reduced-motion 下通过 7 Tab 全走查。

不在本方案内：

- 不做 Windows 安装、升级、扫码和采集（§6.6 真机项，打包后由操作者执行）；
- 不用 mock Host、mock Workbench server 或伪造业务数据替代真实扫码、真实采集与真实任务；
- 不把激活 key、扫码二维码、Cookie、storage_state、本地路径或完整账号身份写入证据文件；
- 不在真实链路未执行时把 D9 标为完成。

## 2. 前置条件

| 条件 | 要求 |
|---|---|
| 代码 | `yootun-agent` 位于 `feat/yootun-douyin-workbench-d9-integration`，工作区干净，D2–D8 检查与本阶段集成检查全绿 |
| bundle | 抖音工作台已插入 yootun bundle（patch 行、dependencies、self-test 断言三处对账一致）；Catalog 未插入 |
| 激活 key | 操作者持有效 yootun 企业 key；key 只在 UI 或冒烟脚本环境变量中使用，不进入命令行历史、脚本文件或截图 |
| 系统 Chrome | WSL 内 `google-chrome` 可执行，且 GUI 可展示扫码窗口 |
| 测试账号 | 可删除的测试抖音账号，已入驻创作者中心且有已发布作品；采集后仍无数据时记录阻塞，不改用假数据 |
| 操作者 | 用户在场扫码，并确认可以执行本地测试库的排期行新增/删除与素材 seed 写操作 |
| 工作树 | 执行期间 `git status` 干净；manifest 记录执行 commit |

证据目录固定为仓库根目录下的 `.ui-review/douyin-workbench-d9-local/`。该目录被 Git 忽略，只保存截图、脱敏 manifest、导出样品和临时脚本；其中的 `dsh-home/`、`electron-user-data/`、`douyin-state/` 是敏感运行状态，验收结束后删除。

## 3. 阶段 A：生产 endpoint 冒烟（脚本化，先于 UI）

冒烟脚本放在证据目录（`.ui-review/douyin-d9-smoke/prod-smoke.mjs`，不入仓库）。key 经隐藏读入传递，不落在命令行上：

```bash
read -rs MODELS_API_KEY
export MODELS_API_KEY
node .ui-review/douyin-d9-smoke/prod-smoke.mjs
unset MODELS_API_KEY
```

key 安全口径：`read -rs` 隐藏输入，不进入 shell 历史；不写入脚本、manifest、截图、日志或仓库；执行结束后立即 `unset`；不得用 `echo` / `printf` / 命令行参数（含 `VAR=... cmd` 前缀形式）传递 key。

| 检查 | 通过标准 |
|---|---|
| endpoint 可达 | connect 不抛传输错误；服务端要求 Models API key 属预期 |
| serverName | `getServerVersion().name === 'yootun-workbench'` |
| tools/list 总量 | 精确 94 项 |
| douyin 子集 | 精确包含 33 项 `workbench_douyin_*`，无多无少（脚本内置清单比对） |
| viral 子集 | 精确包含 22 项 `workbench_viral_*`，无多无少；该分组仅抖音工作台可访问 |
| 调用面对账 | douyin 33 + viral 22 = 55，与 `yootun/plugins/dsh-workbench-mcp/src/whitelist.ts` 的 `douyin-workbench` caller 白名单一致；`workbench_douyin_collect_run_cancel` 在白名单内但无 action 绑定（分册 15 G-1 缺口，现状记录，不算失败） |
| Catalog 边界 | 5 项 `yootun_business_*` 不得混入（脚本对前缀集合做差集） |
| douyin 读通 | `workbench_douyin_report_list`（无必填参数）非 isError，返回结构化列表 envelope |
| viral 读通 | `workbench_viral_rewrite_rules_list` 或 `workbench_viral_seeds_list` 非 isError，返回结构化数据 |

manifest 记录工具名集合与两项读通工具返回的顶层键名；不记录 Authorization 头、key 或任何 Cookie。

## 4. 阶段 B：隔离 Desktop 运行态

在 `yootun-agent` 根目录启动已构建 Desktop；若构建产物缺失，先执行 `pnpm run build`。端口 `9335` 仅作示例，冲突时替换为未占用端口：

```bash
mkdir -p .ui-review/douyin-workbench-d9-local
DOUYIN_OPERATION_STATE_DIR="$PWD/.ui-review/douyin-workbench-d9-local/douyin-state" \
DSH_HOME="$PWD/.ui-review/douyin-workbench-d9-local/dsh-home" \
DSH_DESKTOP_USER_DATA_DIR="$PWD/.ui-review/douyin-workbench-d9-local/electron-user-data" \
DSH_DESKTOP_RENDERER_DEBUG_PORT=9335 \
DSH_DESKTOP_OPEN_DEVTOOLS=0 \
pnpm run start:desktop
```

启动日志必须显示：

1. `DSH_HOME` 与 `userData` 均位于 `.ui-review/douyin-workbench-d9-local/`；
2. Workbench MCP endpoint 保持生产 URL（本方案不设置 `YOOTUN_WORKBENCH_MCP_URL` 覆盖）；
3. renderer inspector 使用指定端口；
4. 侧栏出现「抖音工作台」入口（bundle 插入生效的最直接证据；缺失即停止并回查 bundle patch / dependencies / self-test 三处对账）。

Playwright 通过 `chromium.connectOverCDP('http://127.0.0.1:9335')` 连接 renderer。自动化脚本保存在证据目录，不进入仓库。

验收结束后退出与清理：正常退出 Desktop；确认 `douyin-state/`、`dsh-home/`、`electron-user-data/` 已不再被进程持有后整目录删除；保留截图、脱敏 manifest、导出样品与通过 / 失败汇总。任一本地测试账号执行「移除本地账号」并在远端删除后再清理（见 C1 删除链路）。

## 5. 阶段 C：真实业务链路清单

每条链路写明 UI 操作、远端工具与通过标准。任何一步失败时按失败态呈现并记录稳定错误码，不得伪装成功、不得改用 mock 数据、不得跳过继续标记后续步骤通过。

### C1 账号与会话：扫码登录、探活、账号列表

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 浏览器状态 | 打开抖音工作台，查顶部状态 | —（`browser.status` 本地） | Chrome 可用；缺失时顶部阻断提示并停止 |
| 扫码登录 | 「账号作品」Tab 左侧账号栏点击「添加账号」 | `workbench_douyin_account_save` | headed 系统 Chrome 打开 `creator.douyin.com` 真实页面；操作者扫插件打开的窗口，不扫截图或缓存图片；登录期间账号栏按钮呈等待扫码（aria-busy）与扫码提示 |
| 探活 | 账号卡「检测会话」 | `workbench_douyin_session_status_report` | 结果 ok；Cookie 命中不视为成功，必须读到稳定账号身份；本地 `douyin-state/profiles/<accountId>/` 与 0600 `storage-state/<accountId>.json` 存在 |
| 账号列表 | 「账号作品」Tab 左侧账号管理栏 | `workbench_douyin_account_list` | 本地状态、远端资料与会话状态合并一致；UI 不显示本地路径、Cookie 或 storage_state |
| 删除（收尾） | 账号卡删除（两步确认） | `workbench_douyin_account_remove` | 确认弹层含账号名；本地清理成功后才远端删除；本地清理失败时停在失败态 |

### C2 创作者中心真实采集与恢复态

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 单账号采集 | 选测试账号点击「开始采集」（不点采集全部） | `workbench_douyin_collect_run_start` / `workbench_douyin_collect_run_set_list_meta` / `workbench_douyin_collect_run_heartbeat` / `workbench_douyin_collect_ingest_batch` / `workbench_douyin_collect_ingest_daily` / `workbench_douyin_collect_run_finish`（经 `collect.start` 编排） | 各阶段（probing / list / details / ingest / finishing / 终态）各截一张；终态 completed 或真实 partial；UI runId 与 `workbench_douyin_collect_run_get` 的 `run.run_id` 一致；批次与日度数据不把缺失补成 0 |
| 采集状态 | 采集期间查状态区 | —（`collect.status` 本地） | 进度与阶段一致；不显示假进度 |
| 恢复态 | 采集中途强退 Desktop 并重启 | `collect_run_get` | 重启后恢复提示出现，恢复态与远端 run 状态一致；不重跑已完成批次、不把中断 run 标成 completed |

### C3 作品、总览与单账号分析

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 作品列表 | 「账号作品」Tab | `workbench_douyin_work_list` | 真实 `works[]`、snake_case 字段、null 显示占位不补 0；排序与筛选本地完成 |
| 作品详情 | 双击作品行 | `workbench_douyin_work_get` | 只消费 `{ work }` 包装；封面、指标、来源与远端一致 |
| 作品趋势 | 详情内趋势区 | `workbench_douyin_work_trend` | 折线点与 `day` / 日度指标对齐 |
| 账号总览 | 「账号总览」Tab | `workbench_douyin_account_overview` | KPI 与远端 totals 对齐；缺口不补 0 |
| 热门作品 | 总览热门区 | `workbench_douyin_hot_work_list` | 排行与远端一致 |
| 单账号分析 | 总览下钻进入分析页 | `workbench_douyin_account_analysis` / `workbench_douyin_account_trend` | 下钻不新增顶级 Tab；分析与趋势和远端一致 |
| 负责人与投流 | 作品/分析弹层保存 | `workbench_douyin_account_owner_set` / `workbench_douyin_work_promotion_save` | 幂等键生成；保存回执就近呈现；失败不改原值 |

### C4 发布排期：create / update / delete、账号切换互斥、乐观版本恢复

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 排期列表 | 「发布排期看板」Tab | `workbench_douyin_publish_schedule_list` | 行数据与远端一致；多账号不串行 |
| 行新增 | 新建排期行并保存 | `workbench_douyin_publish_schedule_row_create` | 幂等键生成；新行入表且与远端一致 |
| 整行保存 | 修改单元格后整行失焦保存 | `workbench_douyin_publish_schedule_row_update` | 乐观更新 + 失败回滚；保存中不可重复提交 |
| 行删除 | 删除按钮 + 二次确认 | `workbench_douyin_publish_schedule_row_delete` | 确认弹层含行标识；删除后列表与远端一致 |
| 账号切换互斥 | 采集或保存进行中切换账号 | —（本地互斥） | 切换被阻断或先收尾当前账号，不产生跨账号写 |
| 乐观版本恢复 | 并行政动使版本冲突（另开窗口改同一行） | `workbench_douyin_publish_schedule_row_update` 返回冲突 | 冲突提示出现并可刷新到最新版本；不静默覆盖远端 |

### C5 AI 分析与报表：受理、轮询、重建

AI 分析从「账号总览」下钻进入的单账号分析页发起；报表的列表、详情、重建在「AI 报表」Tab。不新增顶级 Tab，不改变现有导航。

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| AI 分析受理 | 「账号总览」账号行 Enter 下钻单账号分析页，点 AI 分析入口 | `workbench_douyin_account_ai_analysis_start` | 受理回执含任务标识与费用提示；不伪装即时完成 |
| 轮询 | 等待终态 | `workbench_douyin_account_ai_analysis_get` | 五态推进；失败显示稳定错误码，不吞错 |
| 报表列表 | 报表列表区 | `workbench_douyin_report_list` | 列表与远端一致；长文本有摘要与锚点 |
| 报表详情 | 打开一份报表 | `workbench_douyin_report_get` | 指标与正文和远端一致；可复制 |
| 重建 | 对已有报表点重建（确认弹层） | `workbench_douyin_report_regenerate` | 确认后新版本任务受理；失败路径呈现稳定码 |

### C6 爆款拆解：归档、下载、workflow、详情、导出

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 规则 | 「爆款拆解」Tab 规则区 | `workbench_viral_rewrite_rules_list` | 只读呈现与远端一致 |
| 归档 | 提交链接归档 | `workbench_viral_archive_submit` / `workbench_viral_async_submit_get` | 受理 + 轮询终态；失败显示稳定码 |
| 下载 | 发起无水印下载 | `workbench_viral_douyin_download_url_start` / `workbench_viral_douyin_download_url_get` | 轮询到真实下载 URL 并在浏览器完成一次真实下载（样品入证据目录，不判断内容版权） |
| workflow | 发起拆解工作流 | `workbench_viral_workflow_start` / `workbench_viral_workflow_get` | 受理 + 轮询；跨 Tab 切换时轮询继续 |
| 详情 | 打开候选详情 | `workbench_viral_storyboards_list` / `workbench_viral_analysis_status_get` / `workbench_viral_candidates_list` | 8 步骤、6 KPI、五折叠卡与远端一致；辅助源缺失降级呈现 |
| 导出 | 详情导出 | `workbench_viral_storyboard_export` | 产生真实下载文件（见 C9） |

### C7 素材看板：seed、手动采集、run 历史、facets、候选看板

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| seed 池 | 「爆款素材看板」Tab 查/增 seed | `workbench_viral_seeds_list` / `workbench_viral_keyword_seeds_upsert` / `workbench_viral_account_seeds_upsert` | 列表与远端一致；upsert 幂等重放不产生重复 |
| 手动采集 | 发起 seed 搜索采集 | `workbench_viral_seed_search_submit` / `workbench_viral_async_submit_get` | 受理 + 轮询终态；`ACTIVE_RUN_EXISTS` 冲突呈现并阻断 |
| run 历史 | 查 run 历史 | `workbench_viral_runs_list` | 历史与服务端分页一致 |
| facets | 查看板 KPI 与 facets | `workbench_viral_dashboard_get` | facets 与已选条件一致；缺口不补 0 |
| 候选看板 | 查候选列表 | `workbench_viral_candidates_list` | 12 列真实数据；长文有 aria-label；服务端 total 分页 |

### C8 基因库：搜索、详情、人工修正、重建、失败列表

本页无轮询态：重建受理后经 `gene.search` 刷新观察状态，重开详情经 `gene.get` 取最新记录。

| 步骤 | UI 操作 | 远端工具 | 通过标准 |
|---|---|---|---|
| 搜索 | 「爆款基因库」Tab 搜索/筛选 | `workbench_viral_knowledge_search` | 结果与筛选条件一致 |
| 详情 | 打开基因详情弹层（Modal） | `workbench_viral_knowledge_get` | 四态字段与远端一致；缺失显示 — |
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

## 6. 真实浏览器视觉与可达性矩阵

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

## 7. 证据 manifest

`.ui-review/douyin-workbench-d9-local/manifest.json` 记录：

| 字段 | 内容 |
|---|---|
| startedAt / finishedAt | Asia/Shanghai 时间 |
| yootunAgentCommit | `git rev-parse HEAD` |
| endpoint | 生产 Workbench URL（不含凭据） |
| serverName | `yootun-workbench` |
| toolCounts | 94 总量、douyin 33 / viral 22 子集与 Catalog 5 排除的校验结果 |
| readThroughChecks | 两项读通工具名与其返回顶层键名 |
| accountIds | 脱敏账号 ID（仅本地保存，不入截图） |
| taskIds | runId / workflowId / reportId / candidateId 等任务标识（UI 与远端一致性对账用） |
| exportSamples | 四类导出的文件名与字节数 |
| themeWidthCases | 主题、容器宽度、Tab、截图文件 |
| keyboardChecks | 每个路径的通过 / 失败 |
| reducedMotionChecks | 计算样式结果 |
| failures | 稳定错误码、复现步骤和关联截图 |

截图文件名使用 `NN-theme-width-tab.png`。不把带 token 的 Desktop URL、激活 key、Authorization、Cookie、storage_state、二维码、本地路径或未脱敏身份写入 manifest。

## 8. 通过标准与立即停止条件

本地 D9 判定通过要求全部成立：

1. 生产 endpoint 冒烟九项检查全部通过（94 / 33 / 22 / 55 对账、Catalog 排除、两项读通）；
2. 操作者完成真实扫码，登录、探活、账号保存和本地状态迁移通过；
3. 单账号真实采集完成或得到真实 partial，恢复态与远端一致；
4. C3–C8 九域链路全部走真实数据通过，写操作均有受理、回执、失败与重试路径；
5. 四类导出真实下载通过；
6. 明暗 × 三档宽度 × 7 Tab 共 42 张截图齐全，下钻与浮层补充截图齐全；
7. 键盘路径与 reduced-motion 检查通过；
8. 敏感运行状态与测试账号清理完成；
9. manifest 记录所有失败、阻塞和未覆盖项。

出现以下任一情况视为失败并立即停止，不继续扩大测试范围：

- 任一链路显示假成功、假数据或吞掉稳定错误；
- 扫码身份不稳定、账号串号或跨账号数据互写；
- 系统 Chrome 打开非 `creator.douyin.com` 域名页面；
- tools/list 出现 Catalog `yootun_business_*` 混入或 douyin / viral 计数漂移；
- 状态目录串号（`DOUYIN_OPERATION_STATE_DIR` 未生效或写入缺省 `~/.dofe/` 目录）；
- 任一 MCP endpoint 意外指向本地或非生产覆盖。

真实链路未执行或部分执行时，D9 保持「待执行 / 部分完成」状态，不得标为完成。

## 9. 仍需后续验证

本地链路通过后，D9 仍需：

1. 打包产物安装与启动检查（P5 §7.1 集成检查、§7.2 出包命令）；
2. Windows 真机扫码、采集、重启保留状态和升级验收（§6.6，由操作者执行）；
3. 分册 15 G-1 缺口（`workbench_douyin_collect_run_cancel` 无 action 绑定）按产品决策另行处理，不在本方案内补。
