/**
 * 门禁挂载与卸载语义（jsdom，实施单 workbench-host-kit 附录 B.3 R3）：
 * mountGate 连续调用两次（模拟重复挂载）后，第一次的 disposer 只卸载自己创建
 * 的宿主节点——宿主 root 由 mountGate 闭包持有，不再落在模块级变量上。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-access test`（vitest 段）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountGate, type GateProps } from '../../src/client/gate.tsx'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** 只服务于挂载/卸载断言的最小快照表单（值不驱动门禁渲染分支）。 */
function snapshotForm(): ConfigForm<never> {
  return {
    getSnapshot: () => ({ status: 'ready', value: {} as never, base: undefined, user: undefined, revision: 1, writable: true }),
    subscribe: () => () => undefined,
  } as never
}

function gateProps(): GateProps {
  return {
    forms: {
      access: snapshotForm(),
      defaultModel: snapshotForm(),
      models: undefined,
    },
    credentials: {
      describe: async () => ({ ok: true, value: {} }),
      set: async () => ({ ok: true }),
      unset: async () => ({ ok: true }),
    },
    t: (key: never) => String(key),
  }
}

describe('mountGate 挂载/卸载所有权（R3）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('连续挂载两次：第二次替换宿主节点；第一次的 disposer 只卸载自己的宿主', () => {
    const dispose1 = mountGate(gateProps())
    const first = document.getElementById('yu-access-gate')
    expect(first).not.toBeNull()

    const dispose2 = mountGate(gateProps())
    const second = document.getElementById('yu-access-gate')
    expect(second).not.toBeNull()
    expect(second).not.toBe(first, '第二次挂载应创建并接管新的宿主节点')

    dispose1()
    // 第一次的 disposer 只移除自己创建的宿主：第二次的宿主仍在文档中。
    expect(document.getElementById('yu-access-gate')).toBe(second)
    expect(document.contains(second)).toBe(true)

    dispose2()
    expect(document.getElementById('yu-access-gate')).toBeNull()
  })

  it('单独挂载后 disposer 移除宿主并复位应用阻断', () => {
    document.body.innerHTML = '<div id="root"></div>'
    const rootEl = document.getElementById('root')!
    rootEl.inert = true
    document.body.style.overflow = 'hidden'
    const dispose = mountGate(gateProps())
    expect(document.getElementById('yu-access-gate')).not.toBeNull()
    dispose()
    expect(document.getElementById('yu-access-gate')).toBeNull()
    expect(rootEl.inert).toBe(false, 'disposer 应复位 root.inert')
    expect(document.body.style.overflow).toBe('', 'disposer 应复位滚动锁')
  })
})
