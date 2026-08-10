import type { EffectRunner, PaymentsLogger } from './ports';

/**
 * Side effects that must never fail a payment.
 *
 * Once money is captured, fulfillment cannot be all-or-nothing. If a confirmation notification
 * throws, the payer must still receive what they bought — the alternative is refusing to deliver
 * goods because an email server was down, which is strictly worse than a missing email.
 *
 * The consuming app expresses this today by scattering `.catch(err => log(err))` across roughly
 * ten call sites. Centralizing it makes the intent explicit, gives every swallowed failure the
 * same shape in the logs, and provides `settled()` so tests can assert on effects that would
 * otherwise still be in flight when the assertion runs.
 */
export const createEffectRunner = (logger: PaymentsLogger, scope: string): EffectRunner => {
  const started: Promise<unknown>[] = [];

  return {
    best: <T>(label: string, effect: () => Promise<T>): Promise<T | undefined> => {
      const guarded = effect().catch((error: unknown) => {
        logger.error(error, `${scope}.${label}`);
        return undefined;
      });

      started.push(guarded);

      return guarded;
    },
    settled: async (): Promise<void> => {
      // `best` already neutralizes rejections, so this can never reject either.
      await Promise.all(started);
    },
  };
};
