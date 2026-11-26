# infra-workbench-Host 共享库 实施单

状态：开发完成（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

前置：P0 全部合入。本单迁移 [host-lifecycle-budget.md](host-lifecycle-budget.md) 在三插件内落地的 `closeContext` / `launchWithTimeout` 与 `createTaskRegistry`，并承接 [connector-status-and-error-copy.md](connector-status-and-error-copy.md) 明确留给本单的 `permitted()` / 路由合并。

## 0. 背景与目标

### 0.1 现状

三个工作台 Host 各自维护一套同构的基础代码，靠复制保持一致：

| 能力 | 抖音 | 视频号 | 小红书 | 已知差异 |
|---|---|---|---|---|
| 路由信任判定 `permitted` | `route.ts` | `route.ts` | `route.ts` | 函数体逐行相同 |
| JSON 体读取 `readBody` / 响应 `send` / 分发 `createRouteHandler` | `route.ts` | `route.ts` | `route.ts` | 405 的 reason 抖音、视频号为 `invalid_request`，小红书为 `method_not_allowed`；视频号 handler 返回类型是 `object`，没有稳定码的编译期约束 |
| profile 锁 | `locks.ts` | `locks.ts` | `locks.ts` | 小红书多一个即时占入口 `acquireProfileLock`，视频号多一个 `profileLockWaiters` |
| 任务登记表 | `lifecycle.ts` | `lifecycle.ts` | `lifecycle.ts` | `createTaskRegistry` 相同，`disposeHostTasks` 的信号表不同 |
| 系统 Chrome 探测 | `chrome.ts` | `chrome.ts` | `chrome-probe.ts` | `resolveSystemChrome` 相同，`browserStatus` 投影不同 |
| 原子写 | `state.ts` | `state.ts` | `state.ts` | 小红书 tmp 文件名固定为 `<file>.tmp`，且 `accounts.json` 的读改写没有按 root 的串行队列 |

最后一行是一个实际缺陷：小红书 `updateAccount` / `nextSessionSeq`（`src/state.ts`）先读 `accounts.json`、改内存、再整文件写回，中间没有串行化。两个账号的操作并发时（例如账号 A 采集结束写 `lastCollectedAt` 的同时账号 B 的探测写 `sessionStatus`），后写的一方会把先写的一方的字段覆盖回旧值；两个写回撞在同一瞬间时，固定 tmp 名还会让其中一个 `rename` 报 `ENOENT`，一次已经成功的采集以 `COLLECT_FAILED` 结束。抖音与视频号的同类写入都有按 root 的串行队列（各自的 `state.ts` / `runs.ts`），tmp 名也带 pid 与随机段；小红书两者都没有。

### 0.2 目标

上述基础能力只有一份实现，放在纯 Node 库 `@yootun/dsh-workbench-host-kit`，三个工作台消费它，managed-mcp 的状态路由与 media-upload 的路由消费其中的信任判定；插件内只保留各自的 action schema、校验器、业务编排与投影。模块级可变状态按归属重新安放：账号锁与批次序号随插件实例创建，按 root 的写队列是文件级事实、进程内共享。

## 1. 范围

做：

- 新建 `yootun/packages/dsh-workbench-host-kit`，含路由、任务登记表、profile 锁、状态文件写入、系统 Chrome 探测与浏览器生命周期五个模块；
- 三插件改为消费该库，删除本地副本；managed-mcp 的 `agent-status` 路由（P0 新增）与 media-upload 的 `permitted()` 改为消费 kit 的同名函数；无状态的函数（`permitted`、`createTaskRegistry`、`resolveSystemChrome` 等）经 `index.ts` 原名再导出，调用方与测试不改导入路径；锁函数改为实例方法，相关测试随附录 A2 调整；
- 小红书补齐 `accounts.json` 的按 root 写队列与唯一 tmp 名（修复 0.1 的丢更新）；
- 账号锁实例由 `create<Name>HostDeps` 创建并放在 `deps.locks`；抖音 `runner.ts` 的批次序号移入批量控制器闭包；激活门禁 `gate.tsx` 的两个模块级变量移入 `mountGate` 闭包与组件 ref；
- 路由层拒绝原因进入三插件词典（`forbidden` / `unknown_action` / `method_not_allowed`）；
- `yootun/scripts/verify-plugin-runtime-bundle.mjs` 的包名清单补上抖音工作台与 media-upload（当前清单只有 4 个包，这两个包的 `files` 校验被跳过）。

不做：

- 不合并三份 action schema 校验器（`validateActionArgs`）：抖音有 `required` / `idempotency` / `requireTrue` / `date`，视频号有整数区间与枚举，小红书有 `object` / `stringArray`；差异是各自的 action 契约，不是重复。校验器由 `createActionRoute` 的 `validate` 参数注入。第四个工作台出现时再评估做超集；
- 不统一三插件的成功状态词汇（视频号 `ok`，抖音、小红书 `ready` / `started` / `created`）：词汇差异不影响行为，统一要改全部页面判定，回归面大且无用户可见收益；
- 不抽 `stateRoot`（每个插件 5 行，默认目录是冻结的旧路径）；
- 不合并 client 侧的上传传输函数（小红书与 media-upload 的两份）：它是 client 代码，见 [upload-experience-fixes.md](upload-experience-fixes.md)；
- 不改任何 action 的入参与出参；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。均为包内 API 与插件内部结构变化，页面可见的 action 契约不变。

### 2.1 包 `@yootun/dsh-workbench-host-kit`

位置 `yootun/packages/dsh-workbench-host-kit`，纯 Node 库：不依赖 cordis、不注册服务、不含 React。ESM，`exports` 为 `.` 与 `./package.json`；`build` 为 `tsc -p tsconfig.json && tsc -p tests/types/tsconfig.json && tsdown`（`platform: 'node'`、`dts: true`；第二段 tsc 执行 H4 的 `@ts-expect-error` 类型用例），`test` 为 `node --test tests/*.test.ts`。三插件以 `devDependencies`（`workspace:*`）引用，由官方 `clientBundle` 内联进各插件的运行时 bundle（与 `@yootun/dsh-client-ui-kit` 被 client 半内联的口径相同），不新增运行时外部依赖。

| 模块 | 导出 |
|---|---|
| `route.ts` | `permitted`、`readJsonBody`、`sendJson`、`createActionRoute`、`HandlerPayload<S, C>`、`ActionHandler<S, C>`、`ActionArgs`、`ROUTE_REFUSAL_REASONS` |
| `task-registry.ts` | `createTaskRegistry`、`TaskRegistry`（迁移自 P0 生命周期单，含 `awaitSettled(budgetMs)`） |
| `profile-locks.ts` | `createProfileLocks`、`ProfileLocks`、`ProfileLockAttempt<T>`、`ProfileLockRelease` |
| `state-store.ts` | `atomicWriteJson`、`rootQueues`、`runInRootQueue<T>` |
| `chrome.ts` | `resolveSystemChrome`、`chromeCandidates`、`LAUNCH_ARGS`、`ChromeMissingError`、`DriverMissingError`、`BrowserLaunchTimeoutError`、`closeContext`、`launchWithTimeout` |

### 2.2 `createActionRoute`

```ts
createActionRoute<S extends string, C extends string, A extends ActionArgs = ActionArgs>(options: {
  expectedOrigin: () => string
  actionSchemas: Readonly<Record<string, unknown>>
  validate: (action: string, body: Record<string, unknown>) => A
  handlers: Readonly<Record<string, ActionHandler<S, C, A>>>
  codes: { invalidRequest: C; payloadTooLarge: C; routeCodePrefix: string }
  safeCode: (error: unknown) => string
  isStableCode: (code: string) => boolean
  maxBodyBytes: number
}): (req: RouteRequest, res: RouteResponse) => Promise<void>

`safeCode` 与 `isStableCode` 由调用方注入：「白名单外的原始错误收敛为
codes.invalidRequest（规则同现状）」要求 kit 知道各插件的稳定码投影与白名单，
实现以注入面承载（抖音 fallback `DOUYIN_ROUTE_INVALID_REQUEST`、视频号
`WX_TOOL_UNAVAILABLE`、小红书 `xhs_operation_request_failed`，行为逐字节不变）。
`ActionArgs` 为 kit 层的 `Record<string, unknown>`，各插件以自己的 ActionArgs
实例化 `A`。
```

| 场景 | HTTP | 响应体 |
|---|---|---|
| 非 POST | 405 | `{ status: 'error', reason: 'method_not_allowed' }` |
| 信任判定不通过 | 403 | `{ status: 'error', reason: 'forbidden' }` |
| action 不在 allowlist 或无 handler | 400 | `{ status: 'error', reason: 'unknown_action' }` |
| 体超过 `maxBodyBytes` | 413 | `{ status: 'error', reason: codes.payloadTooLarge }` |
| 抛出的稳定码以 `routeCodePrefix` 开头 | 400 | `{ status: 'error', reason }` |
| handler 返回 error | 200 | handler 的载荷 |
| 白名单外的原始错误 | 200 / 400 | 收敛为 `codes.invalidRequest`（规则同现状） |

与现状的差异只有一处：405 的 reason 三插件统一为 `method_not_allowed`。

### 2.3 `HandlerPayload<S, C>`

```ts
type HandlerPayload<S extends string, C extends string> =
  | ({ status: S } & Record<string, unknown>)
  | ({ status: 'error'; reason: C } & Record<string, unknown>)
```

各插件实例化：抖音 `HandlerPayload<'ready' | 'started', StableErrorCode>`；小红书 `HandlerPayload<'ready' | 'started' | 'created', StableErrorCode>`；视频号 `HandlerPayload<'ok', StableErrorCode>`。视频号由此获得与另两个插件相同的编译期稳定码约束。

### 2.4 `createProfileLocks()`

返回 `{ withProfileLock, tryWithProfileLock, withProfileLocks, tryWithProfileLocks, acquireProfileLock, isProfileLocked, profileLockWaiters }`，是三份实现的并集，语义不变（FIFO、非重入、多锁按 key 排序、try 语义不排队）。

### 2.5 状态文件写入

- `atomicWriteJson(file, data)`：tmp 名为 `<file>.tmp-<pid>-<随机 6 位>`、`0600`、同目录 `rename`、`chmod` 尽力而为；
- `rootQueues`：kit 内唯一的进程级实例，按 root 串行；`runInRootQueue(root, task)` 空闲时回收 entry。进程级是有意的：同一 root 被同进程的两个实例写时，串行化必须跨实例成立。

### 2.6 词典新增（三插件 `src/client/locales.ts`，zh / en 成对）

| 键 | zh | en |
|---|---|---|
| `reason.forbidden` | 请求来源校验未通过，请重启应用 | Request origin was rejected; restart the app |
| `reason.unknown_action` | 应用版本与页面不一致，请重启应用 | The page and the app are out of sync; restart the app |
| `reason.method_not_allowed` | 请求方式不被支持 | Request method not supported |

三个码是路由层字面量，不进 `STABLE_ERROR_CODES`；各插件 client 的码 → 文案映射在穷尽表之外为这三个码各加一条显式分支（运行时防御口径同 [connector-status-and-error-copy.md](connector-status-and-error-copy.md) §2.7）。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-workbench-host-kit/`（新） | 包、五个模块与 `index.ts`、测试 | 是 | 本单主体 |
| yootun-agent | `pnpm-lock.yaml` | 新 workspace 包的锁记录 | 是 | workspace glob 已登记（[inline-changes.md](../../inline-changes.md) #1），无需新登记 |
| yootun-agent | 三插件 `src/route.ts` | 只保留 `ACTION_SCHEMAS`、`validateActionArgs`、`HandlerPayload` 实例化与 kit 再导出 | 是 | 删除三份路由实现 |
| yootun-agent | 三插件 `src/locks.ts`、`src/lifecycle.ts`、小红书 `src/chrome-probe.ts` | `locks.ts` 与 `chrome-probe.ts` 删除；`lifecycle.ts` 只保留各自的 `disposeHostTasks` | 是 | 删除三份副本 |
| yootun-agent | 三插件 `src/chrome.ts` | 只保留 `browserStatus` 投影与各自的启动函数 | 是 | 探测与生命周期上移 |
| yootun-agent | 三插件 `src/handlers.ts`（`create<Name>HostDeps`）、`deps` 类型，以及调用锁的 `runner.ts` / `session.ts` / `probe.ts` / `collector.ts` / `publisher.ts` | `deps.locks`；17 处锁调用与小红书 1 处把 `isProfileLocked` 作为回调传入的地方，改为经 deps 或 options 拿到锁实例（抖音 6、视频号 6、小红书 5） | 是 | 模块级状态归位 |
| yootun-agent | 抖音 `src/runs.ts` / `state.ts`、视频号 `src/runs.ts` / `state.ts`、小红书 `src/state.ts` | 写入改用 `atomicWriteJson` + `runInRootQueue`，删除各自的本地队列副本；小红书 `updateAccount` / `nextSessionSeq` 进入队列 | 是 | 修复小红书丢更新 |
| yootun-agent | 抖音 `src/runner.ts` `createBatchCollectController` | `batchSeq` 移入闭包 | 是 | 模块级状态归位 |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/gate.tsx` | `gateRoot` / `releaseApplication` 移入闭包与 ref | 是 | 模块级状态归位 |
| yootun-agent | 三插件 `src/client/{format,locales}.ts` | 路由层拒绝原因的文案分支 | 是 | 可读错误 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/index.ts`、`yootun/plugins/dsh-media-upload/src/routes.ts` | 本地 `permitted` 改为 kit 再导出（media-upload 的 media 预览路由有自己的 no-cors 规则，不在其内） | 是 | 信任判定单一来源 |
| yootun-agent | `yootun/scripts/verify-plugin-runtime-bundle.mjs` | 包名清单补两项 | 是 | 构建校验漂移 |
| yootun-agent | `yootun/OVERVIEW.md` 目录结构表 | 登记新包 | 是 | 分区导航 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §10.3 | 路由安全口径注明实现位于 kit | 是 | 生命周期与路由契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + OVERVIEW + 08 册 §10.3 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/workbench-host-kit`（基于 P0 合入后的 `main`） | 两轮独立验收通过：kit 包 test 25 用例与 build（含类型段）、三工作台 / managed-mcp / media-upload / client-ui-access 各包 test 与 build、`lint`、`typecheck`、四个 verify 脚本、`test:docs`、5.1 两条 grep 全过；附录 B 全部 ID 存在且经变异检查证实有效 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-workbench-host-kit test`、`build` 通过；
- [ ] 三插件 `pnpm --filter <pkg> test`、`build` 通过，既有 Host 测试不改断言；
- [ ] `pnpm run lint`、`pnpm run verify-export-jsdoc`（新包导出 JSDoc）、`pnpm run verify-client-ui-i18n`；
- [ ] `grep -rn "const locks = new Map" yootun/plugins/*/src` 与 `grep -rn "let batchSeq" yootun/plugins/*/src` 结果为空；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| K1 | 三工作台各走一遍登录、单账号采集、批量采集（视频号、抖音）、探测、移除本地账号 | 行为、文案、耗时与本单之前一致 |
| K2 | 小红书：账号 A 采集进行中对账号 B 点「检测」，等 A 结束后刷新 | A 的「上次采集时间」与 B 的会话状态都被保留；A 的采集结果为成功 |
| K3 | 三工作台任意操作期间退出应用再打开 | 无「占用中」残留；页面可用 |
| K4 | 激活门禁：未激活状态下等待 30 秒后激活，再切到设置移除 Key 回到门禁 | 滚动锁与焦点陷阱正常，背景不可点击；授权后页面可交互 |

### 5.3 本地联调记录

验收轮 1（独立子代理，结论通过、无必须修）发现并已修复：

- 小红书 `clearLocalCredentials` 的 accounts.json 读-删-写仍在按 root 队列外（探针 40/40 复现丢更新），已包进 `runInRootQueue`（对照抖音同段），探针转正为回归用例 `tests/clear-local-credentials-race.test.ts`（X4）；
- `gate.tsx` 双挂载时实例 previous 快照互相指向对方设置的值：实例清理按快照恢复会把仍在阻断的门禁解锁（探针复现），改为实例不按快照恢复、`mountGate` disposer 在门禁层全部卸载后统一复位；失去唯一生产消费者的 `blockApplicationScroll` 快照恢复 helper 随之删除，其行为锁定由 `gate.test.tsx` 与 `gate-double-mount.test.tsx` 的真实 overflow 断言接管（原 helper 单元用例删除，原因如上）；
- 小红书 client `format.ts` 的 `reasonText` JSDoc 被新常量隔开，已归位；抖音、视频号 `format.ts` 的 `ROUTE_REFUSAL_REASONS` 值导入仅被注释引用，改为类型导入；
- X2 用例改写为绕过队列直写 `writeAccounts`（原经 `updateAccount` 已被队列串行化，测不到 tmp 交错面；tmp 唯一性的第一道防线由 kit H7 承担）。

与实施单的出入及处理（单上文字已随实现修订）：

- 2.2 签名增加 `safeCode` / `isStableCode` 注入项：单上「白名单外原始错误收敛为 invalidRequest（规则同现状）」依赖各插件 safeCode 的 fallback（视频号未知错误收敛为 `WX_TOOL_UNAVAILABLE` → HTTP 200），kit 裸读 `.code` 会把该形态变为 400；注入后与三插件原 catch 分支逐字对照等价（单上原文 → 增加注入项 → 验收认可）；
- 3 影响面「抖音 `src/runner.ts`」的写入行：抖音的状态写入实际在 `src/runs.ts` / `src/state.ts`，runner.ts 无写盘点（单上原文 → 实际 → 影响面行已改为 runs.ts / state.ts，runner.ts 保留在批次序号行）；
- 抖音批次序号 `batchSeq` 移入控制器闭包后改名 `batchOrdinal`：5.1 的 `let batchSeq` grep 门禁不分作用域，闭包内声明仍命中（单上原文 → 实际 → 零行为变化的改名使门禁可判）；
- 视频号新增本地稳定码 `refresh_not_allowed`：`account.refreshLoginQr` 既有守卫拒绝在 HandlerPayload 收紧（2.3）后须进 `STABLE_ERROR_CODES` 才能编译；无页面消费者，词典 zh/en 与 `REASON_KEYS` 已补；该 action 由 mount-restore 单（P1 第 3 阶段）删除；
- 视频号 handlers `runPassthrough` 的 `build === undefined` 死分支原返回 `unknown_action`（不在稳定码白名单），改为抛 `WX_ROUTE_UNKNOWN_ACTION` 保持 fail loud；分支不可达（调用点核对 7 处均为映射表既有键），无测试与页面覆盖差异；
- kit chrome.ts 不含 `loadPlaywrightDriver` / playwright-core import：驱动加载留在抖音插件（只有插件声明该依赖），`DriverMissingError` 类在 kit；
- 单上 2.1 的 kit chrome.ts 导出表未列 `browserCloseTimeoutMessage` 与两个缺省预算常量：三插件 index 再导出面保持与迁移前一致，随 chrome.ts 一并迁入（单上原文 → 实际 → 验收认可）。

改动过的既有用例（均为附录 A2 点名的锁实例化适配或 R1 点名的 405 reason 断言，无断言语义改写）：

- 夹具补 `locks`：抖音 batch-concurrency / lifecycle3，视频号 host / dispose / p0-fixes / runs / batch-concurrency / lifecycle-budget / profile-lock（模块级锁函数改实例调用），小红书 host / session / lifecycle-budget；
- 405 reason 断言：抖音 route.test（原只断 status，补 reason 行）、视频号 host.test（新增 R1 用例）、小红书 host.test（补 reason 行）；
- 小红书 host.test「publish.start 锁占用即拒绝」账号名 acc-1 → acc-exp：原断言依赖模块级锁的跨用例残留（本用例发布的账号是 acc-exp），实例化后旧断言恒假，改后断言意图不变且更真实；
- 访问包新增 vitest / jsdom / react-dom devDeps 与 `tests/client/gate.test.tsx`（R3 需要真实 DOM）、`tests/client/primitives-shim.ts`（受控桶）；验收轮 1 后新增 `gate-double-mount.test.tsx`（F2 回归）。

未核对项：真机验收清单 5.2 K1–K4；kit `resolveSystemChrome` 的真实 PATH 命中路径（测试用注入接缝）。

## 附录 A：逐文件规格

### A1 新包

- `src/route.ts`：`permitted` 取视频号版（与抖音、小红书逐行相同）；`readJsonBody(req, { maxBytes })` 超限抛 kit 内的 `RouteBodyTooLargeError`，由 `createActionRoute` 翻译为 `codes.payloadTooLarge`；JSON 解析失败与非对象体返回 `{}`；`createActionRoute` 按 2.2；
- `src/task-registry.ts`、`src/chrome.ts`：从 P0 生命周期单落地后的抖音版迁入，三插件删除本地副本；
- `src/profile-locks.ts`：以小红书版为底（含即时占入口），补回视频号的 `profileLockWaiters`；
- `src/state-store.ts`：以抖音 `state.ts` 的 `atomicWrite` 与 `withRootLock` 为底；
- `src/index.ts` 只做再导出，每个导出有 JSDoc。

### A2 三插件

- `route.ts`：`createRouteHandler` 改为一行——把 `ACTION_SCHEMAS`、`validateActionArgs`、各自的稳定码前缀与 `MAX_BODY_BYTES` 交给 `createActionRoute`；抖音、视频号的 405 reason 随 kit 变为 `method_not_allowed`；
- `handlers.ts`：`create<Name>HostDeps` 增加 `locks: createProfileLocks()`；独立函数（`runCollection`、`probeAndReport`、`loginWithQrCode`、`collectNotes`、`publishDraft` 等）的 options 增加 `locks`，与 `taskRegistry` 同一透传方式；`index.ts` 不再导出锁函数；
- 小红书 `state.ts`：`writeAccounts` 改用 `atomicWriteJson`；`updateAccount`、`nextSessionSeq` 改为 `runInRootQueue(root, async () => { 读、改、写 })`；
- 抖音 `runner.ts`：`batchSeq` 成为 `createBatchCollectController` 内的局部变量；
- `gate.tsx`：`releaseApplication` 改为 `AccessGate` 内的 `useRef`，effect 的清理函数负责释放；`gateRoot` 成为 `mountGate` 内的局部变量，由返回的 disposer 捕获。

### A3 `verify-plugin-runtime-bundle.mjs`

包名清单增加 `@yootun/dsh-douyin-workbench` 与 `@yootun/dsh-media-upload`。

## 附录 B：测试矩阵

### B.1 kit（`tests/route.test.ts`、`tests/locks.test.ts`、`tests/state-store.test.ts`、`tests/task-registry.test.ts`、`tests/chrome.test.ts`）

| ID | 断言 |
|---|---|
| H1 | `permitted`：loopback 放行；非 loopback 拒绝；`sec-fetch-site: cross-site` 拒绝；Origin 等于期望值或缺失放行；字面 `null` 与异源拒绝 |
| H2 | `createActionRoute`：2.2 表的六种响应逐行成立；非稳定码错误收敛为 `invalidRequest`；`routeCodePrefix` 命中的码返回 400 |
| H3 | 体上限：声明与实际都生效，超限返回 413 且不进入 handler |
| H4 | 类型层：返回未登记 reason 的 handler 在 `tsc` 下报错（`tests/types/` 下的 `@ts-expect-error` 用例，随 `build` 执行） |
| H5 | 锁：同账号等待、不同账号并行、try 语义不排队、多锁排序获取、即时占用的 release 幂等、`profileLockWaiters` 计数 |
| H6 | 两个锁实例互不影响（同账号名在不同实例中可同时持有） |
| H7 | `atomicWriteJson`：tmp 名含 pid 与随机段；目标文件在 rename 前不被改写 |
| H8 | `runInRootQueue`：同 root 串行、不同 root 并行、任务抛错后队列继续、空闲后 entry 被回收 |
| H9 | `closeContext` / `launchWithTimeout` / `awaitSettled`：P0 生命周期单的 G1–G4 用例迁入后通过 |

### B.2 小红书（`tests/state.test.ts`、`tests/host.test.ts`）

| ID | 断言 |
|---|---|
| X1 | 两个账号并发 `updateAccount`（注入延迟的文件系统接缝，交错读改写）后重读：两处字段都保留 |
| X2 | 并发写时 tmp 文件名不同，无 `ENOENT` |
| X3 | 同一账号 `nextSessionSeq` 并发两次得到两个不同的连续序号 |

### B.3 三插件回归

| ID | 断言 |
|---|---|
| R1 | 既有 `route.test.ts` / `host.test.ts` 中关于 405 reason 的断言更新为 `method_not_allowed`，其余断言不变 |
| R2 | client：`forbidden` / `unknown_action` / `method_not_allowed` 三个码显示 2.6 的文案 |
| R3 | 门禁：`mountGate` 连续调用两次（模拟重复挂载）后第一次的 disposer 只卸载自己创建的宿主节点 |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| schema 校验器 | 留在各插件，kit 只负责分发 | kit 提供超集校验器 |
| 写队列归属 | kit 进程级单例（文件级事实） | 每个插件实例一份（跨实例丢更新） |
| 账号锁归属 | 每个插件实例一份，经 deps 透传 | 保持模块级单例 |
| 成功状态词汇 | 保持各插件现状 | 统一为一种 |
| 新包位置 | `yootun/packages/`（与 kit、access 并列） | 放进某个插件再互相引用 |
