# 第一步（批次 1–5）整体收尾状态汇总（2026-11-14）

对应总纲（`yootun/docs/migration-plan.md` 第 6 节）的「第一步：迁移除业务插件外的全部定制内容」。本文是收官快照：已完成面、挂起面（谁在等谁）、后续路线。各批细节以分册与批次文档为准，本文不重复。

## 一、已完成面（代码与物料全部合入 main）

| 批次 | 分支（已 merge --no-ff） | 交付 | 收官状态 |
|---|---|---|---|
| 1 scaffold | `feat/migration-step1-scaffold` | `yootun/` 分区骨架、workspace 接入、官方 gate 波及实测（5 点结论）、护栏文档（inline-changes.md / upstream-sync.md） | ✅ 2026-11-13 |
| 2 package-ci | `feat/migration-step1-package-ci` | 自建打包 workflow（GH-hosted 双平台，tag/dispatch 双触发），首跑实测 24m54s | ✅ 2026-11-13 |
| 3 brand | `feat/migration-step1-brand` | 品牌全套：前端 slot 包、yootun bundle 进 desktop profile、Electron 壳/安装器/About/托盘品牌收口（内联 #2–#7） | ✅ 代码+出包；两轮真机反馈修复已实施（分册 06），待出包复验 |
| 4 enterprise | `feat/migration-step1-enterprise` | 企业接入层：`@yootun/dsh-client-ui-access`（全屏门禁/激活表单/设置区块 + 同源激活路由）、凭证链收口（credentials store 优先，查证定案走 A）、VALIDATION_VERSION 单一来源、managed MCP patch 格式定稿（路由清单为空）、MCP 权限双通道边界声明 | ✅ 代码合入；真机验收挂起（见二.2） |
| 5 release | `feat/migration-step1-release` | feed 配套：unsigned 品牌包生成 app-update.yml 与通道清单（内联 #4/#5/#8 扩展）、keyPrefix 品牌化（TOS 放行前缀）、feedOrigin/feedKeyPrefix 定稿进 brand.json、mac 品牌态 zip 更新目标与清单生成、workflow artifact 收集清单 + dispatch 抬号（CLI `--build-version` 转发）、`feed-upload-runbook.md` 操作单、分册 04 结构修正与附录 B | ✅ 代码与物料就位；远端动作与真机验证挂起（见二.1/二.2） |

官方目录对账（第一步总口径）：`git diff master..main` 中官方改动 = 内联清单 #1–#7（#4/#5/#6/#7 含各批扩展）+ lockfile，零簿外条目；每批 merge 前均有对账记录（inline-changes.md 对账节）。

## 二、挂起面（按等待方分组）

### 1. 等维护者远端动作（批次 5 操作单 `yootun/docs/feed-upload-runbook.md`）
- 打 tag（`yootun-v0.2.2-rc.2`）触发基线出包；dispatch 抬号（`0.2.2-rc.3`）出验证包；
- artifact 下载核对（含首跑 app-update.yml 抽查）→ TOS 上传（**平台子目录结构**）→ curl 验证；
- Windows 真机更新链（检测→下载→安装→版本前进）→ 基线恢复；执行结果回填 runbook 第七节与分册 04 附录 B。

### 2. 等下一轮出包的真机复验（代码已实施，包未出）
- **分册 06 第二轮清单**：欢迎窗主标题/描述品牌化（onboarding 词条内联）、首页标题（TAGLINE 供给端直通）、托盘菜单/tooltip、卸载页白底化、首页纯白底色、侧边栏 mark 直接注册形态（随批次 4 包一并验证，明暗两主题）；
- **批次 4 验收**（分册 03 第 9 节）：首次启动门禁拦截 → 有效 key 激活 → 对话走 ixicai.cn 网关（抓包）→ 移除 key 回门禁态；MODELS_API_KEY store 优先验证；官方模型设置页自配不影响激活；Plugins 页官方能力原样；
- 本批（批次 5）的 app-update.yml 首跑抽查与更新链（依赖一）。

### 3. 等条件（长期挂起，不阻塞收官）
- macOS 真机目检与更新链补验（维护者无 mac 设备；同源实现，Windows 复验通过后风险可控）；
- welcome 窗 mockup 大图（等设计出图；`YOOTUN_BRAND_WELCOME_ASSETS` 覆盖机制已就位）；
- feed 自动上传 workflow（可选增强，暂缓，机制已写明分册 04 第 3 节）。

## 三、后续路线（总纲阶段 3–5）

1. **复验轮**：维护者完成二.1 上传后，从 main 出下一轮包，一次性覆盖二.2 全部真机项（门禁、品牌复验、更新链三合一）；
2. **第二步（总纲阶段 4）发版与切换**：首轮 feed 发布（`stable` 通道正式版）、官网首装入口指向 TOS、旧桌面冻结只修 P0（「新一代发布」提示横幅决策点仍开放，取决于存量用户量）；
3. **第三步（总纲阶段 3）插件勾选迁移**：等勾选清单定稿后按批迁 `yootun/plugins/`（0.2.2 适配 + 契约测试 + 分册 05 设计验收）；managed MCP 真实路由随插件清单逐条补入 bundle patch（清单单一来源已收敛）；会话只读裁剪策略（查询/写入分类）与插件页面全能力通道随各插件落地；
4. **第五步（总纲阶段 5）退役**：docker-helm 桌面部分归档、dsh-desktop 冻结（维护者本人操作）。

## 四、第一步行内改动总账（对账基准）

`yootun/docs/inline-changes.md` #1–#7 全部落实；批次 4/5 扩展（tsdown.client define 键、electron-builder update 条件、keyPrefix 品牌化）并入 #4/#5 同文件条目。上游同步策略：各条「重放」口径不变，品牌生成式条目重跑 `yootun/scripts/brand-environment.mjs` 即可。
