# 分册 05：yootun UI/UX 设计规范

## 0. 规范地位与适用范围（2026-11-10 用户定为长期规范）

- 本规范对 **yootun 定制层的全部用户可见 UI** 有强制约束力：第一步的品牌前端与激活页、**以及后续所有批次迁移的业务插件 UI**，一律遵循本规范与官方设计体系。
- **迁移插件时旧视觉不迁移**：旧插件的样式实现（全局样式注入、inline style、硬编码几何）整体废弃，只迁移交互逻辑与数据面；UI 按本规范重做（ui-primitives 复用、token 消费、圆角刻度、locale-owned 文案）。
- 插件迁移批次的验收必须包含第 6 节设计验收清单；**「功能可用但视觉不合规范」不算通过**。
- 本文件长期有效：第三步（插件迁移）启动时可将本册内容升格为 `yootun/docs/ui-ux-standard.md` 独立长期文件，并在迁移方案中引用。

## 0.1 目标

**现代化 UX/UI + 科技感，整体严格符合官方 deepseek harness 设计规范**——科技感来自官方体系本身的材质语言（superellipse 曲率、elevation 阴影、hairline、动态 hero），不靠破坏规范堆特效。

## 1. 官方设计体系（必须遵循，全部为第 0 层既有资产）

| 维度 | 官方体系 | 权威文件 |
|---|---|---|
| 样式技术 | CSS Modules + `clsx`；**禁止 Tailwind/组件库/全局样式注入** | `docs/web-styling.md` |
| 设计 token | 三层体系：`--dsw-static-*`（静态色板）→ `--dsw-alias-*`（语义别名，feature 组件唯一合法入口，**禁止字面色值**）→ `--dsw-specific-*`（专属表面） | `packages/client/ui-theme/src/styles/design-platform.css` |
| 圆角 | R4/R8/R12/R16/R20/R28 按组件角色选档（控件 R12、卡片 R20、对话框 R28）+ 全局 `superellipse(1.5)` 曲率 | `docs/ui-radius.md`、`ui-theme/src/styles/corner-shape.css` |
| 边框/材质 | 中性边框一律 0.5px hairline；抬升面 `border:0` + `--dsw-elevation-panel/prominent/soft`（阴影自带发丝线，不得再叠中性边框） | `web-styling.md`、`gradient-shadow-text.css` |
| 动效 | 时长/曲线走 token（`--ds-transition-duration` 0.2s、fast 0.1s、slow 0.3s；`--ds-ease-in-out`）；每组件局部 keyframes；**必须带 `prefers-reduced-motion` 守卫**；hover 包 `@media (hover: hover)` | `ui-theme/src/styles/base.css` |
| 字体 | 主题 typography roles；13px 为行/详情基准字号；**自写 CSS 字重 ≤500**（强调用字号或墨色）；品牌字体 Montserrat（`--dsw-font-family-brand`） | `dsh-client-ui-ux` skill 视觉基础节 |
| 组件 | **先复用 `ui-primitives` 再新建**（Button/Input/Modal/Switch/Menu/SegmentedControl/Checkbox/ConfigField…），跨包唯一通道 | `packages/client/ui-primitives/README.md` |
| 图标 | 官方 SVG sprite（`#dsw-icon-*`，currentColor）+ `size` prop；品牌 artwork 走独立组件（官方 FishLogo/BrandWordmark 先例） | `ui-primitives/src/icons/` |
| 文案 | locale-owned：typed dictionary（**zh 为 key-set source of truth**）+ `t()`，`verify-client-ui-i18n` 拒绝硬编码文案；中文提示最多两句不带句号 | AGENTS.md、`ui-settings-general/src/client/locales.ts` 范式 |
| 焦点 | 焦点环 token 化（2px、business-primary）；指针输入抑制、键盘导航可见 | `ui-theme/src/styles/focus.css` |

## 2. yootun 品牌视觉定义

**品牌色原则**：不改官方 theme token（第 0 层禁改），品牌色只出现在两处——① yootun 自有 artwork 组件（logo/wordmark/hero，官方 FishLogo 同型先例）；② yootun 专属界面的强调位（激活卡片主按钮、焦点高亮），以组件局部 custom property 声明（官方允许：值属于该组件呈现契约时可定义局部变量）。

- `yootun/brand/brand.json` 增补 `palette` 节：`primary`（从现有 sidebar-mark/logo 素材提取主色，批次 3 定值）、`ink`（沿用旧 wordmark `#0F172A` 深墨系）、`accent-gradient`（hero/门禁卡片背景的科技感渐变，见第 3 节）。
- 明暗双主题各出适配值：亮色用品牌 primary 直出；暗色校验对比度后提亮一档（官方规则：明暗两主题实测墨/底可读性）。

**科技感手法白名单**（全部官方体系内）：superellipse 曲面、`--dsw-elevation-prominent` 悬浮卡、hairline 细线阵列、菜单级 `blur(40px) saturate(150%)` backdrop、品牌渐变（官方 gradient token 同型）、hero canvas 微动效（PixelWhale 先例）、modalEnter 类进场动画。

**禁止清单**：霓虹发光描边、大面积玻璃拟态、自定义字体渲染效果、off-scale 圆角（6px/10px 等）、1px 实线中性边框、z-index 自挂载 DOM、全局 `.yu-*` 样式注入。

## 3. 界面设计规格（四个面）

### 3.1 侧边栏品牌位（`sidebar.brand.mark` / `.name`）

- mark：`YootunMark` artwork 组件（接收宿主 `size`，对齐 `SidebarBrandMarkOwnerProps` 契约），SVG 或内嵌 dataURL，亮暗主题各一版（暗色提亮）。
- name：旧实现返回 null（纯 logo 无文字）——保留；wordmark 视觉合并进 mark 或按素材宽度自适应，重设计时二选一定稿。

### 3.2 会话首页 hero（`conversation.hero.frame`，重设计重点）

- 形态：对齐官方 PixelWhale 范式——`HeroFrameOwnerProps` HOC 包裹滚动体，hero 态在内容下方挂 yootun 视觉层。
- 视觉方案：yootun wordmark + eyebrow（"YOOTUN AGENT" 字样进 locale dictionary，不硬编码）+ 品牌渐变微光背景；**可 v2 追加 canvas 动效**（如缓慢漂移的光粒子/品牌豚剪影微动画），首版静态渐变即可——动效是加分项不阻塞批次 3。
- 空白区点击交互、`aria-hidden` 装饰层照官方 PixelWhale 形态。

### 3.3 激活门禁（批次 4，全屏阻断卡片）

- 阻断机制沿用旧逻辑层资产（全部保留）：`root.inert` + body 滚动锁、focus trap（Tab 钳回）、fail-closed 凭据探测、「授权最后提交」写入顺序、settings CAS 冲突重试、30s 超时。
- 视觉层全部重做，改用官方 Modal 材质语言：
  - 背板：官方 modal mask（`--dsw-alias-bg-mask-1`，无 blur——官方设置确认弹窗同款）；旧 `blur(10px)+color-mix` 背板抛弃；
  - 卡片：R28 + `--dsw-alias-bg-layer-2` + `--dsw-elevation-prominent`，宽度 `min(380px,100%)` 官方 Modal 档（旧 680px 宽卡抛弃），进场动画 token 化 + reduced-motion 守卫；
  - header：YootunMark 48px + eyebrow + 标题（typography role，字重 ≤500）；
  - 表单控件全换官方 primitives：key 输入用 `Input`（32px/R12/0.5px 边框/焦点 business-primary 描边），「显示 Key」用 `Switch`（旧原生 checkbox 抛弃），模型选择用官方 `Menu`/select 模式（旧 `<select>` 抛弃），主按钮 `Button md primary`，移除 Key 为危险态（`--dsw-alias-state-error-*`）；
  - 反馈：提交中 loading 态（Button loading 变体）、成功走全局 Toast、失败 in-place notice（`role="alert"`，短句中文不带句号）。

### 3.4 设置页激活管理（`settings.section`，id `yootun-access`）

- 对齐官方设置区块规律（ConfigField 范式）：`12px 0` 行距 + 相邻字段 0.5px hairline 分隔，label 13px/500，控件右置；分组大间距，不堆卡片盒子。
- 内容三行：激活状态（已激活/未激活 + 租户/模型摘要）、更换 Key（进入门禁同款表单，复用组件）、移除 Key（危险按钮 + 官方确认 Modal）。

## 4. 文案与 i18n

- 首版两语言：`zh`（key-set source of truth）+ `en`；字典形态照官方（typed `keyof typeof zh` + `t` + `{placeholder}` 插值），`locale/zh-CN.json`、`locale/en.json` 随包发布；`ctx.locale.register/bind` 注册。
- 旧实现的手写 copy 对象升级为 typed dictionary；eyebrow/按钮文案/错误提示全部进字典。

## 5. 无障碍与适配（验收硬项）

- 明暗双主题全界面实测（token 消费保证基础合规，品牌色两版对比度实测）；
- `prefers-reduced-motion` 全部动效守卫；hover 全部包 `@media (hover: hover)`；
- 键盘可达：focus trap 保留、焦点环可见（键盘导航时）、Escape 关闭（门禁态除外——门禁不可 Escape 关闭，属有意阻断）；
- 窄容器/长文案：卡片 `min(380px,100%)` 自适应、640px 断点复查（旧断点保留为复查点，样式重写）；
- 平台：`--dsh-frame-top-clearance` 让出 macOS/Windows 窗口 chrome（官方 Modal 已处理，自查不覆盖）。

## 6. 设计验收清单（并入批次 3/4 验收）

- [ ] 全部颜色来自 token/品牌 palette，无字面色值（批内 grep 复查）；
- [ ] 圆角全部在官方刻度内且角色选档正确；中性边框无 1px 实线；抬升面无双重描边；
- [ ] 控件复用 ui-primitives，无重复造轮子（Button/Input/Switch/Menu/Modal）；
- [ ] 明暗双主题、reduced-motion、窄宽、键盘导航四项实测通过；
- [ ] 文案零硬编码（typed dictionary + t），中文提示句式合规；
- [ ] 与官方界面（设置页、侧边栏）并排目检风格连贯——「放在官方桌面里不违和」是总验收标准。
