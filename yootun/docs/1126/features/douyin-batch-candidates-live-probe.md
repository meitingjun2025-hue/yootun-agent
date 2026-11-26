# douyin-workbench-采集全部候选实测 实施单

状态：已合入 `main`（2026-11-26，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现象

「采集全部」的候选筛选 `batchCandidates`（`yootun/plugins/dsh-douyin-workbench/src/runner.ts`）按本地缓存的会话状态预筛：`sessionStatus !== 'ok'` 的账号直接标 `skipped / session_required`，不进入批量阶段 1 的实测。而会话探测对 `unknown` 结果只更新 `checkedAt`、不改状态，所以一次探测异常（例如当时 Chrome 未就绪）之后，该账号在每一轮「采集全部」里都被跳过，面板上显示的原因是「需要登录」——与事实不符，用户会去重新扫码。

### 0.2 目标

候选阶段只跳过两类确定不可采的账号：登录占位（`pending-`）与本地凭证缺失（无 storage_state）。其余账号一律进入阶段 1 实测，由实测结果决定 `skipped` 的原因。单账号采集路径不变。

## 1. 范围

做：

- `batchCandidates` 的筛选条件改为只看 `pending-` 与 storage_state；
- 测试补「缓存 `unknown` / `expired` 账号进入阶段 1 并按实测结果结算」的用例；
- 顺带修正抖音包内 action 计数注释（`package.json` description 与 `src/index.ts` 头注释 56 → 57，纯注释）。

不做：

- 不改阶段 1 的探测实现与串行语义；
- 不改 `collectAll.status` 出参；
- 不改视频号工作台（其批量控制器没有预筛，候选来自 `accounts.json` 全量）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 `collectAll.start` 行为变化

| 场景 | 现状 | 变更 |
|---|---|---|
| 账号缓存状态 `unknown` | 候选阶段 `skipped / session_required` | 进入阶段 1 实测；实测 `ok` → 采集；`expired` → `skipped / session_required`；`unknown` → `skipped / probe_failed` |
| 账号缓存状态 `expired` | 候选阶段 `skipped / session_required` | 同上（重新登录会改回 `ok`，此处只影响缓存与实际不一致的情况） |
| `pending-` 占位账号 | `skipped / pending_account` | 不变 |
| 无 storage_state | `skipped / storage_state_missing` | 不变 |

### 2.2 稳定码

无新增。`session_required`、`probe_failed` 为既有取值。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无工具变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/runner.ts` `batchCandidates` | 筛选条件 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/batch-concurrency.test.ts` | 新增用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/package.json`、`src/index.ts` | action 计数注释 56 → 57 | 是 | 文档漂移顺带修正 |
| yootun-agent | `yootun/docs/1110/p4-douyin-workbench-baseline.md` §11 | 登记「候选不再按缓存状态预筛」 | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 15 册 §11 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-26 | `feat/douyin-batch-candidates-live-probe`（自 `main` 切出） | 包内 `test`（node --test 18 文件 215 用例、vitest 151 用例）、`build`、`pnpm run lint` 通过，验收独立复跑结果一致；真机验收见 5.2 |
| yootun-agent 合入 `main` | 2026-11-26 | `main` | 随 P0 八张批次一并合入（顶点分支 `feat/activation-gate-and-model-catalog`，合并无冲突），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过；
- [ ] 附录 A.2 的用例存在并通过；
- [ ] `pnpm run lint` 对改动文件无新告警。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| R1 | 准备一个缓存状态为 `unknown` 的账号（例如断网状态下点过一次「采集」后恢复网络），点「采集全部」 | 该账号出现在「正在检查会话」序列中；实测通过后进入采集；实测失败时原因显示为「探测失败」而不是「需要登录」 |
| R2 | 准备一个缓存 `ok` 但实际已过期的账号，点「采集全部」 | 该账号被标 `skipped / session_required`（与现状一致） |
| R3 | 其余账号的批量行为与 [douyin-collect-all-concurrency.md](../../1125/features/douyin-collect-all-concurrency.md) 5.2 的 R1–R5 一致 | 并发、熔断、取消语义不变 |

### 5.3 本地联调记录

待填（合入前回填）。

## 附录 A：逐文件规格

### A1 `src/runner.ts` `batchCandidates`

- 循环内只保留两个 `skipped` 分支：`isPendingAccountId(record.accountId)` → `pending_account`；`!(await hasStorageState(...))` → `storage_state_missing`；
- 删除 `record.sessionStatus !== 'ok'` 分支；
- 其余账号 `{ skipped: false, reason: null }`；abort 检查点保持原位；
- 函数头注释改为「缓存口径只排除确定不可采的账号；会话有效性一律由阶段 1 实测决定」。

### A2 `tests/batch-concurrency.test.ts`

| ID | 断言 |
|---|---|
| C1 | 本地三个账号：`unknown`、`expired`、`ok`，均有 storage_state → 三者均 `skipped: false` |
| C2 | `pending-` 账号 → `skipped / pending_account`；无 storage_state → `skipped / storage_state_missing` |
| C3 | `unknown` 账号进入阶段 1：probe 返回 `ok` → `ready` → 被采集；probe 返回 `unknown` → `skipped / probe_failed`；probe 返回 `expired` → `skipped / session_required` |
| C4 | 全部账号被实测拦截 → 批次 `failed / no_eligible_account`（既有行为，回归） |

### A3 文档

- `package.json` description 与 `src/index.ts` 头注释中的「56 个 action」「56 项」改为 57（`collect.running` 已于 2026-11-25 加入）；
- 15 册 §11 缺口与观察清单追加一条：候选筛选改为实测（2026-11-26）。
