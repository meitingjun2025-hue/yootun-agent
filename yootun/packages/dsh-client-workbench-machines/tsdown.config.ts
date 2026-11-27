import type { UserConfig } from 'tsdown'

export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'neutral',
  target: 'es2024',
  clean: false,
  fixedExtension: false,
  dts: true,
} satisfies UserConfig
