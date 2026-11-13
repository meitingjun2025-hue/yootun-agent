# 分册 04：自建打包 workflow、feed 与自动更新

批次 2（workflow 前半）与批次 5（feed 后半）实施依据。

## 1. 目标

GitHub Actions 在 GH-hosted runner 上一键出 win/mac 安装包；tag 触发发布到自有 feed；桌面端自动更新闭环（检测 → 下载 → 安装）走自有端点。本地不构建（现状约束保持）。

## 2. 官方构建链事实（复用基础）

- 打包入口：根 `package.json` 的 `package:desktop:<target>:unsigned` scripts → `apps/desktop` 的 `package:<target>:unsigned` = `tsx scripts/package-target.ts <target> --unsigned`。链路：`pnpm run build:artifacts` → `prepare:runtime`（stage-packages → prod install → materialize → smoke 等十二步）→ electron-builder → `prepare:packages`（依赖闭包 tarball）。
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

- **job（build-matrix，第一步唯一 job）**：`strategy.matrix` 平台 `windows-latest` / `macos-latest`；steps：checkout → pnpm + node 24（官方 engines）→ `pnpm install --frozen-lockfile` → `pnpm run build:artifacts` → 品牌环境注入（`yootun/scripts/brand-environment.mjs` 输出 env）→ `pnpm run package:desktop:<target>:unsigned`（批次 2）→ upload-artifact。
- **上传 = 用户手动**（2026-11-10 定案）：从 artifacts 下载 4 个文件（win/mac 清单 + 两安装包），按第 4 节操作表**重命名清单**（`latest.yml` → `stable.yml`/`nightly.yml` 等）后传 TOS feeds/ 目录。电子构建器已把清单与安装包成对生成，内容零手工编辑。
- **（可选增强，暂缓）自动上传 job**：如后续想省掉手动步骤，再加一个 publish job——TOS CLI/SDK 上传 + 凭证走 GitHub Environments secrets（`yootun-feed`，建议火山 RAM 子账号最小权限）+ `concurrency` 防并行写 feed。机制已明确，启用成本约半天，不阻塞任何批次。
- 时长风险：GH-hosted 全量构建（build:artifacts 全仓 + 两端打包）预估 30–90 分钟/平台；批次 2 实测后决定是否加 pnpm store 缓存（`actions/cache`）与 electron 缓存。实测数据记入本册附录。

## 4. feed 目录约定（electron-updater generic provider，2026-11-10 定案，服务端调查后修正）

官方运行期行为：electron-updater 读安装包内 `app-update.yml`（`provider: generic, url, channel`），按 **`<url><channel>.yml`（win）/ `<url><channel>-mac.yml`（mac）** 请求清单文件（channel 非 `latest` 时替换文件名前缀——官方 CI 上传的就是 `${channel}.yml` / `${channel}-mac.yml`，`desktop-auto-update-environment.mjs:105-114`），比对版本后按清单内相对路径下载安装包。feed 只需静态 HTTPS 目录，**不调任何 JSON API**。

**feed origin（定案）**：`https://dofe-public.tos-cn-beijing.volces.com/yootun-agent/releases/feeds/`

- 前缀必须在 **`yootun-agent/releases/*`** 之下：bucket 公开读策略（`dofe-public-policy.json`）只放行 `tools-dofe/*` 与 `yootun-agent/releases/*`，该前缀零服务端改动即可匿名 GET；自建 `feeds/` 等新前缀需要改 policy 并重跑 `configure-desktop-release-storage.js`。
- CORS 不构成障碍：electron-updater 跑在 Electron 主进程（Chromium 网络栈的非渲染层请求），不受浏览器 CORS 约束，普通公开读 GET 即可。
- `url` 以 `/` 结尾（官方 publicUrl 拼接规则）。

**目录结构（单层，channel 靠清单文件名区分，无子目录）**：

```
dofe-public/yootun-agent/releases/feeds/
├── stable.yml                                  # Windows·stable 通道清单
├── nightly.yml                                 # Windows·nightly 通道清单
├── stable-mac.yml / nightly-mac.yml            # macOS 两通道清单
├── Yootun-Agent-<version>-win-x64.exe          # Windows 安装包（清单 files[].url 指向它）
├── Yootun-Agent-<version>-mac-arm64.zip        # macOS 更新包（electron-updater 的 mac 更新走 zip；dmg 仅首装分发）
└── （可选 *.blockmap 差分文件：缺省时回退全量下载，功能不受影响）
```

**手动上传操作表（定案发版流程）**：打 tag → Actions 出包 → 从 artifacts 下载 → 按下表重命名/上传：

| 打包产物 | 上传名（channel 按目标） | 规则 |
|---|---|---|
| `latest.yml`（builder 固定名） | **`stable.yml` 或 `nightly.yml`** | 重命名后放 feeds/ 根；内容不改 |
| win 安装包 exe | 原名（**不改**） | 同目录；清单内文件名/sha512 必须与实际一致 |
| `latest-mac.yml` | **`stable-mac.yml` 或 `nightly-mac.yml`** | 重命名后放 feeds/ 根 |
| mac zip | 原名（**不改**） | 同目录 |

- **发布哪个通道 = 用哪套清单文件名**：灰度传 `nightly(.yml/-mac.yml)`，验证稳定后把同一对清单（指向同一安装包）以 `stable(.yml/-mac.yml)` 名再传一份；两通道可共享同一安装包文件。
- **成对覆盖**：清单与安装包版本必须一致，一起上传。
- 旧链路（`/api/desktop/version`、`/api/desktop/downloads/*`、13101 release 服务）**原样保留**服务旧桌面，新 feed 是纯新增，不触碰旧链路。
- 首装分发入口仍可在 ixicai.cn 官网链接到 TOS 文件地址；若将来统一域名，nginx 加一条到该前缀的流式反代即可，客户端只改 feed origin 一处。

**打包链配合项（批次 3 实测定夺，三候选组合）**：启用 feed 需要包内有 `app-update.yml`（否则 `update-coordinator.ts:64` 的 `enabled()` 恒 false，后台静默禁用）；官方 **unsigned 分支强制 `publish: null`**（`electron-builder-config.mjs:102/:274`）——即官方现成 target 里「无签名 + 带 feed」不存在，需实测/选择：
1. 非 unsigned 目标 + 无签名身份（electron-builder 无 CSC 时 ad-hoc/跳过签名）——若官方 `package-target.ts` 容忍即零改动；
2. `package-target.ts` 增加一个「跳过签名但生成 publish/app-update.yml」的组合（第 2 层内联登记）；
3. unsigned 打包 + CI 后处理：自写清单生成（官方 `installed-update-distribution.ts:68-69` 的 dump 格式可抄）+ mac 侧复用 afterPack 写入钩子（`macos-app-update-config.mjs`）。
另确认：无 app-update.yml 时后台轮询完全静默无感，仅设置页手动「检查更新」会弹一次错误框——如需完全干净，渲染层一处判断不注册通道行（`ui-settings-general/src/client/index.ts:110`），列为可选小改。

## 5. 版本与签名策略

- **版本**：官方序列（用户已拍板）。包版本取 workspace 版本（= dsh 版本，官方恒等原则），如 `0.2.2-rc.1`；不引入 `-yootun.N` 后缀（prerelease 语义会被 channel 逻辑吃进 `allowPrerelease`，自有 feed 上同号无冲突）。`yootun/brand/brand.json` 记 `baseVersion` 元数据备查。
- **首装切换**：旧桌面（自研更新器）不会看到新 feed，天然不会误升级——两代并行，无跨代自动更新（总纲既定决策）。
- **Windows**：unsigned（SmartScreen 提示与现状一致），决策点 6 同步预留。
- **macOS（决策点 6 已定案 2026-11-10）**：unsigned。Gatekeeper 会拦截——安装时右键打开（或 `xattr -cr`），发布说明写清引导。旧桌面 mac 是签名+公证的，此为已接受的分发体验退化项；将来购入 Apple 开发者证书后走官方 signed 链切换（`macos-packaging/production.env.example` 列明所需 env：证书、notarize 凭证），workflow 加签名步骤即可，feed 结构不变。
- 打包形态选择：品牌包启用 feed 时走「非 unsigned」目标（publish 生效、生成 app-update.yml 与 latest.yml）；mac 侧若 unsigned 则 app-update.yml 由官方 `macos-app-update-config.mjs` afterPack 写入路径不受签名影响——实施时按实测取可行组合，两分支都登记进 workflow 注释。

## 6. 验收

批次 2：
- [ ] Actions 出未品牌化官方包（win/mac artifact 可下载安装，官方品牌，无 feed）；
- [ ] 构建时长实测记录（附录表），缓存策略定夺。

批次 5：
- [ ] tag `yootun-v*` 触发 → artifact 出包 → 按第 4 节操作表重命名清单并上传 feeds/ 目录；
- [ ] 真机：设置页切 nightly/stable → 检测到新版本 → 下载 → 安装重启，版本号前进，全程 TOS feed；
- [ ] 篡改防护：latest.yml sha512 校验路径生效（改一位安装包内容应导致更新拒绝）；
- [ ] review 子代理验证通过，本地 commit。

## 7. 风险

| 风险 | 对策 |
|---|---|
| GH-hosted 构建超时/成本 | 批次 2 实测；必要时 pnpm store + electron builder 缓存、拆 build:artifacts 缓存层 |
| mac unsigned 更新包被 Gatekeeper 干扰更新流程 | 优先切 signed（决策点 6）；unsigned 期更新安装引导文案写进发布说明 |
| feed 侧缓存导致客户端读到旧 latest.yml | TOS 直读默认无 CDN 缓存层（批次 5 核实 bucket 是否挂 CDN）；若后续挂 CDN，需对 `latest*.yml` 设短缓存、安装包长缓存 |
| channel 目录与官方 keyPrefix 结构不一致导致 404 | 以打包产物 `app-update.yml` 内实际 URL 为准做一次端到端联调（验收项覆盖） |
| 官方打包脚本对 GH-hosted 环境的隐性假设（官方只在 self-hosted 跑过） | 批次 2 就是探路批次；失败逐条修 workflow env，不改官方脚本逻辑 |
