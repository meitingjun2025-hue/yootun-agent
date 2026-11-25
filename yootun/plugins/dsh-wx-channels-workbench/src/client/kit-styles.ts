/**
 * kit 复合层样式表的装载声明：本插件是 kit 代码的唯一加载者（kit 以编译产物
 * 内联进本 bundle，类名映射在 kit 构建时冻结），其样式表文本必须随本模块的
 * meta 安装才能生效。逐文件 import 让构建期的 CSS Modules 编译器为每张样式
 * 表产出与 kit 冻结类名一致（内容哈希确定性）的文本，并进入 bundle 的
 * `meta.stylesheets`（loader 经 DocumentStyles 安装）。
 *
 * 清单纪律：import 集合必须与本插件实际消费的 kit 组件一一对应
 * （wx-bundle.test.ts 的源码层守护按 client 源里的 kit 导入推导本清单，
 * 组件 → 样式表按 kit 文件命名，`PluginPageShell → page-shell` 为已登记的
 * 例外）；消费新 kit 组件时在此补对应样式表。容器名 `yootun-kit-page` 的
 * 稳定性由构建脚本 `cssModules.container: false` 保证，kit 与插件两侧共享
 * 同一名字。
 * @module
 */
import '@yootun/dsh-client-ui-kit/src/chart-frame.module.css'
import '@yootun/dsh-client-ui-kit/src/chart-legend.module.css'
import '@yootun/dsh-client-ui-kit/src/chart-tooltip.module.css'
import '@yootun/dsh-client-ui-kit/src/data-card.module.css'
import '@yootun/dsh-client-ui-kit/src/data-state.module.css'
import '@yootun/dsh-client-ui-kit/src/filter-bar.module.css'
import '@yootun/dsh-client-ui-kit/src/filter-menu.module.css'
import '@yootun/dsh-client-ui-kit/src/kpi-card.module.css'
import '@yootun/dsh-client-ui-kit/src/page-shell.module.css'
import '@yootun/dsh-client-ui-kit/src/pager.module.css'
import '@yootun/dsh-client-ui-kit/src/plugin-header.module.css'
