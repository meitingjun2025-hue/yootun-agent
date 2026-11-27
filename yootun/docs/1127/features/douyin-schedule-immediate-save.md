# douyin-schedule-抖音发布排期看板即时保存修复 实施单

状态：开发完成（2026-11-27，自动验收通过），待合入 ｜ 创建：2026-11-27 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台「发布排期」看板（`yootun/plugins/dsh-douyin-workbench/src/client/SchedulePage.tsx`）的行内控件有两种保存方式。文本类字段（视频内容、成片链接、备注、拍摄负责人、剪辑负责人）每次输入都更新页面状态，失焦时保存。「是否发布」「拍摄情况」两个勾选框、「拍摄日期」「发布日期」两个日期与发布平台的勾选在改动时立即保存。

立即保存从 2026-11-22 看板首次落地起就没有生效，不是 1126 各单引入的。`handleImmediate`（平台勾选经 `handlePlatformToggle` 走同一条路）先调用 `editCell` 更新页面状态，紧接着同步调用 `performSave`。`performSave` 从 `rowsRef.current` 读行数据，而这个 ref 由 `useEffect` 在渲染提交之后才同步，所以读到的是改动前的旧值。随后的 no-op 判定拿旧值与最近一次服务端快照比较，结论是「没有变化」，函数直接返回，`schedule.rowUpdate` 没有发出。

用户在页面上看到的「勾选后进入已发布」是渲染层的分组：已发布组只看行上的本地值与行状态是否为 idle，勾选后行立即进入已发布折叠组；刷新页面后回到服务端的值。

2026-11-27 在 `main` 上复现，结果如下（临时用例，跑完已删）：

| 操作 | `schedule.rowUpdate` 调用次数 | 页面表现 |
|---|---|---|
| 勾选「是否发布」 | 0 | 行进入已发布折叠组，勾选只在页面内存里，没有保存提示 |
| 点「拍摄情况」 | 0 | 勾选只在页面内存里 |
| 勾选发布平台（小红书） | 0 | 勾选只在页面内存里 |
| 改发布日期 | 0 | 日期只在页面内存里 |
| 对照：改剪辑负责人后失焦 | 1 | 正常保存 |

拍摄日期与发布日期走同一个 `onChange` 处理函数，没有单独跑。

同一个原因还有第二个表现：保存在途时继续输入，保存返回后新输入的内容被服务端返回的行覆盖，也没有补提交。`performSave` 在调用时把 `dirtySnapshot` 取进闭包，保存成功后用的仍是这个旧值，保存期间累计的 dirty 快照没有被读到。复现结果：改剪辑负责人为「王五」并失焦触发保存，保存中改成「赵六」，返回后输入框被重置，请求只有 1 次。补提交这条路径此前从未执行到；按代码走读，它发起时 `performSave` 从 ref 读到的行状态仍是保存中的旧状态，请求会带旧的行版本号，真实服务端会返回 `SCHEDULE_ROW_CONFLICT`。[14 册 §6(../../1110/14-douyin-workbench-ui-layout-parity.md) 的行交互契约写的是「保存中的行可继续输入，后续修改进入 queued 快照，保存成功后如仍有差异用新幂等键补提交」，实现与条款不符。

既有用例只覆盖文本字段的保存与失败分支，以及「值不变时失焦不发请求」，没有一条用例操作即时保存控件。

### 0.2 目标

即时保存控件改动后发出保存请求并携带新值；保存在途时的输入在返回后保留并补提交。文本字段的失焦保存、失败重试、放弃修改、删除、新增的行为不变。

## 1. 范围

做：

- `SchedulePage.tsx` 的 `editCell`：更新页面状态的同时同步更新 `rowsRef.current`，让紧随其后的保存读到新值；
- `SchedulePage.tsx` 的 `performSave`：保存成功后重新读取该行当前的 dirty 快照，再决定合并与补提交；发起补提交前，把合并后的行与新的行状态同步写入 `rowsRef` 与 `statesRef`，补提交才会带新的行版本；
- 测试：`tests/client/douyin-client.test.tsx` 的「发布排期看板」用例组补 6 条回归用例（附录 A）；
- [14 册 §6](../../1110/14-douyin-workbench-ui-layout-parity.md) 行交互契约补一句：拍摄情况、是否发布与发布平台的勾选同样在改动时保存。

不做：

- 不改 Host action、tools 契约与数据库：`schedule.rowUpdate` 的入参与出参不变，本单只是让该发的请求发出去；
- 不改文本字段「失焦保存」的触发方式；
- 不改 no-op 判定：值确实没变时仍然不发请求、不递增行版本；
- 不改已发布组的折叠与分组规则。修复后勾选「是否发布」的行先显示保存中，成功后才进入已发布组，这是保存真正生效后的结果，分组代码不动；
- 不清理 `queued` 状态：代码里没有任何地方把行状态置为 `queued`，它是 [14 册 §6](../../1110/14-douyin-workbench-ui-layout-parity.md) 列出的状态之一，本单不动。

## 2. 契约增量

MCP 工具：无。Host action：无变化。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 纯界面修复 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/SchedulePage.tsx` | `editCell` 同步 `rowsRef`；`performSave` 成功后重读 dirty 快照，补提交前同步两个 ref | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/client/douyin-client.test.tsx` | 「发布排期看板」用例组补 6 条回归用例，既有断言不变 | 是 | 行为变化的证据 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §6 | 行交互契约补一句 | 是 | 分册是交互记录 |
| yootun-agent | `yootun/docs/1127/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、1127 索引） | 2026-11-27 | `main` | 建单 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/douyin-schedule-immediate-save` | 独立 review 通过，阻断 0 条；自动验收见 5.1，联调记录见 5.3 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [x] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过；
- [x] 附录 A 的 6 条用例存在并通过；
- [x] 用例确实能抓住缺陷：临时去掉 `editCell` 里对 `rowsRef` 的同步，A1 到 A5 应失败；临时把 `performSave` 改回用调用时捕获的 dirty 快照，A6 应失败；临时去掉补提交前对两个 ref 的同步，A6 也应失败（第二次保存带的是旧行版本）。验证后恢复，结果记入 5.3；
- [x] 「发布排期看板」用例组的既有断言未改，其中「no-op 失焦不发请求」仍然通过。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| S1 | 进入发布排期，勾选一条未发布行的「是否发布」 | 行先显示保存中并出现「保存中」提示，成功后提示「已保存」，行进入已发布组 |
| S2 | 刷新页面 | 该行仍是已发布 |
| S3 | 依次改拍摄情况、拍摄日期、发布日期、发布平台各一次 | 每次都出现保存提示；刷新后值保留 |
| S4 | 改剪辑负责人并失焦，在保存提示消失前继续输入 | 保存返回后输入保留，随后再出现一次保存提示；刷新后是最后输入的值 |
| S5 | 不改任何值，只在文本框聚焦再失焦 | 不出现保存提示 |

### 5.3 本地联调记录

2026-11-27 在 `feat/douyin-schedule-immediate-save` 完成开发与验收，改动三个文件：`SchedulePage.tsx`（`editCell` 同步写 `rowsRef`；`performSave` 成功分支重读 dirty 快照，补提交前同步两个 ref）、`douyin-client.test.tsx`（「发布排期看板」用例组补 A1 到 A6 与四个辅助函数，既有断言零改动）、14 册 §6（补一句）。提交前经独立 review 复核，结论为可以验收，阻断 0 条；review 逐条推演了六种时序（空闲行勾选、保存在途改回、保存在途切账号、失败后同键重试期间继续输入、补提交失败、迟到响应），均正确。

本地验证：`pnpm --filter @yootun/dsh-douyin-workbench test` 通过（Host 侧 node 测试 227 项，vitest 172 项）；`build` 通过。

5.1 第三项的变异验证，每项验证后已恢复：去掉 `editCell` 对 `rowsRef` 的同步，A1 到 A5 失败，`schedule.rowUpdate` 调用 0 次；成功分支改回用调用时捕获的 dirty 快照，A6 失败，调用只有 1 次；去掉补提交前对两个 ref 的同步，A6 失败在行版本断言，第二次保存带的 `expectedVersion` 是 `1` 而不是 `2`。

已知遗留（review 提出，非本单引入，本单不处理）：保存失败后行的 dirty 快照为空，不阻塞账号切换与刷新，此时切走或刷新，未落库的输入会丢。空闲行发起的首次保存失败也是同样的既有模式，行上有同键重试入口。

顺带发现：`yootun/plugins/dsh-douyin-workbench/vitest.config.ts` 头注释写的用例计数已过时，不在本单清单内，未改。

## 附录 A：回归用例

mock 的 `schedule.rowUpdate` 返回行要把 camelCase 入参映射成服务端的 snake_case 字段，并把 `row_version` 加一，与真实服务端的行为一致；用例通过工作台组件渲染，点「创作」组后进入看板。

| ID | 操作 | 断言 |
|---|---|---|
| A1 | 勾选「是否发布」 | `schedule.rowUpdate` 恰好调用一次；入参的 `published` 为真、`expectedVersion` 等于行版本、`idempotencyKey` 以 `douyin:publish_schedule_update:<rowId>:` 开头；成功后行进入已发布组 |
| A2 | 点「拍摄情况」 | 调用一次；入参的 `shootingStatus` 是翻转后的值 |
| A3 | 改拍摄日期 | 调用一次；入参的 `shootingDate` 是新日期 |
| A4 | 改发布日期 | 调用一次；入参的 `publishDate` 是新日期 |
| A5 | 勾选一个未选的发布平台 | 调用一次；入参的 `publishPlatforms` 含该平台，顺序与 `SCHEDULE_PLATFORMS` 一致 |
| A6 | 改剪辑负责人并失焦触发保存，保存返回前再改一次 | 第一次保存返回后输入框保留第二次输入，随后发起第二次保存：入参的 `editingOwner` 是第二次输入，`expectedVersion` 是第一次返回的行版本；共调用两次 |
