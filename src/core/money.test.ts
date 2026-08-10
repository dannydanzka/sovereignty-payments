import { describe, expect, it } from 'vitest';

import { PAYMENT_ERROR_CODES, PaymentError } from './errors';
import { currencyExponent, fromMinorUnits, isSupportedCurrency, toMinorUnits } from './money';

describe('money', () => {
  describe('toMinorUnits', () => {
    it('scales a centesimal currency', () => {
      expect(toMinorUnits(499.5, 'mxn')).toBe(49950);
    });

    it('does not scale a zero-exponent currency', () => {
      // The reason this library exists instead of `Math.round(x * 100)`: JPY has no minor unit,
      // so multiplying by 100 would overcharge a payer one hundredfold.
      expect(toMinorUnits(1200, 'jpy')).toBe(1200);
    });

    it('scales a three-exponent currency', () => {
      expect(toMinorUnits(1.234, 'kwd')).toBe(1234);
    });

    it('rounds half away from zero after scaling, not before', () => {
      // 4.995 is not representable in binary floating point; rounding the scaled value is what
      // keeps this at 500 rather than 499.
      expect(toMinorUnits(4.995, 'usd')).toBe(500);
      expect(toMinorUnits(-4.995, 'usd')).toBe(-500);
    });

    it('is case-insensitive about the currency code', () => {
      expect(toMinorUnits(10, 'MXN')).toBe(1000);
    });

    it('rejects a non-finite amount instead of producing NaN', () => {
      expect(() => toMinorUnits(Number.NaN, 'mxn')).toThrow(PaymentError);
      expect(() => toMinorUnits(Number.POSITIVE_INFINITY, 'mxn')).toThrow(PaymentError);
    });

    it('rejects an unknown currency rather than guessing an exponent', () => {
      // Invariant 6: absent configuration is an error, never a default.
      try {
        toMinorUnits(10, 'xyz');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PaymentError);
        expect((error as PaymentError).code).toBe(PAYMENT_ERROR_CODES.CONFIGURATION_INVALID);
      }
    });
  });

  describe('fromMinorUnits', () => {
    it('inverts toMinorUnits', () => {
      expect(fromMinorUnits(49950, 'mxn')).toBe(499.5);
      expect(fromMinorUnits(1200, 'jpy')).toBe(1200);
    });

    it('rejects a fractional minor amount', () => {
      expect(() => fromMinorUnits(10.5, 'mxn')).toThrow(PaymentError);
    });
  });

  describe('currency support', () => {
    it('reports known and unknown currencies', () => {
      expect(isSupportedCurrency('MXN')).toBe(true);
      expect(isSupportedCurrency('xyz')).toBe(false);
    });

    it('exposes the exponent', () => {
      expect(currencyExponent('mxn')).toBe(2);
      expect(currencyExponent('krw')).toBe(0);
    });
  });
});
