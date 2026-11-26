# workbench-挂载恢复、登录终态与中断提示对齐 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

前置：P0 全部合入（[wx-collect-all-concurrency.md](wx-collect-all-concurrency.md) 给视频号补了挂载恢复，[xhs-collect-cancel-and-publish-state.md](xhs-collect-cancel-and-publish-state.md) 给小红书补了取消）。

## 0. 背景与目标

### 0.1 现状

四个彼此相关的不一致：

1. **小红书没有挂载恢复。** `collect.status` 只接受 `collectId`（`yootun/plugins/dsh-xhs-workbench/src/handlers.ts`），而 `collectId` 只存在页面组件的内存里。应用重启或页面重载后，Host 里仍在跑的采集无法被重新找到：账号卡片不显示进行中，「采集」按钮可再点一次并得到 `PROFILE_BUSY`，采集结束后也没有任何提示。抖音与视频号在挂载时会按账号查询运行中的采集并恢复轮询。
2. **登录终态记录的保留策略三种。** 抖音与小红书是「读完即删」（`account.loginStatus` 读到终态就 `delete`），视频号是 30 分钟过期、但只在下一次 `beginLogin` 时顺带清理。读完即删在两次并发轮询、或页面在登录完成后立刻重载时，第二次读到 `idle`，登录卡片被静默清掉而没有结果提示。
3. **视频号有一个没有入口的 action。** `account.refreshLoginQr`（`src/handlers.ts`、`src/route.ts`、`tests/host.test.ts` 的 allowlist）在页面上没有任何调用方，词典里的 `login.refreshQr` 也没有使用处。它的成功分支只更新内存记录，不做 `workbench_wx_account_save`，也不做会话状态上报——与 `beginLogin` 的成功分支不一致。一旦被接入，经它完成的登录不会在远端建号。
4. **采集中断只有一条会消失的提示。** 抖音与视频号在挂载恢复发现上次采集被中断时弹一条 toast（「上次采集被中断，建议重新采集」），没有任何操作入口；批量采集被中断时也一样，用户要自己去账号栏再点一次「采集全部」。

### 0.2 目标

三个工作台在「重开页面后能看到什么」上一致：运行中的采集可恢复；登录终态在一段时间内可重复读取；中断提示带操作入口。视频号的孤立 action 定去留。

## 1. 范围

做：

- 小红书 `collect.status` 支持按账号查询，页面挂载时恢复运行中的采集；
- 小红书采集运行记录增加终态保留与清理（当前只增不删）；
- 三工作台登录终态记录统一为「保留 30 分钟，读取时顺带清理，卸载时清空」；
- 删除视频号 `account.refreshLoginQr` 与孤立词典键；
- 抖音、视频号：采集中断由 toast 改为页面内横幅，带「重新采集」与「重新采集全部」。

不做：

- 不做跨进程恢复运行中的采集（Host 重启后任务已不存在，维持「提示被中断」的口径）；
- 不给小红书增加「采集全部」（未排期）；
- 不改登录流程本身（扫码、超时、临时 Profile 迁移）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 小红书 `collect.status`

| 项 | 现状 | 变更 |
|---|---|---|
| 入参 | `collectId`（≤128） | `collectId`（≤128）或 `accountId`（≤128），二者至少一个；都给时以 `collectId` 为准 |
| 按 `collectId` | 返回该 run | 不变 |
| 按 `accountId` | 不支持 | 返回该账号最近一条 run：有运行中的返回运行中的；否则返回最近结束且仍在保留期内的；都没有返回 `collect: null` |
| 两者都缺 | `collect_id_required` | 不变 |

小红书 action 数量不变（P0 之后为 30 项）。

### 2.2 小红书采集记录的保留

- 终态记录（`completed` / `failed` / `cancelled`）保留 30 分钟，之后在下一次 `collect.start` 或 `collect.status` 时清理；
- `disposeHostTasks` 清空 `collectRuns` 与 `collectIdempotency`；
- 每个账号维护「最近一条 run」的索引，供 2.1 的按账号查询使用。

### 2.3 登录终态记录（三工作台统一）

| 规则 | 内容 |
|---|---|
| 保留时长 | 终态记录自进入终态起保留 30 分钟（`LOGIN_RECORD_TTL_MS`，视频号已有同名常量） |
| 清理时机 | 每次 `account.loginStatus` 与 `account.beginLogin` 处理前，清理已过期的终态记录；不依赖定时器 |
| 卸载 | `disposeHostTasks` 清空登录记录表 |
| 小红书占位映射 | pending 键与 resolvedId 指向同一条记录时，两者同时清理 |
| `idle` 的含义 | 只在「没有记录或记录已过期」时返回 |

### 2.4 视频号 action 清单

删除 `account.refreshLoginQr`：路由 allowlist、handler、`tests/host.test.ts` 的 action 清单各去掉一项（P0 之后 23 → 22）。`refresh_not_allowed` 随之不再出现。删除依据 [cross-repo-sync.md](../../cross-repo-sync.md) 第三节「删除 / 重命名工具」的顺序：该 action 从未有页面调用方，不存在旧客户端依赖。

### 2.5 中断横幅（抖音、视频号）

Host：

- `recoverInterruptedRuns(root)` 的返回值由数量改为 `{ count, accountIds }`；
- Host 依赖里保存启动时的中断摘要 `startupInterruption`；`collect.status` 与 `collectAll.status` 的出参增加 `interrupted: { count: number; accountIds: string[] } | null`；
- 摘要在下一次 `collect.start` 或 `collectAll.start` 成功启动后置空（不再返回）；不做单独的「已读」action。

页面：

| 条件 | 显示 |
|---|---|
| `interrupted` 非空 | 作品面板顶部横幅：「上次采集被中断（N 个账号）」，右侧按钮 |
| 选中账号在 `accountIds` 内 | 按钮「重新采集」 |
| `count >= 2` | 按钮「重新采集全部」 |
| 始终 | 关闭按钮（只隐藏本次页面会话内的横幅；Host 的摘要在下一次采集启动前仍在） |

原 toast「上次采集被中断，建议重新采集」在横幅出现时不再弹。

### 2.6 词典新增

| 插件 | 键 | zh | en |
|---|---|---|---|
| 抖音、视频号 | `run.interruptedBanner` | 上次采集被中断（{count} 个账号） | The last collection was interrupted ({count} accounts) |
| 抖音、视频号 | `run.interruptedBannerOne` | 上次采集被中断 | The last collection was interrupted |
| 抖音、视频号 | `run.recollect` | 重新采集 | Collect again |
| 抖音、视频号 | `run.recollectAll` | 重新采集全部 | Collect all again |
| 抖音、视频号 | `run.dismissBanner` | 关闭提示 | Dismiss |

小红书不新增文案：恢复后账号卡直接显示「采集中」与进度（既有词条）。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | 小红书 `src/route.ts` | `collect.status` 入参 | 是 | 按账号查询 |
| yootun-agent | 小红书 `src/handlers.ts` | 按账号查询、最近 run 索引、终态保留与清理、登录记录保留 | 是 | 本单主体 |
| yootun-agent | 小红书 `src/lifecycle.ts` | 卸载时清空采集与登录记录表 | 是 | 记录有生命周期 |
| yootun-agent | 小红书 `src/client/{accounts-machine.ts,AccountsPage.tsx,locales.ts}`、`src/client/api.ts` | 挂载时按账号查询并恢复轮询；文案 | 是 | 页面恢复 |
| yootun-agent | 抖音 `src/handlers.ts`、`src/lifecycle.ts` | 登录记录保留 30 分钟与读取时清理；中断摘要；`collect.status` / `collectAll.status` 出参 | 是 | 对齐 |
| yootun-agent | 视频号 `src/{handlers,route,lifecycle}.ts` | 删除 `account.refreshLoginQr`；登录记录读取时清理；中断摘要与出参 | 是 | 对齐 |
| yootun-agent | 抖音、视频号 `src/runs.ts` | `recoverInterruptedRuns` 返回账号列表 | 是 | 横幅的操作范围 |
| yootun-agent | 抖音、视频号 `src/client/{WorkbenchPage.tsx,WorksPanel.tsx,locales.ts,workbench.module.css}` | 横幅与按钮；移除对应 toast | 是 | 中断后的操作入口 |
| yootun-agent | 视频号 `src/client/locales.ts` | 删除 `login.refreshQr`（zh / en） | 是 | 孤立词典键 |
| yootun-agent | 抖音、视频号、小红书 `tests/{host,dispose,runs,lifecycle*}.test.ts`、`tests/client/*` | 用例更新与新增 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/p2-wx-workbench-baseline.md` §1、`p3-xhs-workbench-baseline.md` §8、`p4-douyin-workbench-baseline.md` §11 | 登记 action 删除与登录终态保留的偏离 | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1110/09-workbench-migration-plan.md` §5.3 | 视频号 action 清单去掉一项 | 是 | 清单记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 三份基线 + 09 册 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/mount-restore-login-alignment` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] 三插件 `pnpm --filter <pkg> test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] `grep -rn "refreshLoginQr\|login.refreshQr" yootun/plugins/dsh-wx-channels-workbench/src` 结果为空；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| R1 | 小红书：对某账号点「采集笔记」，采集进行中切到「爆款仿写」Tab 再切回 | 账号卡保持「采集中」与进度，不重复启动 |
| R2 | 小红书：采集进行中重载页面 | 重新显示进行中与进度，结束后提示结果 |
| R3 | 小红书：采集进行中退出应用重开 | 不显示进行中；「采集」按钮可点，不报「占用中」 |
| R4 | 任一工作台：扫码登录成功后立刻重载页面 | 账号列表包含新账号；登录卡片不再出现；没有「卡片消失但账号没加上」的情况 |
| R5 | 抖音、视频号：采集（单账号）进行中退出应用重开 | 作品面板顶部出现横幅「上次采集被中断」，带「重新采集」与关闭；点「重新采集」直接开始该账号采集 |
| R6 | 抖音、视频号：「采集全部」进行中（至少 2 个账号已开始）退出应用重开 | 横幅显示账号数，带「重新采集全部」；点击后开始新一轮批量 |
| R7 | 点横幅的关闭按钮 | 横幅消失；下一次成功启动采集后不再出现 |
| R8 | 视频号：扫码登录全程 | 行为与之前一致（没有「刷新二维码」入口，Chrome 窗口内可自行刷新二维码） |

### 5.3 本地联调记录

待填（合入前回填）。

## 附录 A：逐文件规格

### A1 小红书 Host

- `deps` 增加 `collectLatestByAccount: Map<string, string>`（账号 → 最近一条 run 的 `collectId`），在 `collect.start` 创建 run 时写入；
- `collect.status`：`accountId` 分支取最近 run；run 不存在或已清理 → `collect: null`；
- 清理函数 `sweepCollectRuns(now)`：删除进入终态超过 30 分钟的 run、其幂等映射与账号索引（索引只在仍指向该 run 时删除）；在 `collect.start` 与 `collect.status` 入口调用；
- 登录记录：新增 `sweepLoginRuns(now)`，在 `account.loginStatus` 与 `account.beginLogin` 入口调用；`account.loginStatus` 不再读完即删；
- `disposeHostTasks`：现有清空信号表之后增加清空 `loginRuns`、`collectRuns`、`collectIdempotency`、`collectLatestByAccount`。

### A2 小红书 client

- `api.ts` / machine ports：`collectStatus` 接受 `{ collectId } | { accountId }`；
- `accounts-machine.ts` `init()`：账号列表就绪且 `selectedId` 确定后调用一次 `collectStatus({ accountId: selectedId })`，带代次守卫（用户已点「采集」则丢弃该响应）；返回 `collectStatus === 'running'` → 写入 `state.collect` 并启动轮询；
- 选中账号切换时不对历史账号做恢复查询（运行中的采集在同一时刻至多一个：`anyRunning` 已禁用其他按钮）。

### A3 抖音、视频号登录记录

- 抖音 `account.loginStatus`：删除 `if (run.status !== 'waiting') deps.loginRuns.delete(run.key)`，改为处理前调用 `sweepLoginRuns`；
- 视频号 `account.beginLogin` 里现有的过期清理提取为 `sweepLoginRuns(deps, nowMs)`，`account.loginStatus` 也调用；
- 两插件的 `disposeHostTasks` 清空登录记录表与登录信号表。

### A4 中断摘要（抖音、视频号）

- `runs.ts` `recoverInterruptedRuns`：收集本次被标记为 `interrupted` 的 `accountId`（去重），返回 `{ count, accountIds }`；调用方（抖音是 `handlers.ts` 的启动恢复接缝，视频号是 `index.ts`）把结果写入 `deps.startupInterruption`；
- `handlers.ts`：`collect.status`、`collectAll.status` 出参加 `interrupted`（为空时省略键）；`collect.start` 与 `collectAll.start` 在 `started === true` 时置 `deps.startupInterruption = null`；
- client：`readCollectStatus` / `readBatchStatus` 读取 `interrupted`；横幅组件渲染在作品面板顶部；关闭状态存于页面状态机（[client-workbench-hooks.md](client-workbench-hooks.md) 落地后存于 machine）；移除 `recovery === 'recovery_required'` 分支里的 `notify(t('run.interrupted'))`。

### A5 视频号删除项

- `route.ts` `ACTION_SCHEMAS`、`handlers.ts` 的 `'account.refreshLoginQr'`、`tests/host.test.ts` 第 29 行清单、`client/locales.ts` 的 `login.refreshQr`（zh / en）。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| X1 | 小红书 `collect.status({ accountId })`：运行中 → 返回该 run；只有终态且在保留期内 → 返回终态 run；无 → `collect: null` |
| X2 | 小红书 `collect.status` 两者都缺 → `collect_id_required`；同时给且不一致 → 以 `collectId` 为准 |
| X3 | 小红书：终态 run 30 分钟后（注入时钟）在下一次 `collect.start` / `collect.status` 被清理，账号索引同步清理；运行中的不被清理 |
| X4 | 小红书：同一账号先后两次采集，按账号查询返回后一次 |
| X5 | 小红书 dispose 后 `collectRuns` / `collectIdempotency` 为空 |
| X6 | 小红书 client：挂载时 Host 返回 `running` → 进入运行态并按 `collectId` 轮询；返回终态或 `null` → 不进入运行态 |
| X7 | 小红书 client：恢复响应到达前用户已点「采集」→ 恢复结果丢弃 |
| L1 | 三插件：登录终态记录在 30 分钟内重复读取结果一致（不再读完即删） |
| L2 | 三插件：超过 30 分钟的终态记录在下一次读取时被清理，返回 `idle` |
| L3 | 三插件：dispose 后登录记录表为空 |
| L4 | 小红书：pending 键与 resolvedId 的映射同时清理 |
| W1 | 视频号：action 清单为删除后的集合，`account.refreshLoginQr` → `unknown_action` |
| I1 | `recoverInterruptedRuns` 返回 `{ count, accountIds }`，账号去重 |
| I2 | `collect.status` / `collectAll.status` 带中断摘要；下一次成功启动后不再带 |
| I3 | client：`interrupted` 非空 → 横幅出现、toast 不弹；选中账号在列表内 → 显示「重新采集」；`count >= 2` → 显示「重新采集全部」 |
| I4 | client：点「重新采集」调用与账号栏「采集」相同的启动路径；点关闭后横幅消失 |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 视频号 `refreshLoginQr` | 删除（无调用方、成功分支缺远端建号） | 接入登录卡片并补齐完成逻辑（新增一个与 Chrome 窗口内刷新重复的入口） |
| 登录终态保留 | 30 分钟 + 读取时清理（沿用视频号常量） | 10 分钟；或定时器清理 |
| 中断提示 | 页面内横幅 + 操作按钮 | 保留 toast 并加「重新采集」动作按钮 |
| 横幅关闭的持久化 | 仅当前页面会话 | 写入本地存储（跨重载保持关闭） |
