/**
 * Host API 客户端：页面只访问本地同源路由
 * （`/api/desktop/yootun/douyin-workbench`），不直连任何远端地址；请求契约
 * （30 秒缺省预算、`redirect: 'error'`、same-origin 凭证）与错误收敛统一由
 * kit 的 `createHostAction` 承担；未知传输失败收敛为 `host_unreachable`，业务
 * envelope 以稳定 `reason` 抛出；HTTP 状态码不误当业务 status。
 * @module
 */
// 从 kit 叶子模块源码路径导入（非桶），与另外两个工作台的 api.ts 同一种导入形态；
// 小红书的同款文件被其 Host 侧图（accounts-machine）引用，是三处统一走叶子路径
// 的原因——桶导出会把组件与其样式表拖进宿主 bundle。
import { createHostAction, type HostResponse } from '@yootun/dsh-client-ui-kit/src/host-action.ts'

export const HOST_PATH = '/api/desktop/yootun/douyin-workbench'

export type { HostResponse }

/**
 * 同步探测类 action 的单独预算（毫秒）：返回前要同步等待一次浏览器探测
 * （探测 45 秒 + 打开页面 60 秒 + 余量），预算不足时慢速失败会先被页面截断，
 * 真实原因（probe_failed）会被误收敛为 host_unreachable。其余 action 用
 * `createHostAction` 的 30 秒缺省预算（长动作由宿主异步执行、页面轮询状态）。
 */
const SYNC_PROBE_ACTION_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({
  'account.probe': 120_000,
  'collect.start': 120_000,
})

/** 绑定到本工作台同源路由的 Host action 调用器（kit 统一实现）。 */
export const hostAction = createHostAction(HOST_PATH, { actionTimeouts: SYNC_PROBE_ACTION_TIMEOUTS_MS })
