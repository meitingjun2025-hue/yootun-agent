# managed-mcp-状态路由注册 实施单

状态：开发完成（2026-11-28，自动验收通过），待真机验收 ｜ 创建：2026-11-28 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

来源：2026-11-28 用户在客户端「设置 → Yootun 接入」看到「智能体工具」一行显示「未加载，请重启应用」，而会话与三个工作台功能正常。根因与修复方案于 2026-11-28 经用户确认，修复在 `main` 上实施。

## 1. 范围

做：

- `yootun-managed-mcp` 的状态路由 `POST /api/desktop/yootun/agent-status` 改为随 `webServer` 的可用性注册：服务就绪后注册，服务变化时在新实例上重新注册。
- 补组合层回归用例：`webServer` 晚于插件就绪、`webServer` 先于插件就绪、`webServer` 被替换三种时序。

不做：

- `inject` 不加 `webServer`，不把它变成必选依赖：没有 `webServer` 的组合里，监督器与会话守卫照常加载。
- 设置页文案「未加载，请重启应用」：路由可达后，它只在插件不在组合里时出现。
- 监督器、会话守卫、路由的路径、信任判定、请求与响应字段。
- tools.dofe.ai、docker-helm.dofe.ai 的任何改动。

## 2. 契约增量

MCP 工具、Host action、路由路径、请求与响应、稳定码：无变化。

### 2.1 状态路由的注册时机

路由由 `yootun-managed-mcp` 注册。插件的 `inject` 只有 `tools`，`tools` 就绪即执行 `apply`；`apply` 里读一次 `ctx.get('webServer')`，读到才注册路由。`webServer` 的提供方要等端口监听完成才 ACTIVE，晚于这次读取；在那之前 `ctx.get` 返回 `undefined`，路由被跳过，之后也没有补注册的时机。设置页每 5 秒轮询这条路由，拿到 404 就显示「未加载，请重启应用」。同一组合里接入层、媒体上传与三个工作台都把 `webServer` 写进 `inject`，所以它们的路由正常。

2026-11-28 在 web profile 加 yootun bundle 的组合里复现：插件已 ACTIVE，`POST /api/desktop/yootun/agent-status` 返回 404，与不存在的路径相同；同一进程里视频号工作台的路由返回 400 `unknown_action`（路由存在）。

`apply` 内改用 `ctx.inject(['webServer'], scope => { … })`。这段回调在 `webServer` 可用后执行，用 `scope.effect(() => scope.webServer.register(…))` 注册路由：

| 时序 | 行为 |
|---|---|
| `webServer` 先于插件就绪 | 插件加载后路由随即注册 |
| `webServer` 晚于插件就绪 | 插件先加载并照常运行监督器与会话守卫；`webServer` 就绪后路由注册 |
| `webServer` 被替换 | 回调先卸载再重跑：路由在旧实例上注销，在新实例上注册 |
| 组合没有 `webServer` | 回调不执行，不注册路由，也不报错 |

处理函数、信任判定、响应字段都不变；卸载中返回 503 的判定沿用插件作用域里的同一个标记。[agent-face-self-heal.md](../../1126/features/agent-face-self-heal.md) 附录 A2 的「`inject` 不变、`apply` 内读一次 `ctx.get('webServer')`」自本单起由本节取代。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env / URL |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/index.ts` | 状态路由随 `webServer` 可用性注册；头注释同步 | 是 | 2.1 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/tests/managed-mcp.test.ts` | 三条组合层用例 | 是 | 行为随实现变更 |
| yootun-agent | [08 册](../../1110/08-plugin-mcp.md) §4.2 | 状态路由的注册时机 | 是 | 分册是契约记录 |
| yootun-agent | [agent-face-self-heal.md](../../1126/features/agent-face-self-heal.md) 附录 A2 | 修订登记 | 是 | 被取代的规格 |
| yootun-agent | [1128 索引](../00-overview.md) | 登记本单 | 是 | 当天建单 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 开发完成（自动验收通过） | 2026-11-28 | `main` | 见 5.1、5.3 |
| yootun-agent 合入 `main` | 2026-11-28 | `main` | 本地提交，推送经用户确认后执行 |
| 真机验收 | | | 待用户执行，见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行）

- [x] `pnpm --filter @yootun/dsh-managed-mcp test`、`build` 通过；
- [x] 仓库级：`pnpm run lint`、`pnpm run typecheck`、`git diff --check`；
- [x] 本机组合复现：web profile 加 yootun bundle，`POST /api/desktop/yootun/agent-status` 由 404 变为 200 并带状态；
- [x] 独立 review 通过，阻断 0 条。

### 5.2 真机验收（用户执行）

需要新的客户端构建；tools 与 docker-helm 不用重新部署。

| # | 步骤 | 预期 |
|---|---|---|
| S1 | 设置 → Yootun 接入 | 「智能体工具」一行不再显示「未加载，请重启应用」 |
| S2 | 已激活且 Key 有效 | 显示「已连接，共 N 个工具可用」；刚打开设置的头几秒可能先显示「正在连接（第 1 次）」 |
| S3 | 会话里让模型做一件需要工作台数据的事 | 模型调用 yootun 工具：读操作直接执行，写操作弹出确认 |
| S4 | 移除 Key 后再看设置 | 不再显示「已连接」；重新激活后恢复「已连接」 |

### 5.3 本地联调记录

2026-11-28：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 用例 | `pnpm --filter @yootun/dsh-managed-mcp test` 24 条（基线 21 加 S7 至 S9）与 `build`；消费方回归 `pnpm --filter @yootun/dsh-client-ui-access test`；仓库级 `lint`、`typecheck`（5 道门）；`git diff --check` | 全部通过 |
| 测试文件类型 | 仓库级 typecheck 的 `tsconfig.host.json` 不含 `yootun/` 下的测试文件；用插件 tsconfig 的编译选项对 `src` 与 `tests` 单独跑 `tsc --noEmit` | `src` 零错误；`tests` 报 3 条，都在本次未改动的行上：未使用的 `TestContext` 导入、`ToolCallId` 在该检查环境下的导出解析、`emitSettingsUpdate` 传给 `ctx.emit` 的 namespace 是 `string`。本次新增代码零错误 |
| 用例有效性 | 临时改回「`apply` 内读一次 `ctx.get('webServer')`」 | S7、S9 失败（等待路由注册超时）；S8 通过，`webServer` 先就绪时旧写法恰好可用；恢复后复跑 24 条全过 |
| 组合复现 | web profile 加 yootun bundle，从源码启动宿主后 `POST /api/desktop/yootun/agent-status` | 修复前 404 `not found`；修复后 200，`state` 为 `connecting`（联调环境的 Agent 面端点未开）；不存在的路径仍 404，GET 405，异源 Origin 403 |
| 独立 review | 读 vendored cordis 源码推演回调的唤醒、服务替换时的卸载与重跑、父插件卸载时的释放、`disposing` 标记的读取、启动审计的范围，并复跑上表命令 | 可以验收，阻断 0 条；索引状态行已同步；测试文件里未使用的 `TestContext` 导入是既有问题，未处理 |
| 观察项 | review 首跑时既有用例 S2（退避后第二次延迟约为两倍）偶发失败，单独重跑与整文件重跑通过 | 时间敏感断言，不在本单改动内，未处理 |
