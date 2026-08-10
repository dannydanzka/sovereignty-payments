import { PAYMENT_ERROR_CODES, PaymentError } from './errors';
import { KIND_KEY, type MetadataValue } from './metadata';
import type { EffectRunner } from './ports';
import type { LineItem } from './types';

export interface PrepareContext {
  readonly baseUrl: string;
  readonly currency: string;
}

export interface PreparedPurchase<TMeta> {
  /** Appended to `baseUrl`. Defaults are the consumer's job to supply, not the library's. */
  readonly cancelPath: string;
  readonly lineItems: readonly LineItem[];
  readonly metadata: TMeta;
  readonly payerEmail?: string;
  /** The consumer's own identifier, echoed back for convenience. Never interpreted. */
  readonly reference?: string;
  readonly successPath: string;
}

export interface FulfillContext<TMeta> {
  readonly amountMinor: number;
  /** 1 on first delivery. Greater means a retry got through — usually after a partial failure. */
  readonly attempt: number;
  readonly currency: string;
  readonly effects: EffectRunner;
  readonly eventId: string;
  readonly metadata: TMeta;
  readonly payerEmail: string | null;
  readonly paymentRef: string;
  readonly receiptUrl?: string;
  /**
   * Which path invoked fulfillment. The same handler serves both, which is precisely what gives
   * every purchase kind a fallback when a webhook never arrives — instead of writing that recovery
   * once per kind, as the consuming app did for exactly one of its four.
   */
  readonly source: 'reconciliation' | 'webhook';
}

export interface PurchaseDefinition<TInput, TMeta extends Record<string, MetadataValue>> {
  /**
   * Turn the string map that came back from the provider into the consumer's typed shape.
   * MUST throw (`PaymentError('metadata_invalid')`) on anything it cannot read — see
   * {@link ../core/metadata.decodeJsonField}.
   */
  decodeMetadata(raw: Readonly<Record<string, string>>): TMeta;
  /** Runs at most once per payment. The kernel guarantees that; the handler need not. */
  fulfill(context: FulfillContext<TMeta>): Promise<unknown>;
  /** The discriminator written into metadata and matched on the way back. */
  readonly kind: string;
  /** Price it and describe it. Runs before the provider is called. */
  prepare(input: TInput, context: PrepareContext): Promise<PreparedPurchase<TMeta>>;
}

/**
 * Identity function that exists purely for type inference: it lets a consumer write a definition
 * with full checking on its own metadata shape, without hand-writing the generic parameters.
 *
 * Note what this function does NOT do: it ships no purchase kinds, no defaults and no naming
 * conventions. `definePurchase` is the library's; the definitions are the product's (invariant 1).
 */
export const definePurchase = <TInput, TMeta extends Record<string, MetadataValue>>(
  definition: PurchaseDefinition<TInput, TMeta>
): PurchaseDefinition<TInput, TMeta> => definition;

/** Erased view used inside the kernel, where the concrete generics are not knowable. */
export type RegisteredPurchase = PurchaseDefinition<never, Record<string, MetadataValue>>;

export interface PurchaseRegistry {
  get(kind: string): RegisteredPurchase;
  /** Resolve which purchase kind an incoming metadata map belongs to. */
  resolve(raw: Readonly<Record<string, string>>): RegisteredPurchase;
}

export interface RegistryOptions {
  /**
   * Called ONLY when metadata carries no `kind`. The library ships no default here on purpose:
   * a legacy discriminator convention is the consuming product's history, and guessing at one
   * would silently route another product's payments to the wrong handler.
   */
  readonly resolveLegacyKind?: (raw: Readonly<Record<string, string>>) => string | undefined;
}

export const createPurchaseRegistry = (
  purchases: readonly RegisteredPurchase[],
  options: RegistryOptions = {}
): PurchaseRegistry => {
  const byKind = new Map<string, RegisteredPurchase>();

  for (const purchase of purchases) {
    if (byKind.has(purchase.kind)) {
      throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
        context: { kind: purchase.kind, reason: 'duplicate_purchase_kind' },
      });
    }
    byKind.set(purchase.kind, purchase);
  }

  const get = (kind: string): RegisteredPurchase => {
    const purchase = byKind.get(kind);

    if (!purchase) {
      throw new PaymentError(PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND, {
        context: { kind, known: [...byKind.keys()] },
      });
    }

    return purchase;
  };

  return {
    get,
    resolve: (raw: Readonly<Record<string, string>>): RegisteredPurchase => {
      const kind = raw[KIND_KEY] ?? options.resolveLegacyKind?.(raw);

      if (kind === undefined) {
        throw new PaymentError(PAYMENT_ERROR_CODES.UNKNOWN_PURCHASE_KIND, {
          context: { reason: 'no_kind_in_metadata' },
        });
      }

      return get(kind);
    },
  };
};
