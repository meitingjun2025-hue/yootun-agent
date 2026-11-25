# douyin-workbench-采集全部并发 实施单

状态：草案 ｜ 创建：2026-11-25 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音账号管理栏「采集全部」走 Host action `collectAll.start`：`batchCandidates` 按本地缓存筛选候选账号（pending / 非 ok / 无凭证的账号直接 `skipped`），交给批量控制器 `createBatchCollectController`（`yootun/plugins/dsh-douyin-workbench/src/runner.ts`）。控制器分两阶段：阶段 1 逐个账号实测会话并上报；阶段 2 严格串行，上一个账号完全结束才启动下一个。单账号流程 `runCollection` 全程持有账号 profile 锁：探测 → 远端账号自愈 → 无头 Chrome → 作品列表翻页 → 逐稿详情 → 入库 → 会话恢复上报 → 头像补写。

耗时主体在逐稿详情：每个作品固定等待约 7.5 秒（3 s + 1.5 s × 2 + 1.5 s，`src/collector.ts` `collectWorkDetail`），再加导航与兜底请求。账号之间串行，18 个账号一轮约 2 小时，折合每账号约 6.7 分钟。

### 0.2 目标

账号之间并发采集：默认 3 个账号同时进行，插件 Config 可调 1..5，整批耗时降到约三分之一。单账号流程、探测阶段、互斥口径、失败语义、取消与 dispose 语义全部不变。附带两项风控对策：worker 启动错峰、批内熔断。

### 0.3 并发在结构上成立的事实

| 层 | 隔离方式 | 位置 |
|---|---|---|
| 本地 profile | 每账号一把锁，`runCollection` 全程持有；不同账号互不阻塞 | `src/locks.ts` |
| 本地状态文件 | `accounts.json` 与 `runs.json` 各有 per-root 写队列，run 记录按 accountId + attemptId 写入 | `src/state.ts`、`src/runs.ts` |
| 本地凭证 | storage_state 按账号分文件，探测只写自己账号的文件 | `src/session.ts` `probeSession` |
| Chrome | 每账号独立 browser 进程与 context，注入各自的 storageState | `src/session.ts` `launchChromeSession` |
| 服务端 run | `run_start` 锁账号行，同账号至多一个 running run，没有全局或设备级限制 | tools `src/tools_dofe/services/douyin_operation/runs.py` `start_run` |
| 单账号控制器 | `runs` Map 以 accountId 为键，同账号 running 时再次 start 返回 `collect_busy` | `src/runner.ts` `createCollectController` |

串行假设只存在于批量控制器的阶段 2 循环和它的状态投影（`currentAccountId` 单值）。服务端与 docker-helm 不需要改。

## 1. 范围

做：

- 阶段 2 由串行循环改为 worker 队列：`batchConcurrency` 个 worker 从按 accountId 排序的 `runnable` 列表取账号，取到后执行与现状完全相同的「`collect.start` → `collect.wait` → 结算条目」；
- 插件 Config 新增 `batchConcurrency`（缺省 3，1..5），loader 校验，越界即加载失败；
- worker 启动错峰：第 k 个 worker 首次取账号前等待 k × 随机 3–8 秒；每次取下一个账号前随机等待 0–3 秒；
- 批内熔断：同一批次内「探测通过后采集途中会话失效」的账号达到 2 个，剩余未开始的账号标 `skipped` / `risk_paused`，批次带 `error: risk_paused` 结算；
- `collectAll.status` 出参增量：`runningAccountIds`、`concurrency`；`currentAccountId` 保留；
- 批量面板按多账号展示运行中账号与熔断提示；
- 新原因 `risk_paused` 登记稳定码与中英文案；
- 测试：既有批量 dispose / abort 用例按并发重写，新增并发峰值、顺序、熔断、错峰、Config 校验用例。

不做：

- 不改阶段 1：探测仍逐个串行执行，`no_eligible_account` 仍表示「全部账号被探测拦截」；
- 不改单账号流程 `runCollection` 的任何步骤、等待时长与顺序，包括每个账号在批量探测与 `runCollection` 内各探测一次的既有行为；
- 不改逐稿 7.5 秒等待节奏；
- 不提供页面级并发度入口（只走 Config）；
- 不新增 `collectAll.cancel` action（分册 15 §11 G-1 的既有缺口，不在本单范围）；
- 不改视频号工作台：其批量采集（`dsh-wx-channels-workbench/src/collect-all.ts`）仍串行，待抖音观察结论后另立单；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。本单不新增、不修改任何 Workbench 工具。

### 2.1 插件 Config

| 字段 | 类型 | 缺省 | 约束 | 位置 |
|---|---|---|---|---|
| `batchConcurrency` | integer | `3` | 1..5；非整数、越界、非数字由 schema 拒绝，插件加载失败 | `src/index.ts` `Config` |

bundle `cordis.patch.yml` 不写该字段，走缺省 3。

### 2.2 `collectAll.start`

入参不变（无参）。

### 2.3 `collectAll.status` 出参增量（`batch`）

| 字段 | 类型 | 取值 | 说明 |
|---|---|---|---|
| `currentAccountId` | string \| null | 首个运行中的账号；无运行账号为 null | 保留字段，兼容现有消费者 |
| `runningAccountIds` | string[] | 运行中的账号，按启动顺序 | 新增；长度 ≤ `concurrency` |
| `concurrency` | number | 生效的并发度 | 新增；未启动过的空状态为 0 |
| `error` | string \| null | 批次级原因 | 新增取值 `risk_paused`（熔断暂停）；`collect_cancelled`、`no_eligible_account` 不变 |
| `items[].reason` | string \| null | 条目原因 | 新增取值 `risk_paused`，仅出现在 `status: skipped` 的未开始账号上 |
| `phase` | `'probing'` \| `'collecting'` \| null | 不变 | 阶段 1 仍为 `probing`，阶段 2 仍为 `collecting` |
| `status` | `'running'` \| `'completed'` \| `'partial'` \| `'failed'` \| null | 不变 | 熔断批次按既有三态结算 |
| `runnableDone` / `completedCount` / `partialCount` / `failedCount` / `skippedCount` | number | 不变 | `risk_paused` 条目计入 `skippedCount`，不计入 `runnableDone` |

### 2.4 稳定码

| 码 | 位置 | 用途 |
|---|---|---|
| `risk_paused` | `src/errors.ts` `LOCAL_ERROR_CODES` 追加 | 批次 `error` 与条目 `reason` 的新取值；不是路由 `reason` |

### 2.5 词典新增（`src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `batch.progress.concurrent` | 已完成 {done}/{total} 个账号 | {done}/{total} accounts done |
| `batch.currentList` | 正在采集：{names} | Collecting: {names} |
| `batch.concurrency` | {count} 路并发 | {count} in parallel |
| `batch.paused` | 检测到疑似平台风控，批次已暂停，剩余 {remaining} 个账号未采集 | Possible platform risk control detected; the batch is paused with {remaining} accounts not collected |
| `batch.reason.riskPaused` | 疑似风控，批次已暂停 | Paused for possible risk control |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | run 按账号隔离，无全局约束 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/index.ts` | `Config.batchConcurrency` schema；`createDouyinHostDeps` 透传到批量控制器 | 是 | 可调参数必须是 Config 字段 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/runner.ts` | `createBatchCollectController` 阶段 2 改 worker 队列；`BatchStatus` 增 `runningAccountIds` / `concurrency`；熔断 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/errors.ts` | `risk_paused` | 是 | 稳定码白名单 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/schema.ts` | `BatchView` 增字段，`readBatchStatus` 投影 | 是 | Host 载荷读取器 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/format.ts` | `batchReasonKey` 增 `risk_paused` | 是 | 原因 → 词典键 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/AccountSidebar.tsx` | `BatchPanel` 多账号展示与熔断提示 | 是 | 页面 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/locales.ts` | 2.5 节五个键 | 是 | 文案 locale-owned |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/batch-concurrency.test.ts`（新建）、`tests/lifecycle3.test.ts`、`tests/client/douyin-parity.test.tsx`、`package.json` test 脚本 | 新增与重写用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/p4-douyin-workbench-baseline.md` §11 | 登记 #10 `collectAll.start` 由逐账号串行改为受控并发 | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1125/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 15 册 §11） | | `main` | 待填 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| yootun-agent 合入 `main` | | `feat/douyin-collect-all-concurrency` → `main` | 待填 |
| 发版 | | | 待填 |
| 观察结论（视频号是否镜像） | | | 待填：观察窗口与指标见附录 C |

## 5. 验收

- [ ] yootun-agent：`pnpm --filter @yootun/dsh-douyin-workbench test`、`pnpm --filter @yootun/dsh-douyin-workbench build` 通过；
- [ ] 附录 B 不变量逐条有对应用例并通过；
- [ ] 本地三仓联调：假 MCP + 真 Chrome 跑一轮不少于 6 个账号的批量，`collectAll.status` 全程 `runningAccountIds.length ≤ 3`，`runs.json` 每条记录的 accountId 与 attemptId 一一对应；
- [ ] 真机：18 个账号一轮批量，记录整批耗时、并发峰值、`session_invalid` / `probe_failed` 条目数、熔断是否触发；
- [ ] 真机：批量运行中点单账号「采集」得到 `collect_busy`；批量运行中重复点「采集全部」不产生第二个批次；
- [ ] 真机：批量运行中退出应用，3 个在途账号的本地 run 落 `cancelled`，重启后 `collect.status` 给出 `recovery_required`（G-2 既有口径）；
- [ ] UI：明暗主题、三档宽度下批量面板的多账号行与熔断提示完整可读；
- [ ] PR 附真机录制的 GIF（GUI 行为变更）；
- [ ] 实施单第 4 节回填完整。

## 附录 A：调度设计

### A.1 阶段 1（不变）

逐个账号实测会话并上报，结果为 `ready` / `skipped`。全部探测完成后：有取消 → `failRest('collect_cancelled')`，批次 `failed`；无 `ready` → 批次 `failed` / `no_eligible_account`。

### A.2 阶段 2（worker 队列）

`runnable` 是阶段 1 产出的 `ready` 条目，顺序与 `items` 一致（已按 accountId 排序）。控制器维护共享的取数游标 `nextIndex` 与运行中集合 `runningAccountIds`。

每个 worker 循环执行：

1. 若游标已到末尾或批次已取消或已熔断 → 退出；
2. 首次取账号前等待 `workerIndex × rand(3000, 8000)` 毫秒；之后每次取账号前等待 `rand(0, 3000)` 毫秒。等待可被批次 signal 立即打断；
3. 取 `runnable[nextIndex]`，`nextIndex += 1`；条目 `status: running`，`runningAccountIds.push(accountId)`，`currentAccountId = runningAccountIds[0] ?? null`；
4. `collect.start({ accountId, options: { signal } })`；未启动 → 条目 `failed`，原因取 `started.reason ?? 'collect_failed'`；
5. 已启动 → `await collect.wait(accountId)`，按 `collectOutcomeStatus` 结算条目（`completed` / `partial` / `failed`），与现状逐字段相同；取消后结算沿用现状：在途条目 `failed` / `collect_cancelled`；
6. 从 `runningAccountIds` 移除该账号并更新 `currentAccountId`；
7. 若结算结果是风控信号（附录 C.2）→ 计数加一，达到阈值即置 `paused`，把仍是 `queued` / `ready` 的条目标 `skipped` / `risk_paused`，`current.error = 'risk_paused'`。

全部 worker 退出后进入既有的 `finally`：批次仍为 `running` 时按 completed / partial / failed 计数结算三态并写 `finishedAt`。取消后仍有条目未结算 → `failRest('collect_cancelled')`，批次 `failed` / `collect_cancelled`（不变）。

### A.3 取消与 dispose

批次级 `signal` 同时传给每个 worker 启动的采集（现状只传给当前这一个）。abort 后：等待中的 worker 立即结束等待并退出；在途账号的 `runCollection` 在既有 abort 检查点退出并落 `cancelled`；没有 worker 再取新账号。`collect:batch:<id>` 信号在整批 settle 后清理（不变）。

### A.4 资源

同时运行的 Chrome 进程数等于并发度，3 路约多占 1 GB 内存；并发度上限 5 由 Config 约束。

## 附录 B：业务不变量与测试矩阵

| ID | 不变量 | 用例（`tests/batch-concurrency.test.ts`，除注明外） |
|---|---|---|
| B1 | 同时运行的账号数 ≤ `batchConcurrency` | 假 `collect.wait` 记录在途计数峰值 |
| B2 | 每个账号在整批中只被 `collect.start` 一次 | 记录 `collect.start` 调用的 accountId 列表，无重复、与 `runnable` 集合相等 |
| B3 | worker 按顺序取账号；`items` 数组顺序不变 | 断言取账号顺序与 `runnable` 顺序一致 |
| B4 | 阶段 1 仍串行且先于任何采集完成 | 探测期间 `collect.start` 调用数为 0；探测按顺序逐个进行 |
| B5 | `no_eligible_account`：全部被探测拦截时不启动任何采集 | 既有行为保留 |
| B6 | 批量运行中 `collect.start` 返回 `collect_busy`；重复 `collectAll.start` 返回 `collect_busy` | handler 层用例 |
| B7 | 取消：在途条目 `failed` / `collect_cancelled`，未开始条目 `failed` / `collect_cancelled`，批次 `failed` / `collect_cancelled`，取消后无新的 `collect.start` | 批次 signal 中途 abort |
| B8 | 熔断：第 2 个风控信号后，剩余未开始条目 `skipped` / `risk_paused`，`error = risk_paused`，有成功条目时批次 `partial`，否则 `failed`；运行中的条目正常结算 | 假采集按脚本返回 `session_expired` |
| B9 | 熔断不误触：单个风控信号、阶段 1 跳过任意数量、`ingest_failed`、`collect_failed`（其他原因）都不暂停 | 参数化用例 |
| B10 | 投影：`currentAccountId` 是 `runningAccountIds[0]`；`runningAccountIds` 按启动顺序；终态后为空数组与 null | 轮询 `status` 快照 |
| B11 | 错峰：worker k 的首取时刻 ≥ k × 3000 毫秒；相邻两次取账号间隔 ≥ 0；abort 后等待在 100 毫秒内结束 | 注入 `rand` 与 `sleep` 接缝 |
| B12 | Config：缺省 3；`0`、`6`、`2.5`、`'3'` 被 schema 拒绝；`1` 与 `5` 接受 | `Config.safeParse` |
| B13 | dispose：探测挂起、首个账号采集挂起、三个账号同时采集挂起时 dispose，全部在途调用收到 signal，后续不启动，批次 `failed`，信号清理 | `tests/lifecycle3.test.ts` 既有四条按并发重写并增一条三路挂起 |
| B14 | `runs.json`：三账号并发时每条 run 记录只写自己的 accountId / attemptId，终态全部落盘 | 假采集 + 临时状态目录 |

客户端（`tests/client/douyin-parity.test.tsx`）：

| ID | 断言 |
|---|---|
| B15 | `readBatchStatus` 读出 `runningAccountIds` / `concurrency`，缺失时为 `[]` / `0` |
| B16 | `batchReasonKey('risk_paused')` → `batch.reason.riskPaused` |
| B17 | 运行中面板显示「正在采集：A、B、C」与「3 路并发」；仅一个账号运行时显示它一个 |
| B18 | `error = risk_paused` 时显示暂停文案与剩余数，未完成账号列表里的 `risk_paused` 条目显示 `batch.reason.riskPaused` |

## 附录 C：风控分析与对策

### C.1 事实

- 18 个账号已经从同一 IP、同一台机器、同一个系统 Chrome、同样的最小启动参数（分册 15 §7 冻结：不引入自动化特征规避参数）访问创作者平台；平台把它们归为同一操作者是既有状态。
- 并发把单 IP 瞬时请求速率提高到约 3 倍。按每账号每 7.5–10 秒一个作品详情、每个详情十余个接口估算，3 路约每秒 4–5 个请求。
- 两个新增风险：worker 同时启动造成同步突发；平台临时限流或弹验证时，探测读不到资料会被判成会话过期（`src/session.ts` `readAccountProfile` 既有口径：读不到即 null，不猜测），本地与远端都把会话标为过期，下一轮批量会把这些账号当作 `session_required` 跳过，需要人工重新探测或扫码。串行时一次只波及 1 个账号，并发会一次波及 3 个、一轮波及全部。

### C.2 熔断规则

统计对象是阶段 2 采集的终态（`collect.wait` 结果），不含阶段 1 探测跳过的账号。

| 项 | 规则 |
|---|---|
| 风控信号 | `status = session_expired`（reason `session_invalid`：探测通过后采集途中 `status_code = 8`）；或 `status = collect_failed` 且 reason ∈ {`session_expired`, `probe_failed`}（`runCollection` 自带探测在批量探测通过后随即失败） |
| 阈值 | 同一批次内风控信号 ≥ 2 |
| 动作 | 剩余未开始条目 `skipped` / `risk_paused`；运行中的条目继续到自然结束；`error = risk_paused`；批次三态结算不变 |
| 不计入 | 阶段 1 的 `session_required` / `probe_failed` / `storage_state_missing` 跳过；`ingest_failed`；`collect_cancelled`；其他 `collect_failed` 原因 |

阈值 2 的依据：真实过期的账号在阶段 1 就被跳过；「刚通过探测、几十秒内失效」连续出现两次，说明问题在环境而不是账号。单次出现按账号自身处理。

### C.3 节奏

worker 启动间隔与取号间隔（附录 A.2）让三条采集链路不同相位。逐稿等待节奏不变。

### C.4 观察计划

发版后至少观察 3 轮完整批量、不少于 1 周。记录：整批耗时、并发峰值、风控信号条目数、熔断触发次数、批量结束 24 小时内需要重新探测或扫码的账号数。结论回填第 4 节，作为视频号是否镜像同一机制的依据。

## 附录 D：批量面板

位置与容器不变（账号管理栏内 `BatchPanel`，`AccountSidebar.tsx`）。变化：

| 状态 | 现状 | 变更 |
|---|---|---|
| 阶段 1 运行中 | 「正在检查会话 i/n」 | 不变 |
| 阶段 2 运行中 | 「第 i/n 个账号」+「当前账号 X」 | 「已完成 {done}/{total} 个账号」+「正在采集：A、B、C」+「{count} 路并发」 |
| 熔断结束 | 三态汇总 + 未完成账号列表 | 汇总行上方增加暂停提示行；未完成列表里 `risk_paused` 条目显示对应原因 |

昵称用 `nameOf(accountId)` 既有映射；三个以上名称在窄容器换行，不截断账号名。
