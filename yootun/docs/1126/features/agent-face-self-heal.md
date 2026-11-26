# managed-mcp-Agent 面自愈与连接状态可见 实施单

状态：已合入 `main`（2026-11-26，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

`@yootun/dsh-managed-mcp` 的监督器（`src/supervisor.ts`）只在两类事件时重新评估门禁并挂载 / 重建 Agent 面 client：`yootun-access` 设置变更、`MODELS_API_KEY` 凭证变更；重建条件是「凭证变更」或「评估时发现状态为 `failed`」。官方 `dsh-mcp-client` 的重连策略（500ms 起倍增、30 秒封顶、10 次）耗尽后状态落 `failed`，此时若没有任何门禁事件，Agent 面会一直缺失，普通会话里的模型看不到 `yootun_*` 工具，用户只看到「模型说没有这个工具」。

另一个面：设置页「Yootun 接入」区块只显示激活状态与当前模型，不显示 Agent 面是否已连上、是否在重连。

### 0.2 目标

重连耗尽后无需任何外部事件即可按退避自愈；设置页可见 Agent 面连接状态，并给出下一步（等待 / 重新激活 / 重启应用）。

## 1. 范围

做：

- 监督器订阅 `McpConnectionStatusHandle.onChange`：`failed` → 按退避调度重建（基值 30 秒、倍增、上限 5 分钟、抖动 ±20%），`connected` → 复位退避；dispose 清除定时器与订阅；
- 新增只读同源路由 `POST /api/desktop/yootun/agent-status`，返回 Agent 面连接状态；
- `@yootun/dsh-client-ui-access` 设置区块增加「智能体工具」一行：状态点 + 文案 + 建议；区块挂载且可见时每 5 秒轮询。

不做：

- 不改官方 `dsh-mcp-client` 的重连策略；
- 不改 Workbench 连接器（见 [connector-status-and-error-copy.md](connector-status-and-error-copy.md)）；
- 不在普通会话 UI 里加状态提示（会话侧的提示依赖官方面板，另议）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 `POST /api/desktop/yootun/agent-status`

| 项 | 内容 |
|---|---|
| 方法 / 体 | 只接受 `POST`；体可省略，有体时必须是空对象 |
| 信任判定 | 与 yootun 其余同源路由同口径（loopback 远端、显式 Origin 精确匹配、显式 `sec-fetch-site: cross-site` 拒绝、双头缺失放行） |
| 响应 200 | `{ status: 'ok', state, attempt, since, count, retryAt? }`（`count` 为 `connected` 时官方登记的工具数，其余状态为 0） |
| `state` 取值 | `disabled`（门禁未通过：未激活 / 版本不符 / 无 key）· `connecting` · `connected` · `failed`（重连耗尽，等待退避重建）· `waiting-credentials` |
| `attempt` | 官方状态句柄给出的尝试次数；`disabled` 时为 0 |
| `since` | 当前状态首次出现的时间（ISO 8601），页面用于显示「已持续」 |
| 503 | 插件正在卸载：`{ status: 'error', reason: 'plugin_disposing' }` |
| 路由不存在 | 返回 404 时页面显示「未加载」 |

### 2.2 监督器退避参数

| 参数 | 值 | 可配 |
|---|---|---|
| 基值 | 30 秒 | 是：Config `rebuildBackoffMs`（1000..600000，缺省 30000） |
| 倍增 / 上限 | ×2 / 5 分钟 | 上限 = `max(rebuildBackoffMs, 300000)` 固定 |
| 抖动 | ±20% | 否 |
| 复位 | `connected` 后下一次失败从基值开始 | — |

### 2.3 词典新增（`dsh-client-ui-access/src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `agent.title` | 智能体工具 | Agent tools |
| `agent.connected` | 已连接，共 {count} 个工具可用 | Connected, {count} tools available |
| `agent.connecting` | 正在连接（第 {attempt} 次） | Connecting (attempt {attempt}) |
| `agent.failed` | 连接失败，{seconds} 秒后自动重试 | Connection failed, retrying in {seconds}s |
| `agent.disabled` | 未激活，激活后可用 | Not activated; available after activation |
| `agent.waitingCredentials` | 等待密钥 | Waiting for the key |
| `agent.notLoaded` | 未加载，请重启应用 | Not loaded, restart the app |

`count` 取官方 `tools/list` 结果数（连接后由监督器记录）；连接前显示 0 或省略括号。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/supervisor.ts` | 状态订阅、退避重建、状态快照 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/index.ts` | Config `rebuildBackoffMs`；可选注册状态路由（`ctx.get('webServer')` 存在时） | 是 | 可调参数必须是 Config 字段；路由是状态出口 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/constants.ts` | `STATUS_PATH` | 是 | 路由常量单一来源 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/gate.ts` | 复用 `isActivated` 判定 `disabled` | 是 | 门禁单一来源 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/tests/managed-mcp.test.ts` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/{section.tsx,locales.ts}`、`src/access-constants.ts`（生成脚本同步） | 状态行与轮询 | 是 | 设置区块 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/tests/access.test.ts` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §4.2 | 自愈与状态路由 | 是 | 分册是桌面接入契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §4.2 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-26 | `feat/agent-face-self-heal`（基于 `feat/media-upload-tool-handoff`） | `@yootun/dsh-managed-mcp` `test`（node --test 20 用例）、`build`，`@yootun/dsh-client-ui-access` `test`（node --test 9 用例）、`build`，`pnpm --filter '@yootun/*' run build`，仓库根 `pnpm run build`（10 门）、`pnpm run lint`、`typecheck`、三个 verify 脚本与 `test:docs` 通过，验收独立复跑结果一致；真机验收见 5.2 |
| yootun-agent 合入 `main` | 2026-11-26 | `main` | 随 P0 八张批次一并合入（顶点分支 `feat/activation-gate-and-model-catalog`，合并无冲突），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-managed-mcp test`、`build` 通过；
- [ ] `pnpm --filter @yootun/dsh-client-ui-access test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`、`pnpm run verify-empty-catch`；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| A1 | 正常激活后打开设置 → Yootun 接入 | 「智能体工具」显示「已连接」 |
| A2 | 断网 2 分钟再恢复 | 期间显示「连接失败，N 秒后自动重试」并倒计时；恢复网络后 5 分钟内自动变回「已连接」，普通会话里 Agent 工具重新可用，无需重启 |
| A3 | 移除 Key | 状态变为「未激活」；重新激活后回到「已连接」 |
| A4 | 退出应用再打开 | 启动 30 秒内状态到「已连接」 |

### 5.3 本地联调记录

官方 `McpConnectionStatusHandle` 核对（`packages/mcp/mcp-client/src/status.ts`，2026-11-26）：`current(): McpConnectionStatus`、`closure(): McpCloseResult`、`onChange(callback): () => void`（回调同步按发布顺序执行、单回调异常被容器化）。状态机（`types.ts`）取值：`closed` / `waiting-credentials` / `waiting-authorization` / `connecting`（带 `attempt`，首次为 0）/ `connected`（带 `toolCount` 与 `connectedAt`）/ `reconnecting`（带 `attempt` / `maxAttempts` / `nextRetryAtMs`）/ `failed`（`reason: 'gave-up' | 'reconnect-disabled' | 'unclosed-generation'`）。状态单元初值 `{ state: 'connecting', attempt: 0 }`。

与附录 A1 的两处出入（按官方事实实施）：官方 `connected` 事件自带 `toolCount`（实时工具代登记数），监督器无需在 `ready` 后主动 `listTools`，`count` 直接取自该事件；官方 `failed` 不携带 `attempt`，快照保留耗尽前的最后一次计数。官方重连默认策略核对（`connection.ts` `RECONNECT_DEFAULTS`）：enabled、500ms 起倍增、30s 封顶、10 次，耗尽约 8.5 分钟——自愈只需覆盖 `failed` 终态。`reconnecting`（官方自动重连预算内）对外投影为 `connecting`；`waiting-authorization` 与 `closed` 在本组合不可达，分别保守投影为 `waiting-credentials` 与 `connecting`。

本地验证（`feat/agent-face-self-heal`）：`pnpm --filter @yootun/dsh-managed-mcp test` 20/20 通过（含附录 B S1–S6，S7 为既有回归用例），`pnpm --filter @yootun/dsh-client-ui-access test` 9/9 通过（含 U1–U3）；两包 `build`（tsc + tsdown + 运行时 bundle 门）通过。自愈用例以注入缝驱动：`rebuildBackoffMs=1000` + 定值随机源（抖动因子恰为 1.0）+ 官方重连覆盖 `maxAttempts: 1`（测试缝，产品组合不设置），经 fixture 的 reject 模式连续失败循环测得延迟 ≈1000ms → ≈2000ms（倍增）与 connected 复位后 ≈1000ms。状态路由以结构化 req/res 替身直测（405 / 403 / 503 / 400 / 200 与字段集合）。

## 附录 A：逐文件规格

### A1 `src/supervisor.ts`

- `AgentSupervisor` 增 `snapshot(): { state, attempt, since, count, retryAt? }`；`evaluate` 不变（入口先取消待触发的退避定时器）；
- `mount()` 成功拿到 `handle` 后：`unsubscribe = handle.onChange(status => onStatus(status))`；保存 `unsubscribe`，unmount 与 dispose 时调用；
- `onStatus(status)`：维护 `currentState` / `attempt` / `since`（状态变化时刷新 `since`）；`failed` → `scheduleRebuild()`；`connected` → `backoff = base`、`toolCount` 取官方 `connected` 事件自带的 `toolCount`（状态句柄没有 `listTools`）；
- `scheduleRebuild()`：已有定时器则忽略；上限 = `max(rebuildBackoffMs, 300000)`；延迟 = `min(backoff, 上限) × (0.8 + rand × 0.4)`；触发时 `backoff = min(backoff × 2, 上限)`，然后走 `evaluate('status failed')`（`credentialDirty` 不置位，`evaluate` 内 `rebuild = status.current().state === 'failed'` 分支已能重建）；
- `dispose()`：`stopped = true` → 清定时器 → `unsubscribe()` → 既有流程。

### A2 `src/index.ts` / `src/constants.ts`

- Config 增 `rebuildBackoffMs: z.number().step(1).min(1000).max(600000).default(30_000)`；
- `inject` 不变（`['tools']`）；`apply` 内 `const webServer = ctx.get('webServer')`，存在时 `ctx.effect(() => webServer.register({ kind: 'exact', path: STATUS_PATH, handler }))`；handler 与 yootun 其余路由同一信任判定（本包内实现一份 `permitted`，合并见 P1 host-kit 单）；`disposing` 后返回 503；
- 路由处理只读监督器快照，不触发任何网络请求。

### A3 `dsh-client-ui-access/src/client/section.tsx`

- 在「激活状态」行下新增「智能体工具」行：`StateDot`（connected → done；connecting → ongoing；failed → error；disabled → idle；waiting-credentials 与未加载 → warning）+ 文案（connecting 显示「第 attempt + 1 次」，官方 attempt 是此前失败的次数）；failed 时显示倒计时秒数（`max(0, ceil((since + rebuildBackoffMs) - now) / 1000)`，用 `since` 与路由返回的 `retryAt` 更准确：路由增加 `retryAt?: string`）；
- 轮询：区块挂载且 `document.visibilityState === 'visible'` 时每 5 秒；隐藏即停；`fetch` 失败或 404 → `notLoaded`；卸载清除；
- 路由常量 `ACCESS_AGENT_STATUS_PATH` 由 `scripts/generate-access-constants.mjs` 生成（与既有路径常量同源）。

### A4 路由响应补充

`retryAt`（ISO 8601，可选）：`failed` 时给出下次重建时间；其余状态省略。

## 附录 B：测试矩阵

### B.1 监督器（`tests/managed-mcp.test.ts`）

| ID | 断言 |
|---|---|
| S1 | 门禁通过后挂载；状态 `connecting` → `connected`，`snapshot()` 反映 |
| S2 | 状态 `failed` 后无任何事件，在 `rebuildBackoffMs`（测试注入短值）内重建；第二次失败的延迟约为此前的两倍 |
| S3 | `connected` 后退避复位 |
| S4 | dispose 清除待触发的重建，不再 mount |
| S5 | `disabled`：未激活时 `snapshot().state === 'disabled'`，`attempt === 0` |
| S6 | 状态路由：POST 返回快照；非 POST 405；来源不信任 403；disposing 503；无 `webServer` 时不注册且不报错 |
| S7 | 根作用域已有 `mcpClientHost` 提供方时仍能挂载（既有回归不变） |

### B2 设置区块（`tests/access.test.ts`）

| ID | 断言 |
|---|---|
| U1 | 路由返回 `connected` → 显示已连接；`failed` + `retryAt` → 显示倒计时；404 → 未加载 |
| U2 | 隐藏时停止轮询，可见时恢复 |
| U3 | 词典 zh / en 键集一致 |
