/** 组件行为测试（jsdom）：状态、交互、键盘路径与窄容器结构。 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKitTranslate } from '../src/kit-locale.ts'
import { KitLocaleProvider } from '../src/kit-locale.ts'
import { en } from '../src/locales.ts'
import { AssistantDock } from '../src/assistant-dock.tsx'
import { ChartFrame } from '../src/chart-frame.tsx'
import { ChartLegend } from '../src/chart-legend.tsx'
import { ChartTooltip } from '../src/chart-tooltip.tsx'
import { DataCard } from '../src/data-card.tsx'
import { DataState } from '../src/data-state.tsx'
import { FilterBar } from '../src/filter-bar.tsx'
import { FilterMenu } from '../src/filter-menu.tsx'
import { KpiCard } from '../src/kpi-card.tsx'
import { OperationReceipts } from '../src/operation-receipts.tsx'
import { Pager } from '../src/pager.tsx'
import { PluginHeader } from '../src/plugin-header.tsx'
import { PluginPageShell } from '../src/page-shell.tsx'

afterEach(cleanup)

const t = createKitTranslate(en)
const renderLocalized = (ui: React.ReactElement): ReturnType<typeof render> => render(<KitLocaleProvider value={t}>{ui}</KitLocaleProvider>)

describe('DataState', () => {
  it('loading 呈骨架并声明 aria-busy', () => {
    const { container } = render(<DataState state="loading" shape="rows" />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.querySelectorAll('span[class*="rowLine"]').length).toBeGreaterThan(0)
  })

  it('error 呈 role=alert 并提供 Retry', () => {
    const onRetry = vi.fn()
    renderLocalized(<DataState state="error" onRetry={onRetry} />)
    expect(screen.getByRole('alert')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('error 无 onRetry 时不渲染按钮', () => {
    renderLocalized(<DataState state="error" />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('empty 呈空态文案并可带下一步动作', () => {
    renderLocalized(<DataState state="empty" emptyAction={<button type="button">next</button>} />)
    expect(screen.getByText('No data')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'next' })).not.toBeNull()
  })

  it('partial 在保留内容之上呈警告条', () => {
    renderLocalized(<DataState state="partial"><p>rows</p></DataState>)
    expect(screen.getByRole('status').textContent).toContain('Partial data shown')
    expect(screen.getByText('rows')).not.toBeNull()
  })

  it('ready 只渲染内容', () => {
    renderLocalized(<DataState state="ready"><p>settled</p></DataState>)
    expect(screen.getByText('settled')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('FilterBar', () => {
  it('无任何内容时不渲染', () => {
    const { container } = render(<FilterBar />)
    expect(container.firstElementChild).toBeNull()
  })

  it('搜索可清空且焦点回到输入框', () => {
    const onChange = vi.fn()
    renderLocalized(<FilterBar search={{ value: 'abc', placeholder: 'Search', onChange }} />)
    const clear = screen.getByRole('button', { name: 'Clear search' })
    fireEvent.click(clear)
    expect(onChange).toHaveBeenCalledWith('')
    const input = screen.getByRole('searchbox')
    expect(document.activeElement).toBe(input)
  })

  it('Escape 清空非空搜索', () => {
    const onChange = vi.fn()
    renderLocalized(<FilterBar search={{ value: 'x', placeholder: 'Search', onChange }} />)
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('chip 展示数量、独立清除与一键清除', () => {
    const onClear = vi.fn()
    const onClearAll = vi.fn()
    renderLocalized(<FilterBar chips={[{ id: 'a', label: '播放', count: 3, onClear }]} onClearAll={onClearAll} />)
    expect(screen.getByText('播放')).not.toBeNull()
    expect(screen.getByText('3')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Clear: 播放' }))
    expect(onClear).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    expect(onClearAll).toHaveBeenCalledOnce()
  })
})

describe('KpiCard', () => {
  it('loading 呈数值骨架而非数字', () => {
    const { container } = render(<KpiCard label="播放" value="1,204" state="loading" />)
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.queryByText('1,204')).toBeNull()
  })

  it('delta 方向有箭头、文本与可达名称', () => {
    renderLocalized(<KpiCard label="播放" value="1,204" delta={{ direction: 'up', text: '+12%' }} />)
    expect(screen.getByText('+12%')).not.toBeNull()
    expect(screen.getByText('up')).not.toBeNull()
    expect(screen.getByText('↑')).not.toBeNull()
  })

  it('error/empty 态不渲染数值与 delta', () => {
    renderLocalized(<KpiCard label="播放" value="1,204" delta={{ direction: 'up', text: '+12%' }} state="error" onRetry={() => {}} />)
    expect(screen.queryByText('1,204')).toBeNull()
    expect(screen.queryByText('+12%')).toBeNull()
    expect(screen.getByRole('alert')).not.toBeNull()
    renderLocalized(<KpiCard label="播放" value="—" state="empty" />)
    expect(screen.getByText('No data')).not.toBeNull()
  })

  it('disabled 声明 aria-disabled', () => {
    const { container } = render(<KpiCard label="播放" value="—" disabled />)
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull()
  })
})

describe('ChartFrame', () => {
  it('绘图区为 role=group 且高度钳制在规格带', () => {
    const { container } = render(<ChartFrame title="最近七天播放如何变化" height={88}><svg /></ChartFrame>)
    const plot = container.querySelector('[role="group"]')
    expect(plot).not.toBeNull()
    expect(plot?.getAttribute('aria-label')).toContain('最近七天播放如何变化')
    expect(plot?.getAttribute('style')).toContain('height: 180px')
  })

  it("height='fit' 不固定高度，仅给绘图区与骨架一致的最小高度", () => {
    const { container } = render(<ChartFrame title="趋势" height="fit"><svg /></ChartFrame>)
    const plot = container.querySelector('[role="group"]')
    expect(plot?.getAttribute('style')).toContain('min-height: 120px')
    expect(plot?.getAttribute('style')).not.toMatch(/(^|;)\s*height:/)
  })

  it('error 态提供 Retry 且不渲染 marks', () => {
    const onRetry = vi.fn()
    const { container } = renderLocalized(<ChartFrame title="趋势" state="error" onRetry={onRetry}><svg /></ChartFrame>)
    expect(container.querySelector('svg')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('footnote 渲染在绘图区之后', () => {
    const { container } = render(<ChartFrame title="趋势" footnote="数据来源：采集批次">​<svg /></ChartFrame>)
    expect(container.textContent).toContain('数据来源：采集批次')
  })
})

describe('ChartLegend', () => {
  it('无 onToggle 时为只读色块行', () => {
    render(<ChartLegend items={[{ id: 'a', label: '播放', color: '--yt-chart-1' }]} />)
    expect(screen.queryByRole('group')).toBeNull()
    expect(screen.getByText('播放')).not.toBeNull()
  })

  it('onToggle 时每项为 aria-pressed 按钮并回调', () => {
    const onToggle = vi.fn()
    renderLocalized(
      <ChartLegend
        items={[{ id: 'a', label: '播放', color: '--yt-chart-1' }, { id: 'b', label: '点赞', color: '--yt-chart-2' }]}
        hiddenIds={new Set(['b'])}
        onToggle={onToggle}
      />,
    )
    const shown = screen.getByRole('button', { name: 'Hide series 播放' })
    expect(shown.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(shown)
    expect(onToggle).toHaveBeenCalledWith('a')
    const hidden = screen.getByRole('button', { name: 'Show series 点赞' })
    expect(hidden.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('ChartTooltip', () => {
  const container = { getBoundingClientRect: () => ({ width: 400, height: 300, x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 300, toJSON: () => ({}) }) } as HTMLElement

  it('不可见时不渲染', () => {
    const { container: root } = render(
      <ChartTooltip visible={false} point={{ x: 10, y: 10 }} title="11-10" rows={[{ label: '播放', value: '12' }]} container={container} />,
    )
    expect(root.firstElementChild).toBeNull()
  })

  it('可见时渲染标题与数据行并定位', () => {
    const { container: root } = render(
      <ChartTooltip visible point={{ x: 60, y: 80 }} title="11-10" rows={[{ label: '播放', value: '12', color: '--yt-chart-1' }]} container={container} />,
    )
    const bubble = root.firstElementChild as HTMLElement
    expect(bubble.textContent).toContain('11-10')
    expect(bubble.textContent).toContain('播放')
    expect(bubble.style.left).toBe('72px')
    expect(bubble.dataset.side).toBe('right')
  })
})

describe('AssistantDock', () => {
  const base = {
    open: true,
    onClose: vi.fn(),
    status: 'live' as const,
    draft: '',
    onDraftChange: vi.fn(),
    busy: false,
    onSend: vi.fn(),
    onStop: vi.fn(),
  }

  it('关闭时不渲染', () => {
    const { container } = render(<AssistantDock {...base} open={false} />)
    expect(container.firstElementChild).toBeNull()
  })

  it('标题与状态可达', () => {
    renderLocalized(<AssistantDock {...base} status="loading" />)
    expect(screen.getByText('Plugin assistant')).not.toBeNull()
    expect(screen.getByText('Connecting')).not.toBeNull()
  })

  it('Escape 在 dock 内触发关闭', () => {
    const onClose = vi.fn()
    renderLocalized(<AssistantDock {...base} draft='x' onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('侧板模式下 dock 外的 Escape 不关闭（不抢搜索框与页面快捷键）', () => {
    const onClose = vi.fn()
    render(
      <div>
        <input type='search' aria-label='page search' />
        <AssistantDock {...base} onClose={onClose} />
      </div>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('IME 组词期与收尾键的 Escape 不关闭', () => {
    const onClose = vi.fn()
    renderLocalized(<AssistantDock {...base} draft='x' onClose={onClose} />)
    const input = screen.getByRole('textbox')
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('空草稿禁用发送并给出原因', () => {
    renderLocalized(<AssistantDock {...base} draft="" />)
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toHaveProperty('disabled', true)
    expect(send.getAttribute('title')).toBe('Type a question first')
  })

  it('Enter 发送、Shift+Enter 不发送', () => {
    const onSend = vi.fn()
    render(<AssistantDock {...base} draft="你好" onSend={onSend} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })
    expect(onSend).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('IME 组词期间 Enter 不发送', () => {
    const onSend = vi.fn()
    render(<AssistantDock {...base} draft="你好" onSend={onSend} />)
    const input = screen.getByRole('textbox')
    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
  })

  it('busy 时呈 Stop 并回调 onStop', () => {
    const onStop = vi.fn()
    renderLocalized(<AssistantDock {...base} busy onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
  })

  it('模型不可用时禁用输入并按原因提示', () => {
    renderLocalized(<AssistantDock {...base} status="unavailable" unavailableReason="unauthorized" />)
    const input = screen.getByRole('textbox')
    expect(input).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('title')).toBe('Not activated; the assistant is unavailable')
  })

  it('建议在空态与对话中都渲染（调用方按 §6.1 裁剪条数）', () => {
    const onSuggest = vi.fn()
    const { rerender } = renderLocalized(
      <AssistantDock {...base} suggestions={['最近七天播放如何变化']} onSuggest={onSuggest} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '最近七天播放如何变化' }))
    expect(onSuggest).toHaveBeenCalledWith('最近七天播放如何变化')
    rerender(
      <KitLocaleProvider value={t}>
        <AssistantDock {...base} suggestions={['换个角度对比']} onSuggest={onSuggest} messages={[{ id: 'm1', role: 'user', content: <p>hi</p> }]} />
      </KitLocaleProvider>,
    )
    expect(screen.getByRole('button', { name: '换个角度对比' })).not.toBeNull()
  })

  it('上下文 chip 可移除且带可达名称', () => {
    const onRemove = vi.fn()
    renderLocalized(<AssistantDock {...base} context={[{ id: 'c1', label: '作品 12', onRemove }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference 作品 12' }))
    expect(onRemove).toHaveBeenCalledOnce()
  })
})

describe('OperationReceipts', () => {
  it('空列表不渲染', () => {
    const { container } = render(<OperationReceipts receipts={[]} />)
    expect(container.firstElementChild).toBeNull()
  })

  it('成功行带撤销位，失败行没有', () => {
    const onUndo = vi.fn()
    renderLocalized(
      <OperationReceipts
        receipts={[
          { id: 'r1', kind: 'success', text: '已保存设置', target: '采集设置', undo: { onUndo } },
          { id: 'r2', kind: 'failed', text: '保存失败（SETTINGS_CONFLICT）' },
        ]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(onUndo).toHaveBeenCalledOnce()
    expect(screen.getByText('Failed')).not.toBeNull()
    expect(screen.getByText('采集设置')).not.toBeNull()
  })

  it('已撤销行冻结展示', () => {
    renderLocalized(<OperationReceipts receipts={[{ id: 'r1', kind: 'undone', text: '已恢复原设置' }]} />)
    expect(screen.getByText('Undone')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })
})

describe('Pager', () => {
  it('信息文案按 total/pageSize 计算页数，末页禁用下一页', () => {
    const onPage = vi.fn()
    const { rerender } = renderLocalized(<Pager page={1} pageSize={20} total={40} onPage={onPage} />)
    expect(screen.getByText('40 items · page 1 / 2')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('disabled')).toBeNull()
    rerender(
      <KitLocaleProvider value={t}>
        <Pager page={2} pageSize={20} total={40} onPage={onPage} />
      </KitLocaleProvider>,
    )
    expect(screen.getByText('40 items · page 2 / 2')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('disabled')).toBeNull()
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('disabled')).not.toBeNull()
  })

  it('pages ≤ 1 只渲染信息文案，不渲染按钮', () => {
    renderLocalized(<Pager page={1} pageSize={20} total={5} onPage={() => {}} />)
    expect(screen.getByText('5 items · page 1 / 1')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('total=null 显示统计加载中文案并禁用两枚按钮', () => {
    const onPage = vi.fn()
    renderLocalized(<Pager page={1} pageSize={20} total={null} onPage={onPage} />)
    expect(screen.getByText('Loading totals…')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('disabled')).not.toBeNull()
  })

  it('busy 禁用两枚按钮', () => {
    renderLocalized(<Pager page={2} pageSize={20} total={60} busy onPage={() => {}} />)
    expect(screen.getByRole('button', { name: 'Previous page' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Next page' }).getAttribute('disabled')).not.toBeNull()
  })

  it('点击回调只在有效翻页时触发', () => {
    const onPage = vi.fn()
    const { rerender } = renderLocalized(<Pager page={1} pageSize={20} total={40} onPage={onPage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(onPage).toHaveBeenCalledOnce()
    expect(onPage).toHaveBeenCalledWith(2)
    rerender(
      <KitLocaleProvider value={t}>
        <Pager page={2} pageSize={20} total={40} onPage={onPage} />
      </KitLocaleProvider>,
    )
    onPage.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }))
    expect(onPage).toHaveBeenCalledWith(1)
  })

  it('按钮是原生 button，可键盘到达', () => {
    renderLocalized(<Pager page={1} pageSize={20} total={40} onPage={() => {}} />)
    const next = screen.getByRole('button', { name: 'Next page' })
    next.focus()
    expect(document.activeElement).toBe(next)
  })
})

describe('页面骨架与头部', () => {
  it('页面 region 可达并按序放置区域', () => {
    const { container } = render(
      <PluginPageShell label="视频号工作台" header={<span>header</span>} filter={<span>filter</span>} dock={<aside>dock</aside>}>
        <p>content</p>
      </PluginPageShell>,
    )
    const region = container.querySelector('[role="region"]')
    expect(region?.getAttribute('aria-label')).toBe('视频号工作台')
    const text = region?.textContent ?? ''
    expect(text.indexOf('header')).toBeLessThan(text.indexOf('filter'))
    expect(text.indexOf('filter')).toBeLessThan(text.indexOf('content'))
    expect(text.indexOf('dock')).toBeGreaterThan(-1)
  })

  it('标题、副标题与操作齐备', () => {
    render(
      <PluginHeader
        title="视频号工作台"
        subtitle="账号总览"
        status={<span>live</span>}
        primaryAction={<button type="button">collect</button>}
        actions={<button type="button">refresh</button>}
      />,
    )
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('视频号工作台')
    expect(screen.getByText('live')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'collect' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'refresh' })).not.toBeNull()
  })

  it('DataCard 的 error 态保留卡片并给 Retry', () => {
    const onRetry = vi.fn()
    renderLocalized(<DataCard title="作品排行" state="error" onRetry={onRetry}><p>rows</p></DataCard>)
    expect(screen.queryByText('rows')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })
})

describe('FilterMenu', () => {
  const ITEMS = [
    { id: 'all', label: 'All accounts' },
    { id: 'a', label: 'Account A' },
    { id: 'b', label: 'Account B' },
  ] as const

  it('渲染触发按钮与可选可见标签，关闭态不渲染菜单', () => {
    const { container } = render(
      <FilterMenu label="Account" visibleLabel="Account:" currentLabel="All accounts" items={ITEMS} selectedId="all" onSelect={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Account' }).textContent).toBe('All accounts')
    expect(container.querySelector('span[class*="filterGroupLabel"]')?.textContent).toBe('Account:')
    expect(screen.queryByRole('menu')).toBeNull()
    // visibleLabel 缺省不渲染
    const { container: bare } = render(
      <FilterMenu label="Sort" currentLabel="By plays" items={ITEMS} selectedId="all" onSelect={() => {}} />,
    )
    expect(bare.querySelector('span[class*="filterGroupLabel"]')).toBeNull()
  })

  it('打开后当前项带 check（selectedId）', () => {
    const { container } = render(
      <FilterMenu label="Account" currentLabel="Account A" items={ITEMS} selectedId="a" onSelect={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['All accounts', 'Account A', 'Account B'])
    // 选中行渲染尾缀 check 图标（MenuRow selected → IconCheckOutlineRegular）
    const selected = container.querySelector('[class*="selected"]')
    expect(selected?.querySelector('svg')).not.toBeNull()
  })

  it('disabled 时触发按钮不可打开', () => {
    render(
      <FilterMenu label="Account" currentLabel="All accounts" items={ITEMS} selectedId="all" disabled onSelect={() => {}} />,
    )
    const trigger = screen.getByRole('button', { name: 'Account' })
    expect((trigger as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('选择回调收到选项 id 并关闭菜单', () => {
    const onSelect = vi.fn()
    render(
      <FilterMenu label="Account" currentLabel="All accounts" items={ITEMS} selectedId="all" onSelect={onSelect} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Account' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Account B' }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('b')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('triggerClassName 附加到触发按钮', () => {
    render(
      <FilterMenu label="Account" currentLabel="All" items={ITEMS} selectedId="all" triggerClassName="pageTrigger" onSelect={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Account' }).classList.contains('pageTrigger')).toBe(true)
  })
})
