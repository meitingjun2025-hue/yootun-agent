# 批次 3 真机验收问题与修复方案（2026-11-14）

状态：**决策点已定案，待实施**（2026-11-14 用户定案）。来源：批次 3 品牌包 Windows 真机验收反馈。出包状态：win/mac 双平台安装包均已产出（macOS 重跑成功）；真机目检 Windows 反馈如下，macOS 真机目检挂起（维护者无 mac 设备，后续有条件时补验）。已正确的面：安装包前缀、任务栏/桌面快捷方式图标与名称、About 面板、hero.brand.mark（首页标题旁品牌头像）、hero 渐变与 eyebrow 占位生效。

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
2. 问题 2：`apps/desktop/src/locale.ts` welcome 系列词条收口（`welcomeTaglineBefore/After`、描述、按钮文案跟随品牌环境）——并入内联 #7；
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
