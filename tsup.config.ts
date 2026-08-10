import { defineConfig } from 'tsup';

/**
 * Three independent entry points, because they have three different dependency profiles:
 *
 * - `index`            pure TypeScript. No provider SDK, no I/O. A consumer that only needs the
 *                      types and the kernel never pulls a payment SDK into its bundle.
 * - `adapters/stripe`  the ONLY module that imports `stripe`. It is an optional peer, so a
 *                      consumer on a different provider never installs it.
 * - `testing`          helpers for consumers' test suites. Kept out of `index` so it can never
 *                      reach a production bundle by accident.
 *
 * `external: ['stripe']` is not an optimization: bundling an optional peer would defeat the
 * optionality and ship a second copy of the SDK inside the library.
 */
export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    'adapters/stripe/index': 'src/adapters/stripe/index.ts',
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  },
  external: ['stripe'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  splitting: true,
  target: 'node20',
  treeshake: true,
});
