import { DecimalUtils } from '../../src/utils/decimal';

describe('DecimalUtils', () => {
  describe('add', () => {
    test('should correctly add two decimals', () => {
      expect(DecimalUtils.add('0.1', '0.2')).toBe('0.3');
      expect(DecimalUtils.add('100.05', '50.10')).toBe('150.15');
    });
  });

  describe('subtract', () => {
    test('should correctly subtract two decimals', () => {
      expect(DecimalUtils.subtract('0.3', '0.1')).toBe('0.2');
      expect(DecimalUtils.subtract('100.00', '0.01')).toBe('99.99');
    });
  });

  describe('multiply', () => {
    test('should correctly multiply two decimals', () => {
      expect(DecimalUtils.multiply('0.1', '0.1')).toBe('0.01');
      expect(DecimalUtils.multiply('10.5', '2')).toBe('21');
    });
  });

  describe('divide', () => {
    test('should correctly divide two decimals with default precision', () => {
      // 1 / 3 = 0.3333333...
      expect(DecimalUtils.divide('1', '3')).toBe('0.3333333');
    });

    test('should correctly divide two decimals with custom precision', () => {
      expect(DecimalUtils.divide('1', '3', 2)).toBe('0.33');
      expect(DecimalUtils.divide('10', '2', 2)).toBe('5.00');
    });

    test('should throw when dividing by zero', () => {
      expect(() => DecimalUtils.divide('1', '0')).toThrow('[big.js] Division by zero');
    });

    test('should validate precision parameter', () => {
      expect(() => DecimalUtils.divide('1', '3', -1)).toThrow();
      expect(() => DecimalUtils.divide('1', '3', 2.5)).toThrow();
      expect(() => DecimalUtils.divide('1', '3', Number.POSITIVE_INFINITY)).toThrow();
    });
  });

  describe('applyFee', () => {
    test('should correctly apply a percentage fee', () => {
      // 100 + 2.5% = 102.5
      expect(DecimalUtils.applyFee('100', 2.5)).toBe('102.5');
      // 50 + 10% = 55
      expect(DecimalUtils.applyFee('50', 10)).toBe('55');
    });

    test('should accept zero and 100% boundary fees', () => {
      expect(DecimalUtils.applyFee('100', 0)).toBe('100');
      expect(DecimalUtils.applyFee('100', 100)).toBe('200');
    });

    test('should reject invalid fee inputs', () => {
      expect(() => DecimalUtils.applyFee('100', -1)).toThrow();
      expect(() => DecimalUtils.applyFee('100', Number.NaN)).toThrow();
      expect(() => DecimalUtils.applyFee('100', Infinity)).toThrow();
      expect(() => DecimalUtils.applyFee('100', 200)).toThrow();
    });
  });

  describe('precision preservation', () => {
    test('should preserve precision for financial math', () => {
      // Standard JS: 0.1 + 0.2 = 0.30000000000000004
      // DecimalUtils should be exactly '0.3'
      expect(DecimalUtils.add('0.1', '0.2')).toBe('0.3');

      // Multiplication precision
      expect(DecimalUtils.multiply('0.0000001', '0.0000001')).toBe('0.00000000000001');
    });
  });

  describe('error handling', () => {
    test('should throw error for invalid decimal strings', () => {
      expect(() => DecimalUtils.fromString('abc')).toThrow('Invalid decimal string provided: abc');
      expect(() => DecimalUtils.add('10.5', 'invalid')).toThrow();
      expect(() => DecimalUtils.subtract('invalid', '10.5')).toThrow();
      expect(() => DecimalUtils.multiply('10.5', 'invalid')).toThrow();
      expect(() => DecimalUtils.divide('10.5', 'invalid')).toThrow();
      expect(() => DecimalUtils.applyFee('invalid', 2.5)).toThrow();
    });
  });
});
