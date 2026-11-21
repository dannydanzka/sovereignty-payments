import { PAYMENT_ERROR_CODES, PaymentError } from './errors';

/**
 * The one key this library owns inside the metadata map. Everything else belongs to the consumer.
 *
 * Metadata is the only channel that survives the round trip through the provider — the payer
 * leaves, pays, and the webhook arrives minutes later in a different process. Whatever fulfillment
 * needs to know has to be in here.
 */
export const KIND_KEY = 'kind';

export type MetadataValue =
  boolean | number | string | readonly unknown[] | Record<string, unknown>;

/**
 * Flatten a consumer's metadata into the string map every provider accepts.
 *
 * Objects and arrays are JSON-encoded, which is what the consuming app does by hand today for its
 * nested payloads. Doing it here removes the asymmetry that caused a real defect: the encode was
 * explicit (`JSON.stringify`) but the decode was a forgiving `JSON.parse(x || '[]')` inside a
 * try/catch, so corrupted metadata silently became an empty list instead of an error.
 *
 * `undefined` values are dropped rather than serialized to the string "undefined" — a value that
 * would later decode into a truthy string and be acted upon.
 */
export const encodeMetadata = (
  metadata: Readonly<Record<string, MetadataValue | undefined>>,
  kind: string
): Record<string, string> => {
  if (Object.prototype.hasOwnProperty.call(metadata, KIND_KEY)) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { key: KIND_KEY, kind, reason: 'reserved_metadata_key' },
    });
  }

  const encoded: Record<string, string> = { [KIND_KEY]: kind };

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;

    encoded[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  return encoded;
};

/**
 * Decode a JSON-encoded metadata field, loudly.
 *
 * Offered as a helper because the failure mode it prevents is the expensive one: a decoder that
 * swallows malformed input turns "we could not read what was bought" into "nothing was bought",
 * with no error anywhere. Throwing lets the kernel answer non-retryably and surface the payment
 * for a human instead of quietly under-delivering.
 */
export const decodeJsonField = <T>(raw: string | undefined, field: string): T => {
  if (raw === undefined) {
    throw new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID, {
      context: { field, reason: 'missing' },
    });
  }

  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID, {
      cause,
      context: { field, reason: 'malformed_json' },
    });
  }
};

/** Read a required string field, throwing the same non-retryable error on absence. */
export const requireField = (raw: Readonly<Record<string, string>>, field: string): string => {
  const value = raw[field];

  if (value === undefined || value === '') {
    throw new PaymentError(PAYMENT_ERROR_CODES.METADATA_INVALID, {
      context: { field, reason: 'missing' },
    });
  }

  return value;
};
