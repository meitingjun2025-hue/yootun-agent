/**
 * media_upload 会话工具（人机回环）：模型调用后插件创建上传会话并等待用户
 * 在工作台页面完成「选择文件 → 直传」，返回公网 URL 与非敏感元信息。工具
 * 不接受任何本地路径参数；预签名 URL、object key 与路径绝不进入结果。
 * @module
 */
import { PICK_KINDS, TOOL_NAME } from './constants.ts'
import type { UploaderDeps } from './deps.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
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
    description: '上传本地图片/视频到对象存储并返回公网 URL。调用后会请求用户在插件页面通过文件选择器亲手选择文件；'
      + '本工具不接受也不应该由调用方提供任何本地路径。拿到 URL 后可把它交给需要公网媒体地址的下游工具。',
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

/** The human-loop body of one admitted media_upload execution. */
async function executeAdmitted(
  deps: UploaderDeps,
  kind: string,
  exec: Parameters<NonNullable<ToolDefinition['execute']>>[1],
  toolTimeoutMs: number,
): Promise<ToolOutput> {
  const session = deps.registry.create(kind)
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
