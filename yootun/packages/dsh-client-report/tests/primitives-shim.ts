/**
 * 测试专用官方原子件桶文件：jsdom 测试只加载本包实际消费的原子件，避免把
 * primitives 全量桶（shiki/katex/markdown 运行时）拖进测试图。生产 client
 * bundle 走包根导入，不受本文件影响。
 * @module
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export type { ButtonVariant } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
export { RiskConfirmation } from '@deepseek-ai/dsh-client-ui-primitives/src/RiskConfirmation.tsx'
export { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedControl.tsx'
export { Tag } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
export type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
