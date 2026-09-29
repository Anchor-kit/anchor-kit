import Big from 'big.js';
import { ValidationUtils } from './validation';
import { ValidationError } from '@/core/errors.ts';

/**
 * DecimalUtils helper object
 * Provides high-precision financial math capabilities for Stellar anchor services.
 * Uses big.js to preserve precision and deterministic behavior.
 */
export const DecimalUtils = {
  /**
   * Converts a string to a Big instance.
   *
   * @param value The decimal string.
   * @returns Big instance.
   */
  fromString(value: string): Big {
    if (!ValidationUtils.isDecimal(value)) {
      throw new Error(`Invalid decimal string provided: ${value}`);
    }
    return new Big(value);
  },

  /**
   * Adds two decimal strings.
   *
   * @param a First operand.
   * @param b Second operand.
   * @returns Sum as string.
   */
  add(a: string, b: string): string {
    return this.fromString(a).plus(this.fromString(b)).toFixed();
  },

  /**
   * Subtracts one decimal string from another.
   *
   * @param a Minuend.
   * @param b Subtrahend.
   * @returns Difference as string.
   */
  subtract(a: string, b: string): string {
    return this.fromString(a).minus(this.fromString(b)).toFixed();
  },

  /**
   * Multiplies two decimal strings.
   *
   * @param a Multiplicand.
   * @param b Multiplier.
   * @returns Product as string.
   */
  multiply(a: string, b: string): string {
    return this.fromString(a).times(this.fromString(b)).toFixed();
  },

  /**
   * Divides one decimal string by another with optional precision control.
   *
   * @param a Dividend.
   * @param b Divisor.
   * @param precision Optional decimal places (defaults to 7 for Stellar convention).
   * @returns Quotient as string.
   */
  divide(a: string, b: string, precision: number = 7): string {
    if (
      typeof precision !== 'number' ||
      !Number.isFinite(precision) ||
      !Number.isSafeInteger(precision) ||
      precision < 0
    ) {
      throw new ValidationError('precision must be a non-negative safe integer');
    }

    return this.fromString(a).div(this.fromString(b)).toFixed(precision);
  },

  /**
   * Calculates an amount with a percentage fee applied.
   * amount * (1 + feePercentage / 100)
   *
   * @param amount The base amount string.
   * @param feePercentage The fee percentage (e.g., 2.5 for 2.5%).
   * @returns Total amount including fee as string.
   */
  applyFee(amount: string, feePercentage: number): string {
    if (
      typeof feePercentage !== 'number' ||
      !Number.isFinite(feePercentage) ||
      Number.isNaN(feePercentage)
    ) {
      throw new ValidationError('feePercentage must be a finite number');
    }

    if (feePercentage < 0 || feePercentage > 100) {
      throw new ValidationError('feePercentage must be between 0 and 100 inclusive');
    }

    const bigAmount = this.fromString(amount);
    const bigFee = new Big(feePercentage).div(100);
    return bigAmount.times(new Big(1).plus(bigFee)).toFixed();
  },
};
