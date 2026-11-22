/**
 * kit 复合层样式表的装载声明（wx/xhs 同款机制）：本插件是 kit 代码的唯一加载
 * 者，其样式表文本必须随本模块的 meta 安装才能生效。清单纪律：import 集合必须
 * 与本插件实际消费的 kit 组件一一对应（douyin-parity.test.tsx 源码层守护推导）；
 * 容器名 `yootun-kit-page` 的稳定性由构建脚本 `cssModules.container: false`
 * 保证，kit 与插件两侧共享同一名字。
 * @module
 */
import '@yootun/dsh-client-ui-kit/src/chart-frame.module.css'
import '@yootun/dsh-client-ui-kit/src/chart-tooltip.module.css'
import '@yootun/dsh-client-ui-kit/src/data-card.module.css'
import '@yootun/dsh-client-ui-kit/src/data-state.module.css'
import '@yootun/dsh-client-ui-kit/src/filter-bar.module.css'
import '@yootun/dsh-client-ui-kit/src/kpi-card.module.css'
import '@yootun/dsh-client-ui-kit/src/page-shell.module.css'
import '@yootun/dsh-client-ui-kit/src/plugin-header.module.css'
