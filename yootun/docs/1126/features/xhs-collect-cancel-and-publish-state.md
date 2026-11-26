# xhs-workbench-采集取消与发布窗口状态 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

- 小红书账号管理的笔记采集只有 `collect.start` 与 `collect.status` 两个 action：采集一旦发起只能等它结束，抖音与视频号都有 `collect.cancel`。
- 「打开创作者中心」会在有头 Chrome 里打开发布页，浏览器保持打开，该账号的 profile 锁随窗口关闭才释放。窗口未关时，该账号的登录 / 探测 / 采集 / 移除全部返回 `PROFILE_BUSY`，但账号卡片上没有任何「发布窗口打开中」的标识，用户不知道原因。

### 0.2 目标

采集可取消，取消落 `cancelled` 终态且不写入本次快照；账号列表投影发布窗口状态，账号卡显示标识与说明。

## 1. 范围

做：

- 新增 Host action `collect.cancel`；
- `CollectRun.status` 增 `cancelled`，取消时不写快照，页面提示「已取消，未保存本次采集」；
- `accounts.list` 增 `publishWindowOpen`；
- 账号卡显示「发布窗口打开中」状态点；采集运行中按钮变为「取消」。

不做：

- 不做远端删除账号（小红书账号只有本地凭证，远端无账号实体）；
- 不改发布流程本身（仍由用户在浏览器手动发布）；
- 不做「关闭发布窗口」的远程操作（用户自行关闭浏览器窗口）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 新增 action `collect.cancel`

| 项 | 内容 |
|---|---|
| 入参 | `collectId`（string，≤128，必填） |
| 出参 | `{ status: 'ready', collect: { collectStatus: 'cancelled' \| 'completed' \| 'failed', ... } }`；取消成功时 `collectStatus === 'cancelled'` |
| 终态后再取消 | `{ status: 'ready', collect }`，`collectStatus` 为既有终态，不改写 |
| 未知 collectId | `{ status: 'error', reason: 'collect_id_required' }`（与 `collect.status` 同口径） |
| 效果 | abort 该 run 的 controller；run 落 `cancelled`、`error = 'collect_cancelled'`；锁在既有 finally 释放 |

小红书 Host action 由 29 项变 30 项；09 册 §5.3 的 action 分组同步。

### 2.2 `collect.status` / `collect.start` 投影

`collectStatus` 取值增 `cancelled`；新增本地码 `collect_cancelled`（`src/errors.ts` `STABLE_ERROR_CODES`）。

### 2.3 `accounts.list`

| 字段 | 类型 | 说明 |
|---|---|---|
| `publishWindowOpen` | boolean | 该账号存在 `status === 'running'` 的发布 run（浏览器窗口仍打开）；新增，缺省 `false` |

### 2.4 词典新增（`src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `collect.cancel` | 取消采集 | Cancel collection |
| `collect.cancelled` | 已取消，未保存本次采集 | Cancelled, this collection was not saved |
| `reason.collect_cancelled` | 采集已取消 | Collection cancelled |
| `account.publishWindowOpen` | 发布窗口打开中 | Publish window open |
| `account.publishWindowHint` | 该账号的浏览器发布页仍打开；关闭后可继续登录、探测、采集或移除 | The publish page is still open for this account; close it to sign in, probe, collect or remove |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无工具变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/route.ts` | `collect.cancel` schema；action 计数注释 | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/handlers.ts` | `CollectRun.status` 增 `cancelled`；`collect.start` 的 catch 分支；`collect.cancel` handler；`accounts.list` 投影 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/errors.ts` | `collect_cancelled` | 是 | 稳定码白名单 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/client/accounts-machine.ts` | `cancelCollect` 端口、`cancelled` 终态处理、`publishWindowOpen` 读取 | 是 | 页面状态机 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/client/{AccountsPage.tsx,locales.ts}` | 取消按钮、取消提示、发布窗口标识 | 是 | 页面 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/tests/{host,route}.test.ts`、`tests/client/*` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/12-xhs-workbench-ui-layout-parity.md` §4、`09-workbench-migration-plan.md` §5.3 | 取消与窗口状态条款；action 分组 | 是 | 布局与契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

与 [host-lifecycle-budget.md](host-lifecycle-budget.md) 的关系：两单都改小红书 `handlers.ts`（本单改 `collect.start` 的 catch 与 `accounts.list`，生命周期单改 `publish.start`），改动点不重叠；后合入者按 5.3 预演解决文本冲突。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 12 册 §4 + 09 册 §5.3 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/xhs-collect-cancel-and-publish-state` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-xhs-workbench test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| X1 | 账号管理页点「采集」，进度出现后点「取消」 | 按钮恢复；提示「已取消，未保存本次采集」；账号可再次采集，不报占用 |
| X2 | 采集正常结束后点「取消」（按钮应已不可点） | 无请求发出 |
| X3 | 点「打开创作者中心」，回到账号管理页 | 该账号卡片显示「发布窗口打开中」标识与说明；此时点「采集」提示占用 |
| X4 | 关闭浏览器窗口后刷新账号列表 | 标识消失；采集可用 |
| X5 | 明暗主题、三档宽度 | 标识与按钮完整可读 |

### 5.3 本地联调记录

- 开发完成：2026-11-26，分支 `feat/xhs-collect-cancel-and-publish-state`（自生命周期单分支切出，两单改动点不重叠，无文本冲突）。
- 与 [host-lifecycle-budget.md](host-lifecycle-budget.md) 的叠加：本单在其之后实施，`collect.start` 的取消判定加在该单建立的 `deps.taskRegistry.track(...)` 登记与 `launchTimeoutMs` / `browserCloseTimeoutMs` / `trackCleanup` 透传之后（`then`/`catch`/`finally` 链原样保留）；登记与预算透传未动。
- 行为叠加说明：dispose 与 `collect.cancel` 共用同一取消判定口径（`controller.signal.aborted === true` → `cancelled / collect_cancelled`），dispose 中途 abort 的采集 run 由旧 `failed(collect_aborted)` 变为 `cancelled(collect_cancelled)`，`tests/dispose.test.ts` 对应用例已随行为更新。
- 自动验收（2026-11-26）：`pnpm --filter @yootun/dsh-xhs-workbench test` 通过（node --test 七个文件 45/13/22/3/7/16/15 全绿 + vitest 4 文件 33 用例）、`build` 通过；仓库根 `pnpm run lint`、`typecheck`、`verify-client-ui-i18n`、`verify-export-jsdoc`、`verify-empty-catch`、`test:docs`、`git diff --check` 全部通过。附录 B 用例对照：XH1→host.test.ts「action allowlist：白名单 30 项…（XH1）」；XH2→host.test.ts「collect.cancel：运行中取消落 cancelled/collect_cancelled…（XH2）」与「collect.cancel：取消时不写本次快照…（XH2）」；XH3→host.test.ts「collect.cancel：终态后取消不改写…（XH3）」；XH4→host.test.ts「collect.start：会话失效收敛 SESSION_EXPIRED…（XH4…）」；XH5→host.test.ts「accounts.list：running 发布 run 投影 publishWindowOpen…（XH5）」；XC1→xhs-accounts.test.tsx「采集运行中按钮变「取消采集」…（XC1）」与「采集自然结束后按钮回「采集」…（XC1/X2）」；XC2→xhs-accounts.test.tsx「publishWindowOpen 账号卡显示…（XC2）」；XC3→xhs-page.test.tsx「en 与 zh 键集完全一致」+ xhs-bundle.test.ts「REASON_KEYS 覆盖 Host STABLE_ERROR_CODES 全集」。

## 附录 A：逐文件规格

### A1 `src/handlers.ts`

- `CollectRun.status: 'running' | 'completed' | 'failed' | 'cancelled'`；
- `collect.start` 的 `.catch`：`controller.signal.aborted === true` → `run.status = 'cancelled'`、`run.error = 'collect_cancelled'`；其余分支不变；`.finally` 不变（释放锁、清理 signal）；
- 新增 `'collect.cancel'`：按 `collectId` 取 run；不存在 → `{ status: 'error', reason: 'collect_id_required' }`；`running` → `controller.abort()`，返回 `{ status: 'ready', collect: projectCollect(run) }`（投影时 `collectStatus` 已是 `cancelled`，abort 后的 catch 同步执行前可能仍为 `running`：handler 在 abort 后直接置 `cancelled` / `collect_cancelled`，catch 分支对已是 `cancelled` 的记录不再改写）；终态 → 原样返回；
- `accounts.list`：`const openAccounts = new Set([...deps.publishRuns.values()].filter(run => run.status === 'running').map(run => run.accountId))`；每条账号 `publishWindowOpen: openAccounts.has(record.accountId)`。

### A2 `src/route.ts`

- `ACTION_SCHEMAS['collect.cancel'] = { fields: { collectId: 'string' }, limits: { collectId: 128 } }`；
- 头注释的 action 计数与分组同步。

### A3 `src/client/accounts-machine.ts` / `AccountsPage.tsx`

- 端口 `cancelCollect: (collectId) => hostAction('collect.cancel', { collectId })`；
- `collectStatus === 'cancelled'` 为终态：停止轮询、toast `collect.cancelled`、刷新账号摘要（快照未变）；
- 账号卡：`publishWindowOpen === true` 时在会话徽标旁显示 `StateDot state="warning"` + `account.publishWindowOpen`，`title` 走词典 `account.publishWindowHint`（本单先用 `title`，统一改 Tooltip 见 P1 可达性单）；
- 采集按钮：运行中显示「取消采集」。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| XH1 | action 清单含 `collect.cancel`（30 项） |
| XH2 | 运行中取消：run 落 `cancelled / collect_cancelled`，锁释放，`collect.status` 返回 `cancelled` |
| XH3 | 终态后取消：不改写；未知 id → `collect_id_required` |
| XH4 | 采集自然失败（非取消）仍为 `failed`，不被误判为取消 |
| XH5 | `accounts.list`：有 running 发布 run 的账号 `publishWindowOpen === true`，其余 `false` |
| XC1 | 页面：运行中显示「取消采集」，点击调用 `collect.cancel`，收到 `cancelled` 后停止轮询并提示 |
| XC2 | 页面：`publishWindowOpen` 账号卡显示标识 |
| XC3 | 词典 zh / en 键集一致 |
