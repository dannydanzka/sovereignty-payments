import { describe, expect, it } from 'vitest';

import { isPaymentError, PAYMENT_ERROR_CODES, PaymentError } from './errors';

describe('PaymentError', () => {
  it('carries the code as the message so untyped logs stay useful', () => {
    const error = new PaymentError(PAYMENT_ERROR_CODES.SIGNATURE_INVALID);

    expect(error.message).toBe('signature_invalid');
    expect(error.name).toBe('PaymentError');
  });

  it('marks deterministic failures as non-retryable', () => {
    // A bad signature and undecodable metadata fail identically forever: retrying is pure waste,
    // and answering the provider with a retryable status would loop indefinitely.
    expect(new PaymentError(PAYMENT_ERROR_CODES.SIGNATURE_INVALID).retryable).toBe(false);
    expect(new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID).retryable).toBe(false);
    expect(new PaymentError(PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND).retryable).toBe(false);
  });

  it('marks transient failures as retryable', () => {
    expect(new PaymentError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE).retryable).toBe(true);
    expect(new PaymentError(PAYMENT_ERROR_CODES.SESSION_NOT_CREATED).retryable).toBe(true);
  });

  it('lets the caller override retryability when it knows better', () => {
    expect(new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID, { retryable: true }).retryable).toBe(
      true
    );
  });

  it('preserves cause and context for diagnosis', () => {
    const cause = new Error('underlying');
    const error = new PaymentError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, {
      cause,
      context: { operation: 'createCheckoutSession' },
    });

    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ operation: 'createCheckoutSession' });
  });

  it('narrows unknown values', () => {
    expect(isPaymentError(new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID))).toBe(true);
    expect(isPaymentError(new Error('nope'))).toBe(false);
    expect(isPaymentError(null)).toBe(false);
  });
});
