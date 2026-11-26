# wx-workbench-采集全部并发 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

参照实现：抖音「采集全部」并发（[douyin-collect-all-concurrency.md](../../1125/features/douyin-collect-all-concurrency.md)），2026-11-25 合入后运行两天稳定，本单把同一调度模型移植到视频号。

## 0. 背景与目标

### 0.1 现状

视频号账号管理栏「采集全部」走 Host action `collectAll.start`：候选为 `accounts.json` 中全部非占位账号，交给批量控制器 `createBatchCollectController`（`yootun/plugins/dsh-wx-channels-workbench/src/collect-all.ts`）。控制器分两阶段：阶段 1 逐个账号实测会话并上报；阶段 2 严格串行，上一个账号完全结束才启动下一个。单账号采集 `runCollection` 全程持有账号 profile 锁：探测 → 远端账号自愈 → 无头 Chrome → 作品列表翻页 → 逐作品详情 → 账号级三接口 → 入库 → 会话恢复上报。

单账号采集在 Host 里是单槽语义：`deps.collectBusy` 是一个布尔值，`deps.collectRecord` 是一个对象，页面靠 `collect.status` 无参查询拿到「当前那一条」。并发之前必须先把单账号状态改成按账号维护。

### 0.2 目标

账号之间并发采集：默认 3 个账号同时进行，插件 Config 可调 1..5，整批耗时降到约三分之一。单账号流程、探测阶段、互斥口径、失败语义、取消与 dispose 语义不变。沿用抖音的两项风控对策：worker 启动错峰、批内熔断。

### 0.3 并发在结构上成立的事实

| 层 | 隔离方式 | 位置 |
|---|---|---|
| 本地 profile | 每账号一把锁，`runCollection` 全程持有；不同账号互不阻塞 | `src/locks.ts` |
| 本地状态文件 | `accounts.json` 与 `runs.json` 各有 per-root 写队列，run 记录按 accountId + attemptId 写入 | `src/state.ts`、`src/runs.ts` |
| 本地凭证 | storage_state 按账号分文件，探测只写自己账号的文件 | `src/session.ts` `probeSession` |
| Chrome | 每账号独立 browser 进程与 context，注入各自的 storageState | `src/session.ts` `launchChrome` |
| 服务端 run | `run_start` 锁账号行，同账号至多一个 running run，没有全局或设备级限制 | tools `wx_channels_operation` 服务（与抖音同口径） |
| 页面 | 账号栏状态点已按批量 `currentAccountId` 与单账号记录维护 | `src/client/AccountSidebar.tsx` |

串行假设只存在于批量控制器的阶段 2 循环、单账号的单槽状态（`collectBusy` / `collectRecord`）和它们的投影（`collect.status` 无参返回单个记录、`currentAccountId` 单值）。服务端与 docker-helm 不需要改。

## 1. 范围

做：

- 单账号采集改为按账号 Map 的控制器（`createCollectController`）：同账号单飞幂等、`running()` / `wait()` / `hasRunning()`、批量内部启动不受批量互斥拦截；
- 阶段 2 由串行循环改为 worker 队列：`batchConcurrency` 个 worker 从按 accountId 排序的 `ready` 列表取账号，取到后执行与现状相同的「启动单账号采集 → 等待 → 结算条目」；
- 插件 Config 新增 `batchConcurrency`（缺省 3，1..5），loader 校验，越界即加载失败；
- worker 启动错峰：第 k 个 worker 首次取账号前等待 k × 随机 3–8 秒；每次取下一个账号前随机等待 0–3 秒；
- 批内熔断：同一批次内「探测通过后采集途中会话失效」的账号达到 2 个，剩余未开始的账号标 `skipped / risk_paused`，批次带 `error: risk_paused` 结算；
- `collectAll.status` 出参增量：`runningAccountIds`、`concurrency`、`error`；`currentAccountId` 保留；
- `collect.status` 入参增可选 `accountId`，出参增 `runningAccountIds`；新增本地只读 action `collect.running`；
- 批量面板按多账号展示运行中账号与熔断提示；
- 新原因 `risk_paused` 登记稳定码与中英文案；
- 页面挂载恢复改为三路查询（与抖音同口径）；
- 测试：既有批量 dispose / abort 用例按并发重写，新增并发峰值、顺序、熔断、错峰、Config 校验用例。

不做：

- 不改阶段 1：探测仍逐个串行执行；
- 不改单账号流程 `runCollection` 的任何步骤与顺序；
- 不提供页面级并发度入口（只走 Config）；
- 不改 `collectAll.cancel` 的语义（stopping → 当前账号 settle → finished）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。本单不新增、不修改任何 Workbench 工具。

### 2.1 插件 Config

| 字段 | 类型 | 缺省 | 约束 | 位置 |
|---|---|---|---|---|
| `batchConcurrency` | integer | `3` | 1..5；非整数、越界、非数字由 schema 拒绝，插件加载失败 | `src/index.ts` `Config` |

bundle `cordis.patch.yml` 不写该字段，走缺省 3。

### 2.2 `collect.start`

入参不变（`accountId`、`newAttempt`）。出参不变（`started`、`reason`）。

页面发起（非批量内部）的启动流程与现状逐步一致：就绪检查 → `probeAndReport`（同步等待，期间记录的 `progress.phase` 为 `probing`）→ 探测通过后登记记录并启动 `runCollection`，返回 `started: true`；探测不通过返回 `started: false` 与原因。批量内部启动（`fromBatch`）不做前置探测（阶段 1 已实测），直接启动。

行为变化只有一处：`started: false / collect_busy` 的判定改为「同账号运行中，或批量运行中且本次不是批量内部启动」。

### 2.3 `collect.status`

| 字段 | 现状 | 变更 |
|---|---|---|
| 入参 | 无 | 增可选 `accountId`（≤128） |
| `busy` | `deps.collectBusy` | 任一账号运行中 |
| `collect` | 单槽记录（含终态） | 传了 `accountId`：该账号最近一条记录（运行中或终态），无则 `null`；未传：首个运行中记录，无运行中则 `null` |
| `runningAccountIds` | 无 | 运行中的账号，按启动顺序 |
| `lastRun` | runs.json 最近一条 | 不变 |

### 2.4 `collect.running`（新增）

| 项 | 内容 |
|---|---|
| 入参 | 无（`ACTION_SCHEMAS['collect.running'] = { fields: {} }`） |
| 出参 | `{ status: 'ok', collect: Record \| null, batchRunning: boolean }`；`collect` 与 `collect.status` 的 `collect` 投影同形 |
| 用途 | 页面挂载恢复时查询「当前哪个账号在采」 |

视频号 Host action 由 22 项变 23 项；p2 册 §1 的 action 映射同步。

### 2.5 `collectAll.status` 出参增量

| 字段 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `currentAccountId` | string \| null | 首个运行中的账号；无运行账号为 null | 保留，兼容现有消费者 |
| `runningAccountIds` | string[] | 运行中的账号，按启动顺序 | 新增；长度 ≤ `concurrency` |
| `concurrency` | number | 生效并发度 = min(配置并发度, 阶段 1 通过的账号数) | 新增；未启动过的空状态为 0 |
| `error` | string \| null | 批次级原因 | 新增；取值 `risk_paused`、`collect_cancelled`、`no_eligible_account` |
| `items[].reason` | string \| null | 条目原因 | 新增取值 `risk_paused`，只出现在 `status: skipped` 的未开始账号上 |
| `items[].finishedAt` | string \| null | 条目终态时刻 | 新增；只有熔断暂停的条目写暂停时刻 |
| `phase` | `'probing' \| 'collecting' \| 'stopping' \| 'ready' \| 'finished'` | 不变 | |
| `status` | `'running' \| 'completed' \| 'partial' \| 'failed' \| null` | 不变 | 熔断批次按既有三态结算 |

### 2.6 稳定码

| 码 | 位置 | 用途 |
|---|---|---|
| `risk_paused` | `src/errors.ts` `LOCAL_ERROR_CODES` 追加 | 批次 `error` 与条目 `reason` 的新取值；不是路由 `reason` |

### 2.7 词典新增（`src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `batch.progress.concurrent` | 已完成 {done}/{total} 个账号 | {done}/{total} accounts done |
| `batch.currentList` | 正在采集：{names} | Collecting: {names} |
| `batch.concurrency` | 最多同时采集 {count} 个账号 | Up to {count} accounts collected at a time |
| `batch.paused` | 检测到疑似平台风控，批次已暂停，剩余 {remaining} 个账号未采集 | Possible platform risk control detected; the batch is paused with {remaining} accounts not collected |
| `batch.reason.riskPaused` | 疑似风控，批次已暂停 | Paused for possible risk control |

既有文案复用：`account.collecting`（账号栏状态点）、`batch.progress.checking`、`batch.counts`、`batch.summaryLine`。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | run 按账号隔离，无全局约束 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/index.ts` | `Config.batchConcurrency`；`createWxHostDeps` 透传 | 是 | 可调参数必须是 Config 字段 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/runner.ts` | 新增 `createCollectController`（按账号 Map） | 是 | 并发的前置 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/collect-all.ts` | 阶段 2 改 worker 队列；`BatchStatus` 增字段；熔断 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/handlers.ts` | `collect.start` / `collect.status` / `collect.cancel` 改走控制器；新增 `collect.running`；批量回调接线 | 是 | Host action |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/route.ts` | `collect.status` 入参、`collect.running` schema | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/errors.ts` | `risk_paused` | 是 | 稳定码白名单 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/schema.ts` | `BatchView` 增字段；`readBatchStatus` 投影 | 是 | Host 载荷读取器 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/WorkbenchPage.tsx` | 单账号轮询按账号查询；挂载恢复三路查询；批量轮询 | 是 | 页面 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/AccountSidebar.tsx` | `BatchPanel` 多账号展示与熔断提示 | 是 | 页面 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/locales.ts` | 2.7 节五个键 | 是 | 文案 locale-owned |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/tests/batch-concurrency.test.ts`（新建）、`tests/host.test.ts`、`tests/dispose.test.ts`、`tests/client/wx-data.test.tsx`、`tests/client/wx-page.test.tsx`、`package.json` test 脚本 | 新增与重写用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/p2-wx-workbench-baseline.md` §1、`11-wx-workbench-ui-layout-parity.md` §6 | action 计数 22 → 23；并发与多账号面板条款 | 是 | 基线与布局记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + p2 册 §1 + 11 册 §6 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/wx-collect-all-concurrency` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |
| 观察结论 | | | 待填：观察窗口与指标见附录 C.4 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build` 通过（node --test 与 vitest 两套）；
- [ ] 附录 B 的 B1–B18 对应用例全部存在并通过；
- [ ] `pnpm run lint` 对改动文件无新告警。

### 5.2 真机验收（用户执行）

前置：不少于 6 个会话状态为 ok 的视频号账号；插件 Config 未设置 `batchConcurrency`（走缺省 3）。

| # | 步骤 | 预期 |
|---|---|---|
| R1 | 点「采集全部」 | 面板先显示「正在检查会话 i/n」，随后显示「已完成 x/n 个账号」「正在采集：A、B、C」「最多同时采集 3 个账号」并持续更新；任务管理器可见 3 个 Chrome 进程；记录整批耗时 |
| R2 | 批量运行中点某账号的「采集」 | 提示已有采集任务（`collect_busy`），不启动 |
| R3 | 批量运行中再点「采集全部」 | 不产生第二个批次 |
| R4 | 批量运行中分别选中运行中的账号与未开始的账号看作品页 | 运行中的显示实时进度；未开始的不显示进度且按钮禁用 |
| R5 | 批量运行中 `runs.json` 任取 3 条 running 记录 | accountId 与 attemptId 一一对应，没有同一账号两条 running |
| R6 | 本轮出现疑似平台风控时（无法人为触发，遇到即记录） | 剩余未开始账号标「疑似风控，批次已暂停」，面板显示暂停提示与剩余数；已运行的账号正常结束 |
| R7 | 批量运行中点取消 | 面板显示 stopping；3 个在途账号落 cancelled 后显示 finished 汇总 |
| R8 | 批量运行中退出应用，重新打开 | 在途账号的本地 run 落 cancelled；页面提示「上次采集被中断」 |
| R9 | 采集进行中切到其他面板再切回 | 进度、面板与账号栏状态点恢复并继续更新（挂载恢复三路查询） |
| R10 | 明暗主题、三档宽度（≥1120 / 880 / 640 px） | 多账号行与熔断提示完整可读 |
| R11 | 按 `record-browser-gif` 流程录制批量面板片段 | GIF 附在 PR |
| R12 | 发版后按附录 C.4 记录至少 3 轮批量、不少于 1 周 | 整批耗时、并发峰值、风控信号数、熔断次数；结论回填第 4 节 |

### 5.3 本地联调记录

待填（合入前回填：环境、空闲态挂载查询、与并行的 P0 单冲突预演）。

## 附录 A：调度设计

### A.1 阶段 1（不变）

逐个账号实测会话并上报，结果为 `ready` / `skipped`。全部探测完成后：有取消 → 剩余条目 `failed / collect_cancelled`，批次 `failed`；无 `ready` → 批次 `failed / no_eligible_account`。

### A.2 阶段 2（worker 队列）

`runnable` 是阶段 1 产出的 `ready` 条目（`items` 已按 accountId 排序）。控制器维护共享游标 `nextIndex` 与运行中集合 `runningAccountIds`。

每个 worker 循环：

1. 游标到末尾、批次已取消或已熔断 → 退出；
2. 首次取账号前等待 `workerIndex × rand(3000, 8000)` 毫秒；之后每次取账号前等待 `rand(0, 3000)` 毫秒；等待可被批次 signal 立即打断；
3. 取 `runnable[nextIndex]`，`nextIndex += 1`；条目 `running`，`runningAccountIds.push(accountId)`，`currentAccountId = runningAccountIds[0] ?? null`；
4. `collect.start({ accountId, options: { signal }, fromBatch: true })`；未启动 → 条目 `failed`，原因取 `started.reason ?? 'collect_failed'`；
5. `await collect.wait(accountId)`；按 `collectOutcomeStatus` 结算为 `completed` / `partial` / `failed`（取消时 `failed / collect_cancelled`，与抖音同口径；`items[].reason` 记录原因）；
6. `runningAccountIds` 移除该账号；未取消且结果为风控信号 → `riskSignals += 1`，达到阈值且未熔断 → `paused = true`，`pauseRest()`：剩余 `queued` / `ready` 条目标 `skipped / risk_paused` 并写 `finishedAt`，批次 `error = 'risk_paused'`；
7. 回到 1。

`Promise.all(workers)` 结束后在 `finally` 结算批次三态；取消 → `failed / collect_cancelled`；全部被拦截 → `failed / no_eligible_account`；熔断 → 按三态结算并保留 `error: 'risk_paused'`。

### A.3 单账号控制器

`createCollectController(deps, { batchHasRunning, taskRegistry })`：

- `runs: Map<accountId, CollectRecord>`；`CollectRecord = { accountId, status, startedAt, finishedAt, events, progress, result, error, task }`；
- `start(input)`：空 id → `account_id_required`；同账号运行中 → `collect_busy`；非批量内部启动且 `batchHasRunning()` → `collect_busy`；否则创建记录并调用 `runCollection`（与现状 `collect.start` handler 内的编排一致：`onProgress` 更新 `record.progress`、终态写回），`task` 保存到记录上并登记到 `taskRegistry`；
- `status(accountId)`、`running()`、`runningAccountIds()`、`hasRunning()`；
- `wait(accountId)`：直接 `await record.task`（不用定时轮询），记录不存在 → `null`；
- `cancel(accountId)`：abort 该账号的 controller；返回是否在运行。

终态记录保留到下一次同账号启动时覆盖（Map 以 accountId 为键，条目数不超过账号数）。

### A.4 风控信号

结果 `status === 'failed'` 且 `reason ∈ { 'session_expired', 'probe_failed' }`（探测通过后采集途中会话失效）。阈值 2。

### A.5 挂载恢复

挂载后（账号列表就绪、选中账号确定）并行三路查询，响应用既有代次守卫（页面代次 + 选中账号 + 用户已发起标记）：

| 查询 | 结果 | 页面动作 |
|---|---|---|
| `collect.running` | `collect.status === 'running'` | 进入运行态；按其 `accountId` 轮询 `collect.status({ accountId })` |
| `collect.status({ accountId: 选中 })` | 运行中 | 同上（与 `collect.running` 指向同一条记录时幂等） |
| 同上 | `busy === false` 且 `collect === null` | 不进入运行态（视频号作品面板没有终态横幅，终态只在采集结束时以 toast 提示一次，挂载时不重放） |
| `collectAll.status` | `phase ∈ { probing, collecting, stopping }` | 批量面板置为返回值；启动批量轮询 |
| 同上 | `phase = finished` | 面板显示汇总，不轮询 |
| 同上 | `phase = ready` | 不显示批量面板 |

## 附录 B：测试矩阵

### B.1 Host（`tests/batch-concurrency.test.ts` 新建；`tests/host.test.ts`、`tests/dispose.test.ts`）

| ID | 断言 |
|---|---|
| B1 | action 清单含 `collect.running`（23 项），`ACTION_SCHEMAS` 为空字段 |
| B2 | 同账号运行中再次 `collect.start` → `collect_busy`；不同账号可同时运行 |
| B3 | 批量运行中页面发起单账号 → `collect_busy`；批量内部 `fromBatch` 启动不受拦截 |
| B4 | 并发峰值等于 min(配置并发度, ready 账号数)，任何时刻不超过 |
| B5 | worker 按 accountId 排序取号；`runningAccountIds` 按启动顺序；`currentAccountId` 为首个 |
| B6 | `collectAll.status` 的 `concurrency` 在阶段 2 启动时落定，终态后不变 |
| B7 | 单账号 `partial` 结算为 `partial`；`failed` 结算为 `failed` 并带原因 |
| B8 | 风控信号达到 2 → 剩余条目 `skipped / risk_paused`，`error = risk_paused`，已运行账号正常结束 |
| B9 | 风控信号 1 次不熔断 |
| B10 | 错峰：注入定值 rand 与零等待 sleep，断言第 k 个 worker 首取延迟为 k × (base + rand × spread) |
| B11 | `batchConcurrency` 非整数 / 0 / 6 → Config 校验失败 |
| B12 | 批量运行中 `stop()` → `phase = stopping`，在途账号 abort 并结算 `collect_cancelled`，后续账号不启动，settle 后 `finished` |
| B13 | dispose 在批量运行中：abort 全部在途、等全部 settle、无 unhandled rejection |
| B14 | `collect.wait` 在任务已完成时立即返回结果 |
| B15 | `collect.status` 传 `accountId` 返回该账号记录；未传返回首个运行中；`runningAccountIds` 正确 |
| B16 | `collect.running` 无运行中时 `collect = null`；批量运行中 `batchRunning = true` |
| B17 | 阶段 1 全部拦截 → `failed / no_eligible_account`，阶段 2 不启动 |
| B18 | 既有 dispose / abort 用例按并发重写后通过；无 client / timer / request 泄漏 |

### B.2 client（`tests/client/wx-data.test.tsx`、`tests/client/wx-page.test.tsx`）

| ID | 断言 |
|---|---|
| D1 | 挂载时三路查询各一次；无运行中采集时不启动轮询 |
| D2 | 选中账号运行中：按钮「采集中」禁用、进度文案来自该账号记录、轮询继续 |
| D3 | 批量运行中：面板显示「已完成 x/n」「正在采集：A、B、C」「最多同时采集 3 个账号」并按轮询更新 |
| D4 | 熔断：面板显示暂停提示与剩余数；账号栏剩余账号不显示「采集中」 |
| D5 | 批量 `finished`：显示汇总，不轮询；`ready`：无面板 |
| D6 | 恢复响应到达前用户点「采集」：恢复结果丢弃 |
| D7 | 其他账号在采：账号卡片显示「采集中」，选中账号面板不显示其进度 |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 单账号状态 | 按 accountId 的 Map（移植抖音控制器） | 保留单槽 + 批量单独维护运行集合 |
| 等待单账号结束 | 保存并 await 任务 promise | 120ms 定时轮询（抖音现状） |
| 并发度 | Config 3，范围 1..5 | 页面级入口 |
| 错峰与取号间隔 | k × rand(3–8s)；rand(0–3s) | 固定间隔 |
| 熔断阈值 | 2 | 3 |
| 取消时在途条目 | `failed / collect_cancelled`（与抖音同口径） | `cancelled` 独立状态 |

### C.4 观察指标（发版后）

至少 3 轮批量、不少于 1 周：整批耗时、并发峰值、风控信号数（`session_expired` / `probe_failed` 出现次数）、熔断次数、批量结束 24 小时内需重新探测或扫码的账号数。结论回填第 4 节「观察结论」。
