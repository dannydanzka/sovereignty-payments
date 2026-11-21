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

export { toAppErrorOptions, type PaymentAppErrorOptions } from './core/app-error';

export { currencyExponent, fromMinorUnits, isSupportedCurrency, toMinorUnits } from './core/money';

export {
  systemClock,
  type EffectRunner,
  type EventClaim,
  type PaymentEventStore,
  type PaymentsClock,
  type PaymentsLogger,
} from './core/ports';

export {
  createPaymentsKernel,
  type CheckoutResult,
  type ConfirmResult,
  type PaymentsKernel,
  type PaymentsKernelConfig,
  type WebhookResult,
} from './core/kernel';

export {
  createPurchaseRegistry,
  definePurchase,
  type FulfillContext,
  type PreparedPurchase,
  type PrepareContext,
  type PurchaseDefinition,
  type PurchaseRegistry,
  type RegisteredPurchase,
  type RegistryOptions,
} from './core/registry';

export {
  decodeJsonField,
  encodeMetadata,
  KIND_KEY,
  requireField,
  type MetadataValue,
} from './core/metadata';

export { createEffectRunner } from './core/effects';

export { fulfillmentKey, type FulfillmentOutcome } from './core/idempotency';

export type {
  LineItem,
  PaymentProvider,
  ProviderCheckoutInput,
  ProviderEvent,
  ProviderSession,
} from './core/types';
