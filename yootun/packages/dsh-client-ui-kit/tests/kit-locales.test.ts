/** 词典键集与占位符一致性测试（zh 为键集事实源）。 */
import { describe, expect, it } from 'vitest'
import { createKitTranslate } from '../src/kit-locale.ts'
import { LOCALE_PLACEHOLDERS, en, zh, type YtKitLocaleKey } from '../src/locales.ts'

describe('kit 词典', () => {
  it('en 与 zh 键集完全一致', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('登记的占位符在 zh/en 中一致出现', () => {
    for (const [key, tokens] of Object.entries(LOCALE_PLACEHOLDERS)) {
      for (const token of tokens) {
        expect(zh[key as YtKitLocaleKey]).toContain(token)
        expect(en[key as YtKitLocaleKey]).toContain(token)
      }
    }
  })

  it('createKitTranslate 支持插值且缺值保持字面', () => {
    const t = createKitTranslate(en)
    expect(t('legend.toggleOn', { series: '播放' })).toBe('Hide series 播放')
    expect(t('legend.toggleOn')).toBe('Hide series {series}')
    expect(t('state.loading')).toBe('Loading…')
  })
})
