import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: ['src/testing/**', '**/*.test.ts', '**/index.ts', 'src/core/types.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'lcov'],
      /**
       * A global floor, plus a hard 100 % gate on the module where a gap means money captured with
       * nothing delivered — or delivered twice. Idempotency has no acceptable uncovered branch:
       * every path through it is a decision about whether a payer's goods get granted.
       */
      thresholds: {
        'src/core/idempotency.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
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
