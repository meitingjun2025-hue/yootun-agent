# 2026-11-25 实施单索引

建单日期：2026-11-25 ｜ 流程依据：[cross-repo-sync.md](../cross-repo-sync.md) 第四节

本目录收纳 2026-11-25 建单的业务特性实施单（目录规则见 [cross-repo-sync.md 第四节](../cross-repo-sync.md#四实施单)）。实施单是三仓共享的唯一协调文件，固定五章（范围 / 契约增量 / 影响面 / 状态回填 / 验收），先建单再动代码；模板见 [feature-template.md](../feature-template.md)。

## 实施单索引

| 实施单 | 内容 | 状态 |
|---|---|---|
| [douyin-collect-all-concurrency.md](features/douyin-collect-all-concurrency.md) | 抖音「采集全部」由逐账号串行改为 3 路并发（插件 Config 可调 1..5）：阶段 2 改 worker 队列、worker 启动错峰、批内熔断（新原因 `risk_paused`）、批量面板按多账号展示；探测阶段、单账号流程、互斥与取消语义不变 | 已实施，待真机验收（`feat/douyin-collect-all-concurrency`） |
| [works-list-pagination.md](features/works-list-pagination.md) | 抖音、视频号作品列表改服务端分页（固定 10 条/页）与服务端排序，列表接口随带 KPI 聚合（`total` / `summary`）；抖音作品页新增 5 卡 KPI 行与视频号同布局；分页控件 `Pager` 上移 kit；tools 两个 `work_list` 工具增量入参出参，不改工具清单 | 已实施，本地三仓联调通过，待真机验收（tools 与 yootun-agent 各在 `feat/works-list-pagination`，tools 待合入 `dev` 并部署测试环境） |
| [collect-state-restore.md](features/collect-state-restore.md) | 抖音、视频号页面重新挂载时向 Host 查询并恢复采集状态：运行中的单账号采集与批量采集恢复进度与轮询，最近一次终态可见，其他账号在采在账号栏可见；抖音 Host 新增本地只读 action `collect.running`（56 → 57 项），视频号 Host 无变化 | 已实施，本地联调（空闲态）通过，待真机验收（`feat/collect-state-restore`） |

## 推进顺序

三张单分两条线。采集线只动 yootun-agent：先合 [collect-state-restore.md](features/collect-state-restore.md)（两个工作台、改动小），再合 [douyin-collect-all-concurrency.md](features/douyin-collect-all-concurrency.md)（只改抖音，合入后发版观察）。分页线 [works-list-pagination.md](features/works-list-pagination.md) 以 tools 契约为前置：tools 合入 `dev` 并部署测试环境，kit 可并行先行，两个插件在 tools 部署后接入；与采集线并行。分支规则见 [cross-repo-sync.md §5.1](../cross-repo-sync.md#51-分支)。 2026-11-25 三条特性分支与 tools 分支已各自合并目标分支的最新提交（含并行的视频号总览批次），单条分支可干净并入；按顺序落地时最后合入分支的 4 个文件冲突已在本地预演，见 [works-list-pagination.md](features/works-list-pagination.md) 5.3。

## 验收分工

每张单第 5 节分两张清单：5.1 开发侧自动验收（测试、构建、静态核对），5.2 真机验收由用户执行，每项写明步骤与预期。本机联调与真机验收的数据库以 `tools.dofe.ai` 的 `.env` 指向的数据库为准（[cross-repo-sync.md 第五节](../cross-repo-sync.md#五顺序与门禁)）。 2026-11-25 三张单完成本地三仓联调，各单第 5 节另有 5.3 本地联调记录，写明结果、按联调修订的预期与留在 5.2 的未覆盖项。
