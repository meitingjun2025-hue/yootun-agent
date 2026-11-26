/**
 * client Host 调用测试（jsdom）：插件的 `hostAction` 即 kit `createHostAction`
 * 绑定本工作台路由的实例（通用契约由 kit 测试覆盖）；本文件锁定插件侧事实：
 * 同源路径、传输失败收敛 `host_unreachable`（不再是 `douyin_operation_request_failed`）、
 * error envelope 以稳定 reason 抛出、载荷透传。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostActionError } from '@yootun/dsh-client-ui-kit/src/host-action.ts'
import { HOST_PATH, hostAction } from '../../src/client/api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('插件侧 hostAction 绑定', () => {
  it('绑定本工作台同源路由', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ready', accounts: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await hostAction('accounts.list')
    expect(res.status).toBe('ready')
    expect(res.accounts).toEqual([])
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe(HOST_PATH)
    expect(HOST_PATH).toBe('/api/desktop/yootun/douyin-workbench')
  })

  it('malformed JSON 收敛 host_unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(hostAction('accounts.list')).rejects.toMatchObject({ code: 'host_unreachable' })
  })

  it('非对象 JSON（数组/字符串）收敛 host_unreachable 且不透传原文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[1,2]', { status: 200 })))
    const error = await hostAction('accounts.list').catch((e: unknown) => e as HostActionError)
    expect(error).toBeInstanceOf(HostActionError)
    expect(error.message).not.toContain('1,2')
  })

  it('error envelope 按 reason 透出（状态码不误当 status）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'error', reason: 'collect_busy' }), { status: 403 })))
    await expect(hostAction('accounts.list')).rejects.toThrow('collect_busy')
  })
})
