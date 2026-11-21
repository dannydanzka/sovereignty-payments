import type { EventClaim, PaymentEventStore, PaymentsLogger } from '../../core/ports';

/** Prisma's unique-constraint violation: the claim row already exists. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * The slice of a Prisma model delegate the store needs, typed structurally so this module never
 * imports `@prisma/client`: each product generates its own client, and the library must not pin it.
 * The model is `ProcessedPaymentEvent` (schema in the README).
 */
export interface ProcessedPaymentEventDelegate {
  create: (args: { data: { eventId: string } }) => Promise<unknown>;
  delete: (args: { where: { eventId: string } }) => Promise<unknown>;
  findUnique: (args: {
    select: { completedAt: true };
    where: { eventId: string };
  }) => Promise<{ completedAt: Date | null } | null>;
  update: (args: {
    data: { completedAt: Date; result: never };
    where: { eventId: string };
  }) => Promise<unknown>;
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;

/**
 * `claim` is an insert whose unique violation means "someone else has it" — never a read followed
 * by a write, which reopens the race it exists to close: providers deliver duplicates routinely.
 */
export const createPrismaPaymentEventStore = (
  delegate: ProcessedPaymentEventDelegate,
  logger?: Pick<PaymentsLogger, 'error'>
): PaymentEventStore => ({
  claim: async (eventId): Promise<EventClaim> => {
    try {
      await delegate.create({ data: { eventId } });
      return 'claimed';
    } catch (error) {
      if (!isUniqueViolation(error)) {
        logger?.error(error, 'paymentEventStore.claim');
        throw error;
      }
      const existing = await delegate.findUnique({
        select: { completedAt: true },
        where: { eventId },
      });
      return existing?.completedAt ? 'already_processed' : 'in_flight';
    }
  },

  complete: async (eventId, result) => {
    await delegate.update({
      data: { completedAt: new Date(), result: result as never },
      where: { eventId },
    });
  },

  /**
   * Deleted, not marked failed: a claimed-but-unfinished row blocks every retry, leaving money
   * captured and nothing able to deliver it. Deleting lets the provider's next retry do the work.
   */
  fail: async (eventId, error) => {
    try {
      await delegate.delete({ where: { eventId } });
    } catch (deleteError) {
      logger?.error(deleteError, 'paymentEventStore.fail');
    }
    logger?.error(
      new Error(`payment fulfillment failed for ${eventId}: ${error}`),
      'paymentEventStore'
    );
  },
});
