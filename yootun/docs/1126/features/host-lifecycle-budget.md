# workbench-Host 生命周期时间预算 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

三工作台 Host 的卸载收口（`src/lifecycle.ts` `disposeHostTasks`）按「拒绝新请求 → abort 全部信号 → `awaitSettled()` 等全部登记任务结束」执行，`awaitSettled()` 是一个无上限的 `while (pending.size > 0)` 循环。登记任务里包含浏览器相关 promise：三插件共 28 处 `context.close()`，全部无超时。Chrome 进程挂起时 `close()` 永不返回，profile 锁随 `finally` 永不释放，插件卸载与应用退出被拖死，该账号之后的登录 / 探测 / 采集全部返回 `collect_busy` 或 `PROFILE_BUSY`，直到重启电脑。

小红书的发布是另一处：`publish.start` 用 `void publishDraft(...)` 启动，promise 没有登记到任务表，dispose 不等它；Chrome 启动若挂起，profile 锁被占住且无人释放。

### 0.2 目标

卸载在预算内完成；浏览器关闭在预算内完成或被放弃并告警；锁在任何结局下都会释放；发布 promise 纳入登记表；启动浏览器有超时。

## 1. 范围

做：

- 三插件 Config 新增 `disposeBudgetMs`（缺省 20000，1000..120000）与 `browserCloseTimeoutMs`（缺省 8000，1000..60000）；
- `createTaskRegistry({ now })` 的 `awaitSettled(budgetMs)`：超时后记录剩余任务数与类型并 resolve（调用方决定是否继续）；
- 各插件新增 `closeContext(context, timeoutMs, logger)`：`close()` 与超时赛跑，超时后告警并 resolve；28 处 `context.close()` 全部改用它；
- 小红书 `publish.start` 的 promise 登记；`publishDraft` 的 Chrome 启动加超时（`launchTimeoutMs`，缺省 60000）；
- 抖音 / 视频号采集与探测路径上的启动同样走带超时的启动封装（复用 `launchTimeoutMs`）。

不做：

- 不强杀 Chrome 进程（持久化 context 没有 `browser()` 句柄；放弃等待后由 Chrome 自身的 profile 文件锁兜底，下次同账号操作会快速失败并给出明确错误）；
- 不改 runs.json 的终态写入语义；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 插件 Config（三插件同名字段）

| 字段 | 类型 | 缺省 | 约束 |
|---|---|---|---|
| `disposeBudgetMs` | integer | 20000 | 1000..120000 |
| `browserCloseTimeoutMs` | integer | 8000 | 1000..60000 |
| `launchTimeoutMs` | integer | 60000 | 1000..180000 |

越界即加载失败。bundle `cordis.patch.yml` 不写，走缺省。

### 2.2 行为变化

| 场景 | 现状 | 变更 |
|---|---|---|
| 插件卸载时某任务挂起 | 永不完成 | 等待 `disposeBudgetMs` 后记录 `lifecycle: dispose budget exhausted, N tasks pending (types)` 并完成卸载；被 abort 的任务若随后结束，其 finally（含锁释放）照常执行 |
| `context.close()` 挂起 | 永不返回，锁不释放 | 等待 `browserCloseTimeoutMs` 后记录 `browser close timed out (<accountId 摘要>)` 并继续执行 finally 的其余部分（锁释放） |
| 小红书发布启动中卸载 | 不等待 | 等待（在预算内）；Chrome 启动超过 `launchTimeoutMs` → `PublishError('PUBLISH_FAILED', 'launch timeout')`，锁释放 |
| 采集 / 探测启动超过 `launchTimeoutMs` | 跟随 Playwright 默认（30 秒）抛错 | 按配置超时，稳定码 `PLAYWRIGHT_DRIVER_MISSING` 之外新增 `browser_launch_timeout` |

### 2.3 稳定码新增

| 码 | 插件 | 用途 |
|---|---|---|
| `browser_launch_timeout` | 三插件 `LOCAL_ERROR_CODES` | 启动超时（采集 / 探测 / 登录 / 发布） |

### 2.4 词典新增（三插件各自 `client/locales.ts`，zh / en 成对）

| 键 | zh | en |
|---|---|---|
| `reason.browser_launch_timeout` | 启动浏览器超时，请确认 Chrome 可用后重试 | Timed out starting the browser; check Chrome and retry |

（视频号、小红书的 `reason.<CODE>` 键与 [connector-status-and-error-copy.md](connector-status-and-error-copy.md) 的穷尽映射同口径；若两单并行，先合入者在词典补键，后合入者解决冲突。）

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-{wx-channels,douyin,xhs}-workbench/src/lifecycle.ts` | `awaitSettled(budgetMs)`；`createTaskRegistry({ now })` 测试接缝 | 是 | 预算执行点 |
| yootun-agent | 三插件 `src/chrome.ts`（视频号、抖音、小红书各一份） | `closeContext`、`launchWithTimeout` 封装 | 是 | 浏览器生命周期单一来源 |
| yootun-agent | 三插件 `src/{runner,session,probe,collector,publisher}.ts` 中 28 处 `context.close()` 与启动调用 | 改用封装 | 是 | 本单主体 |
| yootun-agent | 三插件 `src/index.ts` | Config 三个字段与透传 | 是 | 可调参数必须是 Config 字段 |
| yootun-agent | 三插件 `src/errors.ts`、`src/client/locales.ts` | `browser_launch_timeout` 与文案 | 是 | 稳定码与 locale-owned 文案 |
| yootun-agent | 小红书 `src/handlers.ts` `publish.start` | promise 登记；`publishDraft` 启动超时 | 是 | 发布生命周期 |
| yootun-agent | 三插件 `tests/{lifecycle*,dispose,host,batch-concurrency}.test.ts` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §12.4 | 卸载预算与启动超时条款 | 是 | 分册是生命周期契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §12.4 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/host-lifecycle-budget` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] 三插件 `pnpm --filter <pkg> test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] `grep -rn "\.close()" yootun/plugins/dsh-*-workbench/src --include=*.ts | grep -v closeContext` 结果为 0（tests 除外）；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| L1 | 批量采集进行中退出应用 | 应用在 20 秒内退出，不悬挂；重新打开后账号可继续操作，没有 `collect_busy` 残留 |
| L2 | 采集进行中切换插件（设置页停用再启用视频号工作台） | 停用在预算内完成；启用后工作台可用 |
| L3 | 小红书点「打开创作者中心」后立刻退出应用 | 应用正常退出；重新打开后该账号不再报「占用中」 |
| L4 | 把 Chrome 可执行文件临时改名后点采集 | 提示浏览器不可用（既有码），不出现启动超时 |
| L5 | 制造启动超时（例如系统极慢时观察） | 若出现，提示「启动浏览器超时，请确认 Chrome 可用后重试」，按钮可重试 |

### 5.3 本地联调记录

待填。

## 附录 A：逐文件规格

### A1 `src/lifecycle.ts`（三插件同构）

- `createTaskRegistry(options: { now?: () => number } = {})`；
- `awaitSettled(budgetMs = Number.POSITIVE_INFINITY): Promise<{ exhausted: boolean; pending: number }>`：循环 `Promise.allSettled([...pending])`，每轮结束检查 `now() - start >= budgetMs` → 返回 `{ exhausted: true, pending: pending.size }`；
- `disposeHostTasks({ deps, batch }, options: { disposeBudgetMs: number; warn })`：调用 `awaitSettled(disposeBudgetMs)`，`exhausted` 时 `warn('lifecycle: dispose budget exhausted, N tasks pending')`；之后照常清空 signals。

### A2 `src/chrome.ts`（三插件）

- `export async function closeContext(context: BrowserContext, timeoutMs: number, onTimeout: () => void): Promise<void>`：`Promise.race([context.close().catch(() => undefined), sleep(timeoutMs).then(() => 'timeout')])`；超时 → `onTimeout()`；不抛；
- `export async function launchWithTimeout<T>(launch: () => Promise<T>, timeoutMs: number): Promise<T>`：超时抛各插件的 `ChromeMissingError` 同体系的 `BrowserLaunchTimeoutError`（`name = 'BrowserLaunchTimeoutError'`），`safeCode` 映射为 `browser_launch_timeout`；超时后若 launch 迟到成功，立即 `closeContext` 清理（与登录流程的「晚 factory 清理」同口径，交 `trackCleanup` 登记）。

### A3 调用点替换

- 28 处 `context.close()` → `closeContext(context, config.browserCloseTimeoutMs, () => logger.warn(...))`；
- `chromeFactory({ headless, profileDir })` 调用点（采集、探测、登录、发布）包一层 `launchWithTimeout`，超时后不再进入后续步骤；
- 登录流程的 abort 竞速（`launchOrAbort`）保留，叠加启动超时。

### A4 小红书 `publish.start` / `publisher.ts`

- `deps.taskRegistry.track(publishDraft(...).then(...).catch(...).finally(...))`；
- `publishDraft` 内 `launchWithTimeout(() => chromeFactory(...), options.launchTimeoutMs ?? 60_000)`，超时抛 `PublishError('PUBLISH_FAILED', 'launch timeout')`；`onContext` 钩子仍在 context 创建后立即挂接。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| G1 | `awaitSettled(50)` 在有永不 settle 的任务时 50ms 左右返回 `exhausted: true, pending: 1`；无任务时立即返回 |
| G2 | dispose 预算耗尽时记录告警且 signals 已清空；挂起任务随后 settle 时其 finally 执行 |
| G3 | `closeContext` 正常关闭 ≤ 超时 → 不触发 onTimeout；挂起的 close → 超时触发 onTimeout 并 resolve |
| G4 | `launchWithTimeout` 超时抛 `BrowserLaunchTimeoutError`，`safeCode` → `browser_launch_timeout`；迟到的 launch 结果被关闭 |
| G5 | 小红书 publish：dispose 等待挂起的 publishDraft 至预算；启动超时后 profile 锁释放，`account.probe` 不再返回 `PROFILE_BUSY` |
| G6 | 既有 dispose / abort / 批量取消用例在新预算下通过 |
