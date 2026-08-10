import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The invariants of this library are enforced here, not merely documented.
 *
 * This package will be consumed by several unrelated products. Every rule below exists because
 * violating it would make the library *wrong* for the next consumer, not just impure:
 *
 *  1. No domain vocabulary  — a payments kernel that knows the word "enrollment" is one product's
 *                             kernel wearing a library's name.
 *  2. No user-facing text   — the consumer owns its language and tone; we return typed codes.
 *  5. No ambient config     — reading process.env makes behavior depend on a file we cannot see,
 *                             and silently couples us to the consumer's deployment.
 *
 * (Invariants 3, 4, 6 and 7 are enforced by the dependency list, the type signatures and the
 * contract test suite instead — see README "Invariants".)
 */
const DOMAIN_WORDS = [
  'enrollment',
  'participant',
  'coupon',
  'kit',
  'book',
  'meet',
  'shipment',
  'challenge',
  'evidence',
  'sponsor',
  'companion',
];

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      /**
       * Off for decoders at the serialization boundary. `decodeJsonField<T>` legitimately takes a
       * caller-asserted type parameter used once: JSON.parse returns `any`, and the shape is the
       * caller's knowledge, not ours. The alternative the rule pushes toward — returning `unknown`
       * — moves an identical cast to every call site instead of removing it.
       */
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      'no-restricted-globals': [
        'error',
        { message: 'Invariant 5: no ambient config. Configuration arrives through createPaymentsKernel.', name: 'process' },
      ],
      'no-restricted-properties': [
        'error',
        { message: 'Invariant 5: no ambient config. Pass values in explicitly.', object: 'process', property: 'env' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          message:
            'Invariant 1: no domain vocabulary. This library must not know what is being sold. Use generic terms (purchase, item, reference).',
          selector: `Identifier[name=/^(?!.*(?:Book(?:mark|keeping))).*(${DOMAIN_WORDS.join('|')})/i]`,
        },
        {
          message:
            'Invariant 2: no user-facing text. Return a typed error code; the consumer localizes it.',
          selector: 'Literal[value=/[áéíóúñ¿¡]/i]',
        },
      ],
      'sort-keys': ['error', 'asc', { caseSensitive: false, natural: true }],
    },
  },
  {
    files: ['src/**/*.test.ts', 'src/testing/**/*.ts'],
    rules: {
      /**
       * Test-only relaxations. Each is a rule whose value is in production code and whose cost is
       * paid only in tests:
       *  - `unbound-method` fires on the idiomatic `expect(spy.method)` assertion.
       *  - `no-confusing-void-expression` fires on `void effects.best(...)`, which is exactly how a
       *    caller signals "started, deliberately not awaited".
       *  - the assertion rules fire on casts that exist to construct inputs the types forbid —
       *    which is the point of the negative cases.
       */
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      // Fixtures legitimately name a consumer's purchase kinds to prove the registry is generic.
      'no-restricted-syntax': 'off',
    },
  },
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] }
);
