# client-工作台页面状态机拆分 实施单

状态：草案（待审查） ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音与视频号的页面组件 `WorkbenchPage.tsx` 各自是一个单体：

| 文件 | 行数 | `useState` | `useRef` | `useCallback` | 页面内直接调用 Host |
|---|---|---|---|---|---|
| 抖音 `src/client/WorkbenchPage.tsx` | 901 | 35 | 20 | 26 | 18 处 |
| 视频号 `src/client/WorkbenchPage.tsx` | 683 | 27 | 18 | 21 | 15 处 |

登录、单账号采集、批量采集、作品查询、挂载恢复五条数据流的状态与副作用全部写在同一个组件作用域里，靠 18–20 个 ref 互相守卫（请求序号、选中账号快照、是否已发起、恢复是否完成）。两份实现的分段注释一一对应（作品列表 / 登录流 / 单账号采集 / 批量采集 / 挂载恢复 / 刷新），逻辑同构但各自维护；改一条流要在两个文件里各改一遍，并重新推演它与另外四条流的 ref 交互。

小红书在迁移时采用了另一种组织方式：数据流是不依赖 React 的 machine（`src/client/accounts-machine.ts`、`hotboard-machine.ts`、`task-machine.ts` 与 `src/upload-machine.ts`），页面用 `useSyncExternalStore` 订阅。machine 只依赖注入的 `ports`（几个返回 Promise 的函数与定时器），可以用 `node --test` 配合假 ports 与假时钟做确定性的竞态测试，不需要 jsdom。

另有两处小问题：

- 语言标签靠字符串比较得出：`localeTagOf(t)` 判断 `t('panel') === zhDict.panel`。只要某个键的中英文取值相同（例如品牌名），标签就会判错，数值与日期格式随之切到另一种语言；官方 locale 支持 8 种语言，非中英文界面回落到英文词典时该判断恰好成立，但这是巧合而不是保证。
- 抖音 `attemptId()`（幂等键后缀）定义并导出自页面组件模块 `AnalysisPage.tsx`，被爆款拆解、基因、素材、报表、排期 5 个页面跨模块引用。

### 0.2 目标

抖音与视频号的五条数据流改为 machine，页面组件回到布局与组合；两份同构 machine 的核心上移为共享的纯 client 包，各插件只保留把 Host 响应映射成通用视图的适配层。语言标签取自 locale 服务的当前语言 id。现有页面级行为不变，既有 client 测试全部原样通过。

## 1. 范围

做：

- 新建纯 client 包 `@yootun/dsh-client-workbench-machines`（无 React、无 DOM 依赖）：登录、单账号采集、批量采集、作品查询四个 machine 的核心；
- 抖音、视频号各自实现 `ports` 适配层（把 `hostAction` 的 action 名与响应投影接到 machine），`WorkbenchPage` 拆为组合层，挂载恢复改为对各 machine 调 `restore(...)`；
- 页面规模目标：两个 `WorkbenchPage.tsx` 各不超过 350 行，组件内 hook 调用各不超过 20 个；
- `localeTagOf` 改为语言 id 的纯函数，页面经 slot 注入拿到 locale 服务的快照；三个工作台同步替换；
- 抖音 `attemptId` 迁到 `format.ts`。

不做：

- 不改小红书的四个 machine（已经是目标形态；它的「采集全部」排期时再评估迁到共享 machine）；
- 不改任何 Host action、路由或 tools 契约；
- 不改页面布局、文案与交互；
- 不引入状态管理库；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 包 `@yootun/dsh-client-workbench-machines`

位置 `yootun/packages/dsh-client-workbench-machines`，ESM，`exports` 为 `.` 与 `./package.json`；`build` 为 `tsc -p tsconfig.json && tsdown`；`test` 为 `node --test tests/*.test.ts`。抖音、视频号以 `devDependencies`（`workspace:*`）引用，由官方 `clientBundle` 内联进 client bundle，不新增运行时外部依赖。

| 模块 | 导出 |
|---|---|
| `login-machine.ts` | `createLoginMachine(ports)`、`LoginMachine`、`LoginState` |
| `collect-machine.ts` | `createCollectMachine(ports)`、`CollectMachine`、`CollectState` |
| `batch-machine.ts` | `createBatchMachine(ports)`、`BatchMachine`、`BatchState` |
| `works-query.ts` | `createWorksQuery(ports)`、`WorksQuery`、`WorksQueryState` |
| `polling.ts` | `createPoller({ schedule, cancel, intervalMs })`：单飞轮询，上一拍未返回不发下一拍 |
| `guards.ts` | `createLatest()`：序号守卫，过期的异步结果被丢弃 |
| `types.ts` | 通用视图类型与 `Ports` 接口 |

### 2.2 machine 通用形态

```ts
interface Machine<State> {
  get(): State
  subscribe(listener: () => void): () => void
}
```

每个 machine 另有自己的命令方法。`get()` 在状态变化时返回新的对象引用，未变化时返回同一引用（`useSyncExternalStore` 的要求）。

### 2.3 ports

| machine | ports | 说明 |
|---|---|---|
| 登录 | `begin(args?) → Promise<LoginView>`、`status(key) → Promise<LoginView>`、`pollIntervalMs`、`poller` | 轮询到终态或 `idle` 停止，经 `onSettled(view)` 通知页面 |
| 单账号采集 | `start(accountId, options) → Promise<StartResult>`、`status(accountId) → Promise<CollectView \| null>`、`running() → Promise<{ accountId: string } \| null>`、`cancel(accountId)`、`pollIntervalMs`、`poller` | 维护按账号的记录与 `runningAccountIds`；启动走乐观运行态，Host 报「记录已丢」时清乐观态 |
| 批量采集 | `start()`、`status() → Promise<BatchView \| null>`、`cancel()`、`pollIntervalMs`、`poller` | 终态后通知 `onFinished(summary)` |
| 作品查询 | `list(query) → Promise<WorksPage>`、`pageSize` | 缓存键 = 账号 \| 排序 \| 方向 \| 页；命中缓存先出缓存再后台刷新；过期响应整体丢弃 |

`LoginView` / `CollectView` / `BatchView` / `WorksPage` 是通用视图类型，各插件现有的 `schema.ts` 读取函数（`readLogin`、`readCollectStatus`、`readBatchStatus`、`readWorksPage`）就是适配层的实现。

### 2.4 页面 props

`WorkbenchPageProps` 由 `{ t }` 变为 `{ t, locale }`，其中 `locale: { subscribe(fn): () => void; getSnapshot(): { active: string } }` 由各插件 `client/index.ts` 的 slot `inject` 提供（绑定 `ctx.locale`）。`format.ts` 新增：

```ts
export function localeTagOf(activeLocaleId: string): 'zh' | 'en'
```

以 `zh` 开头的语言 id 返回 `zh`，其余返回 `en`。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/packages/dsh-client-workbench-machines/`（新） | 包、七个模块与 `index.ts`、测试 | 是 | 本单主体 |
| yootun-agent | `pnpm-lock.yaml` | 新 workspace 包的锁记录 | 是 | workspace glob 已登记（[inline-changes.md](../../inline-changes.md) #1） |
| yootun-agent | 抖音、视频号 `src/client/WorkbenchPage.tsx` | 拆为组合层；五条数据流迁出 | 是 | 本单主体 |
| yootun-agent | 抖音、视频号 `src/client/flows.ts`（新） | ports 适配层与 machine 实例的创建 | 是 | Host 差异隔离在此 |
| yootun-agent | 三插件 `src/client/{index,WorkbenchPage,format}.ts(x)` | `locale` 注入、`localeTagOf` 替换 | 是 | 语言判定收口 |
| yootun-agent | 抖音 `src/client/{AnalysisPage,format,index}.ts(x)` 及 5 个引用页 | `attemptId` 迁移 | 是 | 工具函数归位 |
| yootun-agent | 抖音、视频号 `tests/client/*.test.tsx` | 用例的 import 路径随迁移调整，断言不变；新增 machine 单测 | 是 | 行为不变的证据 |
| yootun-agent | `yootun/docs/plugin-ui-ux-standard.md` §8.1 | 组件分层表增加「数据流 machine」一行 | 是 | 分层规则补充 |
| yootun-agent | `yootun/OVERVIEW.md` 目录结构表 | 登记新包 | 是 | 分区导航 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + UI 规范 §8.1 + OVERVIEW + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/client-workbench-hooks` | 待填，分三步合入（见附录 A0） |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-client-workbench-machines test`、`build` 通过；
- [ ] 抖音、视频号 `pnpm --filter <pkg> test`、`build` 通过；**既有 client 用例的断言零改动**（只允许改 import 路径）；
- [ ] `pnpm run lint`、`pnpm run verify-export-jsdoc`、`pnpm run verify-client-ui-i18n`；
- [ ] `wc -l` 两个 `WorkbenchPage.tsx` 均 ≤ 350；`grep -c "use(State\|Ref\|Callback\|Effect\|Memo)"` 均 ≤ 20；
- [ ] `grep -rn "localeTagOf(t)" yootun/plugins/*/src/client` 结果为空（旧的两参数判定已无调用方）；
- [ ] 附录 B 用例全部存在并通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| M1 | 抖音、视频号：新增账号扫码登录，等待确认页出现，扫码确认 | 状态卡流转与提示与之前一致；登录完成后账号列表刷新并选中 |
| M2 | 单账号采集进行中切到别的 Tab 再切回；再试切到别的工作台再切回 | 进度继续显示，不重复启动 |
| M3 | 采集进行中退出应用重开 | 不显示运行中；提示上次采集被中断 |
| M4 | 视频号、抖音「采集全部」运行中切账号、切 Tab | 面板数字持续更新，账号栏状态点正确 |
| M5 | 作品列表快速连点排序与翻页、采集途中切账号 | 不出现旧账号的数据闪回；最终显示与所选排序一致 |
| M6 | 把界面语言切到 English 再切回中文 | 三个工作台的数值、日期格式随之切换， kit 组件文案同步 |

### 5.3 本地联调记录

待填（合入前回填；需记录 locale 快照在语言切换时 `getSnapshot()` 返回新引用的实测结果）。

## 附录 A：逐文件规格

### A0 落地顺序（三步，各自独立合入）

1. 抖音：在插件内建 `src/client/flows.ts`，把登录、单账号采集、批量采集、作品查询写成 machine，`WorkbenchPage` 改为消费；此步不建包；
2. 视频号：同样在插件内落 machine。两份写完后对照，核心一致的部分上移为 `@yootun/dsh-client-workbench-machines`，两插件改为消费并删除本地核心；
3. `localeTagOf` 与 `attemptId` 的收口（与第 2 步无依赖，可并行）。

每一步以「既有 client 测试断言零改动且通过」为合入条件；任一步做不到即停下回退该步，不带着差异进入下一步。

### A1 machine 要点

- 状态更新统一经一个 `set(next)`：浅比较无变化则不通知；
- 轮询一律经 `createPoller`：`tick` 在途时忽略新的触发，`stop()` 清定时器；组件卸载与 machine `dispose()` 都调用 `stop()`；
- 所有异步结果经 `createLatest()` 的序号守卫：发起时取号，返回时号不匹配即丢弃；
- 挂载恢复：`collect.restore({ running, selected })`、`batch.restore()` 各自处理自己的恢复查询，页面只负责在「账号列表就绪且选中账号确定」时调用一次；「用户已发起则丢弃恢复结果」的守卫在 machine 内（`start()` 使恢复代次失效）。

### A2 抖音、视频号 `src/client/flows.ts`

- `createDouyinFlows()` / `createWxFlows()`：以 `hostAction` 构造 ports，返回 `{ login, collect, batch, works }` 四个 machine；
- 现有 `schema.ts` 读取函数保持不动，直接作为 ports 的响应投影；
- 现有页面里的 ref 守卫（`collectInitiatedRef`、`batchInitiatedRef`、`collectRestoreDoneRef`、`worksSeqRef` 等）随数据流迁入 machine，页面不再持有。

### A3 locale 与 `attemptId`

- 三插件 `client/index.ts`：slot `inject` 返回 `{ t, locale: ctx.locale }`；
- `WorkbenchPage.tsx`：`const active = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot).active`；`localeTagOf(active)`；
- `format.ts`：新增 `localeTagOf(activeLocaleId)`；抖音新增 `attemptId()`（自 `AnalysisPage.tsx` 迁入，实现不变），`AnalysisPage.tsx` 改为从 `format.ts` 导入并停止导出该函数。

## 附录 B：测试矩阵

### B.1 machine（`tests/login-machine.test.ts` 等，假 ports + 假时钟）

| ID | 断言 |
|---|---|
| L1 | `begin` 返回后进入轮询；第一拍立即发出，之后每 `pollIntervalMs` 一拍 |
| L2 | 上一拍未返回时定时器到点：不发新请求 |
| L3 | 终态（`ok` / `timeout` / `failed` / `idle`）停轮询并触发一次 `onSettled` |
| L4 | `stop()` 之后迟到的响应不改变状态 |
| C1 | `start` 成功进入运行态；返回 `collect_busy` 等原因时不进入运行态 |
| C2 | 两个账号并发运行时 `runningAccountIds` 为两个；其中一个结束后剩一个 |
| C3 | `status` 返回 `collect === null`（宿主重启丢记录）→ 清乐观态并停该账号轮询 |
| C4 | `restore` 结果到达前用户已 `start` → 恢复结果被丢弃 |
| C5 | `cancel` 后停轮询；终态到达后记录落终态 |
| B1 | 批量运行中每拍 `status` 更新计数；`finished` 后停轮询并触发一次 `onFinished` |
| B2 | `start` 在途时的第二次 `start` 不发请求 |
| W1 | 同一查询键第二次请求先同步返回缓存，再后台刷新 |
| W2 | 账号 A 的请求晚于账号 B 的请求返回 → A 的结果被丢弃 |
| W3 | 请求失败且该账号已有行 → 状态为 `partial`；无行 → `error` |

### B.2 插件 client（既有用例 + 新增）

| ID | 断言 |
|---|---|
| P1 | 抖音、视频号全部既有 client 用例通过，断言未改 |
| P2 | 语言切换：注入 locale 快照由 `zh-CN` 变为 `en` → 页面数值格式由中文切为英文；把 `panel` 的中英文词典值设成相同字符串后判断仍然正确 |
| P3 | `attemptId` 从 `format.ts` 导入可用，输出为 32 位小写 hex |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 数据流组织 | 不依赖 React 的 machine + `useSyncExternalStore`（沿用小红书既有形态） | 自定义 hook（`useLoginFlow` 等）直接持有 `useState` |
| 共享核心的位置 | 新包 `@yootun/dsh-client-workbench-machines` | 放进 `@yootun/dsh-client-ui-kit`（UI 库混入数据流） |
| 落地方式 | 先各插件内落 machine，再上移共享核心 | 一步到位建包 |
| 小红书 | 不动 | 同步迁到共享 machine |
