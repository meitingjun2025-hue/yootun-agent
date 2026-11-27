/**
 * 小红书工作台中央面板：顶级导航固定三 tab（爆款仿写 / 账号管理 / 车衣爆款
 * 看板，12 册 §2；「素材」「发布」等不是页面）。X4 批次交付爆款仿写页；账号
 * 管理与车衣爆款看板面板随 X5/X6 批次接入（面板内占位，不新增顶级导航）。
 * 浏览器状态在页头辅助信息位呈现（阻断文案，无设备路径细节）。
 * @module
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { SegmentedTabs, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createKitTranslate, DataState, KitLocaleProvider, PluginHeader, PluginPageShell } from '@yootun/dsh-client-ui-kit'
import { en as kitEn, zh as kitZh } from '@yootun/dsh-client-ui-kit'
import { hostAction } from './api.ts'
import css from './workbench.module.css'
import { AccountsPage } from './AccountsPage.tsx'
import { HotboardPage } from './HotboardPage.tsx'
import { localeTagOf, type Translate } from './format.ts'
import { RewritePage } from './RewritePage.tsx'

export type { Translate } from './format.ts'

/** locale 服务的订阅座位（官方 LocaleFace 的 subscribe/getSnapshot 投影）。 */
export interface WorkbenchLocale {
  /** 快照变化通知；返回退订函数。 */
  subscribe(fn: () => void): () => void
  /** 当前快照（两次变化之间引用稳定）。 */
  getSnapshot(): { active: string }
}

export interface WorkbenchPageProps { t: Translate; locale: WorkbenchLocale }

type TabValue = 'rewrite' | 'accounts' | 'hotboard'
type BrowserState = 'loading' | 'ready' | 'chrome_missing' | 'driver_missing' | 'api_error'

interface TabItem { value: TabValue; label: string; id: string; panelId: string }

/**
 * 把元素最近的可滚动祖先滚回顶部：面板切换 = 新视图起点，避免上一面板
 * 遗留的滚动位置在新面板被钳制产生跳动。
 * @param el - 页内锚点元素（其祖先链含 shell 滚动容器）。
 */
function scrollAncestorToTop(el: HTMLElement | null): void {
  let node = el?.parentElement ?? null
  while (node !== null) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      node.scrollTop = 0
      return
    }
    node = node.parentElement
  }
}

/** 页面组件：三 tab 导航与爆款仿写页接线。 */
export function WorkbenchPage(props: WorkbenchPageProps): ReactNode {
  const t = props.t
  const locale = props.locale
  const active = useSyncExternalStore(locale.subscribe, locale.getSnapshot, locale.getSnapshot).active
  const localeTag = localeTagOf(active)
  const [tab, setTab] = useState<TabValue>('rewrite')
  const [browser, setBrowser] = useState<BrowserState>('loading')
  const tabsRef = useRef<HTMLDivElement | null>(null)

  const switchTab = useCallback((next: TabValue): void => {
    setTab(next)
    scrollAncestorToTop(tabsRef.current)
  }, [])

  const checkBrowser = useCallback((): void => {
    setBrowser('loading')
    hostAction('browser.status').then(res => {
      const chromeAvailable = res.chromeAvailable === true
      const driverAvailable = res.driverAvailable === true
      setBrowser(chromeAvailable && driverAvailable ? 'ready' : chromeAvailable ? 'driver_missing' : 'chrome_missing')
    }).catch(() => { setBrowser('api_error') })
  }, [])

  useEffect(() => { checkBrowser() }, [checkBrowser])

  const kitTranslate = localeTag === 'zh' ? createKitTranslate(kitZh) : createKitTranslate(kitEn)

  const tabs: readonly [TabItem, ...TabItem[]] = [
    { value: 'rewrite', label: t('tab.rewrite'), id: 'xhs-tab-rewrite', panelId: 'xhs-panel-rewrite' },
    { value: 'accounts', label: t('tab.accounts'), id: 'xhs-tab-accounts', panelId: 'xhs-panel-accounts' },
    { value: 'hotboard', label: t('tab.hotboard'), id: 'xhs-tab-hotboard', panelId: 'xhs-panel-hotboard' },
  ]

  const headerStatus = browser === 'loading'
    ? <span className={css.headerStatus}><StateDot state='ongoing' />{t('header.status.browserChecking')}</span>
    : browser === 'chrome_missing' || browser === 'driver_missing'
      ? <span className={css.headerStatus}><StateDot state='error' />{t('header.status.browserBlocked')}</span>
      : browser === 'api_error'
        ? <span className={css.headerStatus}><StateDot state='warning' />{t('header.status.serviceDegraded')}</span>
        : <span className={css.headerStatus}><StateDot state='done' />{t('header.status.browserReady')}</span>

  return (
    <KitLocaleProvider value={kitTranslate}>
      <PluginPageShell
        label={t('panel')}
        header={(
          <PluginHeader
            title={t('panel')}
            subtitle={t('panel.subtitle')}
            status={headerStatus}
          />
        )}
      >
        <div className={css.tabsRow} ref={tabsRef}>
          <SegmentedTabs items={tabs} value={tab} onChange={switchTab} label={t('panel')} />
        </div>
        <DataState state='ready' shape='rows'>
          <div id='xhs-panel-body' role='tabpanel' aria-label={t('panel')}>
            {tab === 'rewrite' && <RewritePage t={t} />}
            {tab === 'accounts' && <AccountsPage t={t} />}
            {tab === 'hotboard' && <HotboardPage t={t} />}
          </div>
        </DataState>

      </PluginPageShell>
    </KitLocaleProvider>
  )
}
