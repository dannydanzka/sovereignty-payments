import type { PaymentEventStore, PaymentsLogger } from './ports';

export type FulfillmentOutcome = 'duplicate' | 'fulfilled' | 'in_flight';

export interface RunOnceResult {
  readonly outcome: FulfillmentOutcome;
  readonly result?: unknown;
}

/**
 * The idempotency key is derived from the PAYMENT, not from the provider event id.
 *
 * This is the correction that makes reconciliation safe. A payment can be announced through more
 * than one channel: the provider's webhook (event `evt_A`), a duplicate delivery of that same
 * webhook (`evt_A` again), and the payer landing back on the success page, where the application
 * verifies the session directly and finds it paid. Keying on the event id guards only the second
 * case — the third arrives with no event id at all, or a different one, and would run fulfillment
 * a second time, granting twice what was paid for once.
 *
 * Keying on the payment reference states the actual invariant: **one fulfillment per payment**,
 * regardless of which channel noticed it first.
 */
export const fulfillmentKey = (paymentRef: string): string => `payment:${paymentRef}`;

/**
 * Run `work` at most once for a given key.
 *
 * On failure the claim is released, because a failed fulfillment that stays claimed is a payment
 * that can never complete — the worst resting state available. Releasing lets the provider's next
 * retry (they retry for days) find the work undone and do it.
 */
export const runOnce = async (params: {
  readonly eventStore: PaymentEventStore;
  readonly key: string;
  readonly logger: PaymentsLogger;
  readonly work: () => Promise<unknown>;
}): Promise<RunOnceResult> => {
  const claim = await params.eventStore.claim(params.key);

  if (claim === 'already_processed') {
    params.logger.info(`Skipped duplicate fulfillment for ${params.key}`);
    return { outcome: 'duplicate' };
  }

  if (claim === 'in_flight') {
    /**
     * Another delivery of the same payment is mid-flight. Returning without doing anything is
     * correct: the in-flight run will either complete (and this delivery was redundant) or fail
     * and release the claim (and a later retry will pick it up).
     */
    params.logger.info(`Fulfillment already in flight for ${params.key}`);
    return { outcome: 'in_flight' };
  }

  try {
    const result = await params.work();
    await params.eventStore.complete(params.key, result);

    return { outcome: 'fulfilled', result };
  } catch (error) {
    await params.eventStore.fail(params.key, error instanceof Error ? error.message : String(error));
    throw error;
  }
};
