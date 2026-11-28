# douyin-workbench-顶级导航重组与详情入口 实施单

状态：已合入 `main`（2026-11-27，自动验收通过），待真机验收 ｜ 创建：2026-11-26 ｜ 流程依据：[cross-repo-sync.md](../../cross-repo-sync.md)

## 0. 背景与目标

### 0.1 现状

抖音工作台有 7 个顶级 Tab（`yootun/plugins/dsh-douyin-workbench/src/client/WorkbenchPage.tsx`）：账号总览、账号作品、发布排期看板、爆款素材看板、爆款拆解、爆款基因库、AI 报表。

- 超出 yootun 插件规范「顶层导航 ≤5、内部层级不超过三层」（[plugin-ui-ux-standard.md](../../plugin-ui-ux-standard.md) 第九节）；7 项平铺后每项标签都很长，其中 3 项以「爆款」开头，用户要逐项读标签才能找到位置。
- 账号管理栏（添加账号、扫码登录、采集全部、批量面板）只在「账号作品」Tab 里出现；而应用启动默认落在「账号总览」，用户想采集要先切到另一项。
- 表格行打开详情靠双击或 Enter，界面上没有任何可见入口。同一工作台内做法也不一致：总览与单账号分析的「热门作品」表在标题单元格放了一个链接样式的按钮，账号作品表没有。

7 项平铺是迁移时与旧插件逐项对齐的结果，顺序与文案被 `tests/client/douyin-client.test.tsx` 的「顶级导航（parity 矩阵 §0：7 Tab 固定顺序）」用例固定。本单是对该冻结基线的一次有意偏离。

### 0.2 目标

顶级导航 4 项，按用户要办的事分组，组内用二级分段控制；保留现有 7 个页面的全部功能、keep-alive 与跨页跳转。账号管理栏在「数据」组内两个页面都可见。作品与榜单表格每行有可见的「查看详情」按钮。

## 1. 范围

做：

- 7 个 Tab 重组为 4 组 + 组内二级 `SegmentedControl`；
- 「账号作品」的账号管理栏在「账号总览」页同样显示；在总览页点击账号卡进入该账号的单账号分析；
- 4 张表格的操作列增加「查看详情」按钮：账号作品表、总览的账号表（进入单账号分析）与热门作品表、单账号分析的热门作品表；爆款拆解历史表同样补一个；
- 词典新增分组名与按钮文案；
- 冻结基线偏离登记。

不做：

- 不改任何页面的内容、筛选、图表与数据流；
- 不改 keep-alive 规则（首次访问后保持挂载）；
- 不改行级键盘路径（`tabIndex=0` + Enter）与双击；
- 不做导航状态的持久化与 URL 锚点；
- 不改视频号与小红书的导航（视频号、小红书的顶级 Tab 数分别为 2 和 3，未超限）；
- 不改 tools、docker-helm。

## 2. 契约增量

MCP 工具：无。

### 2.1 导航结构

| 顶级 | 二级（顺序） | 选中该组时默认 |
|---|---|---|
| 数据 | 账号作品、账号总览 | 账号作品 |
| 创作 | 无（直接是「发布排期看板」） | — |
| 素材与知识 | 爆款素材看板、爆款拆解、爆款基因库 | 爆款素材看板 |
| 报表 | 无（直接是「AI 报表」） | — |

规则：

- 状态只有一个 `tab`（7 个页面值不变），所属组由 `tab` 推导，不另存「当前组」；
- 点顶级项：该组有二级 → 选中该组默认页；无二级 → 直接选中该页；
- 已在组内时再点该组：回到该组默认页；从别的组切回：恢复该组上一次页面（`lastPageByGroup`，N3/T3 口径）；
- 二级控件只在当前组有多于一个页面时渲染，位于顶级导航下方左对齐，宽度随内容；
- 跨页跳转（总览账号行进入单账号分析、素材看板「去拆解」带链接跳转）继续直接设置 `tab`，不受分组影响；
- 应用启动默认落在「账号作品」（账号管理栏与所选账号的作品列表是日常最常用的一屏）。

### 2.2 账号管理栏

「数据」组的两个页面共用同一条账号管理栏，与右侧内容组成现有的两栏布局（`worksLayout`）。在「账号作品」页点击账号卡是选中账号（右侧切到该账号的作品）；在「账号总览」页点击账号卡进入该账号的单账号分析，与总览账号表的「查看分析」同一处理函数，并同步把该账号设为选中账号。单账号分析是从总览进入的页内状态（`analysisAccountId`），分析页内不显示账号管理栏（现状不变）。

2026-11-27 真机验收修订：账号管理栏只在「账号作品」页渲染，「账号总览」页恢复全宽布局（与 14 册 §4 一致），单账号分析从总览账号行的「查看分析」进入；本节的共用约定不再适用，见 [device-review-fixes.md](../../1127/features/device-review-fixes.md)。

### 2.3 「查看详情」按钮

| 表格 | 按钮 | 行为 |
|---|---|---|
| 账号作品表（`WorksPanel.tsx`） | 查看详情 | 打开统一作品详情弹层，与行 Enter / 双击同一处理函数 |
| 总览 · 账号表（`OverviewPage.tsx`） | 查看分析 | 进入该账号的单账号分析 |
| 总览 · 热门作品表（`OverviewPage.tsx`） | 查看详情 | 打开作品详情；标题单元格原有的链接式按钮保留 |
| 单账号分析 · 热门作品表（`AnalysisPage.tsx`） | 查看详情 | 同上 |
| 爆款拆解 · 历史表（`BreakdownPage.tsx`） | 查看详情 | 打开该条拆解详情；行级鼠标手势随 [ui-accessibility-and-visual-cleanup.md](ui-accessibility-and-visual-cleanup.md) 由单击统一为双击 |

按钮规格：官方 `Button`，`variant='ghost'`、`size='sm'`，放在行末操作列，列宽固定。

操作列的表头与按钮单元格带同一个操作列类，同为固定宽、右对齐（2026-11-28 真机验收修正，见 [device-review-fixes.md](../../1128/features/device-review-fixes.md) 2.1）。

### 2.4 词典新增（`src/client/locales.ts`，zh 为键集事实源，en 成对）

| 键 | zh | en |
|---|---|---|
| `nav.group.data` | 数据 | Data |
| `nav.group.create` | 创作 | Create |
| `nav.group.material` | 素材与知识 | Material and knowledge |
| `nav.group.report` | 报表 | Reports |
| `nav.subLevel` | {group}下的页面 | Pages under {group} |
| `action.viewDetail` | 查看详情 | View detail |
| `action.viewAnalysis` | 查看分析 | View analysis |

## 3. 影响面

| 仓 | 位置 | 改动 | 必改 | 依据 |
|---|---|---|---|---|
| tools.dofe.ai | — | 无 | 否 | 无契约变化 |
| docker-helm.dofe.ai | — | 无 | 否 | 无路由变化 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/WorkbenchPage.tsx` | 分组定义、二级控件、账号管理栏的渲染条件 | 是 | 本单主体 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/{WorksPanel,OverviewPage,AnalysisPage,BreakdownPage}.tsx` | 操作列「查看详情」 | 是 | 详情入口可见 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/src/client/{locales.ts,workbench.module.css}` | 新词条；二级控件行样式；操作列宽度 | 是 | 文案与布局 |
| yootun-agent | `yootun/plugins/dsh-douyin-workbench/tests/client/{douyin-client,douyin-d678,douyin-parity}.test.tsx` | 顶级导航用例改为 4 项且默认选中「账号作品」；依赖默认落在账号总览的用例在开头增加一次点击；新增分组与详情按钮用例 | 是 | 行为随实现变更 |
| yootun-agent | `yootun/docs/1110/p4-douyin-workbench-baseline.md` §11 | 登记「7 Tab 平铺 → 4 组 + 二级」的有意偏离 | 是 | 冻结基线偏离登记 |
| yootun-agent | `yootun/docs/1126/00-overview.md` | 索引行状态随第 4 节回填 | 是 | 目录索引 |

## 4. 状态回填

| 节点 | 日期 | 分支 | 备注 |
|---|---|---|---|
| 文档（本文 + 15 册 §11 + 1126 索引） | 2026-11-26 | `main` | 草案，待审查 |
| tools 合入 `dev` | — | — | 不涉及 |
| docker-helm 部署测试环境 | — | — | 不涉及 |
| 开发完成（自动验收通过） | 2026-11-27 | `feat/douyin-tabs-regroup` | 分支基于 client-workbench-hooks 落地提交；抖音包 164 例全绿（新增 N1–N6/D1–D2 + 改 7 Tab 冻结用例），build/lint/verify-client-ui-i18n 过；页面 291 行、hook 1 |
| yootun-agent 合入 `main` | 2026-11-27 | `main` | 随 P1 八张批次一并合入（含验收审查修复），真机验收见 5.2 |
| 发版 | | | 待填 |

## 5. 验收

### 5.1 自动验收（开发侧执行，每次合入前）

- [ ] `pnpm --filter @yootun/dsh-douyin-workbench test`、`build` 通过；
- [ ] `pnpm run lint`、`pnpm run verify-client-ui-i18n`；
- [ ] 附录 B 用例全部存在并通过；
- [ ] 15 册 §11 已登记偏离。

### 5.2 真机验收（用户执行）

| # | 步骤 | 预期 |
|---|---|---|
| T1 | 打开抖音工作台 | 顶级 4 项：数据、创作、素材与知识、报表；默认在「数据 › 账号作品」，账号管理栏可见，所选账号的作品列表已加载 |
| T2 | 在「账号作品」点二级的「账号总览」 | 进入总览页；账号管理栏在两个页面都显示 |
| T3 | 在「账号总览」切到「素材与知识」再点回「数据」 | 回到「账号总览」而不是默认页；总览筛选保持 |
| T4 | 在「素材与知识 › 爆款素材看板」点某条「去拆解」 | 二级切到「爆款拆解」并带入链接 |
| T5 | 在「账号总览」点某账号行的「查看分析」，以及点左侧账号卡 | 两种方式都进入该账号的单账号分析；返回后筛选保留 |
| T6 | 账号作品表任意行：点「查看详情」、按 Enter、双击行 | 三种方式打开同一详情；Esc 关闭后焦点回到该行 |
| T7 | 键盘：Tab 到顶级导航，方向键切换；Tab 到二级控件，方向键切换 | 焦点顺序为 顶级 → 二级 → 页面内容；不出现跳不进去的控件 |
| T8 | 640px / 880px / 1120px 三档宽度；明暗主题 | 二级控件不换行溢出；操作列按钮不被截断 |
| T9 | 英文界面 | 分组名与按钮文案为英文，宽度正常 |

### 5.3 本地联调记录

自动验收通过（2026-11-27）。改动构成：新增 N1–N6、D1–D4 用例；既有用例按 D4 只加导航前置点击（跨组页面点击前插组点击 53 处、单页组改名点击 9 处、总览前置 6 处）；断言改动逐条为——顶级导航用例重写为 N1+N2、下钻用例 navTabs 7→4、四张表列头断言追加 `action.viewDetail` / `action.viewAnalysis`、`row.detailAria` 词典值改「{title}，查看详情」（既有断言经同一词典函数自动跟随）。

与附录 A1 的裁决：A1 原文 `selectGroup` 恒回默认页，与 N3/T3「跨组切回恢复上页」矛盾——按测试矩阵实现 `lastPageByGroup`（组内重选回默认页、跨组切回恢复上页），2.1 与 A1 文字已同步。官方 `SegmentedControl` 的 `aria-controls` 为组件固定模式（指向未渲染元素 id），N6 按容器 `aria-labelledby` → 选中段方向断言并在用例注释说明。

真机移交：T7（焦点顺序与方向键漫游）、T8（640/880/1120 三档宽度与明暗主题）、T6 的 Esc 焦点回归走查、T1/T2/T3 布局观感、T9 英文界面宽度。

## 附录 A：逐文件规格

### A1 `src/client/WorkbenchPage.tsx`

```ts
type TabGroup = 'data' | 'create' | 'material' | 'report'
const GROUP_TABS: Readonly<Record<TabGroup, readonly [TabValue, ...TabValue[]]>> = {
  data: ['works', 'overview'],
  create: ['schedule'],
  material: ['material', 'breakdown', 'gene'],
  report: ['report'],
}
```

- `groupOf(tab)`：由 `GROUP_TABS` 反查；
- `selectGroup(group)`：组内重选 → `setTab(GROUP_TABS[group][0])`；跨组切回 → `setTab(lastPageByGroup[group])`；均记入 `visitedTabs`（与 2.1 规则一致，N3/T3）；
- 顶级 `SegmentedTabs` 的 `items` 为 4 个组，`value={groupOf(tab)}`；
- `GROUP_TABS[group].length > 1` 时渲染官方 `SegmentedControl`（`id='dy-tab-sub'`，`label={t('nav.subLevel', { group })}`），选项为该组的页面；
- `PanelId` 关系：页面容器的 `role='tabpanel'` 仍由页面值决定；顶级 Tab 控制「组容器」，二级 segment 控制「页面容器」；
- 账号管理栏的渲染条件由 `tab === 'works'` 改为 `tab === 'works' || (tab === 'overview' && analysisAccountId === null)`；`onSelect` 在总览页改为「选中并进入分析」；「账号总览」页使用与「账号作品」相同的两栏布局容器。

### A2 页面

- 四张表的操作列加 `Button`（规格见 2.3）；`onClick` 调用与行 Enter 相同的处理函数，事件不冒泡到行；
- `WorksPanel`、`OverviewPage`、`AnalysisPage` 的行 `aria-label` 文案改为「{标题}，查看详情」，提示不再提双击。

### A3 样式

- `.tabsRow` 保持；新增 `.subTabsRow`：上边距 8px、下边距 4px、`min-width: 0`；
- 二级控件在 `<640px` 容器下允许横向滚动，不换行成两排。

## 附录 B：测试矩阵

| ID | 断言 |
|---|---|
| N1 | 顶级 tablist（`aria-label` 为面板名）恰有 4 项，文案与顺序为 数据 / 创作 / 素材与知识 / 报表，默认选中「数据」 |
| N2 | 默认渲染二级控件，选项顺序为 账号作品 / 账号总览，选中「账号作品」；选中「创作」「报表」时不渲染二级控件 |
| N3 | 在「账号总览」切到别的组再切回「数据」→ 仍是「账号总览」 |
| N4 | 首次进入「素材与知识」→ 落在「爆款素材看板」 |
| N5 | 「账号总览」页渲染账号管理栏；点击其中账号卡进入该账号的单账号分析；进入分析后不渲染 |
| N6 | 二级控件 `id` 对应的 tab 与页面容器的 `aria-labelledby` 互相指向 |
| D1 | 五张表每行都有名为「查看详情」（或「查看分析」）的按钮；点击后与行 Enter 打开同一目标 |
| D2 | 点击行内按钮不触发行的打开处理（不重复打开） |
| D3 | keep-alive：访问过的页面切走再切回，状态保留（既有用例不变） |
| D4 | 既有按标签取 Tab 的用例（`getByRole('tab', { name })`）不改；依赖「默认落在账号总览」的用例在开头增加一次点击「账号总览」，断言不变 |

## 附录 C：默认采用项

| 项 | 采用 | 备选 |
|---|---|---|
| 分组 | 4 组：数据 / 创作 / 素材与知识 / 报表 | 3 组：把 AI 报表并入「数据」（没有单项组，但报表入口多一层） |
| 二级控件 | 官方 `SegmentedControl`（规范 §4.3） | 第二层也用 `SegmentedTabs`（形成双层大 Tab，规范禁止） |
| 行焦点 | 保留行 `tabIndex=0` + Enter；新增按钮是第二个 Tab 停靠点 | 改为「标题即入口」并移除行焦点：每行只有一个停靠点，但要改约 15 处行 Enter 用例并改变键盘用户已有习惯 |
| 详情按钮样式 | `ghost` + `sm` | `toolbar` + `sm` |
