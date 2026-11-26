/** client 组件测试（jsdom）：键集、两 tab 布局骨架、页面区域、键盘、样式红线。 */
// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkbenchPage } from '../../src/client/WorkbenchPage.tsx'
import { en, zh, type WxLocaleKey } from '../../src/client/locales.ts'

afterEach(cleanup)

const t = (key: WxLocaleKey): string => en[key] ?? key

describe('词典键集', () => {
  it('en 与 zh 键集完全一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('稳定码全集每个码都有词典文案（REASON_KEYS 编译期穷尽的运行时面）', async () => {
    const { STABLE_ERROR_CODES } = await import('../../src/errors.ts')
    const { reasonText } = await import('../../src/client/format.ts')
    const interpolate = (key: string, values?: Record<string, string | number>): string =>
      values === undefined ? (en[key as WxLocaleKey] ?? key) : `${en[key as WxLocaleKey] ?? key}:${String(values.code ?? '')}`
    for (const code of STABLE_ERROR_CODES) {
      expect(reasonText(code, interpolate).includes('error.unknownWithCode'), `reasonText ${code}`).toBe(false)
    }
    // 连接器鉴权投影与 Host 收敛码的口径（分册 08 §5.2 / 实施单 2.7）。
    expect(reasonText('UNAUTHORIZED', interpolate)).toBe(`${en['reason.UNAUTHORIZED']}（UNAUTHORIZED）`)
    expect(reasonText('host_unreachable', interpolate)).toBe(`${en['reason.host_unreachable']}（host_unreachable）`)
    expect(reasonText('LOCAL_CLEARED_REQUIRED', interpolate)).toBe(`${en['reason.LOCAL_CLEARED_REQUIRED']}（LOCAL_CLEARED_REQUIRED）`)
    // 批内熔断批次 / 条目原因文案（采集全部并发实施单 2.6/2.7）。
    expect(reasonText('risk_paused', interpolate)).toBe(`${en['reason.risk_paused']}（risk_paused）`)
    // 批量取消与空账号 ID 的稳定码文案（实施单 5.3 补齐轮，2.6 增量）。
    expect(reasonText('collect_cancelled', interpolate)).toBe(`${en['reason.collect_cancelled']}（collect_cancelled）`)
    expect(reasonText('account_id_required', interpolate)).toBe(`${en['reason.account_id_required']}（account_id_required）`)
    // 路由层拒绝原因文案（workbench-host-kit 2.6：kit 路由字面量的显式分支，R2）。
    expect(reasonText('forbidden', interpolate)).toBe(`${en['reason.forbidden']}（forbidden）`)
    expect(reasonText('unknown_action', interpolate)).toBe(`${en['reason.unknown_action']}（unknown_action）`)
    expect(reasonText('method_not_allowed', interpolate)).toBe(`${en['reason.method_not_allowed']}（method_not_allowed）`)
  })

  it('账号采集中状态点文案 zh / en 成对', () => {
    expect(zh['account.collecting']).toBe('采集中')
    expect(en['account.collecting']).toBe('Collecting')
  })
})

describe('顶级导航（布局契约：只有作品数据 / 账号总览两个 tab）', () => {
  it('tab 数量为 2，顺序为作品数据 → 账号总览，默认选中作品数据', () => {
    const { container } = render(<WorkbenchPage t={t} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.length).toBe(2)
    expect(tabs[0]?.getAttribute('aria-label') ?? tabs[0]?.textContent).toContain(en['tab.works'])
    expect(tabs.map(tab => tab.textContent)).toEqual([en['tab.works'], en['tab.overview']])
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('false')
    void container
  })

  it('采集与账号不再是顶级 tab（旧四 tab 契约废除）', () => {
    render(<WorkbenchPage t={t} />)
    expect(screen.queryByRole('tab', { name: 'Collect' })).toBeNull()
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull()
    // 词典里也不再提供旧 tab 键。
    expect('tab.collect' in zh).toBe(false)
    expect('tab.accounts' in zh).toBe(false)
  })

  it('tab 键盘左右切换在两个 tab 间循环', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(<WorkbenchPage t={t} />)
    const worksTab = screen.getByRole('tab', { name: en['tab.works'] })
    fireEvent.keyDown(worksTab, { key: 'ArrowRight' })
    await waitForTabSelected(en['tab.overview'])
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.overview'] }), { key: 'End' })
    await waitForTabSelected(en['tab.overview'])
    fireEvent.keyDown(screen.getByRole('tab', { name: en['tab.overview'] }), { key: 'ArrowRight' })
    await waitForTabSelected(en['tab.works'])
  })

  it('jsdom 无 Host：加载态可达（empty/error 由 Host 集成验证）', () => {
    render(<WorkbenchPage t={t} />)
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
  })

  it('jsdom 无 Host：挂载恢复查询失败按无运行中采集处理，不弹错误', async () => {
    render(<WorkbenchPage t={t} />)
    // 恢复查询在无 Host 时失败：按无运行中采集处理，页面骨架保持可用。
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(screen.getByRole('region', { name: en.panel })).not.toBeNull()
    expect(screen.queryByRole('button', { name: en['works.collecting'] })).toBeNull()
  })
})

async function waitForTabSelected(label: string): Promise<void> {
  const { waitFor } = await import('@testing-library/react')
  await waitFor(() => expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true'))
}

describe('样式红线', () => {
  const srcDir = join(process.cwd(), 'src', 'client')
  it('无 !important、无全局选择器、无字面色', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css')) continue
      const source = readFileSync(join(srcDir, name), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')
      expect(source).not.toMatch(/!important/u)
      expect(source).not.toMatch(/@tailwind|@apply/u)
      expect(source).not.toMatch(/(^|[}\n,{])(\s*)(body|html|:root|\*)\s*[,{]/u)
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
      expect(source).not.toMatch(/\b(rgba?|hsla?|oklch|oklab)\(/u)
    }
  })

  it('无 ywc-* 旧类名迁移、无 <style> 注入、无旧 inline style 技术', () => {
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.module.css') && !name.endsWith('.tsx')) continue
      const source = readFileSync(join(srcDir, name), 'utf8')
      expect(source).not.toMatch(/\bywc-/u)
      expect(source).not.toMatch(/dangerouslySetInnerHTML|document\.createElement\('style'\)/u)
    }
  })

  it('断点与 reduced-motion 覆盖（640 / 880 / 1120 容器档）', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('yootun-kit-page')
    expect(css).toContain('max-width: 1119px')
    expect(css).toContain('max-width: 879px')
    expect(css).toContain('max-width: 639px')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('280px 账号栏布局契约存在于样式', () => {
    const css = readFileSync(join(srcDir, 'workbench.module.css'), 'utf8')
    expect(css).toContain('280px minmax(0, 1fr)')
  })

  it('容器查询依赖 PluginPageShell（容器名对齐）', () => {
    const kitDir = join(process.cwd(), '..', '..', 'packages', 'dsh-client-ui-kit', 'src')
    expect(existsSync(join(kitDir, 'page-shell.module.css'))).toBe(true)
  })
})
