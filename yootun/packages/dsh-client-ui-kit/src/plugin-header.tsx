/**
 * PluginHeader：页面头部（分册规范 §二/§三）。一级标题左对齐、操作右对齐；
 * 唯一主操作 + 次要操作区；状态（StateDot + 文本）由调用方经 `status` 传入。
 * 窄容器折为两行（标题行 + 操作行），高度保持 48–56px。
 * @module
 */
import type { ReactNode } from 'react'
import css from './plugin-header.module.css'

export interface PluginHeaderProps {
  /** Page title (caller-owned copy). */
  title: ReactNode
  /** Secondary line under the title. */
  subtitle?: ReactNode
  /** Live status node (e.g. StateDot + localized text). */
  status?: ReactNode
  /** The single primary action (caller renders the official Button). */
  primaryAction?: ReactNode
  /** Secondary actions: refresh, settings, assistant toggle. */
  actions?: ReactNode
}

/**
 * Render the page header row.
 * @param props.title - page title.
 * @param props.subtitle - secondary line.
 * @param props.status - status node.
 * @param props.primaryAction - the page's single primary action.
 * @param props.actions - secondary action buttons.
 * @returns the header element.
 */
export function PluginHeader({ title, subtitle, status, primaryAction, actions }: PluginHeaderProps): ReactNode {
  return (
    <header className={css.header}>
      <div className={css.identity}>
        <div className={css.titleRow}>
          <h1 className={css.title}>{title}</h1>
          {status}
        </div>
        {subtitle !== undefined && <p className={css.subtitle}>{subtitle}</p>}
      </div>
      <div className={css.actions}>
        {primaryAction}
        {actions}
      </div>
    </header>
  )
}
