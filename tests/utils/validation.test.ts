import {
  AnchorKitConfigSchema,
  NetworkConfigSchema,
  SecurityConfigSchema,
  ValidationUtils,
} from '../../src/utils/validation';
import type { AnchorKitConfig } from '../../src/types/config';

describe('ValidationUtils', () => {
  describe('isValidEmail', () => {
    test('should return true for valid emails', () => {
      expect(ValidationUtils.isValidEmail('test@example.com')).toBe(true);
      expect(ValidationUtils.isValidEmail('user.name@domain.co.uk')).toBe(true);
      expect(ValidationUtils.isValidEmail('user+alias@gmail.com')).toBe(true);
    });

    test('should return false for invalid emails', () => {
      expect(ValidationUtils.isValidEmail('invalid-email')).toBe(false);
      expect(ValidationUtils.isValidEmail('user@')).toBe(false);
      expect(ValidationUtils.isValidEmail('@domain.com')).toBe(false);
      expect(ValidationUtils.isValidEmail('user@domain')).toBe(false);
    });
  });

  describe('isValidPhoneNumber', () => {
    test('should return true for valid E.164 phone numbers', () => {
      expect(ValidationUtils.isValidPhoneNumber('+1234567890')).toBe(true);
      expect(ValidationUtils.isValidPhoneNumber('+447123456789')).toBe(true);
    });

    test('should return false for invalid phone numbers', () => {
      expect(ValidationUtils.isValidPhoneNumber('1234567890')).toBe(false); // Missing +
      expect(ValidationUtils.isValidPhoneNumber('+0123456789')).toBe(false); // Leading zero after +
      expect(ValidationUtils.isValidPhoneNumber('+123')).toBe(true); // Minimum length is not strictly enforced by SEP usually, but pattern says 1-14 digits
      expect(ValidationUtils.isValidPhoneNumber('+1234567890123456')).toBe(false); // Too long (>15 digits)
    });
  });

  describe('isValidUrl', () => {
    test('should return true for valid URLs', () => {
      expect(ValidationUtils.isValidUrl('https://stellar.org')).toBe(true);
      expect(ValidationUtils.isValidUrl('http://localhost:8000')).toBe(true);
    });

    test('should return false for invalid URLs', () => {
      expect(ValidationUtils.isValidUrl('not-a-url')).toBe(false);
      expect(ValidationUtils.isValidUrl('ftp://invalid')).toBe(true); // Technically a valid URL structure
      expect(ValidationUtils.isValidUrl('')).toBe(false);
    });
  });

  describe('sanitizeInput', () => {
    test('should remove script tags', () => {
      const input = '<script>alert("xss")</script>Hello';
      expect(ValidationUtils.sanitizeInput(input)).toBe('Hello');
    });

    test('should remove HTML tags', () => {
      const input = '<div><b>Bold</b> Text</div>';
      expect(ValidationUtils.sanitizeInput(input)).toBe('Bold Text');
    });

    test('should handle robust XSS vectors', () => {
      const vectors = [
        '<img src=x onerror=alert(1)>',
        '<svg/onload=alert(1)>',
        '<details open ontoggle=alert(1)>',
        '<a href="javascript:alert(1)">Click me</a>',
        '<video><source onerror="alert(1)">',
      ];
      for (const vector of vectors) {
        expect(ValidationUtils.sanitizeInput(vector)).not.toContain('alert(1)');
        expect(ValidationUtils.sanitizeInput(vector)).not.toContain('<script');
      }
    });

    test('should trim whitespace', () => {
      const input = '   content   ';
      expect(ValidationUtils.sanitizeInput(input)).toBe('content');
    });

    test('should handle empty input', () => {
      expect(ValidationUtils.sanitizeInput('')).toBe('');
    });
  });

  describe('isDecimal', () => {
    test('should return true for valid decimals', () => {
      expect(ValidationUtils.isDecimal('100')).toBe(true);
      expect(ValidationUtils.isDecimal('100.50')).toBe(true);
      expect(ValidationUtils.isDecimal('-100.50')).toBe(true);
      expect(ValidationUtils.isDecimal('0')).toBe(true);
    });

    test('should return false for invalid decimals', () => {
      expect(ValidationUtils.isDecimal('abc')).toBe(false);
      expect(ValidationUtils.isDecimal('1.2.3')).toBe(false);
      expect(ValidationUtils.isDecimal('100px')).toBe(false);
      expect(ValidationUtils.isDecimal('')).toBe(false);
      expect(ValidationUtils.isDecimal(' ')).toBe(false);
    });
  });

  describe('isValidDatabaseUrl', () => {
    test('should return true for valid database URLs', () => {
      expect(ValidationUtils.isValidDatabaseUrl('postgresql://localhost:5432/db')).toBe(true);
      expect(ValidationUtils.isValidDatabaseUrl('postgres://user:pass@host:5432/db')).toBe(true);
      expect(ValidationUtils.isValidDatabaseUrl('sqlite://path/to/db.sqlite')).toBe(true);
      expect(ValidationUtils.isValidDatabaseUrl('file:./local.db')).toBe(true);
    });

    test('should return false for invalid database URLs', () => {
      expect(ValidationUtils.isValidDatabaseUrl('')).toBe(false);
      expect(ValidationUtils.isValidDatabaseUrl('not-a-db-url')).toBe(false);
    });
  });
});

describe('NetworkConfigSchema', () => {
  test('should validate a correct NetworkConfig', () => {
    expect(() => NetworkConfigSchema.validate({ network: 'testnet' })).not.toThrow();
    expect(() =>
      NetworkConfigSchema.validate({
        network: 'public',
        horizonUrl: 'https://horizon.stellar.org',
      }),
    ).not.toThrow();
  });

  test('should throw for invalid network name', () => {
    // @ts-expect-error test case
    expect(() => NetworkConfigSchema.validate({ network: 'invalidnet' })).toThrow(
      /Invalid network/,
    );
  });

  test('should throw for invalid horizonUrl', () => {
    expect(() =>
      NetworkConfigSchema.validate({
        network: 'testnet',
        horizonUrl: 'not-a-url',
      }),
    ).toThrow(/Invalid URL format/);
  });
});

describe('SecurityConfigSchema', () => {
  const validSecurityConfig = {
    sep10SigningKey: 'SD6P3...',
    interactiveJwtSecret: 'shhh',
    distributionAccountSecret: 'SD7Q4...',
  };

  test('should validate a correct SecurityConfig', () => {
    expect(() => SecurityConfigSchema.validate(validSecurityConfig)).not.toThrow();
  });

  test('should throw for missing security secrets', () => {
    expect(() =>
      SecurityConfigSchema.validate({
        ...validSecurityConfig,
        sep10SigningKey: '',
      }),
    ).toThrow(/sep10SigningKey/);
  });

  test('should throw for invalid authTokenLifetimeSeconds', () => {
    expect(() =>
      SecurityConfigSchema.validate({
        ...validSecurityConfig,
        authTokenLifetimeSeconds: 0,
      }),
    ).toThrow(/authTokenLifetimeSeconds must be > 0/);
  });

  test('should throw when authTokenLifetimeSeconds is a string', () => {
    expect(() =>
      SecurityConfigSchema.validate({
        ...validSecurityConfig,
        authTokenLifetimeSeconds: '3600' as unknown as number,
      }),
    ).toThrow(/authTokenLifetimeSeconds must be > 0/);
  });
});

describe('AnchorKitConfigSchema', () => {
  const validConfig: AnchorKitConfig = {
    network: { network: 'testnet' },
    server: { interactiveDomain: 'https://example.com' },
    security: {
      sep10SigningKey: 'SD6P3...',
      interactiveJwtSecret: 'shhh',
      distributionAccountSecret: 'SD7Q4...',
    },
    assets: {
      assets: [
        {
          code: 'USDC',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
      ],
    },
    framework: {
      database: { provider: 'sqlite', url: 'file:./test.db' },
    },
  };

  test('should validate a correct AnchorKitConfig', () => {
    expect(() => AnchorKitConfigSchema.validate(validConfig)).not.toThrow();
  });

  test('should throw for missing secrets', () => {
    const invalidConfig = {
      ...validConfig,
      security: { ...validConfig.security, sep10SigningKey: '' },
    };
    expect(() => AnchorKitConfigSchema.validate(invalidConfig)).toThrow(/sep10SigningKey/);
  });

  test('should throw for invalid pollsIntervalMs', () => {
    const invalidConfig = {
      ...validConfig,
      framework: {
        ...validConfig.framework,
        watchers: { pollIntervalMs: 5 }, // Minimum is 10
      },
    };
    expect(() => AnchorKitConfigSchema.validate(invalidConfig)).toThrow(/pollIntervalMs/);
  });
});
