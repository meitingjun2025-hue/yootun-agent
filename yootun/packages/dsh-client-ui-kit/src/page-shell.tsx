/**
 * PluginPageShell：工作台页面的容器壳（分册规范 §二）。建立面板容器查询
 * （`container: yootun-kit-page / inline-size`），AssistantDock 等子组件按
 * 容器宽度切换布局；主内容区保持 `min-width: 0`，横向滚动只发生在内容内部。
 * @module
 */
import type { CSSProperties, ReactNode } from 'react'
import { ytChartStyle } from './tokens.ts'
import css from './page-shell.module.css'

export interface PluginPageShellProps {
  /** Localized accessible name for the page region. */
  label: string
  /** Page header region (PluginHeader). */
  header?: ReactNode
  /** Filter region (FilterBar). */
  filter?: ReactNode
  /** The assistant dock node; placed by the shell's container-query layout. */
  dock?: ReactNode
  /** Page content. */
  children?: ReactNode
}

/**
 * Render the workbench page shell with its container-query context.
 * @param props.label - accessible region name.
 * @param props.header - header region node.
 * @param props.filter - filter region node.
 * @param props.dock - assistant dock node.
 * @param props.children - page content.
 * @returns the page region element.
 */
export function PluginPageShell({ label, header, filter, dock, children }: PluginPageShellProps): ReactNode {
  const style: CSSProperties = { ...ytChartStyle }
  return (
    <section role="region" aria-label={label} className={css.shell} style={style}>
      <div className={css.body}>
        {header}
        {filter}
        <div className={css.content}>{children}</div>
      </div>
      {dock}
    </section>
  )
}
