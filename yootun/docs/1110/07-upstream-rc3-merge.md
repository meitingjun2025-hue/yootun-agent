# 上游 0.2.2-rc.3 同步注意事项与验收清单（2026-11-15）

本文记录 `main` 从官方 0.2.2-rc.2 基线同步到官方 0.2.2-rc.3 的合并决策、适配点、验证结果与后续出包注意事项。同步执行前 `main` 已包含 yootun 批次 1–5、真机修复、企业接入层与双平台更新提示品牌化修复；`master` 仅作为官方上游镜像，不承载 yootun 定制，也不得反向合入 `main` 的定制内容。

## 一、同步基线与范围

| 项 | 记录 |
|---|---|
| 同步日期 | 2026-11-15 |
| 同步前产品版本 | `0.2.2-rc.2` |
| 同步后产品版本 | `0.2.2-rc.3` |
| 官方上游 | `deepseek-ai/deepseek-harness` 的 `master`，本地 `master` 与 `upstream/master` 一致 |
| 官方变更规模 | 约 448 个提交、3262 个路径变化；三个 @yootun 私有包版本随产品基线同步为 0.2.2-rc.3；包含 Cordis 4.0.0-rc.12、Client 模块元信息机制、Desktop publisher 独立化、若干包导出清理与 UI 更新 |
| 合并方式 | 在 `main` 上执行 `git merge --no-ff master`；Git 无文本冲突，合并后按登记簿做语义对账 |
| 远端状态 | 同步前 `main` 已推送到 `origin/main`；本次合并先停在本地，未打 tag、未触发打包 |

官方升级指南重点：`client-module-metadata` 要求自定义 client bundle 用配套版本重新构建，并在样式元信息中通过 `context.asset()` 解析载体资源；`package-export-cleanup` 移除多个包子路径并要求类型改走 `/types` 入口。yootun 自有包没有消费被移除子路径，完整构建已验证兼容。

## 二、自动合并结果与适配决策

| 上游变化 | 合并结果 | 决策 |
|---|---|---|
| `desktop-auto-update-environment.mjs` 从 `apps/desktop/scripts/` 迁移到 `apps/desktop-publisher/src/` | yootun 的 feed origin 与 keyPrefix 覆盖被 Git 识别为 rename 并带到新路径 | 保留新路径；origin/keyPrefix 统一从函数参数 env 读取，补品牌 feed 动态测试；内联登记 #5 与 yootun 自检同步改路径 |
| `apps/desktop-publisher/` 独立成 publisher workspace | 官方桌面打包与发布链引用新包入口 | 接受官方实现；品牌 feed 配置经新入口继续生效 |
| Client 模块元信息与静态样式 manifest 变化 | 自有 brand/access client bundle 重新构建成功 | 不改自有导出形态；保留官方 renderer 安装样式的新机制 |
| 官方删除 Python PTC runtime 包 | 合并索引删除仓库文件，本机遗留 `lib/` 与 `node_modules/` | 先确认无 Git 追踪后运行官方 `pnpm run clean`，清理 392 个残留路径 |
| Cordis Include 方言迁移与 core 升级 | 官方 YAML 与依赖更新自动合入 | 接受官方版本；yootun bundle patch 仍是普通 patch 文件，不受 Include 导出迁移影响 |
| 上游加强 macOS 本地环境对 ambient release 键的剥离测试 | 旧 #8 透传在无品牌构建也会保留 `DSH_DESKTOP_AUTO_UPDATE_ENV`，补充测试暴露 1 例失败 | 透传加 `YOOTUN_BRAND_FEED_ORIGIN` 门控：品牌 feed 打包继续透传，官方无品牌构建保持官方剥离语义 |
| 官方版本、workspace 与 lockfile 更新 | `pnpm-lock.yaml` 合入官方依赖变化并保留 yootun importers | 冻结安装通过；不手改 lockfile |

## 三、内联改动保留清单

合并后以官方 `master` 为对照，官方目录仅保留下列差异；完整对账命令为 `git diff --name-status master -- packages vendor apps docs scripts .github native benchmarks website python ':(exclude).github/workflows/yootun-*.yml'`。

| 登记项 | 合并后文件面 | 状态 |
|---|---|---|
| #1 workspace | `pnpm-workspace.yaml` 保留 `yootun/packages/*`；`pnpm-lock.yaml` 保留 yootun importers 与官方 rc3 依赖更新 | ✅ |
| #2 desktop profile | `apps/desktop/src/project-manager.ts` 保留 `@yootun/dsh-bundle-yootun` | ✅ |
| #3 打包闭包 | `apps/desktop/scripts/prepare-package-set.ts`、`pack-local-packages.ts`、`tests/prepare-package-set.spec.ts` 保留 yootun bundle 选择与单独 staging | ✅ |
| #4 品牌打包 | `electron-builder-config.mjs`、`package-target.ts`、`smoke-packaged-runtime.ts`、Windows installer 脚本与素材、NSIS helper、locale 声明与测试、`packages/client/tsdown.client.ts` 保留品牌收口 | ✅ |
| #5 feed 配置 | 新路径 `apps/desktop-publisher/src/desktop-auto-update-environment.mjs` 与配套测试保留 feed origin 与 keyPrefix 品牌覆盖，品牌 feed publicUrl 动态断言通过 | ✅ 登记簿路径与测试已更新 |
| #6 client 构建 | client build environment、类型声明、键集测试与 `ui-conversation` 八语言 hero 文案保留 | ✅ |
| #7 桌面与 onboarding 文案 | desktop locale/main、welcome 快照、`ui-settings-account` locale/onboarding 文案保留 | ✅ 登记簿补齐历史漏列文件 |
| #8 mac 本地打包环境 | `apps/desktop/scripts/desktop-package-environment.mjs` 保留品牌 appId 与仅品牌 feed 态的更新部署键透传；配套测试覆盖品牌/无品牌双态 | ✅ |

除上述登记项、`pnpm-workspace.yaml` 与派生 `pnpm-lock.yaml` 外，合并结果相对官方 `master` 无簿外官方目录差异；`.github/workflows/yootun-desktop-package.yml` 是自有 workflow，按登记簿口径排除。

## 四、本次同步验证记录

| 检查 | 结果 | 备注 |
|---|---|---|
| `pnpm install --frozen-lockfile` | ✅ | 官方 rc3 lockfile 与 yootun workspace 一致 |
| `pnpm run constraints` | ✅ | 初跑仅因上游删除 Python PTC runtime 后的本机残留失败；官方 clean 后复跑通过 |
| `pnpm run clean` | ✅ | 清理 392 个已删除包残留路径 |
| `pnpm run lint` | ✅ | 包含 contracts 生成与全仓 oxlint |
| `pnpm run typecheck` | ✅ | 5 gates 全过 |
| `pnpm run build` | ✅ | 10 gates 全过；379 个 client artifact 记录构建环境 |
| `pnpm --filter '@yootun/*' run build` | ✅ | brand/access/bundle 三个自有包构建通过 |
| 聚焦 Vitest（7 个文件） | ✅ | publisher 更新环境（含品牌 feed URL）、installer locale、package set、welcome renderer、onboarding、client build environment；165 用例全过 |
| `node yootun/scripts/self-test.mjs` | ✅ | 13/13；同步时修复两处旧脚本路径断言，并覆盖 #8 品牌 feed 门控 |
| 桌面 target 与 publisher 聚焦 Vitest（6 个文件） | ✅ | 182 用例全过；初跑暴露 #8 无品牌态透传 1 例，修复品牌门控后复跑通过 |
| `pnpm run verify-repository-references` | ✅ | 无裸提交引用 |
| `pnpm run verify-translation-pairing` | ✅ | 双语文档配对通过 |
| `pnpm run verify-installer-locales` | ✅ | 8 语言 installer locale 键与占位符一致 |
| `pnpm run verify-client-ui-i18n` | ✅ | 1355 个 Client UI 源文件保持 locale-owned copy |
| `pnpm run test:docs` | ✅ | doc-quick gates 全过 |

## 五、出包与真机复验清单

1. 出包前确认 `main` 工作树干净、`master` 不包含 yootun 定制、官方 workflow 保持禁用状态，仅按需触发 `Yootun Desktop Package`。
2. 版本号已随官方升到 `0.2.2-rc.3`；不得复用已存在的 `yootun-v0.2.2-rc.2` tag。是否打 `yootun-v0.2.2-rc.3` 或使用 dispatch 抬号，由维护者明确决定。
3. 自动更新验证如使用 dispatch 抬号，基础版本应跟随 `0.2.2-rc.3`，并保持官方 semver 校验允许的四段日期形态；不要沿用旧基线的四段版本。
4. Windows 首验：安装器五图与 NSIS 原生横幅、欢迎窗、门禁、模型获取与会话、左上角 mark、托盘菜单、明暗主题、X 关闭与升级后页面可点击。
5. Windows 更新链：确认更新提示标题为 `Yootun-Agent`，下载、安装、重启与版本前进完整通过；feed 清单仍使用平台子目录 `feeds/win-x64/`。
6. macOS 有条件时补验：app 身份、DMG/ZIP 更新目标、`stable-mac.yml`、更新提示标题与品牌素材；无设备时继续挂起并依赖同源实现风险说明。
7. 上传 feed 前核对 manifest 的 `version`、安装器 URL、SHA512、size 与平台目录；上传后用 curl 分别验证 Windows 与 macOS 清单。
8. 真机通过后回填 `yootun/docs/feed-upload-runbook.md` 与分册 04 附录 B，再决定是否对外发布。

## 六、后续同步注意事项

- `master` 只用于 fast-forward 官方 `upstream/master`；永远不从 `master` 历史里寻找或恢复 yootun 定制，定制权威在 `main` 与 `yootun/` 分区。
- `apps/desktop-publisher/src/desktop-auto-update-environment.mjs` 是 #5 的当前路径；若官方再次移动文件，先用 rename 对照确认定制是否随迁，再更新登记簿与 `yootun/scripts/self-test.mjs`。
- 上游删除包后 `constraints` 报“expected a package here”时，先检查合并索引是否仍跟踪该路径；无追踪则运行官方 `pnpm run clean`，不要手工绕过 gate。
- Client bundle 机制变化后，同步必须执行完整 `pnpm run build` 与 `pnpm --filter '@yootun/*' run build`，不能只跑 TypeScript 编译。
- 官方升级 guide 是同步必读材料；新增包导出、client metadata、publisher workspace 或 workflow 变化时，同步本文的“上游变化—决策”表。

## 七、rc3 tag 首跑补充记录（2026-11-15）

首个 `yootun-v0.2.2-rc.3` tag 在 Windows 打包阶段失败：同步前的升级横幅品牌化修复为 `prepare-windows-installer.ps1` 的编译命令多写入一个右括号，PowerShell 在执行前解析失败；该缺陷在 rc3 合并前已存在，合并本身未改这行。修复为删除多余括号，并把 PowerShell 字符串/注释外的分组括号平衡检查加入 `yootun/scripts/self-test.mjs`，避免同类语法错误只等到 Windows runner 才暴露。已有远端 tag 指向失败提交；修复提交推送后需由维护者决定重新移动该 tag 或另打修复 tag，不得擅自改写已发布 tag。
