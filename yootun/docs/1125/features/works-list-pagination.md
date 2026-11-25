# douyin-wx-workbench-作品列表分页 实施单

状态：已实施，本地三仓联调通过，待真机验收（tools 待合入 `dev` 并部署测试环境） ｜ 创建：2026-11-25 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音与视频号作品数据页的「账号作品」面板都默认查询选中账号的全部已入库作品，一次返回、一次渲染。

| 端 | 抖音 | 视频号 |
|---|---|---|
| Host action | `works.list(accountId, includeNotInList?)` 原样透传 | `works.list(accountId, sort?, order?, publishedFrom?, publishedTo?)` 原样透传；页面只传 `accountId` |
| 服务端工具 | `workbench_douyin_work_list(accountId, includeNotInList)` 全量返回 | `workbench_wx_work_list(...)` 全量返回（docstring 注明一期无服务端分页，规模假设 ≤ 500） |
| 排序 | 页面对全量数据本地排序，10 个数值列三态 | 页面对全量数据本地排序，10 列三态 |
| 顶部 KPI | 无 | 5 张摘要卡：作品总数与近 7 日两卡来自账号与 `account.overview`，完播率、缺口作品、最近采集时间由页面基于全量行计算 |

一条作品约 3 KB（含 `data_gap`、`traffic_source` 等 JSON 字段），几百条作品意味着全量序列化、网关传输、前端一次渲染几百行带封面图的表格。视频号页面表现为顶部 KPI 先出、列表数秒后才出现。MCP 网关有 2,000,000 字节响应硬上限，超限抛 `OUTPUT_TOO_LARGE` 且不截断；按 3 KB 一条推算约 650 条作品触顶，而该码不在抖音插件稳定码白名单内，会被收敛成通用的 `douyin_operation_request_failed`。

### 0.2 目标

- 两个工作台的作品列表改为服务端分页，固定 10 条/页，不提供页码大小选择；
- 表头排序改为服务端排序，翻页不重不漏，排序语义（空值恒排最后、三态循环）不变；
- 列表接口随带整账号聚合值：`total` 与 KPI 所需的 `summary`，一次请求同时得到 KPI 与当页数据；
- 抖音作品页新增与视频号同布局的 5 卡 KPI 行；视频号三张由页面计算的卡改读服务端聚合值，口径不变；
- 分页控件 `Pager` 上移 `@yootun/dsh-client-ui-kit`，小红书作品数据页后续直接复用。

## 1. 范围

做：

- tools：`workbench_douyin_work_list` 增加 `sort` / `order` / `limit` / `offset`，出参增加 `total` / `limit` / `offset` / `summary`；`workbench_wx_work_list` 增加 `limit` / `offset`，`sort` 枚举补两列，出参增加 `limit` / `offset` / `latest_collected_at` / `completion_rate_pct`，`total` 与 `gap_count` 改口径；
- yootun-agent kit：新增 `Pager`；
- 抖音 Host：`works.list` 入参增量与响应投影；
- 抖音 client：服务端排序、分页、KPI 行、缓存键与竞态守卫；
- 视频号 Host：路由 schema 新增整数字段类型，`works.list` 入参增量；
- 视频号 client：服务端排序、分页、三张卡与最近采集时间改读服务端聚合值；
- 文档同步：14 册 §5、11 册 §3.2 与 §4.1、15 册 §11、p2 册 §3 的 `works.list` 行。

不做：

- 不新增、不删除、不重命名 MCP 工具，工具清单与计数不变；
- 不做页码大小选择，不做跳页；
- 不做游标分页（offset 加稳定排序足够：每页 10 条、单账号千级以内）；
- 不做虚拟列表；
- 不改 Agent 面的 `yootun_douyin_works_list` / `yootun_wx_works_list` 调用方式（不带分页参数，服务端保持全量行为）；
- 不改作品详情、趋势、导出（导出仍是服务端全量 xlsx）、账号总览页；
- 不把 `OUTPUT_TOO_LARGE` 加入白名单（分页后页面不再触及该上限）；
- 不做小红书作品数据页（另立单，复用 kit `Pager` 与本单的 KPI 行布局）；
- 不迁移小红书 Hotboard 现有的分页（等其作品数据页实施时一并处理）。

## 2. 契约增量

### 2.1 工具清单行

无新增工具。两个既有工具的入参与出参按 2.2、2.3 扩展，均为可选字段，不传时行为与现状一致。

tools 契约文档对齐：`docs/1116/yootun-mcp.md` §4.2 与 §4.4 的工具清单和计数不变；参数以 DTO 为准，契约文档不改。tools 的 schema 对齐门要求 Workbench 面、Agent 面与源工具的入参逐字段一致，所以裸工具 `douyin_work_list` / `wx_channels_work_list` 与 Agent 面 `yootun_douyin_works_list` / `yootun_wx_works_list` 的签名同步扩展同一组可选参数；Agent 面调用方不传新参数，行为不变。

### 2.2 `workbench_douyin_work_list`

入参（camelCase，DTO `DouyinWorkListInput`，`src/tools_dofe/mcp/domains/douyin_operation/schemas.py`）：

| 字段 | 类型 | 必填 | 缺省 | 约束 |
|---|---|---|---|---|
| `accountId` | string | 是 | — | 不变 |
| `includeNotInList` | bool | 否 | `false` | 不变 |
| `sort` | enum | 否 | `publish_time` | `publish_time` `play_count` `collect_count` `like_count` `comment_count` `bounce_rate_2s_pct` `completion_rate_5s_pct` `completion_rate_pct` `fans_gain_count` `avg_watch_duration_s` `avg_view_proportion_pct`（取值与 DB 列名、客户端 `WorkSortKey` 一致） |
| `order` | enum | 否 | `desc` | `asc` / `desc` |
| `limit` | int | 否 | `null`（全量） | 1..100 |
| `offset` | int | 否 | `0` | 0..1,000,000；`offset > 0` 且未传 `limit` 拒绝 |

出参：

```json
{
  "account_id": "…",
  "works": [ { "work_id": "…", "title": "…", "play_count": 12000, "promoted": false } ],
  "total": 183,
  "limit": 10,
  "offset": 0,
  "summary": {
    "work_count": 183,
    "play_count": 1250000,
    "fans_gain_count": 4021,
    "completion_rate_pct": 38.27,
    "gap_count": 4
  }
}
```

`works[]` 每行是 `work_payload(record)` 加 `promoted`，字段与现状相同。

口径：

| 项 | 规则 |
|---|---|
| 过滤集合 F | `account_id = accountId`；`includeNotInList = false` 时另加 `visibility = active`。`works`、`total`、`summary` 都基于 F |
| 排序 | 按 `sort` 列与 `order`；NULL 在两个方向都排最后；并列行按 `publish_time DESC NULLS LAST, work_id ASC` 稳定排序（`sort = publish_time` 时只追加 `work_id ASC`） |
| `total` | F 的行数 |
| 全量模式 | 未传 `limit`：返回 F 全部行，`limit: null`，`offset: 0`，出参其余字段与现状一致 |
| 分页模式 | 排序后跳过 `offset` 行取 `limit` 行；`offset ≥ total` 时 `works: []` |
| `promoted` | 逐行布尔，取该账号全部投流 work_id 集合，与现状相同 |
| `summary.work_count` | 等于 `total` |
| `summary.play_count` / `summary.fans_gain_count` | F 内该列求和，服务端收敛为整数（PostgreSQL 对 bigint 求和返回 numeric，MCP 投影会把 Decimal 序列化成字符串）；F 内全为 NULL 时为 `null`，不写 0 |
| `summary.completion_rate_pct` | `SUM(completion_rate_pct × play_count) / SUM(play_count)`，只计两列都非 NULL 的行；分母为 0 时 `null`；保留两位小数 |
| `summary.gap_count` | F 内 `data_gap` 非 NULL 且非空的作品数 |
| 响应体积 | `limit ≤ 100` 时单页上限约 350 KB，低于 2,000,000 字节硬上限；全量模式的上限与现状相同 |

实现要求：`total` 与 `summary` 用聚合查询，不为算聚合把全部行加载进内存；页行用同一条排序查询加 `OFFSET / LIMIT`。

错误码：枚举外 `sort` / `order`、越界 `limit` / `offset`、`offset > 0` 且无 `limit` 由 DTO 或服务层拒绝为 `VALIDATION_ERROR`；账号不存在与墓碑沿用 `ACCOUNT_NOT_FOUND` / `ACCOUNT_NOT_ACCESSIBLE`。无新码，三个码都已在 yootun-agent 抖音插件白名单内。

### 2.3 `workbench_wx_work_list`

入参（camelCase，DTO `WxWorkListInput`，`src/tools_dofe/services/wx_channels_operation/schemas.py`）：

| 字段 | 类型 | 必填 | 缺省 | 约束 |
|---|---|---|---|---|
| `accountId` / `sort` / `order` / `publishedFrom` / `publishedTo` | 不变 | | | `sort` 枚举追加 `completion_rate_pct`、`avg_play_duration_s`（都是实表列），`SORTABLE_FIELDS` 同步为 10 项，与客户端 `SortKey` 一致 |
| `limit` | int | 否 | `null`（全量） | 1..100 |
| `offset` | int | 否 | `0` | 0..1,000,000；`offset > 0` 且未传 `limit` 拒绝 |

出参在现有 `{account_id, works, total, data_available, gap_count}` 上增加 `limit`、`offset`、`latest_collected_at`、`completion_rate_pct`，并改两个字段的口径：

| 字段 | 现状 | 变更 |
|---|---|---|
| `total` | 本次返回的行数 | F 的行数；全量模式下数值与现状相同 |
| `data_available` | 本次返回非空 | `total > 0` |
| `gap_count` | `data_gap` 非空的行数（任一缺口） | `data_gap` 的任一键属于 `CORE_GAP_FIELDS` 的行数，与页面现在显示的「核心字段缺失」一致 |
| `latest_collected_at` | 无 | F 内 `latest_collected_at` 的最大值，无值为 `null` |
| `completion_rate_pct` | 无 | `SUM(completion_rate_pct × play_count) / SUM(play_count)`，只计两列都非 NULL 的行；分母为 0 时 `null`；两位小数 |
| `limit` / `offset` | 无 | 回传生效值；全量模式 `limit: null`、`offset: 0` |

`CORE_GAP_FIELDS` 定义为服务层常量（tools `src/tools_dofe/services/wx_channels_operation/constants.py`），取值等于客户端 `src/client/schema.ts` 现有集合的 15 项：`traffic_source` `retention_trend` `daily_metrics` `play_count` `like_count` `favorite_count` `comment_count` `share_count` `forward_count` `follow_count` `completion_rate_pct` `avg_play_duration_s` `cover_url` `publish_time` `duration_s`。

排序：按 `sort` 列与 `order`，NULL 在两个方向都排最后，并列行按 `publish_time DESC, work_id ASC` 稳定排序。全量模式与分页模式的规则同 2.2。

错误码：同 2.2，另沿用 `INVALID_SORT`、`INVALID_TIME_WINDOW`、`ACCOUNT_NOT_FOUND`、`ACCOUNT_NOT_ACCESSIBLE`。无新码。

### 2.4 Host action 契约

| 面 | action | 入参增量 | 出参增量 | 错误码 | 读/写 |
|---|---|---|---|---|---|
| 抖音 | `works.list` | `sort`（枚举 11）、`order`（`asc` / `desc`）、`limit`（整数 1..100）、`offset`（整数 0..1,000,000） | `total`、`limit`、`offset`、`summary` 原样透传 | `DOUYIN_ROUTE_INVALID_REQUEST`（枚举外 / 越界） | 读 |
| 视频号 | `works.list` | `limit`、`offset` 同上；`sort` / `order` 加枚举校验 | `total`、`limit`、`offset`、`gap_count`、`latest_collected_at`、`completion_rate_pct` 原样透传 | `WX_ROUTE_INVALID_REQUEST` | 读 |

视频号路由 schema（`src/route.ts` `ActionSchema`）新增字段类型 `'integer'`（要求 `Number.isInteger`）、可选 `ranges` 与 `enums`，语义与抖音路由一致；既有 `'string'` / `'boolean'` 行为不变。

### 2.5 kit `Pager`

`@yootun/dsh-client-ui-kit` 新增：

```ts
export interface PagerProps {
  /** 当前页，从 1 开始。 */
  page: number
  /** 页大小（消费者固定值，组件不提供修改入口）。 */
  pageSize: number
  /** 服务端总数；加载中或未知为 null。 */
  total: number | null
  /** 翻页回调；排序或筛选变化时由消费者自行回到第 1 页。 */
  onPage: (page: number) => void
  /** 页请求在途：两个按钮禁用。 */
  busy?: boolean
}
```

渲染 `<nav aria-label>`：信息文案「共 {total} 条 · 第 {page} / {pages} 页」、上一页、下一页。`total` 为 `null` 时显示「统计加载中…」且两个按钮禁用；`pages ≤ 1` 时只渲染信息文案。`pages = max(1, ceil(total / pageSize))`。词典键进 kit `locales.ts`（zh 为键集事实源，en 成对）：

| 键 | zh | en |
|---|---|---|
| `pager.label` | 分页 | Pagination |
| `pager.info` | 共 {total} 条 · 第 {page} / {pages} 页 | {total} items · page {page} / {pages} |
| `pager.loading` | 统计加载中… | Loading totals… |
| `pager.prev` | 上一页 | Previous page |
| `pager.next` | 下一页 | Next page |

抖音素材看板现有的内联分页改为消费 kit `Pager`，其词典键 `mat.page.*` 删除；XHS Hotboard 的分页不在本单迁移。

### 2.6 页面行为（两个工作台共同）

| 项 | 规则 |
|---|---|
| 页大小 | 常量 10，固定 |
| 默认查询 | 发布时间降序：`page = 1`、`sort = publish_time`、`order = desc`，第 1 页是该账号最新发布的作品（抖音三态排序的「默认态」即此） |
| 表头排序 | 三态循环不变：默认（发布时间降序）→ 该列降序 → 该列升序 → 默认。点击即发起新查询并回到第 1 页；排序期间同值行仍按发布时间降序排列 |
| 翻页 | 只改 `offset`，排序不变 |
| 请求在途 | 排序或翻页请求发出后保留当前已渲染的行，表格标记 `aria-busy`，`Pager` 置 `busy`；新页到达后整体替换；失败保留旧行并可重试 |
| 切换账号 | 回到第 1 页；排序态保留 |
| 刷新 / 采集完成 | 重拉当前账号当前页 |
| 缓存 | 按账号 + 排序 + 页码缓存最近一次成功响应，切回时即时渲染后后台刷新；数据变更（采集完成）后清掉该账号的全部缓存 |
| 竞态 | 序号守卫 + 账号守卫 + 查询键守卫，过期响应整体丢弃 |
| 失败 | 同账号保留已渲染行进入 partial，跨账号直接 error；重试重拉当前页 |
| 列表区域高度 | 与行数、数据有无无关：抖音在双列布局下填满作品面板剩余高度，容器宽度小于 880 px 时固定 60 vh；视频号固定 60 vh。分页页脚占位恒定 |
| 列表区域四态 | 加载中显示骨架；没有行时在区域正中显示一行「暂无数据」（kit `DataState` 空态，不带采集按钮）；没有可保留的行而查询失败时，区域内显示一处「加载失败」与「重试」 |
| 失败提示位置 | 列表请求的失败提示只出现在工具栏的刷新失败提示（刷新场景）或列表区域（整页失败）。KPI 卡不重复：加载中呈骨架，其余按值显示，缺失为「—」；缺口卡在聚合值缺失时不显示「数据完整」 |

### 2.7 抖音 KPI 行

位置：作品面板工具栏下方、表格上方，与视频号 `summaryGrid` 同构（5 张 kit `KpiCard`，断点：宽容器 5 列，≤ 1119 px 3 列，更窄 2 列）。数据全部来自 `works.list` 的 `summary`。加载中呈骨架；就绪、部分失败、出错都按值显示，卡片上不出现失败提示。行高取最小值 120 px，缺口脚注换行时列表区域高度不变。

| 卡 | 值 | footnote |
|---|---|---|
| 作品总数 | `summary.work_count` | 已入库作品 |
| 播放合计 | `summary.play_count` | 全部已入库作品 |
| 吸粉合计 | `summary.fans_gain_count` | 全部已入库作品 |
| 完播率 | `summary.completion_rate_pct` | 按播放加权 |
| 缺口作品 | `summary.gap_count` | 大于 0：至少 1 项数据缺失；等于 0：数据完整；聚合值缺失时不显示 |

`null` 按既有格式化函数显示「—」。工具栏的「全部时间作品数」提示与第一张卡同源同值，删除。

### 2.8 视频号 KPI 卡数据来源

| 卡 | 现状 | 变更 |
|---|---|---|
| 作品总数 | 账号 `feedCount` | 不变 |
| 近 7 日播放 / 近 7 日关注量 | `account.overview(last_7d)` | 不变 |
| 作品完播率 | 页面对全量行计算 | `works.list` 的 `completion_rate_pct`；加载中呈骨架，其余按值显示，不重复列表的失败提示 |
| 缺口作品 | 页面对全量行计算 | `works.list` 的 `gap_count`；加载中呈骨架，其余按值显示，不重复列表的失败提示 |
| 最近采集时间（工具栏） | 页面对全量行取最大值 | `works.list` 的 `latest_collected_at` |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | `src/tools_dofe/mcp/domains/douyin_operation/schemas.py` | `DouyinWorkListInput` 追加四个字段与约束 | 是 | DTO |
| tools.dofe.ai | `src/tools_dofe/services/douyin_operation/queries.py` | `list_works` 分页、稳定排序、`summary` 聚合 | 是 | 服务层 |
| tools.dofe.ai | `src/tools_dofe/mcp/domains/yootun/workbench/server.py` | `workbench_douyin_work_list` / `workbench_wx_work_list` 透传新字段 | 是 | 工具实现 |
| tools.dofe.ai | `src/tools_dofe/services/wx_channels_operation/schemas.py`、`constants.py`、`queries.py` | `WxWorkListInput` 追加字段与枚举；`SORTABLE_FIELDS` 加两列；新增 `CORE_GAP_FIELDS`；`work_list` 分页与聚合 | 是 | 服务层 |
| tools.dofe.ai | `docs/1116/yootun-mcp.md` | 清单与计数不变；参数说明以 DTO 为准 | 否 | 无新工具 |
| tools.dofe.ai | `src/tools_dofe/mcp/domains/douyin_operation/server.py`、`wx_channels_operation/server.py`、`yootun/agent/server.py` | 裸工具与 Agent 面签名同步扩展同一组可选参数 | 是 | schema 对齐门要求各面与源工具入参一致 |
| tools.dofe.ai | `tests/yootun/test_dev_baseline_parity.py` | `OPTIONAL_SCHEMA_EXTENSIONS` 登记两工具新增入参；新增 `OPTIONAL_ENUM_EXTENSIONS` 登记视频号 `sort` 枚举追加（既有枚举值必须保留、新增集合钉死） | 是 | dev 基线门 |
| tools.dofe.ai | `docs/superpowers/catalogs/yootun-service-catalog-snapshot.json` | 按既定脚本再生成，仅 `catalogVersion` 变化 | 是 | 目录快照是入参 schema 的内容哈希 |
| tools.dofe.ai | `tests/douyin_operation/test_tools.py`、`test_server_contract.py`、`tests/wx_channels_operation/test_queries.py`、`test_wx_channels_server_contract.py`、`tests/yootun/test_workbench_coverage.py` | 分页、排序、聚合、拒绝用例 | 是 | 行为随实现变更 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env / URL |
| yootun-agent | `yootun/packages/dsh-client-ui-kit/src/{pager.tsx,pager.module.css,index.ts,locales.ts}`、`tests/kit.test.tsx` | 新增 `Pager` 与用例 | 是 | 第二个消费者出现时上移 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/route.ts`、`src/handlers.ts` | `works.list` schema、透传与投影 | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/{WorkbenchPage,WorksPanel,schema,format,locales,kit-styles}.ts(x)`、`workbench.module.css`、`MaterialPage.tsx` | 服务端排序、分页、KPI 行、缓存与守卫、素材看板改用 kit `Pager` | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/*` | route / handler / 页面用例更新，本地排序用例删除 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/route.ts`、`src/handlers.ts` | 整数字段类型与枚举；`works.list` 透传 | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/{WorkbenchPage,WorksPanel,schema,works-format,locales,kit-styles}.ts(x)`、`workbench.module.css` | 服务端排序、分页、聚合值接入；删除本地排序与聚合工具函数 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/tests/*` | 路由与页面用例更新 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §5 | 作品面板增 KPI 行与分页，排序改服务端 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1110/11-wx-workbench-ui-layout-parity.md` §3.2、§4.1 | 摘要卡数据来源、分页、排序改服务端 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1110/p4-douyin-workbench-baseline.md` §3 #12、§11 | 登记 `works.list` 入参扩展 | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1110/p2-wx-workbench-baseline.md` §3 | `works.list` 行补分页参数 | 是 | 基线行更新 |
| yootun-agent | `yootun/docs/1125/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 14 册 §5 + 11 册 §3.2/§4.1 + 15 册 §11 + p2 册 §3） | 2026-11-25 | `main` | 已提交本地 `main`，推送待用户确认 |
| tools 开发完成（自动验收通过） | 2026-11-25 | `feat/works-list-pagination`（tools 仓，自 `dev`） | `pytest tests/douyin_operation tests/wx_channels_operation tests/yootun` 850 通过；16 项迁移 / PG 用例因本机无建库权限报错，改动前同样如此；ruff 在改动文件上无新增 |
| tools 分支同步最新 `dev`（对方新增 `workbench_wx_accounts_overview`） | 2026-11-25 | `feat/works-list-pagination`（tools 仓） | 合并 `origin/dev`：`wx_channels_operation/queries.py` 的 import 与服务目录快照两处冲突已解决，快照按脚本重新生成；`pytest tests/douyin_operation tests/wx_channels_operation tests/yootun tests/mcp` 1373 通过，1 个失败与 53 个错误均为本机 PG 建库权限 |
| tools 合入 `dev` | 2026-11-25 | `feat/works-list-pagination` → `dev` | 已合并到本地 `dev`，推送待用户确认 |
| docker-helm 部署测试环境 | | — | 待填：部署后 `curl tools/list` 核对，两工具带分页参数可调 |
| yootun-agent 开发完成（自动验收通过） | 2026-11-25 | `feat/works-list-pagination`（自 `main` 切出；kit `Pager`、抖音、视频号三个提交） | kit `test` 65、抖音 `test`（node --test 17 文件 + vitest 136）、视频号 `test`（node --test 76 + vitest 66），三包 `build`、oxlint 通过；真机验收见 5.2 |
| yootun-agent 分支同步最新 `main`（视频号总览批次已先合入） | 2026-11-25 | `feat/works-list-pagination` | 合并 `origin/main`：抖音 `MaterialPage.tsx` 与视频号 `WorkbenchPage.tsx` 两处 import 冲突已解决，两边内容都保留；合并后 kit 70、抖音 191 + 136、视频号 77 + 74 全过，`build` 通过 |
| 本地三仓联调（按落地顺序的本地临时预演分支） | 2026-11-25 | — | 通过，记录见 5.3；预演分支只在本地，不推送 |
| yootun-agent 真实 UI 反馈修复 | 2026-11-25 | `feat/works-list-pagination` | 列表区域固定高度、空列表「暂无数据」、KPI 卡不重复失败提示；两个插件 `test`、`build` 通过，并入预演分支复跑，记录见 5.3 |
| yootun-agent 合入 `main` | 2026-11-25 | `feat/works-list-pagination` → `main` | 按采集状态恢复 → 采集并发 → 分页的顺序合入本地 `main`；与前两单在 4 个文件的冲突按预演结果解决，代码与预演分支逐文件一致；推送待用户确认。部署时 tools 必须先于或同时于 yootun-agent 上线 |
| 发版 | | | 待填 |

顺序约束：tools 的 DTO 是 `extra="forbid"`，旧服务端会拒绝新参数，所以 yootun-agent 的两个插件必须在 tools 部署测试环境之后合入；kit `Pager` 不依赖 tools，在分支内先行完成。

## 5. 验收

环境：本机启动 tools.dofe.ai（读取其 `.env`，`DATABASE_URL` 指向的数据库；[cross-repo-sync.md 第五节](../../cross-repo-sync.md#五顺序与门禁)），yootun-agent 的 Workbench MCP 指向本机 tools。数据集里准备一个作品数超过 650 的抖音账号；没有则用现有作品数最多的账号并记录数量。2026-11-25 本地联调所用数据：抖音账号 17 个，工作台列出 13 个，作品最多的账号 82 条，其中 1 条不在列表；视频号 1 个账号 53 条。库里没有作品数超过 650 的账号，R5 在本地只验证到机制（见 5.3）。

### 5.1 自动验收（开发侧执行，每次合入前）

- [x] tools：`uv run pytest tests/douyin_operation tests/wx_channels_operation tests/yootun -q` 与全量 `uv run pytest -q` 通过；不传新字段时两个工具出参与改动前逐字段一致（2026-11-25）；
- [x] yootun-agent：`pnpm --filter @yootun/dsh-client-ui-kit test`、`build`；两个插件 `test`、`build`（含样式表与 runtime bundle 校验）通过（2026-11-25；与另两条分支集成后复跑结果见 5.3）；
- [x] 附录 A 的用例全部存在并通过（2026-11-25）。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| T1 | tools：调用本机 `tools/list` | 清单与改动前一致（2026-11-25 本地联调已核对：Workbench 95、Agent 39；95 含视频号总览批次新增的 1 个工具） |
| T2 | tools：带 `limit=10, offset=0` 调用 `workbench_douyin_work_list` 与 `workbench_wx_work_list` | `works` 10 行；`total` 为该账号全部行数；`limit=10`、`offset=0`；聚合字段齐全（2026-11-25 本地联调已覆盖） |
| R1 | 抖音：进入作品页 | 只发一次 `works.list`（`limit=10, offset=0, sort=publish_time, order=desc`）；KPI 五卡出现；第 1 页是最新发布的作品；底部「共 N 条 · 第 1 / M 页」 |
| R2 | 抖音：点「播放量」表头三次 | 依次为播放量降序（整账号播放量最高的 10 条，回第 1 页）→ 升序 → 回到发布时间降序；空值恒在最后 |
| R3 | 抖音：下一页、上一页、刷新、切换账号再切回 | 翻页只变 `offset`；末页「下一页」禁用；刷新停留在当前页；切账号回第 1 页且排序保留 |
| R4 | 抖音：点「采集」等结束 | 当前页刷新，KPI 随之更新 |
| R5 | 抖音：作品数超过 650 的账号翻到末页 | 可翻到底，不再出现查询失败（`OUTPUT_TOO_LARGE`） |
| R6 | 抖音：导出 Excel | 仍为全量，行数等于全部已入库作品数；账号有不在列表的作品时为 `total` 加不在列表数（本地样本 83 = 82 + 1，见 5.3） |
| R7 | 抖音：R2 的首行与导出 Excel 对照；KPI 播放合计与 Excel 播放量列求和对照 | 降序首行等于 Excel 播放量列最大值；Excel 播放量列求和等于 KPI 播放合计加不在列表作品的播放量 |
| R8 | 视频号：重复 R1–R4、R6 | 同抖音；完播率、缺口作品、最近采集时间与改动前显示一致 |
| R9 | 两个工作台：明暗主题、三档宽度（≥ 1120 / 880 / 640 px） | KPI 行与分页控件完整可读；列表区域高度固定（抖音双列布局随面板，窄容器 60 vh；视频号 60 vh），表格可见 |
| R11 | 两个工作台：切到没有作品的账号、翻到末页、让 tools 不可用后点一次刷新 | 没有作品时列表区域正中只有一行「暂无数据」；末页与第 1 页的列表区域高度相同；刷新失败时 KPI 卡片和列表上方不出现「部分数据」提示，只有工具栏一行提示 |
| R10 | 按 `record-browser-gif` 流程录制排序与翻页片段 | GIF 附在 PR |

### 5.3 本地三仓联调记录（2026-11-25）

环境：本机以 `uv run app` 启动 tools.dofe.ai（读取其 `.env`，连接其 `DATABASE_URL` 指向的数据库），只起 Web 进程，不起 worker 与 beat；yootun-agent 用隔离 Web profile `douyind9`，Workbench 与 Agent 两个 MCP 覆盖指向本机 tools，抖音与视频号状态目录为全新空目录。三条特性分支（`feat/collect-state-restore`、`feat/douyin-collect-all-concurrency`、`feat/works-list-pagination`）与 tools 分支先各自合并目标分支的最新提交（`main` 与 `dev` 已含并行的视频号总览批次），再按落地顺序合入一条本地临时分支验证：kit 70、抖音 211 + 148、视频号 77 + 86 全过，三包 `build` 通过。真实 UI 反馈修复并入后复跑：kit 70、抖音 211 + 151、视频号 77 + 87 全过，三包 `build` 通过，仓库级 `lint`、`typecheck`、`verify-client-ui-i18n`、`verify-export-jsdoc`、`verify-empty-catch` 通过。驱动脚本与截图保存在仓库外。

| 层 | 范围 | 结果 |
|---|---|---|
| tools（直连 `/mcp/yootun-workbench` 与 `/mcp/yootun-agent`） | `tools/list`（Workbench 95、Agent 39）；两个 `work_list` 的入参 schema、不传新参数时的全量出参、分页窗口、`total` 与聚合不随页码变化、`offset ≥ total` 返回空、排序页内有序且空值恒最后、`offset > 0` 无 `limit` 与 `limit = 101` 返回 `VALIDATION_ERROR`；视频号 `gap_count` 与播放加权完播率按全量行复算一致 | 28 项通过 |
| Host（真实 MCP 连接器 + 两个插件的路由处理器） | 首查参数、翻页不重不漏、表头排序两个方向、路由拒绝 `limit = 101` 与枚举外 `sort`、视频号整数字段拒绝非整数、聚合字段经 `readWorksPage` 可读、空闲态的 `collect.running` / `collect.status` / `collectAll.status`、导出 | 28 项通过 |
| 抖音作品页（无头 Chrome） | 5.2 的 R1、R2、R3 全部步骤；五卡 KPI 与服务端聚合一致；导出下载；三档宽度与明暗主题 | 37 项通过 |
| 视频号作品页（无头 Chrome） | R1–R3；完播率、缺口作品、最近采集时间取自列表响应；切到其他 Tab 再切回仍停在原页码；三档宽度与明暗主题；视频号总览页（对方批次）合并后可用 | 28 项通过 |
| 抖音素材看板 | kit `Pager` 显示「49 items · page 1 / 3」，下一页请求 `offset = 20` | 通过 |
| 两个作品页的列表状态与高度（真实 UI 反馈修复后） | 第 1 页 10 行、末页 2–3 行、空账号、出错、点重试恢复五种状态下的列表区域高度；900 px 与 640 px 视口；「暂无数据」在区域正中；出错提示与「重试」各 1 处；部分失败不出现「部分数据」提示 | 13 项通过，1 项未达预期（刷新部分失败时矮 26 px，见下） |

联调结论：

- 导出含「不在列表」的作品：导出调用 `list_works(include_not_in_list=True)`，列表 `total` 不含这部分。样本账号导出 83 行，等于 `total` 82 加不在列表 1；播放量列求和 974453 等于 KPI 播放合计，列最大值 220039 等于降序首行（不在列表的作品播放量为 0）。这是既有口径，5.2 的 R6、R7 已按此修订。
- 全量模式实测约 4.8 KB 一条，82 条即 392 KB，推算约 417 条触到 2,000,000 字节上限，早于 0.1 节约 650 条的估算。分页模式单页响应约 59 KB，与账号作品总数无关。
- 抖音作品页在容器宽度小于 880 px（账号栏在上、作品面板在下）时，表格滚动容器高度原为 0，表格不可见（`main` 上同样复现）。真实 UI 反馈修复后该宽度下区域固定 60 vh，900 px 与 640 px 视口实测均为 600 px。
- 列表区域高度实测（真实 UI 反馈修复后）：第 1 页 10 行、末页 2 行、空账号、出错、重试恢复五种状态下，抖音均为 596 px，视频号均为 600 px。唯一未达预期的状态是「刷新部分失败」：工具栏多出一行失败提示，抖音列表区域为 570 px。该提示行与采集进度共用同一位置，出现时都会让列表区域变矮，属面板既有行为，未改。
- 视频号首次加载时 tools 不可用：账号列表请求失败被显示为「没有账号」，没有账号被选中，列表区域显示「暂无数据」，没有出错提示或重试入口。与抖音的账号列表失败是同一类既有缺陷，未改。
- 并行批次与分支同步：视频号总览批次先合入 `main`（kit 新增 `FilterMenu`，tools 新增 `workbench_wx_accounts_overview`）。三条特性分支各自合并最新 `main`、tools 分支合并最新 `dev` 后都能干净并入目标分支；冲突只在 import 行与生成物，按合并后的实际使用点取并集，两边内容都保留。合并后视频号总览页可用：`overview.accounts` 与 `account.overview` 正常返回，页面渲染全视频指标与账号表现表；抖音素材看板同时使用对方的筛选下拉与 kit `Pager`。
- 按落地顺序（采集状态恢复 → 采集全部并发 → 作品列表分页）依次合入时，最后合入的分支仍会与前面两条分支在 4 个文件冲突：抖音 `src/client/WorkbenchPage.tsx`、`tests/client/douyin-client.test.tsx`、`tests/client/douyin-parity.test.tsx` 与视频号 `tests/client/wx-data.test.tsx`。已在本地按该顺序预演，按两边逻辑与用例全部保留解决后测试全过；落地时需要带这份解决结果。
- Web 应用的 Workbench 连接器在建立连接时读取一次 `tools/list`，tools 更新后要重启 Web 应用才能调用新工具，否则该工具显示为不可用。

本地未覆盖、留在 5.2：R4（采集完成后刷新当前页，需要真实采集）、R5 的作品数超过 650 的真实账号、视频号切换账号（本地库只有 1 个视频号账号）、R10 的 GIF。

## 附录 A：测试矩阵

### A.1 tools.dofe.ai

| ID | 断言 | 文件 |
|---|---|---|
| T1 | 抖音 `limit` / `offset` 翻页正确；`offset ≥ total` 返回空数组；`total` 为 F 行数 | `tests/douyin_operation/test_tools.py` |
| T2 | 抖音 11 个 `sort` 列在两个方向下 NULL 恒最后；并列行顺序稳定 | 同上 |
| T3 | 抖音 `summary`：求和列全 NULL → `None`；加权完播率分母 0 → `None`；`gap_count` 只计非空 `data_gap` | 同上 |
| T4 | 抖音拒绝：`offset > 0` 无 `limit`、`limit` 0 / 101、`sort` 枚举外 | 同上 |
| T5 | 抖音不传新字段时出参与改动前一致（`total = len(works)`，`limit = None`） | 同上 |
| T6 | 视频号 `limit` / `offset`；`total` 为 F 行数；`data_available` 随 `total` | `tests/wx_channels_operation/test_queries.py` |
| T7 | 视频号 `gap_count` 只计核心字段缺口；`latest_collected_at` 取最大；`completion_rate_pct` 口径 | 同上 |
| T8 | 视频号 `completion_rate_pct`、`avg_play_duration_s` 可排序；NULL 恒最后；枚举外 `INVALID_SORT` | 同上、`test_wx_channels_server_contract.py` |
| T9 | Workbench 面两个工具带分页参数经 `/mcp/yootun-workbench` 可调，审计工具名不变 | `tests/yootun/test_workbench_coverage.py` |

### A.2 kit

| ID | 断言 |
|---|---|
| K1 | `Pager` 信息文案、页数计算、边界禁用、`pages ≤ 1` 不渲染按钮、`total = null` 显示加载文案、`busy` 禁用、按钮可键盘到达 |
| K2 | 词典 zh / en 键集一致（`kit-locales.test.ts` 既有守护） |
| K3 | 样式表清单守护覆盖 `pager.module.css` |

### A.3 抖音插件

| ID | 断言 | 文件 |
|---|---|---|
| D1 | 路由：四个新字段的类型、枚举、范围校验与拒绝 | `tests/route.test.ts` |
| D2 | handler：参数透传与响应投影（`total` / `limit` / `offset` / `summary`） | `tests/d3.test.ts`、`tests/abort.test.ts` |
| D3 | 页面：切账号拉第 1 页（`limit 10, offset 0, publish_time desc`）；点表头发新参数并回第 1 页；三态循环；翻页只变 `offset`；过期响应丢弃；采集完成刷新当前页 | `tests/client/douyin-client.test.tsx` |
| D4 | KPI 行五卡取值、`null` 显示「—」、状态随 `worksState`；工具栏不再渲染「全部时间作品数」 | 同上 |
| D5 | `Pager` 接线：`total` 来自服务端；导出按钮在 `total = 0` 时禁用 | 同上 |
| D6 | 本地排序用例删除（`sortWorkRows` / `compareNullableNumbers` 及桶导出），PR 说明行为迁到服务端 | `tests/client/douyin-parity.test.tsx` |
| D7 | 素材看板改用 kit `Pager` 后翻页行为不变 | `tests/client/douyin-d678.test.tsx` |
| D8 | kit 样式表装载清单守护通过（`pager.module.css`） | `tests/client/douyin-parity.test.tsx` |
| D9 | 列表区域四态：出错时出错提示与重试各 1 处、五卡为「—」；部分失败不出现 partial 文案、保留行、工具栏提示；加载中显示骨架且不显示「暂无数据」；无账号与 `total = 0` 时区域为空态并显示「No data」 | `tests/client/douyin-client.test.tsx` |

### A.4 视频号插件

| ID | 断言 | 文件 |
|---|---|---|
| W1 | 路由：`integer` 字段只接受整数，范围与枚举外拒绝；既有 string / boolean 行为不变 | `tests/host.test.ts` |
| W2 | handler：`limit` / `offset` 透传到工具参数 | 同上 |
| W3 | 页面：排序改为重新查询并回第 1 页（替换现有「排序不重新查询服务端」用例）；翻页；过期响应丢弃；采集完成刷新当前页 | `tests/client/wx-data.test.tsx` |
| W4 | 完播率、缺口作品、最近采集时间取自列表响应 | 同上 |
| W5 | kit 样式表装载清单守护通过 | `tests/client/wx-bundle.test.ts` |
| W6 | 部分失败不出现「部分数据」提示条；空列表时区域保留并居中显示「暂无数据」，不渲染 Pager 按钮 | `tests/client/wx-data.test.tsx` |

## 附录 B：逐文件要点

| 文件 | 要点 |
|---|---|
| 抖音 `src/client/WorkbenchPage.tsx` | 新增 `worksPage` 状态；`loadWorks` 组装 `limit` / `offset` / `sort` / `order`；缓存键与查询键守卫；`refreshAfterDataChange` 清该账号缓存后重拉当前页 |
| 抖音 `src/client/WorksPanel.tsx` | 删除本地排序；表格下方挂 `Pager`；工具栏下方挂 KPI 行；导出禁用态改用 `total`；列表区域四态，KPI 卡不重复失败提示 |
| 抖音 `src/client/schema.ts` | `readWorksPage`：行 + `total` + `summary`，字段缺失按既有规则给 `null` |
| 抖音 `src/client/format.ts` | 保留 `nextWorkSort` 与 `WorkSortState`；删除 `sortWorkRows`、`compareNullableNumbers` |
| 抖音 `src/client/index.ts` | 桶导出同步删除两个排序函数 |
| 抖音 `src/client/MaterialPage.tsx` | 分页区改用 kit `Pager`，删除 `mat.page.*` 文案 |
| 抖音 `src/client/kit-styles.ts` | 追加 `pager.module.css` |
| 抖音 `src/client/workbench.module.css` | 新增 KPI 行网格（断点同视频号 `summaryGrid`，行高取最小值）、分页页脚占位、列表区域居中样式；窄容器下作品面板与列表区域给定高度 |
| 抖音 `src/client/locales.ts` | 2.7 节 KPI 文案；删除 `works.workCountAllTime`、`mat.page.*` |
| 视频号 `src/client/WorkbenchPage.tsx` | 新增 `worksPage`；`loadWorks` 组装排序与分页参数；缓存与守卫同抖音 |
| 视频号 `src/client/WorksPanel.tsx` | 删除本地排序；三处改读聚合值；表格下方挂 `Pager`；列表区域四态与分页页脚占位 |
| 视频号 `src/client/workbench.module.css` | 新增作品页列表区域固定高度、居中与分页页脚占位样式 |
| 视频号 `src/client/schema.ts` | `readWorksPage`：行 + `total` + `gapCount` + `latestCollectedAt` + `completionRatePct` |
| 视频号 `src/client/works-format.ts` | 删除 `sortWorkRows`、`weightedCompletionRate`、`gapWorkCount`、`latestCollectedAt`、`hasCoreGap`；保留 `SortKey`、`SortState`、`DEFAULT_SORT_STATE`、`nextSortState` |
| 视频号 `src/client/kit-styles.ts` | 追加 `pager.module.css` |

## 附录 C：默认采用项

审查时可逐项否决；否决的项回到草案修订。

| 项 | 采用 | 备选 |
|---|---|---|
| 分页方式 | offset + 稳定排序 | 游标 |
| 聚合来源 | 列表接口随带 `summary` / 聚合字段 | 单独聚合工具 |
| 抖音 KPI 五卡 | 作品总数 / 播放合计 / 吸粉合计 / 完播率 / 缺口作品 | 第五卡换「已投流作品」 |
| 抖音工具栏「全部时间作品数」 | 删除（与 KPI 同源同值） | 保留 |
| 素材看板分页 | 改用 kit `Pager` | 保留内联实现 |
| 视频号路由整数字段 | 新增 `'integer'` 类型 | 以字符串传数字 |
| KPI 行网格 | 两个插件各自的 CSS，断点一致 | 再上移 kit `KpiRow` |
