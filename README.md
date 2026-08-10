# @dannydanzka/sovereignty-payments

A **provider-agnostic payments kernel**: checkout, webhook verification, idempotent fulfillment and reconciliation — with the payment provider behind a four-method port.

This is not a wrapper around a payment SDK. It exists because every product that takes money ends up re-implementing the same five steps once per purchase kind, each time slightly differently, and the differences are where money gets taken without anything being delivered.

---

## Why

Extracted from a production application that had four purchase flows. Each one had independently grown:

- its own idempotency guard — and **only one of the four** handled the concurrent-delivery race, though providers deliver duplicates routinely and retry for days;
- its own metadata encoding, with two competing discriminator conventions;
- its own checkout builder, duplicating URL construction and minor-unit conversion;
- and **only one of the four** had a fallback for a webhook that never arrives. For the other three, the money was captured and nothing happened — a failure mode with no error attached to it.

None of that is business logic. All of it is payments infrastructure, and it belongs in one place.

## Install

```bash
yarn add @dannydanzka/sovereignty-payments
yarn add stripe            # only if you use the Stripe adapter
```

Requires a `.npmrc` pointing the `@dannydanzka` scope at GitHub Packages.

## Entry points

| Import | Contains | Pulls in a provider SDK? |
|---|---|---|
| `@dannydanzka/sovereignty-payments` | kernel, ports, types, errors, money helpers | no — pure TypeScript |
| `@dannydanzka/sovereignty-payments/stripe` | the Stripe adapter | yes (`stripe`, an optional peer) |
| `@dannydanzka/sovereignty-payments/testing` | webhook signer, fake provider, in-memory event store | no |

## Usage

```ts
import { createStripeProvider } from '@dannydanzka/sovereignty-payments/stripe';
import { toMinorUnits } from '@dannydanzka/sovereignty-payments';

const provider = createStripeProvider({
  secretKey: config.secretKey,        // injected — this library never reads process.env
  webhookSecret: config.webhookSecret,
});

const session = await provider.createCheckoutSession({
  cancelUrl: `${baseUrl}/cancelled`,
  currency: 'mxn',
  lineItems: [{ name: 'Item', unitAmountMinor: toMinorUnits(499.5, 'mxn') }],
  metadata: { kind: 'demo_purchase', reference: order.id },
  successUrl: `${baseUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
});

// Later, in your webhook endpoint — the raw body, untransformed:
const event = provider.verifyWebhook(rawBody, signature);   // throws PaymentError('signature_invalid')
```

`metadata` set at checkout is mirrored onto the payment intent automatically, because `payment_intent.*` webhooks carry the intent's metadata and not the session's — a detail that silently produces empty metadata in fulfillment if you miss it.

## Money

Amounts cross the port in **minor units**, and the exponent is not universally 2. `toMinorUnits(1200, 'jpy')` is `1200`, not `120000`: JPY has no minor unit. Hard-coding `* 100` does not fail loudly — it overcharges a payer one hundredfold. An unlisted currency throws instead of guessing.

## Invariants

This library is consumed by several unrelated products. Anything product-shaped that reaches it becomes dead weight — or wrong defaults — for the next consumer.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | No domain vocabulary. The library never knows what is being sold. | ESLint banned-identifier rule |
| 2 | No user-facing text. Failures are typed codes; the consumer localizes. | ESLint; `PaymentError` carries a code, not a sentence |
| 3 | No persistence. State arrives only through `PaymentEventStore`. | no ORM/DB dependency permitted |
| 4 | No framework. No React, Next, Redux, styled-components. | dependency list |
| 5 | No ambient config. Zero `process.env`, zero file reads. | ESLint |
| 6 | No policy defaults. Absent configuration is an error, never a guess. | unit tests assert the throw |
| 7 | No opinion about what was bought. `metadata` is the consumer's generic. | type signatures + contract suite |

## Adding a provider

Implement `PaymentProvider` — four methods — and make it pass `contract.spec.ts`, the same suite the Stripe adapter passes. That file is the definition of "done"; it is what makes the swap real rather than aspirational.

Two rules the port encodes and an adapter must honor:

- **`paid` is normalized inside the adapter.** Every provider expresses "the payer actually paid" differently. Consumers must never re-derive it.
- **`verifyWebhook` is synchronous.** Verification runs on the raw body with zero I/O in between — an `async` seam is exactly where a body gets parsed, re-serialized and silently invalidated.

## Development

```bash
yarn verify     # type-check + lint + test + build
```

Publishing happens **only through CI** — never `npm publish` from a laptop.

## Status

`0.1.0` — the kernel is complete: typed errors, money, the provider port, the purchase registry, payment-keyed idempotency, reconciliation, the Stripe adapter and the cross-adapter contract suite. 75 tests, 100 % line coverage.
