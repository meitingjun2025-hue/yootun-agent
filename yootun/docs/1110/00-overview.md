# 第一步实施方案：迁移除业务插件外的全部定制内容

状态：**待用户确认后实施**（2026-11-10 起草）。
本文是 `yootun/docs/migration-plan.md`（总纲）第一步的细化实施依据；与本总纲冲突处以本文为准（差异均来自本轮代码级调查的事实修正，见第二节）。

分册索引：

| 分册 | 内容 |
|---|---|
| [01-workspace-scaffold.md](01-workspace-scaffold.md) | `yootun/` 分区骨架、workspace 接入、官方 gate 波及结论、护栏文档建立 |
| [02-brand.md](02-brand.md) | 品牌迁移：素材分区、前端品牌包、yootun bundle 进 desktop profile、Electron 壳品牌 |
| [03-enterprise.md](03-enterprise.md) | 企业层：key 激活 UI、凭证链、门禁收敛、managed MCP 骨架、MCP 权限双通道边界 |
| [04-release.md](04-release.md) | 自建 GitHub Actions 打包 workflow、feed 目录约定、自动更新切换、版本策略 |
| [05-ui-ux.md](05-ui-ux.md) | yootun UI/UX 设计规范：官方 token/圆角/材质体系内的现代化重设计（批次 3/4 的视觉依据） |

## 一、目标与范围

第一步交付一个 **可安装、可自动更新、yootun 品牌、带 key 激活与托管 MCP 接入机制的桌面端**，但不包含任何业务插件。

| 做 | 不做（归后续步骤） |
|---|---|
| `yootun/` 分区骨架 + workspace 接入 + 护栏文档 | 业务插件迁移（等勾选清单，第三步） |
| yootun 品牌全套（前端 slot、Electron 壳、图标、标题、About） | 服务端 mcp-gateway 改造（保留原职责，按需另立项目） |
| 自建打包 workflow（GH-hosted，win/mac 出包） | 服务端 feed 部署本身的实施（本文给出约定，部署动作随批次 5 一起） |
| key 激活 UI + 凭证链 + 门禁收敛 | OIDC（永不迁）、旧自研更新器（废弃）、sensteed 全部 |
| UI/UX 现代化重设计（官方规范体系内，带科技感） | 旧激活界面的旧视觉原样照搬 |
| managed MCP 机制骨架（凭证模板绑定 + patch 格式定稿） | managed MCP 具体路由清单（依赖插件勾选清单，清单为空交付） |
| 官方插件能力保留：模型设置自配 + Plugins 页管理与会话创建插件（官方原样） | Discover 市场启用（保持官方默认关闭，用户需要时自行开启） |
| feed 切换为 electron-updater generic 自有端点 | MCP 工具级裁剪策略（查询/写入分类，依赖业务插件清单） |

「除业务插件外」的旧资产边界（调查确认）：`plugins/brand`（素材与品牌常量）、`plugins/dsh-yootun-ui`（品牌前端 + key 门禁）、旧桌面壳的 `brand.config.json` 身份与 `brand/assets` 素材、managed MCP 机制、门禁契约。`dsh-plugin-console` / `dsh-opencli` 属可选项，本次不迁（如需再单独确认）。

## 二、调查带来的事实修正（相对总纲）

1. **旧桌面自动更新不是 electron-updater**，是自研 HTTP 版本检查器（`/api/desktop/version` JSON API + 下载白名单 + stable/beta/next 三通道；安装包存火山 TOS `dofe-public` bucket，nginx 反代 13101 release 服务）。按既定决策整体废弃，改用官方 electron-updater generic provider。**自有 feed 的服务端形态必须按 generic 约定重建**（静态目录 + `latest.yml`/`latest-mac.yml` + 安装包），但设施全部沿用（TOS bucket / nginx / 域名现成），旧 `/api/desktop/*` 服务原样保留服务旧桌面——见分册 04。
2. **key 激活层不是独立 credentials provider 插件**：旧实现 = yootun-ui 前端 `credentials.set('MODELS_API_KEY', key)` + 桌面壳 cordis patch 固定 `llm-deepseek` 的 `apiKeyEnv/baseURL/models`。迁移按保持该形态设计（官方 `dsh-credentials-local` 存储已在 base bundle 内置，无需自写 provider），authorization flow 重组作为后续可选优化。
3. **「插件进安装包」的官方机制是依赖闭包**：打包脚本从 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-desktop-host` 两个根出发沿依赖递归打 tarball；desktop profile 复用 web 模板的 bundle 列表（base + web-app）。因此让 yootun bundle 内置 = 两个内联点（bundles 列表 + 打包闭包根），并非总纲设想的「profile 组装两条路径」。
4. **门禁版本契约已漂移**：docker-helm 的 yootun-ui 写 `validationVersion=3`，旧桌面 host 要求 `=5`。新单仓必须收敛为单一来源；因采用首装切换（无存量数据兼容），建议重置为 1。
5. **官方把桌面品牌身份硬编码在源码的面比总纲预估大**：productName/artifactName/protocols 名硬编码于 `electron-builder-config.mjs`，About 面板与 locale 文案硬编码 "DeepSeek Harness"。appId 与 feed 反而是环境变量驱动。内联改动从预估 ≤5 处修正为 **7 处**（见第五节）。
6. **CI gate 波及面比总纲预估小**：`yootun/` 天然不在 coverage/hygiene/duplication 的目录 scope 内；doc-sync 聚合中 md-links/md-wrap 不扫 `yootun/docs/**`，但 `verify-translation-pairing`（任何路径下名为 README.md 的文件进入双语配对 scope）与 `verify-repository-references`（全仓文本禁止本仓库裸 commit hash）两项会扫到 yootun（2026-11-13 实测）。处置：yootun 分区导航文档不命名 README.md（2026-11-13 定案，内部项目不依赖 GitHub 目录默认展示），文档引用官方版本一律用版本号/日期，不写裸 hash。连同 workspace 协议检查（constraints）、oxlint 全仓解析、pnpm lockfile 同步，波及点共 5 点。详见分册 01。

## 三、批次划分与顺序

每批一个 `feat/` 分支，完成后 `merge --no-ff` 回 main（2026-11-10 定稿的分支工作流）。每批含实现、验证、review 子代理验证、本地提交；批次 2 起依赖 GitHub Actions 出包验收。

| 批次 | 分支 | 内容 | 验收 | 预估 |
|---|---|---|---|---|
| 1 | `feat/migration-step1-scaffold` | 分册 01：分区骨架 + workspace + 护栏文档 + gate 实测记录 | `pnpm install` lockfile 刷新、`constraints`/`lint` 过、目录树就位 | 0.5 天 |
| 2 | `feat/migration-step1-package-ci` | 分册 04 前半：自建打包 workflow，先出**未品牌化官方包**（unsigned、无 feed）验证构建链 | Actions 出 win/mac 官方品牌安装包 artifact，实测构建时长 | 1 天 |
| 3 | `feat/migration-step1-brand` | 分册 02 + 05：素材分区、品牌前端包（UI/UX 按分册 05 规范设计）、bundle 进 profile、Electron 壳品牌收口 | Actions 出 yootun 品牌安装包；真机安装后侧边栏/首页/标题/图标/About 全 yootun 且视觉过设计验收 | 3–4 天 |
| 4 | `feat/migration-step1-enterprise` | 分册 03 + 05：key 激活（UI/UX 重设计）+ 凭证链 + 门禁 + managed MCP 骨架 + 官方设置页开放 | 真机：未激活被门禁拦截 → 输 key 激活成功 → 模型可用；官方 key 可自配；managed MCP patch 格式定稿（路由清单为空） | 3–4 天 |
| 5 | `feat/migration-step1-release` | 分册 04 后半：feed 目录首批手动上传 + 端到端更新闭环验证（自动上传 workflow 为可选增强，暂缓） | 真机：手动传 feed 后检测到新版 → 下载 → 安装 | 0.5–1 天 |

合计约 7–10 天（不含用户真机验收等待）。

## 四、待确认决策点（确认后冻结进各分册）

| # | 决策点 | 结论 | 详见 |
|---|---|---|---|
| 1 | appId | **已定案**：`ai.yootun.agent` 单一 appId（官方 channel 机制是同一安装实例切 nightly/stable） | 02 |
| 2 | productName / 窗口标题 | **已定案**：`Yootun-Agent`（artifact 前缀、About 面板、DSH_CLIENT_TITLE 同值） | 02 |
| 3 | key 激活形态 | **已定案**：保持旧形态（前端 credentials.set + patch 固定 config）；yootun key 激活强制（managed MCP 凭证依赖），DeepSeek 官方 key 用户可在官方设置页自配（可选） | 03 |
| 4 | VALIDATION_VERSION | **已定案**：重置 `1`（新契约单一来源，首装切换无存量包袱；机制讲解见 03 第 5 节） | 03 |
| 5 | feed 托管位置 | **已定案**：火山 TOS `dofe-public` bucket 直连，feed 目录 `yootun-agent/releases/feeds/`（该前缀已被 bucket 公开读策略放行，零服务端改动），客户端用官方 electron-updater；**上传由用户手动完成**：Actions 出包 → 清单重命名为 `<channel>.yml`（如 `stable.yml`/`stable-mac.yml`，channel 非 latest 时 electron-updater 按此名请求）→ 连同安装包传 feeds/ 目录，规范见 04 第 4 节；自动上传 workflow 为可选增强暂缓；旧 `/api/desktop/*` 服务原样保留服务旧桌面 | 04 |
| 6 | mac 包签名 | **已定案**：unsigned（2026-11-10）；将来购证书后官方链路可切 signed | 04 |
| 7 | 品牌包拆分 | **已定案**：拆两个包 `@yootun/dsh-client-ui-brand`（品牌 slot）+ `@yootun/dsh-client-ui-access`（激活/门禁）——低耦合、符合 harness 一切皆插件理念（2026-11-10 用户拍板） | 02/03 |
| 8 | 激活页范围 | **已定案**：只做 key 维护 + 模型加载选择；旧「预装插件勾选」整段删除 | 03 |
| 9 | UI/UX 重设计 | **已定案**：迁移时 UI/UX 重头设计——现代化规范 + 科技感，整体符合官方 harness 设计规范（token/圆角/材质/文案全套沿用官方体系）；规范见分册 05，工时已计入批次 3/4 | 05 |
| 10 | 官方模型设置页 | **已定案**：不 disable `ui-settings-models`，保留开放供用户自配 DeepSeek 官方 key/通道（可选）；yootun 激活与官方自配互不替代（2026-11-13） | 03 |
| 11 | 插件市场 | **已定案**：官方 Plugins 管理与会话创建插件原样保留；实验性 Discover 自定义插件索引（plugin-market-bundle）**保持官方默认关闭**，不预置索引源，用户需要时自行开启（2026-11-13 复议定案 B） | 03 |

全部决策点已定案，无阻塞项，可从批次 1 开工。

## 五、内联改动清单（第 2 层登记预估，批次 3 落实后以 `yootun/docs/inline-changes.md` 为准）

| # | 文件 | 改动 | 上游同步策略 |
|---|---|---|---|
| 1 | `pnpm-workspace.yaml` | packages 列表 + `yootun/*` | 冲突时保留自有行 |
| 2 | `apps/desktop/src/project-manager.ts` | profile bundles 列表追加 yootun bundle 一项 | 重放（一行） |
| 3 | `apps/desktop/scripts/prepare-package-set.ts` + `pack-local-packages.ts` | 打包闭包接入完整形态：`ROOT_PACKAGES` 追加 yootun bundle（选择）；`pack-local-packages.ts` 在 dsh family pack 后追加 `--filter=@yootun/*` pack 进同一 staging 目录（产出，CI 实测补齐 2026-11-13） | 重放（两处小改） |
| 4 | `apps/desktop/scripts/electron-builder-config.mjs` + `smoke-packaged-runtime.ts` + `package-target.ts`（mac app 路径两处 + DMG 日志路径）+ `prepare-windows-installer.ps1`（安装器素材源目录） | 品牌输入收口：productName/artifactName/protocols 名/图标路径改为从品牌环境读取（官方值作缺省），见分册 02；unsigned 后缀品牌可覆盖、nsis 安装器图标品牌态注入、欢迎窗展示图品牌态覆盖拷入、安装器位图素材源目录品牌可覆盖（真机修复补齐 2026-11-14）；冒烟与 mac 产物路径同用品牌产品名（CI 实测补齐 2026-11-13） | 重放（生成式，重跑品牌环境脚本即可） |
| 5 | `apps/desktop/scripts/desktop-auto-update-environment.mjs` | production feed origin 改自有地址（或引入 env 覆盖） | 重放（一行） |
| 6 | `scripts/client-build-environment.ts` + `packages/client/ui-conversation/src/client/locales.ts` | `DSH_CLIENT_TITLE` 改 yootun 值；增 `DSH_CLIENT_TAGLINE_ZH`/`EN` 键（官方 headline 缺省），`hero.headline` 八语言条目消费（真机修复补齐 2026-11-14） | 重放（一行 + 两键 + locales 八条目） |
| 7 | `apps/desktop/src/locale.ts`、`apps/desktop/src/main.ts` | About 面板与可见欢迎/更新文案品牌名；欢迎窗描述换品牌标语、API key 引导句产品名换品牌名（真机修复补齐 2026-11-14）（长尾文案可分期清理，先改用户可见关键面） | 重放 |

不改的官方面（明确排除）：`PROFILE_TEMPLATES`（packages/util/official-bundles）、desktop-host 的 package.json、全部 vendor/、官方 workflow 文件。

## 六、总体验收（第一步完成定义）

1. GitHub Actions 一键出 yootun 品牌 win/mac 安装包（unsigned）；
2. 真机安装：品牌全套正确、未激活被门禁拦截、输 key 后激活成功且模型可用；
3. 自动更新闭环走自有 feed（批次 5 后）；
4. `git diff master..main --stat` 中官方目录（第 0/2 层）改动仅第五节清单所列 7 处 + lockfile；
5. `yootun/docs/inline-changes.md`、`upstream-sync.md` 就位且与实际一致；
6. 全部批次通过 review 子代理验证。

## 七、实施流程约定

- 每批次按全局流程执行：开发 → 自测 → review 子代理验证 → 修复至通过 → 本地 commit（不 push）；push 与发版动作由用户明确指示。
- 每批次开始时登记当批预期触碰的官方文件；结束时核对 `inline-changes.md`。
- yootun 分区内测试不进官方 vitest scope（gate 结论见分册 01），各包自带 `node --test` 脚本，批次内本地跑。
- **UI/UX 规范（分册 05）为长期规范**：对后续所有插件迁移批次同样强制——旧插件视觉不迁移，UI 按规范重做，验收含设计合规检查（2026-11-10 用户定案）。
