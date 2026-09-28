import { describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { AnchorConfig } from '../../src/core/config';
import { ConfigError } from '../../src/core/errors';
import { createAnchor, makeSqliteDbUrlForTests } from '../../src/core/factory';
import type { AnchorPlugin } from '../../src/types/plugin';
import type { AnchorKitConfig } from '../../src/types/config';
import { DatabaseUrlSchema } from '../../src/utils/validation-helpers';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  it('should reject non-numeric and unsafe rateLimit values (#250, #483, #484)', () => {
    const invalidCasesByKey: Record<string, unknown[]> = {
      windowMs: [0, -1, 1.5, NaN, Infinity, '60000' as unknown as number],
      authChallengeMax: [0, -1, 1.5, NaN, Infinity, '30' as unknown as number],
      authTokenMax: [0, -1, 1.5, NaN, Infinity, '30' as unknown as number],
      webhookMax: [0, -1, 1.5, NaN, Infinity, '120' as unknown as number],
      depositMax: [0, -1, 1.5, NaN, Infinity, '60' as unknown as number],
    };

    for (const [key, invalidValues] of Object.entries(invalidCasesByKey)) {
      for (const value of invalidValues) {
        const config = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            rateLimit: { [key]: value as number },
          },
        });
        expect(() => config.validate()).toThrow(ConfigError);
        expect(() => config.validate()).toThrow(/must be a positive safe integer/);
      }
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

  it('should validate watcher transactionTimeoutMs as a positive safe integer (#482)', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, '5000' as unknown as number]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { transactionTimeoutMs: value as number },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(
        /transactionTimeoutMs must be a positive safe integer/,
      );
    }

    for (const value of [1, 300000]) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          watchers: { transactionTimeoutMs: value },
        },
      });
      expect(() => config.validate()).not.toThrow();
    }
  });

  it('should validate defaultCurrency as a three-letter ISO 4217 code (#485)', () => {
    for (const value of ['usd', 'US', 'US$', 'US D', 'U1D']) {
      const config = new AnchorConfig({
        ...validBaseConfig,
        assets: {
          ...validBaseConfig.assets,
          defaultCurrency: value,
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(
        /defaultCurrency must be a three-letter uppercase ISO 4217 code/,
      );
    }

    const config = new AnchorConfig({
      ...validBaseConfig,
      assets: {
        ...validBaseConfig.assets,
        defaultCurrency: 'USD',
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
        assets: [
          { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
        ],
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
        unlinkSync(dbPath);
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

  describe('queue.concurrency validation', () => {
    it.each([0, -1, 1.5, NaN, Infinity, -Infinity, '2' as unknown as number])(
      'should reject invalid concurrency %s',
      (concurrency) => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            queue: { backend: 'memory', concurrency: concurrency as number },
          },
        });
        expect(() => config.validate()).toThrow(ConfigError);
        expect(() => config.validate()).toThrow(/queue\.concurrency must be a finite integer >= 1/);
      },
    );

    it.each([1, 2, 10])('should accept valid concurrency %i', (concurrency) => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: { ...validBaseConfig.framework, queue: { backend: 'memory', concurrency } },
      });
      expect(() => config.validate()).not.toThrow();
    });

    it('should accept omitted concurrency', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: { ...validBaseConfig.framework, queue: { backend: 'memory' } },
      });
      expect(() => config.validate()).not.toThrow();
    });
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

    it('should single-flight concurrent initialization and share failures', async () => {
      const pluginInitCalls: string[] = [];
      const failingPlugin = {
        id: 'failing-plugin',
        async init() {
          pluginInitCalls.push('init');
          await wait(25);
          throw new Error('plugin init failed');
        },
      };
      const anchor = createAnchor({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
        },
      });
      anchor.use(failingPlugin as AnchorPlugin);

      await expect(Promise.all([anchor.init(), anchor.init(), anchor.init()])).rejects.toThrow(
        'plugin init failed',
      );
      expect(pluginInitCalls).toHaveLength(1);
    });

    it('should single-flight concurrent shutdown calls and avoid duplicate cleanup', async () => {
      const anchor = createAnchor({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: makeSqliteDbUrlForTests(),
          },
        },
      });

      const stopCalls = { count: 0 };
      const disconnectCalls = { count: 0 };
      Object.assign(anchor, {
        initialized: true,
        backgroundJobsRunning: true,
        database: {
          disconnect: async () => {
            await wait(20);
            disconnectCalls.count += 1;
          },
        },
        queue: {
          stop: async () => {
            await wait(20);
            stopCalls.count += 1;
          },
        },
        watchers: [],
      });

      await Promise.all([anchor.shutdown(), anchor.shutdown(), anchor.shutdown()]);
      expect(stopCalls.count).toBe(1);
      expect(disconnectCalls.count).toBe(1);

      await anchor.shutdown();
      expect(disconnectCalls.count).toBe(1);
    });
  });

  describe('Provider-by-scheme validation (#382)', () => {
    it('should reject sqlite provider with postgres URL', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: 'postgresql://localhost:5432/db',
          },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/does not match provider "sqlite"/);
    });

    it('should reject postgres provider with sqlite URL', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'postgres',
            url: 'file:./dev.db',
          },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/does not match provider "postgres"/);
    });

    it('should reject sqlite provider with postgres:// URL', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'sqlite',
            url: 'postgres://user:pass@host/db',
          },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/does not match provider "sqlite"/);
    });

    it('should reject postgres provider with sqlite: URL', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          database: {
            provider: 'postgres',
            url: 'sqlite:./local.db',
          },
        },
      });
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/does not match provider "postgres"/);
    });

    it('should validate a matrix of provider-by-scheme combinations', () => {
      const passing = [
        { provider: 'sqlite' as const, url: 'sqlite:./dev.db' },
        { provider: 'sqlite' as const, url: 'file:./data.db' },
        { provider: 'postgres' as const, url: 'postgresql://localhost/db' },
        { provider: 'postgres' as const, url: 'postgres://localhost/db' },
      ];

      for (const { provider, url } of passing) {
        const cfg = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            database: { provider, url },
          },
        });
        expect(() => cfg.validate(), `${provider} + ${url} should pass`).not.toThrow();
      }

      const failing = [
        { provider: 'sqlite' as const, url: 'postgresql://localhost/db' },
        { provider: 'sqlite' as const, url: 'postgres://localhost/db' },
        { provider: 'postgres' as const, url: 'sqlite:./dev.db' },
        { provider: 'postgres' as const, url: 'file:./dev.db' },
      ];

      for (const { provider, url } of failing) {
        const cfg = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            database: { provider, url },
          },
        });
        expect(() => cfg.validate(), `${provider} + ${url} should fail`).toThrow(
          /does not match provider/,
        );
      }
    });
  });

  describe('maxBodyBytes validation (#379)', () => {
    it('should reject non-finite and non-integer maxBodyBytes values', () => {
      const invalidValues = [
        NaN,
        Infinity,
        -Infinity,
        1023,
        1,
        0,
        -1,
        1023.5,
        1024.5,
        '1024',
        true,
        false,
        {},
        [],
      ];
      for (const value of invalidValues) {
        const config = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            http: { maxBodyBytes: value as unknown as number },
          },
        });
        expect(() => config.validate()).toThrow(/maxBodyBytes must be a finite integer >= 1024/);
      }
    });

    it('should accept valid maxBodyBytes values', () => {
      const validValues = [1024, 2048, 8192, 65536, 1048576];
      for (const value of validValues) {
        const config = new AnchorConfig({
          ...validBaseConfig,
          framework: {
            ...validBaseConfig.framework,
            http: { maxBodyBytes: value },
          },
        });
        expect(() => config.validate()).not.toThrow();
      }
    });

    it('should accept omitted maxBodyBytes and apply the default', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        framework: {
          ...validBaseConfig.framework,
          http: {},
        },
      });
      expect(() => config.validate()).not.toThrow();
    });
  });
});
