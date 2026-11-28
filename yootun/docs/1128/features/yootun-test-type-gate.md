# infra-yootun-测试类型门禁 实施单

状态：开发完成（2026-11-28，自动验收通过），待合入 ｜ 创建：2026-11-28 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

来源：2026-11-28 修复 Agent 面状态路由的注册（[managed-mcp-status-route.md](managed-mcp-status-route.md)）时发现：仓库级 typecheck 的两个聚合程序（`tsconfig.host.json`、`tsconfig.client.json`）不含 `yootun/` 下的测试文件，`yootun` 各包的 tsconfig 只含 `src`，`yootun` 的测试文件从未做过类型检查。方案于 2026-11-28 经用户确认：`yootun` 自建聚合类型检查，存量全部修复，代码在特性分支 `feat/yootun-test-type-gate` 上实施。同日用户追加要求：另立一份长期规范，约束之后的全部新增内容。实施期间用户再追加两项：新增测试文件按被测功能命名、不使用编号文件名；两处涉及 `src` 的判断经用户确认——小红书 `ChromeLaunch.context` 的类型收窄保留（纯类型改动），抖音 `ACTION_SCHEMAS` 不为取键联合而修改源码。

## 1. 范围

做：

- 新增 `yootun` 测试类型门禁 `yootun/scripts/typecheck-tests.mjs`：按官方聚合程序的方式对 `yootun` 的测试做一次 `tsc -b`（组成见 2.1）。
- 在 `.github/workflows/yootun-desktop-package.yml` 的「Build yootun packages」之后加一步运行门禁。
- 修复门禁查出的全部存量类型错误（建单时实测 451 条、55 个文件，分布见 2.2）。
- `managed-mcp` 的三条自愈用例（S2、S3、S4）改用监督器已有的 `DelayScheduler` 注入缝，断言申请的延迟，不再度量真实时间（见 2.3）。
- 门禁增加两项检查：测试文件必须位于 `tests/` 目录；压制类型的写法（见 2.4、2.5）。
- 新增长期规范 `yootun/docs/test-type-safety-standard.md`，约束之后的全部新增内容，并在 `yootun/AGENTS.md`「构建与测试」与 `yootun/OVERVIEW.md`「护栏文档」登记（约束点见 2.6）。
- `yootun/scripts/self-test.mjs` 增加两条守护：桌面流程含门禁步骤且位于构建 `yootun` 包之后；护栏文档清单含本规范。
- 门禁运行时生成模块增强载体文件，把所选包 `src/**` 的空类型导入带入聚合程序（见 2.1）；测试不手工补这类导入。
- 新增测试文件按被测功能命名、不使用编号文件名的约定，写入 `yootun/AGENTS.md`「构建与测试」与 [cross-repo-sync.md](../../cross-repo-sync.md) 第四节「实施单」。

不做：

- 官方聚合配置（`tsconfig.host.json`、`tsconfig.client.json`、`tsconfig.base.json`、`tsconfig.base.client.json`）与 `pnpm run typecheck`。
- 生产代码（`src`）的行为，以及测试的断言与被测行为；类型错误暴露出测试接线与真实签名不一致时逐条判断，记入 5.3。
- tools.dofe.ai、docker-helm.dofe.ai 的任何改动。
- 类型错误的豁免清单：存量一次修完，门禁对类型错误不设基线。压制写法的存量（`as never` 61 处、`as unknown as` 16 处）不在本单清理，按 2.4 只降不升。
- 官方对 `as unknown` 的全仓门禁（`verify-no-unknown-casts`）及其基线。
- 抖音 `ACTION_SCHEMAS` 的宽类型注解与派发处的按键取值：给测试取值辅助函数提供键联合需要改这两处源码，超出本单边界；写错键名由辅助函数在运行测试时抛错暴露。
- 文本检查不追踪用别名、工具类型拼出的顶层类型（如 `NonNullable<unknown>`）与经函数封装的类型转换，规范「检查范围」一节写明由 review 把关。

## 2. 契约增量

MCP 工具、Host action、路由、稳定码：无变化。

### 2.1 门禁的组成

门禁每次运行时读取官方配置生成一份聚合 tsconfig（不落库），再用仓库自带的 `tsc -b` 检查。

| 项 | 取值 | 依据 |
|---|---|---|
| 程序面 | 单一面：`tsconfig.base.client.json` 加 `types` 的 `node`、`client-build-environment`、`client-assets` | `yootun` 含客户端代码的插件用同一口径检查全部源码，宿主与客户端代码同处一个程序 |
| `references` | 官方宿主聚合与客户端聚合的 `references` 并集（建单时 440 个），加 `yootun` 的 13 个包项目 | 被引用项目的源码一律重定向到已生成的声明文件，不内联编译；官方清单由上游维护，这里只读取 |
| `paths` | `tsconfig.base.json` 的 619 条，加 `@yootun/<包名>` 指向该包的 `src` | `@yootun/*` 与官方包同构，避免同一类型的源码与声明两个身份并存 |
| `include` | `yootun/**/tests/**/*.{ts,tsx,mts,cts}`（不含 `node_modules`）、`yootun/**/src/css-modules.d.ts` 与运行时生成的模块增强载体文件；合入时 91 个文件（测试与辅助 82、CSS Modules 声明 8、载体 1） | 测试、辅助文件、CSS Modules 声明与模块增强载体 |
| 生成位置 | `node_modules/.cache/yootun-typecheck-tests/`：聚合配置 `tsconfig.json`（`--package` 时为 `tsconfig.<包名组合>.json`），载体文件 `augmentations*.ts` 同目录 | 含机器相关的绝对路径，不入库；文件名带包名组合，并行运行互不覆盖 |
| 前置条件 | 官方产物与 `yootun` 包均已构建 | 被引用项目要读已生成的声明；流程里排在构建之后 |
| 输出 | 先按包汇总，再逐条列出错误首行；`--verbose` 输出 tsc 原文 | 存量有数百条，原文含多行细节 |

脚本支持 `--package <包目录名>`：只检查该包的测试文件，引用不变，供单包修复时快速核对。

模块增强载体：`tsc` 生成声明文件时丢弃 `import type {} from '…'`，被引用项目的源码重定向到声明文件后，官方包经声明合并加到 cordis `Context` 上的成员（`locale`、`slots` 等）在门禁程序里缺席。门禁每次运行把所选各包 `src/**` 里全部空类型导入的说明符（去重、排序）写进载体文件并加入 `include`，全量模式取全部包，`--package` 模式只取所选包。

### 2.4 压制类型的写法

门禁只报告类型错误；用类型断言或注释指令把错误压住，门禁照样通过，测试却仍没有类型保护。存量里已有 `as never` 61 处、`as unknown as` 16 处、`@ts-expect-error` 3 处。门禁对 `yootun/**/tests/**` 另做文本检查：

| 写法 | 规则 | 建单时存量 |
|---|---|---|
| `@ts-ignore`、`@ts-nocheck` | 禁止。行注释与块注释（含 JSDoc 形态）开头紧跟的指令字样都算，位置不限 | 0 |
| `any` 类型 | 任何形式都禁止：`as any`、`: any`、`<any>x`、`Array<any>`、`Record<string, any>` 等 | 0 |
| `@ts-expect-error` | 只在 `tests/types/` 下的类型层断言文件里可用，在指令所在行、指令之后用 `--` 写明原因 | 3，均在 `dsh-workbench-host-kit/tests/types/route-types.ts` |
| `as never`（含 `<never>x`）、两段式断言 | 按包、按文件记基线，只能下降；下降时在同一改动里下调基线 | 61、16 |

基线文件是 `yootun/scripts/typecheck-tests.baseline/<包目录名>.json`，按包拆分是为了并行修改不同包时互不相干；没有基线文件的包按零计。 基线的两类键是 `as never` 与 `两段式断言`；合入时只有三个包有基线文件（`dsh-wx-channels-workbench` 56 与 6、`dsh-xhs-workbench` 6、`dsh-media-upload` 4）。

两段式断言指被断言表达式本身又是断言、且内层断言目标是 `unknown`、空 `{}`、`object` 或含这些类型任一成员的联合，含尖括号拼法；一段式的向上转型不计数。文本检查按语法树判定，只认这些直接写法：用别名、工具类型拼出的顶层类型（如 `NonNullable<unknown>`）与经函数封装的转换不在检查范围，由 review 对照规范「检查范围」一节把关；一段式 `as unknown`、`<unknown>` 由官方 `verify-no-unknown-casts` 的基线兜底。

### 2.5 游离的测试文件

门禁的覆盖范围按目录划定。`yootun` 下文件名匹配 `*.test.*` 或 `*.spec.*` 而不在 `tests/` 目录里的文件不在覆盖范围内，门禁直接失败并列出路径。`tests/` 下扩展名不做类型检查的测试文件（`.js`、`.jsx`、`.mjs`、`.cjs`）同样失败；`tests/` 下的 `.mts`、`.cts` 进聚合程序，`.mjs` 辅助脚本不做类型检查。

### 2.6 规范的约束点

`yootun/docs/test-type-safety-standard.md` 面向之后在本分区新增或修改代码的人与智能体，逐条写明：

- `pnpm run typecheck` 不覆盖 `yootun` 的测试，测试的类型检查只有本门禁；提交前按包运行，CI 在构建之后运行。
- 新增测试、辅助文件、包自动纳入，不需要登记；测试文件必须放在 `tests/` 目录。
- 测试底盘按真实类型写：假对象用 `satisfies` 对齐真实类型；按键取处理函数用有类型的取值辅助函数；辅助函数的参数注解与实际用法一致。
- 2.4 的禁用与限用写法；类型错误的处置是修类型，不是压住。
- 源码改名或改签名时同步测试；新增 `yootun` 包与新增流程时的检查清单。
- 门禁步骤不可删除：`self-test.mjs` 守护流程里的步骤与护栏文档清单里的链接。
- 模块增强载体由门禁自动带入，测试不手工补 `import type {} from '…'`。
- 文本检查的检查范围：别名与工具类型拼法、经函数封装的转换不在检查范围，由 review 把关。

### 2.2 存量（建单时实测）

门禁原型对 11 个包报 451 条错误，全部位于测试与辅助文件；官方源码、`vendor` 与 `yootun` 的 `src` 零报错。

| 包 | 错误 | 文件 |
|---|---|---|
| `dsh-douyin-workbench` | 255 | 21 |
| `dsh-wx-channels-workbench` | 63 | 9 |
| `dsh-xhs-workbench` | 61 | 12 |
| `dsh-media-upload` | 36 | 2 |
| `dsh-client-ui-access` | 15 | 2 |
| `dsh-client-report` | 7 | 2 |
| `dsh-client-ui-kit` | 7 | 3 |
| `dsh-managed-mcp` | 3 | 1 |
| `dsh-workbench-mcp` | 2 | 1 |
| `dsh-client-workbench-machines` | 1 | 1 |
| `dsh-workbench-host-kit` | 1 | 1 |

按成因分四类：

| 类别 | 条数 | 典型形态 | 修法 |
|---|---|---|---|
| 按键或下标取值后直接使用 | 209 | `handlers['works.list']({...})`，`Record` 按键取值可能为 `undefined` | 测试底盘提供有类型的取值函数，取不到即抛错 |
| 假对象与调用同真实签名不一致 | 161 | 辅助函数的参数注解写成 `Promise` 而实际按函数调用；函数已是 3 个必填参数而用例只传 2 个；解构返回值里不存在的属性 | 逐条判断：注解错的改注解；接线与真实签名不一致的按真实签名补齐 |
| 未使用的变量与导入、隐式 `any` | 54 | `TestContext` 导入未使用；回调参数无类型 | 删除或补类型 |
| 其余 | 27 | 引用了不存在的导出、找不到名称等 | 逐条判断 |

### 2.3 自愈用例的时钟

S2、S3、S4 以真实时钟量两段间隔（窗口分别是 850–1800ms、1700–2900ms），机器负载高时会漂出窗口（2026-11-28 一次 review 中实测第二次延迟 3286ms）。三条用例改为经 `bootSupervisor` 注入受控的 `DelayScheduler`：调度器记录申请的延迟，由用例显式触发；断言改为精确值。退避随机源固定返回 0.5（乘数公式 `0.8 + random() * 0.4` 在 0.5 时恰为 1）时，首次自愈申请 1000ms，第二次申请 2000ms；`connected` 复位后回到 1000ms；`dispose` 后待触发的重建被取消。监督器与生产代码不变。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env / URL |
| yootun-agent | `yootun/scripts/typecheck-tests.mjs`（新） | 门禁脚本：聚合检查、模块增强载体、按包汇总、`--package`、按语法树的文本检查、基线与覆盖范围检查 | 是 | 2.1、2.4、2.5 |
| yootun-agent | `yootun/scripts/typecheck-tests.baseline/<包目录名>.json`（新） | 压制写法基线 | 是 | 2.4 |
| yootun-agent | `yootun/scripts/self-test.mjs` | 流程步骤与护栏文档清单的守护，门禁文本检查的表驱动用例 | 是 | 2.6 |
| yootun-agent | `yootun/docs/test-type-safety-standard.md`（新）、`yootun/AGENTS.md`、`yootun/OVERVIEW.md` | 规范与登记 | 是 | 2.6 |
| yootun-agent | `.github/workflows/yootun-desktop-package.yml` | 「Build yootun packages」之后加一步 | 是 | 2.1 |
| yootun-agent | 11 个包的 `tests/**`（55 个文件） | 存量类型修复 | 是 | 2.2 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/tests/managed-mcp.test.ts` | S2–S4 改用受控时钟 | 是 | 2.3 |
| yootun-agent | `yootun/plugins/dsh-xhs-workbench/src/chrome.ts` | `ChromeLaunch.context` 的类型收窄为 `XhsBrowserContext`，纯类型改动 | 是 | 小红书测试需要注入 fake context |
| yootun-agent | `yootun/AGENTS.md`「构建与测试」、[cross-repo-sync.md](../../cross-repo-sync.md) 第四节 | 测试文件命名约定 | 是 | 用户 2026-11-28 追加 |
| yootun-agent | [1128 索引](../00-overview.md) | 登记本单 | 是 | 当天建单 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文） | 2026-11-28 | `main` | 草案；同日回填验收记录 |
| 特性分支 | 2026-11-28 | `feat/yootun-test-type-gate` | 开发完成，自动验收通过（5.3）；存量修复与门禁本体分批提交 |
| 合入 `main` | | | 待用户确认后合入并推送 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行）

- [x] `node yootun/scripts/typecheck-tests.mjs` 退出码 0，零错误；
- [x] 变异验证：临时引入一处类型错误、一处 `as never`、一个不在 `tests/` 目录的测试文件，门禁分别必须失败；
- [x] `node --test yootun/scripts/self-test.mjs` 通过；
- [x] 11 个包的 `test` 全部通过，用例数与修复前一致（对照表见 5.3）；
- [x] 受影响包的 `build` 通过；仓库级 `pnpm run lint`、`pnpm run typecheck`、`git diff --check`；
- [x] 流程改动的 YAML 可解析，步骤顺序在构建之后（CI 实跑待推送后首次构建）；规范在 `yootun/AGENTS.md` 与 `yootun/OVERVIEW.md` 的登记到位；
- [x] 每个代码阶段独立 review 通过，阻断 0 条（阶段 1 的最后一轮增量由主控探针复测）。

### 5.2 真机验收（用户执行）

本单不改界面与运行时行为，没有真机验收项。发版后抽查三个工作台与会话正常即可。

### 5.3 本地联调记录

2026-11-28 在特性分支 `feat/yootun-test-type-gate` 上完成，自动验收全部通过；合入 `main` 与推送待用户确认。

存量修复（类型错误为门禁报出的条数，修复前为建单时；用例数为修复前后一致的 node --test 与 vitest 条数）：

| 包 | 类型错误（修复前 → 后） | 用例数 |
|---|---|---|
| `dsh-douyin-workbench` | 255 → 0 | 227 + 178 |
| `dsh-wx-channels-workbench` | 63 → 0 | 128 + 118 |
| `dsh-xhs-workbench` | 61 → 0 | 135 + 39 |
| `dsh-media-upload` | 36 → 0 | 45 + 12 |
| `dsh-client-ui-access` | 15 → 0 | 20 + 5 |
| `dsh-client-report` | 7 → 0 | 41 |
| `dsh-client-ui-kit` | 7 → 0 | 88 |
| `dsh-managed-mcp` | 3 → 0 | 24 |
| `dsh-workbench-mcp` | 2 → 0 | 32 |
| `dsh-workbench-host-kit` | 1 → 0 | 26 |
| `dsh-client-workbench-machines` | 1 → 0 | 20 |
| 合计 | 451 → 0 | — |

`src/` 的改动只有一处：小红书 `src/chrome.ts` 把 `ChromeLaunch.context` 的类型收窄为 `XhsBrowserContext`，只有类型注解与 `import type`，改动前后编译出的 JavaScript 去掉注释后逐字节相同。

按 1「不做」逐条判断过的接线修正（断言均未改动）：

- ui-report 的 P11 用例原先被 `openDetail` 覆盖了 mock 实现，靠竞态通过；按用例本意在 `openDetail` 之后重新挂上请求实现。
- ui-access 的 G1、G2 用例原有 20ms 真实时钟等待，机器满载时偶发失败；改为条件轮询，10 次连跑全过。
- 抖音 `batch-concurrency` 的 B6b 用例调用了假对象上不存在的 `workbench.callTool`；按真实接线改为 `workbench.face.callTool`。
- 视频号 `dispose`、`profile-lock`、`runs` 三个底盘的 `entered` 注解写成 `Promise<void>`，实际传入并按函数调用；注解改为函数类型。
- 视频号 `host` 的 5 处 `buildRouteHandlers` 调用补必需的第三参 `CollectController`，用例测的是不消费 collect 的 action，执行路径不变。
- 小红书 `host` 的假 handler 返回体 `status: 'ok'` 改为类型约束的 `'ready'`，没有断言读响应体。
- 媒体上传 T1 用例的假请求体从 `Readable` 改为参数类型要求的 `IncomingMessage`。

门禁在 review 与通读中查出并修复的问题（每项先实测复现，修复后补自测）：`@ts-nocheck` 未被拦截；行注释指令只在文件开头被判定；块注释形态的指令（`/* @ts-ignore */`、JSX 子节点的 `{/* @ts-ignore */}`）漏判；两段式断言经 `{}`、`object`、联合的拼法与尖括号写法 `<never>x` 绕过基线；多行块注释把 `--` 写在指令之前的行可绕过 `@ts-expect-error` 的原因检查。

门禁的最终一轮对抗性 review 由 reviewer 自构 105 条形态，没有「tsc 压掉错误而门禁放行」的违例，阻断 0 条；其后的增量（两段式断言桶、`--` 位置、桥类型的联合形态）由主控用 61 个探针复测通过。

全量验收（2026-11-28，全部真实执行）：

| 命令 | 结果 |
|---|---|
| `node yootun/scripts/typecheck-tests.mjs` | 91 个文件，类型错误 0 条，压制写法合规，无游离文件，退出码 0 |
| `node --test yootun/scripts/self-test.mjs` | 22 条全过 |
| 11 个包的 `pnpm --filter <pkg> test` | 全部通过，用例数见上表 |
| `pnpm run lint`、`pnpm run typecheck`、`git diff --check` | 退出码均为 0（typecheck 5 道门全过） |

已知边界：

- `@yootun/<包名>/client` 这类子路径导入在门禁程序里解析不了，会显式报错；当前没有测试这样导入。
- 文本检查不追踪别名与工具类型拼法、经函数封装的转换，由 review 把关。
- 存量测试文件名里的编号（`d2.test.ts` 等 9 个）保持原名，命名约定只约束新增文件。
- 流程里的门禁步骤尚未在 CI 上实跑，推送后的首次构建验证。
- 批次 B 的 review 提了 3 条可选建议未采纳：一处 import 拆成两行；`pngBytes` 在尺寸小于 12 时抛错，现有调用点都不小于 64；一处 `as readonly string[]` 与生产代码写法一致。
