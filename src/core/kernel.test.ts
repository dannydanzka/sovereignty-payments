import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeProvider, createInMemoryEventStore, silentLogger } from '../testing';
import { PAYMENT_ERROR_CODES, PaymentError } from './errors';
import { createPaymentsKernel } from './kernel';
import { decodeJsonField, requireField } from './metadata';
import { definePurchase, type RegisteredPurchase } from './registry';
import { toMinorUnits } from './money';

/**
 * A deliberately generic purchase. The library must never know what is being sold, so the fixture
 * sells "items" — the point is to prove the kernel works without a domain.
 */
interface DemoMetadata extends Record<string, string | readonly string[]> {
  readonly extras: readonly string[];
  readonly reference: string;
}

const fulfilled: DemoMetadata[] = [];

const demoPurchase = definePurchase<{ price: number; reference: string }, DemoMetadata>({
  decodeMetadata: (raw) => ({
    extras: decodeJsonField<string[]>(raw['extras'], 'extras'),
    reference: requireField(raw, 'reference'),
  }),
  fulfill: (context) => {
    fulfilled.push(context.metadata);
    return Promise.resolve({ recorded: context.metadata.reference });
  },
  kind: 'demo_purchase',
  prepare: (input, context) =>
    Promise.resolve({
      cancelPath: '/cancelled',
      lineItems: [{ name: 'Item', unitAmountMinor: toMinorUnits(input.price, context.currency) }],
      metadata: { extras: ['a', 'b'], reference: input.reference },
      reference: input.reference,
      successPath: '/done',
    }),
});

const buildKernel = (
  overrides: Partial<Parameters<typeof createPaymentsKernel>[0]> = {},
  provider = createFakeProvider()
): { eventStore: ReturnType<typeof createInMemoryEventStore>; kernel: ReturnType<typeof createPaymentsKernel> } => {
  const eventStore = createInMemoryEventStore();

  const kernel = createPaymentsKernel({
    baseUrl: 'https://app.test/',
    currency: 'mxn',
    eventStore,
    logger: silentLogger,
    provider,
    purchases: [demoPurchase],
    ...overrides,
  });

  return { eventStore, kernel };
};

const succeededEvent = (metadata: Record<string, string>, id = 'evt_1', paymentRef = 'pi_1') =>
  ({
    amountMinor: 49950,
    currency: 'mxn',
    id,
    kind: 'payment.succeeded' as const,
    metadata,
    payerEmail: 'payer@test.com',
    paymentRef,
  });

const VALID_METADATA = { extras: '["a","b"]', kind: 'demo_purchase', reference: 'ord_1' };

beforeEach(() => {
  fulfilled.length = 0;
});

describe('kernel — configuration', () => {
  it('refuses an unsupported currency instead of assuming an exponent', () => {
    expect(() => buildKernel({ currency: 'xyz' })).toThrow(PaymentError);
  });

  it('refuses two purchases claiming the same kind', () => {
    expect(() =>
      buildKernel({ purchases: [demoPurchase, demoPurchase] as unknown as RegisteredPurchase[] })
    ).toThrow(PaymentError);
  });
});

describe('kernel — checkout', () => {
  it('builds absolute URLs from the base once, and stamps the kind into metadata', async () => {
    const provider = createFakeProvider();
    const { kernel } = buildKernel({}, provider);

    const result = await kernel.checkout(demoPurchase, { price: 499.5, reference: 'ord_1' });

    expect(result).toEqual({
      reference: 'ord_1',
      sessionId: 'sess_fake',
      url: 'https://fake.test/checkout',
    });

    const call = provider.checkoutCalls[0];
    expect(call?.cancelUrl).toBe('https://app.test/cancelled');
    expect(call?.successUrl).toBe('https://app.test/done');
    expect(call?.lineItems[0]?.unitAmountMinor).toBe(49950);
    // Nested values are JSON-encoded on the way out so the decoder can be strict on the way back.
    expect(call?.metadata).toEqual({ extras: '["a","b"]', kind: 'demo_purchase', reference: 'ord_1' });
  });

  it('fails loudly when the provider returns no redirect URL', async () => {
    const provider = createFakeProvider({ session: { url: null } });
    const { kernel } = buildKernel({}, provider);

    await expect(kernel.checkout(demoPurchase, { price: 10, reference: 'x' })).rejects.toMatchObject({
      code: PAYMENT_ERROR_CODES.SESSION_NOT_CREATED,
    });
  });
});

describe('kernel — webhook fulfillment', () => {
  it('fulfills a successful payment with typed metadata', async () => {
    const provider = createFakeProvider({ event: succeededEvent(VALID_METADATA) });
    const { kernel } = buildKernel({}, provider);

    const result = await kernel.handleWebhook('{}', 'sig');

    expect(result).toMatchObject({ kind: 'demo_purchase', outcome: 'fulfilled' });
    expect(fulfilled).toEqual([{ extras: ['a', 'b'], reference: 'ord_1' }]);
  });

  it('runs fulfillment exactly once when the provider delivers the same payment twice', async () => {
    // Providers deliver duplicates as a matter of routine. This is the guarantee that three of the
    // consuming app's four purchase flows did not have.
    const provider = createFakeProvider({ event: succeededEvent(VALID_METADATA) });
    const { kernel } = buildKernel({}, provider);

    await kernel.handleWebhook('{}', 'sig');
    const second = await kernel.handleWebhook('{}', 'sig');

    expect(second.outcome).toBe('duplicate');
    expect(fulfilled).toHaveLength(1);
  });

  it('deduplicates across DIFFERENT event ids for the same payment', async () => {
    // The key is the payment, not the event. A provider that re-issues an event under a new id —
    // a manual replay from a dashboard, or a resend after an endpoint change — would otherwise
    // fulfill a second time. The two deliveries below share `pi_same` and nothing else.
    const eventStore = createInMemoryEventStore();

    const first = buildKernel(
      { eventStore },
      createFakeProvider({ event: succeededEvent(VALID_METADATA, 'evt_A', 'pi_same') })
    ).kernel;
    const second = buildKernel(
      { eventStore },
      createFakeProvider({ event: succeededEvent(VALID_METADATA, 'evt_B', 'pi_same') })
    ).kernel;

    expect((await first.handleWebhook('{}', 'sig')).outcome).toBe('fulfilled');
    expect((await second.handleWebhook('{}', 'sig')).outcome).toBe('duplicate');
    expect(fulfilled).toHaveLength(1);
  });

  it('rejects undecodable metadata loudly instead of fulfilling a guess', async () => {
    const provider = createFakeProvider({
      event: succeededEvent({ extras: 'not-json', kind: 'demo_purchase', reference: 'ord_1' }),
    });
    const { kernel } = buildKernel({}, provider);

    await expect(kernel.handleWebhook('{}', 'sig')).rejects.toMatchObject({
      code: PAYMENT_ERROR_CODES.METADATA_INVALID,
      retryable: false,
    });
    expect(fulfilled).toHaveLength(0);
  });

  it('rejects an unregistered purchase kind', async () => {
    const provider = createFakeProvider({ event: succeededEvent({ kind: 'other_kind' }) });
    const { kernel } = buildKernel({}, provider);

    await expect(kernel.handleWebhook('{}', 'sig')).rejects.toMatchObject({
      code: PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND,
    });
  });

  it('routes metadata without a kind through the consumer-supplied legacy resolver', async () => {
    // The library ships no legacy convention of its own; the consumer owns its history.
    const provider = createFakeProvider({
      event: succeededEvent({ extras: '[]', legacyType: 'old', reference: 'ord_2' }),
    });
    const { kernel } = buildKernel({ resolveLegacyKind: () => 'demo_purchase' }, provider);

    expect((await kernel.handleWebhook('{}', 'sig')).outcome).toBe('fulfilled');
  });

  it('releases the claim when fulfillment fails, so a retry can succeed', async () => {
    const failing = definePurchase<never, DemoMetadata>({
      ...demoPurchase,
      fulfill: vi
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce({ ok: true }),
    });

    const provider = createFakeProvider({ event: succeededEvent(VALID_METADATA) });
    const { kernel } = buildKernel({ purchases: [failing] }, provider);

    await expect(kernel.handleWebhook('{}', 'sig')).rejects.toThrow('transient');
    // A failed fulfillment that stayed claimed would be a payment that can never complete.
    expect((await kernel.handleWebhook('{}', 'sig')).outcome).toBe('fulfilled');
  });

  it('answers ignored for provider events it does not act on', async () => {
    const { kernel } = buildKernel({}, createFakeProvider());

    expect((await kernel.handleWebhook('{}', 'sig')).outcome).toBe('ignored');
  });

  it('does not swallow a signature failure', async () => {
    const provider = {
      ...createFakeProvider(),
      verifyWebhook: () => {
        throw new PaymentError(PAYMENT_ERROR_CODES.SIGNATURE_INVALID);
      },
    };
    const { kernel } = buildKernel({}, provider);

    await expect(kernel.handleWebhook('{}', 'bad')).rejects.toMatchObject({
      code: PAYMENT_ERROR_CODES.SIGNATURE_INVALID,
    });
  });

  it('delegates refunds and late receipts by payment reference', async () => {
    const onRefund = vi.fn().mockResolvedValue(undefined);
    const onReceipt = vi.fn().mockResolvedValue(undefined);

    const refundKernel = buildKernel(
      { onReceipt, onRefund },
      createFakeProvider({ event: { id: 'evt_r', kind: 'payment.refunded', paymentRef: 'pi_9' } })
    ).kernel;
    expect((await refundKernel.handleWebhook('{}', 'sig')).outcome).toBe('refunded');
    expect(onRefund).toHaveBeenCalledWith({ paymentRef: 'pi_9' });

    const receiptKernel = buildKernel(
      { onReceipt, onRefund },
      createFakeProvider({
        event: { id: 'evt_c', kind: 'receipt.updated', paymentRef: 'pi_9', receiptUrl: 'https://r.test' },
      })
    ).kernel;
    expect((await receiptKernel.handleWebhook('{}', 'sig')).outcome).toBe('receipt');
    expect(onReceipt).toHaveBeenCalledWith({ paymentRef: 'pi_9', receiptUrl: 'https://r.test' });
  });
});

describe('kernel — reconciliation', () => {
  it('reports an unpaid session without fulfilling', async () => {
    const { kernel } = buildKernel({}, createFakeProvider({ session: { paid: false } }));

    expect(await kernel.confirm('sess_1')).toEqual({ outcome: 'unpaid', paid: false, reference: null });
    expect(fulfilled).toHaveLength(0);
  });

  it('fulfills a paid session the webhook never delivered', async () => {
    // This is the fallback that only one of the consuming app's four flows had. Every kind gets it.
    const provider = createFakeProvider({
      session: { metadata: VALID_METADATA, paid: true, paymentRef: 'pi_2' },
    });
    const { kernel } = buildKernel({}, provider);

    const result = await kernel.confirm('sess_2');

    expect(result).toEqual({ outcome: 'fulfilled', paid: true, reference: 'pi_2' });
    expect(fulfilled).toHaveLength(1);
  });

  it('does not double-fulfill when the webhook already handled the same payment', async () => {
    // The webhook and the return path share one idempotency key: whichever arrives first wins.
    const eventStore = createInMemoryEventStore();

    const webhookProvider = createFakeProvider({ event: succeededEvent(VALID_METADATA, 'evt_x', 'pi_3') });
    const { kernel: viaWebhook } = buildKernel({ eventStore }, webhookProvider);
    await viaWebhook.handleWebhook('{}', 'sig');

    const returnProvider = createFakeProvider({
      session: { metadata: VALID_METADATA, paid: true, paymentRef: 'pi_3' },
    });
    const { kernel: viaReturn } = buildKernel({ eventStore }, returnProvider);

    expect((await viaReturn.confirm('sess_3')).outcome).toBe('duplicate');
    expect(fulfilled).toHaveLength(1);
  });
});

describe('kernel — receipts', () => {
  it('returns null instead of throwing when the provider fails', async () => {
    const provider = {
      ...createFakeProvider(),
      resolveReceiptUrl: () => Promise.reject(new Error('provider down')),
    };
    const { kernel } = buildKernel({}, provider);

    expect(await kernel.resolveReceipt('pi_1')).toBeNull();
  });
});
