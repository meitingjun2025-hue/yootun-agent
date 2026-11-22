/**
 * client Host 响应边界验证测试（jsdom）：validateHostResponse 五态 + hostAction
 * malformed JSON 收敛。HTTP 状态码不误当业务 status。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostAction, validateHostResponse } from '../../src/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('validateHostResponse 边界验证', () => {
  it('status 非法拒绝（含把 HTTP 数字码误当 status 的形态）', () => {
    expect(() => validateHostResponse({ status: 200 })).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse({ status: 'ok-ish' })).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse({})).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse('ready')).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse([1])).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse(null)).toThrow('douyin_operation_request_failed')
  })

  it('status=error 缺 reason 拒绝', () => {
    expect(() => validateHostResponse({ status: 'error' })).toThrow('douyin_operation_request_failed')
  })

  it('reason 非字符串拒绝', () => {
    expect(() => validateHostResponse({ status: 'ready', reason: 42 })).toThrow('douyin_operation_request_failed')
    expect(() => validateHostResponse({ status: 'error', reason: { code: 'x' } })).toThrow('douyin_operation_request_failed')
  })

  it('ready/started/created 通过，其余字段保持透传', () => {
    const ready = validateHostResponse({ status: 'ready', accounts: [{ accountId: 'a' }] })
    expect(ready.status).toBe('ready')
    expect(ready.accounts).toEqual([{ accountId: 'a' }])
    expect(validateHostResponse({ status: 'started' }).status).toBe('started')
    expect(validateHostResponse({ status: 'created' }).status).toBe('created')
    expect(validateHostResponse({ status: 'error', reason: 'collect_busy' }).reason).toBe('collect_busy')
  })
})

describe('hostAction 传输收敛', () => {
  it('malformed JSON 收敛 douyin_operation_request_failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(hostAction('accounts.list')).rejects.toThrow('douyin_operation_request_failed')
  })

  it('非对象 JSON（数组/字符串）收敛稳定错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1,2]', { status: 200 })))
    await expect(hostAction('accounts.list')).rejects.toThrow('douyin_operation_request_failed')
  })

  it('HTTP 403 的 error envelope 按 reason 透出（状态码不误当 status）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', reason: 'forbidden' }), { status: 403 })))
    await expect(hostAction('accounts.list')).rejects.toThrow('forbidden')
  })
})
