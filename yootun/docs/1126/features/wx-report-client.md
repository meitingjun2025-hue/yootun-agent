# wx-report-视频号 AI 报表工作台与智能体工具 实施单

状态：开发完成（三步均已验收并本地提交，2026-11-27），待合入 ｜ 创建：2026-11-26 ｜ 最近修订：2026-11-27 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台的报表页（`yootun/plugins/dsh-douyin-workbench/src/client/ReportPage.tsx`，820 行）是一个自包含组件：列表与详情双态、详情轮询、重新生成确认、HTML 导出、尚未移除的 PDF 导出、版本切换；加上同目录的读取器（`schema.ts`）、组合趋势图（`charts.tsx` 的 `ReportComboChart`）、格式化函数（`format.ts`）与 128 条报表词条（`locales.ts` 的中文词典，其中 `report.error.*` 18 条）。它直接 import 本插件的 `hostAction`，样式用插件的 `workbench.module.css`：页面引用 46 个类，25 个为报表专属，21 个与插件其他页面共用；组合趋势图另用 11 个。页面目前只用了 kit 的 `DataCard` 与 `DataState`，KPI 行、趋势图、作品卡、AI 洞察三列都是插件内自写的样式类，并用结构选择器 `.reportSection h2` 覆盖了 kit 卡片的标题样式。界面与 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md) 的差距见 2.8。

视频号工作台目前有两个 Tab（作品数据、账号总览），没有报表。

1126 的 P0、P1 十六张单已全部合入 `main`（P0 于 2026-11-26，P1 于 2026-11-27）。与本单相关的现状：

| 项 | `main` 上的实际形态 | 对本单的意义 |
|---|---|---|
| 页面组合层 | 两个插件的页面 props 都是 `{ t, locale }`，语言标签取 locale 快照的当前语言；数据流在 `flows.ts` 与共享 machine，`WorkbenchPage.tsx` 只做组合 | 报表 Tab 作为组合层的一个渲染分支接入，不在页面里写数据流 |
| `hostAction` | 两个插件的 `api.ts` 各自用 kit 的 `createHostAction(路径, { actionTimeouts })` 构造，缺省 30 秒；`host-action.ts` 走 kit 的叶子路径 import | 共享包不 import 任何插件的请求模块，由插件把请求函数注入 |
| 错误码映射 | 两个插件都是 `REASON_KEYS: Record<StableErrorCode, 词典键>` 的穷尽记录，缺键即编译失败；报表码的词条键是 `report.error.*` | 新增的码必须在两个插件的映射表与词典里补齐 |
| 可达性基线 | kit 新增 `ReasonButton`（官方 `Button` 的 props 加 `reason`）与行手势守卫 `isOnInteractiveTarget`；字重与字号已清零 | 上移到共享包的组件按这组基线核对（结论见 5.3） |
| 抖音导航 | 顶级导航四组加二级分段，「AI 报表」是「报表」组的唯一页面 | 本单不改导航 |
| 视频号 action | 清单 22 项 | 本单在其上追加 3 项 |

### 0.2 目标

把报表页抽成纯 client 包 `@yootun/dsh-client-report`，并在包内按 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md) 整改界面；抖音改为消费，视频号新增第三个 Tab「AI 报表」，两个平台用同一份整改后的报表页；两个只读的报表工具进入普通会话。

前置单：[wx-report-server.md](wx-report-server.md)（工具契约与部署，已合入 `dev`）、[douyin-report-remove-pdf.md](douyin-report-remove-pdf.md)（上移前先去掉 PDF）。

### 0.3 基线核对

本单草建于 2026-11-26，当时 1126 的 P0、P1 各单尚未合入，对客户端形态的描述来自各单的条款。P1 合入后，于 2026-11-27 在 `main` 上做了一次基线核对，九个核对项的逐项结论记在 5.3；本文已按核对结果修订，0.1 与第 2 节描述的都是 `main` 上的现有代码。

核对发现的原稿缺口，均已修订进本文。第 1 项是修订过程中引入又撤回的一次失误，一并记录：

| # | 原稿写法 | 核对结果 | 修订位置 |
|---|---|---|---|
| 1 | 报表页用 `locale: 'zh' \| 'en'` 选词典与格式 | 已撤回的一次修订失误：第一版修订把它改成了语言标签，理由是「插件传给页面的是语言标签」。复核 `format.ts` 的 `localeTagOf` 后确认，它把 locale 快照的 active id 归一成 `'zh'` 或 `'en'`，两个插件传给页面的就是这个值，原稿写法与现状一致 | 2.1 保持 `locale: 'zh' \| 'en'` |
| 2 | 共享包自己解析报表错误码 | 连接失败码与路由拒绝码不在报表码集合内，共享包无从解析；抖音现状用 `domainErrorText('report', code, t)` | 2.1 增加必填的 `errorText` 注入，错误文案全部经它解析 |
| 3 | 错误码文案常量的键是 `reason.REPORT_*` | 抖音词典里 13 个 `REPORT_*` 码的键是 `report.error.REPORT_*`；既有用例锁定该前缀恰好 17 码加 `default` | 2.3、附录 A3 |
| 4 | 视频号稳定码白名单加 13 个 | 视频号白名单既没有 `REPORT_*`，也没有 `INVALID_CURSOR`；后者是报表列表翻页会返回的码 | 2.5、附录 A3 改为 14 个 |
| 5 | 作品卡用单一的 `workColumns` 渲染 | 抖音作品卡是 4 个主列、一行次要指标加一条完播进度条，单一列表表达不了这个分层 | 2.1 拆成 `primary`、`secondary`、`progress` |
| 6 | 抖音既有用例只改 import 路径 | 两个用例直接读 `ReportPage.tsx` 源文件做红线扫描，一个用例从插件模块 import 读取器；迁出后目标路径要跟着改 | 3、5.1、附录 A1 |
| 7 | 报表页不改内容、布局与交互 | 页面与规范有差距，且 P1 之后 kit 已有 `KpiCard`、`ChartFrame`、`ChartLegend`、`ChartTooltip` 可用 | 1、2.8 |

动代码前再比对一次：从本次修订到开始开发之间，`main` 还可能有新的合入。开始开发的那一天先拉取 `main`，重读 5.3 表里列出的文件；有不一致时先修订本文，再动手。

## 1. 范围

做：

- 新建纯 client 包 `@yootun/dsh-client-report`：报表页组件、读取器、组合趋势图、格式化函数、词典、样式；
- 在共享包内按 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md) 整改报表页界面（2.8），抖音与视频号同时生效；
- 抖音工作台的报表页改为消费共享包，删除本地的重复实现；
- 视频号 Host 新增三个 action：`report.list`、`report.get`、`report.regenerate`；
- 视频号路由补三项校验能力：必填字段、日期格式、幂等键模板，只被这三个 action 使用；
- 视频号稳定码白名单加入 14 个码（13 个 `REPORT_*` 与 `INVALID_CURSOR`），错误码映射与词典补齐；
- 视频号工作台新增第三个 Tab「AI 报表」；
- Agent 面策略表加入两个只读工具。

不做：

- 不改 tools 与 docker-helm，契约见 [wx-report-server.md](wx-report-server.md)；
- 不改报表的数据内容、action 入参与出参、幂等键规则、轮询节奏、导出 HTML 的内容项，也不改详情的区块顺序（口径、KPI、趋势、账号、作品、异常、AI 洞察）；本单改的是这些内容的呈现方式（2.8）；
- PDF 导出的移除见 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md)，不在本单重复；
- 不改抖音导航结构与任何 keep-alive 规则；
- 不把报表组件放进 `@yootun/dsh-client-ui-kit`：那是 UI 复合组件库，不承载数据请求与业务页面；
- 不改 kit 的现有组件：`KpiCard` 的涨跌配色与本页的涨跌语义方向相反（2.8），本页不传它的 `delta`，也不为它加配色开关；
- 不在 kit 里新建洞察卡：报表页是「事实、推断、建议」三列形态的第一个消费者，先留在共享包，上移触发条件见 2.8；
- 不统一三个插件各自的数值与时间格式化函数：共享包自带一份抖音口径（2.1），既有重复不在本单处理；
- 不在 Agent 面提供「重新生成」；
- 关注者画像不进报表页。

## 2. 契约增量

MCP 工具：无。本单只消费 [wx-report-server.md](wx-report-server.md) 定义的 5 个工具。

### 2.1 共享包 `@yootun/dsh-client-report`

位置 `yootun/packages/dsh-client-report`。构建与测试方式同 `@yootun/dsh-client-ui-kit`：`build` 为 `tsc -p tsconfig.json && tsdown`，`test` 为 `vitest run`（jsdom）。抖音、视频号以 `devDependencies`（`workspace:*`）引用，由官方 `clientBundle` 内联进各自的 client bundle，不新增运行时外部依赖。

共享包从 kit 的桶导出 import 组件，与两个插件页面的现有写法一致。共享包不得被任何 Host 侧模块引用：桶导出会把组件与样式表带进宿主 bundle，两个插件 `api.ts` 走 `host-action.ts` 叶子路径就是为了避开这一点。

| 模块 | 内容 |
|---|---|
| `index.ts` | 导出面 |
| `report-page.tsx` | `ReportPage`：列表、详情、轮询、重新生成、版本切换（上移自抖音） |
| `report-detail.tsx` | 详情正文：报表头、KPI 行、趋势、账号表、作品卡、异常、AI 洞察 |
| `report-chart.tsx` | 组合趋势图：上移自抖音 `charts.tsx` 的 `ReportComboChart` 及其私有的刻度、值域函数；轴刻度文案函数 `axisLabel` 与同文件的折线图共用，共享包复制一份，插件内保留 |
| `report-export.ts` | 导出 HTML 的序列化 |
| `locales.ts` | 报表词条：zh 为键集事实源，en 全量同步 |
| `schema.ts` | 报表的行与详情类型、`readReportList`、`readReportDetail` |
| `format.ts` | 报表页用到的格式化函数，周期、文件名、版本号辅助函数，幂等键后缀生成 |
| `report.module.css` | 报表页样式 |

导出：`ReportPage`、`readReportList`、`readReportDetail`、`REPORT_REASONS_ZH`、`REPORT_REASONS_EN`、`REPORT_ERROR_CODES`、`NS`、`zh`、`en` 与相关类型。两个读取器供插件的页面用例断言投影结果，页面运行时只在共享包内部调用；词典的翻译函数只在包内使用，不导出。

`ReportPage` 的 props：

```ts
interface ReportPageProps {
  /** 请求函数：各插件用自己的 hostAction 构造。action 名为 report.list、report.get、report.regenerate。 */
  request: (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 当前语言：选择报表词条与数值、日期的格式。取值与两个插件页面的 localeTag 相同。 */
  locale: 'zh' | 'en'
  /** 稳定码到文案：报表码、连接失败码、路由拒绝码都经它解析；码为空时给出该域的默认文案。 */
  errorText: (code: string | null) => string
  onNotice: (text: string, tone?: 'success') => void
  /** 导出文件名前缀，由插件词典提供（如「抖音运营」「视频号运营」）。 */
  filePrefix: string
  /** 「重新生成」幂等键的前缀（如 douyin:report_regenerate），键为前缀加 reportId 加共享包生成的后缀。 */
  regenerateKeyPrefix: string
  /** 请求抛出的值不是 Error、轮询连续 5 次失败时的兜底码，由插件给出本域的请求失败稳定码。不传时为空码，`errorText` 给出该域的默认文案。 */
  requestFailedCode?: string | undefined
  /** 作品卡的指标布局，由插件声明。 */
  work: ReportWorkLayout
  /** 作品卡的扩展区；视频号用它渲染流量来源与最大流失点，抖音不传。 */
  renderWorkExtra?: (work: ReportWork) => ReactNode
}

interface ReportWorkLayout {
  /** 卡片主行，4 个计数指标。 */
  primary: ReadonlyArray<{ key: string; label: string }>
  /** 次要指标行。 */
  secondary: ReadonlyArray<{ key: string; label: string; kind: 'count' | 'percent' | 'seconds' }>
  /** 完播进度条；不传不渲染。 */
  progress?: { key: string; kind: 'percent'; label: string }
}
```

`requestFailedCode` 的取值：抖音传 `douyin_operation_request_failed`，上移前三处兜底解析到的就是这个码，文案逐字相同；视频号的稳定码表里没有对应的码，第 3 步接入时随 `reportErrorText`（2.3）一起定，不传则显示 `errorText` 对空码的默认文案。

`ReportWork` 从服务端的 `works[].metrics` 投影，分两部分：`metrics` 是数值指标，类型 `Readonly<Record<string, number | null>>`，读取器遍历服务端给出的键，值为有限数字则保留，否则记为空，不要求两个平台的键一致；`extra` 是同一对象里非数值的键，类型 `Readonly<Record<string, unknown>>`，原样保留给扩展区，由注入方自己校验。两个平台的指标键如下：

| 平台 | 共有 | 平台特有 |
|---|---|---|
| 抖音 | `plays`、`likes`、`comments`、`fansGain`、`collects`、`shares` | `completion5s`、`bounce2s`、`avgWatchSeconds` |
| 视频号 | 同上 | 数值：`completionRate`、`avgPlaySeconds`、`fastFlipRate`；非数值（进 `extra`）：`trafficSource` 是 `{ name, plays }` 数组，`retention` 是 `{ durationSeconds, maxLostSecond, retentionAtMaxLostPct }` |

两平台数据差异的处理：

| 差异 | 处理 |
|---|---|
| 账号行没有 `ownerName` | 类型改为可选；数据里没有该字段时不渲染「账号负责人」列。抖音的数据带该字段，显示不变 |
| 作品指标键不同 | 作品卡按 `work` 配置渲染；平台特有的内容经 `renderWorkExtra` 注入，不传时不留空位 |
| 词典与文件名前缀 | 词典在共享包内一份；文件名前缀由插件传入 |
| 数值与时间格式 | 共享包自带一份抖音现有口径：满 1 万用紧凑格式，不足 1 万加千位分隔，时间固定上海时区。视频号其他页面不足 1 万不加千位分隔、时间取本机时区，报表页不随它们变：两个平台的报表是同一业务，格式一致优先 |

抖音侧传给 `work` 的声明与现有作品卡一一对应：主行是播放、点赞、评论、净涨粉；次要行是收藏、分享、5 秒完播、2 秒跳出、平均观看时长；进度条是 5 秒完播率。视频号侧的声明：主行相同；次要行是收藏、分享、完播率、平均播放时长、快速划过率；进度条是完播率。

### 2.2 数据请求

共享包不持有任何插件路径。插件在组合层用本插件的 `hostAction` 构造 `request`，action 名与参数和抖音现有约定相同。响应经共享包的读取器投影；读取失败按稳定错误处理，不渲染半成品。详情轮询 5 秒一次，离开页面即停止；这段逻辑在共享包内，不依赖页面是否 keep-alive。

### 2.3 词典

共享包自带词典，形态同 kit 的词典模块，按 props 的 `locale` 选择，不需要 Provider。导出文件名前缀属于平台，`report.filePrefix` 这一条留在各插件的词典里，不迁入共享包。报表错误码的文案在共享包定义一次，以 `REPORT_REASONS_ZH` 与 `REPORT_REASONS_EN` 导出，键是抖音词典现有的全部 18 条 `report.error.*`：13 个 `REPORT_*` 码、`IDEMPOTENCY_CONFLICT`、`INVALID_IDEMPOTENCY_KEY`、`INVALID_CURSOR`、`VALIDATION_ERROR`，以及 `default`。两个插件的词典展开并入，各自的错误码映射表补对应键。单一事实源在共享包；1126 的编译期穷尽约束保证两边都不会漏。`REPORT_ERROR_CODES` 是 13 个 `REPORT_*` 码的只读数组，供测试核对，Host 侧不 import 它（白名单在 Host 的 `errors.ts` 里手写）。

抖音词典里现有的报表词条随页面上移迁入共享包。删键后运行 `pnpm run verify-client-ui-i18n`，确认没有残留引用。

`errorText` 由两个插件各自注入：

| 插件 | 注入 | 文案形态 |
|---|---|---|
| 抖音 | `code => domainErrorText('report', code, t)` | 与现状逐字相同：有分域文案用分域文案，其余走统一映射，未知码附原码 |
| 视频号 | 新增 `reportErrorText(code, t)`：先取 `report.error.<码>`，取不到再交给 `reasonText` | 报表码不带码后缀，与抖音一致；非报表码沿用视频号现有形态 |

HTML 导出失败是共享包的本地失败，不经过 Host action，文案不走 `errorText`：抖音现在用的是本域稳定码 `export_failed` 的词条，视频号没有这个码。共享包词典新增 `report.exportFailed`，措辞沿用抖音的「导出失败，请稍后重试」，不附码后缀；抖音的 `reason.export_failed` 词条其他页面仍在用，保留。

### 2.4 样式装载

共享包的样式表必须随消费它的插件进入 bundle 的样式安装元数据，否则样式静默不生效（kit 的页面壳曾因此失效）。做法与 kit 一致：共享包的样式表以编译产物内联；抖音、视频号在各自的 `kit-styles.ts` 里 import `@yootun/dsh-client-report/src/report.module.css`，并把该文件加入产物校验 `tests/client/verify-bundle-stylesheets.mjs` 与源码层守护用例。源码层守护是抖音的 `tests/client/douyin-parity.test.tsx` 与视频号的 `tests/client/wx-bundle.test.ts`，它们现在只从 kit 的导入推导样式表清单，需要加一条规则：client 源里 import 了共享包的报表页，就必须声明共享包的样式表。

共享包的响应式规则写成 `@container yootun-kit-page (...)`。这个容器名由 kit 的 `PluginPageShell` 建立，共享包对它有隐式依赖：报表页必须渲染在 `PluginPageShell` 之内，两个插件的组合层都已满足。共享包的构建沿用 kit 的 `staticLinked` 配置，容器名才不会被逐文件哈希。

共享包的类名映射在共享包构建时冻结。两个插件的 `verify-bundle-stylesheets.mjs` 把共享包样式表的类名映射加入「冻结类名在安装文本中有规则」的校验循环。

共享包要有自己的样式守护用例：TSX 里引用的每个 css 类都在 `report.module.css` 里有定义，且样式表不含 `!important`、字面色值与 kit 或官方的类名。

### 2.5 视频号 Host action

| action | 入参 | 对应工具 |
|---|---|---|
| `report.list` | `reportType?`（枚举）、`periodStart?`（日期）、`status?`（枚举）、`limit?`（整数 1 到 100）、`cursor?`（不超过 512 字符）、`allVersions?`（布尔） | `workbench_wx_report_list` |
| `report.get` | `reportId`（必填，不超过 128 字符） | `workbench_wx_report_get` |
| `report.regenerate` | `reportId`、`idempotencyKey`（必填；键模板前缀 `wx:report_regenerate`，绑定 `reportId`） | `workbench_wx_report_regenerate` |

三个 action 都经现有的透传调用链，出参为远端投影。「重新生成」是写操作，错误收敛沿用透传链路的现有行为。视频号 action 清单由 22 项变为 25 项；[p2 册 §1](../../1110/p2-wx-workbench-baseline.md) 与 [11 册](../../1110/11-wx-workbench-ui-layout-parity.md) 同步。

视频号的 `ActionSchema` 现在只有字段类型（`string`、`boolean`、`integer`）、截断式长度上限、整数闭区间与枚举。路由 schema 新增三项能力，写法与抖音路由的同名能力一致，只被这三个 action 使用，既有 action 的校验结果不变：

| 能力 | 行为 |
|---|---|
| 必填字段 | 列出的字段缺失或为空时拒绝 |
| `date` 字段类型 | 必须是 `YYYY-MM-DD` 且是合法日期 |
| 幂等键模板 | 键必须以给定前缀开头、后接两段非空；绑定字段时键内该段必须与请求值一致 |

抖音 `report.list`、`report.get`、`report.regenerate` 三个 schema 可以直接作为参照。

视频号现有的字符串长度限制是截断到上限而不是拒绝。三个新 action 的字符串字段沿用这个行为；与抖音「超限即拒绝」的差异是既有差异，不在本单统一。

稳定码：视频号的 `safeCode` 只放行白名单内的服务端码，其余收敛为 `WX_TOOL_UNAVAILABLE`。白名单在 `src/errors.ts` 的 `SERVER_ERROR_CODES`，现在不含任何 `REPORT_*`，也不含 `INVALID_CURSOR`。本单在 `SERVER_ERROR_CODES` 加入 13 个 `REPORT_*` 与 `INVALID_CURSOR`（抖音报表的另外三个通用码视频号已有）；客户端的 `REASON_KEYS` 以稳定码全集为键，随之多出 14 个键，词典同步补齐。

### 2.6 视频号 Tab

| 项 | 内容 |
|---|---|
| 位置 | 第三个 Tab，排在「作品数据」「账号总览」之后；值 `report`，元素 id `wx-tab-report` 与 `wx-panel-report` |
| 默认选中 | 不变，仍为「作品数据」 |
| 词条 | `tab.report`：「AI 报表」与「AI reports」 |
| 内容 | 共享包的 `ReportPage`，占满内容区 |

接入点有三处：

1. `src/client/workbench-ui.ts` 的 `TabValue` 加 `'report'`；
2. `src/client/use-workbench-page.tsx` 内联构造的 `tabs` 加一项，沿用现有两项的 id 与 `panelId` 命名；
3. `src/client/WorkbenchPage.tsx` 的内容分支现在是 `tab === 'works' ? … : <OverviewPage/>` 的三元表达式，改为显式分支：作品、总览、报表各一条。

报表分支与抖音一样放在账号列表的 `DataState` 之内：报表本身不依赖账号列表，但页面沿用组合层现有的账号加载门，两个平台一致。报表 Tab 不 keep-alive，切走即卸载，轮询随之停止。

### 2.7 Agent 面

`yootun/plugins/dsh-managed-mcp/src/guard.ts` 的只读工具表在视频号段加入 `yootun_wx_reports_list` 与 `yootun_wx_report_get`。Agent 面不提供「重新生成」，所以三张策略表里都不出现它。对应测试用 `AGENT_TOOL_NAMES.length` 动态断言注册数量，不需要改数字。

### 2.8 报表页界面整改

整改在共享包内进行，依据 [plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md)。下表左列是 `main` 上抖音报表页的现状，中列是规范条款，右列是整改后的形态。

| 区块 | 现状 | 规范条款 | 整改 |
|---|---|---|---|
| KPI 行 | 插件局部的 `kpiRow`、`kpiTile`，网格自动填充，行内数量不限；窄于 1120 三列、窄于 640 两列；没有加载骨架 | §三 KPI：数值 20–24px、标签 12–13px、每行最多 6 个、附时间范围或分母；§2.3：640–879 两列，小于 640 单列；§4.6：KPI 用数值骨架 | 改用 kit `KpiCard`。6 个指标：880 及以上六列，640–879 两列，小于 640 单列；加载态用数值骨架；不可用的指标显示「—」 |
| KPI 变化量 | `kpiChange`，涨红跌绿 | kit `KpiCard` 的 `delta`：上升为 `--yt-chart-positive`（绿），下降为 `--yt-chart-negative`（琥珀） | 不传 `delta`。变化说明经 `footnote` 传入，涨红跌绿沿用现有 token，与两个工作台其他页面一致 |
| 趋势图容器 | `DataCard`；区段标题被 `.reportSection h2` 覆盖成 15px 加左侧竖杠 | §5.2：图表卡有标题、绘图区、图例、脚注；标题写成业务问题；`role="group"` 与可访问名；高度 180–320px | 改用 kit `ChartFrame`，高度 240，显式给可访问名；标题词条改成业务问题的句式，例如日报趋势卡由「近 7 天播放增量与净增粉丝趋势」改为「近 7 天播放与净增粉丝如何变化」；删除对 kit 标题的结构选择器覆盖 |
| 趋势图图例 | 没有图例，图下一段文字说明柱与线各是什么 | §5.2：图例含颜色、标签、值 | 加只读的 `ChartLegend`，柱与线两个系列，沿用现有配色：柱 `--yt-chart-2`，线 `--yt-chart-4`；末位柱仍用 `--yt-chart-1` 标出当期，在脚注说明。不提供开关，两个系列都不该被隐藏 |
| 趋势图浮层 | 自写的深色单行气泡，只显示线系列的值 | §5.3：浮层含类别、数值、时间；靠边翻转，不遮挡当前 mark | 改用 kit `ChartTooltip`：标题是日期，两行是柱值与线值；缺采显示「—」 |
| 趋势图键盘 | 每列一个按钮，聚焦时显示气泡 | §5.2：可点击的 mark 用 button 语义，支持 Enter 与 Space | 不变；聚焦时显示同一个 `ChartTooltip` |
| 账号表与列表 | 插件的 `dataTable`：数字右对齐，行高 32px，与插件其他表格同一密度 | §三 表格：表头 32px、行高 36–40px、数字右对齐、操作列固定宽度 | 数字右对齐与表头高度不变；行高沿用两个工作台现有表格的 32px，否则同一插件内表格密度不一致，规范条款与全站现状的差异不在本单处理；负责人列随数据有无渲染 |
| 列表的「查看」列 | 操作列没有固定宽度 | 同上 | 固定宽度 |
| 列表加载更多失败 | 整个列表替换成错误提示，已加载的行消失 | §4.5：失败列表保留已加载数据并提供重试，不整页替换成错误 | 加载更多失败时保留已有行，在按钮旁给一处错误提示与重试；首屏失败才整块错误 |
| 「重新生成」提交中 | 按钮置灰，旁边有「提交中」状态文字；按钮自身没有 `aria-busy`，文案不变 | §4.1：提交中 disabled、`aria-busy`、busy 文案 | 按钮补 `aria-busy` 与 busy 文案；状态文字保留 |
| 详情加载态 | 整块骨架 | §4.6：三态与最终内容形状相似 | KPI 行用数值骨架，趋势图用图形骨架，账号表用行骨架 |
| 分区间距 | 16px | §三：相邻一级分区纵向 20px | 20px |
| 作品卡 | `workCard` 系列：4 个主列、一行次要指标、一条进度条 | §4.5：重复卡片同一构图；不同状态用 Tag | 结构不变，按 `work` 配置渲染；视频号的扩展区用同一构图 |
| AI 洞察 | 三列，窄于 1120 单列；置信度与优先级用 Tag | §4.6：状态颜色伴随文本 | 结构不变 |
| 响应式 | 容器查询 `yootun-kit-page` | §2.3：按容器宽度，不用视口媒体查询 | 共享包样式表沿用 `@container yootun-kit-page` |
| HTML 导出 | 自包含单文件，内联独立样式 | 不适用：导出物不是插件界面 | 内容项与页面保持一致；不套 kit 组件 |

置灰原因：抖音报表页现有的置灰按钮（生成中时的「重新生成」与「导出」）是官方 `Button` 加 `disabled`，原因由就近的状态文字说明，没有用 `title` 解释控件。这符合 §4.1 的「附近说明」写法，不改成 `ReasonButton`。

洞察卡的归属：规范 §8.1 把洞察卡列在 kit，同时规定 kit 不预先创建，随真实消费者建立。报表页的三列洞察是第一个消费者，按 §1.1 第 4 条先留在共享包，并在本文记录上移触发条件：kit 的其他消费者需要「事实、推断、建议」三列或同构的洞察列表时，把它抽成 kit 组件，报表页改为消费。

整改会改变抖音报表页的可见界面：KPI 卡的样式、趋势图的标题与浮层、区段标题、分区间距。数据、文案的含义、幂等与轮询行为不变。这是用户在 2026-11-27 提出的要求：日报的界面参考 P0、P1 之后的仓库规范。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约在 [wx-report-server.md](wx-report-server.md) |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-client-report/`（新） | 包、源文件、测试 | 是 | 本单主体 |
| yootun-agent | `pnpm-lock.yaml` | 新 workspace 包的锁记录 | 是 | workspace glob 已登记（[inline-changes.md](../../inline-changes.md) 第 1 项） |
| yootun-agent | 抖音 `src/client/ReportPage.tsx`（删除）、`charts.tsx`、`schema.ts`、`index.ts`、`WorkbenchPage.tsx`、`kit-styles.ts` | 改为消费共享包；删除本地的报表实现；样式装载声明加一项。`format.ts` 不动：共用的格式化函数其他页面仍在用 | 是 | 第二个消费者出现，必须上移 |
| yootun-agent | 抖音 `src/client/locales.ts` | 报表词条迁出；并入 `REPORT_REASONS_*` | 是 | 单一事实源 |
| yootun-agent | 抖音 `src/client/workbench.module.css` | 删除 25 个报表专属类与 11 个组合图类；21 个共用类其他页面仍在用，保留 | 是 | 样式随页面上移 |
| yootun-agent | 抖音 `tests/client/douyin-client.test.tsx` | 「AI 报表页」用例组：import 路径、源码扫描的目标路径随迁移调整；界面整改后，绑定旧类名与旧浮层的断言逐条修改并写明原因 | 是 | 行为变化的证据 |
| yootun-agent | 抖音 `tests/client/douyin-parity.test.tsx`、`verify-bundle-stylesheets.mjs` | 读取器的 import 路径；样式守护清单加一项；产物校验加共享包样式表与类名映射。`report.error.*` 17 码加 `default` 的键集锁定不变 | 是 | 词典单一事实源的证据 |
| yootun-agent | 视频号 `src/route.ts`、`src/handlers.ts`、`src/errors.ts` | 三个 action、三项校验能力、14 个稳定码 | 是 | Host action |
| yootun-agent | 视频号 `src/client/WorkbenchPage.tsx`、`use-workbench-page.tsx`、`workbench-ui.ts`、`kit-styles.ts`、`locales.ts`、`format.ts` | 第三个 Tab、请求与 `errorText` 注入、错误码映射与词条、样式装载、`reportErrorText` | 是 | 页面 |
| yootun-agent | 视频号 `tests/host.test.ts`、`tests/client/*.test.ts*`、`verify-bundle-stylesheets.mjs` | action 清单、路由校验、错误码穷尽、样式守护、页面用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/guard.ts`、`tests/managed-mcp.test.ts` | 两个只读工具 | 是 | Agent 面策略表 |
| yootun-agent | `yootun/docs/plugin-ui-ux-standard.md` §8.1 | 组件分层表增加「报表业务页」一行，来源为共享包 | 是 | 分层规则补充 |
| yootun-agent | `yootun/OVERVIEW.md` 目录结构表 | 登记新包 | 是 | 分区导航 |
| yootun-agent | `yootun/docs/1110/11-wx-workbench-ui-layout-parity.md` §2 与新增「AI 报表页」一节；`p2-wx-workbench-baseline.md` §1、§5 | Tab 结构、页面条款、action 与工具映射 | 是 | 分册是布局与基线记录 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §10 | 注明报表页由共享包承载；按 2.8 更新区块、图表与间距描述 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

Workbench 白名单不改：视频号 caller 的域已含 `wx`，`workbench_wx_report_*` 经域门放行（[cross-repo-sync.md 第二节](../../cross-repo-sync.md)）。yootun-agent 不持有工具名清单，除 Agent 面策略表外没有别处需要登记工具名。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、1126 索引） | 2026-11-27 | `main` | 基线核对后修订；等用户通知进入开发 |
| tools 合入 `dev` | 2026-11-26 | — | 不涉及，契约已在 [wx-report-server.md](wx-report-server.md) 落地 |
| docker-helm 部署测试环境 | — | — | 部署仓已合入 `master`，测试环境待部署；客户端先发只是报表 Tab 显示暂不可用，旧功能不受影响 |
| 第 1 步：纯上移，抖音改为消费 | 2026-11-27 | `feat/wx-report-client` | 阶段验收通过，已本地提交，未推送；分支从 `main` 切出并并入 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md) 与 [douyin-schedule-immediate-save.md](../../1127/features/douyin-schedule-immediate-save.md) 两条分支作为基线；核对记录见 5.3 |
| 第 2 步：界面整改 | 2026-11-27 | `feat/wx-report-client` | 阶段验收通过，已本地提交，未推送；主控验收修正四处后提交，核对记录见 5.3 |
| 第 3 步：视频号接入 | 2026-11-27 | `feat/wx-report-client` | 阶段验收通过，已本地提交，未推送；三仓联调 8 项通过（真实报表读取与重新生成）；核对记录见 5.3 |
| yootun-agent 合入 `main` | | | 三步都通过后一次合入；待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [x] 开发当日重读 5.3 表里列出的文件，与本文的差异已记入 5.3；
- [x] `pnpm --filter @yootun/dsh-client-report test`、`build` 通过；
- [x] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build`；`pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build` 通过；
- [x] `pnpm --filter @yootun/dsh-managed-mcp test`、`build` 通过；
- [x] 仓库级：`pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`；
- [x] 两个插件的产物校验通过，且 `lib/client.js` 的样式安装元数据里出现共享包的样式表，冻结类名在安装文本中都有规则；
- [x] 视频号错误码穷尽检查生效：临时从映射表删掉一个 `REPORT_*` 键应导致 `build` 失败，验证后恢复，记入 5.3；
- [x] 附录 B 的用例全部存在并通过。

三步串行，共用一条特性分支；每一步做完先过自己的阶段验收，通过后做一次本地提交，再进入下一步。每一步的阶段验收条件：

| 步骤 | 阶段验收条件 |
|---|---|
| 第 1 步：纯上移 | 抖音既有 client 用例只改了 import 路径与源码扫描的目标路径，断言零改动；`douyin-parity.test.tsx` 的 `report.error.*` 键集锁定不变。做不到即停下，不提交这一步 |
| 第 2 步：界面整改 | 抖音用例的变化限定在绑定旧类名与旧浮层的断言，逐条写明原因；数据、文案、幂等、轮询、导出的断言不动。2.8 表逐行落实；明暗主题、880 与 640 两档容器宽度、键盘路径、`prefers-reduced-motion` 目检通过；14 册 §10 已更新 |
| 第 3 步：视频号接入 | 附录 B 的 H、W、A 三组用例通过；视频号的三个 action 经本地三仓联调拿到真实报表 |

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| C1 | 抖音「AI 报表」：列表、详情、版本切换、重新生成、导出 HTML | 数据、文案与上移前一致；界面是 2.8 整改后的形态 |
| C2 | 视频号工作台出现第三个 Tab「AI 报表」，点击进入 | 没有报表时显示空态并说明调度时刻；有报表时显示列表 |
| C3 | 打开一份视频号日报 | KPI、趋势、账号表（没有负责人列）、作品卡（含流量来源与最大流失点）、AI 洞察显示正常；没有数据的格子显示「—」而不是 0 |
| C4 | 切换日报与周报、翻页、打开历史版本、切换版本 | 不出现旧报表的内容闪回；版本标签正确 |
| C5 | 点「重新生成」并确认，随后立刻再点一次 | 第一次生成新版本；第二次提示已有生成中的版本，不重复生成 |
| C6 | 导出 HTML 并打开 | 单文件自包含，内容项与页面一致 |
| C7 | 在普通会话里让智能体列出视频号最近的报表、读取其中一份的结论 | 两个工具免审批执行并返回结果 |
| C8 | 明暗主题；640、880、1120 三档宽度 | 报表页可读，没有溢出；KPI 行在 640 到 879 之间两列、640 以下单列；趋势图浮层靠边时翻转 |
| C9 | 抖音报表列表连续点「加载更多」时断开本地服务 | 已加载的行保留，按钮旁出现一处错误提示与重试 |

### 5.3 本地联调记录

2026-11-27 基线核对（在 `main` 上，P0、P1 已合入）：

| 核对项 | 重新调查的文件 | 结论 |
|---|---|---|
| 页面组合层 | 两个插件的 `src/client/WorkbenchPage.tsx`、`use-workbench-page.tsx` | 与原稿一致。抖音的报表分支是 `tab === 'report' && <ReportPage t localeTag onNotice/>`，不 keep-alive，位于账号 `DataState` 之内。视频号的 `tabs` 在 `use-workbench-page.tsx` 内联构造，`TabValue` 在 `workbench-ui.ts`，内容分支是三元表达式；加报表 Tab 要改成显式分支（2.6）。Tab 的 id 与 `panelId` 命名是 `wx-tab-{值}`、`wx-panel-{值}`，与原稿一致 |
| 请求函数 | kit 的 `host-action.ts`，两个插件的 `src/client/api.ts` | 与原稿一致。两个插件的 `hostAction` 签名可以直接当 `request` 传入 |
| 抖音报表页现状 | `ReportPage.tsx`、`charts.tsx`、`schema.ts`、`format.ts`、`locales.ts` | PDF 桥、`exportPdf` 与按钮仍在，去 PDF 单尚未实施。`attemptId` 已在 `format.ts`。页面直接 import 插件的 `hostAction`。`ReportPage` 的 props 是 `{ t, localeTag, onNotice }`，`localeTag` 由 `localeTagOf` 得出，取值 `'zh'` 或 `'en'`（见 0.3 第 1 项）。样式引用 46 个类，25 个专属、21 个共用，组合图 11 个 |
| 错误码映射 | 抖音、视频号的 `src/client/format.ts`、`locales.ts` | 两个插件都是穷尽记录。抖音 13 个 `REPORT_*` 的词条键是 `report.error.REPORT_*`，不是 `reason.REPORT_*`（修订 0.3 第 3 项）。抖音有分域解析 `domainErrorText`；视频号只有 `reasonText`，文案带码后缀，需要新增 `reportErrorText`（2.3） |
| 样式装载 | 两个插件的 `kit-styles.ts`、`tests/client/verify-bundle-stylesheets.mjs`、源码层守护用例 | 与原稿一致。源码层守护是抖音 `douyin-parity.test.tsx` 与视频号 `wx-bundle.test.ts`，推导规则只认 kit 路径，共享包要扩展规则（2.4）。产物校验有一段「冻结类名在安装文本中有规则」的循环，共享包的类名映射要加入 |
| 可达性基线 | kit 的 `reason-button.tsx`、`row-gesture.ts`；抖音报表页的置灰按钮 | kit 导出 `ReasonButton` 与 `isOnInteractiveTarget`。报表页的置灰按钮用 `disabled` 加就近的状态文字说明原因，符合 §4.1，无遗留违规项。原稿「按基线整改」改写为「按基线核对，结论是不需要改」（2.8） |
| 视频号路由 | 视频号 `src/route.ts`；抖音 `src/route.ts` 的报表 schema | `ActionSchema` 只有字段类型、截断式长度、整数区间、枚举，没有必填、日期、幂等键能力，与原稿一致。抖音三个报表 schema 可直接参照（2.5） |
| 视频号稳定码 | 视频号 `src/errors.ts` | `SERVER_ERROR_CODES` 没有任何 `REPORT_*`，也没有 `INVALID_CURSOR`，原稿漏了后者；白名单要加 14 个（修订 0.3 第 4 项） |
| Agent 面策略表 | `dsh-managed-mcp/src/guard.ts`、`tests/managed-mcp.test.ts` | 与原稿一致。抖音的是 `yootun_douyin_reports_list` 与 `yootun_douyin_report_get`；视频号段 6 个只读工具，追加两个报表工具。测试用 `AGENT_TOOL_NAMES.length` 动态断言 |

2026-11-27 第 1 步「纯上移」提交前核对：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 渲染一致性 | 上移前的 `ReportPage` 与共享包的 `ReportPage` 用同一批 mock 请求渲染，比较规范化后的 DOM、请求序列、`onNotice` 序列、导出的 HTML 与文件名 | 37 个场景全部一致：中英文列表、空列表、加载失败、加载更多、详情各状态、趋势图悬停列、重新生成的确认与提交、导出 HTML、日报周报切换、兜底码两条路径 |
| 样式规则 | 迁移前样式表中报表 57 个类（25 个专属、21 个共用、11 个组合图）的规则，对共享包样式表逐条比较选择器、嵌套的 `@media` 与 `@container` 上下文、声明体 | 缺失 0、多出 0 |
| 词典 | 迁移前抖音词典 1200 条，对「现抖音词典加共享包词典」逐条比较键与值 | 移除 107 条，全部在共享包：102 条逐字相同；5 条作品卡次要行词条由「收藏 {value}」这类模板改为纯标签「收藏」，值由组件按 `work` 配置拼接，渲染文本相同。保留的 1093 条值不变 |
| 抖音既有用例 | 读 `douyin-client.test.tsx`、`douyin-parity.test.tsx` 的 diff | 断言的期望值、键名与结构零改动。变化三类：词条与读取器的符号来源换成共享包（28 行）；源码扫描与读取路径的目标换成共享包文件；新增 1 条「`kit-styles` 声明共享包样式表」的守护用例。`report.error.*` 的键集锁定用例未改并通过 |
| 产物 | 读抖音 `lib/client.js` | 样式安装元数据含共享包样式表；14 条 `@container yootun-kit-page` 规则的容器名未被哈希 |
| 自动验收 | 共享包与抖音的 `test`、`build`；仓库级 `lint`、`verify-client-ui-i18n`、`verify-export-jsdoc`；`git diff --check` | 全部通过：共享包 30 条用例；抖音 Host 侧 227 条、vitest 172 条 |

主控验收发回的修正（已改完并复验）：样式漏了迁移前的两条规则（表格行悬停底色、减少动效偏好下关闭过渡），已补入；请求抛出非 Error 值与轮询连续 5 次失败时的兜底文案变了，加了 `requestFailedCode`，抖音传 `douyin_operation_request_failed`；导出面多了只在包内使用的翻译函数，已去掉。

主控做词典对照时另发现共享包英文词典的 10 条错误码文案被改写（如 `REPORT_DISABLED` 由「AI reports are currently disabled」改成「AI reports are not enabled」），违反 2.3 的「与现状逐字相同」，已直接改回原文。

第 1 步的已知遗留，不在本步处理：`report.exporting` 词条抖音与共享包各一份且文案相同，抖音的总览与分析页、共享包的报表页都在用；共享包样式表里随并写规则带入的 4 个类（`workTable`、`scheduleTable`、`colAction`、`axisSvg`）在共享包内没有对应元素，第 2 步重做表格样式时删除；日报与周报切换控件的元素 id 仍是 `douyin-report-type`，第 3 步视频号接入时改成不带平台名的 id。

2026-11-27 第 2 步「界面整改」提交前核对：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 2.8 表逐行 | 读共享包 `report-detail.tsx`、`report-chart.tsx`、`report-page.tsx`、`report.module.css` 的 diff，对照 2.8 表「整改」列 | 16 行全部落实。KPI 行是 6 张 `KpiCard`，列数由 `.kpiRow` 的三档容器查询决定；趋势图装在 `ChartFrame`（默认高度 240）内，图例与浮层用 kit 的 `ChartLegend`、`ChartTooltip`；`report-export.ts` 未改 |
| 词条 | 第 1 步定稿的共享包词典对工作区逐条比较键与值 | 改写 2 条趋势标题（2.8 表指定）、新增 `report.retry`、删除不再引用的 `report.trend.lineTip`；其余逐字不变，`REPORT_REASONS_*` 零变化 |
| 抖音用例 | 读 `douyin-client.test.tsx`、`douyin-parity.test.tsx` 的 diff | `douyin-client.test.tsx` 只改「日报区段」一条用例：用例名、区段容器断言、KPI 变化行断言、浮层断言，各有一行原因注释；数据、文案、幂等、轮询、导出的断言未动。`douyin-parity.test.tsx` 的样式守护推导扩展为同时扫描共享包源的 kit 导入 |
| 范围外改动 | 读 `git status` | 抖音 `kit-styles.ts` 加 `chart-legend.module.css` 一行：共享包引入 `ChartLegend` 后按 2.4 必须由消费插件声明，否则图例无样式。产物的样式安装元数据里共享包样式表与图例、KPI 卡、图表框、浮层 4 张 kit 样式表都在 |
| 自动验收 | 共享包与抖音的 `test`、`build`；仓库级 `lint`、`verify-client-ui-i18n`、`verify-export-jsdoc`；`git diff --check` | 全部通过：共享包 41 条用例（开发交付 38 条，主控补 3 条）；抖音 Host 侧 227 条、vitest 172 条 |

主控验收发现并直接修正的四处，开发的自检均未拦住。其一，样式表里多出一行未闭合的 `.reportBody {`，把它后面的 `.reportBody { gap: 20px }` 与之后所有规则嵌成了后代选择器，分区间距 20px 这条整改实际没有生效，窄屏下列表工具栏的折行规则也一并失效；以文本正则写成的样式用例恰好匹配到被嵌套的那个块，所以通过。已删掉多余的一行，并给样式守护加一条花括号配平与禁嵌套规则的用例，把坏块放回去时该用例失败。其二，详情骨架的标题在周报加载中显示成日报标题，改为按正在打开的报表类型取词条。其三，整改后不再引用的 `report.trend.lineTip` 留在词典里，已删除，抖音用例里引用它的那条「旧气泡不存在」断言一并删除。其四，2.8 表「详情加载态」一行没有用例，补了两条：骨架形状与加载完成后换成正文、周报骨架标题。

未做浏览器目检：明暗主题、两档容器宽度、键盘路径、`prefers-reduced-motion` 的开发侧证据是样式规则对照与 P14 的可执行断言，待真机验收（5.2 的 C1、C8）。

第 2 步的已知遗留：日报与周报切换控件的元素 id 仍是 `douyin-report-type`，第 3 步处理；浮层靠边翻转的真实落位由 kit 的 `placeTooltip` 决定，共享包用例只锁定翻转标记的存在。

2026-11-27 第 3 步「视频号接入」提交前核对：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 词典 | 视频号词典第 2 步定稿版对工作区逐条比较键与值 | 改写 0、删除 0；新增 24 条：6 条页面词条加 18 条 `report.error.*`（后 18 条与共享包 `REPORT_REASONS_ZH/EN` 逐字一致） |
| 共享包 | 读 `dsh-client-report` 的 diff | 仅日报周报切换控件的 id 由 `douyin-report-type` 改为 `yootun-report-type`，接口、词典与组件实现零改动；全仓 grep 该旧串无残留，抖音测试无牵连 |
| 路由 | 读 `route.ts` 的 diff，对照 2.5 | 三项能力（必填、`date`、幂等键模板）与三个 schema 逐字段一致；空串字段剔除是旧版既有行为，本步只是变量重组，既有 action 的校验行为不变（H3 用例锁定） |
| Agent 面 | 读 `guard.ts` 与测试 diff | 只读工具表视频号段加两个工具；三张策略表无任何 `*_report_regenerate` |
| 自动验收 | 视频号、managed-mcp、共享包、抖音的 `test`、`build`；仓库级 `lint`、`typecheck`、`verify-client-ui-i18n`、`verify-export-jsdoc`；`git diff --check` | 全部通过：视频号 vitest 115 条（基线 110 加 5）、managed-mcp 21 条、共享包 41 条、抖音 Host 侧 227 条、vitest 175 条；typecheck 5 项门全过 |
| 产物 | `verify-bundle-stylesheets` 与产物文本 | 视频号 `lib/client.js` 的样式安装元数据含共享包样式表，冻结类名在安装文本中都有规则；`@container yootun-kit-page` 容器名未被哈希 |

抖音 vitest 用例数说明：合并远程 `main` 的测试加固带入 3 条用例，第 3 步未改抖音测试文件（diff 为零），175 条是合并后的正确基线。

三仓联调（环境与真实数据由主控提供：本地库迁移到 `20261126_0092`、FastAPI `http://127.0.0.1:8000`（`/mcp` 聚合网关）、视频号专属 worker 监听 `tools.wx_channels_operation`、库内已有一条真实 `succeeded` 报表）：

| 项 | 结果 |
|---|---|
| `report.get` 缺 `reportId` | 路由 400 `WX_ROUTE_INVALID_REQUEST` |
| `report.list` | 拿到真实报表行 |
| `report.get` | 真实 AI 结论（summary、facts、recommendations） |
| `report.regenerate` | 派发成功；联调期间 v2 至 v6 五次均由视频号专属 worker 真实生成至 `succeeded`，v6 为当前版本 |
| 幂等键前缀错误 | 路由拒绝 `INVALID_IDEMPOTENCY_KEY` |
| 既有 action | 合并远程后全量回归通过 |

联调发现并修复一个真实对接缺口：视频号既有透传 `compat` 把工具出参顶层展开，而共享包读取器读 `payload.data.*`（抖音 passthrough 是 data 包裹），不修则报表页永远空列表；测试 mock 形状对齐共享包所以单测未暴露。已把三个报表 action 改走 `runReport`（data 包裹，与抖音同构），未改共享包接口。这是 2.5「经现有的透传调用链」与第 1 步定稿读取器的对接缺口，按实际形状落地。

错误码穷尽变异验证：临时从 `REASON_KEYS` 删除 `REPORT_TIMEOUT`，`build` 因 `TS2741` 失败；恢复后通过。

执行失误披露（开发自报并已修复复验）：中途一条命令误带 `git checkout` 把 `wx-page.test.tsx` 回滚到 HEAD，本步改动全量重放后复跑通过；`report.extra.maxLost` 词条初版含多余字面 `%`，已修正。

第 3 步的已知遗留：浏览器目检待真机验收（5.2 的 C1 至 C9）；库内视频号报表的 works 全为空（11-25 周期无发布作品），作品卡扩展区的真实数据目检待真机 C3 用一条含作品行的报表补做，开发侧由 W4 用服务端真实形状的 fixture 覆盖。

真机验收前本地环境复用方式：`tools.dofe.ai` 仓 `uv run alembic upgrade head` 后 `uv run app`（FastAPI，8000）与 `uv run celery -A tools_dofe.tasks.celery_app.celery_app worker -Q tools.wx_channels_operation -n wx-channels-operation@local`；本次联调的进程与日志（`/tmp/tools-app.log`、`/tmp/tools-wx-worker.log`）仍在。

## 附录 A：逐文件要点

### A1 落地顺序（三步串行）

1. **纯上移。** 建共享包，页面原样迁入（样式按类复制），抖音改为消费并删除本地实现。以「抖音既有 client 用例断言零改动」为阶段验收条件；做不到即停下，不提交这一步。
2. **界面整改。** 在共享包内按 2.8 整改，抖音随之变化。以 5.1 第 2 步的阶段验收条件为准。
3. **视频号接入。** 加 Tab、Host action 与路由能力、稳定码、Agent 面登记。props 契约在第 1 步定稿，这一步不再改接口。

三步串行、共用一条特性分支，不开并行工作区：每一步验收通过后本地提交，三步都通过后一次合入 `main`。视频号的报表 Tab 第一次对用户可见时，就是整改后的界面。

把前两步分开的原因：上移是纯重构，界面整改是有意的可见变化。各自单独提交，抖音报表出问题时能直接判断是哪一步引入的。

### A2 请求与幂等键

- 抖音、视频号的组合层各自用本插件的 `hostAction` 构造 `request`，action 名与参数相同；
- 「重新生成」的幂等键后缀由共享包生成（32 位小写十六进制），同一次点击的重试复用同一个后缀；键模板为 `{前缀}:{reportId}:{后缀}`，前缀由 props 的 `regenerateKeyPrefix` 给出：抖音传 `douyin:report_regenerate`，视频号传 `wx:report_regenerate`。

### A3 错误码

- 共享包导出 18 条 `report.error.*` 文案常量：13 个 `REPORT_*` 码、`IDEMPOTENCY_CONFLICT`、`INVALID_IDEMPOTENCY_KEY`、`INVALID_CURSOR`、`VALIDATION_ERROR`，以及 `default`；键名沿用抖音词典现有的键；
- 视频号服务端稳定码白名单加入 13 个 `REPORT_*` 与 `INVALID_CURSOR`；映射表与词典补齐这 14 个键；
- 抖音的映射表已经覆盖这些码；本单只把词条来源换成共享包常量，键集锁定用例不变。

## 附录 B：测试矩阵

| ID | 层 | 断言 |
|---|---|---|
| P1 | 共享包 | 列表为空时显示空态文案；状态为数据不足的条目显示「数据不足」 |
| P2 | 共享包 | 详情各状态：已生成、生成中（轮询，卸载后停止）、数据不足（指引文案）、生成失败（错误码文案） |
| P3 | 共享包 | 缺采账号显示「—*」，覆盖摘要列出缺采账号 |
| P4 | 共享包 | 作品卡按 `work` 配置渲染主行、次要行与进度条；传入 `renderWorkExtra` 时渲染扩展内容，不传时不留空位 |
| P5 | 共享包 | 账号行没有 `ownerName` 时不渲染负责人列 |
| P6 | 共享包 | 「重新生成」需要确认；取消不发起请求；确认后的幂等键符合模板 |
| P7 | 共享包 | 导出 HTML 生成自包含单文件，文件名由前缀、日报或周报、周期组成 |
| P8 | 共享包 | 语言切换后词典与数值格式随之切换 |
| P9 | 共享包 | 错误文案全部来自 `errorText`：报表码、连接失败码、空码各调用一次，传入的码正确 |
| P16 | 共享包 | HTML 导出失败时提示共享包词典的 `report.exportFailed`，不调用 `errorText` |
| P10 | 共享包 | 列表加载更多失败时保留已加载的行，出现一处错误提示与重试；首屏失败时整块错误 |
| P11 | 共享包 | 「重新生成」提交中：按钮 disabled、`aria-busy`、busy 文案 |
| P12 | 共享包 | 趋势图聚焦某一列时浮层显示日期与柱、线两个系列的值；缺采列为「—」 |
| P13 | 共享包 | KPI 行渲染 6 个 `KpiCard`；不可用的指标显示「—」；没有对比基准时显示说明 |
| P14 | 共享包 | 样式守护：TSX 引用的 css 类都有定义；样式表不含 `!important` 与字面色值 |
| P15 | 共享包 | 抖音口径的格式化：满 1 万用紧凑格式，不足 1 万加千位分隔，时间固定上海时区 |
| H1 | 视频号 Host | action 清单包含三个报表 action；每个 action 的未知字段被拒绝 |
| H2 | 视频号路由 | `report.get` 缺 `reportId` 被拒绝；`report.list` 的 `periodStart` 不是日期被拒绝；`report.regenerate` 的幂等键前缀错误或键内 `reportId` 不一致被拒绝 |
| H3 | 视频号路由 | 既有 action 的校验结果与加入三项能力之前逐项相同 |
| H4 | 视频号路由 | 14 个新增稳定码经透传后原样到达页面，不被收敛为 `WX_TOOL_UNAVAILABLE` |
| W1 | 视频号页面 | 第三个 Tab 存在且默认不选中；切换后渲染报表页 |
| W2 | 视频号页面 | 报表页的请求发往本插件的路径 |
| W3 | 视频号页面 | 报表码的错误文案不带码后缀；非报表码沿用 `reasonText` 的形态 |
| W4 | 视频号页面 | 视频号作品卡渲染流量来源与最大流失点 |
| A1 | Agent 面 | 两个只读工具免审批放行，调用携带正确的工具名 |
| A2 | Agent 面 | 只读工具表里不含任何 `*_report_regenerate` |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 共享的范围 | 整个报表页（含请求编排、轮询、导出）作为一个纯 client 包 | 只共享读取器与图表，页面各写一份 |
| 请求函数 | 由插件注入 `request` | 共享包接收 Host 路径并自己发请求 |
| 错误文案 | 由插件注入 `errorText`，共享包不解析任何码 | 共享包解析报表码，注入方解析其余码 |
| 平台差异 | 指标布局由插件声明，扩展区注入 | 共享包内置两套作品卡 |
| 词典 | 共享包自带一份；错误码文案以常量导出、插件并入 | 两个插件的词典各保留一份完整报表词条 |
| 落地方式 | 纯上移与界面整改分两步，各自单独提交 | 上移与整改一步做完 |
| 涨跌配色 | 沿用红涨绿跌，变化说明经 `KpiCard` 的 `footnote` | 用 `KpiCard` 的 `delta`（绿涨琥珀跌）；给 kit 加配色开关 |
| 趋势图浮层 | `ChartTooltip`，显示日期与两个系列 | 保留单行气泡 |
| 洞察卡归属 | 留在共享包，kit 出现第二个消费者时上移 | 现在在 kit 建洞察卡 |
| 详情的区块顺序 | 保持抖音现有顺序 | AI 洞察上移到 KPI 行之后（规范「洞察优先」） |
