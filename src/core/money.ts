import { PAYMENT_ERROR_CODES, PaymentError } from './errors';

/**
 * Money, in minor units.
 *
 * Every provider transacts in the currency's smallest unit, and the exponent is NOT universally 2.
 * MXN and USD are 1/100, JPY and KRW have no minor unit at all, and a handful of currencies use
 * 1/1000. Hard-coding `* 100` — as the consuming app does today in three places — is a bug waiting
 * for the first non-centesimal currency, and an invisible one: it overcharges by 100x rather than
 * failing.
 *
 * Only the exponents this library has been exercised against are listed. An unlisted currency
 * throws instead of guessing, per invariant 6 (no policy defaults).
 */
const CURRENCY_EXPONENTS: Record<string, number> = {
  bhd: 3,
  brl: 2,
  cad: 2,
  clp: 0,
  cop: 2,
  eur: 2,
  gbp: 2,
  jpy: 0,
  krw: 0,
  kwd: 3,
  mxn: 2,
  pen: 2,
  usd: 2,
};

export const isSupportedCurrency = (currency: string): boolean =>
  Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, currency.toLowerCase());

export const currencyExponent = (currency: string): number => {
  const exponent = CURRENCY_EXPONENTS[currency.toLowerCase()];

  if (exponent === undefined) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { currency, reason: 'unknown_currency' },
    });
  }

  return exponent;
};

/**
 * Convert a major-unit amount (what a price list shows: 499.5) into minor units (49950).
 *
 * Rounds half away from zero, matching how prices are quoted to payers. The rounding happens on
 * the scaled value precisely because floating point cannot represent 4.995 exactly — scaling first
 * and rounding second is what keeps 4.995 → 500 instead of 499.
 */
export const toMinorUnits = (amount: number, currency: string): number => {
  if (!Number.isFinite(amount)) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { amount, reason: 'amount_not_finite' },
    });
  }

  const factor = 10 ** currencyExponent(currency);
  const scaled = amount * factor;

  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
};

/** Inverse of {@link toMinorUnits}. Useful for rendering a provider amount back to the consumer. */
export const fromMinorUnits = (minor: number, currency: string): number => {
  if (!Number.isInteger(minor)) {
    throw new PaymentError(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID, {
      context: { minor, reason: 'minor_units_not_integer' },
    });
  }

  return minor / 10 ** currencyExponent(currency);
};
