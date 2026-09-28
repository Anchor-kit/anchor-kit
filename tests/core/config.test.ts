import { AnchorConfig } from '@/core/config.ts';
import { ConfigError } from '@/core/errors.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import { Networks } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

describe('AnchorConfig', () => {
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

  describe('Initialization and Getters', () => {
    it('should initialize and return specific config properties', () => {
      const config = new AnchorConfig(validBaseConfig);
      expect(config.get('network').network).toBe('testnet');
      expect(config.get('server').port).toBe(3000);
      expect(config.getConfig()).toMatchObject(validBaseConfig);
    });

    it('should apply operational defaults when not provided', () => {
      const cfg = new AnchorConfig(validBaseConfig);
      const op = cfg.get('operational');
      expect(op).toBeDefined();
      expect(op?.transactionRetentionDays).toBe(90);
    });

    it('should reject invalid transaction retention values', () => {
      const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53];

      invalidValues.forEach((value) => {
        const invalidConfig: AnchorKitConfig = {
          ...validBaseConfig,
          operational: {
            transactionRetentionDays: value,
          },
        };

        expect(() => new AnchorConfig(invalidConfig).validate()).toThrow(
          /transactionRetentionDays/,
        );
      });
    });

    it('should accept valid positive integer retention values unchanged', () => {
      const config = new AnchorConfig({
        ...validBaseConfig,
        operational: {
          transactionRetentionDays: 30,
        },
      });

      expect(config.get('operational')?.transactionRetentionDays).toBe(30);
      expect(() => config.validate()).not.toThrow();
    });
  });

  describe('getAsset()', () => {
    it('should return the matching asset', () => {
      const config = new AnchorConfig(validBaseConfig);
      const asset = config.getAsset('USDC');
      expect(asset).toBeDefined();
      expect(asset?.code).toBe('USDC');
      expect(asset?.issuer).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
    });

    it('should return undefined when case does not match', () => {
      const config = new AnchorConfig(validBaseConfig);
      const asset = config.getAsset('usdc');
      expect(asset).toBeUndefined();
    });

    it('should return undefined when the asset is missing', () => {
      const config = new AnchorConfig(validBaseConfig);
      const asset = config.getAsset('UNKNOWN');
      expect(asset).toBeUndefined();
    });
  });

  describe('getKycRequiredFields()', () => {
    it('should return configured fields for a mapped asset', () => {
      const configWithKyc: AnchorKitConfig = {
        ...validBaseConfig,
        kycRequired: {
          USDC: ['first_name', 'last_name', 'email'],
        },
      };
      const config = new AnchorConfig(configWithKyc);
      const fields = config.getKycRequiredFields('USDC');
      expect(fields).toEqual(['first_name', 'last_name', 'email']);
    });

    it('should return an empty list for an unmapped asset', () => {
      const configWithKyc: AnchorKitConfig = {
        ...validBaseConfig,
        kycRequired: {
          USDC: ['first_name', 'last_name', 'email'],
        },
      };
      const config = new AnchorConfig(configWithKyc);
      const fields = config.getKycRequiredFields('NGNC');
      expect(fields).toEqual([]);
    });

    it('should return an empty list when no policy exists (kycRequired is undefined)', () => {
      const config = new AnchorConfig(validBaseConfig);
      const fields = config.getKycRequiredFields('USDC');
      expect(fields).toEqual([]);
    });
  });

  describe('isNetworkPassphrase()', () => {
    it('should return true for configured network passphrase', () => {
      const configWithPassphrase: AnchorKitConfig = {
        ...validBaseConfig,
        network: {
          ...validBaseConfig.network,
          networkPassphrase: 'Custom Network Passphrase',
        },
      };
      const config = new AnchorConfig(configWithPassphrase);
      expect(config.isNetworkPassphrase('Custom Network Passphrase')).toBe(true);
      expect(config.isNetworkPassphrase('Test SDF Network ; September 2015')).toBe(false);
    });

    it('should fall back to testnet default passphrase', () => {
      const config = new AnchorConfig(validBaseConfig); // validBaseConfig has network: 'testnet'
      expect(config.isNetworkPassphrase('Test SDF Network ; September 2015')).toBe(true);
      expect(config.isNetworkPassphrase('Wrong Passphrase')).toBe(false);
    });

    it('should fall back to public default passphrase', () => {
      const configPublic: AnchorKitConfig = {
        ...validBaseConfig,
        network: { network: 'public' },
      };
      const config = new AnchorConfig(configPublic);
      expect(config.isNetworkPassphrase('Public Global Stellar Network ; September 2015')).toBe(
        true,
      );
      expect(config.isNetworkPassphrase('Test SDF Network ; September 2015')).toBe(false);
    });

    it('should fall back to futurenet default passphrase', () => {
      const configFuturenet: AnchorKitConfig = {
        ...validBaseConfig,
        network: { network: 'futurenet' },
      };
      const config = new AnchorConfig(configFuturenet);
      expect(config.isNetworkPassphrase(Networks.FUTURENET)).toBe(true);
      expect(config.isNetworkPassphrase('Test SDF Network ; September 2015')).toBe(false);
    });
  });

  describe('validate()', () => {
    it('should pass for a valid configuration', () => {
      const config = new AnchorConfig(validBaseConfig);
      expect(() => config.validate()).not.toThrow();
    });

    it('should throw ConfigError if top-level network is missing', () => {
      // @ts-expect-error this is for test cases
      const invalidConfig: AnchorKitConfig = { ...validBaseConfig, network: undefined };
      const config = new AnchorConfig(invalidConfig);
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/network/);
    });

    it('should throw ConfigError if required secrets are missing', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        security: { ...validBaseConfig.security, sep10SigningKey: '' },
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/sep10SigningKey/);
    });

    it('should throw ConfigError for missing assets list', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        assets: { assets: [] },
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/asset/);
    });

    it('should throw ConfigError for invalid network string', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        // @ts-expect-error this is for test cases
        network: { network: 'invalidnet' },
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/Invalid network: invalidnet/);
    });

    it('should validate framework database configuration', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        // @ts-expect-error this is for test cases
        framework: { database: { provider: 'postgres' } }, // missing url
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/database/);
    });

    it('should reject invalid database URLs', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        framework: {
          database: {
            provider: 'postgres',
            url: 'invalid-url-string',
          },
        },
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/Invalid database URL format/);
    });

    it('should reject invalid HTTP URLs for network or server', () => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        server: { ...validBaseConfig.server, interactiveDomain: 'not-a-url' },
      };
      const config = new AnchorConfig(invalidConfig);

      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/Invalid URL format for server\.interactiveDomain/);
    });

    it('should validate valid sqlite file URIs', () => {
      const sqliteConfig: AnchorKitConfig = {
        ...validBaseConfig,
        framework: {
          database: {
            provider: 'sqlite',
            url: 'file:./dev.db',
          },
        },
      };
      const config = new AnchorConfig(sqliteConfig);
      expect(() => config.validate()).not.toThrow();
    });

    it('should accept valid challenge lifetime', () => {
      const configWithChallengeTtl: AnchorKitConfig = {
        ...validBaseConfig,
        security: {
          ...validBaseConfig.security,
          challengeExpirationSeconds: 300,
        },
      };
      const config = new AnchorConfig(configWithChallengeTtl);
      expect(() => config.validate()).not.toThrow();
      expect(config.get('security').challengeExpirationSeconds).toBe(300);
    });

    it('should accept valid auth token lifetime', () => {
      const configWithTtl: AnchorKitConfig = {
        ...validBaseConfig,
        security: {
          ...validBaseConfig.security,
          authTokenLifetimeSeconds: 7200,
        },
      };
      const config = new AnchorConfig(configWithTtl);
      expect(() => config.validate()).not.toThrow();
      expect(config.get('security').authTokenLifetimeSeconds).toBe(7200);
    });

    it('should use default TTL when not specified', () => {
      const config = new AnchorConfig(validBaseConfig);
      expect(config.get('security').authTokenLifetimeSeconds).toBeUndefined();
    });

    it.each([
      ['challengeExpirationSeconds', 0],
      ['challengeExpirationSeconds', -100],
      ['challengeExpirationSeconds', 1.5],
      ['challengeExpirationSeconds', Number.MAX_SAFE_INTEGER + 1],
      ['challengeExpirationSeconds', Number.NaN],
      ['challengeExpirationSeconds', Number.POSITIVE_INFINITY],
      ['authTokenLifetimeSeconds', 0],
      ['authTokenLifetimeSeconds', -100],
      ['authTokenLifetimeSeconds', 1.5],
      ['authTokenLifetimeSeconds', Number.MAX_SAFE_INTEGER + 1],
      ['authTokenLifetimeSeconds', Number.NaN],
      ['authTokenLifetimeSeconds', Number.POSITIVE_INFINITY],
    ])('should reject invalid %s lifetime value %p', (key, value) => {
      const invalidConfig: AnchorKitConfig = {
        ...validBaseConfig,
        security: {
          ...validBaseConfig.security,
          [key]: value,
        },
      };
      const config = new AnchorConfig(invalidConfig);
      expect(() => config.validate()).toThrow(ConfigError);
      expect(() => config.validate()).toThrow(/must be a safe positive integer/);
    });

    describe('operational supportEmail validation', () => {
      it('should accept valid operational supportEmail', () => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          operational: { supportEmail: 'support@example.com' },
        });
        expect(() => config.validate()).not.toThrow();
      });

      it('should accept omitted operational supportEmail', () => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          operational: { name: 'Test Anchor' },
        });
        expect(() => config.validate()).not.toThrow();
      });

      it('should reject malformed operational supportEmail', () => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          operational: { supportEmail: 'invalid-email-address' },
        });
        expect(() => config.validate()).toThrow(ConfigError);
        expect(() => config.validate()).toThrow(
          /Invalid email format for operational.supportEmail/,
        );
      });
    });

    describe('KYC age bounds validation', () => {
      it.each([
        { kyc: { minAge: 18 }, name: 'minimum age only' },
        { kyc: { maxAge: 120 }, name: 'maximum age only' },
        { kyc: { minAge: 18, maxAge: 120 }, name: 'ordered age range' },
        { kyc: { minAge: 0, maxAge: 0 }, name: 'zero age bounds' },
      ])('should accept valid KYC $name', ({ kyc }) => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          kyc,
        });

        expect(() => config.validate()).not.toThrow();
      });

      it.each([
        { kyc: { minAge: -1 }, message: /kyc\.minAge must be a finite non-negative integer/ },
        { kyc: { maxAge: -1 }, message: /kyc\.maxAge must be a finite non-negative integer/ },
        { kyc: { minAge: 18.5 }, message: /kyc\.minAge must be a finite non-negative integer/ },
        {
          kyc: { maxAge: Number.NaN },
          message: /kyc\.maxAge must be a finite non-negative integer/,
        },
        {
          kyc: { minAge: Number.POSITIVE_INFINITY },
          message: /kyc\.minAge must be a finite non-negative integer/,
        },
        {
          kyc: { minAge: 65, maxAge: 18 },
          message: /kyc\.minAge must be less than or equal to kyc\.maxAge/,
        },
      ])('should reject invalid KYC age bounds %#', ({ kyc, message }) => {
        const config = new AnchorConfig({
          ...validBaseConfig,
          kyc,
        });

        expect(() => config.validate()).toThrow(ConfigError);
        expect(() => config.validate()).toThrow(message);
      });
    });
  });
});
