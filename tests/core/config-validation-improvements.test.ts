import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { AnchorConfig } from '../../src/core/config';
import { ConfigError } from '../../src/core/errors';
import { createAnchor, makeSqliteDbUrlForTests } from '../../src/core/factory';
import type { AnchorKitConfig } from '../../src/types/config';
import { DatabaseUrlSchema } from '../../src/utils/validation-helpers';

describe('Config Validation Improvements (#124, #125)', () => {
  const testSep10SigningKey = Keypair.random().secret();
  const validBaseConfig: AnchorKitConfig = {
    network: { network: 'testnet' },
    server: { port: 3000 },
    security: {
      sep10SigningKey: testSep10SigningKey,
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

  it('validates server host and CORS origins in the complete config', () => {
    for (const [server, expectedError] of [
      [{ host: '' }, /server\.host: invalid value/],
      [{ host: 123 }, /server\.host: invalid value/],
      [{ corsOrigins: [''] }, /server\.corsOrigins: invalid value/],
      [{ corsOrigins: [123] }, /server\.corsOrigins: invalid value/],
    ] as const) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        server: server as AnchorKitConfig['server'],
      });
      expect(() => config.validate()).toThrow(expectedError);
    }

    const validConfig = new AnchorConfig({
      ...validBaseConfig,
      server: { host: 'localhost', corsOrigins: ['https://app.example.com'] },
    });
    expect(() => validConfig.validate()).not.toThrow();
    expect(validConfig.get('server').corsOrigins).toEqual(['https://app.example.com']);
  });

  it('validates metadata protocol flags as booleans and freezes valid flags', () => {
    const protocolFlags = ['sep10', 'sep24', 'sep6', 'sep31'] as const;
    for (const protocol of protocolFlags) {
      const invalidConfig = new AnchorConfig({
        ...validBaseConfig,
        metadata: { protocols: { [protocol]: 'yes' as unknown as boolean } },
      });
      expect(() => invalidConfig.validate()).toThrow(
        new RegExp(`metadata\\.protocols\\.${protocol} must be a boolean`),
      );

      const validConfig = new AnchorConfig({
        ...validBaseConfig,
        metadata: { protocols: { [protocol]: true } },
      });
      expect(() => validConfig.validate()).not.toThrow();
      expect(Object.isFrozen(validConfig.get('metadata')?.protocols)).toBe(true);
    }
  });

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

  it('should reject non-numeric rateLimit values (#250)', () => {
    const nonNumericCases = [
      'windowMs',
      'authChallengeMax',
      'authTokenMax',
      'webhookMax',
      'depositMax',
    ];
    for (const key of nonNumericCases) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          rateLimit: { [key]: 'fast' as unknown as number },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/must be a finite number/);
    }
  });

  it('should accept valid numeric rateLimit values (#250)', () => {
    const config = new AnchorConfig({
      ...validBaseConfig,
      framework: {
        ...validBaseConfig.framework,
        rateLimit: {
          windowMs: 60000,
          authChallengeMax: 30,
          authTokenMax: 30,
          webhookMax: 120,
          depositMax: 60,
        },
      },
    });
    expect(() => config.validate()).not.toThrow();
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

  it('should reject empty database URL targets while accepting non-empty ones', () => {
    for (const scheme of ['postgresql:', 'postgres:', 'sqlite:', 'file:']) {
      expect(DatabaseUrlSchema.isValid(scheme)).toBe(false);
      expect(DatabaseUrlSchema.isValid(`${scheme} `)).toBe(false);
    }

    for (const url of [
      'postgresql://localhost:5432/anchor',
      'postgres://user:pass@host/db',
      'sqlite::memory:',
      'file:./anchor.db',
    ]) {
      expect(DatabaseUrlSchema.isValid(url)).toBe(true);
    }

    const config = new AnchorConfig({
      ...validBaseConfig,
      framework: {
        ...validBaseConfig.framework,
        database: { provider: 'postgres', url: 'postgres:' },
      },
    });
    expect(() => config.validate()).toThrow(/Invalid database URL format/);
  });

  it('should require watcher poll intervals to be finite integers of at least 10ms', () => {
    for (const value of [NaN, Infinity, 10.5, 9, '10']) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { pollIntervalMs: value as unknown as number },
        },
      });
      expect(() => config.validate()).toThrow(/pollIntervalMs must be a finite integer >= 10/);
    }

    for (const value of [10, 15000, undefined]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { pollIntervalMs: value },
        },
      });
      expect(() => config.validate()).not.toThrow();
    }
  });

  it('rejects plugin registration after the instance is initialized', async () => {
    const dbUrl = makeSqliteDbUrlForTests();
    const anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: testSep10SigningKey,
        interactiveJwtSecret: 'jwt-secret',
        distributionAccountSecret: 'dist-secret',
      },
      assets: {
        assets: [{ code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }],
      },
      framework: { database: { provider: 'sqlite', url: dbUrl } },
    });

    await anchor.init();
    expect(() => anchor.use({ id: 'late-plugin' })).toThrow(/after init|before calling init/i);
    await anchor.shutdown();
    try {
      // cleanup sqlite file created for this test
      const dbPath = dbUrl.slice('file:'.length);
      if (dbPath) {
        require('node:fs').unlinkSync(dbPath);
      }
    } catch {
      // ignore
    }
  });

  it('should validate watchers.enabled as an optional boolean', () => {
    for (const value of ['true', 1]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { enabled: value as unknown as boolean },
        },
      });
      expect(() => config.validate()).toThrow(/watchers.enabled must be a boolean/);
    }

    for (const value of [true, false, undefined]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { enabled: value },
        },
      });
      expect(() => config.validate()).not.toThrow();
    }
  });

  it('should validate trustForwardedFor as an optional boolean', () => {
    for (const value of ['true', 1]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          rateLimit: { trustForwardedFor: value as unknown as boolean },
        },
      });
      expect(() => config.validate()).toThrow(/trustForwardedFor must be a boolean/);
    }

    for (const value of [true, false, undefined]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          rateLimit: { trustForwardedFor: value },
        },
      });
      expect(() => config.validate()).not.toThrow();
    }
  });

  describe('Runtime Config Validation (#207)', () => {
    it('should reject redis queue backend during initialization', async () => {
      const redisConfig = {
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
          queue: {
            backend: 'redis',
          },
        },
      } as unknown as AnchorKitConfig;
      const anchor = createAnchor(redisConfig);
      await expect(anchor.init()).rejects.toThrow(ConfigError);
      await expect(anchor.init()).rejects.toThrow(/Unsupported queue backend: "redis"/);
    });

    it('should reject postgres queue backend during initialization', async () => {
      const postgresConfig = {
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
          queue: {
            backend: 'postgres',
          },
        },
      } as unknown as AnchorKitConfig;
      const anchor = createAnchor(postgresConfig);
      await expect(anchor.init()).rejects.toThrow(ConfigError);
      await expect(anchor.init()).rejects.toThrow(/Unsupported queue backend: "postgres"/);
    });

    it('should accept memory queue backend during initialization', async () => {
      const memoryConfig: AnchorKitConfig = {
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
          queue: {
            backend: 'memory',
          },
        },
      };
      const anchor = createAnchor(memoryConfig);
      await anchor.init();
      await anchor.shutdown();
    });

    it('should default to memory queue backend when not specified', async () => {
      const defaultConfig: AnchorKitConfig = {
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
        },
      };
      const anchor = createAnchor(defaultConfig);
      await anchor.init();
      await anchor.shutdown();
    });
  });
});
