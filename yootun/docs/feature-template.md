# <工作台或 infra>-<特性名> 实施单

状态：草案 ｜ 创建：YYYY-MM-DD ｜ 流程依据：[cross-repo-sync.md](cross-repo-sync.md)

## 1. 范围

做：

- 待填

不做：

- 待填

## 2. 契约增量

按 tools.dofe.ai `docs/1116/yootun-mcp.md` 的命名规范填写；无新增工具时写"无"。

| 面 | 工具名 | 入参 | 出参 | 错误码 | 读/写 | 进普通会话 |
|---|---|---|---|---|---|---|
| Workbench / Agent | `workbench_<domain>_<capability>` | | | | | 是 / 否 |

tools 契约文档对齐：`docs/1116/yootun-mcp.md` §＿（已同步 / 待同步，日期）。

## 3. 影响面

从 [速查表](cross-repo-sync.md#三速查表改-x-要动哪几个仓) 复制相关行；"不改"也要写并给依据。

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | `src/tools_dofe/mcp/domains/yootun/…` | | | |
| tools.dofe.ai | `docs/1116/yootun-mcp.md` | | | |
| docker-helm.dofe.ai | `runtime/mcp-gateway/route-registry.yml` / `nginx/` / `docker-compose.yml` | | | 默认不改；新路由/队列/env 才改 |
| yootun-agent | `yootun/plugins/<插件>/src/…` | | | |
| yootun-agent | `yootun/docs/1110/<分册>.md` | | | |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| tools 合入 `dev` | | | |
| docker-helm 部署测试环境 | | | |
| yootun-agent 合入 `main` | | | |
| 发版 | | | |

## 5. 验收

- [ ] tools：`pytest` 相关域 + 本地 `tools/list` 核对契约；
- [ ] docker-helm：测试环境 `curl tools/list`，路由可达；
- [ ] yootun-agent：受影响包 `pnpm --filter <pkg> test`、`build`；本地三仓 e2e；
- [ ] 真机：三入口、明暗主题、三档宽度（UI 变更时）；
- [ ] 实施单第 4 节回填完整。
