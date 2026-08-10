import { createEffectRunner } from './effects';
import { PAYMENT_ERROR_CODES, PaymentError } from './errors';
import { fulfillmentKey, runOnce, type FulfillmentOutcome } from './idempotency';
import { encodeMetadata, type MetadataValue } from './metadata';
import type { PaymentEventStore, PaymentsLogger } from './ports';
import {
  createPurchaseRegistry,
  type PurchaseDefinition,
  type RegisteredPurchase,
  type RegistryOptions,
} from './registry';
import { isSupportedCurrency } from './money';
import type { PaymentProvider, ProviderEvent } from './types';

export interface PaymentsKernelConfig extends RegistryOptions {
  /** Absolute origin the success/cancel paths are resolved against. Built once, here. */
  readonly baseUrl: string;
  readonly currency: string;
  readonly eventStore: PaymentEventStore;
  readonly logger: PaymentsLogger;
  /**
   * A refund event carries no reliable purchase metadata — providers attach it to the payment, not
   * to the refund — so it cannot be routed to a purchase definition. It is handled at the kernel
   * level instead, keyed by payment reference, and the consumer looks up its own record.
   */
  readonly onRefund?: (context: { paymentRef: string }) => Promise<void>;
  /** Receipts materialize asynchronously, after fulfillment. Same reasoning as `onRefund`. */
  readonly onReceipt?: (context: { paymentRef: string; receiptUrl: string }) => Promise<void>;
  readonly provider: PaymentProvider;
  readonly purchases: readonly RegisteredPurchase[];
}

export interface CheckoutResult {
  readonly reference?: string;
  readonly sessionId: string;
  readonly url: string;
}

export interface WebhookResult {
  readonly kind: string | null;
  readonly outcome: FulfillmentOutcome | 'ignored' | 'refunded' | 'receipt';
  readonly result?: unknown;
}

export interface ConfirmResult {
  readonly amountTotalMinor: number | null;
  /**
   * The session's metadata, returned verbatim. The kernel already fetched the session to decide
   * whether it was paid, so handing back what it read costs nothing and saves the consumer a
   * second round trip to the provider just to recover its own identifiers.
   */
  readonly metadata: Readonly<Record<string, string>>;
  readonly outcome: FulfillmentOutcome | 'unpaid';
  readonly paid: boolean;
  readonly payerEmail: string | null;
  readonly reference: string | null;
}

export interface PaymentsKernel {
  /**
   * Verify a session after the payer returns, and fulfill it if the webhook has not already.
   *
   * This is the reconciliation path. It shares an idempotency key with the webhook path, so
   * whichever notices the payment first does the work and the other is a no-op.
   */
  confirm(sessionId: string): Promise<ConfirmResult>;
  /** Definition passed by value so the input type is inferred from the definition itself. */
  checkout<TInput, TMeta extends Record<string, MetadataValue>>(
    purchase: PurchaseDefinition<TInput, TMeta>,
    input: TInput
  ): Promise<CheckoutResult>;
  handleWebhook(rawBody: string, signature: string): Promise<WebhookResult>;
  /** Never throws. A receipt is a convenience and must not fail a page load. */
  resolveReceipt(paymentRef: string): Promise<string | null>;
}

const joinUrl = (baseUrl: string, path: string): string =>
  `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export const createPaymentsKernel = (config: PaymentsKernelConfig): PaymentsKernel => {
  if (!isSupportedCurrency(config.currency)) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { currency: config.currency, reason: 'unsupported_currency' },
    });
  }

  const registryOptions: RegistryOptions =
    config.resolveLegacyKind === undefined ? {} : { resolveLegacyKind: config.resolveLegacyKind };

  const registry = createPurchaseRegistry(config.purchases, registryOptions);

  /** Shared by the webhook and reconciliation paths — the whole point of the shared key. */
  const fulfillPayment = async (params: {
    readonly amountMinor: number;
    readonly currency: string;
    readonly eventId: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly payerEmail: string | null;
    readonly paymentRef: string;
    readonly receiptUrl?: string;
    readonly source: 'reconciliation' | 'webhook';
  }): Promise<{ kind: string; outcome: FulfillmentOutcome; result?: unknown }> => {
    const purchase = registry.resolve(params.metadata);
    const decoded = purchase.decodeMetadata(params.metadata);
    const effects = createEffectRunner(config.logger, `fulfill.${purchase.kind}`);

    const { outcome, result } = await runOnce({
      eventStore: config.eventStore,
      key: fulfillmentKey(params.paymentRef),
      logger: config.logger,
      work: async () => {
        const value = await purchase.fulfill({
          amountMinor: params.amountMinor,
          attempt: 1,
          currency: params.currency,
          effects,
          eventId: params.eventId,
          metadata: decoded,
          payerEmail: params.payerEmail,
          paymentRef: params.paymentRef,
          source: params.source,
          ...(params.receiptUrl === undefined ? {} : { receiptUrl: params.receiptUrl }),
        });

        /**
         * Wait for best-effort effects before releasing the claim. Otherwise a serverless runtime
         * can freeze the process the moment fulfillment resolves, dropping notifications that were
         * still in flight — a failure that is invisible locally and routine in production.
         */
        await effects.settled();

        return value;
      },
    });

    return { kind: purchase.kind, outcome, ...(result === undefined ? {} : { result }) };
  };

  const handleEvent = async (event: ProviderEvent): Promise<WebhookResult> => {
    if (event.kind === 'payment.succeeded') {
      const fulfilled = await fulfillPayment({
        amountMinor: event.amountMinor,
        currency: event.currency,
        eventId: event.id,
        metadata: event.metadata,
        payerEmail: event.payerEmail,
        paymentRef: event.paymentRef,
        source: 'webhook',
        ...(event.receiptUrl === undefined ? {} : { receiptUrl: event.receiptUrl }),
      });

      return {
        kind: fulfilled.kind,
        outcome: fulfilled.outcome,
        ...(fulfilled.result === undefined ? {} : { result: fulfilled.result }),
      };
    }

    if (event.kind === 'payment.refunded') {
      await config.onRefund?.({ paymentRef: event.paymentRef });
      return { kind: null, outcome: 'refunded' };
    }

    if (event.kind === 'receipt.updated') {
      await config.onReceipt?.({ paymentRef: event.paymentRef, receiptUrl: event.receiptUrl });
      return { kind: null, outcome: 'receipt' };
    }

    config.logger.info(`Ignored provider event ${event.providerType}`);

    return { kind: null, outcome: 'ignored' };
  };

  return {
    checkout: async <TInput, TMeta extends Record<string, MetadataValue>>(
      purchase: PurchaseDefinition<TInput, TMeta>,
      input: TInput
    ): Promise<CheckoutResult> => {
      const prepared = await purchase.prepare(input, {
        baseUrl: config.baseUrl,
        currency: config.currency,
      });

      const session = await config.provider.createCheckoutSession({
        cancelUrl: joinUrl(config.baseUrl, prepared.cancelPath),
        currency: config.currency,
        lineItems: prepared.lineItems,
        metadata: encodeMetadata(prepared.metadata, purchase.kind),
        successUrl: joinUrl(config.baseUrl, prepared.successPath),
        ...(prepared.payerEmail === undefined ? {} : { payerEmail: prepared.payerEmail }),
      });

      if (!session.url) {
        throw new PaymentError(PAYMENT_ERROR_CODES.SESSION_NOT_CREATED, {
          context: { kind: purchase.kind, sessionId: session.id },
        });
      }

      return {
        sessionId: session.id,
        url: session.url,
        ...(prepared.reference === undefined ? {} : { reference: prepared.reference }),
      };
    },

    confirm: async (sessionId: string): Promise<ConfirmResult> => {
      const session = await config.provider.retrieveCheckoutSession(sessionId);

      if (!session.paid || !session.paymentRef) {
        return {
          amountTotalMinor: session.amountTotalMinor,
          metadata: session.metadata,
          outcome: 'unpaid',
          paid: false,
          payerEmail: session.payerEmail,
          reference: null,
        };
      }

      const fulfilled = await fulfillPayment({
        amountMinor: session.amountTotalMinor ?? 0,
        currency: config.currency,
        eventId: `session:${session.id}`,
        metadata: session.metadata,
        payerEmail: session.payerEmail,
        paymentRef: session.paymentRef,
        source: 'reconciliation',
      });

      if (fulfilled.outcome === 'fulfilled') {
        config.logger.info(
          `Reconciled a payment the webhook had not delivered: session=${session.id}`
        );
      }

      return {
        amountTotalMinor: session.amountTotalMinor,
        metadata: session.metadata,
        outcome: fulfilled.outcome,
        paid: true,
        payerEmail: session.payerEmail,
        reference: session.paymentRef,
      };
    },

    /**
     * `async` on purpose, even though verification is synchronous: an async function converts a
     * synchronous throw into a rejected promise, so `handleWebhook(...).catch(...)` behaves the
     * same as `try { await handleWebhook(...) }`. Without it, the declared `Promise` return type
     * lies for exactly one error — an invalid signature — and a consumer chaining `.catch()` would
     * crash its request handler instead of answering 400.
     *
     * Verification is deliberately NOT wrapped in a try/catch. A `signature_invalid` must reach
     * the endpoint so it can answer 400; swallowing it would answer 200 to a forged request and,
     * worse, to a genuine one whose secret has drifted.
     */
    handleWebhook: async (rawBody: string, signature: string): Promise<WebhookResult> =>
      handleEvent(config.provider.verifyWebhook(rawBody, signature)),

    resolveReceipt: async (paymentRef: string): Promise<string | null> => {
      try {
        return await config.provider.resolveReceiptUrl(paymentRef);
      } catch (error) {
        config.logger.error(error, 'resolveReceipt');
        return null;
      }
    },
  };
};
