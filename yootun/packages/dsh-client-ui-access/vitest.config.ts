/**
 * 接入层 client 测试（jsdom，独立于官方 vitest scope）：
 * `pnpm --filter @yootun/dsh-client-ui-access test`（vitest 段）。
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // 官方 primitives 桶拖入 shiki/katex 全图；门禁只需 React 组件，指向受控入口。
      {
        find: /^@deepseek-ai\/dsh-client-ui-primitives$/u,
        replacement: fileURLToPath(new URL('./tests/client/primitives-shim.ts', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'jsdom',
    include: ['tests/client/**/*.test.{ts,tsx}'],
  },
})
