# P4 抖音工作台 UI 布局与功能对齐方案

状态：**D0 已冻结（2026-11-21 用户确认），D0–D9 已实施并通过 2026-11-23 用户真机验收**（公网 yootun MCP `tools/list` 实测 Agent 39 项、Workbench 94 项、Catalog 5 项；D0 冻结基线总册见 [p4-douyin-workbench-baseline.md](p4-douyin-workbench-baseline.md)，验收记录见 [16-three-workbench-real-device-acceptance.md](16-three-workbench-real-device-acceptance.md)）。

本册是 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) P4 抖音工作台的 UI 布局、信息架构与功能对齐契约。吸取 P2 视频号教训：只列组件栈会让实现重新发明导航与页面结构，导致布局返工（见 [11-wx-workbench-ui-layout-parity.md](11-wx-workbench-ui-layout-parity.md)）。P3 小红书按 [12-xhs-workbench-ui-layout-parity.md](12-xhs-workbench-ui-layout-parity.md) 先锚定旧布局再实现，基本避免同类问题。P4 必须沿用 P3 口径。

## 1. 定案口径

旧抖音插件的**布局、信息架构、功能和任务动线**是 P4 UI 的产品基准；旧插件的**视觉与实现技术**不迁移。新版必须使用 PluginPageShell、官方 primitives、yootun kit、CSS Modules、主题 token、typed dictionary 和现行无障碍底盘重做。

| 层 | 处理 |
|---|---|
| 页面骨架 | 完全参考旧插件 |
| 区域关系 | 完全参考旧插件 |
| 顶级导航 | 完全参考旧插件：账号总览 / 账号作品 / 发布排期看板 / 爆款素材看板 / 爆款拆解 / 爆款基因库 / AI 报表 |
| 交互方式 | 完全参考旧插件，包括总览下钻、作品详情、排期整行保存、候选审核、异步轮询与导出 |
| 功能范围 | 完全参考旧插件冻结点；发布排期看板属于 P4 范围，不得裁剪 |
| 信息密度 | 完全参考旧插件，包括高密度表格、KPI 行、图表同屏、详情弹层与运行历史 |
| 视觉样式 | 按本仓库规范重做 |
| DOM 与 CSS | 不迁移 `ydo-*` 类名、全局 style、inline style、旧色值、旧字体和旧几何 |
| 宿主形态 | 不恢复 sidebar footer 弹层；继续使用 root main 中央面板和 sidebar.panellist 入口 |

布局与功能证据以旧仓库只读源码和验收文档为准：

```text
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/index.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/client.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/overview-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/analysis-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/schedule-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/material-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/breakdown.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/gene-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-douyin-operation/src/report-ui.js
docker-helm.dofe.ai/docs/1116/douyin/RQ-2026-013_开发文档.md
docker-helm.dofe.ai/docs/1116/douyin/RQ-2026-013_验收文档.md
```

## 2. 远端能力基线

2026-11-21 公网握手结果：

```text
yootun-agent:     39 项
yootun-workbench: 94 项
yootun-catalog:    5 项
```

抖音 Workbench 调用面为 55 项：

```text
workbench_douyin_*：33 项
workbench_viral_*：22 项
```

发布排期四项已进入 Workbench：

```text
workbench_douyin_publish_schedule_list
workbench_douyin_publish_schedule_row_create
workbench_douyin_publish_schedule_row_update
workbench_douyin_publish_schedule_row_delete
```

普通会话 Agent 面只追加三项：

```text
yootun_douyin_publish_schedule_list
yootun_douyin_publish_schedule_row_create
yootun_douyin_publish_schedule_row_update
```

`row_delete` 按产品决策不进入 Agent 面，只在抖音工作台 Host 中提供。

## 3. 页面总骨架

新版页面在 PluginPageShell 内重译旧布局：

```text
PluginPageShell
├─ PluginHeader
│  ├─ 抖音工作台
│  ├─ 扫码登录抖音创作者账号，采集并查看作品经营数据
│  └─ 浏览器状态、刷新、导出等全局辅助操作
├─ SegmentedTabs
│  ├─ 账号总览
│  ├─ 账号作品
│  ├─ 发布排期看板
│  ├─ 爆款素材看板
│  ├─ 爆款拆解
│  ├─ 爆款基因库
│  └─ AI 报表
└─ Body
   ├─ 账号总览：全宽总览，可下钻单账号分析
   ├─ 账号作品：左侧账号管理 + 右侧作品面板
   ├─ 发布排期看板：工具栏 + 排期表格 + 底部账号栏
   ├─ 爆款素材看板：KPI / 筛选 / 看板 / seed / run 历史
   ├─ 爆款拆解：新建任务 + 历史列表 + 详情页
   ├─ 爆款基因库：筛选 / 卡片墙 / 详情与编辑
   └─ AI 报表：报表列表 / 详情 / 版本与导出
```

顶级导航固定为旧插件顺序，不得新增、拆分、合并或重排。单账号分析不是顶级 Tab，从账号总览的账号行下钻进入，并保留当前总览筛选条件。AssistantDock 不进入 P4（D-6 已定案，三工作台助手均后置）。

## 4. 账号总览与单账号分析

账号总览使用全宽布局：

```text
筛选与工具栏
├─ 账号、发布时间窗口、排序、负责人筛选
├─ KPI 行
├─ 账号列表 / 热门作品列表 / 爆款账号分布
├─ 运营提醒
└─ 导出总览
```

交互契约：

- 筛选变化后请求与渲染按最新请求序号收口，过期响应不得覆盖新状态；
- 缺失指标显示数据缺口，不补 0、不猜测；
- 账号行进入单账号分析页，返回总览时保留原筛选；
- 热门作品行打开统一作品详情弹层，跨账号详情显式携带所属账号；
- 负责人保存后同步筛选选项，失败保留原筛选与原数据。

单账号分析仍是账号总览 Tab 内的下钻页：

```text
返回总览
├─ 账号 KPI 与指标行
├─ 作品趋势图与指标切换
├─ 观众与内容分析
├─ AI 账号表现分析与证据作品
└─ 导出账号分析报告
```

AI 分析受理、轮询、失败与重跑确认沿用旧插件语义；轮询不阻塞其他只读指标浏览。

## 5. 账号作品

账号作品页保持旧插件两列布局：

```text
账号管理栏（约 280px） | 作品数据面板
```

左侧账号管理栏包含：

- 添加账号与扫码状态；
- 账号卡片、头像、昵称、粉丝数、会话状态；
- 单账号检测、重扫、删除；
- 全账号顺序采集入口与批量进度；
- 删除账号的两步确认和本地凭证清理状态。

右侧作品面板包含：

- 采集本账号全部、刷新、最近采集时间；
- 采集进度、入库进度、部分完成 / 失败 / 取消状态；
- 作品摘要与高密度作品表格；
- 排序与横向滚动；
- 作品详情弹层；
- 作品导出；
- 负责人与投流登记入口。

采集范围沿用旧插件 2026-06-01 上海时间起点；发布时间缺失时不得静默丢弃，列表完整性按旧插件语义降级。

## 6. 发布排期看板

发布排期看板完全保留 RQ-2026-013 的产品功能，使用新版表格、输入控件、确认弹层和状态样式重做。

页面结构固定：

```text
工具栏
├─ 新增行
├─ 刷新
└─ 就近提示

排期表格
├─ 序号
├─ 拍摄日期
├─ 视频内容
├─ 拍摄情况
├─ 是否发布
├─ 成片 / 封面网盘链接
├─ 备注
├─ 发布日期
├─ 发布平台
├─ 拍摄负责人
├─ 剪辑负责人
└─ 操作

底部账号栏
└─ 有效抖音账号横向切换
```

发布平台固定为：

```text
小红书 / 抖音 / 视频号
```

行交互契约：

- 新增行创建空白行，成功后聚焦视频内容输入；
- 文本与链接输入在本地变更、失焦后整行保存；
- 日期选择器变更即按整行保存；
- 拍摄情况、是否发布和发布平台是行内控件；
- 保存前比较归一化后的业务快照，未变化不得调用更新接口或递增行版本；
- 保存中的行可继续输入，后续修改进入 queued 快照，保存成功后如仍有差异用新幂等键补提交；
- 删除必须二次确认，确认后携带当前版本与幂等键；
- 非 idle 行禁用删除；删除在途时整行只读；
- 失败保留用户输入，只允许同键重试、刷新或显式放弃修改；
- `SCHEDULE_ROW_CONFLICT` 后行只读并提示刷新；
- `IDEMPOTENCY_OUTCOME_UNKNOWN` 后只允许同键重试或刷新确认，禁止换新键自动重发；
- 任一行 saving / queued / unknown，或 failed / conflict 且有未提交修改时，禁止切换账号；
- 有同类未落定修改时禁止整表刷新，避免丢输入；
- 放弃修改先用最近服务端快照立即还原，再重拉列表；
- 新增行在途时注册离开确认，防止误刷新或误关闭。

行状态固定：

```text
idle | saving | queued | failed | conflict | unknown
```

展示规则沿用 2026-11-20 业务反馈迭代：

- 已发布行分组折叠，折叠状态会话内保留；
- 已发布组展开时置于表格顶部；
- 在途或异常行保持可见，直到落定；
- 未发布行按发布日期升序，无日期排最后，同日期按 rowId 稳定排序；
- 未发布组内使用组内奇偶斑马纹；
- 状态色优先于斑马纹；
- 深浅主题下行背景、sticky 列和状态色一致。

`rowId` 与 `rowVersion` 在 UI / Host 边界使用十进制字符串比较与序列化，避免超过 JavaScript safe integer 后丢精度。`created_by` / `updated_by` 不进入 UI。

## 7. 爆款素材看板

素材看板保持旧插件的信息结构：

```text
KPI 行
├─ 筛选栏：档位、来源、标签、时间、关键词、状态
├─ 素材看板表格
├─ 评分理由抽屉
├─ 关键词 seed 管理
├─ 对标账号 seed 管理
├─ 手动采集与运行历史
└─ 失败明细弹层
```

交互契约：

- seed 新增、编辑、启停均有确认与幂等键；
- 同一时刻只允许一个手动 run 未终态；
- 手动采集展示受理与轮询状态，终态后刷新 board、seed 与 run 历史；
- 评分与失败原因逐行可解释，缺失字段显示缺口；
- board 分页与服务端 total 一致，不用当页行数冒充 total；
- 候选可带入爆款拆解页，预填链接但不自动开始任务；
- 写操作失败不改变原列表。

## 8. 爆款拆解

爆款拆解保持旧插件两区结构：

```text
新建与下载区
├─ 抖音链接
├─ 仿写规则选择
├─ 归档受理与轮询
├─ 下载直链受理与轮询
└─ 操作回执

历史列表
├─ 状态筛选
├─ 分页加载
└─ 打开详情
```

详情页保留：

- 候选公开指标；
- 原文分段与仿写分段；
- 分镜脚本；
- 工作流状态与步骤进度；
- 重新仿写确认；
- 失败强制重试入口；
- 多 sheet 导出。

归档、下载和工作流均为异步或可能产生费用 / 外部请求的操作，必须显示受理、状态、失败和重试路径。

## 9. 爆款基因库

基因库保持旧插件的卡片墙与筛选形态：

```text
筛选区
├─ 搜索与标签 / 维度筛选
├─ 已选条件条
├─ KPI 与失败记录入口
├─ 基因卡片墙
└─ 详情 / 编辑 / 重建弹层
```

交互契约：

- 标签与维度可展开、勾选、移除、清空；
- 卡片保留封面、标签、命中维度和关键指标；
- 详情展示基因维度、报告与证据；
- 人工编辑使用确认与幂等键；
- 重建是异步模型能力，必须确认并显示费用 / 任务状态；
- 失败记录可逐条重试；
- 搜索、分页和筛选请求不得互相覆盖。

## 10. AI 报表

AI 报表保持旧插件列表 / 详情双态：

```text
报表列表
├─ 日报 / 周报切换
├─ 分页加载
└─ 打开详情

报表详情
├─ 指标 KPI 与环比
├─ 趋势图
├─ 质量覆盖率
├─ 异常与 AI 洞察
├─ 账号表与作品卡
├─ 历史版本切换
├─ 重建确认
└─ HTML / PDF 导出
```

交互契约：

- 版本切换只读，不触发模型；
- 重建必须确认，并保留旧版本；
- 重建结果未知或幂等冲突按稳定错误原样投影，不自动换键；
- 数据不足状态提供明确补数据指引，不用空白或假成功替代；
- 长报表提供摘要、锚点、复制和导出路径。

## 11. 视觉、响应式与可达性

视觉实现只使用：

- `PluginPageShell`、`PluginHeader`、`FilterBar`、`KpiCard`、`ChartFrame`、`DataCard`、`DataState`、`OperationReceipts`；
- 官方 `@deepseek-ai/dsh-client-ui-primitives` 原子控件；
- 插件局部 CSS Modules；
- `--dsw-*` 官方主题 token 与集中 `--yt-chart-*` 语义色；
- typed dictionary，zh 为键集事实源，en 全量同步。

禁止迁移或复制：

- `ydo-*` 类名与旧 CSS；
- 旧 inline style、全局 style、固定色值、旧字体和旧几何；
- 旧 sidebar footer 弹层宿主形态；
- 旧公共 MCP route 直连。

容器矩阵固定：

| 容器宽 | 布局 |
|---|---|
| 宽于 1120px | 账号作品保持账号栏 + 主区；总览、排期、素材、拆解、基因库、报表保留高密度主区 |
| 1120px | 图表与卡片压缩；账号栏收窄；高密度表格保留横向滚动 |
| 880px | 区域堆叠；KPI 与筛选换行；表格保持可键盘进入的横向滚动 |
| 640px | 单列优先；长文本、长数字、账号 chip 和操作按钮完整可达 |

必须覆盖明暗主题、键盘路径、焦点回归、屏幕阅读器名称、表格横向滚动焦点、长文本 / 长数字截断与完整可读名称、reduced-motion。任何布局溢出、焦点丢失、不可读对比度、假数据或错误状态伪装都算失败。

## 12. D0 冻结与通过标准

本册交付后，D0 仍需完成：

1. 冻结旧插件版本与发布排期变更点；
2. 导出旧 Host action、状态 schema、测试与 E2E 清单；
3. 对账旧 route 33 项抖音工具、Workbench 33 项抖音工具与 22 项 viral 工具；
4. 对账 Agent 39 项与普通会话 guard 分类；
5. 复核本册每个页面与旧源码 / 截图；
6. 用户确认冻结点。

UI 通过标准：

1. 顶级导航、页面结构、功能入口和任务动线与旧插件一致；
2. 发布排期看板功能完整，未裁剪新增、整行保存、删除、恢复和账号切换互斥；
3. 没有旧插件不存在的顶级导航或重新发明的页面结构；
4. 没有迁移旧 CSS、旧类名、inline style 或旧宿主形态；
5. 55 项抖音 Workbench 白名单外全部拒绝；
6. Agent 排期 list 读放行、create / update ask、delete 不可见；
7. 明暗主题、三档宽度、键盘路径与 reduced-motion 全部通过。
