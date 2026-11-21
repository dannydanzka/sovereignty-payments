import { PAYMENT_ERROR_CODES } from './errors';
import type { PaymentError, PaymentErrorCode } from './errors';

/** What an HTTP caller should see for each failure: a configuration fault is the server's, a provider
 * outage is temporary, a bad signature or payload is the caller's. */
const STATUS_BY_CODE: Readonly<Record<PaymentErrorCode, number>> = {
  [PAYMENT_ERROR_CODES.CONFIGURATION_INVALID]: 500,
  [PAYMENT_ERROR_CODES.METADATA_INVALID]: 422,
  [PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE]: 503,
  [PAYMENT_ERROR_CODES.SESSION_NOT_CREATED]: 502,
  [PAYMENT_ERROR_CODES.SIGNATURE_INVALID]: 400,
  [PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND]: 422,
};

export interface PaymentAppErrorOptions {
  cause: PaymentError;
  code: PaymentErrorCode;
  details: Readonly<Record<string, unknown>>;
  statusCode: number;
}

/**
 * The options for the platform's `createAppError(message, options)`, so a payment failure crosses
 * into a product as one error type without this library depending on the kernel. The message — the
 * product's own, often an i18n key — stays with the product.
 */
export const toAppErrorOptions = (
  error: PaymentError,
  details: Readonly<Record<string, unknown>> = {}
): PaymentAppErrorOptions => ({
  cause: error,
  code: error.code,
  details: { ...error.context, ...details },
  statusCode: STATUS_BY_CODE[error.code],
});
