/** 图表与 composer 纯逻辑测试（无 DOM）。 */
import { describe, expect, it } from 'vitest'
import { CHART_HEIGHT_MAX_PX, CHART_HEIGHT_MIN_PX, clampChartHeight, placeTooltip } from '../src/chart-logic.ts'
import { composerKeyAction, sendDisabledReason, shouldStickToBottom } from '../src/composer-logic.ts'

describe('clampChartHeight', () => {
  it('钳制到 180–320 规格带，缺省 240', () => {
    expect(clampChartHeight(undefined)).toBe(240)
    expect(clampChartHeight(120)).toBe(CHART_HEIGHT_MIN_PX)
    expect(clampChartHeight(400)).toBe(CHART_HEIGHT_MAX_PX)
    expect(clampChartHeight(200)).toBe(200)
    expect(clampChartHeight(Number.NaN)).toBe(240)
  })
})

describe('placeTooltip', () => {
  const base = {
    point: { x: 60, y: 80 },
    bubble: { width: 120, height: 60 },
    container: { width: 400, height: 300 },
  }

  it('默认放锚点右侧并垂直居中', () => {
    const placement = placeTooltip(base)
    expect(placement.side).toBe('right')
    expect(placement.left).toBe(72)
    expect(placement.top).toBe(50)
  })

  it('右侧放不下时翻转到左侧，仍越界时钳回容器', () => {
    const flipped = placeTooltip({ ...base, point: { x: 340, y: 80 } })
    expect(flipped.side).toBe('left')
    expect(flipped.left).toBe(208)
    const leftFits = placeTooltip({ ...base, point: { x: 395, y: 80 } })
    expect(leftFits.side).toBe('left')
    expect(leftFits.left).toBe(263)
  })

  it('bubble 宽于容器可用空间时钳回 0', () => {
    const wide = placeTooltip({ ...base, point: { x: 10, y: 80 }, bubble: { width: 500, height: 60 } })
    expect(wide.side).toBe('left')
    expect(wide.left).toBe(0)
    // 居中锚点 + 半宽以上 bubble：两侧都越界，钳回 0。
    const centered = placeTooltip({ ...base, point: { x: 200, y: 80 }, bubble: { width: 300, height: 60 } })
    expect(centered.side).toBe('left')
    expect(centered.left).toBe(0)
  })

  it('垂直越界钳回容器内', () => {
    const placement = placeTooltip({ ...base, point: { x: 60, y: 4 } })
    expect(placement.top).toBe(0)
    const bottom = placeTooltip({ ...base, point: { x: 60, y: 295 } })
    expect(bottom.top).toBe(300 - 60)
  })
})

describe('composerKeyAction', () => {
  it('Enter 发送、Shift+Enter 换行、IME 组词期不动作', () => {
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, compositionGuarded: false, canSend: true })).toEqual({ kind: 'send' })
    expect(composerKeyAction({ key: 'Enter', shiftKey: true, compositionGuarded: false, canSend: true })).toEqual({ kind: 'newline' })
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, compositionGuarded: true, canSend: true })).toEqual({ kind: 'none' })
    expect(composerKeyAction({ key: 'Enter', shiftKey: false, compositionGuarded: false, canSend: false })).toEqual({ kind: 'none' })
    expect(composerKeyAction({ key: 'a', shiftKey: false, compositionGuarded: false, canSend: true })).toEqual({ kind: 'none' })
  })
})

describe('sendDisabledReason', () => {
  it('按 busy > unauthorized > model > empty 的稳定优先级给出原因', () => {
    expect(sendDisabledReason({ busy: true, modelAvailable: true, unauthorized: false, empty: false })).toBe('busy')
    expect(sendDisabledReason({ busy: false, modelAvailable: true, unauthorized: true, empty: false })).toBe('unauthorized')
    expect(sendDisabledReason({ busy: false, modelAvailable: false, unauthorized: false, empty: false })).toBe('model')
    expect(sendDisabledReason({ busy: false, modelAvailable: true, unauthorized: false, empty: true })).toBe('empty')
    expect(sendDisabledReason({ busy: false, modelAvailable: true, unauthorized: false, empty: false })).toBeUndefined()
  })
})

describe('shouldStickToBottom', () => {
  it('贴底跟随、上翻不拉回、内容不溢出恒为真', () => {
    expect(shouldStickToBottom({ scrollTop: 500, scrollHeight: 600, clientHeight: 100 })).toBe(true)
    expect(shouldStickToBottom({ scrollTop: 480, scrollHeight: 600, clientHeight: 100 })).toBe(true)
    expect(shouldStickToBottom({ scrollTop: 300, scrollHeight: 600, clientHeight: 100 })).toBe(false)
    expect(shouldStickToBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 })).toBe(true)
  })
})
