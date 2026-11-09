import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', plugin: 'src/plugin.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  tsconfig: 'tsconfig.build.json',
  sourcemap: true,
  clean: true,
  target: 'node20',
  platform: 'node',
  treeshake: true,
  splitting: true,
  external: ['seyfert', 'sucrase'],
});
