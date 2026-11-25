# douyin-wx-workbench-采集状态恢复 实施单

状态：已实施，待真机验收 ｜ 创建：2026-11-25 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现象

真机：在作品列表点「采集」后切到其他面板看数据，采集在后台继续；切回来时页面是全新状态——没有进度、按钮可点；再点「采集」提示已有采集任务（`collect_busy`），不重新采集。批量采集同样丢失面板与进度。

### 0.2 原因

采集状态、轮询定时器都在页面组件的 React state 与 ref 里（抖音 `src/client/WorkbenchPage.tsx`，视频号同名文件）。切换主面板时页面卸载，清理逻辑清掉轮询、state 丢弃；重新挂载只调 `accounts.list` 与 `browser.status`，不查询进行中的采集。Host 侧采集控制器与批量控制器一直持有实时状态，只是没人来问。

| 端 | 单账号采集的 Host 查询 | 批量采集的 Host 查询 | 差异 |
|---|---|---|---|
| 抖音 | `collect.status(accountId)`，必须带账号；记录按账号存在控制器的 Map 里 | `collectAll.status`，无参 | 没有入口能查「当前哪个账号在采」；页面不知道该问谁 |
| 视频号 | `collect.status`，无参，返回当前单槽记录（含 `accountId`） | `collectAll.status`，无参 | 现有查询已足够，只缺挂载时调用 |

### 0.3 目标

页面挂载时向 Host 查询并恢复：运行中的单账号采集（进度、按钮态、轮询继续）、运行中的批量采集（面板、进度、轮询继续）、已结束的最近一次结果（抖音横幅、批量汇总），以及其他账号上正在进行的采集在账号栏可见。恢复后的轮询与页面内发起采集的轮询是同一套，进度实时。

## 1. 范围

做：

- 抖音 Host 新增本地只读 action `collect.running`：返回当前运行中的单账号采集记录（任意账号）与批量是否运行中；
- 抖音页面挂载时恢复：`collect.running`、`collect.status(选中账号)`、`collectAll.status` 三路查询，按结果恢复单账号采集态、横幅、批量面板与轮询；
- 视频号页面挂载时恢复：`collect.status`、`collectAll.status` 两路查询，恢复单账号采集态、批量面板与轮询；
- 两个工作台的账号栏对「正在采集」的账号显示状态点与文案；
- 恢复与用户操作的竞态守卫：恢复响应到达时用户已发起新采集，则丢弃恢复结果。

不做：

- 不改 Host 采集控制器与批量控制器的状态机；不改 `collect.start` 在冲突时返回 `collect_busy` 的语义；
- 不做跨进程恢复：应用重启后 Host 内存丢失，沿用既有 G-2 口径（`collect.status` 给 `recovery_required`，页面提示「上次采集被中断」）；
- 不把页面改成跨面板保活（官方底盘行为，不在本仓改）；
- 不把采集状态持久化到本地文件；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 抖音 Host 新增 action `collect.running`

| 项 | 内容 |
|---|---|
| 入参 | 无（`ACTION_SCHEMAS['collect.running'] = { fields: {} }`） |
| 出参 | `{ status: 'ready', collect: Record \| null, batchRunning: boolean }`；`collect` 与 `collect.status` 的 `collect` 投影同形（accountId / status / startedAt / finishedAt / error / progress / result），没有运行中的单账号采集时为 `null`；`batchRunning` 取批量控制器 `running` |
| 绑定 | `ACTION_TOOL_MAP['collect.running'] = { kind: 'local' }` |
| 幂等 | 只读，无 |
| 轮询 | 本身是一次性查询；恢复后继续用既有 `collect.status` / `collectAll.status` 轮询 |

抖音 Host action 由 56 项变 57 项；分册 15 §3 的计数与 `tests/host.test.ts` 的 action 清单同步。

### 2.2 视频号 Host

无变化。`collect.status` 已返回当前单槽记录（`busy` / `collect` / `lastRun`），`collectAll.status` 已返回批量状态。

### 2.3 稳定码

无新增。

### 2.4 词典新增（各插件 `locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en | 用途 |
|---|---|---|---|
| `account.collecting` | 采集中 | Collecting | 账号栏状态点文案（两个工作台各加一份） |

既有文案复用：`works.collecting`（按钮）、`works.progress.*`（进度）、`run.*`（抖音横幅）、`batch.*`（批量面板）、`run.interrupted`（恢复提示）。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无工具变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/route.ts` | `collect.running` schema 与本地绑定 | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/runner.ts` | `createCollectController` 增 `running()`：返回运行中记录的投影 | 是 | 控制器只读查询 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/handlers.ts` | `collect.running` handler | 是 | Host action |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/{WorkbenchPage,AccountSidebar,schema,locales}.ts(x)` | 挂载恢复流程、账号栏状态点、`readCollectRunning` | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/{host,route,lifecycle3}.test.ts`、`tests/client/douyin-client.test.tsx` | action 清单 57、新 action 用例、恢复用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/{WorkbenchPage,AccountSidebar,locales}.ts(x)` | 挂载恢复流程、账号栏状态点 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/tests/client/wx-data.test.tsx`、`wx-page.test.tsx` | 恢复用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/p4-douyin-workbench-baseline.md` §3、§11 | action 计数 56 → 57；登记新增 `collect.running` | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §5、`11-wx-workbench-ui-layout-parity.md` §6 | 采集状态在页面挂载时恢复的条款 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1125/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

与 [douyin-collect-all-concurrency.md](douyin-collect-all-concurrency.md) 的关系：两单都读写抖音批量面板，但改动点不重叠（本单只改挂载时的查询与恢复，不改调度）；先合本单，再合并发单，并发单的 `runningAccountIds` 投影由本单的恢复流程一并带出。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 15 册 §3/§11 + 14 册 §5 + 11 册 §6） | 2026-11-25 | `main` | 已提交本地 `main`，推送待用户确认 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-25 | `feat/collect-state-restore` | 两插件 `test`、`build`、oxlint 通过；真机验收见 5.2 |
| 本地联调（空闲态挂载） | 2026-11-25 | — | 通过，记录见 5.3；运行中采集的恢复需要真实 Chrome，留在 5.2 |
| yootun-agent 合入 `main` | | `feat/collect-state-restore` → `main` | 待真机验收通过后合入 |
| 发版 | | | 待填 |

## 5. 验收

数据库：本机联调与真机验收都使用 `tools.dofe.ai` 的 `.env`（`DATABASE_URL`）指向的数据库（[cross-repo-sync.md 第五节](../../cross-repo-sync.md#五顺序与门禁)），不为验收另建数据源。

### 5.1 自动验收（开发侧执行，每次合入前）

- [x] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过（2026-11-25）；
- [x] `pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build` 通过（2026-11-25）；
- [x] 附录 B 的 Host 与 client 用例全部存在并通过（2026-11-25）。

### 5.2 真机验收（用户执行）

前置：本机启动 yootun-agent，Workbench MCP 指向连接上述数据库的 tools；抖音与视频号各准备至少 2 个会话状态为 ok 的账号（下文 A、B）。

| # | 步骤 | 预期 |
|---|---|---|
| R1 | 抖音：A 作品页点「采集」，进度出现后切到「账号总览」Tab，再切到另一个插件面板（如视频号工作台），停留 30 秒后切回抖音工作台 | 按钮显示「采集中」并禁用；进度文案与后台一致并持续更新；账号栏 A 显示「采集中」；采集结束后显示完成 / 部分完成 / 失败横幅，作品列表与账号列表已刷新 |
| R2 | 抖音：A 点「采集」后立刻切到其他面板，等采集结束后切回 | 横幅显示终态；作品列表为最新；按钮可点 |
| R3 | 抖音：点「采集全部」后切走，30 秒后切回 | 批量面板显示已完成数、当前账号、成功 / 部分 / 失败 / 跳过计数并持续更新；账号栏当前账号显示「采集中」；结束后显示汇总 |
| R4 | 抖音：A 点「采集」→ 选中 B → 切走 → 切回 | 账号栏 A「采集中」、B 无；B 的作品面板不显示 A 的进度；B 的「采集」按钮禁用，点击后提示已有采集任务 |
| R5 | 抖音：采集进行中退出应用，重新打开回到页面 | 提示「上次采集被中断，建议重新采集」；不显示运行中状态；按钮可点 |
| R6 | 抖音：切回页面的瞬间立刻点「采集」 | 以用户操作为准：已在采则提示 `collect_busy`，否则正常开始；页面状态与 Host 回答一致，不出现假运行态 |
| R7 | 视频号：重复 R1、R3、R4、R6 | 同抖音；视频号作品面板没有终态横幅，R2 对应的预期为按钮可点、面板无残留、不重放提示 |
| R8 | 视频号：点「采集全部」后切走 → 切回 → 点取消 → 再切走 → 切回 | 面板显示 stopping，当前账号结束后显示 finished 汇总 |
| R9 | 两个工作台：明暗主题、三档宽度（≥ 1120 / 880 / 640 px） | 账号栏状态点与恢复后的面板完整可读 |
| R10 | 按 `record-browser-gif` 流程录制「切走切回恢复进度」片段 | GIF 附在 PR |

### 5.3 本地联调记录（2026-11-25）

环境同 [works-list-pagination.md](works-list-pagination.md) 5.3：本机 tools，隔离 Web profile，两个状态目录为空。

- 抖音工作台挂载时发出 `collect.running`、`collect.status`、`collectAll.status`，视频号工作台挂载时发出 `collect.status`、`collectAll.status`，与附录 A 一致。
- 空闲态不出现「采集中」标记，账号栏没有批量面板，不启动轮询。Host 空闲时 `collectAll.status` 返回字段全为空的 `batch` 对象（`status` 为 `null`）而不是 `null`：`readBatchStatus` 读出空闲，`BatchPanel` 对 `status` 为 `null` 不渲染。单测的 mock 用 `batch: null`，真实 Host 的空闲应答是全空对象，两条路径在本地联调中都确认不渲染面板。
- 运行中采集的恢复（5.2 的 R1–R8）需要真实 Chrome 与已登录账号，本地未覆盖。
- 与分页分支的冲突文件及解决方式见 [works-list-pagination.md](works-list-pagination.md) 5.3。

实施单第 4 节在本单合入后回填完整。

## 附录 A：恢复流程

### A.1 抖音

挂载后（账号列表就绪、选中账号确定）并行发三路查询，响应用既有代次守卫（页面代次 + 选中账号）：

| 查询 | 结果 | 页面动作 |
|---|---|---|
| `collect.running` | `collect.status === 'running'` | `collectBusy = true`；`collectRecord = collect`；启动单账号轮询（按其 `accountId` 轮询 `collect.status`，与页面内发起采集同一 tick） |
| 同上 | `collect = null`，`batchRunning = true` | `batchRunning` 先置位（按钮禁用），等批量查询 |
| `collect.status({ accountId: 选中 })` | `collect.status === 'running'` | 同上（与 `collect.running` 指向同一条记录时幂等） |
| 同上 | `collect` 为终态（completed / partial / failed） | `collectRecord = collect` 显示横幅；`collectBusy` 不变 |
| 同上 | `collect = null`，`recovery = recovery_required` | 提示 `run.interrupted`；不进入运行态 |
| `collectAll.status` | `batch.status === 'running'` | `batch` 置为返回值；启动批量轮询 |
| 同上 | `batch.status` 为终态 | `batch` 置为返回值（显示汇总），不轮询 |
| 同上 | `batch.status = null` | 不显示批量面板 |

终态收尾与页面内发起采集一致：单账号终态刷新该账号作品当前页与账号列表；批量终态刷新当前选中账号。

竞态：挂载后记录「用户已发起采集 / 批量」的标记；恢复响应到达时标记已置位则丢弃。恢复查询本身失败按无运行中采集处理，不弹错误（页面内发起采集仍会得到 Host 的真实回答）。

### A.2 视频号

挂载后并行两路：

| 查询 | 结果 | 页面动作 |
|---|---|---|
| `collect.status` | `busy = true` 且 `collect` 非空 | `collectBusy = true`；`collectRecord = collect`；启动单账号轮询 |
| 同上 | `busy = false` | 不进入运行态（视频号作品面板没有终态横幅，终态只在采集结束时以 toast 提示一次，挂载时不重放） |
| `collectAll.status` | `phase ∈ { probing, collecting, stopping }` | `batch` 置为返回值；启动批量轮询 |
| 同上 | `phase = finished` | `batch` 置为返回值（显示汇总），不轮询 |
| 同上 | `phase = ready` | 不显示批量面板 |

竞态守卫同抖音。

### A.3 账号栏状态点

两个工作台的账号卡片在会话徽标旁增加「采集中」状态点：抖音取 `collect.running.collect.accountId`（恢复后由单账号轮询与批量 `items` 维护），视频号取 `collectRecord.accountId`；批量运行中的账号取批量 `currentAccountId`（视频号）或 `items` 中 `status = running` 的账号（抖音）。状态点不改变账号卡片的点击与选中行为。

## 附录 B：测试矩阵

### B.1 抖音 Host（`tests/route.test.ts`、`tests/host.test.ts`、`tests/lifecycle3.test.ts`）

| ID | 断言 |
|---|---|
| H1 | action 清单含 `collect.running`（57 项），`ACTION_TOOL_MAP` 为 local |
| H2 | 无运行中采集：`collect = null`、`batchRunning = false` |
| H3 | 单账号运行中：`collect.status = running` 且 `accountId` 正确；终态后回到 `null` |
| H4 | 批量运行中（探测阶段与采集阶段）：`batchRunning = true`；结束后 `false` |
| H5 | `collect.running` 不读写 runs.json、不调用 Workbench |

### B.2 抖音 client（`tests/client/douyin-client.test.tsx`）

| ID | 断言 |
|---|---|
| D1 | 挂载时三路查询各一次；无运行中采集时不启动轮询（`collect.status` 轮询调用数为 0） |
| D2 | 单账号运行中：按钮「采集中」禁用、进度文案来自返回记录、轮询按既有间隔继续、终态后刷新作品当前页与账号列表 |
| D3 | 终态记录：横幅显示，不轮询 |
| D4 | `recovery_required`：提示 `run.interrupted`，不进入运行态 |
| D5 | 批量运行中：面板与账号栏按返回值渲染，轮询继续；终态：显示汇总不轮询；`null`：无面板 |
| D6 | 恢复响应到达前用户点「采集」：恢复结果丢弃 |
| D7 | 其他账号在采：该账号卡片显示「采集中」，选中账号面板不显示其进度，按钮禁用 |

### B.3 视频号 client（`tests/client/wx-data.test.tsx`、`wx-page.test.tsx`）

| ID | 断言 |
|---|---|
| W1 | 挂载时两路查询各一次；无运行中采集时不启动轮询 |
| W2 | 单账号运行中：按钮态、进度、轮询恢复；终态后刷新 |
| W3 | 批量运行中（probing / collecting / stopping）：面板与轮询恢复；finished：汇总不轮询；ready：无面板 |
| W4 | 恢复响应到达前用户点「采集」：恢复结果丢弃 |
| W5 | 其他账号在采：账号卡片显示「采集中」 |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 抖音「谁在采」的入口 | 新增 action `collect.running` | 把 `collect.status` 的 `accountId` 改为可选 |
| 挂载时显示最近一次终态横幅（抖音） | 显示 | 只恢复运行中 |
| 挂载时显示最近一次批量汇总 | 显示（Host 内存存活期间） | 只恢复运行中 |
| 其他账号在采的提示 | 账号栏状态点 + 文案 | 只禁用按钮 |
| 视频号终态 | 不重放 toast（面板无横幅） | 挂载时补一次 toast |
