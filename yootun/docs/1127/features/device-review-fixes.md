# workbench-真机验收修复 实施单

状态：开发完成（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-27 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

来源：2026-11-27 真机客户端验收反馈（P0、P1 与视频号 AI 报表客户端合入后的第一轮），涉及抖音工作台的账号总览页、账号作品页与视频号工作台的顶级导航。需求由用户在反馈中直接给出，修复在 `main` 上实施。

## 1. 范围

做：

- 抖音顶级导航：4 个顶级 Tab 不再横向铺满，容器按内容收敛。
- 抖音账号总览页：不再渲染左侧账号管理栏，恢复全宽布局；账号管理栏只在「账号作品」页出现。
- 抖音账号作品页：KPI 行去掉最小行高，卡片下方的空白消失，作品列表可用高度变大。
- 视频号顶级导航：第三个 Tab 由「AI 报表」改为「报表」，与抖音顶级导航的「报表」一致。

不做：

- tools.dofe.ai、docker-helm.dofe.ai 的任何改动。
- 抖音顶级导航的分组、顺序与二级控件；账号总览的下钻路径（账号行的「查看分析」进入单账号分析）与筛选条件。
- 「AI 报表」作为功能名的用法：共享包报表页内、Host action 说明、Agent 面工具名都不变，只改视频号的 Tab 文案。
- 视频号、小红书的 Tab 容器限宽方式（固定 `max-width: 480px`）。

## 2. 契约增量

MCP 工具、Host action、路由、稳定码：无变化。本单只有界面与文案。

### 2.1 顶级导航的宽度

官方 `SegmentedTabs` 按项数等分（`gridTemplateColumns: repeat(n, minmax(0, 1fr))`），容器多宽每项就多宽，容器必须限宽。视频号与小红书给容器 `max-width: 480px`；抖音顶级有 4 项，英文标签「Material and knowledge」在 480px 下放不下，所以抖音的 `.tabsRow` 用 `width: fit-content`：宽度等于项数乘以最宽一项，窄容器下受容器宽度约束。二级 `SegmentedControl` 随内容宽度，不变。

### 2.2 账号管理栏的归属

账号管理栏只在 `tab === 'works'` 时与作品面板一起渲染（两栏布局 `worksLayout`）。「账号总览」页（未进入单账号分析时）与单账号分析页同构，直接渲染在面板里，页面全宽。总览页两张表格的滚动高度随 `.tableWrap` 的默认值（`max-height: 62vh`），与窄容器下的现状一致。[douyin-tabs-regroup.md](../../1126/features/douyin-tabs-regroup.md) 2.2 的「数据组两个页面共用账号管理栏」自此不再适用；[14 册](../../1110/14-douyin-workbench-ui-layout-parity.md) §4 的「账号总览使用全宽布局」恢复为现状。

### 2.3 作品 KPI 行高

`.summaryGrid` 不再设最小行高，行高随 kit `KpiCard` 的内容，同一行卡片等高。最小行高来自早先的「作品列表区域固定高度」改动，用意是脚注换行时行高不变；卡片换成 kit `KpiCard` 后内容不足 120px，多出的部分成为卡片下方的空白。脚注文案固定，是否换行只取决于容器宽度、不随数据变化，列表区域高度稳定的用意不受影响。去掉后 kit `KpiCard` 的加载骨架态高 100px、就绪态高 102px，有 2px 差；在账号作品页的两栏布局下由下方撑满剩余高度的表格容器吸收，页面总高不变。抹平这 2px 要改 kit 的数值骨架高度，不在本单范围。

### 2.4 视频号 Tab 文案

| 键 | zh | en |
|---|---|---|
| `tab.report` | 报表 | Reports |

与抖音顶级导航的 `nav.group.report`（「报表」/「Reports」）逐字相同。

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 契约不变 |
| docker-helm.dofe.ai | — | 无 | 否 | 无新路由 / 队列 / env / URL |
| yootun-agent | 抖音 `src/client/WorkbenchPage.tsx` | 账号管理栏只在账号作品页渲染；总览页独立分支 | 是 | 2.2 |
| yootun-agent | 抖音 `src/client/workbench.module.css` | `.tabsRow` 按内容收敛；`.summaryGrid` 去掉最小行高 | 是 | 2.1、2.3 |
| yootun-agent | 抖音 `tests/client/douyin-client.test.tsx` | N5 改为总览不渲染账号管理栏；新增两条布局守护 | 是 | 行为随实现变更 |
| yootun-agent | 视频号 `src/client/locales.ts` | `tab.report` 词条 | 是 | 2.4 |
| yootun-agent | 视频号 `src/client/WorkbenchPage.tsx`、`workbench-ui.ts`、`tests/client/wx-page.test.tsx` | 注释与用例名里的 Tab 名；W1 锁定文案 | 是 | Tab 名的引用处 |
| yootun-agent | [14 册](../../1110/14-douyin-workbench-ui-layout-parity.md) §5、§11 | KPI 行高、顶级导航宽度 | 是 | 分册是布局记录 |
| yootun-agent | [11 册](../../1110/11-wx-workbench-ui-layout-parity.md) §1、§2、§11 | Tab 名 | 是 | 分册是布局记录 |
| yootun-agent | [douyin-tabs-regroup.md](../../1126/features/douyin-tabs-regroup.md) 2.2、[wx-report-client.md](../../1126/features/wx-report-client.md) 2.6、[1126 索引](../../1126/00-overview.md) | 修订说明与 Tab 名 | 是 | 被修订的条款 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 开发完成（自动验收通过） | 2026-11-27 | `main` | 见 5.1、5.3 |
| 真机验收 | | | 待用户执行，见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行）

- [x] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过；
- [x] `pnpm --filter @yootun/dsh-wx-channels-workbench test`、`build` 通过；
- [x] 仓库级：`pnpm run lint`、`pnpm run verify-client-ui-i18n`、`pnpm run verify-export-jsdoc`；
- [x] 独立 review 通过，阻断 0 条。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| D1 | 抖音工作台，中文与英文界面 | 顶部 4 个顶级 Tab 不再铺满，4 项等分、文字完整不截断；二级控件不变 |
| D2 | 抖音「账号总览」 | 页面全宽，左侧没有账号管理栏；点账号行的「查看分析」进入单账号分析，「返回账号总览」回到全宽总览 |
| D3 | 抖音「账号作品」 | 左侧有账号管理栏，点账号卡切换右侧作品；KPI 卡片下方不再有多余空白，作品列表可用高度变大 |
| D4 | 抖音账号作品页，数据加载前后 | KPI 行高度不跳动，4 张卡片等高 |
| D5 | 视频号工作台 | 第三个 Tab 显示「报表」（英文「Reports」），进入后是报表页 |

### 5.3 本地联调记录

2026-11-27：

| 核对项 | 方法 | 结果 |
|---|---|---|
| 用例 | 抖音 vitest 177 条（基线 175 加 2 条布局守护）、视频号 vitest 115 条；两个包的 `build`；仓库级 `lint`、`verify-client-ui-i18n`、`verify-export-jsdoc`；`git diff --check` | 全部通过 |
| 用例有效性 | 四组变异：总览页恢复渲染账号管理栏、导航恢复铺满、KPI 行加回最小行高、视频号 Tab 改回「AI 报表」 | 依次由 N5、两条布局守护、W1 抓住；恢复后复跑通过 |
| 独立 review | 复核总览页移出两栏布局后的布局与交互、等分网格下的 `width: fit-content`、去掉最小行高后的行高稳定、Tab 改名一致性、用例有效性，并复跑上表全部命令 | 可以验收，阻断 0 条；两条注释过时已修正，骨架态与就绪态 2px 高度差记入 2.3 |

未做浏览器目检：`width: fit-content` 的实际宽度、KPI 行高与列表高度的变化待真机验收（5.2 的 D1 至 D4）。
