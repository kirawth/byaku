import { defineConfig } from 'vitest/config';

export default defineConfig({
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
