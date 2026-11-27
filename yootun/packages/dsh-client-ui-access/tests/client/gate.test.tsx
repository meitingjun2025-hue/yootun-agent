/**
 * 门禁挂载与卸载语义（jsdom，实施单 workbench-host-kit 附录 B.3 R3）：
 * mountGate 连续调用两次（模拟重复挂载）后，第一次的 disposer 只卸载自己创建
 * 的宿主节点——宿主 root 由 mountGate 闭包持有，不再落在模块级变量上。
 * 运行：`pnpm --filter @yootun/dsh-client-ui-access test`（vitest 段）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountGate, type GateProps } from '../../src/client/gate.tsx'
import { ACCESS_CREDENTIAL_REF, VALIDATION_VERSION } from '../../src/access-constants.ts'
import { describeKeyConfigured } from '../../src/client/logic.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'

/** 只服务于挂载/卸载断言的最小快照表单（值不驱动门禁渲染分支）。 */
function snapshotForm(value: Record<string, unknown> = {}): ConfigForm<never> {
  // 快照单引用：useSyncExternalStore 要求两次变化之间 getSnapshot 引用稳定。
  const snap = { status: 'ready', value: value as never, base: undefined, user: undefined, revision: 1, writable: true }
  return {
    getSnapshot: () => snap,
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

describe('门禁背景对辅助技术隐藏（ui-accessibility G1/G2）', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"><p>app</p></div>'
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  /** credentials 注入面：describe 按脚本应答（configured 判定的来源）。 */
  function credentialsDescribe(script: () => Promise<{ ok: boolean; value: Record<string, unknown> }>): GateProps['credentials'] {
    return {
      describe: (() => script()) as never,
      set: async () => ({ ok: true }),
      unset: async () => ({ ok: true }),
    }
  }

  it('G1 阻断态（configured=false 与 describe 挂起的未知态）#root 带 aria-hidden；授权成立则不带', async () => {
    const settingsReady = { setupComplete: true, validationVersion: Number(VALIDATION_VERSION) }
    // 第一挂载：describe 永远挂起 → 判定未知 → 阻断。
    let respond: () => void = () => {}
    const hold = new Promise<void>(resolve => { respond = resolve })
    const disposePending = mountGate({
      forms: { access: snapshotForm(settingsReady), defaultModel: snapshotForm(), models: undefined },
      credentials: credentialsDescribe(async () => { await hold; return { ok: true, value: {} } }),
      t: (key: never) => String(key),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true')
    respond()
    await new Promise(resolve => setTimeout(resolve, 0))
    disposePending()
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBeNull()

    // 第二挂载：configured=false → 授权否 → 仍阻断。
    const disposeDenied = mountGate({
      forms: { access: snapshotForm(settingsReady), defaultModel: snapshotForm(), models: undefined },
      credentials: credentialsDescribe(async () => ({ ok: true, value: { [ACCESS_CREDENTIAL_REF]: { configured: false } } })),
      t: (key: never) => String(key),
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBe('true')
    disposeDenied()
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBeNull()

    // 第三挂载：configured=true + settings 就绪 → 授权成立 → 阻断解除，不设 aria-hidden。
    const disposeGranted = mountGate({
      forms: { access: snapshotForm(settingsReady), defaultModel: snapshotForm(), models: undefined },
      credentials: credentialsDescribe(async () => ({ ok: true, value: { [ACCESS_CREDENTIAL_REF]: { configured: true } } })),
      t: (key: never) => String(key),
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(document.getElementById('root')?.getAttribute('aria-hidden')).toBeNull()
    disposeGranted()
  })

  it('G2 disposer 调用后 #root 不带 aria-hidden，且全程未写入 inert', async () => {
    const props: GateProps = {
      forms: { access: snapshotForm(), defaultModel: snapshotForm(), models: undefined },
      credentials: credentialsDescribe(async () => ({ ok: true, value: { [ACCESS_CREDENTIAL_REF]: { configured: false } } })),
      t: (key: never) => String(key),
    }
    const rootEl = document.getElementById('root')!
    const dispose = mountGate(props)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rootEl.getAttribute('aria-hidden')).toBe('true')
    dispose()
    expect(rootEl.getAttribute('aria-hidden')).toBeNull()
    expect(rootEl.inert).not.toBe(true)
  })
})
