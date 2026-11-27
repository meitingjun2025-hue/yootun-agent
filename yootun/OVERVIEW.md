# yootun/ 企业定制分区

本目录是 yootun 企业定制层（迁移总纲三层定制模型的第 1 层），全部为新增文件，与官方目录（`packages/` `vendor/` `apps/` `docs/` `scripts/` `.github/`）物理隔离，上游同步时零冲突。分区导航文件为本文（OVERVIEW.md）；分区内不使用 README.md 命名。

实施依据与决策记录见 [docs/migration-plan.md](docs/migration-plan.md)（总纲）与 [docs/1110/00-overview.md](docs/1110/00-overview.md)（第一步总述）。

## 目录结构

| 目录 | 用途 | 填充批次 |
|---|---|---|
| `brand/` | 品牌输入单一来源：`brand.json`（名称/appId/feed/标题/租户常量/VALIDATION_VERSION 元数据）、`assets/`（app-icon 源图、sidebar-mark、hero-mark、wordmark）、`scripts/`（素材生成脚本） | 批次 3 |
| `packages/dsh-client-ui-brand/` | 品牌前端包 `@yootun/dsh-client-ui-brand`：占官方品牌 slot（sidebar.brand、conversation.hero.frame） | 批次 3 |
| `packages/dsh-client-ui-access/` | 激活前端包 `@yootun/dsh-client-ui-access`：key 激活页 + 门禁 | 批次 4 |
| `packages/dsh-workbench-host-kit/` | Host 侧共享库 `@yootun/dsh-workbench-host-kit`：同源路由信任判定与 action 分发、任务登记表、profile 锁、状态文件原子写与按 root 写队列、系统 Chrome 探测与浏览器生命周期；三工作台与 managed-mcp / media-upload 消费 | 2026-11-27（workbench-host-kit 单） |
| `packages/dsh-client-workbench-machines/` | 纯 client 数据流包 `@yootun/dsh-client-workbench-machines`：登录、单账号采集、批量采集、作品查询四个 machine 的状态与竞态守卫（无 React/DOM）；插件以 `flows.ts` 适配层接入各自 Host action 投影，页面经 `useSyncExternalStore` 订阅 | 2026-11-27（client-workbench-hooks 单） |
| `packages/dsh-bundle-yootun/` | yootun 产品 bundle：自有插件 + 默认配置组层，插进 desktop profile | 批次 3 起逐批充实 |
| `plugins/` | `@yootun/dsh-*` 插件：managed MCP、Workbench 私有连接器、媒体上传、视频号 / 小红书 / 抖音三个工作台（Host 半 + client 半） | 第三步 P1–P4 |
| `scripts/` | 自有工具脚本（品牌环境生成、desktop-compat 契约测试、插件 runtime bundle 校验等） | 批次 3 起 |
| `docs/` | 迁移总纲、跨仓流程、实施分册、护栏文档；`docs/<MMDD>/features/` 按建单日期存放实施单 | 已就位 |
| `AGENTS.md` | 分区 agent 约定（`CLAUDE.md` 软链指向它）：改动前必须知道的规则与指针 | 2026-11-24 |

`brand/`、`packages/`、`scripts/` 下的空位目录以 `.gitkeep` 占位，后续批次填充时移除。

## 命名约定

- npm scope 一律 `@yootun/*`（对齐官方 `@deepseek-ai/dsh-*` 模式）；
- Cordis 插件/bundle id 一律 `yootun-*` / `yootun` 前缀，避免与官方 id 冲突（patch 同 id 后层胜出，id 冲突即覆盖，是有意机制而非事故）；
- pnpm workspace 接入 `yootun/packages/*` 与 `yootun/plugins/*`（见根 `pnpm-workspace.yaml`，登记于 inline-changes #1）；`brand/`、`scripts/`、`docs/` 不进 workspace，不当包扫描。

## 护栏文档

- [docs/cross-repo-sync.md](docs/cross-repo-sync.md) — **跨仓变更流程**：tools（契约唯一来源）/ docker-helm（部署）/ yootun-agent（消费）三仓分工、MCP 白名单机制、改 X 动哪几个仓的速查表、实施单与顺序门禁；
- [docs/feature-template.md](docs/feature-template.md) — 实施单模板：每个业务特性一份，先建单再动代码，按建单当日放入 `docs/<MMDD>/features/`；首份 [1124/features/infra-whitelist-domain-gate.md](docs/1124/features/infra-whitelist-domain-gate.md) 是白名单域级放行的实施与验收单；
- [docs/inline-changes.md](docs/inline-changes.md) — 第 2 层内联改动登记簿：官方目录允许触碰的全部位置，先登记后动工；
- [docs/upstream-sync.md](docs/upstream-sync.md) — 上游同步 SOP、官方 gate 波及结论、历次同步记录；
- [docs/plugin-ui-ux-standard.md](docs/plugin-ui-ux-standard.md) — 后续业务插件的统一 UI/UX 规范：官方底盘、yootun 复合组件、插件场景层与助手 Dock / 图表模式。
- [docs/1110/](docs/1110/00-overview.md) — 第一步迁移分册（历史记录，按日期冻结）。其中 08 册（MCP 桌面接入契约）与 09 册（工作台迁移计划）的现行条款以 cross-repo-sync.md 为准，冲突处已在分册内标注调整日期。
- [docs/1124/](docs/1124/00-overview.md)、[docs/1125/](docs/1125/00-overview.md)、[docs/1126/](docs/1126/00-overview.md)、[docs/1127/](docs/1127/00-overview.md) — 按建单日期存放的实施单索引；每天建单各开一个 `docs/<MMDD>/` 目录（规则见 [cross-repo-sync.md](docs/cross-repo-sync.md) 第四节）。

## 红线摘要（逐条标注出处，全文见总纲与分册）

- 官方目录零改动，允许项以 [docs/inline-changes.md](docs/inline-changes.md) 登记簿为准（总纲第 3 节三层定制模型）；
- `tools.dofe.ai` 是 MCP 契约与实现的唯一来源，`docker-helm.dofe.ai` 只做部署（路由 / nginx / compose），两仓的改动按 [docs/cross-repo-sync.md](docs/cross-repo-sync.md) 走实施单；`docker-helm.dofe.ai/plugins/dsh-yootun-*` 旧插件与 `dsh-desktop` 不再维护，只读参照（2026-11-24 定案，替代总纲第 4 节"迁移期只读"）；
- 分区内禁止 README.md 命名（分区导航用 OVERVIEW.md）；文档禁止裸 commit hash（用版本号/日期标注）（00-overview 第二节，2026-11-13 定案）；
- Workbench 面按域放行，yootun-agent 不持有工具名清单；Agent 面两张策略表之外的 `yootun_*` 工具 `ask`；工具数量不写进任何仓的代码、注释、测试或部署配置（cross-repo-sync 第二节）；
- yootun 分区测试不进官方 vitest scope，各包自带可自跑的 `node --test` 脚本（00-overview 第七节实施流程约定）。
