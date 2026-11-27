# workbench-采集前会话探测结果复用 实施单

状态：开发完成（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

前置：P0 的 [wx-collect-all-concurrency.md](wx-collect-all-concurrency.md) 与 [douyin-batch-candidates-live-probe.md](douyin-batch-candidates-live-probe.md) 已合入。

## 0. 背景与目标

### 0.1 现状

一次账号采集要打开同一个账号的 Chrome 持久化 Profile 三次：

| 入口 | 第 1 次 | 第 2 次 | 第 3 次 |
|---|---|---|---|
| 视频号 · 单账号「采集」 | `collect.start` 先调 `probeAndReport`（`src/handlers.ts`） | `runCollection` 内再调 `refreshSessionState`（`src/runner.ts`） | `launchChrome` 开始采集 |
| 视频号 · 「采集全部」 | 阶段 1 逐账号 `probeAndReport`（`src/collect-all.ts`） | 同上 | 同上 |
| 抖音 · 「采集全部」 | 阶段 1 `refreshSessionState`（`src/index.ts` 的 `probe` 回调） | `runCollection` 内再调 `refreshSessionState`（`src/runner.ts`） | `launchChromeSession` 开始采集 |
| 抖音 · 单账号「采集」 | 无前置探测 | `runCollection` 内 `refreshSessionState` | 同上 |

第 1 次与第 2 次探测之间只隔了一次 MCP 调用（远端账号自愈）和任务登记，实测间隔在秒级，两次结果相同。每次探测是一次完整的 Chrome 冷启动加页面导航，并各触发一次 `session_status_report` 上报（会话有效时每次探测都会把本地 `sessionSeq` 递增一次，所以两次上报的幂等键不同，服务端记两条）。

### 0.2 目标

同一次采集里，紧邻的两次探测合并为一次：前置探测的结果在有效期内直接交给采集流程使用。每账号每次采集少一次 Chrome 冷启动、少一次会话状态上报、少一次 `sessionSeq` 递增。会话在两次探测之间失效的情形仍由采集主流程里的身份复核兜住，安全语义不变。

## 1. 范围

做：

- 视频号、抖音的探测函数返回带时间戳的探测结果；
- 采集流程接受可选的「已探测会话」，在有效期内复用，否则照旧重新探测；
- 单账号入口与批量控制器把阶段 1 的探测结果传给采集流程；
- 抖音单账号入口不变（本来只有两次启动）。

不做：

- 不改探测的实现（`refreshSessionState` / `probeSession`）；
- 不改批量阶段 1 的串行探测与结算口径；
- 不把有效期做成插件 Config（它是一次采集内部的新鲜度窗口，不随部署环境变化）；
- 不改小红书（采集流程里没有前置探测）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。页面可见的 action 出参不变。

### 2.1 内部类型（视频号、抖音同形）

```ts
interface ProbedSession<S> {
  state: S                 // RefreshedSession
  reported: boolean        // 前置探测的上报是否成功
  probedAt: number         // Date.now()
}
```

### 2.2 有效期

`PROBE_REUSE_TTL_MS = 5 * 60 * 1000`。复用条件三项同时成立：调用方传入了探测结果；`state.sessionStatus === 'ok'`；`now - probedAt <= PROBE_REUSE_TTL_MS`。任一不成立则照旧调用 `refreshSessionState`。

批量场景里，阶段 2 的 worker 取号有启动错峰与取号间隔，账号多的批次靠后的账号可能超过有效期；这些账号自然回落到重新探测，行为与现状一致。

### 2.3 上报

复用探测结果时：`reported === true` → 跳过采集流程内的 `reportSessionStatus`；`reported === false` → 仍上报一次（把前置探测失败的上报补上）。不复用时照旧上报。

### 2.4 行为对照

| 场景 | 现状 | 变更 |
|---|---|---|
| 视频号单账号采集，探测与采集间隔 < 5 分钟 | 3 次启动、3 次上报（前置 1 + 流程内 1 + 终态 ok 1）、`sessionSeq` +2 | 2 次启动、2 次上报（前置 1 + 终态 ok 1）、`sessionSeq` +1 |
| 视频号「采集全部」，账号在取号后 5 分钟内开始采集 | 同上 | 同上 |
| 同上，账号超过 5 分钟才开始 | 3 次启动 | 3 次启动（回落，不变） |
| 抖音「采集全部」 | 同上两行 | 同上两行 |
| 抖音单账号采集 | 2 次启动 | 不变 |
| 探测有效、采集启动后身份复核失败 | `account_mismatch` 收尾（身份复核的细分原因），部分成果保留 | 不变（身份复核仍在采集主流程里） |
| 探测为 `expired` / `unknown` | 不启动采集 | 不变（只有 `ok` 的结果会被复用） |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | 视频号 `src/probe.ts` | `probeAndReport` 返回值增 `probe` | 是 | 探测结果带时间戳 |
| yootun-agent | 视频号 `src/runner.ts` `runCollection` | 新增可选入参 `probed`、`now`；按 2.2 / 2.3 复用 | 是 | 复用执行点 |
| yootun-agent | 视频号 `src/handlers.ts` `collect.start` | 把 `probeAndReport` 的结果传给 `runCollection` | 是 | 单账号入口 |
| yootun-agent | 视频号 `src/collect-all.ts`、`index.ts` | 阶段 1 保存每个账号的探测结果，阶段 2 经 `collect.start` 传入 | 是 | 批量入口 |
| yootun-agent | 抖音 `src/runner.ts` | `runCollection` 新增 `probed`、`now`；批量控制器 `createBatchCollectController` 的 `probe` 回调返回 `probe`，阶段 2 传入 | 是 | 复用执行点 |
| yootun-agent | 抖音 `src/index.ts` | `probe` 回调返回 `probe` | 是 | 批量入口 |
| yootun-agent | 视频号 `tests/{host,batch-concurrency,runs}.test.ts`、抖音 `tests/batch-concurrency.test.ts` | 新增用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/collect-probe-reuse`（基于 `feat/workbench-host-kit`） | 两包 test 与 build、`lint`、`typecheck`、四个 verify 脚本、`test:docs` 全过；附录 B U1–U9 全部落地 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] 视频号、抖音 `pnpm --filter <pkg> test`、`build` 通过；
- [ ] `pnpm run lint`；
- [ ] 附录 B 用例全部存在并通过，其中启动次数用例断言的是注入的假 `chromeFactory` 调用次数。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| Q1 | 视频号：单账号点「采集」，观察 Chrome 窗口闪现次数 | 采集前的探测窗口只出现 1 次，随后进入采集；比之前少闪一次 |
| Q2 | 视频号：「采集全部」，账号数 ≥ 4 | 同 Q1；批量汇总、跳过原因、熔断行为与之前一致 |
| Q3 | 抖音：「采集全部」 | 同 Q1 |
| Q4 | 任一工作台：探测通过后，在采集开始前于另一个浏览器登录该账号使其会话失效（或等待其过期） | 采集以「会话已失效」结束，已采集部分按既有口径保留，不出现串号数据 |
| Q5 | 网络中断状态下点「采集」 | 提示探测失败或会话需要重新登录；恢复网络后重试成功 |

### 5.3 本地联调记录

自动验收（独立子代理）通过，无必须修项。与实施单的出入及处理（单上文字随实现修订）：

- 附录 B U6「session_expired 收尾」：身份复核失败的实际细分原因是 `account_mismatch`（串号防线的可行动文案），U6 用例按实际断言，单上文字已修订；
- 附录 B U4「探测结果为 expired → 不启动采集，session_required」：该语义发生在页面路径（前置就绪检查先行拒绝，细分原因 `storage_state_missing`）；runCollection 层收到 expired 的 probed 会回落重新探测（实测可能恢复），用例改走页面路径断言拒绝与零启动；
- U2/U3 的上报计数含采集终态的 ok 上报（每账号 3 次：前置 1 + 重探测 1 + 终态 1），矩阵原文未计终态上报，用例按实际口径断言；
- U8 的「注入时钟」以构造即超 TTL 的 `probedAt` 等价实现（不引入批量控制器的时钟布线）；
- U9 以控制器层断言（douyin 包测试禁类型断言，无完整 body 假件）：批量阶段 2 启动携带 TTL 内的 `probed`；单账号页面路径不携带 `probed` 由 handlers 代码保证（不另设用例），启动次数行为由 wx 侧 U1–U3 的同类断言覆盖。
- 抖音「复用且 reported=false 时流程内补报」分支未单独立 douyin 用例（验收轮 2 建议项，部分采纳）：douyin runner 的该分支与 wx 逐字节平行（wx U5 覆盖且变异检查证实 wx 分支有守卫）；douyin 包测试禁类型断言使完整链路 Chrome 假件不可行，残留风险在此记录。

验收轮 1（独立子代理）发现并已修复：

- 视频号「采集全部」生产门面（index.ts）丢 `probed`——批量场景零复用，测试通过系测试基建 wireHost 自补透传行所致；已补透传行。「U7b 生产接线」用例在测试内照抄门面、未触及 index.ts，抓不住该行丢失；真正的接线回归是后续的工厂守卫（`createWxBatchFacade` 等，apply 与测试共用同一装配，见客户端工作台状态机单 5.3）；
- 三处悬空类型引用（wx runs.test 的 ProbedSession 导入源与 CollectResult 缺失、douyin batch-concurrency 的 RunnerDeps 导入被删）已修正；
- 补 U4b（runCollection 层 expired probed 回落重探测，3 次启动）覆盖复用条件要求 ok 的分支；
- 删除恒真的 U9b；2.4 与附录 B 的上报计数与身份复核措辞按实际行为修订；U8 冗余等待清理。

改动过的既有用例（均为单上写明的行为变化所致）：

- 视频号 dispose / batch-concurrency / profile-lock / runs 四文件的 Chrome factory 调用序：采集本体由「第 3 次启动」变为「第 2 次启动」（复用跳过流程内探测）；
- 视频号 runs.test「collect.status 合并内存与持久化」：探测复用后启动节奏加快，probing 进度的 runs.json 落盘改为显式等待后再断言；
- wireHost（batch-concurrency 测试基建）默认批量探测补传漏掉的 `locks` 位置参数（阶段 1 迁移遗留，默认路径未被既有用例触达）。

未核对项：真机验收 Q1–Q5；5.3 的「改动前后耗时各 3 次」实测（真机执行）。

## 附录 A：逐文件规格

### A1 视频号 `src/probe.ts`

`probeAndReport` 返回 `{ sessionStatus, reason, reported, probe: { state, reported, probedAt: Date.now() } }`。

### A2 视频号 `src/runner.ts` `runCollection`

- options 新增 `probed?: ProbedSession<RefreshedSession>`、`now?: () => number`；
- 第 1 步「会话探测」改为：

```ts
const now = options.now ?? Date.now
const reusable = options.probed !== undefined
  && options.probed.state.sessionStatus === 'ok'
  && now() - options.probed.probedAt <= PROBE_REUSE_TTL_MS
const session = reusable ? options.probed.state : await refreshSessionState({ accountId, root, chromeFactory })
if (!reusable || options.probed.reported !== true) await reportSessionStatus(options.workbench, accountId, session)
```

- 其余步骤不变；`session.sessionStatus !== 'ok'` 的分支保留（复用路径不会进入，作为防御）。

### A3 视频号入口

- `handlers.ts` `collect.start`：`probeAndReport` 的结果在 `sessionStatus === 'ok'` 时以 `probed` 传给 `runCollection`；
- `collect-all.ts`：阶段 1 每个 `options.probe(accountId)` 的返回值存入控制器内的 `Map<accountId, ProbedSession>`；阶段 2 调 `collect.start` 时经 options 传入；批次结束后清空。

### A4 抖音

- `runner.ts` `runCollection`：同 A2（`reportSessionStatus(deps, accountId, session, signal)` 返回 `{ ok, error }`，复用且 `reported` 为真时跳过，并跳过对应的 `session_report_failed` 事件）；
- `createBatchCollectController` 的 `probe` 回调返回类型增 `probe`；阶段 2 `collect.start({ accountId, options: { probed } })`；
- `src/index.ts` 的 `probe` 回调把 `report.ok` 写进 `probe.reported`。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| U1 | 单账号：传入了 5 分钟内的 `ok` 探测结果 → `chromeFactory` 调用 2 次（探测 1 + 采集 1）；本体启动时刻的上报计数为 1（只有前置探测；终态 ok 上报不在该快照内） |
| U2 | 单账号：不传 `probed` → `chromeFactory` 调用 3 次（现状回归） |
| U3 | 探测结果超过 5 分钟（注入时钟）→ 重新探测，`chromeFactory` 调用 3 次 |
| U4 | 前置探测为 `expired` → 页面路径拒绝启动采集（就绪检查先行，细分 `storage_state_missing`）；runCollection 层收到 expired 的 probed 回落重新探测（实测可能恢复） |
| U5 | 复用且 `reported === false` → 采集流程内补一次上报 |
| U6 | 复用后采集主流程身份复核失败 → 以 `account_mismatch` 收尾（身份复核的细分原因），部分成果保留 |
| U7 | 批量：阶段 1 的每个 `ok` 账号在阶段 2 只再启动 1 次 Chrome；阶段 1 的上报次数等于账号数 |
| U8 | 批量：注入时钟使靠后的账号超过有效期 → 该账号回落为重新探测，其余仍复用 |
| U9 | 抖音批量：阶段 1 的探测结果随阶段 2 启动传入（`options.probed`，TTL 内新鲜）；单账号页面路径不传 `probed` 由 handlers 代码保证（不另设用例） |
