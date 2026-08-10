/**
 * Typed error codes — the library's entire vocabulary for failure.
 *
 * There are no messages for humans here (invariant 2). A consumer maps a code to its own
 * localized string, because the library cannot know the language, the tone, or the audience of
 * the product embedding it. A code also survives translation, log aggregation and version bumps;
 * a sentence does not.
 */
export const PAYMENT_ERROR_CODES = {
  /** Provider config is incomplete or contradictory (missing key, unknown currency). */
  CONFIGURATION_INVALID: 'configuration_invalid',
  /** Metadata read back from the provider failed the purchase definition's decoder. */
  METADATA_INVALID: 'metadata_invalid',
  /** The provider rejected the call, timed out, or returned an unusable payload. */
  PROVIDER_UNAVAILABLE: 'provider_unavailable',
  /** The provider accepted the request but returned no redirect URL — nothing to send a payer to. */
  SESSION_NOT_CREATED: 'session_not_created',
  /** Webhook signature did not verify. Treat as hostile input, never as a transient fault. */
  SIGNATURE_INVALID: 'signature_invalid',
  /** An event arrived for a purchase kind that is not registered in this kernel. */
  UNKNOWN_PURCHASE_KIND: 'unknown_purchase_kind',
} as const;

export type PaymentErrorCode = (typeof PAYMENT_ERROR_CODES)[keyof typeof PAYMENT_ERROR_CODES];

export interface PaymentErrorContext {
  readonly [key: string]: unknown;
}

/**
 * The only error type this library throws.
 *
 * `retryable` exists because the consumer's webhook endpoint has to decide an HTTP status, and
 * that decision drives the provider's retry behaviour. Getting it backwards is expensive in both
 * directions: a non-retryable failure answered with 500 makes the provider retry a request that
 * can never succeed, while a transient failure answered with 400 drops a real payment on the floor.
 */
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;

  readonly context: PaymentErrorContext;

  readonly retryable: boolean;

  constructor(
    code: PaymentErrorCode,
    options: { cause?: unknown; context?: PaymentErrorContext; retryable?: boolean } = {}
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.context = options.context ?? {};
    this.name = 'PaymentError';
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code];
  }
}

/**
 * Default retry semantics per code. A signature failure or an undecodable payload will fail
 * identically forever, so retrying is pure waste; provider outages are exactly what retries exist
 * for. A consumer can still override per throw when it knows better.
 */
const DEFAULT_RETRYABLE: Record<PaymentErrorCode, boolean> = {
  [PAYMENT_ERROR_CODES.CONFIGURATION_INVALID]: false,
  [PAYMENT_ERROR_CODES.METADATA_INVALID]: false,
  [PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE]: true,
  [PAYMENT_ERROR_CODES.SESSION_NOT_CREATED]: true,
  [PAYMENT_ERROR_CODES.SIGNATURE_INVALID]: false,
  [PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND]: false,
};

export const isPaymentError = (value: unknown): value is PaymentError =>
  value instanceof PaymentError;
