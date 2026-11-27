# ui-三工作台可达性与视觉基线清理 实施单

状态：已合入 `main`（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

对照 [1110/05-ui-ux.md](../../1110/05-ui-ux.md) 的视觉基线与 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md)，三工作台与 kit 的样式与交互有五类偏离。数量来自 2026-11-26 对源文件的静态统计。

| # | 偏离 | 规则出处 | 抖音 | 视频号 | 小红书 | kit |
|---|---|---|---|---|---|---|
| 1 | 字重 600 / 650 / 700 | 自写 CSS 字重 ≤500，强调用字号或墨色（05 册 §二、官方 `dsh-client-ui-ux` 视觉基础） | 33 条 | 0 | 2 条 | 3 条 |
| 2 | 字号 10px / 11px | 提示 12px 为下限，行与详情基准 13px（05 册 §二、规范 §三） | 31 处（11px 26、10px 5） | 1 处 | 12 处（11px 10、10px 2） | 0 |
| 3 | 视口媒体查询 | 响应式以面板容器宽度计算，不用浏览器窗口宽度（规范 §2.3） | 1 处（`.bdSteps`，`@media (max-width: 880px)`） | 0 | 0 | 0 |
| 4 | HTML `title` 属性当提示 | 悬停解释用 Tooltip；`title` 只用于被省略的完整文本（规范 §4.6、§三） | 22 处 | 4 处 | 2 处 | — |
| 5 | 表格行打开详情的鼠标手势不统一 | 同一动作在三个工作台用同一种手势 | 1 处（拆解历史行 `BreakdownPage.tsx` 为单击） | 0 | 1 处（爆款看板行 `HotboardPage.tsx` 为单击） | — |

第 4 项要分两类看。14 处在省略号文本上（账号名、作品标题、图表标签），规范允许保留；另外 14 处是在用 `title` 解释一个控件：置灰按钮的原因（5 处：小红书「采集全部」、视频号与抖音「采集全部」被锁时、抖音「拆解」、抖音「导出」无数据时）、图标按钮的名称（抖音基因库「移除所选」）、作品标题按钮与链接上的完整标题（6 处）、`<td>` 上的表头解释、以及抖音素材账号表 `<tr>` 上挂的解析失败原因。这些内容键盘与触屏都读不到，置灰按钮尤其如此——原生 `disabled` 的按钮不派发鼠标事件，`title` 在多数浏览器里不会出现。

另有两项同属可达性：

- 激活门禁是 `role="dialog" aria-modal="true"` 的全屏卡片，有焦点陷阱与滚动锁，但背景 `#root` 没有对辅助技术隐藏。门禁有意不申请 `root.inert`：官方 onboarding loading 层会在启动瞬间捕获并恢复该属性，与门禁的 fail-closed 锁竞态，升级启动后授权页被重新锁死（05 册 §3.3 的修订记录）。
- 规范第六节（助手 Dock）与第九节评审清单里的「助手 Dock」「助手三态」「写操作回执与撤销」三项，在 Dock 暂缓期间对所有插件都不成立，评审时没有依据可循。

### 0.2 目标

字重、字号、响应式、提示方式四项回到规范；置灰原因与失败原因对键盘和触屏可达；三工作台表格行打开详情统一为双击；门禁期间背景对辅助技术隐藏且不引入 `inert`；规范写明 Dock 相关条款的适用状态。

## 1. 范围

做：

- 38 条字重规则改为 500，依赖字重表达「选中 / 激活」的 9 条改用墨色与底色 token；
- 44 处 12px 以下的字号提到 12px；
- 抖音 `.bdSteps` 的视口媒体查询改为容器查询；
- 14 处「解释控件」的 `title` 改为 Tooltip 或就近可见文本；14 处省略号文本的 `title` 改为官方 `Tooltip` 的 `onlyWhenClipped`；
- kit 新增 `ReasonButton`（带原因的置灰按钮），五处置灰入口改用它；
- 表格行打开详情的鼠标手势统一为双击：小红书爆款看板行、抖音拆解历史行由单击改为双击；三插件行级双击处理一律忽略落在按钮、链接等交互元素上的事件；
- 门禁显示期间给 `#root` 加 `aria-hidden="true"`，授权或卸载时移除；
- `plugin-ui-ux-standard.md` §六与第九节标注 Dock 暂缓。

不做：

- 不改布局、间距、颜色 token 与组件结构；
- 不改文案内容（只改承载方式）；
- 不引入 `root.inert`；
- 不改行级键盘路径（抖音、视频号行 `tabIndex=0` + Enter 保持；小红书以行内「查看详情」按钮为键盘路径）；
- 不改 05 册管辖的品牌位与激活卡片的 eyebrow 字号（`dsh-client-ui-brand`、`dsh-client-ui-access` 各 1 处 11px）；
- 不动助手 Dock、回执与撤销功能；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 视觉基线取值

| 项 | 取值 | 说明 |
|---|---|---|
| 字重 | 全部 ≤500 | 表头、卡片标题、KPI 数值、选中态一律 500 |
| 强调方式 | 字号（KPI 数值 20–24px、页面标题随 typography role）或墨色（`--dsw-alias-label-primary`） | 不用字重 |
| 选中 / 激活态 | 底色 `--dsw-alias-bg-layer-2`（或既有选中底色）+ 墨色 `--dsw-alias-label-primary`；未选中墨色 `--dsw-alias-label-secondary` | 明暗两套主题下都可区分 |
| 字号下限 | 12px | 坐标轴文字、徽标、封面时长角标同为 12px |
| 响应式 | `@container yootun-kit-page (max-width: 879px)` | 与 kit 页面壳的容器名一致 |

### 2.2 提示承载方式

| 场景 | 承载 |
|---|---|
| 置灰按钮的原因 | `ReasonButton`：官方 `Button` 包在官方 `Tooltip` 内，按钮保持可聚焦、`aria-disabled="true"`、`aria-describedby` 指向隐藏的原因文本，点击不触发 |
| 省略号文本的完整内容 | `<Tooltip label={全文} onlyWhenClipped portal>` 包住文本元素；原生 `title` 移除 |
| `<td>` 上的表头解释（抖音排期序号列） | 表头 `<th>` 加 `aria-describedby`，解释文本作为表头旁的可见提示图标 + Tooltip |
| `<tr>` 上的失败原因（抖音素材账号表） | 新增一列「状态」，失败时显示 `<Tag tone='danger'>解析失败</Tag>`，Tag 包 Tooltip 显示原因 |

### 2.3 表格行打开详情的统一手势

- 鼠标：双击行打开详情。小红书爆款看板行（`HotboardPage.tsx` `BoardRow`）与抖音拆解历史行（`BreakdownPage.tsx` `BreakdownHistoryRowView`）由单击改为双击；抖音、视频号其余表格已是双击，不变；
- 键盘：不变。抖音、视频号行 `tabIndex=0` + Enter；小红书行不可聚焦，行内「查看详情」按钮是键盘路径；
- 行级双击处理统一带一条守卫：事件目标落在 `button` / `a` / `input` / `select` / `textarea` 内时不处理，快速双击行内按钮不会连带打开详情；
- 这是有意的交互变化：原来在这两张表里单击就能打开详情，改后要双击，或点行内「查看详情」按钮（拆解历史表的按钮随 [douyin-tabs-regroup.md](douyin-tabs-regroup.md) 落地）。

### 2.4 门禁背景

门禁组件在未授权期间给 `document.getElementById('root')` 设置 `aria-hidden="true"`；授权、组件卸载与 `mountGate` 的 disposer 三处都负责移除。不读写 `inert`。

### 2.5 词典新增

| 插件 | 键 | zh | en |
|---|---|---|---|
| 抖音 | `mat.account.resolveFailed` | 解析失败 | Resolution failed |
| 抖音 | `schedule.indexHint` | 行序号，用于对照导出文件 | Row number, for matching exported files |
| 抖音、视频号 | `row.openDetailHint`（行 `aria-label` 后缀） | 双击或按 Enter 查看详情 | Double-click or press Enter to view details |

既有 `accounts.collectAllSoon`、`account.collectAllBlocked`、`mat.action.breakdownDisabled` 的文案不变，改为经 `ReasonButton` 显示。

### 2.6 kit 新增 `ReasonButton`

`@yootun/dsh-client-ui-kit`：`ReasonButton`，props 为官方 `Button` 的 props 加 `reason?: string`。`reason` 存在且 `disabled` 为真时按 2.2 渲染；否则原样渲染官方 `Button`。五个消费者：小红书账号页「采集全部」、视频号与抖音账号栏「采集全部」、抖音素材页「拆解」、抖音作品页「导出」。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-client-ui-kit/src/{reason-button.tsx,row-gesture.ts,index.ts}`、`tests/kit.test.tsx` | `ReasonButton`；行级双击守卫 `isOnInteractiveTarget` | 是 | 第三个消费者，按规范上移 |
| yootun-agent | kit `src/{kpi-card,plugin-header,assistant-dock}.module.css` | 3 条字重 | 是 | 表 1 |
| yootun-agent | 抖音 `src/client/workbench.module.css` | 33 条字重、31 处字号、1 处媒体查询 | 是 | 表 1 |
| yootun-agent | 视频号 `src/client/workbench.module.css` | 1 处字号 | 是 | 表 1 |
| yootun-agent | 小红书 `src/client/workbench.module.css` | 2 条字重、12 处字号 | 是 | 表 1 |
| yootun-agent | 三插件 `src/client/*.tsx`（涉及 14 个文件） | `title` 改 Tooltip / 就近文本；`ReasonButton` 替换；小红书看板行与抖音拆解历史行改双击，三插件现有的行级双击套用守卫 | 是 | 提示可达与手势统一 |
| yootun-agent | 抖音 `src/client/{MaterialPage,SchedulePage}.tsx` 及样式 | 素材账号表状态列；排期表头提示 | 是 | 行与单元格上的 `title` |
| yootun-agent | 三插件 `src/client/locales.ts` | 2.5 的新词条 | 是 | 文案 locale-owned |
| yootun-agent | `yootun/packages/dsh-client-ui-access/src/client/gate.tsx`、`tests/access.test.ts` | 背景 `aria-hidden` | 是 | 门禁可达性 |
| yootun-agent | `yootun/docs/plugin-ui-ux-standard.md` §六、§8.4、§九 | Dock 暂缓标注 | 是 | 评审依据 |
| yootun-agent | `yootun/docs/1110/05-ui-ux.md` §3.3 | 门禁背景对辅助技术隐藏的补充条款 | 是 | 门禁是 05 册管辖的面 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + UI 规范 + 05 册 §3.3 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/ui-accessibility-cleanup` | 已填（见 5.3 与提交记录） |
| yootun-agent 合入 `main` | 2026-11-27 | `main` | 随 P1 八张批次一并合入（含验收审查修复），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] 三插件与 kit、access `pnpm --filter <pkg> test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] 静态核对全部为 0：
  - `grep -nE "font-weight:\s*(6|7|8|9)[0-9][0-9]"` 于三插件与 kit 的 `*.module.css`；
  - `grep -nE "font-size:\s*(9|10|11)(\.[0-9]+)?px"` 同上；
  - `grep -n "@media (max-width\|@media (min-width" ` 于三插件 `workbench.module.css`；
  - 用 TypeScript AST 统计 DOM 元素与 `Button` 上的 `title` 属性（省略号文本已改为 Tooltip）；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| A1 | 三工作台逐页浏览，明暗主题各一遍 | 无过粗标题；选中项与未选中项靠底色与墨色可区分；没有文字被截断或挤压 |
| A2 | 抖音排期表、素材看板、基因库卡片墙：缩窄窗口到 880px 以下再放宽 | 爆款拆解步骤条按容器宽度变 4 列；侧栏展开收起时随容器变化而不是随窗口 |
| A3 | 抖音图表卡（总览、单账号分析、报表） | 坐标轴 12px 后刻度标签不重叠；过密时按既有规则抽稀 |
| A4 | 封面上的时长角标、缩略图角标（基因库、小红书看板） | 12px 后不溢出封面 |
| A5 | 键盘：Tab 到置灰的「采集全部」「拆解」并停留 | 焦点可落在按钮上，气泡显示原因；按 Enter 无动作 |
| A6 | 鼠标悬停置灰按钮 | 气泡显示原因 |
| A7 | 触屏或窄容器下点置灰按钮旁边的提示 | 原因可读（气泡钉住，点外部关闭） |
| A8 | 作品表长标题：鼠标悬停、键盘聚焦 | 被省略时出现完整标题气泡，未省略时不出现 |
| A9 | 小红书爆款看板与抖音拆解历史表：鼠标单击行；双击行的文字区域；快速双击行内「排除」或其他按钮；Tab 到「查看详情」按 Enter | 单击不打开详情；双击文字区域打开；双击按钮只触发按钮自己的动作，不打开详情；Enter 打开 |
| A10 | 未激活状态启动应用，用读屏软件（VoiceOver / NVDA）浏览 | 只读到激活卡片内容，读不到背景的应用界面；激活后背景恢复可读，页面可点击 |
| A11 | 英文界面重复 A1、A5、A8 | 气泡与标签文案为英文，不溢出 |

### 5.3 本地联调记录

自动验收通过（2026-11-27）。静态清零实测：三插件与 kit 的 `*.module.css` 中字重 >500 为 0、字号 <12px 为 0、三插件 workbench.module.css 视口媒体查询为 0；三插件 DOM/Button 的 `title` 属性为 0；verify-empty-catch / verify-no-unknown-casts / verify-export-jsdoc / verify-client-ui-i18n / lint 全过。红绿自证：门禁删 `setAttribute('aria-hidden')` → G1/G2 2 红→恢复绿；ReasonButton 删 aria-disabled/onClick 抑制 → R1 1 红→恢复绿。

与实施单统计表的差异：title 实测 26 处（表载 28）——抖音 −3 系阶段 5/6 重排合并了挂 title 的元素；小红书 +1 为 `publishWindowHint` 状态行（A4 未单列的解释控件类），全部清零。字重 38/字号 44/媒体查询 1 与表一致；字重特殊 9 条中 6 条原已带底色/墨色 token 仅降字重，`.bdRadioName` 补墨色，`.scheduleTable th .headerSub` 语义即次级未加墨。

偏离：`row.openDetailHint` 未单列成键——抖音 `row.detailAria` 值并入完整提示（{title}，双击或按 Enter 查看详情），与视频号既有键同构；`mat.account.resolveFailed` 未新增——复用既有 `mat.seed.resolveFailed`，状态列 Tag 的 Tooltip 缺省回退该键；「采集全部」被锁复用既有 `account.collectAllBlocked` 文案（未造新文案）；ReasonButton 气泡 hover/focus 触发，A7 触屏钉住所需的 Tooltip `openOnClick` 未在 A6 规格内，未启用（见下）。

过程修复：ReasonButton 的 `useId` 曾置于早退分支之后，disabled 翻转改变 hook 数导致 React 卸载子树——抖音批量采集反馈既有用例抓出，已改为无条件前置。A3/A4 截图与明暗主题目检待真机（5.2 A1–A11），其中触屏气泡钉住若需 `openOnClick` 补一行即可。

## 附录 A：逐文件规格

### A1 字重（38 条）

- 直接改值的 29 条：`font-weight` 改 `500`；
- 依赖字重表达选中 / 激活的 9 条（抖音 `.rtTabActive`、`.adoptionChipActive`、`.scheduleAccountChip[aria-pressed='true']`、`.bdRadio[aria-checked='true'] .bdStepName`、`.bdStep[data-state='active'] .bdStepName`、`.geneChip`、`.geneFacetMore`、`.barTop1/.barTop2/.barTop3 .barRank`、`.scheduleTable th .headerSub`）：字重 500，同时按 2.1 补底色或墨色；每条在明暗主题下对照改动前后截图；
- kit：`kpi-card.module.css` `.value`、`plugin-header.module.css` `.title`、`assistant-dock.module.css` `.title`（最后一条是纯样式值，Dock 功能仍暂缓）。

### A2 字号（44 处）

- 11px → 12px：38 处；
- 10px → 12px：6 处（抖音 `.rtValleyBadgeText`、`.axisText`、`.aiArrow`、`.geneCoverDuration`；视频号 `.axisText`；小红书 `.progressText`、`.hbThumbBadge` 中实际为 10px 的两处）；
- 封面角标类（`.geneCoverDuration`、`.hbThumbBadge`）与 `.aiArrow`（箭头字符）改后核对行高与内边距，必要时同步调整内边距保持原占位。

### A3 媒体查询

`workbench.module.css`（抖音）第 2833 行附近：`@media (max-width: 880px)` → `@container yootun-kit-page (max-width: 879px)`。`.bdSteps` 所在页面由 kit `PluginPageShell` 承载，容器上下文已存在。

### A4 `title` 清单（28 处）

| 类别 | 数量 | 位置 | 处理 |
|---|---|---|---|
| 置灰原因 | 5 | 小红书 `AccountsPage.tsx`「采集全部」；视频号 `AccountSidebar.tsx`、抖音 `AccountSidebar.tsx`「采集全部」；抖音 `MaterialPage.tsx`「拆解」；抖音 `WorksPanel.tsx`「导出」 | `ReasonButton` |
| 图标按钮名称 | 1 | 抖音 `GenePage.tsx`「移除所选」 | 加 `aria-label`（规范 §4.1 图标按钮必须有的可访问名称）并包 `Tooltip` |
| 完整标题按钮 | 3 | 抖音 `AnalysisPage.tsx` ×2、`OverviewPage.tsx` | 按钮加 `aria-label`（完整标题），可见文本被省略时包 `Tooltip onlyWhenClipped`；[douyin-tabs-regroup.md](douyin-tabs-regroup.md) 落地后另有两张表增加「查看详情」按钮 |
| 链接 | 3 | 抖音 `GenePage.tsx`、`MaterialPage.tsx` ×2 | 文本被省略的包 `Tooltip onlyWhenClipped`；「打开视频」链接把 `title` 换成 `aria-label` |
| 单元格解释 | 1 | 抖音 `SchedulePage.tsx` 序号列 `<td>` | 见 2.2 |
| 行失败原因 | 1 | 抖音 `MaterialPage.tsx` 账号表 `<tr>` | 见 2.2，新增状态列 |
| 省略号文本 | 14 | 抖音 10 处（`<span>` 9、`<p>` 1）、视频号 3 处、小红书 1 处 | `Tooltip onlyWhenClipped portal`，移除 `title` |

### A5 行级双击（小红书 `HotboardPage.tsx`、抖音 `BreakdownPage.tsx`）

- `BoardRow`：`onClick` → `onDoubleClick={openIfOnContent}`；删除两处为阻止单击冒泡而加的 `event.stopPropagation()`；`css.hbRow` 的 `cursor: pointer` 保留；
- `BreakdownHistoryRowView`：`onClick` → `onDoubleClick={openIfOnContent}`；`onKeyDown` 的 Enter / Space 不变；
- `openIfOnContent(event)`：kit 的 `isOnInteractiveTarget(event)` 为真时直接返回，否则调用原有的打开函数；抖音、视频号现有的行级 `onDoubleClick`（作品表、总览账号表与热门作品表、单账号分析热门作品表）一并改为经同一守卫；
- 抖音拆解历史行按钮的 `onClick` 仍与行 Enter 共用同一处理函数。

### A6 kit `reason-button.tsx`

```tsx
export function ReasonButton(props: ButtonProps & { reason?: string | undefined }): ReactNode
```

`disabled && reason` 时：`<Tooltip label={reason} side='bottom' delayMs={500} maxWidth={300} portal>` 包 `<Button disabled={false} aria-disabled='true' aria-describedby={id} onClick={undefined} … />`，其后渲染 `<span id={id} hidden>{reason}</span>`；其余情况直接渲染官方 `Button`。

### A7 `gate.tsx`

- `AccessGate` 内新增 effect：`authorized !== true` 时给 `#root` 设 `aria-hidden='true'`，清理函数与 `authorized === true` 时移除；三态中的「未知」态同样隐藏背景；
- `mountGate` 的 disposer 同样移除该属性（兜底）。

### A8 `plugin-ui-ux-standard.md`

- §六开头加一段：2026-11-26 起助手 Dock、操作回执与撤销暂缓，本节保留为目标设计，落排期前不作为评审项；
- §8.4 与 §九中「助手三态」「写操作回执与撤销」「助手 Dock 的模型状态……」三项加「Dock 落地前不适用」标注。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| S1 | 静态核对：三插件与 kit 的 `*.module.css` 中字重 >500、字号 <12px、视口宽度媒体查询均为 0 |
| S2 | 静态核对：DOM 元素与 `Button` 上的 `title` 属性为 0 |
| R1 | `ReasonButton`：`disabled` 且有 `reason` → 渲染 `aria-disabled="true"`、`aria-describedby` 指向原因文本、点击不触发 `onClick`；无 `reason` → 与官方 `Button` 渲染一致 |
| R2 | `ReasonButton`：聚焦后气泡出现（官方 Tooltip 的键盘聚焦行为），失焦消失 |
| X1 | 行级双击守卫（kit）：目标在 `button` / `a` / `input` 内 → `true`；在普通文本 → `false` |
| X2 | 小红书看板行：单击不打开详情；双击文字区域打开一次；双击「排除」按钮不打开详情 |
| X3 | 抖音拆解历史行：单击不打开；双击与 Enter 各打开一次 |
| X4 | 抖音作品表、视频号作品表：双击行文字区域打开详情（既有行为不变）；双击标题按钮不触发行处理 |
| G1 | 门禁：`configured` 为 `undefined` 与 `false` 时 `#root` 带 `aria-hidden="true"`；为 `true` 时不带 |
| G2 | `mountGate` 的 disposer 调用后 `#root` 不带 `aria-hidden`，且全程未写入 `inert` |
| P1 | 三插件既有 client 用例通过；断言里涉及 `title` 的改为断言 Tooltip 的 `aria-describedby` |
| V1 | 抖音 `.bdSteps`：容器宽度 879px 与 880px 两侧的列数断言（jsdom 不计算容器查询，此条以 5.2 的 A2 真机验收为准，自动化只断言样式表文本不含 `@media (max-width: 880px)`） |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 门禁背景 | `aria-hidden`（不触碰 `inert`，无竞态） | `root.inert`（05 册 §3.3 记录过两次残留故障） |
| 置灰原因 | kit `ReasonButton`（三个消费者） | 就近显示一行灰字说明（占用布局空间） |
| 省略号文本 | 官方 `Tooltip onlyWhenClipped` | 保留原生 `title`（触屏与键盘不可达） |
| 表格行打开详情的鼠标手势 | 双击，三工作台统一 | 保持各表现状（单击与双击并存） |
| 字号 | 一律提到 12px | 坐标轴保留 10px（违反下限） |
