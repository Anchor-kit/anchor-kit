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
});

describe('Operational Website Validation (#388)', () => {
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

  it('should accept valid HTTP website URL', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'http://example.com',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTPS website URL', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'https://example.com',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config without operational.website (optional field)', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        name: 'Test Anchor',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config without operational section', () => {
    const anchor = new AnchorConfig(baseConfig);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject malformed URL', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'not-a-valid-url',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should reject FTP scheme', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'ftp://example.com',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should reject javascript: scheme', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'javascript:alert(1)',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should reject data: scheme', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'data:text/html,<script>alert(1)</script>',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should reject file: scheme', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'file:///etc/passwd',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should reject mailto: scheme', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        website: 'mailto:test@example.com',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid URL format for operational.website/);
  });

  it('should accept valid support email', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        supportEmail: 'support@example.com',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject malformed support email', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        supportEmail: 'not-an-email',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow();
    expect(() => anchor.validate()).toThrow(/Invalid email format for operational.supportEmail/);
  });
});
