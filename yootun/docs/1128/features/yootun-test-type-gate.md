# infra-yootun-测试类型门禁 实施单

状态：草案 ｜ 创建：2026-11-28 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

来源：2026-11-28 修复 Agent 面状态路由的注册（[managed-mcp-status-route.md](managed-mcp-status-route.md)）时发现：仓库级 typecheck 的两个聚合程序（`tsconfig.host.json`、`tsconfig.client.json`）不含 `yootun/` 下的测试文件，`yootun` 各包的 tsconfig 只含 `src`，`yootun` 的测试文件从未做过类型检查。方案于 2026-11-28 经用户确认：`yootun` 自建聚合类型检查，存量全部修复，代码在特性分支 `feat/yootun-test-type-gate` 上实施。同日用户追加要求：另立一份长期规范，约束之后的全部新增内容。

## 1. 范围

做：

- 新增 `yootun` 测试类型门禁 `yootun/scripts/typecheck-tests.mjs`：按官方聚合程序的方式对 `yootun` 的测试做一次 `tsc -b`（组成见 2.1）。
- 在 `.github/workflows/yootun-desktop-package.yml` 的「Build yootun packages」之后加一步运行门禁。
- 修复门禁查出的全部存量类型错误（建单时实测 451 条、55 个文件，分布见 2.2）。
- `managed-mcp` 的三条自愈用例（S2、S3、S4）改用监督器已有的 `DelayScheduler` 注入缝，断言申请的延迟，不再度量真实时间（见 2.3）。
- 门禁增加两项检查：测试文件必须位于 `tests/` 目录；压制类型的写法（见 2.4、2.5）。
- 新增长期规范 `yootun/docs/test-type-safety-standard.md`，约束之后的全部新增内容，并在 `yootun/AGENTS.md`「构建与测试」与 `yootun/OVERVIEW.md`「护栏文档」登记（约束点见 2.6）。
- `yootun/scripts/self-test.mjs` 增加两条守护：桌面流程含门禁步骤且位于构建 `yootun` 包之后；护栏文档清单含本规范。

不做：

- 官方聚合配置（`tsconfig.host.json`、`tsconfig.client.json`、`tsconfig.base.json`、`tsconfig.base.client.json`）与 `pnpm run typecheck`。
- 生产代码（`src`）的行为，以及测试的断言与被测行为；类型错误暴露出测试接线与真实签名不一致时逐条判断，记入 5.3。
- tools.dofe.ai、docker-helm.dofe.ai 的任何改动。
- 类型错误的豁免清单：存量一次修完，门禁对类型错误不设基线。压制写法的存量（`as never` 61 处、`as unknown as` 16 处）不在本单清理，按 2.4 只降不升。
- 官方对 `as unknown` 的全仓门禁（`verify-no-unknown-casts`）及其基线。

## 2. 契约增量

MCP 工具、Host action、路由、稳定码：无变化。

### 2.1 门禁的组成

门禁每次运行时读取官方配置生成一份聚合 tsconfig（不落库），再用仓库自带的 `tsc -b` 检查。

| 项 | 取值 | 依据 |
|---|---|---|
| 程序面 | 单一面：`tsconfig.base.client.json` 加 `types` 的 `node`、`client-build-environment`、`client-assets` | `yootun` 含客户端代码的插件用同一口径检查全部源码，宿主与客户端代码同处一个程序 |
| `references` | 官方宿主聚合与客户端聚合的 `references` 并集（建单时 440 个），加 `yootun` 的 13 个包项目 | 被引用项目的源码一律重定向到已生成的声明文件，不内联编译；官方清单由上游维护，这里只读取 |
| `paths` | `tsconfig.base.json` 的 619 条，加 `@yootun/<包名>` 指向该包的 `src` | `@yootun/*` 与官方包同构，避免同一类型的源码与声明两个身份并存 |
| `include` | `yootun/**/tests/**/*.{ts,tsx}`（不含 `node_modules`）与 `yootun/**/src/css-modules.d.ts`，建单时 80 个文件 | 测试、辅助文件与 CSS Modules 声明 |
| 生成位置 | `node_modules/.cache/yootun-typecheck-tests/tsconfig.json` | 含机器相关的绝对路径，不入库 |
| 前置条件 | 官方产物与 `yootun` 包均已构建 | 被引用项目要读已生成的声明；流程里排在构建之后 |
| 输出 | 先按包汇总，再逐条列出错误首行；`--verbose` 输出 tsc 原文 | 存量有数百条，原文含多行细节 |

脚本支持 `--package <包目录名>`：只检查该包的测试文件，引用不变，供单包修复时快速核对。

### 2.4 压制类型的写法

门禁只报告类型错误；用类型断言或注释指令把错误压住，门禁照样通过，测试却仍没有类型保护。存量里已有 `as never` 61 处、`as unknown as` 16 处、`@ts-expect-error` 3 处。门禁对 `yootun/**/tests/**` 另做文本检查：

| 写法 | 规则 | 建单时存量 |
|---|---|---|
| `@ts-ignore`、`as any`、显式 `any` 注解 | 禁止 | 0 |
| `@ts-expect-error` | 只在 `tests/types/` 下的类型层断言文件里可用，同一行写明原因 | 3，均在 `dsh-workbench-host-kit/tests/types/route-types.ts` |
| `as never`、`as unknown as` | 按包、按文件记基线，只能下降；下降时在同一改动里下调基线 | 61、16 |

基线文件是 `yootun/scripts/typecheck-tests.baseline/<包目录名>.json`，按包拆分是为了并行修改不同包时互不相干；没有基线文件的包按零计。

### 2.5 游离的测试文件

门禁的覆盖范围按目录划定。`yootun` 下文件名匹配 `*.test.*` 或 `*.spec.*` 而不在 `tests/` 目录里的文件不在覆盖范围内，门禁直接失败并列出路径。

### 2.6 规范的约束点

`yootun/docs/test-type-safety-standard.md` 面向之后在本分区新增或修改代码的人与智能体，逐条写明：

- `pnpm run typecheck` 不覆盖 `yootun` 的测试，测试的类型检查只有本门禁；提交前按包运行，CI 在构建之后运行。
- 新增测试、辅助文件、包自动纳入，不需要登记；测试文件必须放在 `tests/` 目录。
- 测试底盘按真实类型写：假对象用 `satisfies` 对齐真实类型；按键取处理函数用有类型的取值辅助函数；辅助函数的参数注解与实际用法一致。
- 2.4 的禁用与限用写法；类型错误的处置是修类型，不是压住。
- 源码改名或改签名时同步测试；新增 `yootun` 包与新增流程时的检查清单。
- 门禁步骤不可删除：`self-test.mjs` 守护流程里的步骤与护栏文档清单里的链接。

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

S2、S3、S4 以真实时钟量两段间隔（窗口分别是 850–1800ms、1700–2900ms），机器负载高时会漂出窗口（2026-11-28 一次 review 中实测第二次延迟 3286ms）。三条用例改为经 `bootSupervisor` 注入受控的 `DelayScheduler`：调度器记录申请的延迟，由用例显式触发；断言改为精确值。抖动系数固定为 1 时，首次自愈申请 1000ms，第二次申请 2000ms；`connected` 复位后回到 1000ms；`dispose` 后待触发的重建被取消。监督器与生产代码不变。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env / URL |
| yootun-agent | `yootun/scripts/typecheck-tests.mjs`（新） | 门禁脚本：聚合检查、按包汇总、`--package`、压制写法与游离测试文件检查 | 是 | 2.1、2.4、2.5 |
| yootun-agent | `yootun/scripts/typecheck-tests.baseline/<包目录名>.json`（新） | 压制写法基线 | 是 | 2.4 |
| yootun-agent | `yootun/scripts/self-test.mjs` | 流程步骤与护栏文档清单的守护 | 是 | 2.6 |
| yootun-agent | `yootun/docs/test-type-safety-standard.md`（新）、`yootun/AGENTS.md`、`yootun/OVERVIEW.md` | 规范与登记 | 是 | 2.6 |
| yootun-agent | `.github/workflows/yootun-desktop-package.yml` | 「Build yootun packages」之后加一步 | 是 | 2.1 |
| yootun-agent | 11 个包的 `tests/**`（55 个文件） | 存量类型修复 | 是 | 2.2 |
| yootun-agent | `yootun/plugins/dsh-managed-mcp/tests/managed-mcp.test.ts` | S2–S4 改用受控时钟 | 是 | 2.3 |
| yootun-agent | [1128 索引](../00-overview.md) | 登记本单 | 是 | 当天建单 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文） | 2026-11-28 | `main` | 草案 |
| 特性分支 | 2026-11-28 | `feat/yootun-test-type-gate` | 代码在分支上实施，分阶段提交 |
| 合入 `main` | | | 待验收通过 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行）

- [ ] `node yootun/scripts/typecheck-tests.mjs` 退出码 0，零错误；
- [ ] 变异验证：临时引入一处类型错误、一处 `as never`、一个不在 `tests/` 目录的测试文件，门禁分别必须失败；
- [ ] `node --test yootun/scripts/self-test.mjs` 通过；
- [ ] 11 个包的 `test` 全部通过，用例数与修复前一致（对照表见 5.3）；
- [ ] 受影响包的 `build` 通过；仓库级 `pnpm run lint`、`pnpm run typecheck`、`git diff --check`；
- [ ] 流程改动的 YAML 可解析，步骤顺序在构建之后（实跑待分支推送后）；规范在 `yootun/AGENTS.md` 与 `yootun/OVERVIEW.md` 的登记到位；
- [ ] 每个代码阶段独立 review 通过，阻断 0 条。

### 5.2 真机验收（用户执行）

本单不改界面与运行时行为，没有真机验收项。发版后抽查三个工作台与会话正常即可。

### 5.3 本地联调记录

待回填。
