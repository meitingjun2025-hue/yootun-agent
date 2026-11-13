# yootun/ 企业定制分区

本目录是 yootun 企业定制层（迁移总纲三层定制模型的第 1 层），全部为新增文件，与官方目录（`packages/` `vendor/` `apps/` `docs/` `scripts/` `.github/`）物理隔离，上游同步时零冲突。分区导航文件为本文（OVERVIEW.md）；分区内不使用 README.md 命名。

实施依据与决策记录见 [docs/migration-plan.md](docs/migration-plan.md)（总纲）与 [docs/1110/00-overview.md](docs/1110/00-overview.md)（第一步总述）。

## 目录结构

| 目录 | 用途 | 填充批次 |
|---|---|---|
| `brand/` | 品牌输入单一来源：`brand.json`（名称/appId/feed/标题/租户常量/VALIDATION_VERSION 元数据）、`assets/`（app-icon 源图、sidebar-mark、hero-mark、wordmark）、`scripts/`（素材生成脚本） | 批次 3 |
| `packages/dsh-client-ui-brand/` | 品牌前端包 `@yootun/dsh-client-ui-brand`：占官方品牌 slot（sidebar.brand、conversation.hero.frame） | 批次 3 |
| `packages/dsh-client-ui-access/` | 激活前端包 `@yootun/dsh-client-ui-access`：key 激活页 + 门禁 | 批次 4 |
| `packages/dsh-bundle-yootun/` | yootun 产品 bundle：自有插件 + 默认配置组层，插进 desktop profile | 批次 3 起逐批充实 |
| `scripts/` | 自有工具脚本（品牌环境生成、desktop-compat 契约测试等） | 批次 3 |
| `docs/` | 迁移总纲、实施分册、护栏文档 | 已就位 |

`brand/`、`packages/`、`scripts/` 下的空位目录以 `.gitkeep` 占位，后续批次填充时移除。

## 命名约定

- npm scope 一律 `@yootun/*`（对齐官方 `@deepseek-ai/dsh-*` 模式）；
- Cordis 插件/bundle id 一律 `yootun-*` / `yootun` 前缀，避免与官方 id 冲突（patch 同 id 后层胜出，id 冲突即覆盖，是有意机制而非事故）；
- pnpm workspace 只接入 `yootun/packages/*`（见根 `pnpm-workspace.yaml`）；`brand/`、`scripts/`、`docs/` 不进 workspace，不当包扫描。

## 护栏文档

- [docs/inline-changes.md](docs/inline-changes.md) — 第 2 层内联改动登记簿：官方目录允许触碰的全部位置，先登记后动工；
- [docs/upstream-sync.md](docs/upstream-sync.md) — 上游同步 SOP、官方 gate 波及结论、历次同步记录。

## 红线摘要（逐条标注出处，全文见总纲与分册）

- 官方目录零改动，允许项以 [docs/inline-changes.md](docs/inline-changes.md) 登记簿为准（总纲第 3 节三层定制模型）；
- 旧仓库（docker-helm.dofe.ai、dsh-desktop）只读参照，严禁任何改动（总纲第 4 节）；
- 分区内禁止 README.md 命名（分区导航用 OVERVIEW.md）；文档禁止裸 commit hash（用版本号/日期标注）（00-overview 第二节，2026-11-13 定案）；
- yootun 分区测试不进官方 vitest scope，各包自带可自跑的 `node --test` 脚本（00-overview 第七节实施流程约定）。
