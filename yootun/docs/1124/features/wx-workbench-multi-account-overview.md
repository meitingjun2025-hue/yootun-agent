# wx-workbench-多账号数据汇总总览 实施单

状态：已合入并推送，待发版前真机验收 ｜ 创建：2026-11-24 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

账号总览页（`OverviewPage.tsx`）是单账号页：顶部账号选择器选定一个账号，页面读取 `account.overview`（tools `workbench_wx_account_overview(accountId, window)`）与 `fans.profile.get`（tools `workbench_wx_fans_profile_get(accountId)`），按「全部视频指标 10 卡 → 关注者增长趋势｜增长指标 4 卡 → 关注者画像五维」三段展示。筛选只有账号与时间窗两项，没有跨账号对比，也没有机构级汇总。

### 0.2 目标

账号总览页升级为多账号数据汇总页：默认展示全部账号的汇总指标，提供筛选条件缩小数据范围，新增账号表现表做跨账号对比；选中单个账号时页面退化为该账号的明细视图。时间范围支持枚举窗口与自定义日闭区间，页内全部数据（KPI、趋势）与所选范围同口径，为后续 AI 日报 / 周报的对账提供同一数据通路。展示字段沿用现有账号总览的全部字段。

### 0.3 新页面数据与现有账号总览数据的关系

| 维度 | 结论 |
|---|---|
| 展示字段 | 现有字段的超集：10 卡、4 卡、画像五维全部保留；新增账号表现表，其列是现有账号属性与指标字段按账号拆分 |
| 数据来源 | 不相同。现有页面读单账号工具；新页面在「全部账号」模式下的汇总值（10 卡求和、4 卡求和、合计趋势）由新增聚合工具 `workbench_wx_accounts_overview` 计算，现有单账号工具无法返回 |
| 单账号模式 | 与现有页面口径一致：10 卡 / 4 卡 / 趋势 / 画像均为该账号值 |
| 时间范围 | 枚举窗口沿用现有三档语义；新增自定义日闭区间 `[fromDay, toDay]`，与 `work_list` 的 `publishedFrom/To` 同为上海时区自然日闭区间。趋势图范围跟随当前窗口（窗口不足 7 天时以末日为锚补足 7 天），不再固定近 7 天 |
| 关注者总数 | 全部账号模式 = 各账号窗口内最新非空值之和（各账号最新行日期可能不同，属近似合计，footnote 标注） |
| 画像 | 全部账号模式不展示（画像五维是各账号的分布，跨账号合并没有已确认的业务口径）；选中账号后展示该账号五维 |

## 1. 范围

做：

- tools.dofe.ai 新增 Workbench 只读工具 `workbench_wx_accounts_overview`：按 `accountIds` / `window`（含 `custom` + `fromDay` / `toDay`）/ `sort` / `sessionStatus` 返回机构汇总、跟随窗口的合计趋势与逐账号行；
- yootun-agent Host（`dsh-wx-channels-workbench/src`）新增 action `overview.accounts`，路由 allowlist、错误码白名单同步登记；
- yootun-agent client 重构 `OverviewPage`：筛选器（账号 / 时间窗含自定义起止日期 / 排序 / 会话状态）、汇总 KPI、账号表现表、跟随窗口的趋势与增长指标、画像；全部账号与单账号两种模式；
- `@yootun/dsh-client-ui-kit` 新增 `FilterMenu`（视频号是抖音 `FilterMenu` 之后的第二个消费者，按 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md) 三层创作模型上移）；抖音工作台删除局部 `FilterMenu.tsx` 改为消费 kit；
- 文档同步：本文、[11-wx-workbench-ui-layout-parity.md](../../1110/11-wx-workbench-ui-layout-parity.md) §5、[1124/00-overview.md](../00-overview.md) 索引行状态。

不做：

- 不改 `workbench_wx_account_overview` 与 `workbench_wx_fans_profile_get` 的入参与出参（作品数据 tab 的摘要与单账号画像仍消费它们）；
- 不做负责人筛选：视频号账号实体没有 `owner_name`；
- 不做多选账号：账号筛选为单选，「全部账号」是缺省项；
- 不做画像加权合并；
- 不做爆款视频表、爆款账号分布、运营提醒、导出；
- 不做 KPI 环比：现有页面未展示 `previousTotals`，新工具不返回；
- 不做预设 90 天档：自定义日期可覆盖，不另加枚举值；
- 不改单账号工具 `workbench_wx_account_overview` 的窗口语义（仍为三档枚举）；作品数据 tab 的固定近 7 天摘要（`loadSummary`）不变；
- 不改 `CALLER_DOMAINS`、不改作品数据 tab、不改 `AccountSidebar`。

## 2. 契约增量

### 2.1 工具清单行

| 面 | 工具名 | 入参 | 出参 | 错误码 | 读/写 | 进普通会话 |
|---|---|---|---|---|---|---|
| Workbench | `workbench_wx_accounts_overview` | `accountIds?` `window` `fromDay?` `toDay?` `sort` `sessionStatus?` | `window` `summary` `accounts[]` `availability` | `INVALID_TIME_WINDOW` `INVALID_SORT` `TOO_MANY_ACCOUNTS` `ACCOUNT_NOT_ACCESSIBLE` | 读 | 否 |

tools 契约文档对齐：`docs/1116/yootun-mcp.md` §4.4 视频号清单追加本工具（19 → 20），待同步。

### 2.2 入参

字段命名沿用 wx 域 Workbench 面的 camelCase 入参风格（与 `workbench_wx_account_overview(accountId, window)` 一致）。

| 字段 | 类型 | 必填 | 缺省 | 约束 |
|---|---|---|---|---|
| `accountIds` | `list[str]` | 否 | `None` = 全部 `delete_state='none'` 的账号 | 去重后最多 200 个；显式传入时任一不可达整体拒绝，不返回部分结果 |
| `window` | `Literal['yesterday', 'last_7d', 'last_30d', 'custom']` | 否 | `'last_7d'` | 前三档与单账号工具同语义：窗口末端 = `latestCompletedDay`（上海时间前一自然日）；`custom` 时 `fromDay` / `toDay` 必填 |
| `fromDay` | `DayStr`（`YYYY-MM-DD`） | `custom` 时必填 | `None` | 自定义闭区间起点；非 `custom` 时传入即拒绝 |
| `toDay` | `DayStr`（`YYYY-MM-DD`） | `custom` 时必填 | `None` | 自定义闭区间终点（包含当日）；`fromDay <= toDay <= latestCompletedDay`；区间长度 ≤ `MAX_OVERVIEW_CUSTOM_DAYS`（92）；非 `custom` 时传入即拒绝 |
| `sort` | `Literal['play', 'like', 'net_fans', 'followers', 'works']` | 否 | `'play'` | 决定 `accounts[]` 行序，见 2.4 |
| `sessionStatus` | `Literal['ok', 'expired', 'unknown']` | 否 | `None` = 不过滤 | 与 `accountIds` 叠加：显式点名的 ID 先做存在性校验，再按状态取交集（可为空） |

Pydantic DTO：`WxAccountsOverviewInput(CamelModel)`，字段 `account_ids / window / from_day / to_day / sort / session_status`；`model_validator(mode="after")` 校验 `custom` 与 `from_day` / `to_day` 的配对关系（缺失或多余均抛 `INVALID_TIME_WINDOW`），日期顺序、上界与长度在服务层校验（复用 `queries._parse_day`）。

入参命名沿用 wx 域 Workbench 面的 camelCase（`workbench_wx_work_list` 的 `publishedFrom` / `publishedTo`）；日期语义与 `work_list` 同为上海时区自然日**闭区间**（`toDay` 当日包含），与抖音 `publishTo` 的「截止日 + 1」半开区间不同，实施单与契约文档都明确写出，避免调用方混用。

### 2.3 出参

字段命名沿用 wx 域现有 Workbench 读工具 `workbench_wx_account_overview` 的既有风格：指标与分布字段 snake_case（`metrics.totals.daily_play_count`、`fans_trend.totals.follower_net_count`、`trendDaily[].follower_total_count`，直接复用 `_sum_metric_daily` / `_sum_fans_daily` 的输出键名）；账号与汇总元数据 camelCase（`followerTotalCount`、`daysObserved`、`rowAvailability`、`accountCount`、`trendDaily`）。新工具不引入第三种命名风格。

```json
{
  "window": "last_7d",
  "summary": {
    "accountCount": 3,
    "window": {"startDay": "2026-11-18", "endDay": "2026-11-23"},
    "totals": {
      "daily_play_count": 456000, "daily_like_count": 23000, "daily_favorite_count": 8900,
      "daily_comment_count": 1200, "daily_share_count": 3400, "daily_forward_count": 560,
      "daily_follow_count": 210, "daily_ringset_count": 45, "daily_status_ref_count": 12,
      "daily_status_cover_count": 7, "work_count": 200
    },
    "fans_totals": {"follower_add_count": 400, "follower_reduce_count": 92, "follower_net_count": 308},
    "followerTotalCount": 169000,
    "trendWindow": {"startDay": "2026-11-17", "endDay": "2026-11-23"},
    "trendDaily": [
      {"day": "2026-11-17", "follower_total_count": 168500},
      {"day": "2026-11-18", "follower_total_count": 168780},
      {"day": "2026-11-19", "follower_total_count": null},
      {"day": "2026-11-20", "follower_total_count": 168900},
      {"day": "2026-11-21", "follower_total_count": 168950},
      {"day": "2026-11-22", "follower_total_count": 168980},
      {"day": "2026-11-23", "follower_total_count": 169000}
    ],
    "daysObserved": {"account_metrics": 3, "fans_trend": 3},
    "accountTotal": 3
  },
  "accounts": [
    {
      "account_id": "wx-acc-a", "nickname": "昵称A", "avatar": "https://…/a.png",
      "session_status": "ok", "last_collected_at": "2026-11-23T10:00:00+08:00",
      "feed_count": 120, "follower_total_count": 123000,
      "metrics": {"totals": {"daily_play_count": 301000}, "daysObserved": 7, "daysExpected": 7, "rowAvailability": "ok"},
      "fans_trend": {"totals": {"follower_net_count": 320}, "followerTotalCount": 123000, "daysObserved": 7, "daysExpected": 7, "rowAvailability": "ok"}
    }
  ],
  "availability": {"account_metrics": "partial", "fans_trend": "ok"}
}
```

`accounts[]` 每行字段：

| 字段 | 来源 | 说明 |
|---|---|---|
| `account_id` `nickname` `avatar` `session_status` `last_collected_at` `feed_count` | `account_payload(record)` | 复用 `serializers.py` 现有投影，不新增账号字段 |
| `follower_total_count` | `fans_trend.followerTotalCount` | 窗口内最新非空行；为空时回退账号记录的 `follower_total_count` |
| `metrics` | `_sum_metric_daily(db, account_id, start, end)` 输出原样 | 含 `totals` / `daysObserved` / `daysExpected` / `rowAvailability`；`window=yesterday` 时 `totals` 为末日单日值，与单账号工具一致；`custom` 单日区间 `[D, D]` 的 `totals` 自然即该日单日值 |
| `fans_trend` | `_sum_fans_daily` 输出去掉 `daily` 与 `window` | 减小载荷；逐日趋势只由 `summary.trendDaily` 提供 |

### 2.4 口径定义

| 项 | 规则 |
|---|---|
| 账号集合 | `accountIds` 缺省或空 → 全部 `delete_state='none'`；显式传入 → 去重、校验每个都存在且 `delete_state='none'`，任一失败抛 `ACCOUNT_NOT_ACCESSIBLE`；再按 `sessionStatus` 过滤（空集是合法结果，`summary.accountCount=0`） |
| 枚举窗口 | 与 `queries.account_overview` 完全相同：`end_day = latestCompletedDay()`，`start_day = end_day - (size-1)`；`yesterday` 的 `size=2`，totals 只取末日 |
| yesterday 窗口 | 新工具按末日单日 `[D, D]` 处理：`totals` / `work_count` / `daysObserved` / `availability` / `summary.window` 全部单日口径；不返回 `previousTotals`；名义 2 天窗口只服务单账号工具的环比（2026-11-25 验收修正） |
| 自定义窗口 | `from_day = _parse_day(fromDay)`、`to_day = _parse_day(toDay)`；校验顺序：格式（`INVALID_TIME_WINDOW`）→ `from_day <= to_day`（`INVALID_TIME_WINDOW`）→ `to_day <= latestCompletedDay()`（`INVALID_TIME_WINDOW`，当天未收盘不入日表）→ `(to_day - from_day).days + 1 <= MAX_OVERVIEW_CUSTOM_DAYS`（`INVALID_TIME_WINDOW`）。单日区间合法（日报对账用）。`summary.window` 回传实际 `{startDay, endDay}` 供调用方核对 |
| 汇总求和 | `summary.totals` 与 `summary.fans_totals` = 各账号同行字段求和；某字段在所有账号都缺失时该字段**不出现**（不写 0）；某账号缺失该字段则不计入。`summary.totals.work_count` 为各账号窗口内发布作品数（`wx_channels_work.publish_time` 落窗）之和；账号无 work 记录时该键不出现，有记录而窗口内为 0 返回 0 |
| 汇总关注者总数 | `summary.followerTotalCount` = 各账号 `follower_total_count` 非空值之和；全部缺失时为 `null` |
| 合计趋势 | `summary.trendWindow` 跟随窗口：`trend_end = window_end`，`trend_start = trend_end - (max(window_days, 7) - 1)`，即窗口不足 7 天时以末日为锚补足 7 天、等于或超过 7 天时与窗口重合；`yesterday` → 7 天（与现状一致），`last_7d` → 7 天，`last_30d` → 30 天，`custom [Mon, Sun]` → 7 天（周报范围），`custom [D, D]` → 7 天（含 D 的近一周），`custom [11-01, 11-30]` → 30 天（月报范围）。`trendDaily[i].follower_total_count` = 该日各账号 `follower_total_count` 非空值之和，该日全部缺失为 `null`；行数 = 趋势天数，缺失日不省略。趋势查询范围与窗口查询范围合并为一次 `IN` 查询（`min(window_start, trend_start) .. window_end`），内存分别聚合 |
| 对账契约 | 日报 / 周报等报告生成方调用本工具时，与页面使用同一入参得到同一结果：同一 `[fromDay, toDay]` 的 `summary.totals` / `fans_totals` / `followerTotalCount` / `trendDaily` 完全确定（日表是已完成日的快照，采集补录历史日会改变结果，报告应记录生成时刻）。数据完整性由 `daysObserved` / `daysExpected` / `availability` 三项表达，报告方据此判定 `ok` / `partial` / `no_data`，不得把缺失日当 0 |
| 汇总 availability | 每账号 `metrics.rowAvailability` / `fans_trend.rowAvailability` 聚合：全部 `no_data` → `no_data`；全部 `ok` → `ok`；其余 → `partial`；账号集合为空 → `no_data` |
| `summary.accountCount` | 过滤后的账号数；`summary.accountTotal` = 过滤前 `delete_state='none'` 的账号数（供 UI 显示「共 N 个账号」与筛选命中率） |
| `summary.daysObserved` | 汇总窗口内有日表行的去重日历天数（`account_metrics` / `fans_trend` 分源），供报告方判断窗口覆盖（2026-11-25 验收确认口径） |
| 排序 | `play` → `metrics.totals.daily_play_count`；`like` → `daily_like_count`；`net_fans` → `fans_trend.totals.follower_net_count`；`followers` → `follower_total_count`；`works` → `metrics.totals.work_count`。均降序，缺失值排最后，同值按 `account_id` 升序保证稳定 |
| 性能 | 服务端用一次 `account_id IN (...)` 查询取 `min(window_start, trend_start) .. window_end` 内全部账号日行，内存按 `account_id` 分组，不逐账号循环查询；200 账号 × 92 天 = 18400 行 / 表为上限，可接受 |

### 2.5 错误码

| 错误码 | 触发 | HTTP 语义 |
|---|---|---|
| `INVALID_TIME_WINDOW` | `custom` 缺 `fromDay` / `toDay` 或非 `custom` 带日期（DTO validator 配对校验）；日期格式非法、`fromDay > toDay`、`toDay` 晚于 `latestCompletedDay`、区间超过 92 天（服务层四项校验）（2026-11-25 修正：枚举非法实际由签名 Literal 前置拦截，见下） | 400 |
| `VALIDATION_ERROR` | `window` / `sort` / `sessionStatus` 不在枚举内（MCP 签名 Literal 前置拦截） | 400 |
| `INVALID_SORT` | `sort` 不在枚举内 | 400 |
| `TOO_MANY_ACCOUNTS` | 去重后 `accountIds` 超过 200 | 400 |
| `ACCOUNT_NOT_ACCESSIBLE` | 显式传入的任一 `accountIds` 不存在或已删除 | 400 |

`INVALID_TIME_WINDOW` / `INVALID_SORT` / `ACCOUNT_NOT_ACCESSIBLE` 已在 yootun-agent `errors.ts` 的 `SERVER_ERROR_CODES` 白名单内；`TOO_MANY_ACCOUNTS` 不在（2026-11-25 阶段 3 实现发现，实施单原表述「四个码都已在白名单」不准确），已追加——不加则该码被 `safeCode` 收敛为 `WX_TOOL_UNAVAILABLE`，UI 显示误导性文案。

### 2.6 与单账号工具的关系

| 场景 | 工具 |
|---|---|
| 账号总览页（全部账号模式） | `workbench_wx_accounts_overview` |
| 账号总览页（单账号模式，10 卡 / 4 卡 / 趋势） | `workbench_wx_accounts_overview(accountIds=[x])`，与全部模式同一数据通路 |
| 账号总览页（单账号模式，画像五维） | `workbench_wx_fans_profile_get`（不变） |
| 作品数据 tab 摘要 | `workbench_wx_account_overview(window='last_7d')`（不变） |

### 2.7 契约文档对齐

tools `docs/1116/yootun-mcp.md` §4.4 清单追加 `workbench_wx_accounts_overview`，并把该节标题的计数加一；§6.1 参数与响应规范无需改动。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | `src/tools_dofe/mcp/domains/yootun/registry.py` | 域工具名元组、`YOOTUN_TOOL_MANIFEST._read`、`WORKBENCH_TOOLS` 映射（`workbench_wx_accounts_overview` → `wx_channels_accounts_overview`）、计数断言加一 | 是 | 速查表「新增 `workbench_<domain>_*` 工具（已有域）」行 |
| tools.dofe.ai | `src/tools_dofe/mcp/capabilities.py`、`service_policies.py` | 登记源能力 `wx_channels_accounts_overview`（读） | 是 | 源能力清单与策略同步 |
| tools.dofe.ai | `src/tools_dofe/mcp/domains/yootun/workbench/server.py` | `_IMPLEMENTED_TOOLS`、分发表、`workbench_wx_accounts_overview()` 函数 | 是 | 工具实现 |
| tools.dofe.ai | `src/tools_dofe/services/wx_channels_operation/schemas.py`、`queries.py`、`constants.py` | `WxAccountsOverviewInput`（含 `custom` 配对 validator）、`accounts_overview()`、新增 `MAX_OVERVIEW_CUSTOM_DAYS = 92`、窗口解析函数 `_resolve_window()` | 是 | 服务层 |
| tools.dofe.ai | `docs/1116/yootun-mcp.md` §4.4 | 清单加一 | 是 | 契约唯一来源 |
| tools.dofe.ai | `tests/yootun/test_workbench_wx_tos.py` | 工具计数断言加一；新增聚合用例 | 是 | 行为与计数 |
| docker-helm.dofe.ai | — | 无 | 否 | 路由按 server 级（`/mcp/tools/yootun/v1/workbench`），不按工具名；无新队列 / env / URL |
| yootun-agent | `yootun/packages/dsh-client-ui-kit/src/filter-menu.tsx` + `filter-menu.module.css` + `index.ts` | 新增 `FilterMenu` | 是 | 第二个消费者出现时必须抽取 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/FilterMenu.tsx`、`OverviewPage.tsx` 等消费点、`kit-styles.ts` | 删除局部组件，改从 kit 导入；样式表清单加 `filter-menu.module.css` | 是 | 消除重复实现 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/route.ts`、`errors.ts` | `ACTION_SCHEMAS` 新增 `overview.accounts`（含 `fromDay` / `toDay`）；错误码白名单不变 | 是 | 路由显式 allowlist |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/handlers.ts` | `overview.accounts` → `workbench_wx_accounts_overview` 映射 | 是 | Host handler |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/src/client/{schema,OverviewPage,WorkbenchPage,format}.tsx`、`locales.ts`、`workbench.module.css`、`kit-styles.ts` | 投影、页面重构、自定义日期输入与越界纠偏、`shiftDay`、文案、样式 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-wx-channels-workbench/tests/*` | action 清单、投影、页面、样式守护 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/11-wx-workbench-ui-layout-parity.md` §5 | 总览页布局条款更新 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1124/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 11 册 §5） | 2026-11-25 | `feat/wx-multi-account-overview` → `main` | 阶段 1–3 验收通过；本地联调结论见附录 G，随代码一并合入 |
| tools 合入 `dev` | 2026-11-25 | `feat/wx-accounts-overview` → `dev`，合并提交 `4d14134`，已推送 | 阶段 1 验收通过：966 passed / 2 skipped，ruff 0 新增；本地联调数据层对账 22 个场景全部一致（附录 G.2） |
| docker-helm 部署测试环境 | — | — | docker-helm 无改动；测试环境部署与服务端 `tools/list` 核对未做，`dev` 已推送不等于服务端已上线 |
| yootun-agent 合入 `main` | 2026-11-25 | `feat/wx-multi-account-overview` → `main`，合并提交 `c37b2ba287`，已推送 | 本地联调通过（附录 G）；真机验收待发版前 |
| 发版 | | | 待填 |

## 5. 验收

- [x] tools：`pytest tests/yootun/test_workbench_wx_tos.py` 全过；`tools/list` 含 `workbench_wx_accounts_overview` 且 manifest read 标记（`readOnly=true` 指 `YOOTUN_TOOL_MANIFEST` effect=read，协议层无 readOnlyHint 字段）；
- [x] tools：tools/list 与 `docs/1116/yootun-mcp.md` §4.4 清单逐名一致（核对脚本通过；curl 需部署环境，联调时复核）；
- [x] tools：`window='yesterday'` 时 `summary.totals` 等于各账号末日单日值之和；`trendWindow` 为末日锚定的 7 天；
- [x] tools：`window='custom'` 单日区间 `[D, D]` 的 `totals` 等于该日单日值；7 天区间 `trendWindow` 恰为窗口；30 天区间 `trendWindow` 为 30 天；`summary.window` 回传与入参一致；
- [x] tools：`custom` 缺 `fromDay` / 非 `custom` 带 `toDay` / `fromDay > toDay` / `toDay` 为今天 / 区间 93 天 → 均返回 `INVALID_TIME_WINDOW`（枚举非法由签名 Literal 前置拦截为 `VALIDATION_ERROR`）；
- [x] tools：显式传入不存在的 `accountIds` 返回 `ACCOUNT_NOT_ACCESSIBLE`；`sessionStatus` 过滤后空集返回 `accountCount=0`、`availability=no_data`；
- [x] yootun-agent：`pnpm --filter @yootun/dsh-client-ui-kit test`（64 passed）、`build` 通过；
- [x] yootun-agent：`pnpm --filter @yootun/dsh-douyin-workbench test`（node --test 全过 + vitest 126 passed）、`build` 通过（FilterMenu 迁移无回归）；前置 `pnpm --filter @yootun/dsh-workbench-mcp build`；
- [x] yootun-agent：`pnpm --filter @yootun/dsh-wx-channels-workbench test`（node --test 77 全过 + vitest 69 passed、1 项详情 Modal 用例为基线预存失败，独立 stash 核实）、`build` 通过；
- [x] yootun-agent：`pnpm run lint` exit 0（tools 仓 ruff 39 条 = dev 基线 39，0 新增）；
- [x] yootun-agent：wx 包 source-conventions 守护通过（无工具数量字面量、域门 whitelist 无工具名）；
- [x] 本地联调 e2e：全部账号模式汇总值 = 各账号单账号工具返回值之和（`work_count` 不适用——单账号工具不产出该字段；`followerTotalCount` 在账号窗口内无 fans 行时回退账号记录值而单账号工具为 `null`，属 2.3 规定的口径差）；单账号模式 10 卡 / 4 卡 / 趋势 = 单账号工具返回值——`yesterday` / `last_7d` / `last_30d` 三档差异 0（附录 G.3）；
- [x] 本地联调 e2e：页面选 `custom [Mon, Sun]` 的 10 卡 / 4 卡 / 趋势 / 账号表现表，与直接调用 `workbench_wx_accounts_overview(window='custom', fromDay=Mon, toDay=Sun)` 的返回逐字段一致（日报 / 周报对账基础）——42 个比对点数值全部一致（附录 G.3）；
- [ ] 真机（待发版前）：三入口、明暗主题、三档容器宽度（1120 / 880 / 640）；筛选 chips 可清除；表格行键盘 Enter 选中账号；画像在全部账号模式为空态、单账号模式为五维；`custom` 时起止日期输入出现、`max` 为昨日、起 > 止时另一端跟随、空值不触发请求（jsdom 页面测试已覆盖交互逻辑，视觉目检待真机）；
- [x] 实施单第 4 节回填完整。

## 附录 A：数据读取方式

### A.1 数据流

```text
OverviewPage.tsx
  │ hostAction('overview.accounts', { accountId, window, sort, sessionStatus })
  ▼
POST /api/desktop/yootun/wx-workbench        （api.ts，同源，credentials: same-origin）
  ▼
route.ts createRouteHandler
  │ ACTION_SCHEMAS['overview.accounts'] 校验字段与长度；未知字段 → WX_ROUTE_INVALID_REQUEST
  ▼
handlers.ts buildRouteHandlers
  │ 'overview.accounts' → callWx(deps, 'workbench_wx_accounts_overview', args)
  ▼
ctx.yootunWorkbench.callTool('wx-workbench', 'wx', name, args)
  │ Workbench 面域门：caller='wx-workbench' 的域为 ['wx']，工具名前缀 workbench_wx_ → 放行
  │ 服务端未广播 → workbench_tool_unavailable；业务失败 → 服务端 error.code 投影
  ▼
tools.dofe.ai /mcp/tools/yootun/v1/workbench
  │ workbench_wx_accounts_overview → WxAccountsOverviewInput → wx_query_service.accounts_overview(db, …)
  ▼
PostgreSQL wx_channels_account_metric_daily / wx_channels_fans_daily / wx_channels_account
```

单账号模式下的画像走现有通路 `hostAction('fans.profile.get', { accountId })`，不变。

### A.2 Host action 契约

`route.ts` `ACTION_SCHEMAS` 新增：

```ts
'overview.accounts': { fields: { accountId: 'string', window: 'string', fromDay: 'string', toDay: 'string', sort: 'string', sessionStatus: 'string' }, limits: { accountId: 128, window: 16, fromDay: 10, toDay: 10, sort: 16, sessionStatus: 16 } },
```

`ActionArgs` 的值类型是 `string | boolean | undefined`，六个参数都是字符串，与现有 `account.overview`、`works.list` 的 `publishedFrom/To`（limit 10）一致。

`handlers.ts` `workbenchActions` 新增：

```ts
'overview.accounts': args => ['workbench_wx_accounts_overview', {
  ...(asString(args, 'accountId') !== '' ? { accountIds: [asString(args, 'accountId')] } : {}),
  window: asString(args, 'window'),
  ...(asString(args, 'fromDay') !== '' && asString(args, 'window') === 'custom' ? { fromDay: asString(args, 'fromDay') } : {}),
  ...(asString(args, 'toDay') !== '' && asString(args, 'window') === 'custom' ? { toDay: asString(args, 'toDay') } : {}),
  sort: asString(args, 'sort'),
  ...(asString(args, 'sessionStatus') !== '' ? { sessionStatus: asString(args, 'sessionStatus') } : {}),
}],
```

Host 不解析聚合结果，`structuredContent` 原样透出（与 `account.overview` 的 `compat()` 路径一致），客户端 `schema.ts` 负责投影。

### A.3 请求装配

| 筛选态 | 请求参数 |
|---|---|
| 账号 = 全部账号 | 不传 `accountIds` |
| 账号 = 某账号 | `accountIds: [accountId]` |
| 时间窗 | `window` 原样透传（`yesterday` / `last_7d` / `last_30d`） |
| 时间窗 = 自定义 | `window: 'custom'` + `fromDay` / `toDay`（`YYYY-MM-DD` 闭区间）；两端任一为空时不发请求（受控输入保留当前值） |
| 排序 | `sort` 原样透传 |
| 会话状态 = 全部 | 不传 `sessionStatus` |
| 会话状态 = 正常 / 已过期 | `sessionStatus: 'ok'` / `'expired'` |

每次筛选变化发一次请求；页面不拆成多次请求再在客户端合并。

日期输入的 `max` 固定为 `recentDays(1)[0]`（上海时区昨日，与服务端 `latestCompletedDay` 同口径），浏览器层先挡住未来日期，服务端再兜底校验；`min` 不设下限（日表最早行由采集决定，早于最早行的范围返回 `no_data`）。

### A.4 响应投影（`schema.ts`）

新增类型与读取函数，命名与现有 `readOverview` 风格一致：

| TS 类型 | 对应 JSON | 说明 |
|---|---|---|
| `AccountsOverviewTotals` | `summary.totals` | 11 个 `number \| null` 字段，键名与 `OverviewTotals` 相同，便于复用 `METRIC_CARDS` |
| `AccountsOverviewSummary` | `summary` | `accountCount` `accountTotal` `totals` `fansTotals` `followerTotalCount` `trendDaily[]` `availability` |
| `AccountsOverviewRow` | `accounts[i]` | `accountId` `nickname` `avatar` `sessionStatus` `lastCollectedAt` `feedCount` `followerTotalCount` `totals`（← `metrics.totals`）`fansTotals`（← `fans_trend.totals`）`availability{accountMetrics ← metrics.rowAvailability, fansTrend ← fans_trend.rowAvailability}` |
| `AccountsOverviewData` | 顶层 | `window` `summary` `rows: AccountsOverviewRow[]` |

`readAccountsOverview(payload: Record<string, unknown>): AccountsOverviewData`：

- 复用现有 `recordOf` / `pick` / `numberOf` / `textOf` 工具函数；缺失与非数值一律 `null`，不补 0；
- `summary.totals` 的字段映射与 `readOverview` 中 `metrics.totals` 的映射逐字段相同（`daily_play_count → playCount` 等 11 项），抽成共用的 `readMetricTotals(record)` 供两处调用，避免两份映射漂移；
- `summary.fans_totals` 的映射与现有 `fans_trend.totals` 相同，抽成 `readFansTotals(record)`；
- `trendDaily` 每行 `{ day, follower_total_count }` 映射为 `TrendRow` 兼容的 `{ day, values: { total } }`，缺 `day` 的行丢弃；
- `accounts[i].metrics.totals` 与 `accounts[i].fans_trend.totals` 走同一对映射函数。

### A.5 页面数据状态机

页面持有三组独立状态，互不覆盖：

| 状态组 | 取值 | 驱动 |
|---|---|---|
| `overviewState` | `loading` / `ready` / `partial` / `empty` / `error` | `overview.accounts` 请求结果与 `summary.availability` |
| `profileState` | `loading` / `ready` / `empty` / `error` / `hidden` | 单账号模式下 `fans.profile.get`；全部账号模式固定 `hidden` |
| `refreshing` | `boolean` | 同一筛选键重复请求时为 `true`（淡化，不整页替换） |

状态推导规则与现有 `serverState()` 一致：`fetchError → error`；`availability=partial → partial`；`no_data → empty`；`ok` 且有值 → `ready`。全部账号模式下 `accountCount=0`（筛选后空集）→ `empty`，文案与「暂无账号」区分。

加载策略：

| 场景 | 行为 |
|---|---|
| 首次进入 | `loading` 骨架，三段数据区都呈骨架 |
| 筛选键变化且无缓存 | 清空已渲染值 → `loading`（旧筛选的数值不得在新筛选名下展示） |
| 筛选键变化且缓存命中 | 即时渲染缓存值（`ready`），后台刷新；刷新期间 `refreshing=true` 淡化 |
| 同筛选键手动重试 / 刷新 | 保留已渲染值 + `refreshing=true` |
| 请求失败 | 丢已渲染值 → `error`，显示重试 |

### A.6 缓存与竞态

- 缓存键：`${accountId}|${window}|${fromDay}|${toDay}|${sort}|${sessionStatus}` 六段字符串（非 `custom` 时 `fromDay` / `toDay` 为空串），`Map<string, { data, at }>`；缓存只在内存，不持久化；
- 请求代次：`seqRef` 单调递增，响应回来时 `seqRef.current !== seq` 直接丢弃；与现有 `loadSeqRef` 模式相同；
- 筛选键守卫：响应回来时若当前筛选键已不等于发起时的键，丢弃（防止 A→B→A 快速切换时旧 A 响应覆盖新 A 响应）；
- 账号列表变化（新增 / 删除账号）时清空全部缓存：`accounts` prop 的 `accountId` 集合变化即视为失效；
- 缓存条目上限 32 条，超出按插入顺序淘汰；
- 画像请求与聚合请求共用同一 `seqRef`，切换账号时画像响应同样受代次守卫。

### A.7 错误与降级

| 失败 | 页面表现 |
|---|---|
| `overview.accounts` 返回 `WX_TOOL_UNAVAILABLE` | 三段数据区 `error`，文案 `error.WX_TOOL_UNAVAILABLE`，重试按钮 |
| `ACCOUNT_NOT_ACCESSIBLE`（账号在请求期间被删除） | `error`，重试时若账号列表已刷新则自动退回「全部账号」 |
| 服务端 `availability=partial` | 有值直排 + 区块级提示行 `overview.metricsPartial`，不逐卡插警告 |
| 某账号行 `metrics.rowAvailability` 与 `fans_trend.rowAvailability` 同时为 `no_data` | 该行数值列因 `null` 自然显示「—」；账号列追加 Tag「暂无数据」（`tone='warning'`）；只有一个源 `no_data` 时不加 Tag，该源对应列显示「—」 |
| `accounts.list` 远端失败 `remoteOk=false` | 现有行为：仍展示本地账号；账号筛选器只用本地账号，`overview.accounts` 不传 `accountIds` 时服务端按自己的账号集合返回，表格行以服务端为准 |
| 画像 `fans.profile.get` 失败 | 仅画像区 `error`，不影响前两段 |

### A.8 单账号画像

全部账号模式 `profileState='hidden'`，不发 `fans.profile.get`；切换到单账号（筛选器选账号或表格行点击）时发请求，逻辑与现有 `OverviewPage.load` 中画像分支相同（`readFansProfile(res, t)`，`availability` 取 `fans.profile.get` 自身的 `availability` 字段）。

## 附录 B：UI 设计

### B.1 页面线框

全部账号模式（缺省）：

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ 账号 [全部账号 ▾]  时间窗 [近 7 天 ▾]  排序 [按播放量 ▾]  会话状态 [全部 ▾]        │  B.3
│ (时间窗: 近 7 天 ×)                                                            │  chips
├────────────────────────────────────────────────────────────────────────────────┤
│ 全部视频指标                                                      共 3 个账号   │  B.2 ①
│ ┌────────┬────────┬────────┬────────┬────────┐                               │
│ │ 播放    │ 喜欢    │ 收藏    │ 评论    │ 分享    │                               │
│ │ 45.6w  │ 2.3w   │ 8900   │ 1200   │ 3400   │                               │
│ ├────────┼────────┼────────┼────────┼────────┤                               │
│ │ 转发    │ 关注量  │ 铃声    │ 状态    │ 封面    │                               │
│ │ 560    │ 210    │ 45     │ 12     │ 7      │                               │
│ └────────┴────────┴────────┴────────┴────────┘                               │
│ ⓘ 该时间窗内部分日期的数据尚未采集，已展示内容均为已采集的真实数据              │  partial 提示
├────────────────────────────────────────────────────────────────────────────────┤
│ 账号表现                                                                       │  B.2 ②
│ ┌──┬──────────────────┬─────────┬─────────┬─────────┬────────┬───────┬──────┬──────┬──────────┐ │
│ │# │ 账号              │ 关注者   │ 净增     │ 播放     │ 喜欢   │ 评论  │ 分享 │ 作品 │          │ │
│ ├──┼──────────────────┼─────────┼─────────┼─────────┼────────┼───────┼──────┼──────┼──────────┤ │
│ │1 │ ● 昵称A  [正常]   │ 12.3w   │ +320    │ 30.1w   │ 1.5w   │ 8000  │ 2.1k │ 120  │          │ │
│ │2 │ ● 昵称B  [已过期] │ 3.4w    │ —       │ 15.5w   │ 8000   │ 4000  │ 1.3k │ 80   │          │ │
│ │3 │ ● 昵称C  [正常]   │ 1.2w    │ -12     │ —       │ —      │ —     │ —    │ 0    │ 暂无数据 │ │
│ └──┴──────────────────┴─────────┴─────────┴─────────┴────────┴───────┴──────┴──────┴──────────┘ │
│ ⓘ 关注者总数为各账号最新关注者之和                                             │  footnote
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌───────────────────────────────────────┐ ┌─────────────────────────────┐     │  B.2 ③
│ │ 关注者总数趋势（近 7 天）               │ │ 关注者增长指标                 │     │
│ │                                     │ │ 净增 +308   新增 +400        │     │
│ │           ╱‾‾╲    ╱‾‾               │ │ 取消 -92    总数 16.9w        │     │
│ │      ╱‾‾╱     ╲╱                   │ │                               │     │
│ │  11-17 ───────────────── 11-23     │ │                               │     │
│ └───────────────────────────────────────┘ └─────────────────────────────┘     │
├────────────────────────────────────────────────────────────────────────────────┤
│ 关注者画像                                                                     │  B.2 ④
│ ┌───────────────────────────────────────────────────────────────────────────┐   │
│ │  在「账号表现」表中选择一个账号查看画像                                      │   │
│ └───────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

自定义日期态（时间窗选「自定义」，筛选器局部；其余区块结构与全部账号模式相同，数据范围变为所选区间）：

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ 账号 [全部账号 ▾]  时间窗 [自定义 ▾] [2026-11-16] 至 [2026-11-22]  排序 [按播放量 ▾]  会话状态 [全部 ▾] │
│ (时间窗: 2026-11-16 至 2026-11-22 ×)                                            │
└────────────────────────────────────────────────────────────────────────────────┘
```

单账号模式（筛选器选中昵称 A，或点击表格第 1 行）：

```text
┌────────────────────────────────────────────────────────────────────────────────┐
│ 账号 [昵称A ▾]  时间窗 [近 7 天 ▾]  排序 [按播放量 ▾]  会话状态 [全部 ▾]          │
│ (账号: 昵称A ×) (时间窗: 近 7 天 ×)                                              │
├────────────────────────────────────────────────────────────────────────────────┤
│ 全部视频指标                                                      该账号 · 近 7 天│
│ （10 卡 = 昵称A 的值）                                                          │
├────────────────────────────────────────────────────────────────────────────────┤
│ 账号表现                                                      共 1 个账号        │
│ │1 │ ● 昵称A  [正常] ◀选中  │  仅该账号一行；切换账号经筛选器或清除 chip（2026-11-25 修正）│
├────────────────────────────────────────────────────────────────────────────────┤
│ 关注者总数趋势（近 7 天）        │ 关注者增长指标                                 │
│ （折线 = 昵称A）                 │ （4 卡 = 昵称A）                               │
├────────────────────────────────────────────────────────────────────────────────┤
│ 关注者画像 · 截止 11-23                                                         │
│ [性别环形] [设备环形] [年龄柱状] / [省份 Top5] [城市 Top5]                       │
└────────────────────────────────────────────────────────────────────────────────┘
```

### B.2 区块规格

| 区块 | 容器 | 内容 | 数据 |
|---|---|---|---|
| 筛选器 | kit `FilterBar`（`children` 放 4 个 `FilterMenu`，`chips` 放生效筛选） | 见 B.3 | `accounts`（账号选项）、`summary.accountTotal`（命中数） |
| ① 全部视频指标 | `DataCard`，`title=overview.section.metrics`，`description=共 N 个账号 / 该账号 · 窗口`，`state='ready'`，`footnote=overview.dataSource` | `kpiGrid` 固定 10 张 `KpiCard`，每张只有 `label` 与 `value`，不带逐卡 `footnote`（2026-11-25 调整：口径说明只在区块 `description` 与 `footnote` 各出现一次） | `summary.totals`；单账号模式取 `rows.find(accountId).totals` |
| ② 账号表现 | `DataCard`，`title=overview.section.accounts`，`description=overview.section.accountsCount{count}`，`state='ready'`，`footnote=overview.followersSumNote` | `tableWrap > table.dataTable`，见 B.4 | `rows`（服务端已按 `sort` 排序） |
| ③ 关注者增长 | `growthGrid`（≥1120 双列：趋势 1.4fr ｜ 指标 0.8fr） | 左：`ChartFrame + LineTrendChart`（单序列 `total`），标题为现有文案 `chart.fansTrend` 加范围「（{trendWindow}）」；该文案含固定的「近 7 天」字样，窗口为 30 天或自定义时与括号内范围不符（2026-11-25 联调发现，文案待调整）；右：`DataCard` + `kpiGrid4` 4 张 `KpiCard` | 趋势：`summary.trendDaily` 按 `summary.trendWindow` 逐日对齐（7 / 30 / ≤92 行，缺日 null 断线；x 轴标签按行数稀疏：≤7 全显、≤31 首尾 + 中点、>31 首尾）；4 卡：`summary.fansTotals` + `summary.followerTotalCount`；单账号模式取该账号行 |
| ④ 关注者画像 | `DataCard`，`title=overview.section.portrait`，`description=截止 {day}` | 全部账号：`DataState state='empty'` 文案 `overview.portrait.pickAccount`；单账号：现有 `portraitGrid` + `portraitGrid2` 五维，代码不变 | `fans.profile.get`（单账号） |

KPI 卡 `state` 推导沿用现有 `kpiState()`：`ready` / `partial` 下有值直排、无值 `empty`；`loading` / `error` 整卡对应态。「净增关注」卡在 `value > 0` 时红字 `+N`、`< 0` 时绿字 `-N`、`0` 与 `null` 无色（新增 `formatDelta`，色值复用 `--dsw-alias-state-error-primary` / `--dsw-alias-state-success-primary`）。

### B.3 筛选器

| 筛选器 | `FilterMenu` 配置 | 选项 | 缺省 | chip |
|---|---|---|---|---|
| 账号 | `label=overview.filter.account`，`visibleLabel` 同 | 首项 `id=''` label `overview.filter.account.all`；其后 `accounts`（跳过 `isPending` 与 `deleteState='remote_deleted'`），label 为 `nickname ?? accountId` | `''` | `id !== ''` 时显示 `overview.chip.account{value}`；清除 → `accountId=''` |
| 时间窗 | `label=overview.filter.window` | `yesterday` / `last_7d` / `last_30d`（label 复用 `overview.window.*`）/ `custom`（label `overview.window.custom`） | `last_7d` | 恒显示 `overview.chip.window{value}`；`custom` 时 value 为 `overview.range.custom{from, to}`；清除 → `last_7d`，同时清空 `customFrom` / `customTo` |
| 自定义起止（仅 `custom` 时显示） | 时间窗按钮右侧 `customRange` 容器：两个 `<input type='date'>`，`aria-label` 分别为 `overview.filter.customFrom` / `overview.filter.customTo`，中间 `customRangeDash` | — | 初值：`customFrom = customTo = recentDays(1)[0]`（昨日） | `max = recentDays(1)[0]`；起 `max` 另受 `customTo` 约束，止 `min` 另受 `customFrom` 约束；越界纠偏见下表 |
| 排序 | `label=overview.filter.sort` | `play` / `like` / `net_fans` / `followers` / `works`，label `overview.sort.*` | `play` | `!== 'play'` 时显示；清除 → `play` |
| 会话状态 | `label=overview.filter.session` | `''`（`overview.filter.session.all`）/ `ok`（`overview.tag.sessionOk`）/ `expired`（`overview.tag.sessionExpired`） | `''` | `!== ''` 时显示；清除 → `''` |

联动规则：

| 操作 | 结果 |
|---|---|
| 会话状态变为 `expired`，而当前账号 `sessionStatus !== 'expired'` | 账号重置为「全部账号」（单次 setState、单次请求） |
| 账号变为具体账号，而当前会话状态与该账号不符 | 会话状态重置为「全部」 |
| 清除全部 chips | 四项全部回缺省（`DEFAULT_OVERVIEW_FILTERS`） |
| 表格行点击 / Enter | 账号筛选设为该行 `accountId`；会话状态若与该行不符则重置为「全部」 |
| 时间窗切到 `custom` | `customFrom` / `customTo` 为空时初始化为昨日；已填过则保留上次值 |
| 修改起始日期致 `from > to` | `customTo` 跟随为新 `from`（单次 setState、单次请求） |
| 修改截止日期致 `to < from` | `customFrom` 跟随为新 `to`（单次 setState、单次请求） |
| 日期输入清空（空串） | 不提交、不触发请求；受控值保留上一次合法值，直到两端都合法才发请求 |
| 时间窗从 `custom` 切回枚举 | `fromDay` / `toDay` 不再透传（Host 侧也按 `window === 'custom'` 过滤） |

筛选态类型（`OverviewPage.tsx` 导出，页面级持有）：

```ts
export type TimeWindow = 'yesterday' | 'last_7d' | 'last_30d' | 'custom'
export interface OverviewFilters { accountId: string; window: TimeWindow; customFrom: string | null; customTo: string | null; sort: OverviewSort; sessionStatus: '' | 'ok' | 'expired' }
export const DEFAULT_OVERVIEW_FILTERS: OverviewFilters = { accountId: '', window: 'last_7d', customFrom: null, customTo: null, sort: 'play', sessionStatus: '' }
```

`customFrom` / `customTo` 为 `null` 表示尚未初始化（首次切到 `custom` 时填昨日）；为空串表示用户清空了输入，此时不发请求。越界纠偏与空值不提交两点对齐抖音 `OverviewPage.applyCustomRange`。

### B.4 账号表现表

| 列 | `th` 文案 | 单元格 | 字段 | 格式 | 对齐 |
|---|---|---|---|---|---|
| 排名 | `overview.col.rank` | 行序号（服务端排序后的索引 + 1） | — | 整数 | 右 |
| 账号 | `overview.col.account` | 头像（`avatar`，28px 圆形，缺省首字符）+ `nickname ?? accountId` + 会话状态 Tag（`ok` 中性 / `expired` `tone='danger'` / 其他不显示）+ `availability.accountMetrics === 'no_data' && availability.fansTrend === 'no_data'` 时追加 Tag「暂无数据」（`tone='warning'`） | `nickname` `avatar` `sessionStatus` `availability` | — | 左 |
| 关注者 | `overview.col.followers` | `followerTotalCount` | `formatCount` | 右 |
| 净增 | `overview.col.netFans` | `fansTotals.netCount`，带符号与涨跌色 | `formatDelta` | 右 |
| 播放 | `col.play` | `totals.playCount` | `formatCount` | 右 |
| 喜欢 | `col.like` | `totals.likeCount` | `formatCount` | 右 |
| 评论 | `col.comment` | `totals.commentCount` | `formatCount` | 右 |
| 分享 | `col.share` | `totals.shareCount` | `formatCount` | 右 |
| 作品 | `overview.col.works` | `totals.workCount`，为空时回退 `feedCount` | `formatCount` | 右 |

- 共 9 列（2026-11-25 调整：去掉「最近采集」列）；数字列的 `th` 直接挂 `.num`，与 `td.num` 同选择器右对齐，不包在 `span` 里；
- `null` 一律显示「—」（现有 `formatCount` 行为），不显示 0；
- 行可聚焦（`tabIndex=0`），`aria-selected` 标识当前选中账号；选中行 `aria-current='true'` + 背景色 `--dsw-alias-bg-layer-2`；
- 表格外层 `tableWrap` 横向滚动，`max-height: 60vh`，与作品表一致；
- 行数 ≤ 200（服务端上限），不分页；表格 `aria-label=overview.section.accounts`。

### B.5 行交互与联动

| 事件 | 行为 |
|---|---|
| 单击行 | `onSelectAccount(row.accountId)`：账号筛选器同步为该账号，chips 增加账号 chip，① ③ 切为该账号值，④ 加载并展示该账号画像 |
| 键盘 Enter / Space（行聚焦时） | 同单击 |
| 再次单击已选中行 | 不改变（保持选中） |
| 点击账号 chip 的 × | 回到全部账号模式，④ 回空态 |

### B.6 状态呈现

| 区块 | `loading` | `empty` | `error` | `partial` |
|---|---|---|---|---|
| ① 10 卡 | 骨架（现有 `KpiCard state='loading'`） | 有 `availability=no_data` 提示 `overview.metricsNoData`，各卡「—」 | 外层 `DataState error` + 重试 | 值直排 + 提示行 `overview.metricsPartial` |
| ② 表格 | 外层 `DataState loading` | `accountCount=0`：`overview.empty.noAccounts` | 外层 `DataState error` + 重试 | 行内 Tag |
| ③ 趋势 | `ChartFrame loading` | `trendDaily` 全 null：`chart.trendEmpty` | `ChartFrame error` + 重试 | footnote 追加 `overview.metricsPartial` |
| ③ 4 卡 | 骨架 | 「—」 | 「—」+ 外层提示 | 值直排 |
| ④ 画像 | 单账号切换时 `DataState loading` | 全部账号：`overview.portrait.pickAccount`；单账号无画像：现有 `portrait.dimMissing` | `DataState error` + 重试 | 现有提示行 |

`refreshing=true` 时三段数据区加 `refreshDim[data-refreshing='true']`（现有样式：透明度 0.6），固定文字（标题、筛选器、表头）不动。

自定义日期的筛选器层状态：两端日期任一为空 → 不发请求，保留上一次渲染的数据（不进 loading，不清空）；两端合法但服务端返回 `INVALID_TIME_WINDOW`（浏览器 `max` 被绕过、或服务端日期已滚动）→ 外层 `DataState error` + `reasonText` 文案 `collect.reason.INVALID_TIME_WINDOW`，重试按钮不改变筛选值；区间早于最早采集日 → `availability=no_data` → `empty`，文案 `overview.metricsNoData`。

### B.7 响应式

容器断点沿用 `@container yootun-kit-page` 三档：

| 断点 | ① kpiGrid | ③ growthGrid | ② 表格 |
|---|---|---|---|
| ≥1120 | 5 列（两行） | 双列 1.4fr / 0.8fr | 全列 |
| 880–1119 | 3 列 | 单列 | 全列，可横向滚动 |
| <880 | 3 列 | 单列 | 横向滚动，首两列（排名 / 账号）`position: sticky; left: 0` |
| <640 | 2 列 | 单列 | 同上；4 卡 2 列 |

筛选器在 <880 时 `FilterBar` 自身换行（kit 样式），`FilterMenu` 触发按钮 `max-width: 160px` + 文本省略；`customRange` 容器 `flex-wrap: wrap`，两个 date input 各 `width: 132px`，<640 时独占一行。

### B.8 无障碍

- 筛选器：每个 `FilterMenu` 触发按钮 `aria-haspopup='menu'` `aria-expanded` `aria-label=label`（kit 组件已带）；当前项在 Menu 内 check；
- chips：清除按钮 `aria-label` 由 kit 提供（`filter.clear: <label>`）；
- 表格：`<table aria-label>`，`<th scope='col'>`，行 `tabIndex=0` `aria-label=overview.row.selectAria{name}`，选中行 `aria-selected='true'`；
- 图表：沿用现有 `LineTrendChart` 的 `aria` 与键盘导航；
- 状态变化：`partial` 提示行 `role='status'`；错误 `role='alert'`；
- 焦点：行聚焦 `:focus-visible` 2px `--dsw-alias-border-selected`；选中不抢焦点；
- `prefers-reduced-motion`：现有 `refreshDim` 过渡与 kit 动效已在 `@media (prefers-reduced-motion: reduce)` 下关闭。

### B.9 文案清单（`locales.ts` 新增，zh 为键集事实源，`en` 必须成对）

| key | zh | en |
|---|---|---|
| `overview.filter.account` | 账号 | Account |
| `overview.filter.account.all` | 全部账号 | All accounts |
| `overview.filter.window` | 时间窗 | Window |
| `overview.window.custom` | 自定义 | Custom |
| `overview.range.custom` | {from} 至 {to} | {from} – {to} |
| `overview.filter.customFrom` | 起始日期 | From date |
| `overview.filter.customTo` | 截止日期 | To date |
| `collect.reason.INVALID_TIME_WINDOW` | 日期范围无效，请检查起止日期（不能晚于昨日、最长 92 天） | Invalid date range; check the dates (not after yesterday, 92 days max) |
| `overview.filter.sort` | 排序 | Sort |
| `overview.filter.session` | 会话状态 | Session |
| `overview.filter.session.all` | 全部 | All |
| `overview.sort.play` | 按播放量 | By plays |
| `overview.sort.like` | 按喜欢 | By likes |
| `overview.sort.net_fans` | 按净增关注 | By net followers |
| `overview.sort.followers` | 按关注者总数 | By followers |
| `overview.sort.works` | 按作品数 | By works |
| `overview.chip.account` | 账号：{value} | Account: {value} |
| `overview.chip.window` | 时间窗：{value} | Window: {value} |
| `overview.chip.sort` | 排序：{value} | Sort: {value} |
| `overview.chip.session` | 会话状态：{value} | Session: {value} |
| `overview.section.accounts` | 账号表现 | Account performance |
| `overview.section.accountsCount` | 共 {count} 个账号 | {count} accounts |
| `overview.section.singleAccount` | 该账号 · {window} | This account · {window} |
| `overview.col.rank` | # | # |
| `overview.col.account` | 账号 | Account |
| `overview.col.followers` | 关注者 | Followers |
| `overview.col.netFans` | 净增关注 | Net followers |
| `overview.col.works` | 作品数 | Works |
| `overview.col.lastCollected` | 最近采集 | Last collected（2026-11-25 起账号表现表无此列，键保留在词典中，页面无引用） |
| `overview.row.selectAria` | 选择账号 {name} | Select account {name} |
| `overview.row.noData` | 暂无数据 | No data |
| `overview.tag.sessionOk` | 正常 | OK |
| `overview.tag.sessionExpired` | 已过期 | Expired |
| `overview.tag.sessionUnknown` | 未知 | Unknown |
| `overview.portrait.pickAccount` | 在「账号表现」表中选择一个账号查看画像 | Select an account in the account performance table to view its audience profile |
| `overview.followersSumNote` | 关注者总数为各账号最新关注者之和 | Follower total is the sum of each account's latest count |
| `overview.empty.noAccounts` | 没有符合条件的账号 | No accounts match the filters |

复用现有 key：`overview.window.yesterday` / `last_7d` / `last_30d`、`overview.section.metrics`、`overview.section.growthCards`、`overview.section.portrait`、`overview.dataSource`、`overview.metricsNoData`、`overview.metricsPartial`、`overview.portraitAsOf*`、`col.play` `col.like` `col.comment` `col.share`、`fans.*`、`chart.*`、`portrait.*`、`metric.*`、`error.*`。

`format.ts` 的 `REASON_KEYS` 新增 `INVALID_TIME_WINDOW: 'collect.reason.INVALID_TIME_WINDOW'`，否则该码落到 `error.unknownWithCode` 的通用文案。

删除现有 key：`overview.accountLabel`、`overview.accountSwitch`（账号选择器由筛选器替代）；删除前确认 `wx-page.test.tsx` / `wx-data.test.tsx` 无引用。

## 附录 C：逐文件规格

### C.1 tools.dofe.ai

2026-11-25 阶段 1 实现后补全：原 9 处 + 实现时由仓库守护测试强制确认的 14 处连锁登记点（实现记录见 tools 仓 `feat/wx-accounts-overview` 提交说明）。

| 文件 | 改动 | 守护机制 |
|---|---|---|
| `src/tools_dofe/services/wx_channels_operation/constants.py` | 新增 `MAX_OVERVIEW_CUSTOM_DAYS: Final = 92`（放在 `WINDOW_*` 常量之后，注释说明：总览自定义区间上限，日报 1 天 / 周报 7 天 / 月报 30 天留余量；与 `MAX_DAILY_WINDOW_DAYS`（采集入库业务上限）无关）；另加同风格 `WINDOW_CUSTOM` 常量（queries 以 `c.WINDOW_*` 比较） | — |
| `src/tools_dofe/services/wx_channels_operation/schemas.py` | 新增 `class WxAccountsOverviewInput(CamelModel)`：`account_ids: list[WxAccountId] \| None = None`（`Field(max_length=200)` 在 server 层参数上）、`window: Literal['yesterday','last_7d','last_30d','custom'] = 'last_7d'`、`from_day: DayStr \| None = None`、`to_day: DayStr \| None = None`、`sort: Literal['play','like','net_fans','followers','works'] = 'play'`、`session_status: Literal['ok','expired','unknown'] \| None = None`；`@model_validator(mode="after")`：`window == 'custom'` 要求 `from_day` 与 `to_day` 均非 `None`，否则抛 `BusinessError(..., error_code="INVALID_TIME_WINDOW")`；`window != 'custom'` 要求二者均 `None`，否则同码拒绝。另加服务层 `DayStr` 类型别名（两面 server 收敛为单一来源） | — |
| `src/tools_dofe/services/wx_channels_operation/queries.py` | 新增 `_resolve_window(window, from_day, to_day) -> tuple[date, date]`：枚举走 `_WINDOW_SIZES` + `latest_completed_day`；`custom` 走 `_parse_day` 后按 2.4 顺序校验（顺序 / 上界 / 长度 ≤ `MAX_OVERVIEW_CUSTOM_DAYS`），失败抛 `BusinessError(..., error_code="INVALID_TIME_WINDOW")`。新增 `_trend_window(window_start, window_end) -> tuple[date, date]`：`end = window_end`，`start = end - (max(days, 7) - 1)`。新增 `accounts_overview(db, *, account_ids, window, from_day, to_day, sort, session_status) -> dict`：复用 `_sum_metric_daily` / `_sum_fans_daily` 的逐行累加口径；**新增一次 `IN` 查询的批量实现** `_account_metric_rows` / `_account_fans_rows`（与单账号版本共用同一个逐行累加函数，避免两份口径），查询范围取 `min(window_start, trend_start) .. window_end`，窗口求和与趋势求和在同一批行上分别聚合；`yesterday` 在 `_resolve_window` 返回后收缩为末日单日窗口（2.4「yesterday 窗口」行）；新增 `_aggregate_availability(values)`、`_ACCOUNT_SORT_KEYS`、`_resolve_overview_accounts`、`_count_works_in_window`（work_count 口径）、`_trend_daily`、`_observed_days`；返回 `summary.window` 与 `summary.trendWindow` 两个范围对象 | — |
| `src/tools_dofe/mcp/domains/yootun/workbench/server.py` | 新增 `def workbench_wx_accounts_overview(accountIds: Annotated[list[WxAccountId], Field(max_length=200)] \| None = None, window: Literal[...] = 'last_7d', fromDay: DayStr \| None = None, toDay: DayStr \| None = None, sort: Literal[...] = 'play', sessionStatus: Literal[...] \| None = None) -> dict`，`model_validate` 置于 `with_db` 的 `_op` 闭包内（DTO validator 的 BusinessError 收敛为稳定码信封），服务层兜底 `TOO_MANY_ACCOUNTS` 后调 `wx_query_service.accounts_overview`；`_IMPLEMENTED_TOOLS` 追加；分发表追加；头注释计数同步 | tools/list 精确计数（`test_workbench_wx_tos.py`） |
| `src/tools_dofe/mcp/domains/yootun/registry.py` | 视频号域工具名元组追加；`YOOTUN_TOOL_MANIFEST` 追加 `_read('workbench_wx_accounts_overview')`；`WORKBENCH_TOOLS` 追加 `"workbench_wx_accounts_overview": "wx_channels_accounts_overview"`；`assert len(WORKBENCH_TOOLS) == 94` 改为 95；头注释 133→134 | registry 断言 + `test_contract.py` 计数锁定 |
| `src/tools_dofe/mcp/capabilities.py` | `wx_channels_operation` 域能力元组追加 `"wx_channels_accounts_overview"`；read 标记集合追加 `_read("wx_channels_accounts_overview")` | `test_contract.py:197` 源能力必须在 legacy 目录 + `test_capability_manifest.py` 目录↔gateway 双向一致 |
| `src/tools_dofe/mcp/service_policies.py` | 能力列表追加 `"wx_channels_accounts_overview"` | `test_policy_snapshot.py` reviewed↔golden 快照双向精确覆盖 |
| `docs/1116/yootun-mcp.md` | §4.4 标题「19 个」→「20 个」，清单追加一行；新增 §4.4.1 契约小节（入参/出参/口径/错误码）；全文现状计数同步（Workbench 95、yootun 业务 134、legacy 272 等） | 契约唯一来源；tools/list 与文档逐名一致（验收核对项） |
| `tests/yootun/test_workbench_wx_tos.py` | `test_tools_list_has_exactly_90_workbench_tools` 改名 `…_95_…` 并计数加一；新增用例见附录 E | — |
| `src/tools_dofe/mcp/domains/wx_channels_operation/server.py`（旧 legacy route） | 源域同签名 `wx_channels_accounts_overview` + `add_tool`（schema parity 等价迁移，公共入口工具面 19→20，RQ-2026-013 同款流程） | `test_contract.py:197` 源能力映射 + `test_capability_manifest.py:59` 双向一致 + `test_schema_parity.py` schema 逐字段一致 + `test_dev_baseline_parity.py` 精确 diff 名单 |
| `src/tools_dofe/mcp/service_taxonomy.json`（legacy） | `content.wx-channels-analytics` service 工具 +1 | `ServiceCatalog._snapshot` 由 taxonomy 驱动（不加则快照与目录不一致） |
| `tests/mcp/data/legacy_policy_snapshot.json` | golden 快照 +1 条（query/database/reviewed，与 `wx_channels_account_overview` 同组） | `test_policy_snapshot.py` reviewed↔golden 双向精确覆盖 |
| `src/tools_dofe/mcp/domains/yootun/policies.py` | `_YOOTUN_DATABASE` 组追加 `workbench_wx_accounts_overview` | registry 头注释不变式；不加则 yootun discovery fail-closed 为 unknown |
| `src/tools_dofe/mcp/domains/yootun/service_taxonomy.json` | workbench-face tools +1（保持字母序）；description 133→134 | `test_contract.py` taxonomy↔manifest 双向一致 |
| `docs/superpowers/catalogs/yootun-service-catalog-snapshot.json` | `--scope yootun` 重生成 | `test_service_catalog_snapshot.py` 快照↔运行时一致 |
| `docs/superpowers/catalogs/service-catalog-snapshot.json` | `--generate-legacy` 候选覆盖；old SHA `7eebee98…30de3` → new SHA `2a4f9f8c…2b23`（结构化 diff 仅含新工具条目与 facet 计数派生量） | 内容 SHA-256 基线锁定测试 + `--check` |
| `scripts/export_service_catalog_snapshot.py` | `LEGACY_SNAPSHOT_BASELINE_SHA256` 常量更新 + 注释追加变更记录 | 同上 |
| `tests/yootun/test_dev_baseline_parity.py` | `ALLOWED_NEW_TOOLS` 追加 `wx_channels_accounts_overview` | dev 基线 diff 必须精确等于名单 |
| `tests/yootun/test_contract.py` | 计数 133→134×2、94→95、`wx_channels_operation` 19→20、gateway 272+134+5、read 34+47、docstring | 测试自身 |
| `tests/yootun/test_catalog_face.py` | 133→134×3、94→95 | 测试自身 |
| `tests/yootun/test_provider_isolation.py` | legacy toolCount 271→272×3 | 测试自身 |
| `tests/yootun/test_schema_parity.py` | 133→134×2、用例名、docstring | 测试自身 |
| `tests/mcp/test_douyin_publish_schedule_tools.py` | 94→95、133→134、legacy 总量 271→272 | 测试自身 |
| `tests/mcp/test_yootun_sdk_probe.py` | 133→134×2 | 测试自身 |
| `tests/mcp/test_service_catalog_snapshot.py` | 133→134×3 | 测试自身 |
| `tests/mcp/test_service_discovery.py` | docstring 271→272 | 测试自身 |
| `tests/wx_channels_operation/test_wx_channels_server_contract.py` | 旧 route `EXPECTED_TOOLS` 集合 +1 | 测试自身 |

### C.2 yootun-agent：`@yootun/dsh-client-ui-kit`

| 文件 | 改动 |
|---|---|
| `src/filter-menu.tsx`（新增） | 从抖音 `plugins/dsh-douyin-workbench/src/client/FilterMenu.tsx` 原样迁入：props `label / visibleLabel? / currentLabel / items / selectedId / disabled? / triggerClassName? / onSelect`；内部 `useState(open)` + 官方 `Button outline sm` + `Menu`；无 kit locale 依赖（文案全部由调用方传入）；JSDoc 含 `@param` / `@returns` |
| `src/filter-menu.module.css`（新增） | `.filterGroup { display: inline-flex; align-items: center; gap: 6px; min-width: 0 }` `.filterGroupLabel { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); white-space: nowrap }`（2026-11-25 阶段 2 修正：`--dsw-font-size-sm` / `--dsw-alias-text-secondary` 不在官方主题，按 kit 惯例用 px 字面量 + `--dsw-alias-label-secondary`，视觉与抖音原版一致；色值全部 token，无字面色） |
| `src/index.ts` | `export { FilterMenu } from './filter-menu.tsx'` 及类型 `FilterMenuItem` / `FilterMenuProps`（kit 组件随组件导出类型的惯例） |
| `packages/dsh-client-ui-kit/tests/*` | 若 kit 有组件测试：新增 `FilterMenu` 渲染 / 选中 / 禁用用例 |

### C.3 yootun-agent：Host（`plugins/dsh-wx-channels-workbench/src`）

| 文件 | 改动 |
|---|---|
| `route.ts` | `ACTION_SCHEMAS` 新增 `'overview.accounts'`，含 `fromDay` / `toDay`（limit 10，与 `works.list` 的 `publishedFrom/To` 同）（A.2） |
| `handlers.ts` | `workbenchActions` 新增 `'overview.accounts'` 映射（A.2）；文件头注释的 action 清单补一行 |
| `errors.ts` | 不改（四个错误码已在白名单） |

### C.4 yootun-agent：client（`plugins/dsh-wx-channels-workbench/src/client`）

| 文件 | 改动 |
|---|---|
| `schema.ts` | 新增 `AccountsOverviewTotals` / `AccountsOverviewSummary`（含 `trendWindow: { startDay, endDay }` 与 `window: { startDay, endDay }`）/ `AccountsOverviewRow` / `AccountsOverviewData` 类型与 `readAccountsOverview()`；抽出 `readMetricTotals()` / `readFansTotals()` 并让 `readOverview` 复用；文件头注释补 `workbench_wx_accounts_overview` 字段说明 |
| `OverviewPage.tsx` | 重写：导出 `OverviewFilters` / `DEFAULT_OVERVIEW_FILTERS`（含 `window: 'custom'`、`customFrom` / `customTo`）；props 改为 `filters` / `onFiltersChange`（与抖音同名同形），移除 `summary*` 五个 props；新增 `applyCustomRange(key, value)`（越界纠偏 + 空值不提交，对齐抖音）；`load()` 按 A.3 装配请求（`custom` 时透传 `fromDay` / `toDay`，两端不完整不发请求），A.5 / A.6 管理状态与缓存；趋势 x 轴按 `summary.trendWindow` 逐日对齐（不再用 `recentDays(7)` 硬编码 7 天）；删除 `AccountSelect` 组件；渲染 B.1 结构 |
| `WorkbenchPage.tsx` | 新增 `overviewFilters` state（页面级持有，切 tab 保留）；传给 `OverviewPage`；`loadSummary` 保留（作品 tab 仍用）；`OverviewPage` 挂载处移除 `summary*` props |
| `format.ts` | 新增 `formatDelta(value: number \| null, localeTag: string): { text: string; tone: 'up' \| 'down' \| 'flat' }`（口径同抖音 `fanDelta`，`0` 与 `null` 为 `flat`）；新增 `shiftDay(dayText, deltaDays): string`（原样迁自抖音，用于 `trendWindow` 内逐日枚举与日期纠偏）；`REASON_KEYS` 新增 `INVALID_TIME_WINDOW: 'collect.reason.INVALID_TIME_WINDOW'` |
| `kit-styles.ts` | 追加 `import '@yootun/dsh-client-ui-kit/src/filter-bar.module.css'` 与 `filter-menu.module.css`（`wx-bundle.test.ts` 源码层守护按组件 → 样式表推导，`FilterBar → filter-bar`、`FilterMenu → filter-menu` 符合默认命名规则，无需登记例外） |
| `workbench.module.css` | 新增 `.accountTable` 列宽、`.accountCell`（头像 + 名称 + Tag 布局）、`.rowSelected`（`background: var(--dsw-alias-bg-layer-2)`）、`.deltaUp` / `.deltaDown`（token 同抖音）、`.stickyFirstCols`（<880 断点下前两列 sticky）、`.customRange` / `.customRangeDash` / `.dateInput`（原样迁自抖音：28px 高、`--dsw-alias-border-l2`、`--dsw-radius-sm`、focus-visible 2px `--dsw-alias-border-selected`；<640 时 `.dateInput { width: 100% }`）；删除 `.toolbar` 中仅供 `AccountSelect` 使用的规则（若 `.toolbar` 另有消费者则保留） |
| `locales.ts` | 新增 B.9 全部 key；删除 `overview.accountLabel` / `overview.accountSwitch`；`en` 同步 |

### C.5 yootun-agent：抖音（`plugins/dsh-douyin-workbench/src/client`）

| 文件 | 改动 |
|---|---|
| `FilterMenu.tsx` | 删除 |
| `OverviewPage.tsx`（内嵌复制体与死参数 `t={t}` 一并删除）、`MaterialPage.tsx`、`GenePage.tsx`、`BreakdownPage.tsx`、`AnalysisPage.tsx`（`MetricMenu` 为第三份内嵌复制，改 kit 薄包装、签名不变；2026-11-25 阶段 2 实现发现）等消费点 | `import { FilterMenu } from '@yootun/dsh-client-ui-kit'`，删除本地 import；业务 props 不变 |
| `kit-styles.ts` | 追加 `filter-menu.module.css` |
| `workbench.module.css` | 删除 `.filterGroup` / `.filterGroupLabel`（迁入 kit）；若 `triggerClassName` 消费 `.xxxTrigger` 则保留 |
| `tests/client/douyin-parity.test.tsx` | kit 导入集合守护推导自动更新；若有对本地 `FilterMenu.tsx` 文件存在的断言则删除 |

### C.6 文档同步

| 文件 | 改动 |
|---|---|
| `yootun/docs/1110/11-wx-workbench-ui-layout-parity.md` §5 | 「账号总览页」布局图与 5.1 / 5.2 / 5.3 按本文 B.1 / B.2 更新；5.2「趋势固定使用 `last_7d`，不随账号总览当前时间窗截断」改为跟随窗口（规则见本文 2.4「合计趋势」），标注调整日期 2026-11-24 |
| `yootun/docs/1124/00-overview.md` | 索引行「状态」列随第 4 节回填更新；本文已在索引中登记，不新增行 |

## 附录 D：健壮性要求

| 项 | 要求 | 验证方式 |
|---|---|---|
| 缺失不补 0 | 所有 `null` 字段在投影、求和、展示三层都不写 0；`summary.totals` 某字段全缺时不出现在 JSON | tools 用例：两账号其中一个字段 NULL，断言求和只含另一个；client 用例：`formatCount(null) === '—'` |
| availability 独立降级 | `account_metrics` 与 `fans_trend` 分开聚合；画像独立 | tools 用例：一账号 metrics `partial`、fans `ok` → `availability={partial, ok}` |
| 请求代次 | 快速切换筛选时旧响应不覆盖 | client 用例：两次请求乱序返回，断言渲染第二次 |
| 缓存失效 | 账号集合变化清缓存；缓存键含全部四段筛选 | client 用例 |
| 错误显式 | 失败丢旧值进 `error`，不保留陈旧数据 | client 用例 |
| 不持有工具数量 | 代码、注释、测试、`package.json` description 不出现 Workbench 工具数量 | `grep -rn` 守护（现有 `source-conventions.test.ts` 模式） |
| 不持有工具名清单 | `whitelist.ts` 不改；`CALLER_DOMAINS` 不改 | 现有测试 |
| locale 成对 | `en: Record<WxLocaleKey, string>` 类型强制 | `wx-page.test.tsx` 键集用例 |
| 无 `as unknown` | 新增代码零 `as unknown` | `verify-no-unknown-casts` |
| 注册即 effect | 不新增注册；`FilterMenu` 是纯组件 | — |
| 类型门 | `pnpm --filter <pkg> build` 通过 | 验收 |
| 路由 allowlist | 新 action 必须登记 `ACTION_SCHEMAS`，未知字段拒绝 | `host.test.ts` action 清单用例更新 |
| 错误码白名单 | 不新增码；四个码已在 `SERVER_ERROR_CODES` | `errors.ts` 单测 |
| 性能 | 服务端批量 `IN` 查询；200 账号 × 30 天单次请求 < 2s（本地 PG） | tools 用例计时断言或手动 e2e |
| 载荷 | `accounts[]` 不含逐日 `daily`；`trendDaily` 行数 = `max(窗口天数, 7)`，上限 92 | 契约用例断言键集与行数 |
| 日期校验双层 | 浏览器 `max` 只是便利层，服务端对格式 / 顺序 / 上界 / 长度四项全量校验，不信任客户端 | tools 用例逐项构造非法输入；client 用例断言 `max` 属性 |
| 对账确定性 | 同一 `[fromDay, toDay]` 多次调用返回一致（日表为已完成日快照）；报告方按 `daysObserved` / `daysExpected` / `availability` 判定完整性 | tools 用例：同参两次调用 `summary` 逐字段相等 |

## 附录 E：测试矩阵

### E.1 tools.dofe.ai（`tests/yootun/test_workbench_wx_tos.py`）

| 用例 | 断言 |
|---|---|
| `test_wx_accounts_overview_aggregates_all_accounts` | 三个账号各有 7 天 metrics 与 fans 日行；`summary.accountCount=3`；`totals.daily_play_count` 等于三账号之和；`followerTotalCount` 等于三账号最新值之和 |
| `test_wx_accounts_overview_partial_availability` | 一账号只送 3 天 → 该行 `rowAvailability='partial'`；`availability.account_metrics='partial'` |
| `test_wx_accounts_overview_skips_null_not_zero` | 一账号某日 `daily_play_count=NULL` → 求和不含它；全 NULL 字段不出现在 `totals` |
| `test_wx_accounts_overview_yesterday_single_day` | `window='yesterday'` 全口径单日：`summary.window = [D, D]`；`totals` 与 `work_count` 只含末日；`daysObserved = 1`；`trendWindow` 仍末日锚定 7 天（2026-11-25 验收修复项，替代原 `yesterday_uses_single_day`） |
| `test_wx_accounts_overview_trend_min_seven_days` | `window='yesterday'`（窗口不足 7 天）时 `trendWindow` 以末日为锚补足 7 天；`trendDaily` 长度 7；某日全缺为 `null`（2026-11-25 修正：原 `trend_fixed_seven_days` 断言 last_30d→7 天与契约 2.4「last_30d → 30 天」及 `enumerated_trend_follows` 矛盾，按 2.4 实现） |
| `test_wx_accounts_overview_sort_orders` | 五种 `sort` 各一；缺失值排最后；同值按 `account_id` |
| `test_wx_accounts_overview_session_status_filter` | `sessionStatus='expired'` → 只含过期账号；与 `accountIds` 叠加为空时 `accountCount=0`、`availability=no_data` |
| `test_wx_accounts_overview_rejects_unknown_account` | `accountIds=['missing']` → `ACCOUNT_NOT_ACCESSIBLE` |
| `test_wx_accounts_overview_rejects_too_many` | 201 个 ID → `TOO_MANY_ACCOUNTS` |
| `test_wx_accounts_overview_ignores_tombstones` | `delete_state='remote_deleted'` 的账号不出现在缺省集合 |
| `test_wx_accounts_overview_payload_keys` | `accounts[i]` 无 `daily` 键；`summary` 键集精确 |
| `test_wx_accounts_overview_custom_single_day` | `window='custom'`、`fromDay == toDay == D`：`summary.window` 为 `[D, D]`；`totals` 等于各账号 D 日单日值之和；`trendWindow` 为 `[D-6, D]` 7 天 |
| `test_wx_accounts_overview_custom_week_follows_trend` | `fromDay=Mon`、`toDay=Sun`：`trendWindow` 恰为 `[Mon, Sun]`；`trendDaily` 7 行 |
| `test_wx_accounts_overview_custom_month` | 30 天区间：`trendWindow` 30 天、`trendDaily` 30 行；`window` 为该区间 |
| `test_wx_accounts_overview_custom_rejects` | 缺 `fromDay` / 非 `custom` 带 `toDay` / `fromDay > toDay` / `toDay` 为今天 / 区间 93 天 → 五种输入均 `INVALID_TIME_WINDOW` |
| `test_wx_accounts_overview_custom_before_earliest` | 区间早于最早日表行：`availability.no_data`、`summary.totals` 为空对象、`trendDaily` 全 `null` |
| `test_wx_accounts_overview_custom_deterministic` | 同参两次调用 `summary` 逐字段相等 |
| `test_wx_accounts_overview_enumerated_trend_follows` | `last_30d` 的 `trendWindow` 为 30 天；`yesterday` 为末日锚定 7 天 |
| 工具计数 | 现有计数用例加一 |

### E.2 yootun-agent

| 包 | 文件 | 用例 |
|---|---|---|
| kit | `tests/*` | `FilterMenu` 渲染、`selectedId` check、`disabled` 不可点、`onSelect` 回调 |
| douyin | `tests/client/douyin-parity.test.tsx` | kit 导入集合与样式表清单一致（现有守护） |
| douyin | `tests/client/*` | 现有筛选用例全部通过（迁移无回归） |
| wx | `tests/host.test.ts` | `ACTION_SCHEMAS` 键集断言追加 `overview.accounts`；`handlers['overview.accounts']({})` 调用 `workbench_wx_accounts_overview` 且参数 `{window, sort}`；传 `accountId` 时 `accountIds=[id]`；传 `sessionStatus` 时透传；`window='custom'` + `fromDay` / `toDay` 时透传；`window='last_7d'` + `fromDay` 时 `fromDay` 被丢弃 |
| wx | `tests/client/wx-data.test.tsx` | `readAccountsOverview`：完整载荷；缺字段 → `null`；`trendDaily` 缺 `day` 行丢弃；`readOverview` 与 `readAccountsOverview` 对同一 `totals` 投影一致 |
| wx | `tests/client/wx-data.test.tsx`（2026-11-25 修正：页面行为用例承载在 wx-data——mockHost / renderPage 基建所在；原列 `wx-page.test.tsx`） | 全部账号模式：筛选器 4 个、10 卡、表格行数 = `rows.length`、画像空态文案；单账号模式：4 卡为该账号值、画像五维渲染；chips 清除回缺省；会话状态与账号联动重置；表格行 Enter 选中；`refreshing` 淡化属性；时间窗切 `custom` 后出现两个 `type=date` 输入且 `max` 为昨日、初值昨日；起始改到截止之后 → 截止跟随；清空任一端 → `hostAction` 不被调用；清除时间窗 chip → 回 `last_7d` 且日期清空；趋势 x 轴数据列 = `trendWindow` 天数、标签稀疏（30 行 → 首 / 中点 / 尾 3 个） |
| wx | `tests/client/wx-bundle.test.ts` | 样式表清单含 `filter-bar` / `filter-menu`；容器名守护不变 |
| wx | `tests/source-conventions.test.ts`（若存在）或新增 | 源码无 Workbench 工具数量字面量；`whitelist.ts` 无 `workbench_wx_accounts_overview` 字面量 |

## 附录 F：默认采用项

以下各项在方案讨论中给出推荐值并按推荐值写入本文，评审时可调整，调整后同步修改对应附录：

| 项 | 本文采用 | 备选 |
|---|---|---|
| 账号筛选 | 单选 | 多选（契约 `accountIds` 已支持，UI 与 chips 需扩展） |
| 自定义日期 | 做：`window='custom'` + `fromDay` / `toDay` 闭区间，上限 92 天，服务端四项校验 | 预设 90 天档（被自定义覆盖，不另加） |
| 画像（全部账号） | 空态提示 | 按人数加权合并五维（需定义合并口径） |
| 趋势图范围 | 跟随窗口：`max(窗口天数, 7)`，以窗口末日为锚；调整分册 11 §5.2 的「固定近 7 天」 | 固定近 7 天（对账时趋势与 KPI 范围不一致） |
| 趋势图（全部账号） | 合计单线 | 每账号一条多线（`LineTrendChart` 支持多序列，账号多时可读性差） |
| 表格行交互 | 单击 / Enter 选中账号并联动 | 无交互 / 跳独立页 |
| 时间窗位置 | 顶部 `FilterBar` | 保留在 ① 标题行右侧 `SegmentedTabs` |
| 会话状态筛选语义 | 传入服务端，影响汇总与表格 | 仅客户端过滤表格行，汇总不变 |
| `FilterMenu` 归属 | 上移 kit，抖音同步迁移 | 视频号局部复制（违反三层创作模型「第二个消费者必须抽取」） |

## 附录 G：本地联调记录（2026-11-25）

联调在本机完成：tools 服务运行 `feat/wx-accounts-overview` 代码（FastMCP 端点 `/mcp/yootun-workbench`，本地直连不校验鉴权，鉴权由部署层网关承担）；yootun-agent 以源码方式启动 web（隔离的 `DSH_HOME`），激活门禁用本地 settings 写入绕过，未调用真实激活路由。联调脚本与证据存放在仓库外已忽略的 `.ui-review/` 目录，不入库；下表测试数据已在联调后删除。

测试数据为 SQL 直接写入的 2 个账号（`delete_state='none'`），库内另有 1 个真实账号，全程未改动：

| 账号 | 日表 | fans 日表 | 作品 | 画像 | 会话 |
|---|---|---|---|---|---|
| `e2e-test-a` | 7 天完整，其中 2 天 `daily_like_count` 为 NULL | 7 天，`follower_net_count=10`，第 4 天 `follower_total_count` 为 NULL | 2 条（1 条近 7 天、1 条 35 天前） | 1 份 | `ok` |
| `e2e-test-b` | 3 天（7 天窗内为 `partial`） | 3 天，`follower_net_count=-1` | 无 | 无 | `expired` |

### G.1 链路

页面 → Host `overview.accounts` → MCP `workbench_wx_accounts_overview` → PG。Host 响应与 MCP 直调同参结果逐字段相等（`last_7d` 与 `custom` 周两个场景）；页面读取的键名与契约文档 §4.4.1 一致。

### G.2 数据层对账

MCP 返回与 SQL 独立聚合（不引用实现代码）逐字段比对，22 个场景全部一致：三档枚举窗口；`custom` 单日、周（周一至周日）、30 天；`sessionStatus` 过滤；5 种 `sort` 各一次（含缺失值排最后、同值按 `account_id`）；显式 `accountIds`；不存在的 `accountIds` 返回 `ACCOUNT_NOT_ACCESSIBLE`；`custom` 五种非法输入均返回 `INVALID_TIME_WINDOW`；过滤后空集返回 `accountCount=0` 与 `availability=no_data`；同参两次调用 `summary` 相等。

### G.3 汇总口径与页面对账

| 比对 | 结果 |
|---|---|
| 多账号汇总 vs 各账号单账号工具之和（`yesterday` / `last_7d` / `last_30d`）：`totals`（不含 `work_count`）、`fans_totals`、逐日关注者总数 | 差异 0；逐日趋势按两边共有的日期比对，三档分别为 2、10、28 个点 |
| 单账号模式行 vs 该账号单账号工具：10 卡 `totals`、`fans_totals`、`followerTotalCount`、可用性、逐日趋势 | 差异 0 |
| 页面 `custom` 2026-11-16 – 2026-11-22（周一至周日）的 10 卡、4 卡、趋势 7 列、账号表现表 3 行 vs 工具直调 | 42 个比对点数值全部一致；其中「新增关注」「取关」两点比对脚本按带符号格式取期望值，与页面的无符号显示不等，按数值核对一致 |

两项口径差来自既定契约，对账时需要知道：`followerTotalCount` 行级值在账号窗口内无 fans 行时回退账号记录值（第 2.3 节），单账号工具在同一窗口返回 `null`，本次联调中 `yesterday` 档为 `e2e-test-b` 555 与真实账号 67，`last_7d` 档为真实账号 67；`yesterday` 档多账号工具按末日单日计 `daysObserved` / `daysExpected`，单账号工具为名义 2 天窗口。

### G.4 页面目检（web，1280 宽）

全部账号模式（筛选条 4 项、chips、10 卡、账号表现表、趋势、画像空态）；单账号模式（指标卡口径说明、画像五维、`1 account`、不显示关注者求和 footnote）；`custom` 日期输入（`max` 为昨日、初值昨日、起止互相约束、清空任一端不发请求且 chip 回退「自定义」）；会话状态筛选；小于 880 与不小于 1120 两档容器宽度；暗色主题。

### G.5 本轮修复的问题

| 问题 | 修复提交 |
|---|---|
| 作品详情 Modal 用例的按日趋势夹具日期写死，真实日期越过窗口后用例失败 | `79f252c` |
| Host `overview.accounts` 把空 `sort` 原样传给 tools，被 `Literal` 校验拒绝为 `VALIDATION_ERROR` | `329badf` |
| client 读取趋势用的键名是 `trend_daily`，与契约的 `trendDaily` 不一致，趋势图始终无数据；测试载荷与实现写成了同一个错误键名，未能发现 | `5304a4b`（并增加按契约键名构造载荷的用例） |
| 单账号模式账号表标题显示复数；`custom` 任一端为空时 chip 文案尾部留下连接符 | `33b34d8` |
| 账号表现表数字列表头包在 `span` 里，右对齐选择器不命中，与数据列错位 | `cacca9ea`（同次提交按用户裁定移除 10 卡逐卡口径注脚与「最近采集」列） |

### G.6 未覆盖项

激活路由未调用；桌面端真机未验收；「200 账号 × 30 天单次请求 < 2s」未计时；测试数据为 SQL 直接写入，写入链路（幂等键、批次账本、服务端复核）未经过；tools 服务首次启动时出现过一次排序未生效，进程内直调与重启后均正确，原因未定位。
