# P2 视频号工作台 UI 布局回正方案

状态：**已实施并通过 2026-11-23 用户真机验收**（布局与功能契约不变；验收记录见 [16-three-workbench-real-device-acceptance.md](16-three-workbench-real-device-acceptance.md)）。

本方案是 [09-workbench-migration-plan.md](09-workbench-migration-plan.md) P2 视频号工作台的 UI 布局与交互补充契约。W5 本地真实链路已证明 Host、MCP、采集和数据契约可用，但现有四 tab 信息架构偏离旧工作台的产品形态；后续实现必须按本册回正。设计规范仍以 [../plugin-ui-ux-standard.md](../plugin-ui-ux-standard.md) 和 [05-ui-ux.md](05-ui-ux.md) 为准。

## 1. 定案口径

旧插件的**布局、信息架构和任务动线**是 P2 UI 的产品基准；旧插件的**视觉与实现技术**不迁移。新版必须使用 PluginPageShell、官方 primitives、yootun kit、CSS Modules、主题 token、typed dictionary 和现行无障碍底盘重做。

| 层 | 处理 |
|---|---|
| 页面骨架 | 对齐旧插件 |
| 区域关系 | 对齐旧插件 |
| 顶级导航 | 对齐旧插件：作品数据 / 账号总览 |
| 交互方式 | 对齐旧插件，包括作品行双击打开详情、Enter 等价路径、工具栏就地进度 |
| 信息密度 | 对齐旧插件，包括 5 张作品摘要卡、10 项账号指标、4 项关注者指标、画像五维同屏 |
| 视觉样式 | 按 yootun 新规范重做 |
| DOM 与 CSS | 不迁移 `ywc-*`、全局 style、inline style、旧色值、旧字体和旧几何 |
| 宿主形态 | 不恢复 sidebar footer 弹层；继续使用 root main 中央面板和 sidebar.panellist 入口 |

布局证据以旧仓库只读源码和截图为准：

```text
docker-helm.dofe.ai/plugins/dsh-yootun-wx-channels-operation/src/client.js
docker-helm.dofe.ai/plugins/dsh-yootun-wx-channels-operation/src/account-ui.js
docker-helm.dofe.ai/plugins/dsh-yootun-wx-channels-operation/src/work-ui.js
docker-helm.dofe.ai/docs/1109/wx/ui-demo.png
docker-helm.dofe.ai/docs/1109/wx/screenshots/wx-ui-light-work.png
docker-helm.dofe.ai/docs/1109/wx/screenshots/wx-ui-light-account.png
docker-helm.dofe.ai/docs/1109/wx/screenshots/wx-ui-light-detail.png
```

## 2. 页面总骨架

新版页面在 PluginPageShell 内重译旧布局：

```text
PluginPageShell
├─ PluginHeader
│  ├─ 视频号工作台
│  ├─ 扫码登录视频号助手，采集账号全部作品、账号数据与关注者数据
│  └─ 浏览器状态 / 刷新等全局辅助操作
├─ SegmentedTabs
│  ├─ 作品数据
│  └─ 账号总览
└─ Body
   ├─ 作品数据：左侧账号管理 + 右侧作品面板
   └─ 账号总览：全宽三段数据区
```

顶级导航只能是两个页面：

```text
作品数据 / 账号总览
```

不得再把“采集”和“账号”做成顶级 tab：

- 账号管理属于作品数据页左侧栏；
- 单账号采集属于作品工具栏；
- 全账号采集属于账号管理栏；
- 账号总览是独立的全宽数据页。

## 3. 作品数据页

### 3.1 左侧账号管理栏

作品数据页使用两列布局：

```text
账号管理栏（约 280px） | 作品数据面板（剩余空间）
```

账号管理栏从上到下：

```text
账号管理 + 采集全部
└─ 批量采集面板（仅运行中或有终态结果时）
└─ 账号卡片列表
└─ 添加账号
└─ 登录中 / 浏览器缺失提示
```

账号卡片信息：

- 头像或安全占位；
- 昵称，缺省显示账号 ID；
- 关注者数；
- 最近同步时间；
- 会话状态：登录有效 / 登录已过期 / 状态未知；
- 当前选中态；
- 本地凭证缺失或 pending 状态；
- 操作：检测会话、重新扫码、提升、删除账号。

交互契约：

- 点击卡片主体切换当前账号；
- `检测会话`只在会话有效行出现；
- 过期或未知状态显示`重新扫码`；
- pending 账号显示`提升`；
- 删除保持两步确认：本地清理成功后才远端删除；
- 批量采集面板挂在标题行下方、账号列表上方；
- 批量运行中显示总进度、当前账号、细粒度进度和四类计数；
- 批量终态显示成功 / 部分完成 / 失败 / 跳过，以及失败和跳过账号明细；
- 添加账号在登录进行中禁用，并提示用户在系统 Chrome 窗口扫码。

### 3.2 右侧作品面板

作品面板从上到下：

```text
作品工具栏
└─ 5 张作品摘要卡
└─ 作品表格
```

工具栏第一行：

```text
[采集本账号全部] [刷新] 最近采集时间：…
```

工具栏第二行仅在存在状态时渲染：

- 单账号采集进度；
- 或刷新结果提示；
- 采集进度优先于刷新提示；
- 运行中提供取消采集；
- 不把采集进度放到页面顶部通知条。

摘要卡固定 5 张：

| 卡片 | 口径 |
|---|---|
| 作品总数 | 账号 `feedCount` |
| 近 7 日播放 | `summaryOverview.metrics.totals.daily_play_count` |
| 近 7 日关注量 | `summaryOverview.metrics.totals.daily_follow_count` |
| 作品完播率 | 按播放加权计算 |
| 缺口作品 | 核心字段缺失的作品数 |

`summaryOverview` 必须固定使用 `last_7d`，不随账号总览页时间窗变化。

## 4. 作品表格与详情

### 4.1 表格列

作品表格保留旧插件的高密度列：

| 列 | 排序 |
|---|---|
| 作品：封面 + 标题 / 占位 | 否 |
| 发布时间 | 是 |
| 完播率 | 是 |
| 平均播放时长 | 是 |
| 播放 | 是 |
| 喜欢 | 是 |
| 收藏 | 是 |
| 评论 | 是 |
| 分享 | 是 |
| 转发聊天和朋友圈 | 是 |
| 关注量 | 是 |
| 企微链接点击 | 否 |
| 添加通讯录 | 否 |

实现要求：

- 不设置“操作”列；
- 作品列不显示 ID 副行；
- 可排序列表头是 button，`aria-sort` 与箭头一致；
- 点击排序循环：默认 → 降序 → 升序；
- 行可聚焦；
- **鼠标双击行打开作品详情**；
- 行内 Enter 打开同一详情，作为键盘等价路径；
- 行的 `aria-label` 说明“双击或 Enter 查看详情”；
- 表格在固定高度区域内滚动，不增加页面主体滚动长度；
- 加载态与真实空态分开；
- 空态引导先执行采集。

### 4.2 作品详情弹层

作品详情必须是 dialog，不是列表下方的 inline 卡片。使用官方 Modal 或同等复合组件，双击 / Enter 打开，Escape 关闭，关闭后焦点回到触发行。

弹层结构：

```text
作品详情 Dialog
├─ Header：标题 + 关闭
├─ 基础信息：封面 + 作品 ID + 发布时间 + 最近采集时间
├─ 核心指标卡
├─ 来源分布 | 观众留存趋势
├─ 按日数据近 7 天多指标趋势
└─ 核心数据缺口
```

核心指标包含旧详情口径：

- 播放；
- 喜欢；
- 收藏；
- 评论；
- 分享；
- 转发聊天和朋友圈；
- 关注量；
- 完播率；
- 平均播放时长；
- 企微链接点击次数 / 人数；
- 添加通讯录次数 / 人数。

详情数据继续使用已验证契约：

```text
work.get   → { work, traffic_source, retention_trend, daily_metrics, data_gap }
work.trend → { account_id, work_id, snapshots }
```

弹层优先消费 `work.get` 的完整详情；`work.trend` 用于补充或刷新趋势，不得用顶层平铺或虚构包装。

## 5. 账号总览页

账号总览页隐藏左侧账号栏，使用全宽纵向三段：

```text
当前账号选择器
└─ 全部视频指标
└─ 关注者增长 | 关注者增长指标
└─ 关注者画像
```

当前账号选择器在有可用账号时始终显示，不因单账号隐藏；切换账号时保留选择器，只让三段数据进入加载态。

### 5.1 全部视频指标

标题行：

```text
全部视频指标      [昨日] [近7天] [近30天]
```

指标卡固定 10 张：

| 指标 | 字段 |
|---|---|
| 播放 | `metrics.totals.daily_play_count` |
| 喜欢 | `metrics.totals.daily_like_count` |
| 收藏 | `metrics.totals.daily_favorite_count` |
| 评论 | `metrics.totals.daily_comment_count` |
| 分享 | `metrics.totals.daily_share_count` |
| 转发聊天和朋友圈 | `metrics.totals.daily_forward_count` |
| 关注量 | `metrics.totals.daily_follow_count` |
| 设为铃声 | `metrics.totals.daily_ringset_count` |
| 设为状态 | `metrics.totals.daily_status_ref_count` |
| 设为朋友圈封面 | `metrics.totals.daily_status_cover_count` |

`availability.account_metrics=no_data` 时显示真实空态，不把缺失值补成 0。

### 5.2 关注者增长

左右双卡：

```text
关注者总数趋势（近 7 天） | 关注者增长指标
```

趋势图：

- 固定使用 `last_7d`，不随账号总览当前时间窗截断；
- 主线为关注者总数；
- y 轴有稳定刻度；
- hover / focus 显示日期和数值；
- 缺失日断线，不伪造成 0。

指标卡固定 4 张：

| 指标 | 字段 |
|---|---|
| 净增关注 | `fans_trend.totals.follower_net_count` |
| 新增关注 | `fans_trend.totals.follower_add_count` |
| 取消关注 | `fans_trend.totals.follower_reduce_count` |
| 关注者总数 | `fans_trend.followerTotalCount` |

### 5.3 关注者画像

画像五维同屏，不使用维度 tab：

```text
第一行：性别分布 | 访问设备分布 | 年龄分布
第二行：省份分布 | 城市分布
```

实现要求：

- 性别与设备使用环形图，中心显示总人数；
- 年龄使用柱状图，柱顶显示百分比；
- 省份与城市按人数降序，只展示 Top 5；
- 省市长尾不渲染成无限列表；
- 每个维度显示人数和占比；
- 单维度缺失显示“该画像维度本次未提供”；
- 整体无画像显示 no_data，不渲染空分布；
- 图表颜色使用集中 `--yt-chart-*` 语义 token，不复制旧字面色值。

## 6. 采集归位

### 6.1 单账号采集

入口在作品工具栏：

```text
[采集本账号全部]
```

行为：

- 点击后立即进入乐观运行态；
- 按钮禁用并显示“采集中…”；
- 工具栏下方显示阶段进度；
- `collect.start` 返回 `started:false` 时清除乐观态并显示稳定 reason；
- 运行中提供取消；
- 终态保留真实 completed / partial / failed / cancelled / interrupted；
- 不把失败伪装成空数据。

### 6.2 全账号采集

入口在账号管理栏标题行：

```text
账号管理        [采集全部]
```

行为：

- 无可采集账号时禁用并解释原因；
- 批量运行中按钮显示“采集中”；
- 批量面板显示总进度和当前账号；
- 终态四类计数完整；
- 失败 / 跳过 / 部分完成账号逐行显示稳定原因；
- 批量取消在批量面板内。

### 6.3 run 查询（已移除）

2026-11-20 真机验收定案：移除作品工具栏的「运行查询」入口与 Dialog。run 维度的核对改由采集终态进度与 `collect.status` 投影承担，Host `run.get` action 保留但不再提供页面入口。

## 7. 新版实现与视觉映射

| 旧结构 | 新实现 |
|---|---|
| `ywc-root` / `ywc-shell` | `PluginPageShell` |
| 旧 header | `PluginHeader` + 官方图标与状态组件 |
| 旧两枚 tab button | `SegmentedTabs` |
| 左侧账号栏 | 插件场景层 CSS Modules 两列布局 |
| 账号卡片 | DataCard / 列表样式 + StateDot + 官方 Button / Menu |
| 批量面板 | DataCard 或插件局部状态卡 |
| 作品工具栏 | FilterBar / toolbar 组合 |
| 摘要卡 | `KpiCard` |
| 作品表格 | 语义 table + 排序 button + CSS Modules |
| 作品详情 dialog | 官方 Modal 基底 + 详情复合布局 |
| 账号指标卡 | `KpiCard` |
| 趋势图 | `ChartFrame` + 新 SVG marks |
| 环形 / 柱状 / 横条图 | `ChartFrame` + 新 SVG 或 CSS marks |
| 加载 / 空态 / 错误 | `DataState` |
| 旧 copy | typed dictionary + `t()` |

禁止事项：

- 不迁移 `ywc-*`；
- 不注入 `<style>`；
- 不使用全局选择器；
- 不使用旧 inline style；
- 不复制旧色值、字体、阴影、间距；
- 不恢复 sidebar footer 弹层；
- 不把旧中文 copy 直接硬编码进组件。

## 8. 响应式与可达性

### 1120px 及以上

- 完整还原旧布局；
- 作品数据页为 280px 账号栏 + 右侧作品面板；
- 账号总览为全宽三段；
- 作品表格保持高密度内部滚动。

### 880px

- 作品数据页改为上下结构：账号管理在上、作品面板在下；
- 摘要卡可变 3 列；
- 关注者增长双卡可上下排列；
- 画像可 2 列；
- 表格保持内部横向滚动。

### 640px

- 账号卡片纵向排列；
- 工具栏换行；
- 摘要卡 2 列；
- 画像单列；
- 详情 Dialog 全宽；
- 作品表格与批次表内部横向滚动；
- 行操作可收敛为官方 Menu，但双击和 Enter 打开详情不变。

可达性硬项：

- 双击详情保留；
- 行 `tabIndex=0`，Enter 等价打开；
- 行 `aria-label` 完整说明动作；
- Dialog `role="dialog"`、`aria-modal`、Escape、焦点回归；
- 排序 button 与 `aria-sort` 一致；
- 图表 mark 可聚焦；
- 明暗双主题；
- `prefers-reduced-motion` 关闭非必要动画。

## 9. 实施步骤

### Step 1：页面骨架回正

- 四 tab 改两 tab；
- 新增账号管理侧栏；
- 作品数据页左右布局；
- 账号总览页全宽布局；
- 移除顶级采集 / 账号 tab；

### Step 2：作品页回正

- 实现账号管理栏；
- 实现批量采集面板；
- 实现作品工具栏与就地进度；
- 实现 5 张摘要卡；
- 扩展 works schema，读取封面和完整指标；
- 实现高密度表格和排序；
- 恢复双击 / Enter 详情；
- 详情改 Modal。

### Step 3：总览页回正

- 实现 10 项账号指标；
- 实现 4 项关注者指标；
- 实现固定 7 天趋势；
- 实现画像五维同屏；
- 实现性别 / 设备环形图；
- 实现年龄柱状图；
- 实现省市 Top 5 条形图。

### Step 4：测试与视觉验收

- 更新错误四 tab 测试；
- 锁定两 tab 和区域顺序；
- 锁定双击 / Enter 详情；
- 锁定 Dialog 焦点行为；
- 锁定 5 / 10 / 4 卡数量；
- 锁定画像五维同屏；
- 锁定采集入口和进度位置；
- 重跑真实本地 E2E；
- 重拍明暗、1120 / 880 / 640、键盘和 reduced-motion 证据。

## 10. 通过标准

布局回正只有同时满足以下条件才通过：

1. 页面打开后的区域顺序和层级与旧工作台一致，而不是只有数据相同；
2. 顶级导航只有作品数据和账号总览；
3. 作品数据页左侧是账号管理，右侧是作品面板；
4. 账号总览隐藏账号栏并全宽展示三段数据；
5. 作品行双击和 Enter 都能打开详情 Dialog；
6. 作品详情、来源分布、留存、按日趋势和数据缺口完整；
7. 5 / 10 / 4 卡数量与旧口径一致；
8. 画像五维同屏，省市为 Top 5；
9. 单账号、全账号入口不破坏旧布局；
10. 视觉、token、i18n、键盘、响应式和 reduced-motion 全部符合新规范；
11. 本地真实 Tools、真实扫码和采集 E2E 不回归。
