# infra-workbench-连接器状态分类与错误码文案闭环 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

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

`callTool` 在域门通过、`connection.toolNames.has(name)` 为 false 时：若该连接距上次刷新 ≥ 60 秒，则对 `connection.client` 调一次 `listTools`（带本次调用剩余的超时预算），成功则就地更新 `toolNames` 后重新判定；刷新失败按 2.1 投影；60 秒内已刷新过的，直接返回 `workbench_tool_unavailable`。

### 2.3 失效后的重连

`workbench_unauthorized` 与 `workbench_protocol_error`（404 / 410）发生后调用一次 `invalidate()`，使下一次调用重新连接（服务端为无状态 Streamable HTTP，重连无副作用）；写操作不自动重试。

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

三插件统一：有映射 → 本地化文案；无映射（只可能是 Host 未登记的新码，运行时防御）→ `error.unknownWithCode`（「未知错误（{code}）」）。抖音的 `domainErrorText(domain, code)` 改为：`code` 为空 → `domain.error.default`；否则走统一映射（不再按域分表）。

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
| yootun-agent | `yootun/plugins/dsh-media-upload/src/errors.ts` | `workbench_unauthorized` → `uploader_not_configured` 的映射补齐（现只识别 `workbench_not_activated` / `workbench_tool_denied`） | 是 | 授权失败的原因要准确 |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §5.2 | 稳定码表与刷新语义 | 是 | 分册是桌面接入契约记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 08 册 §5.2 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/connector-status-and-error-copy` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
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

待填（合入前回填：SDK 错误类导出核对、假 server 的 401/500/新增工具刷新用例、编译期穷尽检查验证）。

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
- 抖音：新增 `REASON_KEYS: Readonly<Record<StableErrorCode, DouyinLocaleKey>>`；`domainErrorText` 改为 `code === null → domain.error.default`，否则 `t(REASON_KEYS[code])`；
- 回退：映射表类型穷尽后运行时不可能缺键；仍保留 `error.unknownWithCode` 作为防御分支（`REASON_KEYS[code] ?? t('error.unknownWithCode', { code })`）；
- 文案口径（三插件一致）：`UNAUTHORIZED` / `workbench_unauthorized` → 「密钥无权限或已失效，请到设置重新激活」；`workbench_server_error` → 「服务暂时不可用，请稍后重试」；`host_unreachable` → 「无法连接本地服务，请重启应用」；`LOCAL_CLEARED_REQUIRED` → 「请先清除本地登录信息，再删除远端账号」；`IDEMPOTENCY_IN_PROGRESS` → 「上一次操作仍在处理，请稍后查询结果」；`IDEMPOTENCY_OUTCOME_UNKNOWN` → 「无法确认上一次操作的结果，请刷新后核对，不要重复提交」；`IDEMPOTENCY_CONFLICT` → 「操作与上一次提交的内容不一致，请刷新后重试」。

### A6 `dsh-client-ui-kit/src/host-action.ts`

- 按 2.5 实现；`HostResponse` 接口 `{ status: string; reason?: string } & Record<string, unknown>`；
- `index.ts` 导出 `createHostAction`、`HostActionError`、`HostActionError` 类型、`HostResponse`；
- kit 无 Host 依赖，保持纯 client 库。

### A7 `dsh-media-upload/src/errors.ts` 与 `authorize.ts`

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
