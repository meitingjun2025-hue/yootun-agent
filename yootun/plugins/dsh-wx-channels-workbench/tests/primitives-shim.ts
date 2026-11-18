/**
 * 测试专用官方原子件桶文件：jsdom 测试只加载实际消费的原子件，避免把
 * primitives 全量桶（shiki/katex/markdown 运行时）拖进测试图。
 * @module
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
export { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
export { Tag } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
export { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedTabs.tsx'
export { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
