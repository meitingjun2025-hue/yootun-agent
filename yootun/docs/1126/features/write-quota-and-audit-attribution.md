# tools-审计归因（含写操作配额与多租户收据的暂缓决策） 实施单

状态：tools 侧已合入 `dev`（2026-11-27），测试环境部署待填 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

- **审计日志没有调用方身份。** tools 的 `log_mcp_audit`（`src/tools_dofe/mcp/core/observability.py`）每条记录只有 domain、tool、request_id、trace_id、result_code、耗时与少量业务 ID。请求上下文里其实有完整的网关身份（`McpGatewayIdentity`：`api_key_id`、`tenant_id`、`sso_team_id`、`principal_type` / `principal_id`、`member_id`、`key_owner_type`），但一个也没进审计行。排查「谁触发了这次发布排期修改 / 素材入库 / 关键词检索」时，只能靠时间与 request_id 去网关日志里反查。
- **写操作没有按调用方的配额。** 同步写只有 `MCPMutationRecord` 幂等收据防重放；同一把 key 可以在短时间内无限次发起写与任务型调用。
- **nginx 入口现在无法按 key 限流。** MCP 网关容器的每个 location 先 `auth_request /_models_mcp_auth`，再用 `auth_request_set $mcp_key_id …` 取 key id（`docker-helm.dofe.ai/runtime/mcp-gateway/mcp-context.inc.template`）。`auth_request` 在 access 阶段执行，`limit_req` 在 preaccess 阶段执行，按 key 分桶的 `limit_req` 拿不到 key id；只按客户端 IP 做粗粒度限制会误伤共享出口的办公网络。
- **幂等收据的唯一索引不含租户。** `MCPMutationRecord` 的唯一索引是 `(operation, idempotency_key_digest)`（`src/tools_dofe/models/entities.py`）。只有一个租户时没有问题；接入第二个租户后，两个租户用相同的幂等键调用同一操作，后到者会拿到先到者的收据。

### 0.2 目标

本期只做与网关迁移无关、现在就能成立的部分：审计行带上调用方身份。写操作配额、nginx 限流与多租户收据不在本期落地，但把判断依据与落地形态写清楚，作为网关从 ixicai 迁移、按用户 key 隔离并加入团队时的输入。

## 1. 范围

做：

- tools：`log_mcp_audit` 为每条审计行附加调用方身份字段；更新可观测性测试；契约文档 §7 增加对应条款。

不做（本期）：

- 写操作配额：应用层与 nginx 层都不做，随网关迁移决策（设计输入见附录 A）；
- Workbench 面 scope：随网关迁移；
- 多租户幂等收据隔离：接入第二个租户之前必须单独建单落地（见附录 B）；
- 不新建审计存储，不采集 Bearer、密钥、其哈希或委托引用；
- 不改 docker-helm；
- yootun-agent 本单无改动。

## 2. 契约增量

MCP 工具：无。工具名、入参、出参与错误码都不变。

### 2.1 审计行字段

`log_mcp_audit` 输出的 JSON 增加下列键，每条都有（无身份时为 `null`）：

| 键 | 来源 | 说明 |
|---|---|---|
| `api_key_id` | `McpGatewayIdentity.api_key_id` | 网关分配的不透明标识，不是凭证；原样记录以便与网关日志关联 |
| `tenant_id` | `McpGatewayIdentity.tenant_id` | 租户 |
| `principal_type` / `principal_id` | 同名 | 调用主体 |
| `key_owner_type` | `McpGatewayIdentity.key_owner_type` | key 归属类型 |
| `delegated` | `identity.mcp_delegation_ref` 非空 | 是否经委托身份调用 |

规则：

- 身份字段在调用方的 `extra` 合并之后写入，调用方无法覆盖；
- 不记录 `models_api_key`、`token_hash`、`sso_team_id`、`member_id`、`models_base_url`、委托引用：前两项是密钥与其派生值，其余与归因无关；
- 请求没有网关身份（内部迁移流量、测试直连）时五个字段为 `null`，`delegated` 为 `false`。

### 2.2 tools 契约文档

`docs/1116/yootun-mcp.md` §7 第 4 条之后增加一条：

> 每条审计行必须附带调用方身份字段（`api_key_id`、`tenant_id`、`principal_type`、`principal_id`、`key_owner_type`、`delegated`），取自共享网关注入的可信身份；不得记录 Bearer、密钥或其哈希。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | `src/tools_dofe/mcp/core/observability.py` | `log_mcp_audit` 附加身份字段；模块头注释同步 | 是 | 本单主体 |
| tools.dofe.ai | `tests/mcp/test_mcp_observability.py` | 新增用例 | 是 | 行为随实现变更 |
| tools.dofe.ai | `docs/1116/yootun-mcp.md` §7 | 身份字段条款 | 是 | 审计契约记录 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由与配置变化；日志采集若按字段白名单提取，需在部署时把新键加入白名单（见 5.3） |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 契约 §7 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | 2026-11-27 | tools 仓 `feat/mcp-audit-identity` | 已合入 `dev`；合入前验收见 5.1：observability 8 例全过、mcp 套件 512 过（38 个 error 为既有 real-SDK 探针环境依赖，干净树复现一致）；密钥字段 grep 仅注释命中 |
| docker-helm 部署测试环境 | | | 待填（含日志字段白名单核对结果） |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] tools：`pytest tests/mcp/test_mcp_observability.py` 与附录 C 涉及的域测试通过；
- [ ] tools：全量 `pytest` 不受影响；
- [ ] `grep -rn "models_api_key\|token_hash" src/tools_dofe/mcp/core/observability.py` 只出现在「不记录」的注释里。

### 5.2 测试环境验收（开发侧执行）

| # | 步骤 | 预期 |
|---|---|---|
| G1 | 用一把已激活的 key 经网关调用任一只读工具与任一写工具 | 两条审计行都带正确的 `api_key_id`、`tenant_id`、`principal_*`、`key_owner_type`，`delegated` 与调用方式一致 |
| G2 | 用另一把 key 重复 G1 | 两次审计行的 `api_key_id` 不同，可据此区分调用方 |
| G3 | 在网关与日志采集链路上检索 `api_key_id` 的值 | 能定位到对应审计行；日志里检索不到 Bearer 与密钥 |

### 5.3 本地联调记录

待填（合入前回填；记录日志采集配置是否按字段白名单提取，若是，新键是否已加入）。

## 附录 A：写操作配额（暂缓，网关迁移时的设计输入）

### A.1 判断顺序

网关迁移方案评审时依次回答：

1. 新网关是否提供按 key 的限流，且能在路由或工具粒度上配置？是 → tools 不做配额，只在客户端处理新网关返回的限流响应；否 → 进入第 2 步；
2. 是否需要按「工具类别」区别对待（例如销毁类与任务派发类严、入库类宽）？否 → 新网关或 nginx 做单一的按 key 限流即可；是 → 进入第 3 步；
3. 在 tools 应用层实现下面的 `WriteQuotaMiddleware`。

### A.2 应用层配额的形态（若需要）

- 位置：`McpGateway.build_app` 的中间件链最外层，在 `UnknownArgsGuardMiddleware` 之前；
- 只对 `tools/call` 生效；只读工具直接放行，不产生 Redis 往返；
- 工具类别：`destructive`（删除、排除）/ `mutate`（保存、更新、入库）/ `dispatch`（启动采集、拆解、报表、检索等会产生任务或费用的调用）；类别表与 tools 的 `service_policies.py` 读写标记同源，不另抄一份；
- 计数：Redis 固定窗口，键 `mcp:wq:{tenant_id}:{api_key_id}:{bucket}:{窗口序号}`，`INCR` + 首次 `EXPIRE`；各桶上限来自 settings；
- 超限：返回 JSON-RPC `tool_error` 信封，稳定码 `RATE_LIMITED`，带 `retryAfterSeconds`（秒），并设 `Retry-After` 响应头；
- 故障策略：Redis 不可用时放行并计数告警（fail-open），写操作因限流组件故障而整体不可用比短暂超量更糟；
- 请求体只读一次：请求体缓冲、未知参数校验与配额三处中间件共用 `scope["state"]` 里的一份字节与解析结果，`unknown_args_guard.py` 的 `_drain_body` / `_replay` 提取为共享模块；
- 客户端（yootun-agent）：把 `RATE_LIMITED` 映射为「操作过于频繁，请在 N 秒后重试」，并把触发按钮禁用 `retryAfterSeconds`；该映射在配额落地时随同一实施单的 yootun-agent 部分交付。

### A.3 nginx 层

在现有拓扑下只能做按 location 的粗粒度限制，不做。若迁移后的网关把 key 解析前移到 preaccess 之前，再评估 `limit_req` 按 key 分桶。

## 附录 B：多租户幂等收据（接入第二租户前必须落地）

- 风险：唯一索引 `(operation, idempotency_key_digest)` 下，租户 B 用与租户 A 相同的幂等键调用同一操作，命中 A 的收据并拿到 A 的响应内容；
- 两种落地形态，建单时二选一：
  1. 加 `tenant_id` 列并回填现有行，唯一索引改为 `(tenant_id, operation, idempotency_key_digest)`；
  2. 把租户并入摘要输入（`sha256(tenant_id + ':' + operation + ':' + key)`），不改表结构；切换时存量收据全部失配，切换窗口内同一幂等键可被重放一次；
- 倾向第 1 种：不产生重放窗口，且收据可按租户查询与清理；
- 触发条件：出现第二个租户的接入排期。届时单独建单，包含数据迁移与回归测试。

## 附录 C：测试矩阵（本期）

| ID | 断言 |
|---|---|
| O1 | 上下文有身份时，审计行含 2.1 的六个字段且取值正确 |
| O2 | 上下文无身份时，五个字段为 `null`，`delegated` 为 `false` |
| O3 | 调用方 `extra` 里带同名字段（如 `api_key_id`）时，最终值以身份为准 |
| O4 | 审计行文本中不出现 `models_api_key`、`token_hash`、`sso_team_id`、`member_id` 的值 |
| O5 | 经 `with_db` 的同步 handler 路径（线程池执行）同样带身份字段 |
| O6 | `yootun-workbench` 域任一写工具执行后，审计行带身份 |
| O7 | 既有可观测性用例不变 |
