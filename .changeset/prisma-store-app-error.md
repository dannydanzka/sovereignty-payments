---
'@dannydanzka/sovereignty-payments': minor
---

`/prisma`: `createPrismaPaymentEventStore` — the idempotency store every paying product needs (atomic claim on a unique insert, release on failure), typed structurally over the Prisma delegate. `toAppErrorOptions`: a `PaymentError` as options for the platform's `createAppError`, with the status each failure deserves. Toolchain: prettier and `format:check` in `verify` and CI, as in every platform library.
