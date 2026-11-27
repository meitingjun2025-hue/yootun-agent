/**
 * ReasonButton：带原因的置灰按钮。原生 disabled 按钮不派发鼠标事件、多数
 * 浏览器也不显示其 title，置灰原因对键盘与触屏不可达；本组件在 disabled 且
 * 有 reason 时保持按钮可聚焦（aria-disabled + aria-describedby 指向隐藏原因
 * 文本），原因经官方 Tooltip 呈现（A6 规格：side bottom / delayMs 500 /
 * maxWidth 300 / portal）；其余情况与官方 Button 渲染一致。
 * @module
 */
import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives'

/** ReasonButton 的 props：官方 Button 的 props 加 reason。 */
export interface ReasonButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
  /** 置灰原因文案；disabled 为真时生效。 */
  reason?: string | undefined
}

/**
 * Render a button whose disabled reason stays reachable.
 * @param props - 官方 Button props 加 reason。
 * @returns the button, wrapped in a reason tooltip when disabled with a reason.
 */
export function ReasonButton(props: ReasonButtonProps): ReactNode {
  const { reason, disabled, ...rest } = props
  // useId 无条件调用：disabled 翻转不得改变 hook 数（条件 hook 会让 React 卸载子树）。
  const reasonId = useId()
  if (disabled !== true || reason === undefined || reason === '') {
    return <Button {...rest} disabled={disabled} />
  }
  return (
    <>
      <Tooltip label={reason} side='bottom' delayMs={500} maxWidth={300} portal>
        <Button {...rest} disabled={false} aria-disabled='true' aria-describedby={reasonId} onClick={undefined} />
      </Tooltip>
      <span id={reasonId} hidden>{reason}</span>
    </>
  )
}
