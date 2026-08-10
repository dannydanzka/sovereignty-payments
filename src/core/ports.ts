/**
 * Ports the consuming application implements.
 *
 * The library is deliberately almost stateless. It owns exactly two effects of its own —
 * remembering which provider events it already processed, and logging — and nothing else.
 * Ledgers, orders, grants and receipts are the consumer's accounting (invariant 3).
 */

export type EventClaim = 'already_processed' | 'claimed' | 'in_flight';

/**
 * Idempotency, expressed as a claim on a provider event id.
 *
 * Providers deliver duplicates as a matter of routine, not as an anomaly: retries after a slow
 * response, at-least-once delivery, and manual replays all produce a second copy of an event that
 * was already honored. Without a claim, the second copy runs fulfillment again — granting twice
 * what was paid for once.
 *
 * `claim` MUST be atomic. The natural implementation is an insert on a primary key with the event
 * id, treating a unique-violation as `already_processed`; a read-then-write check reopens exactly
 * the race it is meant to close.
 */
export interface PaymentEventStore {
  /** `claimed` → the caller owns this event and must run fulfillment. Anything else → skip. */
  claim(eventId: string): Promise<EventClaim>;
  complete(eventId: string, result: unknown): Promise<void>;
  /**
   * Release the claim so a provider retry can be honored. A failed fulfillment that stays claimed
   * is a payment that can never complete — the worst possible resting state.
   */
  fail(eventId: string, error: string): Promise<void>;
}

export interface PaymentsLogger {
  error(error: unknown, context: string): void;
  info(message: string): void;
}

/** Injected so tests can freeze time without patching globals. */
export interface PaymentsClock {
  now(): Date;
}

export const systemClock: PaymentsClock = { now: () => new Date() };

/**
 * Runs side effects that must never fail the payment.
 *
 * After money is captured, fulfillment is not allowed to be all-or-nothing: if a confirmation
 * notification throws, the buyer must still receive what they bought. The consuming app expresses
 * this today by scattering `.catch(err => log(err))` at roughly ten call sites; centralizing it
 * makes the intent explicit and the failures uniformly observable.
 */
export interface EffectRunner {
  /** Fire-and-collect. Rejections are logged and swallowed, never propagated. */
  best<T>(label: string, effect: () => Promise<T>): Promise<T | undefined>;
  /** Resolves once every effect started through `best` has settled. */
  settled(): Promise<void>;
}
