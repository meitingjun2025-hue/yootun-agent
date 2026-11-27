/**
 * mountGate 双挂载下的滚动锁归属回归（jsdom；验收轮 1 发现 F2 转正）：第一次
 * 挂载的 disposer 不得解除仍在阻断的第二次门禁的滚动锁（无条件复位 body
 * overflow 的旧实现会解除）；两次门禁全部卸载后 body overflow 必须复位——
 * 组件 blocking effect 清理各自恢复 previous 快照，双锁的 previous 互相指向
 * hidden，由 disposer 在门禁层清空后统一复位兜底。运行：
 * `pnpm --filter @yootun/dsh-client-ui-access test`（vitest 段）。
 */
import { describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { mountGate, type GateProps } from '../../src/client/gate.tsx'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

const UNAUTHORIZED_SNAPSHOT = { status: 'ready' as const, value: { setupComplete: false } as never, base: undefined, user: undefined, revision: 1, writable: true }

/** 未授权快照表单：门禁进入阻断相位，effect 申请滚动锁（快照引用稳定，避免 useSyncExternalStore 重渲染循环）。 */
function unauthorizedForm(): ConfigForm<never> {
  return {
    getSnapshot: () => UNAUTHORIZED_SNAPSHOT,
    subscribe: () => () => undefined,
  } as never
}

function blockingGateProps(): GateProps {
  return {
    forms: {
      access: unauthorizedForm(),
      defaultModel: unauthorizedForm(),
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

describe('mountGate 双挂载下的滚动锁归属（F2 回归）', () => {
  it('第一次 disposer 不得解除仍在阻断的第二次门禁的滚动锁', async () => {
    // 自建 #root：阻断期间 root.inert 必须保持 false（门禁不申请 inert）。
    document.body.innerHTML = '<div id="root"></div>'
    let dispose1: (() => void) | undefined
    let dispose2: (() => void) | undefined
    try {
      await act(async () => {
        dispose1 = mountGate(blockingGateProps())
      })
      await act(async () => {
        dispose2 = mountGate(blockingGateProps())
      })
      expect(document.body.style.overflow).toBe('hidden')
      // 阻断期间 root.inert 必须保持 false（门禁不申请 inert——与官方
      // onboarding loading 层的竞态，见 gate.tsx；disposer 的兜底复位不在此窗口）。
      expect(document.getElementById('root')?.inert).not.toBe(true)
      await act(async () => {
        dispose1?.()
      })
      // 第二次门禁仍挂载且仍阻断：滚动必须仍被锁住，aria-hidden 也不得被解除。
      expect(document.getElementById('yu-access-gate')).not.toBeNull()
      expect(document.body.style.overflow).toBe('hidden', '第一次 disposer 不应解除第二次门禁的滚动锁')
      expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true', '第一次 disposer 不应解除第二次门禁的背景隐藏')
      await act(async () => {
        dispose2?.()
      })
      // 两把锁都释放后（previous 快照互相指向 hidden）：overflow 与 aria-hidden 必须复位。
      expect(document.getElementById('yu-access-gate')).toBeNull()
      expect(document.body.style.overflow).toBe('', '门禁层全部卸载后滚动锁应复位')
      expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBeNull('门禁层全部卸载后背景隐藏应复位')
      expect(document.getElementById('root')?.inert).not.toBe(true, '卸载兜底复位后 root.inert 不得为 true')
    } finally {
      document.body.innerHTML = ''
      document.body.style.overflow = ''
      document.getElementById('root')?.remove()
    }
  })
})
