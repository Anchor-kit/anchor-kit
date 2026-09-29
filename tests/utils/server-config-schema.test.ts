import { describe, expect, it } from 'vitest';
import { ServerConfigSchema, validateServerConfig } from '../../src/utils/validation';

describe('ServerConfigSchema', () => {
  it('is publicly importable from validation module', () => {
    expect(ServerConfigSchema).toBeDefined();
  });

  it('has all expected ServerConfig fields', () => {
    expect(ServerConfigSchema).toHaveProperty('host');
    expect(ServerConfigSchema).toHaveProperty('port');
    expect(ServerConfigSchema).toHaveProperty('debug');
    expect(ServerConfigSchema).toHaveProperty('interactiveDomain');
    expect(ServerConfigSchema).toHaveProperty('corsOrigins');
    expect(ServerConfigSchema).toHaveProperty('requestTimeout');
  });

  it('each field has required schema properties', () => {
    for (const [key, field] of Object.entries(ServerConfigSchema)) {
      expect(field, `${key} should have type`).toHaveProperty('type');
      expect(field, `${key} should have required`).toHaveProperty('required');
      expect(field, `${key} should have description`).toHaveProperty('description');
      expect(field, `${key} should have validate`).toHaveProperty('validate');
      expect(typeof field.validate).toBe('function');
    }
  });

  describe('host field', () => {
    it('validates a valid host string', () => {
      expect(ServerConfigSchema.host.validate('0.0.0.0')).toBe(true);
      expect(ServerConfigSchema.host.validate('localhost')).toBe(true);
    });
    it('rejects non-string values', () => {
      expect(ServerConfigSchema.host.validate(123)).toBe(false);
      expect(ServerConfigSchema.host.validate('')).toBe(false);
    });
  });

  describe('port field', () => {
    it('validates valid port numbers', () => {
      expect(ServerConfigSchema.port.validate(3000)).toBe(true);
      expect(ServerConfigSchema.port.validate(1)).toBe(true);
      expect(ServerConfigSchema.port.validate(65535)).toBe(true);
    });
    it('rejects invalid port numbers', () => {
      expect(ServerConfigSchema.port.validate(0)).toBe(false);
      expect(ServerConfigSchema.port.validate(-1)).toBe(false);
      expect(ServerConfigSchema.port.validate(65536)).toBe(false);
      expect(ServerConfigSchema.port.validate(3.14)).toBe(false);
      expect(ServerConfigSchema.port.validate('3000')).toBe(false);
    });
  });

  describe('debug field', () => {
    it('validates boolean values', () => {
      expect(ServerConfigSchema.debug.validate(true)).toBe(true);
      expect(ServerConfigSchema.debug.validate(false)).toBe(true);
    });
    it('rejects non-boolean values', () => {
      expect(ServerConfigSchema.debug.validate('true')).toBe(false);
      expect(ServerConfigSchema.debug.validate(1)).toBe(false);
    });
  });

  describe('interactiveDomain field', () => {
    it('validates valid URLs', () => {
      expect(ServerConfigSchema.interactiveDomain.validate('https://anchor.example.com')).toBe(
        true,
      );
      expect(ServerConfigSchema.interactiveDomain.validate('http://localhost:8080')).toBe(true);
    });
    it('rejects invalid URLs', () => {
      expect(ServerConfigSchema.interactiveDomain.validate('not-a-url')).toBe(false);
      expect(ServerConfigSchema.interactiveDomain.validate('')).toBe(false);
      expect(ServerConfigSchema.interactiveDomain.validate(123)).toBe(false);
    });
  });

  describe('corsOrigins field', () => {
    it('validates arrays of non-empty origin strings', () => {
      expect(ServerConfigSchema.corsOrigins.validate(['https://app.example.com'])).toBe(true);
      expect(
        ServerConfigSchema.corsOrigins.validate([
          'https://app.example.com',
          'http://localhost:3000',
        ]),
      ).toBe(true);
    });

    it('rejects invalid origin arrays', () => {
      expect(ServerConfigSchema.corsOrigins.validate('https://app.example.com')).toBe(false);
      expect(ServerConfigSchema.corsOrigins.validate([''])).toBe(false);
      expect(ServerConfigSchema.corsOrigins.validate([123])).toBe(false);
    });
  });

  describe('requestTimeout field', () => {
    it('validates positive finite timeouts', () => {
      expect(ServerConfigSchema.requestTimeout.validate(1)).toBe(true);
      expect(ServerConfigSchema.requestTimeout.validate(30000)).toBe(true);
    });

    it('rejects invalid timeout values', () => {
      expect(ServerConfigSchema.requestTimeout.validate(0)).toBe(false);
      expect(ServerConfigSchema.requestTimeout.validate(-1)).toBe(false);
      expect(ServerConfigSchema.requestTimeout.validate(Number.POSITIVE_INFINITY)).toBe(false);
      expect(ServerConfigSchema.requestTimeout.validate('30000')).toBe(false);
    });
  });
});

describe('validateServerConfig', () => {
  it('returns empty array for valid config', () => {
    const errors = validateServerConfig({
      host: 'localhost',
      port: 3000,
      debug: false,
      interactiveDomain: 'https://anchor.example.com',
      corsOrigins: ['https://app.example.com'],
      requestTimeout: 30000,
    });
    expect(errors).toEqual([]);
  });

  it('returns empty array for empty config (all fields optional)', () => {
    expect(validateServerConfig({})).toEqual([]);
  });

  it('returns error for invalid port', () => {
    const errors = validateServerConfig({ port: -1 });
    expect(errors).toContain('port: invalid value');
  });

  it('returns error for invalid interactiveDomain', () => {
    const errors = validateServerConfig({ interactiveDomain: 'not-a-url' });
    expect(errors).toContain('interactiveDomain: invalid value');
  });

  it('returns multiple errors for multiple invalid fields', () => {
    const errors = validateServerConfig({
      port: 0,
      debug: 'yes' as unknown as boolean,
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ServerConfigSchema public export', () => {
  it('is exported from the utils validation module', async () => {
    const mod = await import('../../src/utils/validation');
    expect(mod.ServerConfigSchema).toBeDefined();
    expect(mod.validateServerConfig).toBeDefined();
  });

  it('is accessible through the utils index', async () => {
    const mod = await import('../../src/utils/index');
    expect(mod.ServerConfigSchema).toBeDefined();
  });
});

describe('SecurityConfigSchema', () => {
  const requiredSecretFields = [
    'sep10SigningKey',
    'interactiveJwtSecret',
    'distributionAccountSecret',
  ] as const;

  it('exposes the required secret fields', () => {
    for (const field of requiredSecretFields) {
      expect(SecurityConfigSchema).toHaveProperty(field);
      expect(typeof SecurityConfigSchema[field].validate).toBe('function');
    }
  });

  for (const field of requiredSecretFields) {
    describe(`${field} field`, () => {
      it('accepts a non-empty string without modifying it', () => {
        const value = 's'.repeat(56);
        expect(SecurityConfigSchema[field].validate(value)).toBe(true);
        expect(value).toBe('s'.repeat(56));
      });

      it('rejects missing, empty, and whitespace-only values', () => {
        expect(SecurityConfigSchema[field].validate(undefined)).toBe(false);
        expect(SecurityConfigSchema[field].validate(null)).toBe(false);
        expect(SecurityConfigSchema[field].validate('')).toBe(false);
        expect(SecurityConfigSchema[field].validate('   ')).toBe(false);
        expect(SecurityConfigSchema[field].validate('\t\n')).toBe(false);
      });

      it('rejects non-string values', () => {
        expect(SecurityConfigSchema[field].validate(123)).toBe(false);
        expect(SecurityConfigSchema[field].validate(true)).toBe(false);
        expect(SecurityConfigSchema[field].validate({})).toBe(false);
        expect(SecurityConfigSchema[field].validate([])).toBe(false);
      });
    });
  }
});
