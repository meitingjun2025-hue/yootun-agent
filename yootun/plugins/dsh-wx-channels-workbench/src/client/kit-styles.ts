/**
 * kit 复合层样式表的装载声明（wx/xhs 同款机制）：本插件是 kit 代码的唯一加载
 * 者，其样式表文本必须随本模块的 meta 安装才能生效。清单纪律：import 集合必须
 * 与本插件（含报表共享包 @yootun/dsh-client-report 转消费的组件）实际消费的
 * kit 组件一一对应（wx-bundle.test.ts 源码层守护推导两侧源）；容器名
 * `yootun-kit-page` 的稳定性由构建脚本 `cssModules.container: false` 保证，kit
 * 与插件两侧共享同一名字。报表业务页共享包的样式表同样经本模块声明安装——
 * client 源 import 了共享包就必须声明其样式表（wx-bundle.test.ts 同一条守护
 * 锁定）。
 * @module
 */
import '@yootun/dsh-client-report/src/report.module.css'
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
