import { describe, expect, it } from 'vitest';

import { PAYMENT_ERROR_CODES, PaymentError } from '../../core/errors';
import { signWebhookPayload } from '../../testing';
import { createStripeProvider } from './index';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests';
const SECRET_KEY = 'sk_test_key_for_unit_tests';

const provider = createStripeProvider({ secretKey: SECRET_KEY, webhookSecret: WEBHOOK_SECRET });

/**
 * Builds a genuinely signed payload — the same HMAC Stripe computes. No stubbing of crypto.
 *
 * The timestamp must be current: signature verification also enforces a replay window (300 s by
 * default), so a hard-coded date makes every test fail for the wrong reason.
 */
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const deliver = (event: Record<string, unknown>): ReturnType<typeof provider.verifyWebhook> => {
  const payload = JSON.stringify({ api_version: '2025-12-15.clover', object: 'event', ...event });

  return provider.verifyWebhook(payload, signWebhookPayload(payload, WEBHOOK_SECRET, nowSeconds()));
};

describe('stripe adapter — configuration', () => {
  it('refuses to construct without credentials', () => {
    expect(() => createStripeProvider({ secretKey: '', webhookSecret: WEBHOOK_SECRET })).toThrow(
      PaymentError
    );
    expect(() => createStripeProvider({ secretKey: SECRET_KEY, webhookSecret: '' })).toThrow(
      PaymentError
    );
  });

  it('identifies itself for diagnostics only', () => {
    expect(provider.name).toBe('stripe');
  });
});

describe('stripe adapter — webhook verification', () => {
  it('rejects a tampered body', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const signature = signWebhookPayload(payload, WEBHOOK_SECRET, nowSeconds());

    try {
      provider.verifyWebhook(`${payload} `, signature);
      expect.unreachable('a tampered body must not verify');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.SIGNATURE_INVALID);
      // Non-retryable on purpose: a bad signature is hostile input, not a transient fault.
      expect((error as PaymentError).retryable).toBe(false);
    }
  });

  it('rejects a signature made with the wrong secret', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

    expect(() =>
      provider.verifyWebhook(payload, signWebhookPayload(payload, 'whsec_wrong', nowSeconds()))
    ).toThrow(PaymentError);
  });

  it('rejects a correctly-signed but stale payload (replay protection)', () => {
    // Verification is not only "is this HMAC right" — it also bounds how old the signature may be,
    // so a captured request cannot be replayed later. Worth pinning: a consumer that reimplements
    // verification by comparing HMACs alone would silently lose this property.
    const payload = JSON.stringify({ id: 'evt_stale', type: 'payment_intent.succeeded' });
    const anHourAgo = nowSeconds() - 3_600;

    try {
      provider.verifyWebhook(payload, signWebhookPayload(payload, WEBHOOK_SECRET, anHourAgo));
      expect.unreachable('a stale signature must not verify');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.SIGNATURE_INVALID);
    }
  });
});

describe('stripe adapter — event normalization', () => {
  it('normalizes a successful payment, exposing metadata to the consumer', () => {
    const event = deliver({
      data: {
        object: {
          amount: 49950,
          currency: 'mxn',
          id: 'pi_123',
          metadata: { kind: 'demo_purchase', reference: 'ord_9' },
          receipt_email: 'payer@test.com',
        },
      },
      id: 'evt_ok',
      type: 'payment_intent.succeeded',
    });

    expect(event).toEqual({
      amountMinor: 49950,
      currency: 'mxn',
      id: 'evt_ok',
      kind: 'payment.succeeded',
      metadata: { kind: 'demo_purchase', reference: 'ord_9' },
      payerEmail: 'payer@test.com',
      paymentRef: 'pi_123',
    });
  });

  it('surfaces the receipt when the charge is already expanded', () => {
    const event = deliver({
      data: {
        object: {
          amount: 1000,
          currency: 'mxn',
          id: 'pi_456',
          latest_charge: { id: 'ch_1', receipt_url: 'https://receipt.test/1' },
          metadata: {},
        },
      },
      id: 'evt_receipt',
      type: 'payment_intent.succeeded',
    });

    expect(event).toMatchObject({
      kind: 'payment.succeeded',
      receiptUrl: 'https://receipt.test/1',
    });
  });

  it('normalizes a refund', () => {
    expect(
      deliver({
        data: { object: { id: 'ch_2', payment_intent: 'pi_789' } },
        id: 'evt_refund',
        type: 'charge.refunded',
      })
    ).toEqual({ id: 'evt_refund', kind: 'payment.refunded', paymentRef: 'pi_789' });
  });

  it('normalizes a late receipt', () => {
    expect(
      deliver({
        data: {
          object: { id: 'ch_3', payment_intent: 'pi_abc', receipt_url: 'https://receipt.test/2' },
        },
        id: 'evt_charge_updated',
        type: 'charge.updated',
      })
    ).toEqual({
      id: 'evt_charge_updated',
      kind: 'receipt.updated',
      paymentRef: 'pi_abc',
      receiptUrl: 'https://receipt.test/2',
    });
  });

  it('ignores an unrelated event instead of failing', () => {
    // Providers emit dozens of types. Erroring on the unrecognized ones would make the provider
    // retry forever; `ignored` lets the consumer answer 200 without claiming it handled anything.
    expect(
      deliver({ data: { object: { id: 'cus_1' } }, id: 'evt_other', type: 'customer.created' })
    ).toEqual({ id: 'evt_other', kind: 'ignored', providerType: 'customer.created' });
  });

  it('ignores a charge event that carries no payment reference', () => {
    expect(
      deliver({ data: { object: { id: 'ch_orphan' } }, id: 'evt_orphan', type: 'charge.refunded' })
    ).toMatchObject({ kind: 'ignored' });
  });
});
