/**
 * 测试专用官方原子件桶文件：jsdom 测试只加载实际消费的原子件，避免把
 * primitives 全量桶（shiki/katex/markdown 运行时）拖进测试图。
 * @module
 */
export { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
