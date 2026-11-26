# 2026-11-26 实施单索引

建单日期：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../cross-repo-sync.md) 第四节

本目录收纳 2026-11-26 建单的业务特性实施单，来源有两处：同日的三工作台全面审查（抖音 / 视频号 / 小红书，含 tools.dofe.ai 与 docker-helm.dofe.ai 的相关面，16 张），以及同日立项的视频号 AI 报表（4 张，登记为第二批）。实施单是三仓共享的唯一协调文件，固定五章（范围 / 契约增量 / 影响面 / 状态回填 / 验收），先建单再动代码；模板见 [feature-template.md](../feature-template.md)。

P0、P1 的 16 张单状态为草案：待用户审查通过后再切特性分支动代码。P2 四张单已于 2026-11-26 确认并开始推进，状态见下表；其中两张客户端单在动代码前需用户确认（见「推进顺序」）。审查结论为「本期不做」的项不在本目录建单：插件助手 Dock 及与之绑定的操作回执 / 撤销与「撤销上次保存」、Workbench 面 scope 与写操作限流（应用层与 nginx 入口）、多租户幂等收据隔离、工作台插件在官方插件页的可插拔开关。其中写操作配额与多租户收据的判断依据和落地形态记录在 [write-quota-and-audit-attribution.md](features/write-quota-and-audit-attribution.md) 的附录里，作为网关从 ixicai 迁移、按用户 key 隔离并加入团队时的输入。

## 实施单索引

分两批登记。P0 与 P1 是三工作台审查的 16 张单，一起推进（2026-11-26 确认不设发版观察期）；P2 是视频号 AI 报表的 4 张单，在 P0、P1 合入后开始。

| 批次 | 实施单 | 内容 | 状态 |
|---|---|---|---|
| P0 | [media-upload-tool-handoff.md](features/media-upload-tool-handoff.md) | `media_upload` 会话工具的承接卡片：工具创建的上传会话经 `/_dsh/uploader/pending` 暴露给页面，新增 `/_dsh/uploader/cancel`；media-upload 新增 client 半在 `shell.overlay` 弹「上传请求」卡片，用户在卡片内选文件、看进度、取消 | 草案 |
| P0 | [douyin-batch-candidates-live-probe.md](features/douyin-batch-candidates-live-probe.md) | 抖音「采集全部」候选筛选不再按缓存的会话状态预筛：只跳过 pending 与无凭证账号，其余进阶段 1 实测 | 草案 |
| P0 | [wx-collect-all-concurrency.md](features/wx-collect-all-concurrency.md) | 视频号「采集全部」对齐抖音的受控并发：单账号采集改为按账号 Map 的控制器，批量阶段 2 改 worker 队列，Config `batchConcurrency` 1..5 缺省 3，启动错峰、批内熔断，`collectAll.status` 增 `runningAccountIds` / `concurrency`，新增 `collect.running` 与稳定码 `risk_paused` | 草案 |
| P0 | [connector-status-and-error-copy.md](features/connector-status-and-error-copy.md) | Workbench 连接器按 HTTP 状态拆分稳定码（`workbench_unauthorized` / `workbench_server_error`），`workbench_tool_unavailable` 命中时刷新一次 `tools/list`；三工作台把连接器新码投影为可读文案；三个 client 的错误码 → 文案映射改为编译期穷尽；`hostAction` 统一为一份带超时与响应校验的实现并上移 kit | 草案 |
| P0 | [agent-face-self-heal.md](features/agent-face-self-heal.md) | Agent 面监督器订阅连接状态，重连耗尽后按退避自愈；新增只读路由 `POST /api/desktop/yootun/agent-status`；设置页「Yootun 接入」区块增加「智能体工具」连接状态一行 | 草案 |
| P0 | [host-lifecycle-budget.md](features/host-lifecycle-budget.md) | 三工作台 Host 的 dispose 等待与浏览器 `close()` 加时间预算（Config 可调），超时告警并释放 profile 锁；小红书发布 promise 纳入任务登记表，Chrome 启动加超时 | 草案 |
| P0 | [xhs-collect-cancel-and-publish-state.md](features/xhs-collect-cancel-and-publish-state.md) | 小红书新增 `collect.cancel`（Host action），取消落 `cancelled` 终态；`accounts.list` 投影 `publishWindowOpen`，账号卡显示「发布窗口打开中」 | 草案 |
| P0 | [activation-gate-and-model-catalog.md](features/activation-gate-and-model-catalog.md) | 激活门禁改三态（未知期间只渲染遮罩，不闪现卡片）；激活失败原因区分网络不可用与密钥无效；激活成功时把网关实时模型目录写入 `llm-pi-ai` provider；目录请求协议与实际承载协议对齐 | 草案 |
| P1 | [workbench-host-kit.md](features/workbench-host-kit.md) | 新建 Host 侧共享库 `@yootun/dsh-workbench-host-kit`（路由信任判定与分发、JSON 体读取、任务登记表、profile 锁、状态文件原子写与按 root 的写队列、系统 Chrome 探测与浏览器关闭 / 启动超时）；三插件删除本地副本改为消费；账号锁与批次序号随插件实例创建，门禁的模块级变量移入闭包；补齐小红书缺失的写队列（修复并发丢更新） | 草案 |
| P1 | [client-workbench-hooks.md](features/client-workbench-hooks.md) | 抖音、视频号的 `WorkbenchPage` 把登录、单账号采集、批量采集、作品查询四条数据流拆为不依赖 React 的 machine（小红书已是该形态，不动），两份同构核心上移为纯 client 包 `@yootun/dsh-client-workbench-machines`；语言标签改取 locale 服务；`attemptId` 归位 | 草案 |
| P1 | [douyin-tabs-regroup.md](features/douyin-tabs-regroup.md) | 抖音 7 个顶级 Tab 重组为 4 组 + 组内二级控制（默认进入「账号作品」），保留 keep-alive；作品与榜单表格增加显式「查看详情」入口 | 草案 |
| P1 | [ui-accessibility-and-visual-cleanup.md](features/ui-accessibility-and-visual-cleanup.md) | 字重 ≤500（38 条）、字号 ≥12px（44 处）、容器查询替换视口媒体查询、`title=` 改 Tooltip 或就近文本（28 处，置灰原因经 kit 新增的 `ReasonButton`）、表格行打开详情统一为双击、门禁背景对辅助技术隐藏（不引入 `inert`）、规范标注助手 Dock 暂缓 | 草案 |
| P1 | [collect-probe-reuse.md](features/collect-probe-reuse.md) | 采集前的会话探测结果带有效期在单次采集内复用，每账号每次采集少一次 Chrome 冷启动与一次会话状态上报（视频号单账号与「采集全部」、抖音「采集全部」） | 草案 |
| P1 | [mount-restore-and-login-alignment.md](features/mount-restore-and-login-alignment.md) | 小红书补齐挂载恢复（按账号查询运行中的采集）；三工作台登录终态记录统一为保留 30 分钟；删除视频号无页面入口且成功分支缺远端建号的 `account.refreshLoginQr`（页面行为不变）；抖音、视频号的采集中断由 toast 改为带「重新采集」/「重新采集全部」的横幅 | 草案 |
| P1 | [upload-experience-fixes.md](features/upload-experience-fixes.md) | 上传结果保留由 60 秒延长到 10 分钟、`UNAUTHORIZED` 映射为激活密钥问题、启动时清理已退出进程遗留的暂存目录、`isForbiddenPublicHost` 改按地址块判断（补齐 mapped / NAT64 / 6to4 / localhost 变体）、上传传输函数上移 kit 去重 | 草案 |
| P1 | [write-quota-and-audit-attribution.md](features/write-quota-and-audit-attribution.md) | tools 审计行附加调用方身份（key、租户、主体）。写操作配额与多租户幂等收据隔离本期不做：配额随网关迁移决策，设计输入写在附录；收据隔离在接入第二个租户前必须单独建单 | 草案 |
| P2 | [douyin-report-remove-pdf.md](features/douyin-report-remove-pdf.md) | 抖音 AI 报表去掉「导出 PDF」：它依赖的桌面桥从未实现，点击只能得到「不支持」；HTML 导出不变 | 待实施（进入客户端开发前需用户确认） |
| P2 | [report-kernel-extraction.md](features/report-kernel-extraction.md) | 抖音 AI 报表的服务端机制（周期、状态机与租约、投递与对账、定时补建、重建与版本、模型调用与重试、输出校验、提示词加载）抽成平台无关内核，抖音改为「平台适配 + 调用内核」；对外行为逐字节不变 | 开发完成（自动验收通过），待合入 `dev` |
| P2 | [wx-report-server.md](features/wx-report-server.md) | 视频号新增与抖音同构的 AI 日报与周报：新表、独立提示词、专属队列 `tools.wx_channels_operation` 与专属 worker、8 个工具名（旧域 3 个源能力、Workbench 3 个、Agent 2 个只读）；关注者画像不进报表 | 实施中 |
| P2 | [wx-report-client.md](features/wx-report-client.md) | 报表页抽成纯 client 包 `@yootun/dsh-client-report`，抖音改为消费；视频号新增第三个 Tab「AI 报表」与 3 个 Host action；两个只读报表工具进普通会话 | 待实施（进入客户端开发前需用户确认） |

## 推进顺序

P0 分三条线，互不阻塞：

- **采集线**：[douyin-batch-candidates-live-probe.md](features/douyin-batch-candidates-live-probe.md)（只改抖音 runner，小）→ [wx-collect-all-concurrency.md](features/wx-collect-all-concurrency.md)（先单账号 Map，再 worker 队列）。两单都以抖音现有并发实现为参照，先合小单可以让视频号单直接对照最新代码。
- **连接与错误线**：[connector-status-and-error-copy.md](features/connector-status-and-error-copy.md) 先合（新稳定码、`hostAction` 上移 kit 是后续 client 改动的依赖）→ [agent-face-self-heal.md](features/agent-face-self-heal.md)、[activation-gate-and-model-catalog.md](features/activation-gate-and-model-catalog.md)。
- **生命周期与小红书线**：[host-lifecycle-budget.md](features/host-lifecycle-budget.md)、[xhs-collect-cancel-and-publish-state.md](features/xhs-collect-cancel-and-publish-state.md)、[media-upload-tool-handoff.md](features/media-upload-tool-handoff.md) 可并行；小红书单与生命周期单都改 `handlers.ts`，后合入者解决冲突（预期冲突：`collect.start` 的 catch 分支与 `publish.start` 的 promise 登记）。

P1 内部的先后：先合 [workbench-host-kit.md](features/workbench-host-kit.md)（后续 client 改动不依赖它，但 Host 侧改动越晚越容易与别的单冲突）与 [collect-probe-reuse.md](features/collect-probe-reuse.md)、[mount-restore-and-login-alignment.md](features/mount-restore-and-login-alignment.md)、[upload-experience-fixes.md](features/upload-experience-fixes.md)（分别承接 P0 的并发、取消、承接卡片单）。client 侧三单都改抖音的 `WorkbenchPage.tsx`，按 [client-workbench-hooks.md](features/client-workbench-hooks.md) → [douyin-tabs-regroup.md](features/douyin-tabs-regroup.md) → [ui-accessibility-and-visual-cleanup.md](features/ui-accessibility-and-visual-cleanup.md) 的顺序串行，前一张合入后再开后一张；其中 `localeTagOf`、`attemptId` 的收口不依赖顺序，可随第一张合入。审计归因单只动 tools，与其余各单无依赖。

分支规则见 [cross-repo-sync.md §5.1](../cross-repo-sync.md#51-分支)：实施单提交在 `main`，代码走 `feat/<slug>` 特性分支，验收通过后合入。P0 与 P1 一起推进，不设发版观察期（2026-11-26 确认）；视频号并发的风控信号在发版后照常观察，`batchConcurrency: 1` 可即时回退。

P2 四张单的先后：[douyin-report-remove-pdf.md](features/douyin-report-remove-pdf.md) 不依赖其他单，可以先行；先完成 [report-kernel-extraction.md](features/report-kernel-extraction.md)（抖音切换到内核并通过一致性对比），再开 [wx-report-server.md](features/wx-report-server.md)（以第二个平台适配接入内核，含专属队列的部署；其特性分支从内核单的分支切出，两单一并合入 `dev`）；[wx-report-client.md](features/wx-report-client.md) 在 P0、P1 与去 PDF 单合入 `main`、且服务端已部署测试环境之后开始，动代码前先按该单 0.3 核对合入后的客户端代码，在最新代码上开发。服务端两张单只动 tools 与 docker-helm，与 P0、P1 的客户端各单没有文件交集，可以并行。

## 对现有功能的影响

20 张单里，**既有行为的变化只发生在下面第一张表列出的地方**；其余改动是内部重构或纯新增。每张单第 1 节的「不做」与第 5 节的验收清单是逐单的依据。

用户可见的行为变化（都是有意为之）：

| 单 | 变化 | 谁会感受到 | 回退方式 |
|---|---|---|---|
| [视频号「采集全部」并发](features/wx-collect-all-concurrency.md) | 阶段 2 由逐个串行改为最多 3 个账号同时采集；出现疑似风控时暂停批次 | 用「采集全部」的视频号用户 | Config `batchConcurrency: 1` 即恢复逐个采集 |
| [抖音候选实测](features/douyin-batch-candidates-live-probe.md) | 缓存为「需登录」的账号不再直接跳过，先实测一次；实测通过就会被采集 | 有过期账号的抖音用户 | 无需回退（只多一次探测） |
| [连接器错误码](features/connector-status-and-error-copy.md) | 密钥失效时提示「密钥无权限或已失效」而不是「网络错误」；服务端新增工具后无需重启 | 所有人 | 无需回退 |
| [小红书采集取消](features/xhs-collect-cancel-and-publish-state.md) | 采集运行中按钮由禁用变为「取消采集」；账号卡显示「发布窗口打开中」 | 小红书用户 | 无需回退 |
| [抖音导航重组](features/douyin-tabs-regroup.md) | 7 个 Tab 变为 4 组 + 二级，默认进入「账号作品」；表格增加「查看详情」按钮 | 抖音用户 | 纯界面，按单回退 |
| [中断提示](features/mount-restore-and-login-alignment.md) | 抖音、视频号「上次采集被中断」由 toast 改为带「重新采集」按钮的横幅；小红书重载页面后能找回进行中的采集；视频号删除一个页面从未调用的本地 action | 三工作台用户 | 纯界面与死代码清理 |
| [激活门禁](features/activation-gate-and-model-catalog.md) | 已激活用户启动不再闪现卡片；断网时提示「无法连接」而不是「Key 验证失败」；重新激活时模型列表并入网关目录（只增不删） | 重新激活的用户 | 无需回退 |
| [界面样式与行手势](features/ui-accessibility-and-visual-cleanup.md) | 字重、字号、置灰按钮的原因改为可聚焦的提示；表格行打开详情统一为双击（小红书爆款看板、抖音拆解历史原为单击） | 所有人 | 纯界面，按单回退 |
| [上传](features/upload-experience-fixes.md) | 上传结果可查询的时间由 60 秒延长到 10 分钟；密钥问题的提示更准确 | 上传用户 | 无需回退 |
| [会话工具承接卡片](features/media-upload-tool-handoff.md) | 模型调用 `media_upload` 后弹出卡片（原先是死路） | 用上传工具的用户 | 纯新增 |
| [抖音去 PDF](features/douyin-report-remove-pdf.md) | 抖音 AI 报表详情少一个「导出 PDF」按钮（该按钮原本只能提示不支持） | 用抖音报表的用户 | 纯界面，按单回退 |
| [视频号 AI 报表](features/wx-report-client.md) | 视频号工作台多一个「AI 报表」Tab；普通会话可以查询视频号报表 | 用视频号工作台的用户 | 纯新增 |

既有流程不变、并有测试守住的部分：

- 单账号采集的步骤与顺序、入库口径、幂等键、`runs.json` 终态语义：三工作台都不改；
- MCP 工具契约：P0、P1 的 16 张单没有任何一张新增、修改或删除 tools 的工具，tools 仓唯一的改动是审计日志多几个身份字段；P2 新增 8 个工具名与一张表（见 [wx-report-server.md](features/wx-report-server.md)），既有工具的入参与出参不变；
- 既有本地路由与 action 的入参与出参不变，新增的都是追加（`collect.running`、`collect.cancel`、`uploader/pending`、`uploader/cancel`、`agent-status`；`collect.status` 的可选入参；P2 的 `report.list`、`report.get`、`report.regenerate`）；
- 小红书爆款仿写页的上传流程不改（承接卡片只响应会话工具发起的上传）；
- 重构类单（Host 共享库、页面状态机、上传传输函数、报表服务端内核、报表页上移）以「既有用例断言零改动」为合入条件；行为变化类单逐条列出要改的断言。

审查中发现并已在单内修正的风险：

| 风险 | 对策 |
|---|---|
| 统一 `hostAction` 的 30 秒超时会截断「返回前同步等待浏览器探测」的 action（探测预算 45 秒），把真实原因变成「无法连接本地服务」；抖音现有实现已有此隐患 | 同步探测类 action 单独给 120 秒（连接器单 2.5） |
| 激活门禁的「未知态」在凭证探测挂起时是一张没有入口的遮罩 | 超过 5 秒回落为卡片（激活单 2.2） |
| 网关模型目录缺少某个内置模型时，整表覆盖会把用户正在用的默认模型移出列表 | 目录写入取并集，只增不删（激活单 2.3） |
| 视频号并发的平台风控 | 启动错峰、批内熔断、发版后观察一周（并发单附录 C.4）；`batchConcurrency: 1` 可即时回退 |
| 抖音 7 个 Tab 是与旧插件逐项对齐的冻结基线 | 导航重组在 15 册 §11 登记为有意偏离 |
| 共享报表包的样式表如果不随消费它的插件进入 bundle 的样式安装元数据，样式会静默不生效（kit 的页面壳出过这个问题） | 两个插件的样式装载声明与产物校验清单都登记该样式表（[wx-report-client.md](features/wx-report-client.md) 2.4） |
| 部署流水线用全量服务列表的精确比较串决定部署分支，漏改新 worker 会让它不被部署 | 部署流水线与校验脚本在同一提交内同步（[wx-report-server.md](features/wx-report-server.md) 第 3 节） |

## 文档漂移

随相关实施单顺带修正，不单独立单：`dsh-client-ui-access/src/route.ts` 与生成常量的头注释（llm-deepseek / Anthropic 表述，见激活单）；抖音 `package.json` 与 `src/index.ts` 的 action 计数 56 → 57（见候选筛选单）；[plugin-ui-ux-standard.md §六](../plugin-ui-ux-standard.md) 标注助手 Dock 与回执 / 撤销暂缓（见 P1 可达性单）；多租户幂等收据隔离的触发条件写在 [write-quota-and-audit-attribution.md](features/write-quota-and-audit-attribution.md) 附录 B；[workbench-host-kit.md](features/workbench-host-kit.md) 顺带把 `yootun/scripts/verify-plugin-runtime-bundle.mjs` 的包名清单补上抖音工作台与 media-upload。

## 验收分工

每张单第 5 节分两张清单：5.1 开发侧自动验收（测试、构建、静态核对），5.2 真机验收由用户执行，每项写明步骤与预期。本机联调与真机验收的数据库以 `tools.dofe.ai` 的 `.env` 指向的数据库为准（[cross-repo-sync.md 第五节](../cross-repo-sync.md#五顺序与门禁)）。各单 5.3 预留本地联调记录，合入前回填。
