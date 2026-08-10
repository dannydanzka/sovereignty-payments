import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/testing/**', '**/*.test.ts', '**/index.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
      /**
       * Global floor. The per-file 100 % gates for the two modules where a bug means money
       * captured with nothing delivered — webhook verification and idempotency — are added
       * together with those modules (plan steps B.5 and B.9); declaring a per-file threshold for
       * a file that does not exist yet fails the run instead of guarding anything.
       */
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    globals: true,
    environment: 'node',
  },
});
