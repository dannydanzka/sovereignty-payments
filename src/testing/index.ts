import crypto from 'node:crypto';

import type { EventClaim, PaymentEventStore, PaymentsLogger } from '../core/ports';
import type {
  PaymentProvider,
  ProviderCheckoutInput,
  ProviderEvent,
  ProviderSession,
} from '../core/types';

/**
 * Sign a payload exactly as Stripe does: HMAC-SHA256 over `${timestamp}.${payload}`.
 *
 * This exists so a consumer's end-to-end suite can exercise the REAL webhook route, signature
 * verification included, without depending on `stripe listen` or any network. Testing the route
 * with verification stubbed out would leave the single most security-sensitive line uncovered.
 */
export const signWebhookPayload = (payload: string, secret: string, timestamp: number): string => {
  const signedPayload = `${String(timestamp)}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  return `t=${String(timestamp)},v1=${signature}`;
};

/** In-memory {@link PaymentEventStore}. Atomic by virtue of the single-threaded event loop. */
export const createInMemoryEventStore = (): PaymentEventStore & {
  readonly seen: Map<string, EventClaim>;
} => {
  const seen = new Map<string, EventClaim>();

  return {
    claim: (eventId: string): Promise<EventClaim> => {
      const current = seen.get(eventId);
      if (current === 'already_processed') return Promise.resolve('already_processed');
      if (current === 'in_flight') return Promise.resolve('in_flight');
      seen.set(eventId, 'in_flight');
      return Promise.resolve('claimed');
    },
    complete: (eventId: string): Promise<void> => {
      seen.set(eventId, 'already_processed');
      return Promise.resolve();
    },
    fail: (eventId: string): Promise<void> => {
      seen.delete(eventId);
      return Promise.resolve();
    },
    seen,
  };
};

export const silentLogger: PaymentsLogger = { error: () => undefined, info: () => undefined };

export interface FakeProviderOptions {
  readonly event?: ProviderEvent;
  readonly receiptUrl?: string | null;
  readonly session?: Partial<ProviderSession>;
}

/**
 * A provider that records what it was asked to do.
 *
 * Used to prove the kernel is genuinely provider-agnostic: the same contract suite runs against
 * this fake and against the Stripe adapter. An adapter is "done" when it passes both.
 */
export const createFakeProvider = (
  options: FakeProviderOptions = {}
): PaymentProvider & { readonly checkoutCalls: ProviderCheckoutInput[] } => {
  const checkoutCalls: ProviderCheckoutInput[] = [];

  const buildSession = (input?: ProviderCheckoutInput): ProviderSession => ({
    amountTotalMinor:
      input?.lineItems.reduce(
        (sum, item) => sum + item.unitAmountMinor * (item.quantity ?? 1),
        0
      ) ?? null,
    id: 'sess_fake',
    metadata: input?.metadata ?? {},
    paid: false,
    payerEmail: null,
    paymentRef: 'ref_fake',
    url: 'https://fake.test/checkout',
    ...options.session,
  });

  return {
    checkoutCalls,
    createCheckoutSession: (input: ProviderCheckoutInput): Promise<ProviderSession> => {
      checkoutCalls.push(input);
      return Promise.resolve(buildSession(input));
    },
    name: 'fake',
    resolveReceiptUrl: (): Promise<string | null> => Promise.resolve(options.receiptUrl ?? null),
    retrieveCheckoutSession: (): Promise<ProviderSession> => Promise.resolve(buildSession()),
    verifyWebhook: (): ProviderEvent =>
      options.event ?? { id: 'evt_fake', kind: 'ignored', providerType: 'unknown' },
  };
};
