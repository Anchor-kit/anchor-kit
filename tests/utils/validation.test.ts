import { AnchorConfig } from '@/core/config';
import type { AnchorKitConfig } from '@/types/config';
import { ValidationUtils } from '@/utils/validation';
import { encodeMuxedAccount, encodeMuxedAccountToAddress } from '@stellar/stellar-sdk';
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

  it('accepts native XLM without an issuer', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: { assets: [{ code: 'XLM' }] },
    };

    expect(() => new AnchorConfig(config).validate()).not.toThrow();
  });

  it('rejects native XLM when an issuer is supplied', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: {
        assets: [
          {
            code: 'XLM',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
    };

    expect(() => new AnchorConfig(config).validate()).toThrow(/Invalid asset at index 0/);
  });

  it('rejects issued assets without a valid classic issuer key', () => {
    for (const issuer of [undefined, 'invalid-issuer']) {
      const config = {
        ...baseConfig,
        assets: { assets: [{ code: 'USDC', ...(issuer ? { issuer } : {}) }] },
      } as AnchorKitConfig;
      expect(() => new AnchorConfig(config).validate()).toThrow(/Invalid asset at index 0/);
    }
  });

  it.each([' USDC', 'USDC ', '\tUSDC', 'USDC\n'])(
    'should reject whitespace-padded asset code %j',
    (code) => {
      const config: AnchorKitConfig = {
        ...baseConfig,
        assets: { assets: [{ code, issuer: baseConfig.assets.assets[0].issuer }] },
      };
      expect(() => new AnchorConfig(config).validate()).toThrow(/Invalid asset at index 0/);
    },
  );

  it.each(['usdc', 'USDC', 'UsdC'])('should accept unpadded mixed-case asset code %s', (code) => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      assets: { assets: [{ code, issuer: baseConfig.assets.assets[0].issuer }] },
    };
    expect(() => new AnchorConfig(config).validate()).not.toThrow();
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

describe('Operational Boolean Options Validation (#550)', () => {
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

  it('should accept valid boolean true for webhooksEnabled', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        webhooksEnabled: true,
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid boolean false for webhooksEnabled', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        webhooksEnabled: false,
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid boolean true for corsEnabled', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        corsEnabled: true,
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid boolean false for corsEnabled', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {
        corsEnabled: false,
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config without webhooksEnabled (optional field)', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {},
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config without corsEnabled (optional field)', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: {},
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject string value for webhooksEnabled', () => {
    const config = {
      ...baseConfig,
      operational: {
        webhooksEnabled: 'true',
      },
    } as unknown as AnchorKitConfig;
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow('operational.webhooksEnabled must be a boolean');
  });

  it('should reject string value for corsEnabled', () => {
    const config = {
      ...baseConfig,
      operational: {
        corsEnabled: 'true',
      },
    } as unknown as AnchorKitConfig;
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow('operational.corsEnabled must be a boolean');
  });

  it('should reject number value for webhooksEnabled', () => {
    const config = {
      ...baseConfig,
      operational: {
        webhooksEnabled: 1,
      },
    } as unknown as AnchorKitConfig;
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow('operational.webhooksEnabled must be a boolean');
  });

  it('should reject number value for corsEnabled', () => {
    const config = {
      ...baseConfig,
      operational: {
        corsEnabled: 0,
      },
    } as unknown as AnchorKitConfig;
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow('operational.corsEnabled must be a boolean');
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

  it('should accept a valid support email', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: { supportEmail: 'support@example.com' },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject a malformed support email', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      operational: { supportEmail: 'not-an-email' },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(/Invalid email format for operational.supportEmail/);
  });
});

describe('Stellar Address Checksum Validation (#386)', () => {
  const VALID_PUBLIC_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  // One-character mutation of the StrKey checksum (final char 5 -> 3)
  const BAD_CHECKSUM_KEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA3';

  it('should return true for a valid public key', () => {
    expect(ValidationUtils.isValidStellarAddress(VALID_PUBLIC_KEY)).toBe(true);
  });

  it('should return false for a regex-shaped key with a bad checksum', () => {
    expect(BAD_CHECKSUM_KEY).toMatch(/^G[A-Z2-7]{55}$/);
    expect(ValidationUtils.isValidStellarAddress(BAD_CHECKSUM_KEY)).toBe(false);
  });

  it('should accept a valid muxed account address', () => {
    const muxed = encodeMuxedAccountToAddress(encodeMuxedAccount(VALID_PUBLIC_KEY, '42'), true);
    expect(ValidationUtils.isValidStellarAddress(muxed)).toBe(true);
  });

  it('should reject a checksum-invalid muxed account address', () => {
    const muxed = encodeMuxedAccountToAddress(encodeMuxedAccount(VALID_PUBLIC_KEY, '42'), true);
    const replacement = muxed.endsWith('A') ? 'B' : 'A';
    expect(ValidationUtils.isValidStellarAddress(muxed.slice(0, -1) + replacement)).toBe(false);
  });

  it('should return false for empty or non-string input', () => {
    expect(ValidationUtils.isValidStellarAddress('')).toBe(false);
    expect(ValidationUtils.isValidStellarAddress(null as unknown as string)).toBe(false);
    expect(ValidationUtils.isValidStellarAddress(undefined as unknown as string)).toBe(false);
  });
});

describe('Email Validation (#607)', () => {
  it.each(['support@example.com', 'first.last+tag@example.co.uk', 'user_name@example-domain.com'])(
    'accepts valid email %s',
    (email) => {
      expect(ValidationUtils.isValidEmail(email)).toBe(true);
    },
  );

  it.each([
    '.support@example.com',
    'support.@example.com',
    'support..team@example.com',
    'support@.example.com',
    'support@example..com',
  ])('rejects malformed email %s', (email) => {
    expect(ValidationUtils.isValidEmail(email)).toBe(false);
  });
});

describe('Documentation URLs Validation (#549)', () => {
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

  it('should accept valid HTTPS URL for apiDocs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'https://docs.example.com/api',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTP URL for apiDocs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'http://docs.example.com/api',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTPS URL for support', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          support: 'https://support.example.com',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTP URL for support', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          support: 'http://support.example.com',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTPS URL for terms', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          terms: 'https://example.com/terms',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept valid HTTP URL for terms', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          terms: 'http://example.com/terms',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config without documentationUrls (optional field)', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        tomlUrl: 'https://example.com/stellar.toml',
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config with empty documentationUrls object', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {},
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept config with partial documentationUrls', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'https://docs.example.com/api',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should accept all three valid documentation URLs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'https://docs.example.com/api',
          support: 'https://support.example.com',
          terms: 'https://example.com/terms',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).not.toThrow();
  });

  it('should reject malformed URL for apiDocs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'not-a-valid-url',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.apiDocs/,
    );
  });

  it('should reject malformed URL for support', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          support: 'not-a-valid-url',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.support/,
    );
  });

  it('should reject malformed URL for terms', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          terms: 'not-a-valid-url',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.terms/,
    );
  });

  it('should reject FTP scheme for apiDocs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'ftp://docs.example.com/api',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.apiDocs/,
    );
  });

  it('should reject javascript: scheme for support', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          support: 'javascript:alert(1)',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.support/,
    );
  });

  it('should reject data: scheme for terms', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          terms: 'data:text/html,<script>alert(1)</script>',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.terms/,
    );
  });

  it('should reject file: scheme for apiDocs', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          apiDocs: 'file:///etc/passwd',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.apiDocs/,
    );
  });

  it('should reject mailto: scheme for support', () => {
    const config: AnchorKitConfig = {
      ...baseConfig,
      metadata: {
        documentationUrls: {
          support: 'mailto:support@example.com',
        },
      },
    };
    const anchor = new AnchorConfig(config);
    expect(() => anchor.validate()).toThrow(
      /Invalid URL format for metadata.documentationUrls.support/,
    );
  });
});
