# yootun 桌面迁移方案：基于官方 deepseek-harness fork 的定制开发

状态：已评审对齐（2026-11-09），待插件/MCP 勾选清单与 feed 托管位置最终确认后启动阶段 0。
本文是唯一实施依据；后续变更直接修订本文并注明日期。

## 1. 背景与目标

现状是「双上游、三仓库、快照传递」的定制链路，同步效率低、版本易乱：

```
docker-helm.dofe.ai ──(快照同步 .ci/)──▶ dsh-desktop ──(symlink + workspace:*)
                                            │
                                            ▼
                              iTechwu/deepseek-harness fork（基线 0.1.7-rc.2，+126 定制提交）
                                            │  落后官方 43 天 / 5671 提交 / 15 个版本
                                            ▼
                              官方 deepseek-ai/deepseek-harness（0.2.2-rc.1）
```

目标：**内核与桌面端 100% 使用官方**，只在 fork 仓库（本仓库）叠加 yootun 定制层；
此后唯一上游是官方 `deepseek-ai/deepseek-harness`，定期 merge 即可获得全部新功能，
同时保留自有定制。宗旨：一个清爽的官方桌面端 + yootun 定制化。

## 2. 现状调查结论（摘要）

- 旧内核 fork（iTechwu/deepseek-harness，基线 0.1.7-rc.2，2026-09-27）共约
  126 个内容提交，其中约 40 个是「外挂桌面架构适配」（ELECTRON_RUN_AS_NODE 剥离、
  恢复官方已删除的 settings 旧门面 API 等）。官方 0.2.x 自带 `apps/desktop`
  （Electron 44.7 + `apps/desktop-host` + electron-updater 双通道）后，这一族补丁的
  前提消失，全部废弃。
- 旧桌面前端复用官方 Web UI、业务插件全部使用官方公共扩展点
  （`sidebar.brand.*`、`shell.overlay`、`settings.section` 等 slot，
  `ctx.webServer/tools` 服务，`cordis.patch.yml` bundle patch），
  无 dsh-plugin-desktop 私有 API 依赖——插件迁移是「换宿主版本」，不是换协议。
- 官方对换品牌有明确的组合路线：不加载 `dsh-client-ui-brand-official`，
  自有包占据 sidebar 品牌槽与 `conversation.hero.frame`
  （`packages/client/ui-brand-official/README.md` "Replacing the brand"）。
  Electron 壳层品牌（productName/appId/图标/feed URL）为源码级配置，
  由 `apps/desktop/scripts/electron-builder-config.mjs` 生成。
- 官方桌面打包工作流（`windows-package.yml` 等）依赖官方机房 self-hosted runner、
  EV 签名令牌与腾讯 COS，不可复用；需自建 GitHub-hosted workflow。
- 官方 CI 对 `packages/*/*/src` 有 per-file 100% 覆盖率等重门禁，
  自有包放独立 `yootun/` 分区以避开目录 scope。

## 3. 总体架构

单仓库三层定制，冲突面从内到外递减：

```
yootun-agent/
├── 官方原样区：packages/ vendor/ native/ apps/ docs/ scripts/   ← 零改动（第 0 层）
├── yootun/                        ← 自有分区（第 1 层，全部为新增文件）
│   ├── brand/        yootun 品牌配置与素材（图标、名称、appId、feed URL、
│   │                 默认模型/baseURL、baseVersion 元数据）
│   ├── client/       ui-brand-yootun（占官方品牌 slot）
│   ├── desktop/      企业层：key 激活 credentials provider、managed MCP 路由、访问门禁
│   ├── plugins/      勾选迁移的业务插件（@yootun/*，源自 docker-helm/plugins）
│   ├── bundle/       yootun 产品 bundle：把自有插件 + 默认配置组一层，插进 desktop profile
│   └── docs/         本方案、inline-changes.md（阶段 0 建）、upstream-sync.md（阶段 0 建）
├── .github/workflows/yootun-*.yml ← 自有 CI（独立命名，不与官方 workflow 冲突）
└── pnpm-workspace.yaml             ← 第 2 层：+一行 `yootun/**` glob
```

- **第 0 层**：官方目录原则上一个字不改。
- **第 1 层**：全部新增文件，同步上游零冲突。
- **第 2 层（登记内联改动）**：仅 `pnpm-workspace.yaml` 一行 glob、
  `apps/desktop` 品牌身份（改为从 `yootun/brand` 读输入后由官方
  `electron-builder-config.mjs` 生成）、浏览器标题构建变量一处。
  全部登记进 `yootun/docs/inline-changes.md`，能用生成脚本管理的绝不手改。

### 分支与同步模型

```
remote: origin   = meitingjun2025-hue/yootun-agent
remote: upstream = https://github.com/deepseek-ai/deepseek-harness.git

分支：
  upstream/master      只读引用，永不直接提交
  main                 唯一长期分支（默认），任何时刻保持可发包状态
  feat/<主题>          新功能开发分支，完成后 merge --no-ff 回 main 并删除
  sync/upstream-<日期>  上游同步分支（见下方 SOP）
```

日常开发工作流（2026-11-10 定稿，单人维护）：

- **新功能一律走 `feat/<主题>` 分支**，完成后 `merge --no-ff` 回 main；
  merge commit 即批次回滚单元（`revert -m 1` 一次回退整个功能）。
- **小修小动直接提交 main**：文档、文案、配置微调、单点修复。
- 红线不变：碰官方文件（第 0/2 层）先登记 `inline-changes.md`。
- main 不设 PR 门禁（单人维护，CI 上线后作为事后守门：push 即跑，红了立刻修）。
- 发版：从 main 打 tag，Actions 出包 → feed。

例行同步 SOP（写入 `yootun/docs/upstream-sync.md`）：

1. `git fetch upstream && git checkout -b sync/upstream-<date> main && git merge upstream/master`；
2. 冲突预期：`vendor/`（只接受官方）→ `pnpm-workspace.yaml`（保留 `yootun/**` 行）→
   `apps/desktop` 品牌文件（重跑品牌生成脚本覆盖）→ 其余应为空；
3. 先读官方新增 `docs/upgrade-guide/v<version>/*`，按指南适配第 1 层资产；
4. 验证：`pnpm install && pnpm run build`，聚焦跑受影响面（插件契约测试、
   桌面打包 smoke、快照测试）；
5. 同步 PR 合入 `main`；同步提交与功能提交分开。

节奏：官方 rc 趋稳后跟进，每 2–4 周一次；大版本升级先通读 upgrade-guide 全集再排期。

## 4. 迁移范围

### 迁移来源与只读红线（2026-11-13 增补）

定制内容迁移自两个旧仓库，实施期间**只读参照，严禁改动其中任何内容**
（含工作区文件、创建或切换分支、commit、push、tag）；两仓库的退役处置
属第五步，且只能由维护者本人执行。

| 来源仓库 | 参照分支 | 迁移资产 | 对应批次 |
|---|---|---|---|
| `docker-helm.dofe.ai` | master | `plugins/dsh-yootun-ui`（key 激活 UI 逻辑层，视觉不迁）；`plugins/brand`（品牌常量参照）；`plugins/` 其余业务插件（第三步按勾选清单分批迁） | 3 / 4 / 第三步 |
| `dsh-desktop` | dev（2.0.12-beta.x 版本线） | `dsh-plugin-desktop/`（llm patch、门禁判定、credential-migration、managed MCP ROUTES 蓝本）；`brand/`（`brand.config.json` 身份字段、`assets/` 源素材、生成脚本最小集） | 3 / 4 |

- 服务端（激活 API `/api/desktop/dofe/*`、mcp-gateway、nginx）属
  docker-helm 服务端职责，零改动，客户端只对接不修改；
- 旧自研更新器相关代码仅作调查参照，已定案整体废弃，不迁移；
- 本机克隆路径：`/home/ubuntu/projects/docker-helm.dofe.ai`、
  `/home/ubuntu/projects/dsh-desktop`（换开发环境时同步更新本表）。

### 迁移（全部随安装包内置）

1. **yootun 品牌**：前端品牌 slot 占位、窗口标题、图标、安装器品牌（仅 yootun，
   不做 sensteed 双品牌）。
2. **企业接入层**：首次登录输 key 激活 + key 管理模式（MODELS_API_KEY 托管）、
   managed MCP 路由（ixicai.cn/mcp）、访问门禁。**无 OIDC**（sso.ixicai.cn 属
   sensteed，不迁）。
3. **自动更新切换**：feed URL 指向自有端点，其余更新机制用官方原样。
4. **业务插件**：按勾选清单迁移（清单待定，见第 8 节）。

### 不迁移 / 不接入

| 项 | 处置 |
|---|---|
| `dsh-community-market`、`dshmarket`、第三方 Plugin Console | 不接。用户自选插件走官方 Settings → Plugins（`dsh plugin --profile desktop add`）；官方实验性 Discover 自定义索引（plugin-market-bundle）保持官方默认关闭，用户需要时自行开启（2026-11-13 定案） |
| sensteed 品牌全套、双品牌构建矩阵 | 不迁 |
| @linxin666 等 19 个第三方捆绑包 | 不内置，用户按需自装 |
| 旧内核 fork 外挂桌面适配补丁（~40 个）、SDK wire 扩展（7 个）、`dsh-desktop-next`、`_deprecated`、patches/ 死文件 | 全部废弃 |
| LAN HTTPS 远程控制、Setup Wizard 等官方没有的桌面功能 | 不补 |
| OIDC SSO（dofe-auth-oidc） | 不迁 |

## 5. 关键设计

### 5.1 品牌定制

- 前端：`@yootun/client-ui-brand` 占官方 slot（`sidebar.brand.mark/name`、
  `conversation.hero.frame`），浏览器标题走官方 `DSH_CLIENT_TITLE` 构建变量。
- Electron 壳：品牌身份（productName/appId/artifact 前缀/图标/feed URL）作为
  `yootun/brand` 配置输入，经官方 electron-builder 配置生成链产出——同步冲突时
  重跑生成脚本覆盖。
- `yootun/brand` 维护 `baseVersion`（基于的官方版本），显示在关于页与发布说明。

### 5.2 企业接入层（无 OIDC）

| 能力 | 官方机制 | 迁移形态 |
|---|---|---|
| 首次登录输 key（激活/管理 UI） | `settings.section` slot + live Config | `@yootun/client-ui`（源自 dsh-yootun-ui） |
| key 变模型凭证（MODELS_API_KEY + baseURL） | `packages/credentials` provider 体系 | `@yootun/credentials` host 插件 |
| managed MCP 路由 | 官方 `dsh-mcp-client` 实例 + bundle patch 声明 | 沿用现有 MCP bundle 插件形态 |

全部走 DSH 插件层，零内核改动。

### 5.3 业务插件内置与用户自选

- 勾选的插件迁入 `yootun/plugins/`（scope 改 `@yootun/*`），经
  `@yootun/desktop-bundle`（`dsh.bundle.patch` 一叠 insert + Config 覆盖行）
  插进 desktop profile，随安装包内置。
- desktop profile 的组装插接点（打包时生成 vs 首启创建）在阶段 1 查证，
  两条路径官方机制均有先例。
- 插件本体迁移含 0.1.7→0.2.2 适配（图标集/slot/客户端注入包名，
  有 0.1.6 删图标致 React #130 崩溃先例），用 docker-helm 的
  `desktop-compat` 契约测试与能力矩阵审计脚本护航（一并移植到 `yootun/scripts/`）。
- 插件 UI/UX 一律按 `yootun/docs/1110/05-ui-ux.md` 规范重做（2026-11-10 定为
  长期规范）：旧插件的样式实现与视觉不迁移，只迁移交互逻辑与数据面；验收含
  设计合规检查。
- 用户自选插件走官方插件管理器，官方行为原样。
- 官方插件能力原样保留（Plugins 页管理与会话创建插件）；实验性 Discover 自定义索引
  保持官方默认关闭（2026-11-13 定案，见 1110 分册 03 F 部分）；DeepSeek 官方 key
  保留官方设置页自配（可选），yootun key 激活强制不变。

### 5.4 MCP 权限双通道（会话只读 / 插件页面全能力）

| 通道 | 机制 | 效果 |
|---|---|---|
| 会话 | mcp-gateway 按连接裁剪 `tools/list`（只广告查询/展示类工具）；可选自有 guard 插件监听 `tools/pre-execute`，对写/采集类调用 `deny` 或 `ask`（executor 级强制，`packages/core/tools/src/contracts.ts` `PreToolDecision`） | 模型只见/只用查询与数据展示 |
| 插件页面 | 插件 host 侧本地路由（`ctx.webServer.register` 同源接口）直连 MCP 全能力端点或业务 API，独立于会话 `ctx.tools` 体系 | 全能力 |

零内核改动：裁剪在自有 mcp-gateway，策略插件与插件路由均为标准 DSH 插件形态。

### 5.5 版本、发版与自动更新

- **版本体系用官方的**：桌面版本 = 官方 dsh 基线版本（Electron 与 dsh 恒等的
  官方原则），自有 `baseVersion` 元数据标注对应关系。无版本号内联改动。
- **发版 = GitHub Actions 自动构建**（本地不构建）：自建 `yootun-*.yml` workflow，
  手动 dispatch 或 push tag 触发；windows-latest / macos-latest 上跑官方
  `build` 链 + `package:desktop:*:unsigned` 脚本；产物上传自有 feed。
  官方 self-hosted 打包流水线不可复用，不引用。
- **更新通道**：官方 electron-updater generic provider + nightly/stable 双通道 +
  设置页切换，全部官方原样；仅 feed 端点换自有地址（品牌配置的一部分）。
- **升级策略：首装切换，不做跨代自动升级**。旧桌面（2.0.12-beta.5）冻结只修 P0，
  新桌面作为新一代发布。理由：跨内核换代会话/设置数据模型不连续，自动更新会把
  「不兼容升级」伪装成兼容升级，且不可灰度、不可回退。存量用户少则连旧桌面
  提示横幅都可省（待确认）。
- Windows 包维持 unsigned（SmartScreen 提示与现状一致）；如后续购买代码签名
  证书，官方链路支持切换 signed。

### 5.6 上游同步的兼容性关注点

- `vendor/` 升级是大 diff，只接受官方版本，fork 不改 vendor；
- `SESSION_FORMAT_VERSION` 迁移链：跟随官方 upgrade-guide，发版前用真实用户
  数据演练升级；
- bundle patch 行以 id 定位，上游重命名只打警告，修复成本一行；
- 官方 pre-stable API（slot/`dsh.client.inject`/PLATFORM_MODULES）变化以
  upgrade-guide 为准；自有插件声明 `engines.dsh`/peer 范围，组合边界显式报不兼容。

## 6. 分阶段实施计划

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| 0 基线护栏 | upstream remote + main 分支；`yootun/` 分区 + 官方 gate 波及面实测（`test:coverage`/`hygiene`/`constraints`/`doc-sync`）；inline-changes.md 与 upstream-sync.md；自建打包 workflow 跑通（先出未品牌化官方桌面包，实测 GH-hosted 构建时长） | Actions 上出未品牌化官方桌面 win/mac 包 | 2–3 天 |
| 1 品牌桌面 | `yootun/brand` + 生成脚本；ui-brand-yootun 占 slot；查证 desktop profile 组装点并接入 yootun bundle 空层；默认模型/baseURL patch | Actions 出 yootun 品牌安装包，可安装、可检测更新（指向自有 feed） | 3–5 天 |
| 2 企业层 | key 激活 UI + credentials provider + managed MCP + 门禁 | 新桌面 key 激活生效 + MCP 路由连通 | 3–4 天 |
| 3 插件勾选迁移 | 按勾选清单分批；每批 0.2.2 适配 + 契约测试 + 真机验收（小件 1–3 天/个，douyin/xhs 大件 3–5 天） | 全部勾选插件可用；能力矩阵审计通过 | 随清单 |
| 4 发版与切换 | 新 feed 首装发布；旧桌面冻结；两代并行观察；（可选）旧桌面新版提示 | 试点用户完成首装切换；自动更新闭环验证 | 1 周 |
| 5 收尾退役 | docker-helm 摘除已迁插件、dsh-desktop 归档、旧内核 fork 冻结 | 旧仓库只读 | 2–3 天 |

阶段 0 先打通 Actions 打包是刻意的：本地不能构建，后续每个里程碑验收都依赖它出包。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 插件 0.1.7→0.2.2 适配（图标删除致 React #130 先例） | 每批先跑 `desktop-compat` 契约测试（含图标导出守卫）；接入官方快照测试 |
| 官方 gate 波及 `yootun/` 分区 | 阶段 0 实测全局 gate，逐条给出目录排除/满足/豁免结论后再迁入 |
| 内联文件同步冲突 | 品牌文件生成式管理；内联清单 ≤5 处并登记 |
| SESSION_FORMAT 升级 | 跟随 upgrade-guide；发版前真实数据演练 |
| GH-hosted 完整构建时长/成本 | 阶段 0 实测，必要时缓存 pnpm store 与 electron-builder 产物 |
| desktop profile 组装点不确定 | 阶段 1 首个查证项，两条路径均有官方先例 |

## 8. 待确认事项

1. **插件/MCP 勾选清单**（进行中）：建议必选 `dsh-yootun-ui`（品牌 + key 激活 UI
   前提）；其余按业务勾选，MCP bundle 随功能依赖自然带出。
2. **feed 托管位置**：ixicai.cn nginx 目录 / 对象存储 / GitHub Releases
   （决定 workflow 上传步骤与品牌配置 URL）。
3. **旧桌面是否加「新一代发布」提示横幅**（取决于存量用户量）。

## 9. 旧仓库退役处置

迁移期间两仓库只读（第 4 节只读红线）；本节处置动作全部在第五步执行，且由维护者本人操作。

- `docker-helm.dofe.ai`：桌面相关部分（`plugins/`、快照同步脚本）冻结归档；
  服务端基础设施（docker-compose、mcp-gateway、nginx、jenkins、各服务部署、
  GEO 自动化服务端、CLI 工具镜像）保留原职责，转型为纯服务端运维仓库。
- `dsh-desktop`：归档（含 `dsh-desktop-next`、`_deprecated`、patches/）；
  仍有效的架构决策记录择要迁入 `yootun/docs/`。
- `iTechwu/deepseek-harness`：冻结只读。
