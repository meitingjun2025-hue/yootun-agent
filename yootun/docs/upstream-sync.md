# 上游同步 SOP 与官方 gate 波及结论

本仓库唯一上游是官方 `deepseek-ai/deepseek-harness`（remote 名 `upstream`）。本文是 `yootun/docs/migration-plan.md` 第三节同步模型的落地执行清单，含官方 CI gate 对 `yootun/` 分区的波及结论与历次同步记录。

## 一、同步 SOP（每 2–4 周一次，官方 rc 趋稳后跟进；大版本升级先通读 upgrade-guide 全集再排期）

1. `git fetch upstream && git checkout -b sync/upstream-<date> main && git merge upstream/master`；
2. 按第二节冲突预期清单逐处解决；
3. 读官方新增 `docs/upgrade-guide/v<version>/*`，按指南适配第 1 层资产（slot/`dsh.client.inject`/PLATFORM_MODULES 等预稳定面变化）；
4. `pnpm install && pnpm run build`；
5. 跑 yootun 自有测试（各包 `node --test`）+ 受影响面官方测试（插件契约测试、桌面打包 smoke、快照测试），按最小覆盖原则选命令，不跑全量；
6. 同步 PR 合入 `main`（本地 merge，push 由维护者明确指示）；同步提交与功能提交分开。

## 二、冲突预期清单

| 文件 | 冲突取值 |
|---|---|
| `vendor/` | 只接受官方版本，fork 不改 vendor |
| `pnpm-workspace.yaml` | 保留 `yootun/packages/*` 自有行 |
| 第 2 层 7 处内联改动（见 [inline-changes.md](inline-changes.md) 登记簿） | 按登记簿逐处重放；其中品牌 4 处（#4 与 #7 相关面）改完跑品牌环境脚本自动生成 |
| 其余 | 应为空；出现即停下调查 |

上游同步后必须重跑：`pnpm install`（lockfile）与第三节 gate 结论中「是/部分」各行，确认波及结论未因官方 gate 实现变化而漂移；结论变化时修订第三节并记入第四节。

## 三、官方 gate 波及 `yootun/` 分区结论

调查结论（2026-11-13，见 [1110/01-workspace-scaffold.md](1110/01-workspace-scaffold.md) 第 4 节）+ 批次 1 实测核验：

| gate | 是否扫 `yootun/` | 说明 |
|---|---|---|
| `test:coverage` | 否 | vitest include 硬编码 `packages/*/*/src/**`；yootun 源码与测试均不进官方覆盖门禁（也不被官方测试跑——自有测试自带自跑） |
| `hygiene`（publint/package-deps/runtime-closure/node-next 等） | 否 | 各 leaf gate 的 glob 只含 `packages/*/*`、`vendor/*`、`apps/*` |
| `doc-sync` | 部分 | md-links/md-wrap 的 pattern 不含 `yootun/docs/**`（yootun 文档不进文档站）；但 `verify-translation-pairing` 把任何路径下名为 README.md 的文件纳入双语配对 scope，`verify-repository-references` 扫全仓文本禁止本仓库裸 commit hash。处置：分区导航命名 OVERVIEW.md、文档引用官方版本用版本号/日期而非 hash |
| `duplication` | 否 | jscpd 只扫 `packages scripts` |
| `constraints` | 部分 | workspace 成员协议检查覆盖所有 pnpm-workspace 成员：@yootun 包依赖官方 workspace 成员时必须写 `workspace:*` 协议。发布类 manifest 规则不扫 yootun |
| `lint`（oxlint） | 是 | 全仓扫描，yootun 下 TS/TSX 会被解析并吃到通用规则——按官方代码质量标准写即可 |
| `pnpm install` | 是 | lockfile 一致性；workspace glob 变更必须同步 lockfile（CI 用 `--frozen-lockfile`） |

若某 gate 出人意料扫到 yootun，处置优先级：满足规则 > 目录排除（找 scripts 对应 glob 白名单）> 登记豁免。

## 四、历次同步记录

| 日期 | 基线（同步前 → 后） | 分支 | 波及结论漂移 | 备注 |
|---|---|---|---|---|
| — | — | — | — | 尚无同步记录 |

## 附录 A：批次 1 gate 实测记录（2026-11-13）

本批在接入 `yootun/packages/*` glob、分区骨架就位后，以真实命令核验第三节结论。实测环境：官方基线 dsh 0.2.2-rc.2（main 分支），分区无包（仅 `.gitkeep` 占位）。

| 命令 | 预期 | 实测结果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 通过（lockfile 零 diff：分区无包） | 通过：`Lockfile is up to date, resolution step is skipped`，`pnpm-lock.yaml` 零 diff |
| `pnpm run constraints` | 通过（@yootun 无包，无协议检查对象） | 通过（初跑因本机残留报错，见下方意外记录） |
| `pnpm run lint` | 通过（yootun 下暂无 TS/TSX） | 通过：仅官方既有 1 条 warning（`packages/experimental/client-ui-cot-translation/src/index.ts` unused oxlint-disable），与 yootun 无关 |
| `pnpm run verify-translation-pairing`（doc-sync 波及点补充实测） | 通过（yootun 无 README.md 命名文件） | 通过：1262 对全部一致 |
| `pnpm run verify-repository-references`（doc-sync 波及点补充实测） | 通过（yootun 文档无裸 commit hash） | 通过：无违禁引用 |

### 意外记录：constraints 初跑因本机已删包孤儿残留报错

初跑 `pnpm run constraints` 报 3 个错（`packages/api/account-controller`、`packages/credentials/deepseek-account-platform`、`packages/document/office-to-pdf`：「expected a package here (no package.json found)」）。排查结论：

- 三者在 HEAD 中不存在、git 零追踪（官方历史提交已删除这些包），磁盘目录只剩旧基线安装期产生的 `lib/` 与 `node_modules/` 孤儿残留；constraints 对磁盘上无 package.json 的包目录一律报错，不受 git 追踪状态影响；
- 对照实验证实与本批改动无关：暂存本批 diff 后在 main 基线跑，报错完全相同（3 个）；
- 处置：跑官方 `pnpm run clean`（scripts/clean.ts，专门清理已删包孤儿条目 `node_modules`/`lib`/`.typecheck`），移除 395 个路径后 constraints 转绿，未绕过任何检查。

同步启示：每次同步后重跑 gate 前，若出现「无 package.json 的包目录」类报错，先用 `git ls-tree HEAD -- <路径>` 区分仓库内容与本机残留，残留走 `pnpm run clean`，不当作 gate 波及结论漂移。
