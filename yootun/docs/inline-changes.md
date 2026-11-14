# 内联改动登记簿（第 2 层）

本仓库对官方目录（`packages/` `vendor/` `apps/` `docs/` `scripts/` `.github/` `native/` `benchmarks/` `website/` `python/`，第 0 层）原则上零改动；允许触碰的仅限本登记簿所列第 2 层内联改动。红线：**任何官方文件改动必须先登记后动工**；每批结束时以 `git diff main --stat -- packages vendor apps docs scripts .github native benchmarks website python ':(exclude).github/workflows/yootun-*.yml'` 与本簿对账，官方目录 diff 中出现簿外条目即违规。对账口径：批次开发中用 `git diff main`（分支工作区相对 main 的批次增量）；第一步全部批次合入后按分册 5.1 以 `git diff master..main` 做第一步总对账。`.github/workflows/yootun-*.yml` 是总纲第 3 节架构图明列的自有 CI 新增文件（第 1 层），虽物理位于官方目录下但不属内联改动，对账命令中排除。

初始清单按 `yootun/docs/1110/00-overview.md` 第五节 7 处预登记（2026-11-13）。同步策略详见 `yootun/docs/upstream-sync.md`。「落实」列按批次与日期定位（不记裸 commit hash）。

| # | 文件 | 改动 | 状态 | 落实 | 同步策略 |
|---|---|---|---|---|---|
| 1 | `pnpm-workspace.yaml` | `packages:` 列表追加 `yootun/packages/*` 一行 glob | 已落实 | 批次 1（2026-11-13） | 冲突时保留自有行 |
| 8 | `apps/desktop/scripts/desktop-package-environment.mjs` | `localMacOSPackageEnvironment`（mac unsigned 本地打包环境构造）品牌收口：显式透传 `DSH_DESKTOP_AUTO_UPDATE_ENV`（官方 ambient 过滤剥离该键，品牌 unsigned mac 包解析 production feed 必失败——批次 5 review P0-1 修复，2026-11-14）；`DSH_DESKTOP_APP_ID` 品牌可覆盖（`YOOTUN_BRAND_APP_ID ?? 'com.deepseek.harness'`，顺带修复批次 3 的 mac 包品牌 appId 遗漏）。官方无品牌环境构建行为原样 | 已落实 | 批次 5（2026-11-14，用户确认登记） | 重放（两行） |
| 2 | `apps/desktop/src/project-manager.ts` | profile bundles 列表追加 yootun bundle（`DESKTOP_BUNDLES` 常量） | 已落实 | 批次 3（2026-11-13） | 重放（一行） |
| 3 | `apps/desktop/scripts/prepare-package-set.ts`（含配套测试闭包 fixture 更新）+ `apps/desktop/scripts/pack-local-packages.ts` | 打包闭包接入完整形态：ROOT_PACKAGES 追加 yootun bundle（选择）+ unsigned 本地 pack 后追加 `--filter=@yootun/*` pack 进同一 staging 目录（产出——dsh family 只选 @deepseek-ai 包，yootun 包须单独 stage；CI 实测补齐，2026-11-13） | 已落实 | 批次 3（2026-11-13） | 重放（两处小改 + 测试 fixture 同步） |
| 4 | `apps/desktop/scripts/electron-builder-config.mjs` + `smoke-packaged-runtime.ts` + `package-target.ts`（mac app 路径两处 + DMG 日志路径）+ `apps/desktop/scripts/prepare-windows-installer.ps1`（安装器素材源目录一行）+ `packages/client/tsdown.client.ts`（品牌 define 键集） | 品牌输入收口完整形态：productName/artifactName/protocols 名/图标路径改为从品牌环境读取（官方值作缺省）；artifactName 的 unsigned 后缀品牌可覆盖（`YOOTUN_BRAND_ARTIFACT_SUFFIX`，空串去后缀）；nsis 节品牌态注入 `installerIcon`/`uninstallerIcon`（官方态不配置，保持 electron-builder 内置图标）；品牌态把 yootun 欢迎窗展示图覆盖拷入 `renderer/assets/welcome-brand.svg`（glob 收集后覆盖语义，官方态不配置）；安装器五张位图素材源目录品牌可覆盖（`YOOTUN_BRAND_INSTALLER_ASSETS`，官方 `installer/assets/` 缺省）；冒烟与 mac 产物路径消费同一品牌产品名（CI 实测补齐，2026-11-13——electron-builder 以 productName 命名 exe/app，冒烟脚本原硬编码官方名）。扩展落实：批次 3 真机验收修复（2026-11-14，问题 1/2 展示图/7、eyebrow define）；批次 4 增 `packages/client/tsdown.client.ts` 的 define 键 `YOOTUN_BRAND_VALIDATION_VERSION`（激活契约版本构建内联，与 eyebrow/product/tagline 同型扩展，2026-11-14）；批次 5 update 条件扩展——品牌 feed 环境注入（`YOOTUN_BRAND_FEED_ORIGIN`）时 unsigned 打包也解析 update 配置，electron-builder 为品牌 unsigned 包生成 app-update.yml 与通道清单（官方构建无品牌环境时行为原样，2026-11-14，方案 A 用户定案）；同批 mac 侧扩展——品牌 unsigned mac 加 zip 更新目标并放开 dmg `writeUpdateInfo`（`stable-mac.yml` 与 zip/blockmap 由 builder 生成，2026-11-14 review P1-1 修复） | 已落实 | 批次 3（2026-11-13）+ 真机修复（2026-11-14）+ 批次 4（2026-11-14）+ 批次 5（2026-11-14） | 重放（生成式，重跑品牌环境脚本即可） |
| 5 | `apps/desktop/scripts/desktop-auto-update-environment.mjs` | production feed origin 改自有地址（或引入 env 覆盖）；批次 5 增 releasePrefix（keyPrefix 首段）品牌可覆盖（`YOOTUN_BRAND_FEED_KEY_PREFIX ?? 'dsh-desk'`）——官方 `dsh-desk` 前缀不在 TOS bucket 公开读放行前缀（`yootun-agent/releases/*`）内，品牌值使 feed URL 落在放行范围（2026-11-14，与 #4 update 条件配套） | 已落实（env 覆盖形态） | 批次 3（2026-11-13）+ 批次 5（2026-11-14） | 重放（两处 env 覆盖行） |
| 6 | `scripts/client-build-environment.ts` + `scripts/client-build-environment.client.spec.ts`（配套键集断言）+ `packages/client/ui-conversation/src/client/locales.ts`（hero.headline 八语言条目） | client 构建环境键集：`DSH_CLIENT_TITLE` 改 yootun 值；增 `DSH_CLIENT_TAGLINE_ZH`/`DSH_CLIENT_TAGLINE_EN`（官方缺省为官方 headline，品牌环境给 mission 标语），`ui-conversation` 的 `hero.headline` 八语言条目消费该键（zh 档配 zh 键，en 与其余语言配 en 键、官方译文作缺省） | 已落实（env 覆盖形态） | 批次 3（2026-11-13，TITLE）+ 真机修复（2026-11-14，TAGLINE） | 重放（一行 + 两键 + locales 八条目 + spec 五处断言） |
| 7 | `apps/desktop/src/locale.ts`、`apps/desktop/src/main.ts`、`apps/desktop/tests/expected/welcome/`（配套快照八份） | About 面板与可见欢迎/更新文案品牌名；欢迎窗描述换品牌标语（zh 档 mission.zh，其余语言档 mission.en）、API key 引导句内产品名（Harness）换品牌名（`welcomeKeyDescription` 八语言，中文官方句无产品名不动）；welcomeTaglineBefore/After 为中性欢迎语，保留官方值（长尾菜单 hide/quit/open/startupFailed 留待分期） | 已落实 | 批次 3（2026-11-13）+ 真机修复（2026-11-14） | 重放（快照随词条更新） |

不改的官方面（明确排除，见 00-overview 第五节）：`PROFILE_TEMPLATES`（packages/util/official-bundles）、desktop-host 的 package.json、全部 `vendor/`、官方 workflow 文件。

## 对账记录

| 批次 | 日期 | 对账结果 |
|---|---|---|
| 批次 1 | 2026-11-13 | 一致：`git diff main --stat -- packages vendor apps docs scripts .github native benchmarks website python` 零输出，`pnpm-lock.yaml` 零 diff；根 `pnpm-workspace.yaml` 的 diff 即 #1 登记内容（+3 行：2 行注释 + 1 行 glob） |
| 批次 2 | 2026-11-13 | 一致：排除口径下官方目录 diff 零输出；唯一 `.github` 变化为新增自有 CI 文件 `.github/workflows/yootun-desktop-package.yml`（第 1 层，排除项），无官方既有文件改动 |
| 批次 3 | 2026-11-13 | 一致：排除口径下官方既有文件 diff 即 #2–#7 六项（含相关测试更新 `prepare-package-set.spec.ts`）；lockfile +95 行（yootun 两包首批接入 workspace，分册 01 预期内）；`pnpm-workspace.yaml` 无新改动 |
