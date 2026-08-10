/**
 * The provider port — the entire surface a payment provider must expose.
 *
 * Four methods. Everything provider-shaped stops here: if a type in this file mentions a concept
 * that only one provider has (`payment_intent`, `charge`, `livemode`), the port has failed and a
 * second adapter becomes impossible to write honestly.
 */

/** A single thing being charged for. The library never asks what it *is*. */
export interface LineItem {
  readonly description?: string;
  readonly name: string;
  readonly quantity?: number;
  /** Already in the currency's smallest unit — see {@link ../core/money.toMinorUnits}. */
  readonly unitAmountMinor: number;
}

export interface ProviderCheckoutInput {
  readonly cancelUrl: string;
  /** ISO-4217, lowercase. */
  readonly currency: string;
  readonly lineItems: readonly LineItem[];
  /** Already flattened to strings by the kernel — providers only carry string maps. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly payerEmail?: string;
  readonly successUrl: string;
}

export interface ProviderSession {
  readonly amountTotalMinor: number | null;
  readonly id: string;
  readonly metadata: Readonly<Record<string, string>>;
  /**
   * Normalized inside the adapter. Each provider expresses "the payer actually paid" differently
   * (Stripe needs `payment_status === 'paid'` AND `status === 'complete'`); collapsing that into
   * one boolean here is what stops the condition from being re-derived, and re-derived wrongly,
   * in consumer code.
   */
  readonly paid: boolean;
  readonly payerEmail: string | null;
  /**
   * Opaque provider-side payment identifier. Deliberately NOT called `paymentIntentId`: that is
   * Stripe's noun. Other providers call it an order, a charge, or a capture id.
   */
  readonly paymentRef: string | null;
  readonly url: string | null;
}

/**
 * The normalized event vocabulary. Four cases, because four is what a payments kernel must act on:
 * money arrived, money went back, the receipt materialized later, and "not our concern".
 *
 * `ignored` is load-bearing: providers emit dozens of event types, and an endpoint that errors on
 * unrecognized ones will be retried forever. Normalizing to `ignored` lets the consumer answer 200
 * truthfully without pretending it handled something.
 */
export type ProviderEvent =
  | {
      readonly amountMinor: number;
      readonly currency: string;
      readonly id: string;
      readonly kind: 'payment.succeeded';
      readonly metadata: Readonly<Record<string, string>>;
      readonly payerEmail: string | null;
      readonly paymentRef: string;
      readonly receiptUrl?: string;
    }
  | { readonly id: string; readonly kind: 'payment.refunded'; readonly paymentRef: string }
  | {
      readonly id: string;
      readonly kind: 'receipt.updated';
      readonly paymentRef: string;
      readonly receiptUrl: string;
    }
  | { readonly id: string; readonly kind: 'ignored'; readonly providerType: string };

export interface PaymentProvider {
  createCheckoutSession(input: ProviderCheckoutInput): Promise<ProviderSession>;

  /** For diagnostics and logs only. The kernel never branches on it. */
  readonly name: string;

  /** Never throws for a missing receipt — resolves to `null`. Receipts materialize late. */
  resolveReceiptUrl(paymentRef: string): Promise<string | null>;

  retrieveCheckoutSession(sessionId: string): Promise<ProviderSession>;

  /**
   * Synchronous by contract: verification must run on the raw body with zero I/O between reading
   * the request and checking the signature. An `async` seam here is exactly where a body gets
   * parsed, re-serialized, and silently invalidated.
   *
   * @throws PaymentError('signature_invalid')
   */
  verifyWebhook(rawBody: string, signature: string): ProviderEvent;
}
