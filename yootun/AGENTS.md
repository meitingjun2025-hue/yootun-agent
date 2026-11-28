# yootun/ 分区约定

本分区是企业定制层（迁移总纲第 1 层，全部新增文件）。导航、目录结构与红线全文见 [OVERVIEW.md](OVERVIEW.md)；本文只列改动前必须知道的规则。根目录 [AGENTS.md](../AGENTS.md) 的官方约定（Cordis 注册即 effect、typed events、`HarnessError`、无 `as unknown`、JSDoc、文案 locale-owned 等）在本分区同样适用。

## 仓库边界

- 官方目录（`packages/` `vendor/` `apps/` `docs/` `scripts/` `.github/` `native/` `benchmarks/` `website/` `python/`）零改动；确需改动先登记 [docs/inline-changes.md](docs/inline-changes.md)，再动工。
- 分区内不建 `README.md`，导航文件是 `OVERVIEW.md`；文档不写裸 commit hash，用日期或版本号。

## 跨仓改动

- 流程与速查表：[docs/cross-repo-sync.md](docs/cross-repo-sync.md)。`tools.dofe.ai` 是 MCP 契约与实现的唯一来源；`docker-helm.dofe.ai` 只做部署；本仓只做消费。`docker-helm.dofe.ai/plugins/dsh-yootun-*` 旧插件不再维护。
- 新增或维护任何业务特性，先复制 [docs/feature-template.md](docs/feature-template.md) 到建单当日目录 `docs/<MMDD>/features/`（`<MMDD>` 为建单当日，如 [docs/1124/features/](docs/1124/00-overview.md)）建实施单（范围 / 契约增量 / 影响面 / 状态回填 / 验收），并在该目录 `00-overview.md` 登记一行，再动代码。契约增量先于代码。

## MCP 白名单

- Workbench 面（`plugins/dsh-workbench-mcp`）：按域放行，`CALLER_DOMAINS` + `workbench_<domain>_` 前缀；本仓不持有 Workbench 工具名清单；连接只校验 `serverName`，不做 `tools/list` 子集校验；域内未广播 → `workbench_tool_unavailable`。
- Agent 面（`plugins/dsh-managed-mcp`）：`guard.ts` 的 `READ_TOOLS` 免审批，`TASK_WRITE_TOOLS` / `SCHEDULE_WRITE_TOOLS` 固定审批；三表之外的 `yootun_*` 工具 `ask`；审批卡片文案在 `locales.ts`，中英文成对；`yootun-workbench` / `yootun-catalog` 在普通会话 `deny`。
- 工具数量不写进代码、注释、测试或部署配置；清单以 tools.dofe.ai `docs/1116/yootun-mcp.md` 为准。
- 规格：[cross-repo-sync.md](docs/cross-repo-sync.md) 第二节；落地记录：[1124/features/infra-whitelist-domain-gate.md](docs/1124/features/infra-whitelist-domain-gate.md)。

## 构建与测试

- 分区测试不进官方 vitest scope；各包 `pnpm --filter <pkg> test` 自跑，包源码的类型门是该包的 `build`（`tsc -p tsconfig.json && tsdown`）；测试的类型检查不在这两道检查里，只有测试类型门禁 `node yootun/scripts/typecheck-tests.mjs`，提交前按包运行、CI 构建后全量运行，压制写法与处置规则见 [docs/test-type-safety-standard.md](docs/test-type-safety-standard.md)。
- 新增测试文件按被测的功能或修复后的行为命名（如 `session.test.ts`、`batch-concurrency.test.ts`、`abort.test.ts`），文件名不使用实施单或分册的章节号、用例编号、轮次或批次号（如 `d2.test.ts`、`d4d5.test.ts`、`lifecycle3.test.ts`、`p0-fixes.test.ts`）；已有这类文件名的测试保持不动，修改时沿用原文件。
- 改动触及官方 gate 的全仓清单项（`verify-no-unknown-casts`、`verify-cordis-root`、oxlint）时按官方标准写；`pnpm run lint` 全仓扫描本分区。
- 浏览器页面不读 `MODELS_API_KEY`、Cookie、storage_state 或本地路径；所有远端调用经 Host 同源路由。
