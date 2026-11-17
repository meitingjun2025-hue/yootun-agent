/**
 * 单会话上传管线：authorize → 预签名 PUT（进度/有界重试）→ 上传后 TOCTOU
 * 复查 → 终态回填。会话取消（abort）与插件卸载通过 session.controller 传播；
 * 失败只落稳定公开错误码，暂存文件无论成败都被清理。
 * @module
 */
import { authorizeUpload } from './authorize.ts'
import { MediaUploadError, toPublicCode } from './errors.ts'
import { putStagedFile } from './uploader.ts'
import type { UploaderDeps } from './deps.ts'
import type { UploadSession } from './sessions.ts'

/**
 * Run one session's upload pipeline to a terminal state. Never throws:
 * every failure settles the session with a public code.
 * @param deps - uploader wiring.
 * @param session - a session already in `uploading` state with staged bytes.
 */
export async function runUpload(deps: UploaderDeps, session: UploadSession): Promise<void> {
  const staged = session.staged
  if (staged === undefined || session.state !== 'uploading') return
  try {
    const authorization = await authorizeUpload(deps.workbench, {
      filename: session.name,
      contentType: session.contentType,
      size: session.size,
    }, session.controller.signal, deps.transport === undefined ? {} : { transport: deps.transport })
    if (session.controller.signal.aborted) throw new MediaUploadError('user_cancelled', 'upload cancelled before PUT')
    session.authorization = authorization
    await putStagedFile(staged, authorization, session.controller.signal, {
      onAttempt: attempt => { session.attempt = attempt },
      onProgress: bytesSent => { session.bytesSent = bytesSent },
    })
    // 上传后 TOCTOU：暂存字节与上传前快照不一致即判失败（file_changed）。
    await deps.staging.verifyAfterUpload(staged)
    session.staged = undefined
    session.settle('done', { url: authorization.publicUrl })
  } catch (error: unknown) {
    session.staged = undefined
    await deps.staging.discard(staged)
    const code = error instanceof MediaUploadError ? error.code : toPublicCode(error)
    if (code !== 'user_cancelled' && code !== 'upload_cancelled') {
      deps.logger?.warn(`yootun-media-upload: upload failed (${session.id.slice(0, 8)}…): ${code}`)
    }
    deps.registry.settleFailed(session, code)
  }
}
