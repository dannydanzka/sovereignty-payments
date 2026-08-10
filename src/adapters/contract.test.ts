import { describe, expect, it } from 'vitest';

import { createStripeProvider } from './stripe';
import { createFakeProvider, signWebhookPayload } from '../testing';
import { PAYMENT_ERROR_CODES, type PaymentError } from '../core/errors';
import type { PaymentProvider } from '../core/types';

/**
 * The contract every adapter must satisfy.
 *
 * This file is the definition of "done" for a new provider. Claiming a library is agnostic while
 * only ever exercising one adapter is how provider-neutral abstractions quietly grow a dependence
 * on one provider's semantics; running the same assertions against two independent implementations
 * is what keeps the port honest.
 *
 * A case that cannot be expressed for every adapter does not belong here — it belongs in that
 * adapter's own suite.
 */

const WEBHOOK_SECRET = 'whsec_contract_secret';

interface AdapterUnderTest {
  readonly name: string;
  readonly provider: PaymentProvider;
  /** Produce a transport-valid webhook delivery carrying a successful payment. */
  signedSuccess(metadata: Record<string, string>): { rawBody: string; signature: string };
  /** Produce a delivery whose signature will not verify. */
  tamperedDelivery(): { rawBody: string; signature: string };
}

const stripeAdapter = (): AdapterUnderTest => {
  const provider = createStripeProvider({
    secretKey: 'sk_test_contract',
    webhookSecret: WEBHOOK_SECRET,
  });

  const sign = (body: string): string =>
    signWebhookPayload(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000));

  return {
    name: 'stripe',
    provider,
    signedSuccess: (metadata) => {
      const rawBody = JSON.stringify({
        data: { object: { amount: 1000, currency: 'mxn', id: 'pi_contract', metadata } },
        id: 'evt_contract',
        object: 'event',
        type: 'payment_intent.succeeded',
      });

      return { rawBody, signature: sign(rawBody) };
    },
    tamperedDelivery: () => {
      const rawBody = JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded' });
      return { rawBody: `${rawBody} `, signature: sign(rawBody) };
    },
  };
};

const fakeAdapter = (): AdapterUnderTest => {
  const metadataHolder: { current: Record<string, string> } = { current: {} };

  const provider: PaymentProvider = {
    ...createFakeProvider(),
    verifyWebhook: (rawBody, signature) => {
      if (signature !== 'valid') {
        const error = new Error('signature_invalid') as PaymentError;
        Object.assign(error, { code: PAYMENT_ERROR_CODES.SIGNATURE_INVALID, retryable: false });
        throw error;
      }

      return {
        amountMinor: 1000,
        currency: 'mxn',
        id: 'evt_contract',
        kind: 'payment.succeeded',
        metadata: metadataHolder.current,
        payerEmail: null,
        paymentRef: 'pi_contract',
      };
    },
  };

  return {
    name: 'fake',
    provider,
    signedSuccess: (metadata) => {
      metadataHolder.current = metadata;
      return { rawBody: '{}', signature: 'valid' };
    },
    tamperedDelivery: () => ({ rawBody: '{}', signature: 'invalid' }),
  };
};

describe.each([stripeAdapter(), fakeAdapter()])('provider contract — $name', (adapter) => {
  it('exposes a name for diagnostics', () => {
    expect(typeof adapter.provider.name).toBe('string');
    expect(adapter.provider.name.length).toBeGreaterThan(0);
  });

  it('normalizes a successful payment into the shared event shape', () => {
    const { rawBody, signature } = adapter.signedSuccess({ kind: 'demo', reference: 'ord_1' });

    const event = adapter.provider.verifyWebhook(rawBody, signature);

    expect(event.kind).toBe('payment.succeeded');
    if (event.kind !== 'payment.succeeded') return;

    // Metadata must survive the round trip untouched — it is the only channel that carries what
    // was bought from checkout time to fulfillment time, in a different process, minutes later.
    expect(event.metadata).toMatchObject({ kind: 'demo', reference: 'ord_1' });
    expect(event.paymentRef).toBeTruthy();
    expect(event.amountMinor).toBe(1000);
    expect(event.currency).toBe('mxn');
  });

  it('rejects a delivery whose signature does not verify', () => {
    const { rawBody, signature } = adapter.tamperedDelivery();

    try {
      adapter.provider.verifyWebhook(rawBody, signature);
      expect.unreachable('an unverifiable delivery must throw');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.SIGNATURE_INVALID);
      // Non-retryable everywhere: a signature that failed once fails identically forever.
      expect((error as PaymentError).retryable).toBe(false);
    }
  });

  it('verifies synchronously — no I/O may sit between reading the body and checking it', () => {
    const { rawBody, signature } = adapter.signedSuccess({ kind: 'demo' });

    const returned = adapter.provider.verifyWebhook(rawBody, signature) as unknown;

    expect(returned).not.toBeInstanceOf(Promise);
  });

  it('never throws when a receipt cannot be resolved', async () => {
    await expect(adapter.provider.resolveReceiptUrl('pi_missing')).resolves.not.toThrow();
  });
});
