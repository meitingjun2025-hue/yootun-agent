# infra-workbench-连接器状态分类与错误码文案闭环 实施单

状态：已合入 `main`（2026-11-26，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

- 连接器 `@yootun/dsh-workbench-mcp` 把 `tools/call` 的所有传输层失败（401 / 403 / 5xx / 断网 / 连接被拒）都收敛为 `workbench_network_error`（`src/client.ts` `callTool` 的 catch），用户在密钥被服务端拒绝时看到的是「网络错误」；`closeClient` 用 `void error` 吞关闭失败。
- `tools/list` 广播的工具名集合只在连接建立时读取一次并缓存到连接失效为止；服务端发版新增工具后，桌面端会持续得到 `workbench_tool_unavailable`，直到重启或更换密钥。
- 三工作台对稳定错误码的文案覆盖不一致：视频号 `REASON_KEYS` 只映射 49 个码中的 19 个，`LOCAL_CLEARED_REQUIRED`、`UNAUTHORIZED` 等落到「未知错误（CODE）」；抖音 `domainErrorText` 回退到不带码的默认文案；小红书回退带码。新增码时没有任何编译期约束。
- 三个 client 的 `hostAction` 各一份：抖音版有 30 秒超时、响应校验与稳定错误收敛；视频号与小红书版无超时，`response.json()` 失败会把 `SyntaxError` 原文抛到 toast。
- 抖音的 30 秒对「返回前同步等待一次浏览器探测」的 action 偏短：探测预算是 45 秒（`PROBE_TIMEOUT_MS`），打开页面预算 60 秒。探测慢速失败时页面先超时，用户看到的是「请求失败」而不是探测原因。把这个超时原样推广到视频号与小红书会把同一隐患带过去。

### 0.2 目标

连接器按 HTTP 状态给出可行动的稳定码；服务端新增工具后无需重启即可用；三工作台对每一个稳定码都有本地化文案，缺文案即编译失败；`hostAction` 只有一份实现。

## 1. 范围

做：

- 连接器：按传输层错误的类型与 HTTP 状态拆分稳定码；`workbench_tool_unavailable` 命中时对当前连接刷新一次 `tools/list`；关闭失败改为命名绑定并注释；
- 三工作台 Host：连接器新码的投影登记（抖音 `WORKBENCH_ERROR_CODES` 受类型约束，补登记；视频号、小红书显式投影到本地码）与中英文案；
- 三工作台 client：错误码 → 文案映射改为 `Record<StableErrorCode, LocaleKey>` + `satisfies`，词典补齐缺失键，回退格式统一为「本地化通用文案（码）」；
- `hostAction` 上移到 `@yootun/dsh-client-ui-kit`（`createHostAction`），三插件改为消费；新增本地码 `host_unreachable`。

不做：

- 不改 tools、docker-helm；
- 不改连接器的放行规则（caller × 域）；
- 不做写操作限流（随网关迁移，见 [write-quota-and-audit-attribution.md](write-quota-and-audit-attribution.md)）；
- 不改各 Host 的业务错误码集合，只补连接器码与 `host_unreachable`；
- 不合并三份 `permitted()` / 路由实现（见 P1 的 host-kit 单）。

## 2. 契约增量

MCP 工具：无。

### 2.1 连接器稳定码

| 码 | 触发 | 现状 |
|---|---|---|
| `workbench_unauthorized` | 传输层报告 HTTP 401 / 403（含 SDK 的 `UnauthorizedError`） | 新增；原为 `workbench_network_error` |
| `workbench_server_error` | HTTP ≥ 500、408、429 | 新增；原为 `workbench_network_error` |
| `workbench_protocol_error` | 其它 4xx（含 404 / 410：端点不存在或已下线）、`serverName` 不匹配 | 既有码，语义扩展 |
| `workbench_network_error` | 连接被拒、DNS、TLS、socket 挂起、SDK 内部超时之外的传输异常 | 不变 |
| `workbench_call_timeout` / `workbench_call_cancelled` | 既有 | 不变 |

判定依据：`@modelcontextprotocol/client` 2.2.0 对非 2xx 响应抛 `SdkHttpError`（`.status` 为数字）或 `UnauthorizedError`（401 且无 auth provider）。按错误对象的类型与 `status` 属性判定，不解析消息文本。实现时以当前安装版本的导出为准（核对结果记入 5.3）。

连接与 `tools/list` 阶段的失败走同一张表（原为 `workbench_network_error` / `workbench_protocol_error` 两码）。

### 2.2 `tools/list` 刷新

`callTool` 在域门通过、`connection.toolNames.has(name)` 为 false 时：若该连接距上次刷新 ≥ 60 秒，则对 `connection.client` 调一次 `listTools`（带本次调用剩余的超时预算），成功则就地更新 `toolNames` 后重新判定；刷新失败按 2.1 投影；60 秒内已刷新过的，直接返回 `workbench_tool_unavailable`。并发的未广播调用共享同一次刷新（单飞）；共享刷新以首发调用方的取消或超时收尾时，未取消的后到调用方以自己的剩余预算重试且仅重试一次，其余投影所有等待者原样共享。

### 2.3 失效后的重连

`workbench_unauthorized` 与 `workbench_protocol_error`（404 / 410）发生后调用一次 `invalidate()`，使下一次调用重新连接（服务端为无状态 Streamable HTTP，重连无副作用）；写操作不自动重试。刷新（`tools/list`）在途时连接被失效或插件卸载，本次调用以 `workbench_unavailable` 结束、不盖 `refreshedAt`、不发 `tools/call`（与 `open()` 的在途失效口径一致）。

### 2.4 Host 投影

| 插件 | 连接器码 | 投影为本地码 | 文案 |
|---|---|---|---|
| 抖音 | `workbench_unauthorized` | 原样（`WORKBENCH_ERROR_CODES` 登记） | 「密钥无权限或已失效，请到设置重新激活」 |
| 抖音 | `workbench_server_error` | 原样 | 「服务暂时不可用，请稍后重试」 |
| 视频号 | `workbench_unauthorized` | `UNAUTHORIZED`（既有服务端码） | 同上 |
| 视频号 | `workbench_server_error` | `WX_TOOL_UNAVAILABLE`（既有） | 同上 |
| 小红书 | `workbench_unauthorized` | `UNAUTHORIZED`（本地码新增） | 同上 |
| 小红书 | `workbench_server_error` | `xhs_operation_request_failed`（既有） | 同上 |

### 2.5 `hostAction`（kit）

```ts
export class HostActionError extends Error { readonly code: string }
export interface HostActionOptions { timeoutMs?: number; actionTimeouts?: Readonly<Record<string, number>> }
export function createHostAction(path: string, options?: HostActionOptions): (action: string, args?: Record<string, unknown>) => Promise<HostResponse>
```

| 项 | 规则 |
|---|---|
| 请求 | `POST`，`credentials: 'same-origin'`，`redirect: 'error'`，`content-type: application/json`，`AbortSignal.timeout(actionTimeouts?.[action] ?? timeoutMs)`（缺省 30000） |
| 同步探测类 action | 返回前要同步等待浏览器探测的 action 单独给 120 秒（探测 45 秒 + 打开页面 60 秒 + 余量）：视频号 `account.probe`、`account.promote`、`collect.start`；小红书 `account.probe`；抖音 `account.probe`、`collect.start`（pending 账号提升时含探测）。预算不足时慢速失败会被页面先截断，真实原因（`probe_failed`）变成 `host_unreachable` |
| 校验 | 响应必须是 JSON 对象且 `status` 为字符串；否则抛 `HostActionError('host_unreachable')` |
| 错误 | `status === 'error'` → `HostActionError(reason ?? 'host_unreachable')` |
| 传输失败 | 超时、网络错误、非 JSON 一律 `HostActionError('host_unreachable')`，不透传原始报文 |

三插件的 `api.ts` 改为 `export const hostAction = createHostAction(HOST_PATH, { actionTimeouts })`（各插件按上表列出自己的同步探测类 action）并保留 `HostResponse` 类型导出；`host_unreachable` 加入各插件 `LOCAL_ERROR_CODES` 与词典。

### 2.6 稳定码新增汇总

| 码 | 位置 |
|---|---|
| `workbench_unauthorized`、`workbench_server_error` | `dsh-workbench-mcp/src/errors.ts` |
| `UNAUTHORIZED` | 小红书 `src/errors.ts`（视频号、抖音已有） |
| `host_unreachable` | 三插件 `src/errors.ts` |

### 2.7 文案回退格式

三插件统一：有映射 → 本地化文案；无映射（只可能是 Host 未登记的新码，运行时防御）→ `error.unknownWithCode`（「未知错误（{code}）」）。抖音的 `domainErrorText(domain, code)` 改为：`code` 为空 → `domain.error.default`；词典已有 `${domain}.error.${code}` 分域文案 → 用它（保持各域页面既有措辞，多个分域对同一码措辞不同的约 10 个码靠这一级恢复各自文案）；否则走统一映射；仍未登记 → `error.unknownWithCode`。统一映射仍是 `Record<StableErrorCode, …>` 穷尽表（编译期保证不能丢码），多域措辞不同的码在其中取中性措辞、只服务不带域的展示路径（如 toast 走的 `reasonText`）。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-workbench-mcp/src/{errors,client,index}.ts` | 新码、状态分类、`tools/list` 刷新、失效重连、关闭失败命名绑定 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-workbench-mcp/tests/{workbench-mcp.test,fixture-workbench-server}.ts` | 新用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/packages/dsh-client-ui-kit/src/{host-action.ts,index.ts}`、`tests/kit.test.tsx` | `createHostAction` | 是 | 第二个消费者出现，必须上移 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/{errors,client/locales}.ts`、`src/client/{api,format,locales}.ts`、`tests/*` | 登记新码、文案、统一映射、`hostAction` 替换 | 是 | 抖音消费面 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/{errors,client/locales}.ts`、`src/client/{api,format,locales}.ts`、`tests/*` | 同上 | 是 | 视频号消费面 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/{errors,client/locales}.ts`、`src/client/{api,format,locales}.ts`、`tests/*` | 同上 | 是 | 小红书消费面 |
| yootun-agent | `yootun/plugins/dsh-media-upload/src/authorize.ts`、`tests/media-upload.test.ts` | `authorizeUpload` 的 catch 识别 `workbench_unauthorized`（与 `workbench_not_activated` / `workbench_tool_denied` 同映射 `uploader_not_configured`）；`workbench_server_error` 落既有 `storage_unavailable`；`src/errors.ts` 只映射服务端业务码，不动 | 是 | 授权失败的原因要准确 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §5.2 | 稳定码表与刷新语义 | 是 | 分册是桌面接入契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §5.2 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-26 | `feat/connector-status-and-error-copy`（基于 `feat/douyin-batch-candidates-live-probe`） | 包内 `test`（workbench-mcp node --test 32 用例；kit vitest 80 用例；抖音 node --test 18 文件、vitest 149 用例；视频号 node --test 5 文件、vitest 99 用例；小红书 node --test 6 文件、vitest 30 用例；media-upload node --test 27 用例）、六个包 `build`、`pnpm run lint`、`typecheck`、三个 verify 脚本与 `test:docs` 通过，验收独立复跑结果一致；真机验收见 5.2 |
| yootun-agent 合入 `main` | 2026-11-26 | `main` | 随 P0 八张批次一并合入（顶点分支 `feat/activation-gate-and-model-catalog`，合并无冲突），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-workbench-mcp test`、`build` 通过；
- [ ] `pnpm --filter @yootun/dsh-client-ui-kit test`、`build` 通过；
- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build`；`pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build`；`pnpm --filter @yootun/dsh-xhs-workbench test`、`build`；`pnpm --filter @yootun/dsh-media-upload test`、`build` 通过；
- [ ] 仓库级：`pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`、`pnpm run verify-empty-catch`；
- [ ] 附录 B 用例全部存在并通过；三插件 `Record<StableErrorCode, …>` 的编译期穷尽检查生效（临时删除一个键应导致 `build` 失败，验证后恢复，记入 5.3）。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| E1 | 在设置页把 Key 换成一个无效值（或临时在服务端吊销），在视频号工作台点刷新 | 提示「密钥无权限或已失效，请到设置重新激活」，不是「网络错误」 |
| E2 | 恢复有效 Key 后再刷新 | 数据正常加载（无需重启） |
| E3 | 停掉本机网络后刷新三个工作台 | 提示网络不可用；恢复网络后刷新即恢复 |
| E4 | 关闭 Host（退出应用）前让页面在请求中 | 不会出现 `SyntaxError` 原文；显示稳定文案 |
| E5 | 触发一次「先清本地再删远端」的逆序操作（远端删除前本地未清） | 文案为「请先清除本地登录信息」而不是「未知错误（LOCAL_CLEARED_REQUIRED）」 |
| E6 | 三个工作台明暗主题 | 新增文案完整可读 |

### 5.3 本地联调记录

SDK 错误类导出核对（`@modelcontextprotocol/client` 2.2.0，按 node_modules 实际类型声明与运行时代码核对）：`UnauthorizedError`（运行时置 `this.name = 'UnauthorizedError'`；401 且无 auth provider 时由 Streamable HTTP transport 抛出）与 `SdkHttpError extends SdkError`（运行时置 `this.name = 'SdkHttpError'`；POST 非 2xx 统一抛出，`get status(): number` 读取 `data.status` 即响应的真实 HTTP 状态码；带 auth provider 重试后的 401 也抛 `SdkHttpError(status: 401)`）。两类错误经 SDK 内部 `markAuthSeamEscape` 时保持对象同一性，`name` 不变，故 `classifyTransportError` 按 `name` + 数字 `status` 判定成立：401/403 → unauthorized、≥500/408/429 → server_error、其余数字状态 → protocol_error、其它（连接被拒、DNS、SDK 内部超时等）→ network_error，不解析 message。

假 server 用例（fixture 增加原始 HTTP 状态故障注入与运行中新增广播工具两个形态）：401/403 → `workbench_unauthorized`，payload 为空、message 不含响应体（K1）；500/503/429 → `workbench_server_error`（K2）；404 → `workbench_protocol_error`，随后下一次调用重新 initialize（以请求计数增量 ≥2 判定重连，K3）；服务端新增工具后，满窗调用先发 `tools/list` 再发 `tools/call` 并成功（K4）；60 秒窗口内第二次未广播调用零请求（K5，经服务构造器注入的可控时钟前拨验证）；连接被拒 → `workbench_network_error` 与既有超时/取消/业务错误/serverName 不匹配用例全部保持通过（K6/K7）。

编译期穷尽检查：三插件 `STABLE_ERROR_CODES` 原以 `Object.freeze([...])` 直接派生类型，数组字面量在泛型推断中放宽为 `string[]`，`StableErrorCode` 实为 `string`，`Record<StableErrorCode, LocaleKey>` 不构成穷尽；已改为 `as const` 值元组加 `Object.freeze([...值元组])` 导出（运行时值不变），`StableErrorCode` 成为真实字面量联合。验证方式：抖音删除 `WORK_NOT_FOUND`、视频号删除 `WORK_NOT_FOUND`、小红书删除 `TASK_NOT_FOUND` 各一处映射键后，各自 `tsc -p tsconfig.json --noEmit` 均以 TS2741/TS1360 失败（exit 2），恢复后通过。类型收紧连带的运行时收敛点两处：抖音 `handlers.ts` 的 `collect.start`（控制器宽字符串 reason 经 `isStableCode` 守卫，未登记值收敛 `collect_busy`）、小红书 `handlers.ts` 的 `account.probe`（经既有 `stableOr` 守卫，未登记值收敛 `PROBE_FAILED`）。

验收返工（2026-11-26 第二轮）：2.3 失效规则补齐刷新路径——`callTool` 的 `tools/list` 刷新与调用共用同一失效判定，刷新遇 401 / 403 / 404 / 410 同样 `invalidate()`（新用例 K8：未广播触发刷新、刷新 401 → `workbench_unauthorized`，下一次调用重新握手）；刷新并发单飞——同一连接已有刷新在途时后到调用共享同一次 `tools/list`（新用例 K9：假 server 对请求注入延迟，两个并发未广播调用只产生一次刷新请求；fixture 增加全请求延迟注入形态）；`refreshedAt` 改为只由缓存服务层盖章（连接时置 0，`open()` 与每次成功刷新后写入，接口 JSDoc 同步）。抖音 `domainErrorText` 按 2.7 修订口径分域优先（K5 用例同时修正为真实建立连接后满窗触发一次刷新），素材页对 `ASYNC_RUN_NOT_FOUND` / `PROVIDER_ERROR` / `ONEAPI_BUDGET_EXHAUSTED` / `DOUYIN_TOOL_UNAVAILABLE` 恢复本域措辞，统一表新增中性键 `reason.ASYNC_RUN_NOT_FOUND`；会话状态上报链路五条文案（`stale_report` / `session_report_rejected` / `already_ok` / `remote_account_unavailable` / `profile_unverified`）按 `reportSessionStatus` / `reportSessionOkAfterCollect` 实际触发场景改写（zh / en 成对）。码集合去重：抖音 `LOCAL_ERROR_CODES` 不再二次展开连接器码（运行时码集不变），视频号 `STABLE_ERROR_CODES` 对服务端与本域同码的 `LOCAL_CLEARED_REQUIRED` 去重，三插件各加「`STABLE_ERROR_CODES` 与 `LOCAL_ERROR_CODES` 无重复元素」断言。

健壮性返工（2026-11-26 第三轮）：单飞刷新的后到调用方不再继承首发调用方的取消与超时——此前 `refreshToolNames` 让后到者直接返回在途 Promise，悬挂刷新被首发调用方取消时未取消的后到者同样得到 `workbench_call_cancelled`；现在后到者在共享刷新以取消 / 超时收尾且自身未取消时，以自己的剩余预算（传入预算减去加入后经过的墙钟，`client.ts` 无时钟注入缝、以 `Date.now()` 计量）重试且仅重试一次，传输层投影仍由所有等待者原样共享（新用例 K10：首发取消后 A 得 `workbench_call_cancelled`、B 以 `workbench_tool_unavailable` 收尾，两次 `tools/list`、零次 `tools/call`；SDK 对被中止的在途请求按协议补发一条 `notifications/cancelled` POST，请求计数按 3 断言）。`callTool` 第 4 步刷新在途未做失效自检——悬挂刷新期间 `dispose` 或凭证更新会让调用方得到误导性的 `workbench_network_error`，成功分支还会给已失效连接盖 `refreshedAt` 并在关闭的连接上继续 `tools/call`；现在刷新返回后与 catch 入口都先判 `stopped` / 连接同一世代，不成立即抛 `workbench_unavailable`（与 `open()` 在途失效同口径），不盖 `refreshedAt`、不发 `tools/call`、不走失效重连判定（新用例 K11：卸载与凭证更新两个子场景各断言 `workbench_unavailable` 且零新增 `tools/call`，凭证更新后下一次调用以请求计数增量 ≥ 2 重新握手）。

## 附录 A：逐文件规格

### A1 `dsh-workbench-mcp/src/errors.ts`

- `WorkbenchErrorCode` 增 `'workbench_unauthorized'`、`'workbench_server_error'`；`'workbench_protocol_error'` 注释补「其它 4xx」；
- 新增 `export function classifyTransportError(error: unknown): WorkbenchErrorCode`：`error.name === 'UnauthorizedError'` → unauthorized；`error.name === 'SdkHttpError'` 且 `typeof error.status === 'number'`：401/403 → unauthorized，≥500 或 408/429 → server_error，其余 → protocol_error；`AbortError` / `TimeoutError` → 交调用方按超时/取消判定（本函数只在调用方排除超时与取消后使用）；其它 → network_error。不解析 `message`。

### A2 `dsh-workbench-mcp/src/client.ts`

- `connectWorkbench` / `callTool` 的 catch：先判调用方取消与超时，再用 `classifyTransportError`；
- `WorkbenchConnection.toolNames` 改为内部可更新：接口字段保持 `ReadonlySet`，新增 `refreshToolNames(connection, timeoutMs, signal): Promise<void>`（就地替换集合）；
- `closeClient` 的 catch 绑定改 `_closeFailed`，注释「transport 已关闭或对端先断开时 close 抛错；连接对象随后丢弃」。

### A3 `dsh-workbench-mcp/src/index.ts`

- `callTool` 第 4 步：`!connection.toolNames.has(name)` 且 `now - connection.refreshedAt >= 60_000` → `await refreshToolNames(...)`，再判定；仍不在 → `workbench_tool_unavailable`；
- 第 5 步 catch：投影为 `workbench_unauthorized` 或 `workbench_protocol_error` 且 `status ∈ {404, 410}` 时 `void this.invalidate()`（世代号自检保证在途 open 产物不进缓存）；
- `connection.refreshedAt` 在 `open()` 成功时置为当前时间。

### A4 三插件 `src/errors.ts`

- 抖音：`WORKBENCH_ERROR_CODES` 补两个新码（类型约束已强制）；
- 视频号：`safeCode` 增显式投影 `workbench_unauthorized → 'UNAUTHORIZED'`、`workbench_server_error → 'WX_TOOL_UNAVAILABLE'`；`LOCAL_ERROR_CODES` 增 `host_unreachable`；
- 小红书：`LOCAL_ERROR_CODES` 增 `UNAUTHORIZED`、`host_unreachable`；`localErrorCode` 增同样两条投影；
- 抖音：`LOCAL_ERROR_CODES` 增 `host_unreachable`。

### A5 三插件 `src/client/format.ts` 与 `locales.ts`

- 视频号、小红书：`REASON_KEYS: Readonly<Record<StableErrorCode, LocaleKey>> = { ... } satisfies Readonly<Record<StableErrorCode, LocaleKey>>`（类型从 `../errors.ts` 以 `import type` 引入）；词典为每个码提供 `reason.<CODE>`（zh / en 成对）；
- 抖音：新增 `REASON_KEYS: Readonly<Record<StableErrorCode, DouyinLocaleKey>>`；`domainErrorText` 改为 `code === null/'' → domain.error.default`，词典已有 `${domain}.error.${code}` → 用它，否则 `t(REASON_KEYS[code])`，仍未登记 → `error.unknownWithCode`（2.7 修订口径）；
- 回退：映射表类型穷尽后运行时不可能缺键；仍保留 `error.unknownWithCode` 作为防御分支（`REASON_KEYS[code] ?? t('error.unknownWithCode', { code })`）；
- 文案口径（三插件一致）：`UNAUTHORIZED` / `workbench_unauthorized` → 「密钥无权限或已失效，请到设置重新激活」；`workbench_server_error` → 「服务暂时不可用，请稍后重试」；`host_unreachable` → 「无法连接本地服务，请重启应用」；`LOCAL_CLEARED_REQUIRED` → 「请先清除本地登录信息，再删除远端账号」；`IDEMPOTENCY_IN_PROGRESS` → 「上一次操作仍在处理，请稍后查询结果」；`IDEMPOTENCY_OUTCOME_UNKNOWN` → 「无法确认上一次操作的结果，请刷新后核对，不要重复提交」；`IDEMPOTENCY_CONFLICT` → 「操作与上一次提交的内容不一致，请刷新后重试」。

### A6 `dsh-client-ui-kit/src/host-action.ts`

- 按 2.5 实现；`HostResponse` 接口 `{ status: string; reason?: string } & Record<string, unknown>`；
- `index.ts` 导出 `createHostAction`、`HostActionError`、`HostActionError` 类型、`HostResponse`；
- kit 无 Host 依赖，保持纯 client 库。

### A7 `dsh-media-upload/src/authorize.ts`

- `authorizeUpload` 的 catch：`workbench_unauthorized` 与 `workbench_not_activated`、`workbench_tool_denied` 同样映射为 `uploader_not_configured`；`workbench_server_error` 与网络错误同映射为 `storage_unavailable`。

## 附录 B：测试矩阵

### B.1 连接器（`tests/workbench-mcp.test.ts`，假 server `fixture-workbench-server.ts`）

| ID | 断言 |
|---|---|
| K1 | 假 server 返回 401 / 403 → `workbench_unauthorized`，不带 payload，message 不含响应体 |
| K2 | 假 server 返回 500 / 503 / 429 → `workbench_server_error` |
| K3 | 假 server 返回 404 → `workbench_protocol_error`，随后连接被失效，下一次调用重新 `initialize` |
| K4 | 域内工具未广播 → `workbench_tool_unavailable`，不发 `tools/call`；假 server 随后新增该工具，下一次调用先发 `tools/list` 再发 `tools/call` 并成功 |
| K5 | 60 秒内连续两次未广播 → 只发一次 `tools/list`（注入时钟） |
| K6 | 连接被拒（假 server 未启动）→ `workbench_network_error` |
| K7 | 既有超时 / 取消 / 业务错误 / serverName 不匹配用例不变 |

### B.2 kit（`tests/kit.test.tsx`）

| ID | 断言 |
|---|---|
| T1 | 2xx + `{ status: 'ok' }` → 返回载荷 |
| T2 | `{ status: 'error', reason: 'X' }` → `HostActionError.code === 'X'` |
| T3 | 非 JSON / 空体 / `status` 非字符串 → `host_unreachable` |
| T4 | 超时（注入短超时 + 挂起的 fetch）→ `host_unreachable` |
| T5 | 请求头、`credentials`、`redirect` 与 2.5 一致 |
| T6 | `actionTimeouts` 中列出的 action 使用其预算（注入短值 + 挂起的 fetch，断言在预算内不抛、超过预算抛 `host_unreachable`）；未列出的 action 使用缺省预算 |

### B.3 三插件

| ID | 断言 |
|---|---|
| P1 | `safeCode` / `localErrorCode` 对连接器新码与 `host_unreachable` 的投影（逐码） |
| P2 | `reasonText` / `domainErrorText` 对每个稳定码返回词典文案；`code === null` 返回默认文案 |
| P3 | 词典 zh / en 键集一致；`verify-client-ui-i18n` 通过 |
| P4 | 既有 `hostAction` 相关用例替换为 kit 实现 |
