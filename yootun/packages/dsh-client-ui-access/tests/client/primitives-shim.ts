/**
 * 测试专用官方原子件桶文件：jsdom 测试只加载门禁表单实际消费的原子件，避免
 * primitives 全量桶（shiki/katex/markdown 运行时）拖进测试图（同工作台插件
 * tests/primitives-shim.ts 口径）。
 * @module
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
export { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
export { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx'
export { Switch } from '@deepseek-ai/dsh-client-ui-primitives/src/Switch.tsx'
export { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx'
