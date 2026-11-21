/** A payment failure crosses into the product as AppError options: code, status, context as details. */
import { describe, expect, it } from 'vitest';

import { toAppErrorOptions } from './app-error';
import { PAYMENT_ERROR_CODES, PaymentError } from './errors';

describe('toAppErrorOptions', () => {
  it('carries the code, the status the failure deserves, and the context merged with the caller details', () => {
    const error = new PaymentError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, {
      context: { provider: 'x' },
    });

    expect(toAppErrorOptions(error, { orderId: 'o1' })).toEqual({
      cause: error,
      code: 'provider_unavailable',
      details: { orderId: 'o1', provider: 'x' },
      statusCode: 503,
    });
  });

  it.each([
    [PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, 500],
    [PAYMENT_ERROR_CODES.METADATA_INVALID, 422],
    [PAYMENT_ERROR_CODES.SESSION_NOT_CREATED, 502],
    [PAYMENT_ERROR_CODES.SIGNATURE_INVALID, 400],
    [PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND, 422],
  ])('%s answers %i', (code, status) => {
    expect(toAppErrorOptions(new PaymentError(code)).statusCode).toBe(status);
  });
});
