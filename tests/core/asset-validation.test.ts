import { AnchorConfig } from '@/core/config';
import type { AnchorKitConfig } from '@/types/config';
import { describe, expect, it } from 'vitest';

describe('Asset Validation (#254)', () => {
  const baseConfig: AnchorKitConfig = {
    network: { network: 'testnet' },
    server: { port: 3000 },
    security: {
      sep10SigningKey: 'secret-key-10',
      interactiveJwtSecret: 'jwt-secret',
      distributionAccountSecret: 'dist-secret',
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
      database: {
        provider: 'postgres',
        url: 'postgresql://localhost:5432/anchor',
      },
    },
  };

  it('should accept valid asset config with code and issuer', () => {
    const config = new AnchorConfig(baseConfig);
    expect(() => config.validate()).not.toThrow();
  });

  it('should accept asset with optional fields', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            name: 'USDC Token',
            deposits_enabled: true,
            withdrawals_enabled: true,
            min_amount: 1,
            max_amount: 10000,
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject asset with empty code string', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: '',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject asset with missing code', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          } as unknown as { code: string; issuer: string },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject asset with invalid issuer', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'invalid-issuer',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should accept a 12-character alphanumeric asset code', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'ABCDEFGH1234',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject an asset code longer than 12 characters', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'ABCDEFGH12345',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject an asset code containing non-alphanumeric characters', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'US-DC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject asset with non-string code', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 123 as unknown as string,
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject asset with non-string issuer', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 123 as unknown as string,
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should identify the invalid asset by code in error message', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'GOOD',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
          {
            code: 'BAD',
            issuer: 'invalid',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 1/);
  });

  it('should validate all assets and fail on first invalid one', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
          {
            code: 'EURC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
          {
            code: '',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 2/);
  });

  it('should reject non-object asset entries', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: ['not-an-object' as unknown as { code: string; issuer: string }],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid asset at index 0/);
  });

  it('should reject duplicate asset codes and report the duplicate code in the error message', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Duplicate asset code detected: USDC/);
  });

  it('should accept configuration with multiple distinct asset codes', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
          {
            code: 'EURC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });
});
