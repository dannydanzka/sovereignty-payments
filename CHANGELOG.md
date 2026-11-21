# Changelog

## 0.2.0

### Minor Changes

- 8887621: `/prisma`: `createPrismaPaymentEventStore` — the idempotency store every paying product needs (atomic claim on a unique insert, release on failure), typed structurally over the Prisma delegate. `toAppErrorOptions`: a `PaymentError` as options for the platform's `createAppError`, with the status each failure deserves. Toolchain: prettier and `format:check` in `verify` and CI, as in every platform library.

## 0.1.0 — 2026-08-09

Foundations. Not yet the full kernel.

### Added

- **Typed errors** (`PaymentError`, `PAYMENT_ERROR_CODES`) with per-code retry semantics. Deterministic failures (bad signature, undecodable metadata, unknown purchase kind) are non-retryable; provider outages are retryable. The consumer's webhook endpoint uses this to pick an HTTP status, which drives the provider's retry behaviour.
- **Money in minor units** (`toMinorUnits`, `fromMinorUnits`, `currencyExponent`) with a per-currency exponent table. Zero-exponent (JPY, KRW, CLP) and three-exponent (KWD, BHD) currencies are handled; unlisted currencies throw rather than assume 1/100.
- **The provider port** (`PaymentProvider`): `createCheckoutSession`, `retrieveCheckoutSession`, `resolveReceiptUrl`, `verifyWebhook`. Provider-neutral session and event types (`paymentRef`, not `paymentIntentId`).
- **Consumer ports**: `PaymentEventStore` (idempotency), `PaymentsLogger`, `PaymentsClock`, `EffectRunner`.
- **Stripe adapter** (`/stripe`): normalizes `payment_intent.succeeded`, `charge.refunded` and `charge.updated`; everything else becomes `ignored` so the endpoint can answer 200 truthfully. Mirrors checkout metadata onto the payment intent. `paid` collapses Stripe's two-condition truth into one boolean.
- **Testing helpers** (`/testing`): `signWebhookPayload` (real HMAC, so end-to-end suites exercise verification instead of stubbing it), `createFakeProvider`, `createInMemoryEventStore`.
- **Invariants enforced by ESLint**: no domain vocabulary, no user-facing text, no `process.env`.

### Notes

- Signature verification also enforces the provider's replay window; a correctly-signed but stale payload is rejected. Pinned by test.
- `stripe` is an **optional** peer dependency — consumers on another provider never install it.

### Next

Kernel: purchase registry (`definePurchase`), idempotent `handleWebhook`, `confirm` with reconciliation, and the cross-adapter `contract.spec.ts`.
