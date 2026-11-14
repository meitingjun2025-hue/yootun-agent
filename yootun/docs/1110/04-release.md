# 分册 04：自建打包 workflow、feed 与自动更新

批次 2（workflow 前半）与批次 5（feed 后半）实施依据。

## 1. 目标

GitHub Actions 在 GH-hosted runner 上一键出 win/mac 安装包；tag 触发发布到自有 feed；桌面端自动更新闭环（检测 → 下载 → 安装）走自有端点。本地不构建（现状约束保持）。

## 2. 官方构建链事实（复用基础）

- 打包入口：根 `package.json` 的 `package:desktop:<target>:unsigned` scripts → `apps/desktop` 的 `package:<target>:unsigned` = `tsx scripts/package-target.ts <target> --unsigned`。链路：`pnpm run build --profile local`（打包入口内部无条件编排的完整构建，覆盖 `build:artifacts` 范围）→ `prepare:runtime`（stage-packages → prod install → materialize → smoke 等十二步）→ electron-builder → `prepare:packages`（依赖闭包 tarball）。
- **unsigned 分支行为**：无签名/公证步骤、`publish: null`（不生成 app-update.yml，即不启用自动更新）——批次 2 用它验证纯构建链；批次 5 起品牌包走 signed 参数以外的 feed 路径（见第 5 节：用 signed 打包形态但只配 feed 不配证书在 mac 上不可行，方案见下）。
- 环境变量（`desktop-release-environment.mjs` 等）：`DSH_DESKTOP_APP_ID`（必填，reverse-DNS 校验）、`DSH_DESKTOP_AUTO_UPDATE_ENV`（test/production）、`DSH_DESKTOP_UPDATE_CHANNEL`（nightly/stable）、`DSH_DESKTOP_BUILD_VERSION`（可选覆盖版本号）。feed origin：unsigned 时不读；非 unsigned 时 production 硬编码 `https://download.deepseek.com`（内联 #5 收口为品牌环境输入）。
- 产物：`apps/desktop/.desktop-build/` 下各 target 的 `artifacts/`（unsigned）/ `unsigned-artifacts/` 子目录。
- 官方 CI（`windows-package.yml` / `macos-package.yml`）跑在官方 self-hosted runner + EV 签名令牌 + 腾讯 COS，**不可复用**；自建 workflow 只调用上述 npm scripts。

## 3. workflow 设计（`.github/workflows/yootun-desktop-package.yml`）

```yaml
on:
  workflow_dispatch:      # 手动触发出包
  push:
    tags: ['yootun-v*']   # 发版 tag（区别于上游镜像的官方 tag）
```

- **job（build-matrix，第一步唯一 job）**：`strategy.matrix` 平台 `windows-latest` / `macos-latest`（`fail-fast: false` 留双平台完整数据）；steps：checkout → pnpm + node 24（官方 engines）→ `pnpm install --frozen-lockfile` → 打包前 `--check` 快速校验（环境 + 工具链探针）→ 品牌环境注入（`yootun/scripts/brand-environment.mjs` 输出 env，批次 3 起）→ `pnpm run package:desktop:<target>:unsigned`（打包入口内部已编排完整构建，无需也不应再单独跑 `build:artifacts`，否则全仓构建翻倍）→ upload-artifact（只传分发物：exe/dmg/zip/blockmap，不含冒烟解包目录）。Windows 侧打包入口强制读取 `apps/desktop/.env.windows`（仓库内只有模板），runner 上生成最小三键文件（appId + 更新环境 + policy origin；unsigned 下不读上传凭证）。
- **上传 = 用户手动**（2026-11-10 定案）：从 artifacts 下载 4 个文件（win/mac 清单 + 两安装包），按第 4 节操作表**重命名清单**（`latest.yml` → `stable.yml`/`nightly.yml` 等）后传 TOS feeds/ 目录。电子构建器已把清单与安装包成对生成，内容零手工编辑。
- **（可选增强，暂缓）自动上传 job**：如后续想省掉手动步骤，再加一个 publish job——TOS CLI/SDK 上传 + 凭证走 GitHub Environments secrets（`yootun-feed`，建议火山 RAM 子账号最小权限）+ `concurrency` 防并行写 feed。机制已明确，启用成本约半天，不阻塞任何批次。
- 时长：批次 2 已实测（附录 A）——双平台并行 24m54s（无缓存首跑），远低于 30–90 分钟/平台的预估；暂不引入 pnpm store / electron 缓存，时长劣化时再评估。

## 4. feed 目录约定（electron-updater generic provider，2026-11-10 定案，服务端调查后修正）

官方运行期行为：electron-updater 读安装包内 `app-update.yml`（`provider: generic, url, channel`），按 **`<url><channel>.yml`（win）/ `<url><channel>-mac.yml`（mac）** 请求清单文件（channel 非 `latest` 时替换文件名前缀——官方 CI 上传的就是 `${channel}.yml` / `${channel}-mac.yml`，`desktopUpdateMetadataFilename` 于 `desktop-auto-update-environment.mjs`），比对版本后按清单内相对路径下载安装包。feed 只需静态 HTTPS 目录，**不调任何 JSON API**。

**feed origin 与 keyPrefix（批次 5 定稿）**：origin `https://dofe-public.tos-cn-beijing.volces.com`（**无路径**——路径语义由 keyPrefix 承载，本册原「origin 带 `/yootun-agent/releases/feeds/` 路径」的设计不可行：品牌 origin 与官方拼装规则 `publicUrl = origin + '/' + keyPrefix` 会在路径处断裂，2026-11-14 修正）；keyPrefix 品牌可覆盖（`YOOTUN_BRAND_FEED_KEY_PREFIX ?? 'dsh-desk'`，内联 #5 扩展），品牌值 `yootun-agent/releases`。品牌环境出口对 feedOrigin 做格式自检（HTTPS 且无路径，fail loud——官方 `httpsOrigin` 仅校验 test 部署的 origin，品牌 origin 不经该校验）。

- 前缀必须在 **`yootun-agent/releases/*`** 之下：bucket 公开读策略（`dofe-public-policy.json`）只放行 `tools-dofe/*` 与 `yootun-agent/releases/*`，该前缀零服务端改动即可匿名 GET；`dsh-desk` 官方缺省前缀不在放行范围，品牌环境必须注入 keyPrefix。
- CORS 不构成障碍：electron-updater 跑在 Electron 主进程（Chromium 网络栈的非渲染层请求），不受浏览器 CORS 约束，普通公开读 GET 即可。
- 最终 feed URL = `origin/keyPrefix/feeds/<target>/`（target 子目录 `win-x64` / `mac-arm64`，官方 keyPrefix 拼装，2026-11-14 干跑实证），`url` 以 `/` 结尾。

**目录结构（按 target 子目录，channel 靠清单文件名区分——2026-11-14 定案修正，原「单层 feeds/」设计作废）**：

```
dofe-public/yootun-agent/releases/feeds/
├── win-x64/
│   ├── stable.yml / nightly.yml            # Windows 两通道清单
│   ├── Yootun-Agent-<version>-win-x64.exe
│   └── （可选 *.blockmap 差分文件：缺省回退全量下载）
└── mac-arm64/
    ├── stable-mac.yml / nightly-mac.yml
    ├── Yootun-Agent-<version>-mac-arm64.zip  # mac 更新走 zip；dmg 仅首装分发不进 feed
    └── （可选 *.blockmap）
```

清单与安装包必须放进对应平台子目录：electron-updater 按包内 app-update.yml 的 `url`（含子目录）拼清单路径，放错层级一律 404。完整操作流程（tag → 出包 → 核对 → 上传映射 → curl 验证 → 真机更新链 → 记录回填）见 `yootun/docs/feed-upload-runbook.md`（批次 5 操作单）。

- **发布哪个通道 = 用哪套清单文件名**：灰度传 `nightly(.yml/-mac.yml)`，验证稳定后把同一对清单（指向同一安装包）以 `stable(.yml/-mac.yml)` 名再传一份；两通道可共享同一安装包文件。
- **成对覆盖**：清单与安装包版本必须一致，一起上传。
- 旧链路（`/api/desktop/version`、`/api/desktop/downloads/*`、13101 release 服务）**原样保留**服务旧桌面，新 feed 是纯新增，不触碰旧链路。
- 首装分发入口仍可在 ixicai.cn 官网链接到 TOS 文件地址；若将来统一域名，nginx 加一条到该前缀的流式反代即可，客户端只改 feed origin 一处。

**打包链配合项（批次 5 已落实，候选 2 定案 2026-11-14 用户确认）**：官方 unsigned 分支强制无 update 配置（`electron-builder-config.mjs` `update = unsigned ? undefined : …`，publish 落 `null`，包内无 `app-update.yml` → `update-coordinator` 的 `enabled()` 恒 false）。落实为两处**已登记内联条目的扩展**：
1. `electron-builder-config.mjs`（内联 #4 同文件扩展）：update 条件改 `unsigned && env.YOOTUN_BRAND_FEED_ORIGIN === undefined`——品牌 feed 环境注入时 unsigned 也走 `resolveDesktopAutoUpdateConfig`，electron-builder 据此生成 app-update.yml 与通道清单（成对生成零手工，正式产物清单名随 channel）；官方构建无品牌环境时行为原样。
2. `desktop-auto-update-environment.mjs`（内联 #5 同文件扩展）：releasePrefix 品牌可覆盖（`YOOTUN_BRAND_FEED_KEY_PREFIX ?? 'dsh-desk'`）。
品牌环境出口（`yootun/scripts/brand-environment.mjs`）一次注入四键：`YOOTUN_BRAND_FEED_ORIGIN`、`YOOTUN_BRAND_FEED_KEY_PREFIX`、`DSH_DESKTOP_AUTO_UPDATE_ENV=production`、`DSH_DESKTOP_UPDATE_CHANNEL=stable`。真机首装包 app-update.yml 抽查入操作单第二节首跑检查项。

## 5. 版本与签名策略

- **版本**：官方序列（用户已拍板）。包版本取 workspace 版本（= dsh 版本，官方恒等原则），如 `0.2.2-rc.1`；不引入 `-yootun.N` 后缀（prerelease 语义会被 channel 逻辑吃进 `allowPrerelease`，自有 feed 上同号无冲突）。`yootun/brand/brand.json` 记 `baseVersion` 元数据备查。
- **首装切换**：旧桌面（自研更新器）不会看到新 feed，天然不会误升级——两代并行，无跨代自动更新（总纲既定决策）。
- **Windows**：unsigned（SmartScreen 提示与现状一致），决策点 6 同步预留。
- **macOS（决策点 6 已定案 2026-11-10）**：unsigned。Gatekeeper 会拦截——安装时右键打开（或 `xattr -cr`），发布说明写清引导。旧桌面 mac 是签名+公证的，此为已接受的分发体验退化项；将来购入 Apple 开发者证书后走官方 signed 链切换（`macos-packaging/production.env.example` 列明所需 env：证书、notarize 凭证），workflow 加签名步骤即可，feed 结构不变。
- 打包形态选择（批次 5 定案收口）：品牌包启用 feed 时**保持 unsigned 目标**——配合项（第 4 节候选 2，内联 #4/#5/#8）让品牌 unsigned 打包解析 update 配置并生成 app-update.yml 与通道清单；mac 侧品牌态额外加 zip 更新目标并放开 dmg update info（`stable-mac.yml` 与 zip/blockmap 由 builder 生成）。官方构建无品牌环境时所有行为原样。

## 6. 验收

批次 2：
- [x] Actions 出未品牌化官方包（win/mac artifact 可下载安装，官方品牌，无 feed）——2026-11-13 双平台首跑成功（附录 A）；
- [x] 构建时长实测记录（附录表），缓存策略定夺——见附录 A。

批次 5：
- [ ] tag `yootun-v*` 触发 → artifact 出包 → 按操作单重命名清单并上传 feeds/ 平台子目录（`yootun/docs/feed-upload-runbook.md`，维护者执行后回填 runbook 第七节）；
- [ ] 真机：设置页切 nightly/stable → 检测到新版本 → 下载 → 安装重启，版本号前进，全程 TOS feed（runbook 第五节，依赖上传完成）；
- [ ] 篡改防护：清单 sha512 校验路径生效（改一位安装包内容应导致更新拒绝）；
- [ ] review 子代理验证通过，本地 commit。

## 7. 风险

| 风险 | 对策 |
|---|---|
| GH-hosted 构建超时/成本 | 批次 2 已实测 24m54s 双平台并行（附录 A），暂不需要缓存；时长劣化时再启用 pnpm store + electron builder 缓存 |
| mac unsigned 更新包被 Gatekeeper 干扰更新流程 | 优先切 signed（决策点 6）；unsigned 期更新安装引导文案写进发布说明 |
| feed 侧缓存导致客户端读到旧 latest.yml | TOS 直读默认无 CDN 缓存层（批次 5 核实 bucket 是否挂 CDN）；若后续挂 CDN，需对 `latest*.yml` 设短缓存、安装包长缓存 |
| channel 目录与官方 keyPrefix 结构不一致导致 404 | 以打包产物 `app-update.yml` 内实际 URL 为准做一次端到端联调（验收项覆盖） |
| 官方打包脚本对 GH-hosted 环境的隐性假设（官方只在 self-hosted 跑过） | 批次 2 就是探路批次；失败逐条修 workflow env，不改官方脚本逻辑 |

## 附录 A：批次 2 出包与时长实测（2026-11-13）

| 项 | 结果 |
|---|---|
| 首跑形态 | GH-hosted 首跑，无任何缓存；`workflow_dispatch` 手动触发，双平台并行（`fail-fast: false`） |
| 双平台结果 | windows-latest / macos-latest 均成功 |
| run 总时长 | **24m54s**（双平台并行，用户实测提供；分平台明细如需可从 run 页补录） |
| artifacts | `yootun-desktop-windows-unsigned`（exe）、`yootun-desktop-macos-unsigned`（dmg/zip）均生成并上传成功；真机安装抽查未单独执行，首装安装验证随批次 3 品牌包真机验收覆盖 |
| 结论一（探路） | 官方 unsigned 自包含打包链在 GH-hosted runner 完整跑通，无需修改任何官方脚本 |
| 结论二（缓存策略定夺） | 24m54s 远低于 30–90 分钟/平台预估，**暂不引入 pnpm store / electron 缓存**——保持 workflow 简单、避免缓存一致性与陈旧缓存维护成本；后续单次时长显著劣化或批次并发需求出现时再评估（`actions/cache` + electron-builder 缓存目录） |

实施备注：第 3 节 steps 描述已按官方源码事实修正——打包入口（`package-target.ts`）对 unsigned 构建内部无条件执行 `pnpm run build --profile local` 完整构建，workflow 不含也不应含独立 `build:artifacts` 步骤；Windows 侧 `.env.windows` 三键（官方 appId + production 更新环境 + policy origin）为 unsigned 链路必填最小集，批次 3 起随品牌环境一并替换为 yootun 值。

## 附录 B：批次 5 feed 配套与首批记录（2026-11-14，待维护者执行后回填）

| 项 | 状态 |
|---|---|
| 配合项落实（候选 2，内联 #4/#5/#8 三处扩展） | ✅ 代码就位（electron-builder-config update 条件与 mac zip/updateInfo、keyPrefix 品牌化、mac 本地打包环境透传部署键 + 品牌 appId）；CI 首跑验证 app-update.yml 内容（runbook 第二节首跑检查项） |
| feed URL 干跑（含 mac unsigned 实际环境形态） | ✅ `resolveDesktopAutoUpdateConfig` 品牌环境注入实证：win `…/feeds/win-x64/`、mac `…/feeds/mac-arm64/`、清单名 `stable.yml`/`stable-mac.yml`；mac 过滤后环境（内联 #8 修复形态）update 解析通过、品牌 appId 存活、ambient 泄入仍剥离 |
| 抬号机制 | ✅ workflow_dispatch `build_version` 经 CLI `--build-version` 转发（打包入口只认该参数）；合法形态 `<workspace 版本>.<日期>.<序列>`（如 `0.2.2-rc.2.20261114.1`，干跑实证 gt 基线成立、`0.2.2-rc.3` 形态被官方校验拒绝）；tag 触发空参回退 workspace 版本 |
| artifact 清单收集 | ✅ workflow upload glob 增 `*.yml`（win `stable.yml`、mac `stable-mac.yml` 均有产物来源） |
| review 修复 | ✅ P0-1（mac unsigned 品牌打包必崩，内联 #8）/P0-2（抬号 env 无效改 CLI 转发 + 合法形态）/P1-1（mac feed 产物无来源）/P1-2（第 5 节矛盾段）/P2 全部修复，复审确认 |
| 基线出包 / 抬号出包 / 上传 / curl / 真机更新链 / 基线恢复 | ⏳ 待维护者按 runbook 执行（第七节记录表回填；构建时长随首跑补录） |
| macOS | artifact 归档（Gatekeeper unsigned 限制已知，runbook 第六节；mac 更新链真机验证挂起） |
