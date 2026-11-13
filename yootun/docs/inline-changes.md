# 内联改动登记簿（第 2 层）

本仓库对官方目录（`packages/` `vendor/` `apps/` `docs/` `scripts/` `.github/` `native/` `benchmarks/` `website/` `python/`，第 0 层）原则上零改动；允许触碰的仅限本登记簿所列第 2 层内联改动。红线：**任何官方文件改动必须先登记后动工**；每批结束时以 `git diff main --stat -- packages vendor apps docs scripts .github native benchmarks website python ':(exclude).github/workflows/yootun-*.yml'` 与本簿对账，官方目录 diff 中出现簿外条目即违规。对账口径：批次开发中用 `git diff main`（分支工作区相对 main 的批次增量）；第一步全部批次合入后按分册 5.1 以 `git diff master..main` 做第一步总对账。`.github/workflows/yootun-*.yml` 是总纲第 3 节架构图明列的自有 CI 新增文件（第 1 层），虽物理位于官方目录下但不属内联改动，对账命令中排除。

初始清单按 `yootun/docs/1110/00-overview.md` 第五节 7 处预登记（2026-11-13）。同步策略详见 `yootun/docs/upstream-sync.md`。「落实」列按批次与日期定位（不记裸 commit hash）。

| # | 文件 | 改动 | 状态 | 落实 | 同步策略 |
|---|---|---|---|---|---|
| 1 | `pnpm-workspace.yaml` | `packages:` 列表追加 `yootun/packages/*` 一行 glob | 已落实 | 批次 1（2026-11-13） | 冲突时保留自有行 |
| 2 | `apps/desktop/src/project-manager.ts` | profile bundles 列表追加 yootun bundle（`DESKTOP_BUNDLES` 常量） | 已落实 | 批次 3（2026-11-13） | 重放（一行） |
| 3 | `apps/desktop/scripts/prepare-package-set.ts` | `ROOT_PACKAGES` 追加 yootun bundle | 已落实 | 批次 3（2026-11-13） | 重放（一行） |
| 4 | `apps/desktop/scripts/electron-builder-config.mjs` | 品牌输入收口：productName/artifactName/protocols 名/图标路径改为从品牌环境读取（官方值作缺省） | 已落实 | 批次 3（2026-11-13） | 重放（生成式，重跑品牌环境脚本即可） |
| 5 | `apps/desktop/scripts/desktop-auto-update-environment.mjs` | production feed origin 改自有地址（或引入 env 覆盖） | 已落实（env 覆盖形态） | 批次 3（2026-11-13） | 重放（一行） |
| 6 | `scripts/client-build-environment.ts` | `DSH_CLIENT_TITLE` 改 yootun 值 | 已落实（env 覆盖形态） | 批次 3（2026-11-13） | 重放（一行） |
| 7 | `apps/desktop/src/locale.ts`、`apps/desktop/src/main.ts` | About 面板与可见欢迎/更新文案品牌名（长尾菜单 hide/quit/open/startupFailed 留待分期） | 已落实 | 批次 3（2026-11-13） | 重放 |

不改的官方面（明确排除，见 00-overview 第五节）：`PROFILE_TEMPLATES`（packages/util/official-bundles）、desktop-host 的 package.json、全部 `vendor/`、官方 workflow 文件。

## 对账记录

| 批次 | 日期 | 对账结果 |
|---|---|---|
| 批次 1 | 2026-11-13 | 一致：`git diff main --stat -- packages vendor apps docs scripts .github native benchmarks website python` 零输出，`pnpm-lock.yaml` 零 diff；根 `pnpm-workspace.yaml` 的 diff 即 #1 登记内容（+3 行：2 行注释 + 1 行 glob） |
| 批次 2 | 2026-11-13 | 一致：排除口径下官方目录 diff 零输出；唯一 `.github` 变化为新增自有 CI 文件 `.github/workflows/yootun-desktop-package.yml`（第 1 层，排除项），无官方既有文件改动 |
| 批次 3 | 2026-11-13 | 一致：排除口径下官方既有文件 diff 即 #2–#7 六项（含相关测试更新 `prepare-package-set.spec.ts`）；lockfile +95 行（yootun 两包首批接入 workspace，分册 01 预期内）；`pnpm-workspace.yaml` 无新改动 |
