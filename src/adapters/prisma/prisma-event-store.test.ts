/** The Prisma store keeps the kernel's idempotency contract: an atomic claim, a release on failure. */
import { describe, expect, it, vi } from 'vitest';

import { createPrismaPaymentEventStore } from './prisma-event-store';
import type { ProcessedPaymentEventDelegate } from './prisma-event-store';

const uniqueViolation = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

const delegateWith = (
  overrides: Partial<ProcessedPaymentEventDelegate> = {}
): ProcessedPaymentEventDelegate => ({
  create: vi.fn(() => Promise.resolve({})),
  delete: vi.fn(() => Promise.resolve({})),
  findUnique: vi.fn(() => Promise.resolve(null)),
  update: vi.fn(() => Promise.resolve({})),
  ...overrides,
});

describe('createPrismaPaymentEventStore', () => {
  it('claims a new event with one insert', async () => {
    const delegate = delegateWith();

    await expect(createPrismaPaymentEventStore(delegate).claim('payment:pi_1')).resolves.toBe(
      'claimed'
    );
    expect(delegate.create).toHaveBeenCalledWith({ data: { eventId: 'payment:pi_1' } });
    expect(delegate.findUnique).not.toHaveBeenCalled();
  });

  it('reads a duplicate as already processed or in flight', async () => {
    const done = delegateWith({
      create: () => Promise.reject(uniqueViolation),
      findUnique: () => Promise.resolve({ completedAt: new Date(0) }),
    });
    const running = delegateWith({
      create: () => Promise.reject(uniqueViolation),
      findUnique: () => Promise.resolve({ completedAt: null }),
    });

    await expect(createPrismaPaymentEventStore(done).claim('e')).resolves.toBe('already_processed');
    await expect(createPrismaPaymentEventStore(running).claim('e')).resolves.toBe('in_flight');
  });

  it('rethrows any other insert failure, logged', async () => {
    const failure = new Error('connection lost');
    const logger = { error: vi.fn() };
    const store = createPrismaPaymentEventStore(
      delegateWith({ create: () => Promise.reject(failure) }),
      logger
    );

    await expect(store.claim('e')).rejects.toBe(failure);
    expect(logger.error).toHaveBeenCalledWith(failure, 'paymentEventStore.claim');
    const plain = new Error('plain');
    await expect(
      createPrismaPaymentEventStore(delegateWith({ create: () => Promise.reject(plain) })).claim(
        'e'
      )
    ).rejects.toBe(plain);
  });

  it('completes with a timestamp and the result', async () => {
    const delegate = delegateWith();

    await createPrismaPaymentEventStore(delegate).complete('e', { orderId: 'o1' });

    expect(delegate.update).toHaveBeenCalledWith({
      data: { completedAt: expect.any(Date) as Date, result: { orderId: 'o1' } as never },
      where: { eventId: 'e' },
    });
  });

  it('releases the claim on failure so a retry can deliver, even if the delete fails', async () => {
    const logger = { error: vi.fn() };
    const delegate = delegateWith();
    await createPrismaPaymentEventStore(delegate, logger).fail('e', 'stock');
    expect(delegate.delete).toHaveBeenCalledWith({ where: { eventId: 'e' } });
    expect(logger.error).toHaveBeenCalledTimes(1);

    const deleteFailure = new Error('locked');
    const broken = createPrismaPaymentEventStore(
      delegateWith({ delete: () => Promise.reject(deleteFailure) }),
      logger
    );
    await broken.fail('e', 'stock');
    expect(logger.error).toHaveBeenCalledWith(deleteFailure, 'paymentEventStore.fail');

    await expect(
      createPrismaPaymentEventStore(delegateWith()).fail('e', 'x')
    ).resolves.toBeUndefined();
  });
});
