/**
 * 文件名 → Content-Type 推断与魔数嗅探。扩展名推断只在登记时给授权用
 * Content-Type；真实字节类型在暂存完成后嗅探比对（mime_mismatch 拒绝）。
 * @module
 */

import { ALLOWED_CONTENT_TYPES } from './constants.ts'

/** 扩展名 → MIME（与 Tools 服务端白名单严格对齐）。 */
const EXT_MIME: Readonly<Record<string, string>> = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
})

/**
 * Take a lowercase extension (no dot).
 * @param filename - file name, possibly with directories.
 * @returns the extension, or '' when absent.
 */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return ''
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Infer the Content-Type from a file name.
 * @param filename - the picked file name.
 * @returns the MIME, or application/octet-stream when unknown.
 */
export function guessContentType(filename: string): string {
  return EXT_MIME[extensionOf(filename)] ?? 'application/octet-stream'
}

/**
 * Strip MIME parameters and lowercase for comparisons.
 * @param value - a Content-Type header value.
 * @returns the bare type, or '' for non-strings.
 */
export function normalizeMime(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/**
 * Sniff the byte-level type of staged content.
 * @param head - the first bytes of the file (at least 12 bytes when available).
 * @returns the sniffed MIME inside the allowlist, or `undefined` for unknown signatures.
 */
export function sniffContentType(head: Uint8Array): string | undefined {
  const ascii = (start: number, end: number): string => Buffer.from(head.slice(start, end)).toString('latin1')
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image/jpeg'
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47) return 'image/png'
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp'
  if (head.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4'
  }
  return undefined
}

/**
 * Whether the declared type matches the byte-level type. Both must be inside
 * the allowlist; unknown signatures never match.
 * @param declared - the registered Content-Type.
 * @param head - the staged file's leading bytes.
 * @returns whether the bytes agree with the declaration.
 */
export function bytesMatchDeclaration(declared: string, head: Uint8Array): boolean {
  const type = normalizeMime(declared)
  if (!ALLOWED_CONTENT_TYPES.has(type)) return false
  return sniffContentType(head) === type
}
