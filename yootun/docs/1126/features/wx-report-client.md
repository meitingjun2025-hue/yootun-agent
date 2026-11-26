# wx-report-视频号 AI 报表工作台与智能体工具 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台的报表页（`yootun/plugins/dsh-douyin-workbench/src/client/ReportPage.tsx`，821 行）是一个自包含组件：列表与详情双态、详情轮询、重新生成确认、HTML 导出、版本切换；加上同目录的读取器（`schema.ts`）、组合趋势图（`charts.tsx`）、格式化函数（`format.ts`）与 128 条报表词条（`locales.ts` 的中文词典）。它直接 import 本插件的 `hostAction`。视频号工作台目前有两个 Tab（作品数据、账号总览），没有报表。

本单的客户端基线是 1126 各单合入之后的形态。与当前代码相比有五处变化，实施时以合入后的代码为准：

| 变化 | 来源 | 对本单的影响 |
|---|---|---|
| 页面数据流拆为不依赖 React 的 machine，`WorkbenchPage` 只做组合；页面 props 为 `{ t, locale }`，语言标签由 locale 快照的当前语言得出 | [client-workbench-hooks.md](client-workbench-hooks.md) | 报表 Tab 作为组合层的一个渲染分支接入，不在页面里写数据流 |
| `hostAction` 上移为 kit 的 `createHostAction` | [connector-status-and-error-copy.md](connector-status-and-error-copy.md) | 共享报表包不 import 任何插件的请求模块，由插件把请求函数注入 |
| 错误码到文案的映射改为以稳定码类型为键的穷尽记录，缺键即编译失败；抖音不再按域分表 | 同上 | 新增的 `REPORT_*` 码必须在两个插件的映射表与词典里补齐 |
| 抖音 `attemptId` 迁到 `format.ts` | [client-workbench-hooks.md](client-workbench-hooks.md) | 共享包自带幂等键后缀的生成函数，不依赖插件 |
| 字重不超过 500、字号不小于 12px、置灰原因用带原因的按钮、省略文本用 Tooltip | [ui-accessibility-and-visual-cleanup.md](ui-accessibility-and-visual-cleanup.md) | 上移到共享包的组件按这组基线整改 |

抖音的顶级导航在 [douyin-tabs-regroup.md](douyin-tabs-regroup.md) 之后是四组，「AI 报表」是「报表」组的直接页面，本单不改导航。视频号的 `account.refreshLoginQr` 已在 [mount-restore-and-login-alignment.md](mount-restore-and-login-alignment.md) 删除，`collect.running` 已在 [wx-collect-all-concurrency.md](wx-collect-all-concurrency.md) 加入；1126 合入后视频号 action 清单为 22 项，本单在其上追加。

### 0.2 目标

把报表页抽成纯 client 包 `@yootun/dsh-client-report`，抖音改为消费（行为不变），视频号新增第三个 Tab「AI 报表」；两个只读的报表工具进入普通会话。

前置单：[wx-report-server.md](wx-report-server.md)（工具契约与部署）、[douyin-report-remove-pdf.md](douyin-report-remove-pdf.md)（上移前先去掉 PDF）。

### 0.3 动代码前先核对最新代码

本单对客户端形态的描述依据的是 1126 各单的条款，不是它们合入之后的代码：0.1 的五处变化，以及 2.1 到 2.7 里对组件接口、请求注入、词典接入、样式装载、路由能力、Tab 接入点的写法，都是按条款推断的。各单在实施中可能与条款有出入，0.1 里的行数与词条数也只是 2026-11-26 当前代码的规模参考。所以本单在动代码之前必须做一次基线核对，在合入后的最新代码上开发，不在当前代码、也不在本文的推断上开发。

核对步骤：

1. 确认 1126 的 P0、P1 各单与 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md) 已合入 `main`，从 `main` 切出本单的特性分支；
2. 重新调查下表列出的文件的实际实现，逐项对照本文；
3. 发现与本文不一致的地方，以代码为准：先修订本单（0.1 的变化表与对应的第 2 节小节），再开始开发；
4. 把逐项结论（一致，或已修订及修订内容）记入 5.3，之后才进入附录 A1 的第一步。

| 核对项 | 重新调查的文件 | 对照本文 |
|---|---|---|
| 页面组合层 | 抖音、视频号的 `src/client/WorkbenchPage.tsx`，以及 1126 新增的 `src/client/flows.ts` 与 machine 包（如果已建） | 0.1 第一行、2.6 |
| 请求函数 | kit 的 `host-action.ts`，两个插件 `src/client/api.ts` 的构造方式与超时配置 | 2.2 |
| 抖音报表页现状 | `ReportPage.tsx`、`charts.tsx`、`schema.ts`、`format.ts`、`locales.ts` 里报表相关代码的当前位置与导出名；PDF 相关代码是否已移除；`attemptId` 现在在哪里 | 2.1、附录 A2 |
| 错误码映射 | 两个插件里错误码映射表的位置、类型写法与当前覆盖的码 | 2.3、附录 A3 |
| 样式装载 | 两个插件的样式装载声明、`verify-bundle-stylesheets.mjs` 与源码层守护用例的现有清单 | 2.4 |
| 可达性基线 | kit 里带原因的按钮与行手势守卫的实际导出名；报表页现有的置灰按钮与 `title` 用法 | 0.1 最后一行 |
| 视频号路由 | `src/route.ts` 的 schema 类型与校验函数：action 清单的当前项数，是否已经有必填、日期、幂等键能力 | 2.5 |
| 视频号稳定码 | `src/errors.ts` 两个白名单的当前内容 | 2.5、附录 A3 |
| Agent 面策略表 | `dsh-managed-mcp/src/guard.ts` 三张表的当前内容与对应测试 | 2.7 |

## 1. 范围

做：

- 新建纯 client 包 `@yootun/dsh-client-report`：报表页组件、读取器、组合趋势图、格式化函数、词典、样式；
- 抖音工作台的报表页改为消费共享包，删除本地的重复实现；既有 client 用例只允许改 import 路径，断言不变；
- 视频号 Host 新增三个 action：`report.list`、`report.get`、`report.regenerate`；
- 视频号路由补三项校验能力：必填字段、日期格式、幂等键模板，只被这三个 action 使用；
- 视频号稳定码白名单加入 13 个 `REPORT_*` 码，错误码映射与词典补齐；
- 视频号工作台新增第三个 Tab「AI 报表」；
- Agent 面策略表加入两个只读工具。

不做：

- 不改 tools 与 docker-helm，契约见 [wx-report-server.md](wx-report-server.md)；
- 不改报表页的内容、布局与交互；PDF 导出的移除见 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md)；
- 不改抖音导航结构与任何 keep-alive 规则；
- 不把报表组件放进 `@yootun/dsh-client-ui-kit`：那是 UI 复合组件库，不承载数据请求与业务页面；
- 不在 Agent 面提供「重新生成」；
- 关注者画像不进报表页。

## 2. 契约增量

MCP 工具：无。本单只消费 [wx-report-server.md](wx-report-server.md) 定义的 5 个工具。

### 2.1 共享包 `@yootun/dsh-client-report`

位置 `yootun/packages/dsh-client-report`。构建与测试方式同 `@yootun/dsh-client-ui-kit`：`build` 为 `tsc -p tsconfig.json && tsdown`，`test` 为 `vitest run`（jsdom）。抖音、视频号以 `devDependencies`（`workspace:*`）引用，由官方 `clientBundle` 内联进各自的 client bundle，不新增运行时外部依赖。

| 模块 | 内容 |
|---|---|
| `index.ts` | 导出面 |
| `report-page.tsx` | `ReportPage`（上移自抖音） |
| `report-locale.ts` | 词典注入，形态同 kit 的词典模块 |
| `locales.ts` | 报表词条：zh 为键集事实源，en 全量同步 |
| `schema.ts` | 报表的行与详情类型、`readReportList`、`readReportDetail` |
| `report-chart.tsx` | 组合趋势图及其内部依赖 |
| `format.ts` | 报表页用到的格式化函数，周期、文件名、版本号辅助函数，幂等键后缀生成 |
| `report.module.css` | 报表页样式，从抖音的样式表拆出，按 1126 可达性基线整改 |

导出：`ReportPage`、`createReportTranslate`、`ReportLocaleProvider`、`REPORT_REASONS_ZH`、`REPORT_REASONS_EN`、`REPORT_ERROR_CODES`、`NS`、`zh`、`en` 与相关类型。

`ReportPage` 的 props：

```ts
interface ReportPageProps {
  /** 请求函数：各插件用自己的 hostAction 构造。action 名为 report.list、report.get、report.regenerate。 */
  request: (action: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** 当前语言：选择词典与数值、日期格式。 */
  locale: 'zh' | 'en'
  onNotice: (text: string, tone?: 'success') => void
  /** 导出文件名前缀，由插件词典提供（如「抖音运营」「视频号运营」）。 */
  filePrefix: string
  /** 作品卡的指标列，由插件声明。 */
  workColumns: ReadonlyArray<{ key: string; label: string; kind: 'count' | 'percent' | 'seconds' }>
  /** 作品卡的扩展区；视频号用它渲染流量来源与最大流失点，抖音不传。 */
  renderWorkExtra?: (work: ReportWork) => ReactNode
}
```

两平台数据差异的处理：

| 差异 | 处理 |
|---|---|
| 账号行可能没有 `ownerName` | 类型改为可选；字段缺失时不渲染「账号负责人」列。抖音的数据仍带该字段，显示不变 |
| 作品指标键不同 | 作品卡按 `workColumns` 渲染通用指标；平台特有的内容经 `renderWorkExtra` 注入，不传时不留空位 |
| 词典与文件名前缀 | 词典在共享包内一份；文件名前缀由插件传入 |

### 2.2 数据请求

共享包不持有任何插件路径。插件在组合层用本插件的 `hostAction` 构造 `request`，action 名与参数和抖音现有约定相同。响应经共享包的读取器投影；读取失败按稳定错误处理，不渲染半成品。详情轮询 5 秒一次，离开页面即停止；这段逻辑在共享包内，不依赖页面是否 keep-alive。

### 2.3 词典

共享包自带词典与 Provider，形态同 kit：插件按当前语言构造 translate 并用 Provider 包住报表页。报表错误码的文案由共享包导出 `REPORT_REASONS_ZH` 与 `REPORT_REASONS_EN`（键为 `reason.REPORT_*` 与三个通用的幂等、游标码），两个插件的词典展开并入，各自的错误码映射表补对应键。单一事实源在共享包；1126 的编译期穷尽约束保证两边都不会漏。

抖音词典里现有的报表词条随页面上移迁入共享包。删键后运行 `pnpm run verify-client-ui-i18n`，确认没有残留引用。

### 2.4 样式装载

共享包的样式表必须随消费它的插件进入 bundle 的样式安装元数据，否则样式静默不生效（kit 的页面壳曾因此失效）。做法与 kit 一致：共享包的样式表以编译产物内联；抖音、视频号在各自的样式装载声明里 import 共享包的样式表，并把该文件加入构建脚本的产物校验与源码层守护用例（两个插件各自的 `verify-bundle-stylesheets.mjs` 与源码层守护用例）。

### 2.5 视频号 Host action

| action | 入参 | 对应工具 |
|---|---|---|
| `report.list` | `reportType?`（枚举）、`periodStart?`（日期）、`status?`（枚举）、`limit?`（整数 1 到 100）、`cursor?`（不超过 512 字符）、`allVersions?`（布尔） | `workbench_wx_report_list` |
| `report.get` | `reportId`（必填，不超过 128 字符） | `workbench_wx_report_get` |
| `report.regenerate` | `reportId`、`idempotencyKey`（必填；键模板前缀 `wx:report_regenerate`，绑定 `reportId`） | `workbench_wx_report_regenerate` |

三个 action 都经现有的透传调用链，出参为远端投影。「重新生成」是写操作，错误收敛沿用透传链路的现有行为。视频号 action 清单由 22 项变为 25 项；[p2 册 §1](../../1110/p2-wx-workbench-baseline.md) 与 [11 册](../../1110/11-wx-workbench-ui-layout-parity.md) 同步。

路由 schema 新增三项能力，写法与抖音路由的同名能力一致，只被这三个 action 使用，既有 action 的校验结果不变：

| 能力 | 行为 |
|---|---|
| 必填字段 | 列出的字段缺失或为空时拒绝 |
| `date` 字段类型 | 必须是 `YYYY-MM-DD` 且是合法日期 |
| 幂等键模板 | 键必须以给定前缀开头、后接两段非空；绑定字段时键内该段必须与请求值一致 |

视频号现有的字符串长度限制是截断到上限而不是拒绝。三个新 action 的字符串字段沿用这个行为；与抖音「超限即拒绝」的差异是既有差异，不在本单统一。

### 2.6 视频号 Tab

| 项 | 内容 |
|---|---|
| 位置 | 第三个 Tab，排在「作品数据」「账号总览」之后；值 `report`，元素 id `wx-tab-report` 与 `wx-panel-report` |
| 默认选中 | 不变，仍为「作品数据」 |
| 词条 | `tab.report`：「AI 报表」与「AI reports」 |
| 内容 | 共享包的 `ReportPage`，占满内容区 |

### 2.7 Agent 面

`yootun/plugins/dsh-managed-mcp/src/guard.ts` 的只读工具表在视频号段加入 `yootun_wx_reports_list` 与 `yootun_wx_report_get`。Agent 面不提供「重新生成」，所以三张策略表里都不出现它。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约在 [wx-report-server.md](wx-report-server.md) |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-client-report/`（新） | 包、源文件、测试 | 是 | 本单主体 |
| yootun-agent | `pnpm-lock.yaml` | 新 workspace 包的锁记录 | 是 | workspace glob 已登记（[inline-changes.md](../../inline-changes.md) 第 1 项） |
| yootun-agent | 抖音 `src/client/ReportPage.tsx`、`charts.tsx`、`schema.ts`、`format.ts`、`index.ts`、`WorkbenchPage.tsx`、`kit-styles.ts` | 改为消费共享包；删除本地的报表实现 | 是 | 第二个消费者出现，必须上移 |
| yootun-agent | 抖音 `src/client/locales.ts` | 报表词条迁出；并入 `REPORT_REASONS_*` | 是 | 单一事实源 |
| yootun-agent | 抖音 `tests/client/*.test.tsx`、`verify-bundle-stylesheets.mjs` | import 路径随迁移调整，断言不变；样式守护清单加一项 | 是 | 行为不变的证据 |
| yootun-agent | 视频号 `src/route.ts`、`src/handlers.ts`、`src/errors.ts` | 三个 action、三项校验能力、13 个稳定码 | 是 | Host action |
| yootun-agent | 视频号 `src/client/WorkbenchPage.tsx`、`index.ts`、`locales.ts`、`format.ts`、`kit-styles.ts` | 第三个 Tab、请求注入、错误码映射与词条、样式装载 | 是 | 页面 |
| yootun-agent | 视频号 `tests/host.test.ts`、`tests/client/*.test.ts*`、`verify-bundle-stylesheets.mjs` | action 清单、路由校验、错误码穷尽、样式守护、页面用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/src/guard.ts`、`tests/managed-mcp.test.ts` | 两个只读工具 | 是 | Agent 面策略表 |
| yootun-agent | `yootun/docs/plugin-ui-ux-standard.md` §8.1 | 组件分层表增加「报表业务页」一行，来源为共享包 | 是 | 分层规则补充 |
| yootun-agent | `yootun/OVERVIEW.md` 目录结构表 | 登记新包 | 是 | 分区导航 |
| yootun-agent | `yootun/docs/1110/11-wx-workbench-ui-layout-parity.md` §2 与新增「AI 报表页」一节；`p2-wx-workbench-baseline.md` §1、§5 | Tab 结构、页面条款、action 与工具映射 | 是 | 分册是布局与基线记录 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §10 | 注明报表页由共享包承载 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

Workbench 白名单不改：视频号 caller 的域已含 `wx`，`workbench_wx_report_*` 经域门放行（[cross-repo-sync.md 第二节](../../cross-repo-sync.md)）。yootun-agent 不持有工具名清单，除 Agent 面策略表外没有别处需要登记工具名。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及，契约已在 [wx-report-server.md](wx-report-server.md) 落地 |
| docker-helm 部署测试环境 | — | — | 不涉及；前置是 [wx-report-server.md](wx-report-server.md) 已部署 |
| 动代码前基线核对 | | `main` | 前置：1126 各单与 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md) 已合入；按 0.3 核对，结论记入 5.3 |
| yootun-agent 合入 `main` | | `feat/wx-report-client` | 前置：1126 各单与 [douyin-report-remove-pdf.md](douyin-report-remove-pdf.md) 已合入 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [ ] 0.3 的基线核对已完成，逐项结论记入 5.3；
- [ ] `pnpm --filter @yootun/dsh-client-report test`、`build` 通过；
- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build`；`pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build` 通过；抖音既有 client 用例只改了 import 路径；
- [ ] `pnpm --filter @yootun/dsh-managed-mcp test`、`build` 通过；
- [ ] 仓库级：`pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`；
- [ ] 两个插件的产物校验通过，且 `lib/client.js` 的样式安装元数据里出现共享包的样式表；
- [ ] 视频号错误码穷尽检查生效：临时从映射表删掉一个 `REPORT_*` 键应导致 `build` 失败，验证后恢复，记入 5.3；
- [ ] 附录 B 的用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| C1 | 抖音「AI 报表」：列表、详情、版本切换、重新生成、导出 HTML | 与上移前一致 |
| C2 | 视频号工作台出现第三个 Tab「AI 报表」，点击进入 | 没有报表时显示空态并说明调度时刻；有报表时显示列表 |
| C3 | 打开一份视频号日报 | KPI、趋势、账号表（没有负责人列）、作品卡（含流量来源与最大流失点）、AI 洞察显示正常；没有数据的格子显示「—」而不是 0 |
| C4 | 切换日报与周报、翻页、打开历史版本、切换版本 | 不出现旧报表的内容闪回；版本标签正确 |
| C5 | 点「重新生成」并确认，随后立刻再点一次 | 第一次生成新版本；第二次提示已有生成中的版本，不重复生成 |
| C6 | 导出 HTML 并打开 | 单文件自包含，内容与页面一致 |
| C7 | 在普通会话里让智能体列出视频号最近的报表、读取其中一份的结论 | 两个工具免审批执行并返回结果 |
| C8 | 明暗主题；640、880、1120 三档宽度 | 报表页可读，没有溢出 |

### 5.3 本地联调记录

待填。先回填 0.3 基线核对的逐项结论（动代码前），再回填合入前的样式安装元数据核对结果与错误码穷尽检查的验证记录。

## 附录 A：逐文件要点

### A1 落地顺序（两步，各自独立合入）

1. 建共享包，抖音改为消费并删除本地实现。以「抖音既有 client 用例断言零改动」为合入条件；做不到即停下回退这一步。
2. 视频号加 Tab、Host action 与路由能力、Agent 面登记。

### A2 请求与幂等键

- 抖音、视频号的组合层各自用本插件的 `hostAction` 构造 `request`，action 名与参数相同；
- 「重新生成」的幂等键后缀由共享包生成（32 位小写十六进制），同一次点击的重试复用同一个后缀；键模板为 `wx:report_regenerate:{reportId}:{后缀}`，与抖音的前缀不同。

### A3 错误码

- 共享包导出 13 个 `REPORT_*` 码与三个通用码的文案常量；
- 视频号服务端稳定码白名单加入 13 个 `REPORT_*`；映射表与词典补齐；
- 按 1126 连接器单的条款，抖音的映射表在该单合入后覆盖这些码；本单只把词条来源换成共享包常量。

## 附录 B：测试矩阵

| ID | 层 | 断言 |
|---|---|---|
| P1 | 共享包 | 列表为空时显示空态文案；状态为数据不足的条目显示「数据不足」 |
| P2 | 共享包 | 详情各状态：已生成、生成中（轮询，卸载后停止）、数据不足（指引文案）、生成失败（错误码文案） |
| P3 | 共享包 | 缺采账号显示「—*」，覆盖摘要列出缺采账号 |
| P4 | 共享包 | 作品卡按 `workColumns` 渲染；传入 `renderWorkExtra` 时渲染扩展内容，不传时不留空位 |
| P5 | 共享包 | 账号行没有 `ownerName` 时不渲染负责人列 |
| P6 | 共享包 | 「重新生成」需要确认；取消不发起请求；确认后的幂等键符合模板 |
| P7 | 共享包 | 导出 HTML 生成自包含单文件，文件名由前缀、日报或周报、周期组成 |
| P8 | 共享包 | 语言切换后词典与数值格式随之切换 |
| H1 | 视频号 Host | action 清单包含三个报表 action；每个 action 的未知字段被拒绝 |
| H2 | 视频号路由 | `report.get` 缺 `reportId` 被拒绝；`report.list` 的 `periodStart` 不是日期被拒绝；`report.regenerate` 的幂等键前缀错误或键内 `reportId` 不一致被拒绝 |
| H3 | 视频号路由 | 既有 action 的校验结果与加入三项能力之前逐项相同 |
| H4 | 视频号路由 | `REPORT_*` 码经透传后原样到达页面，不被收敛为无效请求 |
| W1 | 视频号页面 | 第三个 Tab 存在且默认不选中；切换后渲染报表页 |
| W2 | 视频号页面 | 报表页的请求发往本插件的路径 |
| A1 | Agent 面 | 两个只读工具免审批放行，调用携带正确的工具名 |
| A2 | Agent 面 | 只读工具表里不含任何 `*_report_regenerate` |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 共享的范围 | 整个报表页（含请求编排、轮询、导出）作为一个纯 client 包 | 只共享读取器与图表，页面各写一份 |
| 请求函数 | 由插件注入 `request` | 共享包接收 Host 路径并自己发请求 |
| 平台差异 | 指标列由插件声明，扩展区注入 | 共享包内置两套作品卡 |
| 词典 | 共享包自带一份；错误码文案以常量导出、插件并入 | 两个插件的词典各保留一份完整报表词条 |
