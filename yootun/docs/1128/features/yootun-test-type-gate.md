# infra-yootun-测试类型门禁 实施单

状态：草案 ｜ 创建：2026-11-28 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

来源：2026-11-28 修复 Agent 面状态路由的注册（[managed-mcp-status-route.md](managed-mcp-status-route.md)）时发现：仓库级 typecheck 的两个聚合程序（`tsconfig.host.json`、`tsconfig.client.json`）不含 `yootun/` 下的测试文件，`yootun` 各包的 tsconfig 只含 `src`，`yootun` 的测试文件从未做过类型检查。方案于 2026-11-28 经用户确认：`yootun` 自建聚合类型检查，存量全部修复，代码在特性分支 `feat/yootun-test-type-gate` 上实施。

## 1. 范围

做：

- 新增 `yootun` 测试类型门禁 `yootun/scripts/typecheck-tests.mjs`：按官方聚合程序的方式对 `yootun` 的测试做一次 `tsc -b`（组成见 2.1）。
- 在 `.github/workflows/yootun-desktop-package.yml` 的「Build yootun packages」之后加一步运行门禁。
- 修复门禁查出的全部存量类型错误（建单时实测 451 条、55 个文件，分布见 2.2）。
- `managed-mcp` 的三条自愈用例（S2、S3、S4）改用监督器已有的 `DelayScheduler` 注入缝，断言申请的延迟，不再度量真实时间（见 2.3）。

不做：

- 官方聚合配置（`tsconfig.host.json`、`tsconfig.client.json`、`tsconfig.base.json`、`tsconfig.base.client.json`）与 `pnpm run typecheck`。
- 生产代码（`src`）的行为，以及测试的断言与被测行为；类型错误暴露出测试接线与真实签名不一致时逐条判断，记入 5.3。
- tools.dofe.ai、docker-helm.dofe.ai 的任何改动。
- 豁免清单：存量一次修完，门禁不设基线。

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

脚本支持 `--package <包目录名>`：只检查该包的测试文件，引用不变，供单包修复时快速核对。

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
| yootun-agent | `yootun/scripts/typecheck-tests.mjs`（新） | 门禁脚本 | 是 | 2.1 |
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
- [ ] 变异验证：临时引入一处类型错误，门禁必须失败；
- [ ] 11 个包的 `test` 全部通过，用例数与修复前一致（对照表见 5.3）；
- [ ] 受影响包的 `build` 通过；仓库级 `pnpm run lint`、`pnpm run typecheck`、`git diff --check`；
- [ ] 流程改动的 YAML 可解析，步骤顺序在构建之后（实跑待分支推送后）；
- [ ] 每个代码阶段独立 review 通过，阻断 0 条。

### 5.2 真机验收（用户执行）

本单不改界面与运行时行为，没有真机验收项。发版后抽查三个工作台与会话正常即可。

### 5.3 本地联调记录

待回填。
