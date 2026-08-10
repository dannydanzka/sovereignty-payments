import { describe, expect, it, vi } from 'vitest';

import { createEffectRunner } from './effects';
import { PAYMENT_ERROR_CODES, PaymentError } from './errors';
import { fulfillmentKey, runOnce } from './idempotency';
import { decodeJsonField, encodeMetadata, KIND_KEY, requireField } from './metadata';
import { systemClock, type PaymentEventStore, type PaymentsLogger } from './ports';
import { createPurchaseRegistry, definePurchase, type RegisteredPurchase } from './registry';

const stubLogger = (): PaymentsLogger => ({ error: vi.fn(), info: vi.fn() });

describe('effects — best-effort side effects', () => {
  it('swallows a failing effect and logs it under a scoped label', async () => {
    // Once money is captured, refusing to deliver goods because a notification failed is strictly
    // worse than a missing notification.
    const logger = stubLogger();
    const effects = createEffectRunner(logger, 'fulfill.demo');
    const boom = new Error('mail server down');

    const value = await effects.best('notify', () => Promise.reject(boom));

    expect(value).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(boom, 'fulfill.demo.notify');
  });

  it('returns the value of an effect that succeeds', async () => {
    const effects = createEffectRunner(stubLogger(), 'scope');

    await expect(effects.best('ok', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('settles every started effect, including the failing ones', async () => {
    const logger = stubLogger();
    const effects = createEffectRunner(logger, 'scope');

    void effects.best('a', () => Promise.resolve('a'));
    void effects.best('b', () => Promise.reject(new Error('b')));

    await expect(effects.settled()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe('metadata — encoding', () => {
  it('stamps the kind and JSON-encodes nested values', () => {
    expect(encodeMetadata({ flag: true, items: ['a'], total: 10 }, 'demo')).toEqual({
      flag: 'true',
      items: '["a"]',
      kind: 'demo',
      total: '10',
    });
  });

  it('drops undefined instead of serializing the string "undefined"', () => {
    // "undefined" would decode back as a truthy string and be acted upon.
    expect(encodeMetadata({ absent: undefined, present: 'x' }, 'demo')).toEqual({
      kind: 'demo',
      present: 'x',
    });
  });

  it('refuses to let a consumer overwrite the reserved kind key', () => {
    try {
      encodeMetadata({ [KIND_KEY]: 'hijacked' }, 'demo');
      expect.unreachable('reserved key must be rejected');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID);
    }
  });
});

describe('metadata — decoding', () => {
  it('parses a JSON field', () => {
    expect(decodeJsonField<string[]>('["a","b"]', 'items')).toEqual(['a', 'b']);
  });

  it('throws non-retryably on malformed JSON rather than defaulting to empty', () => {
    // The defect this replaces: `JSON.parse(x || '[]')` inside a try/catch turned "we cannot read
    // what was bought" into "nothing was bought", with no error anywhere.
    try {
      decodeJsonField('not-json', 'items');
      expect.unreachable('malformed JSON must throw');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.METADATA_INVALID);
      expect((error as PaymentError).retryable).toBe(false);
    }
  });

  it('throws when a JSON field is absent', () => {
    expect(() => decodeJsonField(undefined, 'items')).toThrow(PaymentError);
  });

  it('requires a non-empty string field', () => {
    expect(requireField({ reference: 'ord_1' }, 'reference')).toBe('ord_1');
    expect(() => requireField({}, 'reference')).toThrow(PaymentError);
    expect(() => requireField({ reference: '' }, 'reference')).toThrow(PaymentError);
  });
});

describe('registry', () => {
  const demo = definePurchase<never, Record<string, string>>({
    decodeMetadata: (raw) => ({ ...raw }),
    fulfill: () => Promise.resolve(null),
    kind: 'demo',
    prepare: () =>
      Promise.resolve({ cancelPath: '/c', lineItems: [], metadata: {}, successPath: '/s' }),
  });

  const registry = createPurchaseRegistry([demo as unknown as RegisteredPurchase]);

  it('resolves by the kind stamped in metadata', () => {
    expect(registry.resolve({ kind: 'demo' }).kind).toBe('demo');
  });

  it('lists the known kinds when asked for an unregistered one', () => {
    try {
      registry.get('missing');
      expect.unreachable('unknown kind must throw');
    } catch (error) {
      expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND);
      expect((error as PaymentError).context).toMatchObject({ known: ['demo'] });
    }
  });

  it('refuses to guess when metadata carries no kind and no resolver was supplied', () => {
    // Invariant 6: the library ships no legacy convention of its own.
    expect(() => registry.resolve({ legacyType: 'old' })).toThrow(PaymentError);
  });
});

describe('idempotency', () => {
  const store = (claim: PaymentEventStore['claim']): PaymentEventStore => ({
    claim,
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
  });

  it('keys on the payment, not on the provider event', () => {
    expect(fulfillmentKey('pi_1')).toBe('payment:pi_1');
  });

  it('does nothing when another delivery of the same payment is in flight', async () => {
    // The in-flight run will either complete (this delivery was redundant) or fail and release the
    // claim (a later retry picks it up). Running concurrently would double-grant.
    const work = vi.fn();
    const result = await runOnce({
      eventStore: store(() => Promise.resolve('in_flight')),
      key: 'payment:pi_1',
      logger: stubLogger(),
      work,
    });

    expect(result.outcome).toBe('in_flight');
    expect(work).not.toHaveBeenCalled();
  });

  it('records the result when work succeeds', async () => {
    const eventStore = store(() => Promise.resolve('claimed'));
    const result = await runOnce({
      eventStore,
      key: 'payment:pi_2',
      logger: stubLogger(),
      work: () => Promise.resolve({ ok: true }),
    });

    expect(result).toEqual({ outcome: 'fulfilled', result: { ok: true } });
    expect(eventStore.complete).toHaveBeenCalledWith('payment:pi_2', { ok: true });
  });

  it('releases the claim and rethrows when work fails', async () => {
    const eventStore = store(() => Promise.resolve('claimed'));

    await expect(
      runOnce({
        eventStore,
        key: 'payment:pi_3',
        logger: stubLogger(),
        work: () => Promise.reject(new Error('boom')),
      })
    ).rejects.toThrow('boom');

    expect(eventStore.fail).toHaveBeenCalledWith('payment:pi_3', 'boom');
  });

  it('stringifies a non-Error rejection so the store always gets a message', async () => {
    const eventStore = store(() => Promise.resolve('claimed'));

    await expect(
      runOnce({
        eventStore,
        key: 'payment:pi_4',
        logger: stubLogger(),
        // Cast, not a lint suppression: the point of the case is a rejection that is not an Error.
        work: () => Promise.reject('a bare string' as unknown as Error),
      })
    ).rejects.toBeDefined();

    expect(eventStore.fail).toHaveBeenCalledWith('payment:pi_4', 'a bare string');
  });
});

describe('systemClock', () => {
  it('returns the current time', () => {
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});
