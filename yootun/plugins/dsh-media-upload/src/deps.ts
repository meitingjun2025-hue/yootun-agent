/**
 * 上传链路的注入面：生产由插件入口组装（真实 Workbench 服务 + 严格校验），
 * 测试以假授权与假 TOS 替换。会话状态机与路由处理只依赖本接口。
 * @module
 */
import type { UploadSessionRegistry } from './sessions.ts'
import type { StagingArea } from './staging.ts'
import type { WorkbenchFace } from './authorize.ts'

/** Production wiring handed to routes, the upload pipeline, and the session tool. */
export interface UploaderDeps {
  /** The local webServer origin, read at request time (the port binds during service init). */
  getExpectedOrigin: () => string
  registry: UploadSessionRegistry
  staging: StagingArea
  workbench: WorkbenchFace
  /** Local pre-authorization size cap (staging aborts beyond it). */
  maxUploadBytes: number
  /** Test seam: 'loopback-test' relaxes https/public-host checks for fake TOS. */
  transport?: 'strict' | 'loopback-test' | undefined
  logger?: { warn(message: string): void } | undefined
}
