# infra-workbench 白名单域级放行与 Agent 未分类转 ask 实施单

状态：文档已落地，代码待实施 ｜ 创建：2026-11-24 ｜ 流程依据：[cross-repo-sync.md](../cross-repo-sync.md) 第二节

## 1. 范围

做：

- `@yootun/dsh-workbench-mcp`：删除 94 项工具名清单与连接时 `tools/list` 子集校验，改为 `CALLER_DOMAINS` + `workbench_<domain>_` 前缀放行；新增稳定码 `workbench_tool_unavailable`；
- `@yootun/dsh-managed-mcp`：guard 对未分类 `yootun_*` 工具由 `deny` 改为 `ask`；`READ_TOOLS` / `TASK_WRITE_TOOLS` 内容不变；
- 三个插件的测试与注释去计数化；
- docker-helm 三处手抄计数清理（可选，独立提交）。

不做：

- 不改 Agent 面工具注册方式（官方 `dsh-mcp-client` 仍注册服务端全部工具）；
- 不改 `yootun-workbench` / `yootun-catalog` 在普通会话的 `deny`；
- 不改 `CALLER_DOMAINS` 的值；
- 不新增脚本、gate 或生成文件。

## 2. 契约增量

无新增或变更工具。行为变更：

| 面 | 场景 | 原行为 | 新行为 |
|---|---|---|---|
| Workbench | 连接 | serverName 校验 + 白名单子集校验（缺任一项拒连） | 仅 serverName 校验 |
| Workbench | 调用工具 | 名单内且 caller 域内才放行 | 名为 `workbench_<d>_*` 且 `d` 在 caller 域内即放行 |
| Workbench | 通过域门但服务端未广播 | 不存在该场景（连接已被拒） | 返回 `workbench_tool_unavailable`，不发请求 |
| Agent | 调用未分类 `yootun_*` | `deny` | `ask` |

tools 契约文档对齐：无工具变更，不需同步 `docs/1116/yootun-mcp.md`。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无工具变更 |
| docker-helm.dofe.ai | `runtime/mcp-gateway/route-registry.yml` notes、`AGENTS.md`、`CLAUDE.md` | 删 39/94/133 计数，留"以 tools 文档为准" | 可选 | 纯手抄，无功能意义 |
| yootun-agent | `yootun/plugins/dsh-workbench-mcp/src/{whitelist,client,index,errors}.ts` | 见附录 A1–A4 | 是 | 速查表"纯本地能力"行的插件内部改造 |
| yootun-agent | `yootun/plugins/dsh-workbench-mcp/tests/*` | 见附录 A5 | 是 | 计数断言与缺项拒连用例随行为变更 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/{index,guard}.ts` | 见附录 A6–A7 | 是 | 未分类转 ask |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/tests/*` | 见附录 A8 | 是 | 计数断言去字面量 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/host.test.ts` | 见附录 A9 | 是 | 引用了被删除的 `WORKBENCH_GROUP_TOOLS` |
| yootun-agent | `yootun/docs/1110/08-plugin-mcp.md` §4.3 / §5.2 / §12.2 | 行为描述改为目标态 | 是（已随本文落地） | 分册是桌面接入契约记录 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + cross-repo-sync + 08 册 + OVERVIEW） | 2026-11-24 | `main` | — |
| 代码：dsh-workbench-mcp / dsh-managed-mcp / douyin host.test | 待 | | 由 Claude 按附录实施，验证见第 5 节 |
| docker-helm 计数清理 | 待 | `master` | 可选 |
| 发版 | 待 | | 随下一个 yootun 版本 |

## 5. 验收（验证方逐项核对）

- [ ] `pnpm --filter @yootun/dsh-workbench-mcp test` 全过；测试文件中无 `94`、`19`、`55` 等工具数量字面量；
- [ ] `pnpm --filter @yootun/dsh-managed-mcp test` 全过；无 `39` 字面量；
- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test` 全过；
- [ ] 三个包 `build` 通过（tsc + tsdown）；
- [ ] `pnpm run lint` 对改动文件无新告警；
- [ ] `whitelist.ts` 不含任何 `workbench_*` 工具名字面量（除前缀常量 `workbench_`）；
- [ ] `client.ts` 的 `connectWorkbench` 不再出现 `missing` / 子集校验；serverName 校验保留；
- [ ] `index.ts` 的 `callTool`：域门外 → `workbench_tool_denied`；域门内未广播 → `workbench_tool_unavailable`；两者都不发请求；
- [ ] `dsh-managed-mcp/src/index.ts` 的 `sessionGuard`：`unknown` → `ask`；Workbench/Catalog serverName 仍 `deny`；
- [ ] 三个工作台 Host 与 media-upload 的源码无需改动即通过类型检查（它们只依赖 `WorkbenchDomain` / `WorkbenchCaller` / `ToolCallOutcome` 类型）。

## 附录 A：逐文件规格

### A1 `yootun/plugins/dsh-workbench-mcp/src/whitelist.ts`

- 保留 `WorkbenchDomain`、`WorkbenchCaller` 类型与 `CALLER_DOMAINS`（值不变）；
- 删除 `WX_TOOLS` / `XHS_TOOLS` / `DOUYIN_TOOLS` / `VIRAL_TOOLS` / `TOS_TOOLS`、`WORKBENCH_GROUP_TOOLS`、`WORKBENCH_TOOL_WHITELIST`、`allowedToolsFor`；
- 新增 `export const WORKBENCH_TOOL_PREFIX = 'workbench_'`；
- 新增 `export function domainOf(name: string): WorkbenchDomain | undefined`：`name` 以 `WORKBENCH_TOOL_PREFIX` 开头，其后到下一个 `_` 的段是五个域之一，且该段之后还有非空字符；多段 rest（如 `publish_schedule_row_create`）只按第一个 `_` 切分；不满足任一条件返回 `undefined`；
- 新增 `export function isAllowedFor(caller: WorkbenchCaller, name: string): boolean`：`domainOf(name)` 非空且属于 `CALLER_DOMAINS[caller]`；
- 文件头注释改写：说明域级放行、yootun-agent 不持有 Workbench 工具名清单、工具名以 tools.dofe.ai `docs/1116/yootun-mcp.md` 为准；不出现工具数量。

### A2 `yootun/plugins/dsh-workbench-mcp/src/errors.ts`

- 稳定码联合类型新增 `'workbench_tool_unavailable'`，注释："工具通过域门，但服务端 `tools/list` 未广播（服务端未部署该版本或已移除）"；
- 既有码与 `safeCode` 等映射同步补入该码。

### A3 `yootun/plugins/dsh-workbench-mcp/src/client.ts`

- `connectWorkbench`：保留 serverName 校验与 `workbench_protocol_error`；删除 `advertised` / `missing` 子集校验块；仍返回 `{ client, toolNames: advertised }`，其中 `advertised` 为 `tools/list` 名称集合，供调用时判断可用性；
- JSDoc：删除 "subset tools/list contract" 与 "a whitelisted tool is missing" 表述，改为 "server identity check; advertised names are returned for the call-time availability check"。

### A4 `yootun/plugins/dsh-workbench-mcp/src/index.ts`

- 删除 `callerTools` 缓存字段及其填充逻辑；
- `callTool(caller, domain, name, args, signal)`：
  1. `isAllowedFor(caller, name)` 为 `false` → 抛 `workbench_tool_denied`；
  2. 取得连接后、发请求前，`connection.toolNames.has(name)` 为 `false` → 抛 `workbench_tool_unavailable`，不发请求；
  3. 其余（超时、取消、结果投影）不变；
- `domain` 参数保留只为 Host 调用签名兼容，不参与放行判断；放行只看 `name`；
- import 与 re-export：删除 `allowedToolsFor` / `WORKBENCH_GROUP_TOOLS` / `WORKBENCH_TOOL_WHITELIST`，新增 `domainOf` / `isAllowedFor` / `WORKBENCH_TOOL_PREFIX`；
- 第 112–124 行附近的中文注释同步改写，不出现"白名单内/外"的名单语义。

### A5 `yootun/plugins/dsh-workbench-mcp/tests/*`

- `fixture-workbench-server.ts`：工具集缩为每域 3 个（wx / xhs / douyin / viral / tos），保留现有承担业务错误、超时、协议错误路径的特殊工具；不再 import 白名单；头注释去计数；
- `workbench-mcp.test.ts`：
  - 删除：`WORKBENCH_TOOL_WHITELIST.size === 94`、分组 `19/19/33/22/1`、`allowedToolsFor` 的 `19/19/55/1`、"缺项拒绝连接"用例；
  - 新增结构用例：`CALLER_DOMAINS` 恰为 4 个 caller；每个 caller 的域均为合法域；`douyin-workbench` 含 `viral` 且其他 caller 不含；`media-upload` 仅 `tos`；`wx-workbench` / `xhs-workbench` 各仅自身域；
  - 新增 `domainOf` 用例：五个前缀各解析正确；`workbench_douyin_publish_schedule_row_create` → `douyin`；`workbench_wx_`（空 rest）、`workbench_wx`（无 rest 段）、`workbench_foo_x`（未知域）、`yootun_wx_x`（非 workbench 前缀）、`''` 均 `undefined`；
  - 新增调用用例：同域放行且假 server 收到请求；跨域（xhs caller 调 `workbench_douyin_*`）→ `workbench_tool_denied` 且假 server 未收到；域内但假 server 未广播（如 `workbench_wx_not_deployed_yet`）→ `workbench_tool_unavailable` 且假 server 未收到；假 server 多广播工具不影响连接与其他调用；serverName 不匹配 → `workbench_protocol_error`；
  - 保留：超时 / 取消 / 业务错误 / 协议错误投影、credential 变更后缓存失效、dispose 清理。

### A6 `yootun/plugins/dsh-managed-mcp/src/index.ts`

- `sessionGuard` 的 `unknown` 分支（原第 56 行）：`deny` → `ask`，`reason` 与 `displayReason.en` 为 `yootun agent tool "${rawName}" is not yet classified; confirm before use`；
- 文件头注释第 7–8 行与 `sessionGuard` JSDoc："unknown yootun tools deny" → "unknown yootun tools ask"；
- `FORBIDDEN_SERVER_NAMES` 的 `deny` 分支不变。

### A7 `yootun/plugins/dsh-managed-mcp/src/guard.ts`

- 文件头注释：删除"39 项"；说明两张表是"已分类的免审批 / 固定审批名单，未分类工具由 guard 以 `ask` 交人工确认"；
- `AGENT_TOOL_NAMES` 的 JSDoc 改为 "The currently classified Agent tool names (read + task-write); fixture servers and registration assertions consume it"；
- 两个集合内容不变。

### A8 `yootun/plugins/dsh-managed-mcp/tests/*`

- `managed-mcp.test.ts`：`AGENT_TOOL_NAMES.length === 39` → `=== new Set(AGENT_TOOL_NAMES).size` 且 `> 0`；所有 `length === 39` → `length === AGENT_TOOL_NAMES.length`；用例标题去掉"39 项"；
- 新增用例：未分类的 `yootun_*` 工具经 `sessionGuard` 返回 `ask`；`yootun-workbench` / `yootun-catalog` 面仍 `deny`；非 yootun 工具名透传到 `next()`；
- `fixture-agent-server.ts` 头注释去"39 项"。

### A9 `yootun/plugins/dsh-douyin-workbench/tests/host.test.ts`

- 删除 `WORKBENCH_GROUP_TOOLS` import；
- 原用例改为：Host 侧出现的每个字面量工具名满足 `isAllowedFor('douyin-workbench', name)`（import 自 `@yootun/dsh-workbench-mcp`）。

### A10 docker-helm.dofe.ai（可选，独立提交）

- `runtime/mcp-gateway/route-registry.yml`：三条 `/mcp/tools/yootun/v1/*` 路由 `notes` 中的计数删除，保留读写属性描述，追加一句"工具清单以 tools.dofe.ai `docs/1116/yootun-mcp.md` 为准"；
- `AGENTS.md`、`CLAUDE.md`：删除 39 / 94 / 133 计数句，改为同样的指向。
