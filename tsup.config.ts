import { readFileSync } from 'node:fs';

import { defineConfig } from 'tsup';

// The version shown by the summary mode comes from package.json at build time
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

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
  define: { BYAKU_VERSION: JSON.stringify(version) },
});
