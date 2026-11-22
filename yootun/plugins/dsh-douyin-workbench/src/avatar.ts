/**
 * 头像 URL 归一（旧 avatar.js 全语义）：字符串走 http(s) 白名单；抖音图集对象
 * `{ uri, url_list: [...] }` 优先按原顺序取第一个合法 URL；危险协议与超长一律
 * null，不拼接域名、不截断。登录与采集共用本实现，保证两侧同一头像值。
 * @module
 */

/** 头像 URL 上限（旧 MAX_AVATAR_URL_LENGTH）。 */
export const MAX_AVATAR_URL_LENGTH = 2048

/**
 * Validate one candidate URL: trim, length cap, absolute http(s) only.
 * @param value - raw string candidate.
 * @returns the trimmed URL, or null for any unsafe shape.
 */
function safeUrlString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > MAX_AVATAR_URL_LENGTH) return null
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? text : null
  } catch {
    return null
  }
}

/**
 * Normalize one avatar value into a safe http(s) URL string.
 * @param value - string URL or Douyin avatar object (`{ uri, url_list }`).
 * @returns the normalized URL, or null when nothing qualifies.
 */
export function normalizeAvatarUrl(value: unknown): string | null {
  if (typeof value === 'string') return safeUrlString(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as { uri?: unknown; url_list?: unknown }
  // 图集形态：url_list 按原顺序取第一个合法 URL（历史 bug 是把图集对象直接
  // 透传给 <img src> 与 account_save）；uri 只是兼容候选。
  if (Array.isArray(record.url_list)) {
    for (const candidate of record.url_list) {
      const safe = safeUrlString(candidate)
      if (safe !== null) return safe
    }
  }
  return safeUrlString(record.uri)
}
