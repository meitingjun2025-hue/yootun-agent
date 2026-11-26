/**
 * Host API 客户端：页面只访问本地同源路由（`/api/desktop/yootun/xhs-workbench`
 * 与 `@yootun/dsh-media-upload` 的 `/_dsh/uploader/*` 四路由，D-2），不直连任何
 * 远端地址；工作台 action 的请求契约与错误收敛统一由 kit 的 `createHostAction`
 * 承担：未知传输失败收敛为 `host_unreachable`，业务 envelope 以稳定 `reason`
 * 抛出；预签名 URL 与本地路径不进入本层。
 * @module
 */
// 从 kit 叶子模块源码路径导入（非桶）：本文件同时被 xhs Host 侧图（accounts-machine）
// 引用，桶导出会把组件与其样式表拖进宿主 bundle。
import { createHostAction, type HostResponse } from '@yootun/dsh-client-ui-kit/src/host-action.ts'
import { createUploadTransport } from '@yootun/dsh-client-ui-kit/src/upload-transport.ts'
import type { UploadStatusSnapshot } from '../upload-machine.ts'

export const HOST_PATH = '/api/desktop/yootun/xhs-workbench'

/** media-upload 同源路由（D-2：上传四组语义 1:1 落在该路由组）。 */
export const UPLOAD_PICK_PATH = '/_dsh/uploader/pick-file'
export const UPLOAD_START_PATH = '/_dsh/uploader/uploadStart'
export const UPLOAD_STATUS_PATH = '/_dsh/uploader/uploadStatus'

export type { HostResponse }

/**
 * 同步探测类 action 的单独预算（毫秒）：返回前要同步等待一次浏览器探测
 * （探测 45 秒 + 打开页面 60 秒 + 余量），预算不足时慢速失败会先被页面截断，
 * 真实原因（probe_failed）会被误收敛为 host_unreachable。其余 action 用
 * `createHostAction` 的 30 秒缺省预算。
 */
const SYNC_PROBE_ACTION_TIMEOUTS_MS: Readonly<Record<string, number>> = Object.freeze({
  'account.probe': 120_000,
})

/** 绑定到本工作台同源路由的 Host action 调用器（kit 统一实现）。 */
export const hostAction = createHostAction(HOST_PATH, { actionTimeouts: SYNC_PROBE_ACTION_TIMEOUTS_MS })

// 上传传输统一走 kit（2.5：小红书与承接卡片唯一实现）；路由路径注入。
const transport = createUploadTransport({ pick: UPLOAD_PICK_PATH, start: UPLOAD_START_PATH, status: UPLOAD_STATUS_PATH })

/**
 * pick-file：创建上传会话（uploadId/accept/maxBytes）。
 * @param kind - 素材组（image/video）。
 * @returns the session info, or null on any failure (machine 归一).
 */
export async function startUploadSession(kind: 'image' | 'video'): Promise<{ uploadId: string; accept: string[]; maxBytes: number } | null> {
  return transport.startSession(kind)
}

/**
 * uploadStart：把浏览器 File 的字节流推给宿主暂存（kit sendBytes 的布尔包装，
 * 调用方签名不变；稳定错误码由承接卡片路径经 `{ ok, error }` 超集获取）。
 * @param input - 会话 uploadId 与调用方持有的 File。
 * @returns true when accepted.
 */
export async function sendUploadBytes(input: { uploadId: string; file: unknown }): Promise<boolean> {
  const result = await transport.sendBytes(input)
  return result.ok
}

/**
 * uploadStatus：进度轮询（waiting/uploading/done/failed/not_found + 受控字段）。
 * @param uploadId - the session id.
 * @returns the snapshot, or null on transport/HTTP failure (machine 计暂态失败).
 */
export async function pollUploadStatus(uploadId: string): Promise<UploadStatusSnapshot | null> {
  return transport.pollStatus(uploadId)
}
