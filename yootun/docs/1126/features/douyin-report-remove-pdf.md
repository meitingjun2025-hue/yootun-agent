# douyin-report-抖音 AI 报表去除 PDF 导出 实施单

状态：已确认，待实施 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台「AI 报表」的详情页有两个导出按钮：「导出 HTML」与「导出 PDF」（`yootun/plugins/dsh-douyin-workbench/src/client/ReportPage.tsx`）。HTML 导出在浏览器内生成自包含单文件。PDF 导出依赖桌面端注入的桥 `window.desktopNext.exportReportPdf`，这个桥在桌面端从未实现：全仓只有 `ReportPage.tsx` 引用它，官方代码里没有 `desktopNext`。用户点击后只能得到「当前宿主暂不支持该导出方式」。既有用例「PDF 桥不可用：稳定报 export_unsupported，不假成功」固定的是这个不可用状态。

视频号 AI 报表只做 HTML 导出（[wx-report-client.md](wx-report-client.md)）。抖音先移除 PDF 入口，两个平台的导出面对齐。

### 0.2 目标

删除 PDF 导出入口及其专属代码、词条与用例。HTML 导出、重新生成、版本切换的行为与界面不变。

## 1. 范围

做：

- `ReportPage.tsx`：删除 `DesktopNextBridge` 接口、PDF 导出回调与其状态、「导出 PDF」按钮；头注释去掉 PDF 描述；
- `locales.ts`：删除 `report.exportPdf` 与 `reason.export_unsupported`（zh、en 各两条；后者在插件内只有 PDF 导出使用）；
- 测试：`tests/client/douyin-client.test.tsx` 报表详情用例里的「PDF 按钮存在」断言改为「不存在」；删除用例「PDF 桥不可用：稳定报 export_unsupported，不假成功」；`tests/client/douyin-parity.test.tsx` 头注释中的「PDF 导出」一项标注已移除；
- [14 册 §10](../../1110/14-douyin-workbench-ui-layout-parity.md) 页面结构里的「HTML / PDF 导出」改为「HTML 导出」，并注明移除日期与原因。

不做：

- 不改 HTML 导出的内容、样式与文件名；
- 不改 Host action 与 tools 契约；
- 不删导出样式表里的 `@media print` 规则：它服务于用户用浏览器打印导出的 HTML，与 PDF 按钮无关；
- 不动官方目录。

## 2. 契约增量

MCP 工具：无。Host action：无变化（`report.list` / `report.get` / `report.regenerate` 的入参与出参不变）。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 纯界面 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/ReportPage.tsx` | 删 PDF 桥接口、回调、状态与按钮 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/locales.ts` | 删 2 个词条（zh、en） | 是 | 文案 locale-owned，不留悬空键 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/client/douyin-client.test.tsx`、`douyin-parity.test.tsx` | 改 1 条断言、删 1 条用例、改注释 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/14-douyin-workbench-ui-layout-parity.md` §10 | 导出面描述 | 是 | 分册是布局记录 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

与 1126 其他单的关系：`ReportPage.tsx` 同时被 [client-workbench-hooks.md](client-workbench-hooks.md)（`attemptId` 改从 `format.ts` 导入、页面 props 增加 `locale`）与 [ui-accessibility-and-visual-cleanup.md](ui-accessibility-and-visual-cleanup.md) 修改。本单只动 PDF 相关的行，可以先行；后合入的一方按行解决冲突。报表页整体上移到共享包在 [wx-report-client.md](wx-report-client.md)，排在本单之后。

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文、14 册 §10、1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | | `feat/douyin-report-remove-pdf` | 待填 |
| yootun-agent 合入 `main` | | | 待填 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，合入前）

- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过；
- [ ] `pnpm run verify-client-ui-i18n` 通过：删除词条后没有残留引用；
- [ ] `grep -rnE "exportPdf|exportReportPdf|export_unsupported|report\.exportPdf" yootun/plugins/dsh-douyin-workbench/src yootun/plugins/dsh-douyin-workbench/tests` 无输出；
- [ ] 报表页其余既有用例的断言未改。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| R1 | 抖音工作台进入「AI 报表」，打开一份已生成的报表 | 操作区只有「导出 HTML」，没有「导出 PDF」 |
| R2 | 点击「导出 HTML」 | 得到 HTML 文件，内容与移除前一致 |
| R3 | 明暗主题各看一次 | 按钮区没有空位与错位 |

### 5.3 本地联调记录

待填（合入前回填）。
