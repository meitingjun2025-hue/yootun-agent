/**
 * 报表页格式化纯函数测试（附录 B P15）：抖音口径——满 1 万用 locale compact
 * （zh 万/亿、en K/M），不足 1 万加千位分隔；百分比 clamp；时间固定上海时区
 * （UTC+8，不随宿主时区）；日期位移 UTC 语义；幂等键后缀 32 位小写 hex。
 * @module
 */
import { describe, expect, it } from 'vitest'
import { attemptId, formatCount, formatDateTime, formatPercent, shiftDay } from '../src/format.ts'
import { REPORT_ERROR_CODES, REPORT_REASONS_EN, REPORT_REASONS_ZH, createReportTranslate, en, zh } from '../src/locales.ts'

describe('P15 报表页格式化（抖音口径）', () => {
  it('formatCount：≥1 万 locale compact（zh 万/亿、en K/M）；不足 1 万千位分隔；缺失 — 不造 0', () => {
    expect(formatCount(null)).toBe('—')
    expect(formatCount(1234)).toBe('1,234')
    expect(formatCount(12345, 'zh')).toBe('1.2万')
    expect(formatCount(123456789, 'zh')).toBe('1.2亿')
    expect(formatCount(12345, 'en')).toBe('12.3K')
  })

  it('formatPercent clamp 0..100 两位小数；缺失 —', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(33.333)).toBe('33.33%')
    expect(formatPercent(120)).toBe('100%')
    expect(formatPercent(-5)).toBe('0%')
  })

  it('formatDateTime 固定上海时区（UTC+8，不随宿主时区）；非法/缺失 —', () => {
    expect(formatDateTime(null)).toBe('—')
    expect(formatDateTime('')).toBe('—')
    expect(formatDateTime('2026-11-20T16:00:00Z')).toBe('2026-11-21 00:00')
    expect(formatDateTime('2026-11-20T15:59:00Z')).toBe('2026-11-20 23:59')
  })

  it('shiftDay：UTC 语义位移（月末/年末/闰年边界）', () => {
    expect(shiftDay('2026-11-21', 1)).toBe('2026-11-22')
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01')
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('attemptId：32 位小写 hex（幂等键后缀）', () => {
    expect(attemptId()).toMatch(/^[0-9a-f]{32}$/u)
  })
})

describe('P15 报表词典（zh 键集事实源，en 全量同步）', () => {
  it('en 与 zh 键集完全一致，占位符集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const tokens = (text: string): string => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1]).sort().join(',')
    for (const key of Object.keys(zh)) {
      expect(tokens(en[key as keyof typeof en]), key).toBe(tokens(zh[key as keyof typeof zh]))
    }
  })

  it('REPORT_ERROR_CODES 恰好 13 个 REPORT_* 码；错误文案 17 码 + default 键集锁定', () => {
    expect(REPORT_ERROR_CODES).toHaveLength(13)
    for (const code of REPORT_ERROR_CODES) {
      expect(zh[`report.error.${code}`], code).toBeDefined()
    }
    const reasonKeys = Object.keys(REPORT_REASONS_ZH)
    expect(reasonKeys).toHaveLength(18)
    expect(reasonKeys.filter(key => key === 'report.error.default')).toEqual(['report.error.default'])
    expect(Object.keys(REPORT_REASONS_EN).sort()).toEqual([...reasonKeys].sort())
  })

  it('createReportTranslate 按语言选择词典并插值 {token}', () => {
    const zhT = createReportTranslate('zh')
    const enT = createReportTranslate('en')
    expect(zhT('report.daily')).toBe('日报')
    expect(enT('report.daily')).toBe('Daily')
    expect(zhT('report.regenerateBody', { version: 3 })).toBe('将基于当前已回补数据追加新版本 v3，旧版本保留。是否继续？')
  })
})
