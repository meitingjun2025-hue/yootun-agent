import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // tsc 先产出 lib/types（exports 的 types 入口）；tsdown 不得清空 lib。
  clean: false,
  fixedExtension: false,
  dts: true,
} satisfies UserConfig
