# 跨仓变更流程：tools / docker-helm / yootun-agent

状态：定案（2026-11-24）。本文是业务特性在三仓之间协同的唯一流程依据。上游同步（官方 → `master` → `main`）是另一条流程，见 [upstream-sync.md](upstream-sync.md)；两条流程正交，关系见第六节。

## 一、三仓分工

| 仓 | 分支 | 职责 | 不做什么 |
|---|---|---|---|
| `tools.dofe.ai` | `dev` | MCP 契约与实现的**唯一来源**：工具名、入参、出参、错误码、读写标记、所属面。契约文档 `docs/1116/yootun-mcp.md` | 不管桌面如何消费 |
| `docker-helm.dofe.ai` | `master` | 部署面：`runtime/mcp-gateway/route-registry.yml` 路由属性、`nginx/` 入口、`docker-compose.yml` 队列/env/挂载、jenkins | 不维护任何插件代码；`plugins/dsh-yootun-*` 旧插件自 2026-11-24 起不再进入任何特性的影响面 |
| `yootun-agent` | `main` | 消费面：Workbench 域门、Agent 策略表、工作台 Host/Client、打包发版 | 不定义工具契约；不持有 Workbench 工具名清单 |

红线：

- 工具清单与计数只在 tools 的 `docs/1116/yootun-mcp.md` 维护；其他仓不手抄计数；
- yootun-agent 代码、注释、测试中不出现 Workbench 工具数量字面量；
- 新增或维护任何业务特性，先按第四节在建单当日目录建实施单，再动代码。

## 二、白名单机制

两面放行规则不同，差异是有意的：Agent 面是模型驱动、参数来自 LLM，每个工具的会话策略是产品决策；Workbench 面是 Host 驱动、工具名是 Host 代码里的字面量，浏览器无法构造工具名。

### 2.1 Workbench 面：按域放行

唯一需要维护的表是 `yootun/plugins/dsh-workbench-mcp/src/whitelist.ts` 的 `CALLER_DOMAINS`：

```ts
export const CALLER_DOMAINS = {
  'wx-workbench':     ['wx'],
  'xhs-workbench':    ['xhs'],
  'douyin-workbench': ['douyin', 'viral'],
  'media-upload':     ['tos'],
}
```

- 连接：只校验 `serverName === 'yootun-workbench'`，不做 `tools/list` 子集校验；
- 调用：工具名必须是 `workbench_<domain>_<rest>`，且 `<domain>` 在该 caller 的域里，否则 `workbench_tool_denied`；通过域门但服务端 `tools/list` 未广播的工具返回 `workbench_tool_unavailable`，不发请求；
- 服务端多广播的域内工具连接器同样放行，但没有 Host handler 调用它，浏览器侧不可达；服务端未部署新工具时，其余工具照常可用；
- 新增 `workbench_*` 工具时 yootun-agent 白名单零改动，只写调它的 Host handler。

### 2.2 Agent 面：逐工具策略表

`yootun/plugins/dsh-managed-mcp/src/guard.ts` 维护三张表：

| 表 | 会话行为 | 新增工具时的动作 |
|---|---|---|
| `READ_TOOLS` | 直接放行 | 若该工具只读且不想每次弹审批，加入此表 |
| `TASK_WRITE_TOOLS` | `ask` | 若该工具会启动或变更远端任务、可能计费，加入此表 |
| `SCHEDULE_WRITE_TOOLS` | `ask` | 若该工具是发布排期记录的同步幂等写，加入此表 |
| 三表都不在 | `ask`（未分类，交人工确认） | 不加也能用，只是每次调用弹审批 |

- 三张表是"免审批/固定审批"名单，不是准入闸门；未分类工具不再 `deny`（2026-11-24 起，原 fail-closed 作废）；
- 三类 `ask` 的卡片文案在 `src/locales.ts`，中英文成对、按界面语言显示，`reason` 保持英文（模型可见）；新增会 `ask` 的类别时必须同时补两种文案，类型检查强制；
- `yootun-workbench`、`yootun-catalog` 两个 serverName 在普通会话保持 `deny`；
- 官方 `dsh-mcp-client` 注册服务端全部工具，新 Agent 工具不打包即可见，经 `ask` 即可用。

## 三、速查表：改 X 要动哪几个仓

| 改动类型 | tools.dofe.ai | docker-helm.dofe.ai | yootun-agent |
|---|---|---|---|
| 新增 `workbench_<domain>_*` 工具（已有域） | 实现 + 测试 + 契约文档 | 不动（除非新 celery 队列、新 env、新 URL 前缀） | 只写 Host handler；白名单不动 |
| 新增 `yootun_*` Agent 工具 | 实现 + 测试 + 契约文档 | 不动（同上） | 可选：加入 `READ_TOOLS` 免审批，或加入 `TASK_WRITE_TOOLS` / `SCHEDULE_WRITE_TOOLS` 取得准确的审批文案；不加则每次 `ask` |
| 新域（新 `workbench_<newdomain>_*` 前缀） | 实现 + 契约文档 | 视需要 | `WorkbenchDomain` 类型 + 对应 caller 的 `CALLER_DOMAINS` 一行 |
| 工具兼容变更（加可选参数、加返回字段） | 实现 | 不动 | 类型 / 投影（如消费该字段） |
| 工具破坏变更 | 升公共路径版本 `/v2` | nginx + route-registry 加 v2 路由 | 两版并存期 |
| 删除/重命名工具 | **最后**删 | 最后清 notes | **先**移除调用它的 handler 并发布 |
| 新异步任务队列 | 实现 | `docker-compose.yml` worker + env | 不动 |
| 新 URL 前缀 / 新 upstream | 不动 | nginx location + route-registry | 不动 |
| 纯 UI / 本地设备能力（Chrome、文件、state） | 不动 | 不动 | 仅此仓 |
| 旧桌面插件 `plugins/dsh-yootun-*` | — | **不改** | — |

判断顺序：需要远端数据或写操作？→ 要进普通会话？→ 新队列/新 URL？→ 每问只落到上表一行。

## 四、实施单

位置：`yootun/docs/<MMDD>/features/<slug>.md`，从 [feature-template.md](feature-template.md) 复制。一个特性一份，是三仓共享的唯一协调文件。

日期目录：`<MMDD>` 是建单当日（Asia/Shanghai 自然日，四位月日，如 `1124`）；同一天建的实施单归同一目录，跨天建单开新目录，发版不切换目录。每个日期目录以 `00-overview.md` 作索引（标题写完整日期），当天首次建单时一并创建并登记索引行；发版日期回填在各实施单第 4 节，不写在索引里。已建实施单不迁移：实施单记录落地过程与验收，归入建单当日目录冻结。现有目录：[1124/](1124/00-overview.md)、[1125/](1125/00-overview.md)。

固定五章：范围、契约增量、影响面、状态回填、验收。要点：

- **契约增量先于代码**：工具名/入参/出参/错误码/读写/所属面，按 tools 的命名规范写；tools 与 yootun-agent 的实现都以该章为准，只在契约冻结处同步一次；
- **影响面从速查表复制**，逐行填改/不改 + 具体文件路径 + 依据；"不改"也要写，防止遗漏判断；
- **状态回填四个时间点分开记**：tools 合入 `dev`、docker-helm 部署测试环境、yootun-agent 合入 `main`、发版。tools 合入不等于服务端已上线；
- 不记裸 commit hash，用日期与版本号。

首份实施单 [1124/features/infra-whitelist-domain-gate.md](1124/features/infra-whitelist-domain-gate.md) 即第二节白名单机制落地的实施与验收单。

## 五、顺序与门禁

推荐序：tools 实现并合入 `dev` → docker-helm 部署测试环境并 `curl tools/list` 核对 → yootun-agent 实现 → 本地三仓联调（分册 10 的方式：`../tools.dofe.ai` + `../docker-helm.dofe.ai` 的 PG/Redis/RabbitMQ）→ 真机 → 三仓分别合入。

本机联调与真机验收使用的数据库以 `tools.dofe.ai` 的 `.env`（`DATABASE_URL`）指向的数据库为准，不为验收另建数据源；`.env` 不入库，文档不记录其取值。各实施单第 5 节把验收分为两张清单：5.1 开发侧自动验收（测试、构建、静态核对），5.2 真机验收（用户执行，逐步骤写明预期）。

白名单放松后，服务端先于客户端不再是硬约束：客户端先发只是新工具显示"暂不可用"，旧功能不受影响。仍按推荐序走，用户就看不到暂不可用。

删除与重命名反向：客户端先移除调用并发布，等旧客户端过期，服务端再删。

### 5.1 分支

实施单与代码走不同的分支策略，依据是两者性质不同：实施单是三仓共享的协调文件，从草案起就要对其他仓可见，且不影响构建；代码影响构建、需要验收、可能回退。

| 产物 | 分支 | 时点 |
|---|---|---|
| 实施单 | 直接提交在目标分支（本仓 `main`） | 建单即提交，后续修订同在目标分支 |
| 代码 | 从目标分支切特性分支 `feat/<slug>`（tools 仓基于 `dev`，本仓基于 `main`） | 实施单草案确认后、动代码前 |
| 代码合入 | 验收通过后合入目标分支，实施单第 4 节回填分支名 | 第 5 节验收清单全部通过 |

两个特性并行时各自一条分支，不共享；分支推送需经用户确认，本地分支同样起隔离作用。

## 六、与上游同步的关系

上游同步（[upstream-sync.md](upstream-sync.md)）只处理官方 → `master` → `main`，不涉及 tools 与 docker-helm。两条流程在一个点交汇：上游若改动官方 `dsh-mcp-client` / `McpClientHost` 的 API 或 `tools/pre-execute` 决策类型，yootun-agent 的两个连接器要适配（如 0.2.2-rc.5 同步时的 `McpClientHost` 改造），但 tools 契约与 docker-helm 路由不受影响。适配记录写进上游同步的分册，不另开实施单。
