# 分册 01：yootun/ 分区骨架与基线护栏

批次 1（`feat/migration-step1-scaffold`）实施依据。

## 1. 目标

建立 `yootun/` 自有分区（第 1 层）并接入 pnpm workspace，落定官方 CI gate 对该分区的波及结论，建立 `inline-changes.md` 与 `upstream-sync.md` 两份护栏文档。

## 2. 目录树（本批建立骨架，空位留目录 + README 占位）

```
yootun/
├── brand/                        品牌输入单一来源（批次 3 填充）
│   ├── brand.json                名称/appId/feed/标题/租户常量/VALIDATION_VERSION 等元数据
│   ├── assets/                   app-icon 源图(1024)、sidebar-mark、hero-mark、wordmark
│   └── scripts/                  素材生成脚本（从旧桌面 brand 精简迁移）
├── packages/
│   ├── dsh-client-ui-brand/      品牌前端包：品牌 slot 占位（批次 3）
│   ├── dsh-client-ui-access/     激活前端包：key 激活页 + 门禁（批次 4）
│   └── dsh-bundle-yootun/        yootun 产品 bundle（批次 3 起逐批充实）
├── scripts/                      自有工具脚本（品牌环境生成等，批次 3）
├── docs/
│   ├── migration-plan.md         总纲（已存在）
│   ├── 1110/                     本方案（已存在）
│   ├── inline-changes.md         第 2 层内联改动登记（本批建立）
│   └── upstream-sync.md          上游同步 SOP（本批建立）
└── README.md                     分区导航（本批建立）
```

包命名约定：npm scope 一律 `@yootun/*`（对齐官方 `@deepseek-ai/dsh-*` 模式）；Cordis 插件/bundle id 一律 `yootun-*` / `yootun` 前缀，避免与官方 id 冲突（patch 同 id 后层胜出，id 冲突即覆盖，是有意机制而非事故）。

## 3. workspace 接入

`pnpm-workspace.yaml` 的 `packages:` 列表追加一行：

```yaml
  - yootun/packages/*
```

（不采用 `yootun/**`——brand/scripts/docs 不该被当包扫描，收窄 glob 更干净；这就是总纲所说「第 2 层一行 glob」的最终形态，内联清单 #1。）

随后 `pnpm install` 刷新根 `pnpm-lock.yaml`（CI 用 `--frozen-lockfile`，workspace 变更必须同步 lockfile，否则全红）。本批先放一个最小可安装的占位包（如 `@yootun/scripts-brand` 的空壳或仅留 workspace 不放包——推荐**直接不留包**，只加 glob 行；lockfile 无变化时 install 零 diff，批次 3 放首个包时再刷 lockfile。二选一，实施时按 lockfile diff 最小原则定）。

## 4. 官方 gate 波及结论（批次 1 实测核验）

代码级调查结论 + 批次 1 以真实命令核验：

| gate | 是否扫 `yootun/` | 说明 |
|---|---|---|
| `test:coverage` | **否** | vitest include 硬编码 `packages/*/*/src/**`；yootun 源码与测试均不进官方覆盖门禁（也不被官方测试跑——自有测试自带自跑） |
| `hygiene`（publint/package-deps/runtime-closure/node-next 等） | **否** | 各 leaf gate 的 glob 只含 `packages/*/*`、`vendor/*`、`apps/*` |
| `doc-sync` | **否** | md-links/md-wrap 的 pattern 不含 `yootun/docs/**`（yootun 文档不受官方文档门禁，也自动不进文档站） |
| `duplication` | **否** | jscpd 只扫 `packages scripts` |
| `constraints` | **部分** | workspace 成员协议检查覆盖所有 pnpm-workspace 成员：@yootun 包依赖 workspace 成员时，依赖官方包必须写 `workspace:*`。发布类 manifest 规则不扫 yootun |
| `lint`（oxlint） | **是** | 全仓扫描，yootun 下 TS/TSX 会被解析并吃到通用规则——按官方代码质量标准写即可 |
| pnpm install | **是** | lockfile 一致性（见第 3 节） |

批次 1 核验动作：加完 glob 后跑 `pnpm run constraints && pnpm run lint && pnpm install --frozen-lockfile`，把结论（含任何意外）记入 `upstream-sync.md` 附录。若后续某 gate 出人意料扫到 yootun，处置优先级：满足规则 > 目录排除（找 scripts 对应 glob 白名单）> 登记豁免。

## 5. 护栏文档（本批建立）

### 5.1 `yootun/docs/inline-changes.md`

第 2 层内联改动登记簿，格式（初始内容按 00-overview 第五节 7 处预登记，状态标「计划」；批次 3/4 落实后改「已落实」并补 commit 号）：

```
| # | 文件 | 改动 | 状态 | 落实 commit | 同步策略 |
```

红线：任何第 0/2 层官方文件改动必须先登记后动工；批次结束时 `git diff master..main --stat -- <官方目录>` 与登记簿对账。

### 5.2 `yootun/docs/upstream-sync.md`

上游同步 SOP（从总纲第 3 节落地成可执行清单）：fetch upstream → `sync/upstream-<date>` 分支 merge → 冲突预期清单（vendor 全取官方 / pnpm-workspace.yaml 保自有行 / 第 2 层 7 处按登记簿重放，其中品牌 4 处改完跑品牌环境脚本自动生成）→ 读官方 upgrade-guide → `pnpm install && pnpm run build` → yootun 自有测试 + 受影响面官方测试 → merge 回 main。附 gate 波及结论（第 4 节表格）与历次同步记录表。

## 6. 验收

- [ ] `yootun/` 目录树就位，README 导航可用；
- [ ] `pnpm-workspace.yaml` 含 `yootun/packages/*` 且 `pnpm install` / `constraints` / `lint` 全绿；
- [ ] 两份护栏文档建立，inline-changes.md 含 7 处预登记；
- [ ] gate 波及结论实测记录写入 upstream-sync.md 附录；
- [ ] review 子代理验证通过，本地 commit。
