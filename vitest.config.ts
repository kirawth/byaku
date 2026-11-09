import { readFileSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// The version shown by the summary mode comes from package.json at build time
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { BYAKU_VERSION: JSON.stringify(version) },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      // The core stays well covered; the Discord layer is covered by integration tests
      thresholds: {
        'src/{parse,output,session,inspect,runners,options}.ts': { lines: 90 },
      },
    },
  },
});
