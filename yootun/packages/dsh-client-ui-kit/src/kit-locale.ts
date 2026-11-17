/**
 * 组件库词典读取：消费者通过 `KitLocaleProvider` 注入 locale 与 translate，
 * 组件不依赖宿主 locale 服务的具体形态（宿主在插件 apply 里完成绑定）。
 * @module
 */
import { createContext, useContext } from 'react'
import { zh, type YtKitLocaleKey } from './locales.ts'

/** A translate function over the kit's typed dictionary. */
export type YtTranslate = (key: YtKitLocaleKey, values?: Readonly<Record<string, string | number>>) => string

/** Interpolate `{token}` placeholders; unknown tokens stay literal. */
function interpolate(text: string, values: Readonly<Record<string, string | number>> | undefined): string {
  if (values === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (match, token: string) => {
    const value = values[token]
    return value === undefined ? match : String(value)
  })
}

const defaultTranslate: YtTranslate = (key, values) => interpolate(zh[key], values)

const KitLocaleContext = createContext<YtTranslate>(defaultTranslate)

export const KitLocaleProvider = KitLocaleContext.Provider

/**
 * Read the kit translate function.
 * @returns the injected translate, or the zh default in standalone renders.
 */
export function useKitLocale(): YtTranslate {
  return useContext(KitLocaleContext)
}

/** Build a translate function from a resolved dictionary (zh key set). */
export function createKitTranslate(dictionary: Readonly<Record<YtKitLocaleKey, string>>): YtTranslate {
  return (key, values) => interpolate(dictionary[key], values)
}
