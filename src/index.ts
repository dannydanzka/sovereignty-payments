/**
 * @dannydanzka/sovereignty-payments
 *
 * A provider-agnostic payments kernel. This entry point is pure TypeScript: no provider SDK, no
 * I/O, no framework. Import the adapter you need from `@dannydanzka/sovereignty-payments/stripe`.
 */

export {
  isPaymentError,
  PAYMENT_ERROR_CODES,
  PaymentError,
  type PaymentErrorCode,
  type PaymentErrorContext,
} from './core/errors';

export {
  currencyExponent,
  fromMinorUnits,
  isSupportedCurrency,
  toMinorUnits,
} from './core/money';

export {
  systemClock,
  type EffectRunner,
  type EventClaim,
  type PaymentEventStore,
  type PaymentsClock,
  type PaymentsLogger,
} from './core/ports';

export type {
  LineItem,
  PaymentProvider,
  ProviderCheckoutInput,
  ProviderEvent,
  ProviderSession,
} from './core/types';
