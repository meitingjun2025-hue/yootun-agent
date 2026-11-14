# 批次 3 真机验收问题与修复方案（2026-11-14）

状态：**A/B 两组与第二轮真机反馈修复均已实施（2026-11-14，main 直修），待 push 出包复验**（决策点 2026-11-14 用户定案；welcomeTaglineBefore/After 实施取舍见第二节 B 组 2 备注）。来源：批次 3 品牌包 Windows 真机验收反馈。出包状态：win/mac 双平台安装包均已产出（macOS 重跑成功）；真机目检 Windows 反馈如下，macOS 真机目检挂起（维护者无 mac 设备，后续有条件时补验）。已正确的面：安装包名（无 `-unsigned`）、安装器圆标 yootun 素材、卸载页 yootun logo、任务栏/桌面快捷方式、About 面板、hero 品牌头像与 eyebrow。

## 一、问题清单与根因

| # | 问题（截图） | 根因 | 改动面 |
|---|---|---|---|
| 1 | 安装/卸载向导界面为官方视觉：侧边鲸鱼图、deepseek HARNESS wordmark、卸载器标题栏官方图标（图 1/3/4） | NSIS 安装器素材链未收口：`prepare-windows-installer.ps1` 从 `apps/desktop/installer/assets/` 官方素材生成 `installer-ui/*.bmp`（brand/brand-2x/brand-dark/brand-dark-2x/uninstaller-sidebar 五张）；nsis 节未配 `installerIcon`/`uninstallerIcon`；`installer/` 主题目录（theme/pages/uninstall.nsh 与 assets）为官方视觉源 | 官方资产替换（内容级）+ nsis 配置收口 |
| 2 | 欢迎窗口（首启引导）整页官方文案与官方产品展示图（图 2） | `apps/desktop/src/locale.ts` 的 welcome 系列词条（`welcomeTaglineBefore` 等）不在内联 #7 收口范围；欢迎窗展示图为官方素材 | 内联 #7 扩展（locale 词条收口）+ 展示图处理（见决策点） |
| 4 | 侧边栏左上角 mark 显示异常（用户报告「有点问题」，现象待确认：官方鱼 fallback 或 mask 渲染异常） | 两种可能：`sidebar.brand.mark` 注册未生效（fallback FishLogo）；或 YootunMark 的 CSS mask 在桌面 client 注入环境下资产解析失败（显示为色块）。`hero.brand.mark` 用 `<img>` 形态已证实生效，sidebar 用 CSS mask 形态 | 先诊断（见第三节），修复路径 B |
| 5 | 首页顶部大面积淡蓝色渐变，用户预期白色/极淡 | `hero.module.css` 渐变头部透明度 0.2（`brand.json` accentGradient 同值），大画布上过于明显 | 设计参数调淡（yootun 分区文件） |
| 6 | 首页右上角 X 点击无法关闭窗口 | 待复现诊断：hero 装饰层均已 `pointer-events: none`，理论不拦截窗口 chrome；需 devtools/console 与 Alt+F4、菜单退出对照排除 | 诊断后定 |
| 7 | 安装包名含 `-unsigned` 后缀，期望 `Yootun-Agent-<版本>-win-x64.exe`（mac 同步） | 官方 `desktop-build-paths.mjs` 对 unsigned 产物强制 `-unsigned` 后缀（防与官方签名产物混淆；yootun 自有 feed 无此风险） | 后缀品牌收口（可覆盖为空） |

## 二、实施分组

### A 组：yootun 分区修复（无内联改动）

1. 问题 5：`hero.module.css` 与 `brand.json` accentGradient 渐变浓度调淡（建议亮色头部 0.2 → 0.06~0.08，暗色 0.16 → 0.05），保留品牌微光意象但底色回归白/深灰；
2. 问题 4 修复路径 B：YootunMark 从 CSS mask 形态改为 `<img>` 形态（与已证实生效的 YootunHeroMark 同型），暗色主题用素材第二版或 `filter` 适配；若诊断证实是注册问题则按诊断结论修注册；
3. 问题 1/2 的素材产出：`yootun/scripts` 生成脚本扩展——安装器五张品牌图（brand/brand-2x/brand-dark/brand-dark-2x/uninstaller-sidebar 的 yootun 版源图）与欢迎窗展示图（按决策点）。

### B 组：官方内联扩展（并入既有登记项）

1. 问题 1：`prepare-windows-installer.ps1` 资产源目录品牌收口（品牌环境指向 yootun 安装器素材目录，官方 assets 缺省）+ nsis 节 `installerIcon`/`uninstallerIcon` 收口——并入内联 #4（品牌输入收口完整形态）；
2. 问题 2：`apps/desktop/src/locale.ts` welcome 系列词条收口（`welcomeTaglineBefore/After`、描述、按钮文案跟随品牌环境）——并入内联 #7。实施取舍：`welcomeTaglineBefore/After` 为中性欢迎语（Welcome to/欢迎使用），保留官方值不改——品牌名已在 `welcomeTaglineBrand`；实际收口 `welcomeDescription`（官方 slogan → mission 标语，zh 档 mission.zh、其余语言档 mission.en）与 `welcomeKeyDescription`（句内产品名 Harness → 品牌名，中文官方句无产品名不动）；
3. 问题 3：`scripts/client-build-environment.ts` 键集增加品牌标语变量 + `ui-conversation` locales.ts 的 `hero.headline` 消费（`hero.preview` 徽章默认保留，见决策点）——并入内联 #6（client 构建环境键集）；
4. 问题 7：`electron-builder-config.mjs` artifactName 的 suffix 改品牌可覆盖——并入内联 #4。

### C 组：用户操作与诊断（无代码）

1. profile 残留已由用户处理（卸载官方端 + 重建 profile），品牌包加载已证实（hero 生效）；
2. 问题 4 诊断：桌面端开启 devtools（如可用）查 console 是否有 sidebar slot 注册报错；同时截图侧边栏左上角现状高清图——区分「官方鱼 fallback」与「mask 色块」；
3. 问题 6 诊断：复现时记录——点击 X 后窗口与进程状态、Alt+F4 是否可关、应用菜单退出是否可用、console 报错。

## 三、决策点（2026-11-14 用户定案）

1. **渐变浓度**：调淡保留微光——亮色头部透明度 0.2 → **0.08**，暗色 0.16 → **0.05**（`hero.module.css` 与 `brand.json` accentGradient 同步）；
2. **欢迎窗展示图**：换 **yootun 素材**（从现有素材合成，生成脚本产出）；
3. **空态标题文案**：`hero.headline` 收口为 **`brand.json` 的 `mission.zh`（「青年人买车就到优惠豚」）**（en 对应 mission.en）；**「预览版」徽章保留跟官方**（`hero.preview` 词条不动）。

## 四、验收清单（修复批次真机复验）

- [ ] 安装/卸载向导：侧边图、wordmark 图、窗口图标全部 yootun；
- [ ] 欢迎窗：标题、描述、按钮文案品牌化，展示图按决策点处理；
- [ ] 首页空态：标题品牌标语（青年人买车就到优惠豚）+ 品牌 mark，预览版徽章保留；侧边栏 mark 显示正确（明暗两主题）；
- [ ] 首页背景回归白/深灰（按决策点浓度）；
- [ ] X 关闭可用（诊断结论落地后复验）；
- [ ] 安装包名：`Yootun-Agent-<版本>-win-x64.exe` 与 `Yootun-Agent-<版本>-mac-arm64.dmg/.zip`（无 -unsigned）；
- [ ] 内联登记簿同步（#4/#6/#7 扩展口径）；review 子代理验证通过。

> macOS 真机目检（侧边栏/首页/标题/About/明暗主题）挂起：维护者无 mac 设备；macOS 与 Windows 同源实现，Windows 复验通过后风险可控，有 mac 条件时补验。

## 五、第二轮真机反馈（2026-11-14，分册 06 真机修复首个出包）

分册 06 修复的已生效面：安装器圆标 yootun 素材、卸载页 yootun logo（浅灰卡待去，见 6）、包名去 `-unsigned` 后缀、hero 品牌头像/eyebrow、渐变 0.08。以下为仍未生效面与新要求，已逐项核实根因。

| # | 现象 | 根因（已核实） | 修复 |
|---|---|---|---|
| 1 | 欢迎窗主标题「欢迎使用 DeepSeek Harness」、描述句产品名 | 欢迎窗内容是 client Web 页（onboarding 流程），文案在 `ui-settings-account/src/client/locales/onboarding.ts`（`onboardingBrand`/`onboardingIntroduction` 等词条硬编码官方名）——分册 06 未覆盖该文件 | ✅ 已实施：onboarding 全部词条产品名经 `DSH_CLIENT_PRODUCT_NAME` 构建内联（官方名缺省），机制同 TAGLINE（并入内联 #7 扩展） |
| 2 | 首页标题「探索未至之境」未替换 | TAGLINE 构建期内联断点：`ui-conversation` 的 `hero.headline` 消费 `process.env.DSH_CLIENT_TAGLINE_*`，但 client 产物运行时无 `process.env`（永远 fallback 官方值）；供给端断点——官方 define 按 `DSH_CLIENT_` 前缀从流程环境透传，而流程环境只有 `YOOTUN_BRAND_*`（上批实施漏了供给端） | ✅ 已实施：品牌环境出口增 `DSH_CLIENT_TAGLINE_ZH/EN`（官方 define 动态透传，无需改 vite.config）；上批 locales 消费随即生效（并入内联 #6） |
| 3 | 托盘右键菜单/tooltip 显示「DeepSeek Harness」 | `locale.ts` 托盘菜单与 tooltip 词条硬编码官方名（8 语言 × hide/quit/open/quitTitle/startupFailed 等约 40 处）——原「长尾分期」升级为本批必修（托盘为高频可见面） | ✅ 已实施：全部词条模板化为品牌产品名；tooltip 消费 `aboutProduct` 词条（上批已收口）（并入内联 #7 扩展） |
| 4 | 卸载页 yootun logo 外的浅灰圆角卡突兀（卸载页白底） | 生成脚本给 uninstaller-sidebar 加了浅灰圆角卡；卸载页为浅色主题，卡与底色冲突（安装页深色底不受影响） | **图片类，挂起**：随公司设计出图一并替换（与欢迎窗 mockup 同批）；届时 `uninstaller-sidebar` 出白底纯 logo 版、`installer-sidebar` 保留深色卡版并分指 |
| 5 | 首页渐变 0.08 仍显淡蓝，定案改纯白跟随侧边栏底色 | 设计决策更新（用户 2026-11-14 复议：0.08 在浅色底仍突兀） | ✅ 已实施：渐变整体移除（glow 层删除、`brand.json` accentGradient 清除），底色完全跟随宿主；eyebrow 落款保留 |
| 6 | 侧边栏 mark 显示异常（第二轮仍为官方鱼） | 分册 06 已改 `<img>` 形态仍未生效 → 嫌疑收敛到 slot 注册层（写法与声明均与官方 ui-brand-official 同构）；hero.brand.mark 同包生效证明包加载正常 | 诊断项（见第三节），按诊断结论修注册 |
| 7 | 首页右上角 X 无法关闭窗口（第二轮复现） | 待诊断：hero 装饰层均 `pointer-events: none` 理论不拦截窗口 chrome；需 devtools console 与菜单退出/Alt+F4 对照 | 诊断项（见第三节） |

### 诊断步骤（维护者在 Windows 本机 dev 模式执行）

1. 按「本地 dev 启动」流程起桌面（品牌环境注入 + `pnpm run dev:desktop`）；
2. devtools console 查：sidebar slot 注册是否有报错/警告；`document.querySelector` 侧边栏 mark 元素的实际 DOM（是 `<img class=mark>` 还是 fallback FishLogo svg）；
3. X 失效复现：点击 X 时观察 console、进程是否退出、应用菜单「退出」与 Alt+F4 对照；
4. 结论回填本节表格后实施对应修复。

## 六、验收补充（第二轮，并入第四节复验）

- [ ] 欢迎窗：主标题与描述句品牌化（onboarding 词条收口后）；
- [ ] 首页标题：品牌标语（构建期内联经 Web 构建链验证生效）；
- [ ] 托盘右键菜单与 tooltip：全部品牌名（明暗与多语言抽查）；
- [ ] 卸载页：无浅灰卡（白底融图）；安装页深色卡观感不变；
- [ ] 首页底色跟随宿主（浅色白/暗色深灰），无蓝色渐变。
