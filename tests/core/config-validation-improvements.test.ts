import { AnchorConfig } from '../../src/core/config';
import { ConfigError } from '../../src/core/errors';
import type { AnchorKitConfig } from '../../src/types/config';
import { describe, expect, it } from 'vitest';

describe('Config Validation Improvements (#124, #125)', () => {
  const validBaseConfig: AnchorKitConfig = {
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

  it('should reject MySQL provider during validation (#124)', () => {
    const mysqlConfig: AnchorKitConfig = {
      ...validBaseConfig,
      framework: {
        ...validBaseConfig.framework,
        database: {
          provider: 'mysql', // NOT SUPPORTED
          url: 'mysql://user:pass@localhost:3306/db',
        },
      },
    };
    const config = new AnchorConfig(mysqlConfig);
    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/MySQL is not currently supported/);
  });

  it('should accept sqlite provider during validation', () => {
    const sqliteConfig: AnchorKitConfig = {
      ...validBaseConfig,
      framework: {
        ...validBaseConfig.framework,
        database: {
          provider: 'sqlite',
          url: 'file:./dev.db',
        },
      },
    };
    const config = new AnchorConfig(sqliteConfig);
    expect(() => config.validate()).not.toThrow();
  });

  it('should reject non-database schemes in database URL (#125)', () => {
    const ftpConfig: AnchorKitConfig = {
      ...validBaseConfig,
      framework: {
        ...validBaseConfig.framework,
        database: {
          provider: 'postgres',
          url: 'ftp://ftp.example.com/db', // NOT a DATABASE URL
        },
      },
    };
    const config = new AnchorConfig(ftpConfig);
    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/Invalid database URL format/);
  });

  it('should accept valid postgres URLs', () => {
    const postgresConfigs = [
      'postgresql://localhost:5432/mydb',
      'postgres://user:pass@host.com/db',
    ];

    postgresConfigs.forEach((url) => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'postgres',
            url,
          },
        },
      });
      expect(() => config.validate()).not.toThrow();
    });
  });

  it('should accept valid sqlite URLs', () => {
    const sqliteConfigs = ['sqlite:./local.db', 'file:./data.db'];

    sqliteConfigs.forEach((url) => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url,
          },
        },
      });
      expect(() => config.validate()).not.toThrow();
    });
  });

  it('should reject unknown assetMapping targets', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      assets: {
        ...validBaseConfig.assets,
        assetMapping: {
          USD: 'USDT',
        },
      },
    });

    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/assetMapping.*USDT|unknown asset code/i);
  });

  it('should reject case-mismatched assetMapping targets', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      assets: {
        ...validBaseConfig.assets,
        assetMapping: {
          USD: 'usdc',
        },
      },
    });

    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/assetMapping.*usdc|unknown asset code/i);
  });

  it('should reject KYC definitions that reference unknown assets', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      kycRequired: {
        EUR: ['first_name'],
      },
    });

    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/kycRequired.*EUR|unknown asset code/i);
  });

  it('should reject empty KYC field names', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      kycRequired: {
        USDC: ['', 'email'],
      },
    });

    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/kycRequired.*USDC|non-empty string/i);
  });

  it('accepts native XLM without an issuer', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      assets: { assets: [{ code: 'XLM' }] },
    });

    expect(() => config.validate()).not.toThrow();
  });

  it('rejects an issuer configured for native XLM', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      assets: {
        assets: [
          { code: 'XLM', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        ],
      },
    });

    expect(() => config.validate()).toThrow(ConfigError);
    expect(() => config.validate()).toThrow(/XLM must not specify an issuer/i);
  });

  it('rejects issued assets with a missing or malformed issuer', () => {
    for (const issuer of [undefined, 'not-a-stellar-public-key']) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        assets: { assets: [{ code: 'USDC', issuer } as { code: string; issuer?: string }] },
      });

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/issued assets require a valid issuer/i);
    }
  });
});
