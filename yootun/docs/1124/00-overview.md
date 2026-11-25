# 2026-11-24 实施单索引

建单日期：2026-11-24 ｜ 流程依据：[cross-repo-sync.md](../cross-repo-sync.md) 第四节

本目录收纳 2026-11-24 建单的业务特性实施单（目录规则见 [cross-repo-sync.md 第四节](../cross-repo-sync.md#四实施单)）。实施单是三仓共享的唯一协调文件，固定五章（范围 / 契约增量 / 影响面 / 状态回填 / 验收），先建单再动代码；模板见 [feature-template.md](../feature-template.md)。

## 实施单索引

| 实施单 | 内容 | 状态 |
|---|---|---|
| [infra-whitelist-domain-gate.md](features/infra-whitelist-domain-gate.md) | Workbench 白名单由工具名清单改为按域放行（`CALLER_DOMAINS`），Agent 面未分类 `yootun_*` 工具由 `deny` 改为 `ask`，审批卡片文案中英成对 | 已实施并通过验收，待发版 |
| [wx-workbench-multi-account-overview.md](features/wx-workbench-multi-account-overview.md) | 视频号账号总览升级为多账号汇总页：tools 新增 `workbench_wx_accounts_overview` 聚合工具（含自定义日闭区间，趋势跟随窗口，为日报 / 周报对账提供同一数据通路），筛选器（账号 / 时间窗含自定义起止 / 排序 / 会话状态）、汇总 KPI、账号表现表；`FilterMenu` 上移 kit | 草案 |
