/**
 * media_upload 会话工具（人机回环）：模型调用后插件创建上传会话，应用弹出
 * 「上传请求」承接卡片（dsh-media-upload client 半），用户在卡片里经原生
 * file input 选择文件完成直传，工具返回公网 URL 与非敏感元信息。用户可在
 * 卡片取消（cancel 路由把会话先落 `user_cancelled` 终态，工具读快照返回
 * 同码）。工具不接受任何本地路径参数；预签名 URL、object key 与路径绝不
 * 进入结果。
 * @module
 */
import { PICK_KINDS, TOOL_NAME } from './constants.ts'
import type { UploadSessionContext } from './sessions.ts'
import type { UploaderDeps } from './deps.ts'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'

/** 工具输出的稳定投影（不含路径与预签名 URL）。 */
interface ToolOutput {
  ok: boolean
  url?: string
  name?: string
  size?: number
  contentType?: string
  error?: string
}

/**
 * 输出 schema（单一来源）：additionalProperties:false，字段集与
 * {@link ToolOutput} 一致——只有公网 URL 与非敏感元信息。
 */
export const MEDIA_UPLOAD_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    url: { type: 'string' },
    name: { type: 'string' },
    size: { type: 'number' },
    contentType: { type: 'string' },
    error: { type: 'string' },
  },
} as const

/**
 * Register the media_upload session tool.
 * @param ctx - host plugin context.
 * @param deps - uploader wiring (registry carries the tool timeout via toolTimeoutMs).
 * @param toolTimeoutMs - whole-flow budget for the human loop.
 * @returns the registration disposer.
 */
export function registerMediaUploadTool(ctx: Context, deps: UploaderDeps, toolTimeoutMs: number): () => void {
  const definition: ToolDefinition = {
    name: TOOL_NAME,
    description: '上传用户亲手选择的本地图片/视频到对象存储并返回公网 URL。调用后应用会弹出「上传请求」卡片，'
      + '请提示用户在卡片中选择文件；用户也可以取消，取消时本工具返回 user_cancelled。'
      + '本工具不接受任何本地路径。拿到 URL 后可把它交给需要公网媒体地址的下游工具。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: [...PICK_KINDS],
          description: '文件类型档位，缺省 media（图片+视频）。',
        },
      },
    },
    output: {
      schema: MEDIA_UPLOAD_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: toolTimeoutMs,
    async execute(rawArgs, exec) {
      const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as { kind?: unknown }
      const kind = typeof args.kind === 'string' && PICK_KINDS.has(args.kind) ? args.kind : 'media'
      // disposal 后拒绝新调用（稳定码），不触碰 session/staging/Workbench。
      const admission = deps.registry.beginRequest()
      if (admission === undefined) return { ok: false, error: 'uploader_not_configured' } satisfies ToolOutput
      try {
        return await executeAdmitted(deps, kind, exec, toolTimeoutMs)
      } finally {
        admission.release()
      }
    },
  }
  return ctx.tools.register(definition)
}

/**
 * Read the caller identifiers of one execution. dsh-tools names the model
 * call id `callId` on its execution context and carries no session id, so a
 * tool-created session carries `toolCallId` only, and only when the runtime
 * value is a string (no type assertion; the field name follows the
 * execution-context type).
 * @param exec - the tool execution context.
 * @returns the identifiers object, or undefined when none is present.
 */
function contextOf(exec: ToolRunContext | undefined): UploadSessionContext | undefined {
  const toolCallId = exec !== undefined && typeof exec.callId === 'string' ? exec.callId : undefined
  return toolCallId === undefined ? undefined : { toolCallId }
}

/** The human-loop body of one admitted media_upload execution. */
async function executeAdmitted(
  deps: UploaderDeps,
  kind: string,
  exec: Parameters<NonNullable<ToolDefinition['execute']>>[1],
  toolTimeoutMs: number,
): Promise<ToolOutput> {
  // origin 'tool'：承接卡片的 pending 投影只含工具创建的会话；页面会话
  // （pick-file，origin 'page'）不触发卡片。
  const session = deps.registry.create(kind, 'tool', contextOf(exec))
  // 用户侧完成（done/failed）或超时/取消先到者胜。超时/取消取终态语义：
  // 会话立即 failed 并中止在途 PUT（正在直传时不得产生孤儿对象）；
  // awaiting 会话尚未绑定字节，无需中止。
  const timeout = AbortSignal.timeout(toolTimeoutMs)
  const signal = exec?.signal === undefined ? timeout : AbortSignal.any([exec.signal, timeout])
  const onAbort = (): void => {
    session.controller.abort()
    deps.registry.settleFailed(session, exec?.signal?.aborted === true ? 'user_cancelled' : 'upload_timeout')
  }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  try {
    await session.completion
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  const snapshot = deps.registry.snapshot(session.id)
  if (snapshot === undefined || snapshot.state !== 'done' || snapshot.url === undefined) {
    return { ok: false, error: snapshot?.error ?? 'upload_failed' } satisfies ToolOutput
  }
  // 回到对话上下文的只有公网 URL 与元信息；不含预签名 URL、路径与 key。
  return {
    ok: true,
    url: snapshot.url,
    name: snapshot.name,
    size: snapshot.size,
    contentType: snapshot.contentType,
  } satisfies ToolOutput
}
