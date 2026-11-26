/**
 * 本地同源 Host action 客户端（纯 client 库，无 Host 侧依赖）：三个工作台
 * client 共用的一份 `fetch` 封装。只发 POST JSON 到给定同源路径；响应必须是
 * JSON 对象且 `status` 为字符串，`status === 'error'` 时以稳定 `reason` 抛
 * {@linkcode HostActionError}；超时、网络失败与非 JSON 响应一律收敛为
 * `host_unreachable`，原始报文不透传。
 * @module
 */

/** One Host action failure carrying a stable reason code as both `code` and `message`. */
export class HostActionError extends Error {
  /** Stable reason code the page localizes from; identical to {@link Error.message}. */
  readonly code: string

  /**
   * @param code - stable reason code（Host error envelope 的 reason，或传输收敛码）。
   */
  constructor(code: string) {
    super(code)
    this.name = 'HostActionError'
    this.code = code
  }
}

/** One validated Host response: `status` is the business status, other fields pass through. */
export interface HostResponse extends Record<string, unknown> {
  status: string
  reason?: string | undefined
}

/** Budgets for one bound Host action client. */
export interface HostActionOptions {
  /** Default per-action timeout in ms; the SDK-style default applies when omitted. */
  timeoutMs?: number | undefined
  /** Per-action overrides for actions that synchronously wait on a browser probe. */
  actionTimeouts?: Readonly<Record<string, number>> | undefined
}

/** Default per-action budget (ms) when neither {@link HostActionOptions} entry covers the action. */
const DEFAULT_TIMEOUT_MS = 30_000

/** The transport-failure code every non-envelope failure converges to. */
const HOST_UNREACHABLE = 'host_unreachable'

/**
 * Read the stable reason off an error envelope: string, non-empty reasons pass;
 * everything else (missing, empty, non-string) falls back to `host_unreachable`.
 * @param payload - the parsed JSON body once it passed the object + string-status checks.
 * @returns the stable reason code.
 */
function reasonOf(payload: HostResponse): string {
  return typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : HOST_UNREACHABLE
}

/**
 * Create one Host action client bound to a local same-origin path. The returned
 * function resolves with the validated payload or rejects with
 * {@linkcode HostActionError}; it never rejects with a raw transport error.
 * @param path - local same-origin route（如 `/api/desktop/yootun/douyin-workbench`）.
 * @param options - per-action budgets; actions that synchronously wait on a
 *   browser probe must list a larger budget or slow probe failures surface as
 *   `host_unreachable` instead of the probe's own reason.
 * @returns the bound action caller.
 */
export function createHostAction(
  path: string,
  options: HostActionOptions = {},
): (action: string, args?: Record<string, unknown>) => Promise<HostResponse> {
  return async (action: string, args: Record<string, unknown> = {}): Promise<HostResponse> => {
    const budget = options.actionTimeouts?.[action] ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let payload: unknown
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...args }),
        signal: AbortSignal.timeout(budget),
      })
      payload = await response.json()
    } catch {
      // 超时 / 网络失败 / 非 JSON：稳定收敛为 host_unreachable，不透传原始报文。
      throw new HostActionError(HOST_UNREACHABLE)
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new HostActionError(HOST_UNREACHABLE)
    }
    const record = payload as Record<string, unknown>
    if (typeof record.status !== 'string') throw new HostActionError(HOST_UNREACHABLE)
    const reason = typeof record.reason === 'string' ? record.reason : undefined
    const validated: HostResponse = { ...record, status: record.status, ...(reason !== undefined ? { reason } : {}) }
    if (validated.status === 'error') throw new HostActionError(reasonOf(validated))
    return validated
  }
}
