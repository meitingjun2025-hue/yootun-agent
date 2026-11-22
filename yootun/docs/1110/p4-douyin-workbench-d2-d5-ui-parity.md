# P4 抖音工作台 D2–D5 UI parity 矩阵

状态：D2–D5 开工锚定（2026-11-22）。上游基准：[p4-douyin-workbench-baseline.md](p4-douyin-workbench-baseline.md)（D0 冻结）与 [14-douyin-workbench-ui-layout-parity.md](14-douyin-workbench-ui-layout-parity.md)。本册逐区域锚定「旧页面 → 新落位」：旧插件决定页面结构、功能与任务动线；本仓库决定视觉语言（kit 组件 + 官方 primitives + `--dsw-*`/`--yt-chart-*` token + CSS Modules）。每个按钮先分语义层级再选组件；相邻不同语义按钮不得同为白底。D6–D8（爆款素材看板/拆解/基因库）自 `feat/yootun-douyin-workbench-d6-d8-host-ui` 分支起为真实实现，逐页契约见 [p4-douyin-workbench-d6-d8-ui-parity.md](p4-douyin-workbench-d6-d8-ui-parity.md)；本册 §0 的「D6–D8 三 Tab 面板为 DataState」锚点随该分支由新 parity 文档接管。

## 0. 顶级导航（7 Tab 冻结）

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 顶级 nav（client.js 4451-4488） | 7 Tab 固定顺序：账号总览 → 账号作品 → 发布排期看板 → 爆款素材看板 → 爆款拆解 → 爆款基因库 → AI 报表；点击切页并收起 AI 弹层；仅账号作品 Tab 有左侧账号栏，其余全宽 | 普通按钮 Tab 序 + `aria-current` 底部 3px 品牌指示线 | PluginPageShell 内 SegmentedTabs（唯一 tablist） | `SegmentedTabs`（官方，键盘 Left/Right/Home/End 自带）+ `aria-current`；无旧类名 | 测试断言 tablist 顺序与文案恰好 7 项、默认账号总览、单账号分析不是顶级 Tab；D6–D8 三 Tab 面板为 DataState |

单账号分析从账号总览账号行下钻进入（非顶级 Tab），返回保留总览筛选。

## 1. 账号总览页

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 筛选工具栏（overview-ui 369-457） | 4 筛选：账号（全部账号+目录）/ 发布时间窗（近7/30/90天/自定义+起止日期）/ 排序（爆款数/爆款率/中位播放/总播放/互动率）/ 负责人（全部+去重中文排序）；owner 变更换联动重置账号；自定义日期越界纠偏只触发一次查询 | FilterSelect 自绘下拉 | FilterBar（chips + 尾部 SegmentedControl/Menu） | 官方 `Menu`/`MenuItemButton` 替代自绘下拉；日期用官方 `Input type=date`；筛选 chips 可清除 | 4 筛选齐全 + 默认 30d/hot_count；自定义窗口空值不提交；请求按最新序号收口 |
| KPI 行（487-516） | 6 卡：管理账号/作品总数/播放增量/净增粉丝/5秒完播率/爆款视频；缺失指标显示数据缺口不补 0（播放增量等 null 时整卡不渲染）；净增粉丝红涨绿跌 | ydo-ov-kpi 卡 | KpiRow（6× KpiCard） | `KpiCard`（delta 用 kit 语义色）；缺失走 DataState 缺口态 | 缺失→「—」或整卡消失，不造 0；净增粉丝涨红跌绿 |
| 账号表现排行表（518-550） | 11 列：排名/账号(过期·可疑旗标)/负责人/粉丝/窗口净增/窗口播放/作品数/中位播放/爆款视频/爆款率/互动率；行点击下钻单账号分析；目录不完整禁用筛选并提示同步中 | 11 列 grid + data-label 窄容器重排 | DataCard 内高密度表格 | 插件局部表格 CSS Modules（列宽 token 化）；旗标用 `Tag tone=warning/danger`；行键盘可达（Enter 下钻） | 11 列齐全；行可键盘下钻；旗标仅可行动状态 |
| 爆款视频表（568-583） | 6 列：视频(链接开详情)/所属账号/发布时间/播放量/互动率/爆款依据；已投流行红 pill + 淡红底 | 6 列 + promo pill | DataCard 表格 | 投流 pill 用 `Tag tone=danger`；行底色 token | 6 列齐全；点击打开统一作品详情弹层 |
| 爆款账号分布 | 分布条形（仅数组时渲染） | 分布 BarList | DataCard + ChartFrame | kit `ChartFrame` + `--yt-chart-*` 语义色 | 缺失不渲染，不造 0 |
| 运营提醒（113-128） | dataQuality 派生：会话过期/可疑空采集/超 7 天未采集，每账号 ≤3 条 | ul 列表 | DataCard 列表 | 状态前缀 `StateDot state=warning/error` | 三类提醒文案与阈值 |
| 导出总览 | `overview.export`（xlsx base64 下载） | 次要按钮 + 下载图标 | 工具栏右侧 | `Button variant=toolbar/ghost` + icon（次操作） | 导出成功触发下载；export_too_large 文案 |

错误码→文案（ACCOUNT_NOT_ACCESSIBLE/TOO_MANY_ACCOUNTS/RULE_VERSION_MISMATCH/INVALID_TIME_WINDOW/export_*/douyin_operation_request_failed）进 typed dictionary，语义不裁剪。

## 2. 单账号分析下钻页（总览 Tab 内）

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 工具栏（analysis-ui 677-691） | ← 返回账号总览（保留筛选）/ AI 分析（开弹层）/ 导出账号分析报告 | 次要按钮 ×3 | 页顶工具栏 | 返回=`Button ghost`；AI 分析入口=`Button ghost`（弹层内主操作才 primary）；导出=`Button ghost`+icon | 返回后总览筛选保留 |
| 头部（693-704） | 账号名/负责人/粉丝·作品数·最近采集/结构性提醒+服务端规则提醒 | 文本行 + 旗标 | DataCard 头部 | 规则提醒 `Tag`；缺失「暂无记录」 | 提醒 ruleId 中文映射（高播放低互动等 4 类） |
| 核心 KPI（706-711） | 5 卡：播放增量/中位播放/最高播放量/爆款视频/爆款率 | ydo-ov-kpi | 5× KpiCard | 同总览 KPI | 缺失「—」 |
| 粉丝数据面板（715-728） | 5 卡：总粉丝量/吸粉量(红涨绿跌)/脱粉量(恒绿-N)/回访粉丝/主页访问；整块缺失不渲染 | 面板 | DataCard + KpiCard 行 | 同上 | 缺卡不渲染不造 0 |
| 数据趋势（730-755） | 指标筛选（7 枚举）+ 趋势折线（缺口虚线、单点提示、窗口 30 天）+ caption | FilterSelect + SVG 折线 | DataCard + ChartFrame | 指标切换用 `Menu`；折线 kit ChartFrame + `--yt-chart-1`；缺口 dashed 段 | 趋势错误独立呈现不吞成「暂无趋势」；单点仍画 |
| 内容指标面板（758-769） | 8 卡：综合互动率/点赞率/评论率/收藏率/分享率/吸粉量/5秒完播率/平均播放占比/平均播放时长；覆盖率缺失→「数据不足」note | ydo-an-metrics 网格 | DataCard + 指标卡网格 | 插件局部指标卡 CSS Modules | note 规则（缺失或 0→数据不足） |
| 观众与流量（770-774） | 5 块：主要性别/年龄/地域/城市级别/主要流量来源；各前 3 条形 | AudienceBlock 条形 | DataCard 2 列网格 | kit 分布条（`--yt-chart-*` 类别色，色彩不承载唯一信息） | 缺失块「数据不足」 |
| 本账号爆款视频表（267-303） | 7 列：排名/视频/发布时间/播放量/互动率/吸粉量/爆款依据 | 表格 | DataCard 表格 | 同总览爆款表 | 7 列齐全 |
| AI 分析弹层（615-624 + 418-607） | 六折叠卡：结论摘要/表现诊断/爆款规律/风险与机会/执行建议/数据限制；状态机（未分析/分析中/已完成/数据不足/失败）；开始分析/重新分析（确认弹层）；证据作品 chip 叠开作品详情 | 分色折叠卡 + 二次确认 | Modal + 折叠卡 | 官方 `Modal`（Esc/焦点回归）；折叠卡 `DisclosureRow` 或局部 CSS；等级徽章 `Tag`；重新分析确认 `RiskConfirmation` | 受理/轮询(3s, 连续 5 次失败停)/失败保留旧结果；9 个 AI 错误码文案 |

## 3. 账号作品页（唯一两列布局）

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 左侧账号管理栏（280px，client.js 4358-4409） | 标题「账号管理」+「采集全部」主按钮；批量进度面板；账号卡（头像/昵称/粉丝/会话徽标 + 检测会话·重新扫码 + 红色删除）；空态「添加账号后开始采集」；添加账号主按钮（等待扫码…/aria-busy）；扫码提示 role=status | 卡片 + 主按钮 + 危险链接 | 左栏（CSS Modules 两列 grid 280px/1fr） | 添加账号/采集全部=`Button variant=primary`（主操作）；检测/重扫=`Button ghost sm`（次操作）；删除=danger 语义（error token 文本+hover）；会话徽标 `StateDot+Tag` | 主按钮非白底；删除按钮 danger 语义与检测按钮视觉区分 |
| 批量进度面板（1708-1748） | running：spinner+「正在检查会话 i/n」/「第 i/n 个账号」+当前账号+细粒度进度+成功/失败/跳过；终态三态（完成绿/部分完成黄/未完成红）+未完成明细（6 类原因文案） | 状态色面板 | 左栏 DataCard | 终态色走 kit 语义（success/warning/error token）；明细行 reason→文案字典 | 三态文案；批量运行中账号卡全禁用 |
| 删除两步确认（4882-4896） | 确认弹层（标题/不可恢复提示/确认删除/取消）→ removeLocal→removeRemote；RUN_STILL_ACTIVE 专属文案；cleanup_failed 重试块 role=alert | 插件内确认框 | `Modal` + `RiskConfirmation` 风格 | 确认删除=error 语义主按钮（`Button primary` + error token class）；取消=ghost | 删除半清理失败阻断远端；Esc 关闭回归焦点 |
| 右侧工具栏（4790-4826） | 采集本账号全部（主）/ 负责人入口（未设置·新增/已设置·编辑）/ 刷新（次）/ 导出 Excel（次+图标）/ 上次采集时间 / 全部时间作品数 | 主+次按钮层级 | 右栏工具栏 | 采集本账号全部=`primary`；刷新/导出/负责人=`ghost sm`+icon | 主操作唯一且非白底；相邻次操作可辨 |
| 采集进度/错误区（4827-4832） | runBanner 三色（失败红/部分完成黄/完成绿）；采集进度 role=status aria-busy（采集进度 i/n·入库进度 b/t·succeeded/expected）；错误行 role=alert（ERROR_COPY 全表） | 状态色 | 工具栏下状态行 | 状态色 token 化（error/warning/success）；进度文案三态字典 | 会话过期专属文案；进度 aria |
| 作品表格（1596-1684） | 12 列固定序：作品名称(sticky)/作品链接(sticky)/播放量/收藏量/点赞量/评论量/2s跳出率/5s完播率/完播率/吸粉量/平均播放时长/平均播放占比；10 数值列三态排序（默认→降→升），缺失恒最后、显示「—」不造 0；百分比 clamp；行双击/Enter 开详情；已投流行淡红底+pill；链接白名单 douyin.com | 高密度 grid 表格 + sticky 列 | DataCard 高密度表格 | 插件局部表格 CSS Modules（sticky、横向滚动、排序按钮 aria-sort）；投流行 error-token 淡底 | 12 列序冻结；排序三态；缺失「—」；吸粉量红涨绿跌 |
| 作品详情弹层（908-1097） | 头部（封面/标题/发布时间·私密徽标/最近采集/投流操作区）→ 核心指标 8 卡 → 投流数据区（仅存在时）→ 播放量趋势（7 天窗口）→ 流量与留存（流量来源+观看趋势四状态）→ 受众画像（性别环/年龄/地域/城市级别）→ 搜索词与热词 → 数据缺口（五类 reason 文案）；跨账号显式携带 accountId | 大弹层分组卡 | `Modal`（宽 720 档）+ 分组 DataCard | 性别环用 kit 图表 token；缺口行 reason→文案；投流入口=primary（弹层内主操作） | 全区块顺序冻结；观看趋势四状态（请求失败/未提供/未满24h/暂无）；趋势独立错误不吞 |

## 4. 发布排期看板

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 工具栏 | 新增行（主）/ 刷新（次）/ 就近提示（role=alert|status，2600ms 回落） | 主+次按钮 | 页顶工具栏 | 新增行=`primary`；刷新=`ghost`；提示行 aria | 新增中禁连点+aria-busy；刷新禁用矩阵 |
| 12 列表格（schedule-ui 59-70, 538-543） | 序号(系统主键 title)/拍摄日期(date)/视频内容(textarea≤2000)/拍摄情况(checkbox+副标「需要补拍或配音在下方补充」)/是否发布(checkbox)/成片封面网盘链接(url≤2048+副标「编导和账号主理人确认」)/备注(textarea≤2000)/发布日期(date)/发布平台(3 checkbox 小红书·抖音·视频号)/拍摄负责人(≤128)/剪辑负责人(≤128)/操作(删除+状态按钮+错误文案) | 宽表格横向滚动 | DataCard 表格 + colgroup | 官方 `Checkbox`；文本/日期官方 `Input` + 局部 textarea CSS Modules；受控 value 必配 onChange | 12 列结构与副标文案冻结 |
| 行编辑与保存 | 文本/链接/负责人 blur 整行保存；checkbox/平台 change 即保存；日期 change 即保存（原生选择器关后 blur 不一定触发）；no-op 失焦（归一快照一致不调用不递增版本）；saving 中继续输入进 dirty，成功后有差异用新键补提交；新增成功聚焦视频内容 | 行内控件 | 表格行内控件 | 失焦/变更保存接 hostAction；幂等键模板 route 校验 | no-op 不发请求；dirty 补提交；迟到响应丢弃 |
| 行状态机 | idle/saving/queued/failed/conflict/unknown；conflict/unknown 只读；failed 保留输入同键重试/放弃修改（先还原再重拉）；非 idle 禁删；删除在途整行只读 | 行底色（saving 品牌色 8%/error 8%）| 表格行状态 class | 状态底色 token（品牌进行中/error）；行状态操作按钮（重试/放弃/刷新）=`ghost sm` | 状态色优先于斑马纹；六码→行状态映射（§6 必覆盖） |
| 展示规则 | 已发布组折叠置顶（仅 idle 且 published 参与；折叠态会话内保留）；未发布按发布日期升序（无日期最后，同日期 rowId 十进制字符串序）；组内奇偶斑马纹；状态色优先 | 折叠行 + 斑马纹 | 表格分组渲染 | 折叠切换行（role=button/aria-expanded）；斑马纹 layer-1 token；sticky 列随行同色 | 排序/折叠/斑马纹规则；rowId 不转 Number |
| 底部账号栏（545-570） | 「抖音账号」标签 + 账号 chip（头像/昵称/粉丝或有效账号）；chip 选中态；切换互斥（saving/queued/unknown 或 failed/conflict+dirty 禁止）；墓碑账号过滤 | chip 横排 | 表格下方账号栏 | 官方 `Pill`（active 态）；禁用时 disabled+原因 | 切换互斥矩阵与提示文案 |
| 删除确认弹层（571-583） | 标题带行内容 + 「删除后数据不可恢复」+ 取消/删除（删除中…） | 插件内确认框 | `Modal` | 删除确认=error 语义主按钮；取消=ghost | 仅 idle 行可开；Esc 回归焦点 |
| 错误码→文案 | SCHEDULE_ERROR_REASON_COPY 全表 18 条（见勘察纪要；含六必覆盖码与 UNAUTHORIZED/PAYLOAD_TOO_LARGE 等） | 行内错误文案 | typed dictionary `schedule.error.*` | 文案语义逐条迁移不裁剪 | 18 码键集测试锁定 |

## 5. AI 报表页

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 列表页（698-746） | 日报/周报 segmented 切换（重置分页重查）；刷新；表格 7 列：周期/状态 pill(已生成·数据不全·生成失败·数据不足·生成中)/版本 v{n}/覆盖账号 c/t/生成时间/说明(失败码文案)/查看；加载更多分页；空态「等待首个调度周期（日报每天 11:00 / 周报周一 12:00 自动生成）」 | segmented + 表格 | 页内二级 SegmentedControl + DataCard 表格 | `SegmentedControl`（日报/周报）；状态 pill=`Tag tone=success/warning/danger/neutral`；查看=`ghost sm` | 列结构与状态 pill 五态；分页 nextCursor |
| 详情页（748-789） | 工具栏：返回列表/版本下拉（v{n}·状态·当前）/生成中·提交中 status/重新生成/导出 HTML/导出 PDF；报表头（周期标题/生成时间/账号数/对比基准/KPI 口径/互动口径/作品口径/标注说明 + QualityBar 覆盖账号·上次采集·缺采清单）；KPI 行（涨红跌绿 `▲▼` + 上期值 + 无对比基准 flat）；趋势图（近7天/近4周 播放增量柱+净增粉丝线，缺采断开不补零，末位深色实色）；质量覆盖率；账号表（9 列，`—*` 无快照口径）；作品卡（播放/点赞/评论/带粉 + 5s 完播进度条）；异常列表；AI 洞察三列（事实/推断/建议 + 展开完整依据）；数据不足态（信号清单+重新生成） | 分组文档式渲染 | DataCard 分区 + ChartFrame 趋势 | 版本切换官方 `Menu`；KPI delta 涨红跌绿 kit token；柱 `--yt-chart-2`、末位 `--yt-chart-1`、线 `--yt-chart-4`；`—*` 缺口语义保留 | 环比涨红跌绿注明基准；缺采断开；17 稳定码文案；pending/running 等待卡 |
| 重建确认 | 「将基于当前已回补数据追加新版本 v{n}，旧版本保留。是否继续？」+ 继续生成/取消（同一点击重试复用同键） | 插件内确认 | `RiskConfirmation` | 继续生成=primary；取消=ghost | 不自动换键重发 |
| 导出 | HTML 自包含单文件（details 全展开、token 内联、文件名 抖音运营{日报|周报}_{start}）；PDF 桌面桥 `desktopNext.exportReportPdf`，桥不可用回退 `window.print`；本阶段桥未验证则给稳定 unsupported 错误 | 工具栏按钮 | 工具栏 `Button ghost` + icon | 导出中 disabled+aria-busy | HTML 导出完整；PDF unsupported 稳定报错不假成功 |

## 6. 负责人弹层与投流表单（D5）

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 负责人弹层（1114-1167） | 作品页工具栏入口（未设置·新增/已设置·编辑）；弹层：账号名称只读 + 负责人输入（≤128，trim 后空拒绝）；保存投影更新账号列表与筛选选项（去重中文排序「全部」恒首；失联清空）；失败保留原数据；Esc 链（保存中不关）；焦点捕获/回归触发按钮 | 表单弹层 | `Modal` + 官方 `Input` | 保存=`primary`（主操作）；取消=`ghost`；错误 role=alert | 保存成功同步筛选项；OWNER_NAME_* 错误文案 |
| 投流表单（1209-1288） | 详情弹层头部入口（已投流 pill + 添加/更新投流数据）；6 字段：所属账号只读/视频只读/投流播放量(整数≥0)/消耗金额(两位小数≤999999999999.99)/粉丝量(整数≥0)/实际投放时长(>0 两位小数≤999999.99)；预填用服务端字符串；recordId 变化重挂载；PROMOTION_ALREADY_EXISTS 自动重拉转更新（stale 提示「已载入最新记录，保存后将转为更新」）；三处 pill 仅详情可开弹层 | 表单弹层 | `Modal` + 官方 `Input`（number/decimal 文案提示） | 保存=`primary`；取消=`ghost`；校验分键文案 | 字段校验与 Host schema 一致（定点串）；stale-add 恢复；错误码原样投影不自动换键 |

## 7. 采集入口与进度（跨页）

| 旧页面/区域 | 旧功能与任务动线 | 旧视觉语义 | 新布局归属 | 新组件 / CSS 策略 | 验收锚点 |
|---|---|---|---|---|---|
| 采集入口 | 账号作品页「采集本账号全部」（互斥批量/单账号 collect_busy）+ 左栏「采集全部」（批量）；进度 1.5s 轮询 collect.status/collectAll.status；乐观运行态；宿主重启丢 record 清乐观态 | 主按钮 + 进度区 | 工具栏/左栏 + 状态行 | 采集按钮=`primary`+aria-busy；进度 DataState 载入态 | 互斥文案；三态进度；批量终态刷新 |
| 登录扫码流（2028-2057） | 添加账号→beginLogin→2s 轮询 loginStatus（waiting/ok(saveError)/timeout/failed）；ok 后刷新账号列表；扫码提示「请用抖音 App 扫描弹出的窗口完成登录」 | 等待态按钮 + role=status | 左栏登录区 | 等待扫码=primary disabled+aria-busy；提示 role=status | account_save_failed 文案透出；终态停轮询 |

## 8. 列表/表格操作按钮总表（语义层级强制）

| 按钮 | 语义 | 新视觉 |
|---|---|---|
| 添加账号 / 采集全部 / 采集本账号全部 / 开始分析·重新分析 / 保存（负责人·投流·排期确认）/ 新增行 / 确认删除 / 继续生成 | 主操作 | `Button variant=primary` |
| 刷新 / 导出 Excel·总览·分析报告·HTML·PDF / 查看详情 / 返回 / 取消 / 关闭 / 重试 / 放弃修改 / 编辑·新增负责人 / 查看版本 | 次操作 | `Button variant=ghost/toolbar`（+icon） |
| 删除账号（入口）/ 删除排期行（入口）/ 删除确认按钮 | 危险 | error token 文本/hover；确认按钮 primary+error class |
| 已发布 / 已投流 / 生成失败 / 数据不足 / 会话过期 | 状态 | `Tag tone=success/danger/warning` + `StateDot` |
| 采集中 / 保存中 / 分析中 / 生成中 / 提交中 / 等待扫码 | 进行中 | primary disabled + `aria-busy` + spinner |
| failed / conflict / unknown 行 | 异常态 | error/warning 行底色 + 只读 + 状态操作按钮 |

红线：相邻不同语义按钮不得同为白底（primary 与 ghost/toolbar 相邻）；删除类永远 error 语义并带确认路径；状态色不得只靠颜色（附文字）。

## 9. 无法对应项登记

无。截至本册编写日，旧插件 D0 冻结范围内的全部页面区域均有上表落位；D6–D8 三个 Tab 的业务内容不在本阶段（Tab 占位 DataState 已覆盖导航对齐）。旧 rb*（跳出空态）文案键未入旧词典的缺口在新 typed dictionary 中补齐（四状态文案齐全）。

## 10. 验收锚点 → 测试对账

每个锚点在 `tests/client/*.test.tsx`（结构/样式 class/键盘/词典断言）与 `tests/*.test.ts`（Host 行为）对账；无法本地锁定的项（系统 Chrome 扫码、真实采集、Windows 真机、明暗主题实机截图、640/880/1120 实机、reduced-motion、PDF 桥）登记为真机遗留，不以占位测试伪造。
