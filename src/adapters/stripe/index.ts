import Stripe from 'stripe';

import { PAYMENT_ERROR_CODES, PaymentError } from '../../core/errors';
import type {
  PaymentProvider,
  ProviderCheckoutInput,
  ProviderEvent,
  ProviderSession,
} from '../../core/types';

export interface StripeProviderConfig {
  /**
   * Technical pin, not a policy default: the API version this adapter's response mapping has been
   * tested against. Overridable so a consumer can move ahead of the library when it needs to.
   */
  readonly apiVersion?: string;
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** Escape hatch for tests and for consumers that already hold a configured client. */
  readonly client?: Stripe;
}

const TESTED_API_VERSION = '2025-12-15.clover';

/** Stripe returns expandable fields as either an id or the expanded object. */
const idOf = (value: string | { id: string } | null | undefined): string | null => {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
};

const toSession = (session: Stripe.Checkout.Session): ProviderSession => ({
  amountTotalMinor: session.amount_total,
  id: session.id,
  metadata: session.metadata ?? {},
  /**
   * Both conditions are required. `payment_status === 'paid'` alone is true for sessions that are
   * still open in some flows, and `status === 'complete'` alone is true for zero-amount or
   * unpaid-but-finished sessions. Consumers must never have to remember this.
   */
  paid: session.payment_status === 'paid' && session.status === 'complete',
  payerEmail: session.customer_details?.email ?? null,
  paymentRef: idOf(session.payment_intent),
  url: session.url,
});

const receiptUrlOf = (intent: Stripe.PaymentIntent): string | undefined => {
  const charge = intent.latest_charge;
  return typeof charge === 'object' && charge !== null
    ? (charge.receipt_url ?? undefined)
    : undefined;
};

const toEvent = (event: Stripe.Event): ProviderEvent => {
  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const receiptUrl = receiptUrlOf(intent);

    return {
      amountMinor: intent.amount,
      currency: intent.currency,
      id: event.id,
      kind: 'payment.succeeded',
      metadata: intent.metadata,
      payerEmail: intent.receipt_email ?? null,
      paymentRef: intent.id,
      ...(receiptUrl === undefined ? {} : { receiptUrl }),
    };
  }

  if (event.type === 'charge.refunded') {
    const paymentRef = idOf(event.data.object.payment_intent);
    if (paymentRef) return { id: event.id, kind: 'payment.refunded', paymentRef };
  }

  if (event.type === 'charge.updated') {
    const charge = event.data.object;
    const paymentRef = idOf(charge.payment_intent);
    if (paymentRef && charge.receipt_url) {
      return { id: event.id, kind: 'receipt.updated', paymentRef, receiptUrl: charge.receipt_url };
    }
  }

  return { id: event.id, kind: 'ignored', providerType: event.type };
};

/** Anything Stripe throws is an outage from the kernel's point of view — never a payer error. */
const asProviderFailure = (cause: unknown, operation: string): PaymentError =>
  new PaymentError(PAYMENT_ERROR_CODES.PROVIDER_UNAVAILABLE, { cause, context: { operation } });

export const createStripeProvider = (config: StripeProviderConfig): PaymentProvider => {
  if (!config.secretKey || !config.webhookSecret) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { reason: 'missing_stripe_credentials' },
    });
  }

  const client =
    config.client ??
    new Stripe(config.secretKey, {
      apiVersion: (config.apiVersion ?? TESTED_API_VERSION) as Stripe.LatestApiVersion,
      typescript: true,
    });

  return {
    createCheckoutSession: async (input: ProviderCheckoutInput): Promise<ProviderSession> => {
      let session: Stripe.Checkout.Session;

      try {
        session = await client.checkout.sessions.create({
          cancel_url: input.cancelUrl,
          line_items: input.lineItems.map((item) => ({
            price_data: {
              currency: input.currency,
              product_data: {
                name: item.name,
                ...(item.description === undefined ? {} : { description: item.description }),
              },
              unit_amount: item.unitAmountMinor,
            },
            quantity: item.quantity ?? 1,
          })),
          metadata: { ...input.metadata },
          mode: 'payment',
          /**
           * Mirrored onto the payment intent on purpose. Webhooks for `payment_intent.*` carry the
           * intent's metadata, not the session's — without this copy the fulfillment handler
           * receives an empty map and cannot tell what was bought.
           */
          payment_intent_data: { metadata: { ...input.metadata } },
          success_url: input.successUrl,
          ...(input.payerEmail === undefined ? {} : { customer_email: input.payerEmail }),
        });
      } catch (cause) {
        throw asProviderFailure(cause, 'createCheckoutSession');
      }

      if (!session.url) {
        throw new PaymentError(PAYMENT_ERROR_CODES.SESSION_NOT_CREATED, {
          context: { sessionId: session.id },
        });
      }

      return toSession(session);
    },

    name: 'stripe',

    resolveReceiptUrl: async (paymentRef: string): Promise<string | null> => {
      /**
       * Best-effort by contract. A receipt is a convenience, and Stripe generates it
       * asynchronously — a missing one must never fail the caller's page load.
       */
      try {
        const intent = await client.paymentIntents.retrieve(paymentRef);
        const chargeId = idOf(intent.latest_charge);
        if (!chargeId) return null;

        const charge = await client.charges.retrieve(chargeId);
        return charge.receipt_url ?? null;
      } catch {
        return null;
      }
    },

    retrieveCheckoutSession: async (sessionId: string): Promise<ProviderSession> => {
      try {
        const session = await client.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent', 'payment_intent.latest_charge'],
        });
        return toSession(session);
      } catch (cause) {
        throw asProviderFailure(cause, 'retrieveCheckoutSession');
      }
    },

    verifyWebhook: (rawBody: string, signature: string): ProviderEvent => {
      try {
        return toEvent(client.webhooks.constructEvent(rawBody, signature, config.webhookSecret));
      } catch (cause) {
        throw new PaymentError(PAYMENT_ERROR_CODES.SIGNATURE_INVALID, { cause });
      }
    },
  };
};

export { receiptUrlOf as __receiptUrlOf, toEvent as __toEvent, toSession as __toSession };
