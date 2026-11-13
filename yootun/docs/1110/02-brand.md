# 分册 02：品牌迁移

批次 3（`feat/migration-step1-brand`）实施依据。前置：批次 1 骨架就位、批次 2 打包链可用。

## 1. 目标

Actions 出 **yootun 品牌安装包**：窗口标题、侧边栏品牌位、会话首页品牌位、应用图标、托盘图标、安装器身份（productName/appId）、About 面板全部为 yootun；官方品牌元素（PixelWhale 首页、FishLogo、官方品牌包）不出现。

## 2. 官方品牌输入全景（调查事实）

| 品牌项 | 官方实现位置 | 官方取值方式 | yootun 处置 |
|---|---|---|---|
| 前端侧边栏品牌 | slot `sidebar.brand.mark` / `sidebar.brand.name`（ui-brand-official 占用，仅 official build profile 时注册） | 组合路线：不加载官方品牌包 + 自有包占同 slot | 自有品牌包 + patch disabled 官方包 |
| 会话首页 | slot `conversation.hero.frame`（官方 PixelWhale 鲸鱼）+ `conversation.hero.brand.mark`（官方留空） | 同上 | 自有包占 hero.frame；hero.brand.mark 按素材取舍 |
| 浏览器/窗口标题 | 构建变量 `DSH_CLIENT_TITLE`（`scripts/client-build-environment.ts` OFFICIAL 常量硬编码） | 构建期内联 | 内联 #6 改常量 |
| appId / feed URL | 环境变量 `DSH_DESKTOP_APP_ID`、`DSH_DESKTOP_AUTO_UPDATE_ENV`(+production origin 硬编码 download.deepseek.com) | 打包 env | 纯 env，零内联（feed origin 见内联 #5） |
| productName / artifactName / protocols 名 | `electron-builder-config.mjs` 硬编码 | 源码 | 内联 #4 收口为品牌环境输入 |
| 应用/托盘图标 | `apps/desktop/resources/icon-{macos,windows}.png`、`tray-windows.ico`（固定路径，单 1024 PNG 派生全部尺寸） | 文件 | 内联 #4 一并把路径改指 `yootun/brand/assets`（不替换官方文件本体，素材留在自有分区） |
| About 面板 / 菜单文案 | `apps/desktop/src/main.ts`（setAboutPanelOptions）+ `src/locale.ts`（中英文案硬编码 "DeepSeek Harness"） | 源码 | 内联 #7（先改用户可见关键面） |

官方品牌包替换路线原文（`packages/client/ui-brand-official/README.md`）："A deployment with its own identity leaves this package out and composes another package that occupies the sidebar slots and the `conversation.hero.frame` layer…Occupying a slot is the only composition route."——占 slot 是唯一组合路径，品牌素材不可配置。

## 3. A 部分：品牌素材分区（`yootun/brand/`）

从 `dsh-desktop`（dev 分支）`brand/`（源素材 + 生成脚本群）只读迁移（总纲第 4 节只读红线）：

- `brand.json`（单一来源）：`name: Yootun-Agent`、`appId: ai.yootun.agent`（决策点 1）、`tenant: yootun`、`title: Yootun-Agent`、feed origin（决策点 5 定稿后填）、`validationVersion`（决策点 4）、logo/wordmark 文件引用。
- `assets/`：从旧桌面 `brand/assets/` 拷贝源素材（app-icon-source.jpg 1024、sidebar-mark.png、hero-mark.png、wordmark.png）。旧桌面 build 产物（ico/icns/托盘多尺寸）**不拷**——官方桌面从单张 PNG 派生尺寸，只需产出 `icon-macos.png` / `icon-windows.png` / `tray-windows.ico` 三件（ico 由旧脚本 generate-windows-app-icon.mjs 精简版生成）。
- `scripts/`：仅保留产出上述三件 + sidebar/hero 用 PNG 的最小脚本（旧桌面 7 个生成脚本不整搬）。

## 4. B 部分：前端品牌包 `@yootun/dsh-client-ui-brand`

决策点 7 已定案（2026-11-10）：**拆包、低耦合**（用户拍板，符合 harness 一切皆插件理念）——品牌 slot 一个包、激活页一个包（分册 03）。本包只管品牌展示，不含激活逻辑；视觉设计遵循分册 05 规范。

- 结构对齐官方 `ui-brand-official`：host 半空 Loader 席位（`apply(){}`），client 半 `dsh.client.platform: 'web'` + `inject: ['slots', <声明 slot 所属包>]`，经 `ctx.slots.inject(声明名, ...)` 声明感知注册。
- 注册 slot：`sidebar.brand.mark`（logo 图）、`sidebar.brand.name`（返回 null 隐藏文字名，旧实现如此）、`conversation.hero.frame`（yootun 首页视觉，分册 05 的重设计重点）。
- 品牌常量来源：沿用旧机制 `globalThis.__DSH_PLUGIN_BRAND__` 构建期注入（从 `yootun/brand/brand.json` 生成），素材内嵌 dataURL，避免运行期读文件。
- **0.2.2 适配**：旧插件 inject 写的是旧包名，0.2.2 官方包全名带 `@deepseek-ai/` 前缀（如 `@deepseek-ai/dsh-client-ui-renderer`、`-sidebar`、`-conversation`）；slot 声明名不变。实施时逐项核对 inject/peer 的现行包名。

## 5. C 部分：yootun bundle 与「进安装包」机制（本步关键点）

**官方机制（调查确认）**：desktop profile 复用 web 模板 bundle 列表（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，`packages/util/official-bundles/src/bundles.ts` PROFILE_TEMPLATES.web）；安装包内插件清单由打包脚本 `apps/desktop/scripts/prepare-package-set.ts` 从 `ROOT_PACKAGES = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']` 沿依赖闭包打 tarball；首启时在 `~/.dsh/profiles/desktop` 重建 profile。

建立 `@yootun/dsh-bundle-yootun`（Cordis bundle，id `yootun`）：

1. `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`（bundle 声明格式，官方 web-app 同款）；
2. `cordis.patch.yml` 初版内容（批次 3 范围）：
   ```yaml
   - id: ui-brand-official
     disabled: true          # 关官方品牌包（desktop 用 web-app bundle，此行同时作用于桌面）
   - insert:
       - id: yootun-ui-brand
         name: '@yootun/dsh-client-ui-brand'
   ```
   （批次 4 再追加 access 包、llm patch、managed MCP 行。）
3. **两个内联点**（00-overview 第五节 #2/#3）：`apps/desktop/src/project-manager.ts` 的 bundles 列表追加 `'@yootun/dsh-bundle-yootun'`（bundle 生效）；`apps/desktop/scripts/prepare-package-set.ts` 的 `ROOT_PACKAGES` 追加同包名（打进安装包）。不动官方 `PROFILE_TEMPLATES`。

## 6. D 部分：Electron 壳品牌收口（内联 #4/#5/#6/#7）

设计原则：**官方文件只改一次、改成「读品牌环境、官方值兜底」**，此后换品牌/同步重放都只动 `yootun/brand` 数据，不碰源码。

1. `apps/desktop/scripts/electron-builder-config.mjs`：productName、artifactName 模板前缀、protocols 名、图标路径四项改为 `品牌环境值 ?? 官方缺省值`；品牌环境来源一个新脚本 `yootun/scripts/brand-environment.mjs`（读 `yootun/brand/brand.json` 导出环境变量映射），workflow 与本地打包统一经它注入。
2. `apps/desktop/scripts/desktop-auto-update-environment.mjs`：production `fixedOrigin` 同样收口（自有 feed 地址来自品牌环境；批次 5 定稿 URL，本批可先占位）。
3. `scripts/client-build-environment.ts`：`DSH_CLIENT_TITLE` 改 `'Yootun-Agent'`（该常量官方有键集一致性断言，只改值不动结构）。
4. `apps/desktop/src/locale.ts` / `main.ts`：About 面板 applicationName、欢迎页/更新弹窗标题等用户可见关键面改品牌值；长尾菜单文案登记后续分期。

打包 env 全集（workflow 使用，分册 04 引用）：`DSH_DESKTOP_APP_ID=ai.yootun.agent`、`DSH_DESKTOP_AUTO_UPDATE_ENV=production`、`DSH_DESKTOP_UPDATE_CHANNEL=nightly|stable`、品牌环境产物（productName 等）、可选 `DSH_DESKTOP_BUILD_VERSION`。

## 7. 验收

- [ ] Actions 出 yootun 品牌包（win/mac unsigned）；
- [ ] 真机安装：安装器/开始菜单/任务栏名称 `Yootun-Agent`，图标为 yootun 素材；
- [ ] 启动：侧边栏 yootun logo（无 FishLogo）、首页 yootun 视觉（无 PixelWhale）、窗口标题 `Yootun-Agent`、About 面板品牌正确；
- [ ] 官方品牌包未加载（bundle patch disabled 生效）；
- [ ] `git diff master..main -- apps/ scripts/ pnpm-workspace.yaml` 与内联登记簿一致（#1–#7）；
- [ ] review 子代理验证通过，本地 commit。

## 8. 风险

| 风险 | 对策 |
|---|---|
| 品牌包 inject/slot 在 0.2.2 行为差异（声明感知注册机制较新） | 对照官方 ui-brand-official 源码逐 slot 核对；本地 `pnpm run dev:desktop` 先行目检再出包 |
| bundle patch disabled 行写错层序导致官方品牌包仍加载 | patch 层序：bundle patches 按 profile bundles 顺序 → profile patch → 用户目录 patch；yootun bundle 排在 web-app 之后即胜出；验收项专项检查 |
| 图标路径改动被上游官方变更打断 | 图标输入集中在 electron-builder-config 一处（内联 #4），同步时按登记簿重放 |
| locale 文案改动面大引入回归 | 只改用户可见关键面，长尾分期；每处改动跑桌面 smoke（runtime:primary-smoke） |
