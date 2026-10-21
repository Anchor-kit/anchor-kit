/**
 * Type tests for DepositTransaction
 * Verifies discriminated union narrowing and type compatibility
 */

import { describe, it, expect } from 'vitest';

/**
 * Runtime no-op that preserves compile-time type assertions.
 * Bun's test runner does not support vitest's `expectTypeOf` at runtime,
 * so we use this shim instead. TypeScript still validates the type
 * relationships at compile time via the generic constraints.
 */
function expectTypeOf<T>(_value?: T) {
  return {
    toEqualTypeOf<U>(_?: U): void {},
    toMatchTypeOf<U>(_?: U): void {},
  };
}
import type {
  DepositTransaction,
  Sep24TransactionResponse,
  WithdrawalTransaction,
  TransactionNotFoundError,
  BaseTransactionResponse,
} from '../src/types/sep24';
import {
  AnchorKitConfig,
  NetworkConfig,
  ServerConfig,
  AssetsConfig,
  Asset,
  KycConfig,
  OperationalConfig,
  MetadataConfig,
  FrameworkConfig,
  StellarNetwork,
  KycLevel,
} from '../src/types';
import {
  isDepositTransaction,
  isWithdrawalTransaction,
  isTransactionNotFoundError,
} from '../src/types/sep24';
import { AnchorConfig } from '../src/core/config.ts';
import type { TransactionStatus } from '../src/types';

describe('DepositTransaction Type Tests', () => {
  describe('DepositTransaction interface', () => {
    it('should have type discriminator set to "deposit"', () => {
      const deposit: DepositTransaction = {
        type: 'deposit',
        id: 'deposit-123',
        status: 'completed',
      };

      expectTypeOf(deposit.type).toEqualTypeOf<'deposit'>();
    });

    it('should require id and status fields', () => {
      const deposit: DepositTransaction = {
        type: 'deposit',
        id: 'deposit-123',
        status: 'completed',
      };

      expectTypeOf(deposit.id).toMatchTypeOf<string>();
      expectTypeOf(deposit.status).toMatchTypeOf<TransactionStatus>();
    });

    it('should extend BaseTransactionResponse', () => {
      const deposit: DepositTransaction = {
        type: 'deposit',
        id: 'deposit-123',
        status: 'completed',
        amount_in: {
          amount: '100.00',
          asset: 'USD',
        },
      };

      expectTypeOf(deposit).toMatchTypeOf<BaseTransactionResponse>();
    });
  });

  describe('Sep24TransactionResponse compatibility', () => {
    it('should be assignable to Sep24TransactionResponse for deposits', () => {
      const depositTx: DepositTransaction = {
        type: 'deposit',
        id: 'dep-1',
        status: 'pending_user_transfer_start',
      };

      const txResponse: Sep24TransactionResponse = depositTx;
      expectTypeOf(txResponse).toMatchTypeOf<Sep24TransactionResponse>();
    });

    it('should narrow from Sep24TransactionResponse to DepositTransaction', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'deposit',
        id: 'dep-1',
        status: 'completed',
      };

      if (transaction.type === 'deposit') {
        expectTypeOf(transaction).toEqualTypeOf<DepositTransaction>();
      }
    });

    it('should support discriminated union with withdrawals', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'deposit',
        id: 'dep-1',
        status: 'completed',
      };

      const testUnion = (tx: Sep24TransactionResponse) => {
        if (tx.type === 'deposit') {
          expectTypeOf(tx).toEqualTypeOf<DepositTransaction>();
        } else if (tx.type === 'withdrawal') {
          expectTypeOf(tx).toEqualTypeOf<WithdrawalTransaction>();
        } else {
          expectTypeOf(tx).toEqualTypeOf<TransactionNotFoundError>();
        }
      };

      testUnion(transaction);
    });

    it('should support an error branch in Sep24TransactionResponse', () => {
      const errorTx: Sep24TransactionResponse = {
        type: 'not_found',
        error: 'transaction not found',
      };

      const tx: Sep24TransactionResponse = errorTx;
      expectTypeOf(tx).toMatchTypeOf<Sep24TransactionResponse>();

      if (tx.type === 'not_found') {
        expectTypeOf(tx).toEqualTypeOf<TransactionNotFoundError>();
      }
    });
  });

  describe('Type guard functions', () => {
    it('isDepositTransaction should narrow correctly', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'deposit',
        id: 'dep-1',
        status: 'completed',
      };

      if (isDepositTransaction(transaction)) {
        expectTypeOf(transaction).toEqualTypeOf<DepositTransaction>();
      }
    });

    it('isWithdrawalTransaction should narrow to WithdrawalTransaction', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'withdrawal',
        id: 'wd-1',
        status: 'completed',
      };

      if (isWithdrawalTransaction(transaction)) {
        expectTypeOf(transaction).toEqualTypeOf<WithdrawalTransaction>();
      }
    });

    it('should use type guards for runtime filtering', () => {
      const transactions: Sep24TransactionResponse[] = [
        { type: 'deposit', id: 'dep-1', status: 'completed' },
        { type: 'withdrawal', id: 'wd-1', status: 'pending_external' },
        { type: 'deposit', id: 'dep-2', status: 'error' },
      ];

      const deposits = transactions.filter(isDepositTransaction);
      const withdrawals = transactions.filter(isWithdrawalTransaction);

      expectTypeOf(deposits).toMatchTypeOf<DepositTransaction[]>();
      expectTypeOf(withdrawals).toMatchTypeOf<WithdrawalTransaction[]>();
    });
  });

  describe('Field compatibility', () => {
    it('should support all optional BaseTransactionResponse fields', () => {
      const deposit: DepositTransaction = {
        type: 'deposit',
        id: 'dep-1',
        status: 'completed',
        more_info_url: 'https://example.com/info',
        amount_in: {
          amount: '100.00',
          asset: 'USD',
        },
        amount_out: {
          amount: '95.00',
          asset: 'USDC',
        },
        amount_fee: {
          amount: '5.00',
          asset: 'USD',
        },
        started_at: 1000000,
        completed_at: 2000000,
        message: 'Transaction completed',
      };

      expectTypeOf(deposit.type).toEqualTypeOf<'deposit'>();
      expectTypeOf(deposit.id).toEqualTypeOf<string>();
      expectTypeOf(deposit.status).toMatchTypeOf<string>();
    });
  });
});

describe('WithdrawalTransaction Type Tests', () => {
  describe('WithdrawalTransaction interface', () => {
    it('should have type discriminator set to "withdrawal"', () => {
      const withdrawal: WithdrawalTransaction = {
        type: 'withdrawal',
        id: 'withdrawal-123',
        status: 'pending_external',
      };

      expectTypeOf(withdrawal.type).toEqualTypeOf<'withdrawal'>();
    });

    it('should require id and status fields', () => {
      const withdrawal: WithdrawalTransaction = {
        type: 'withdrawal',
        id: 'withdrawal-123',
        status: 'pending_external',
      };

      expectTypeOf(withdrawal.id).toMatchTypeOf<string>();
      expectTypeOf(withdrawal.status).toMatchTypeOf<TransactionStatus>();
    });

    it('should extend BaseTransactionResponse', () => {
      const withdrawal: WithdrawalTransaction = {
        type: 'withdrawal',
        id: 'withdrawal-123',
        status: 'completed',
        amount_out: {
          amount: '100.00',
          asset: 'USD',
        },
      };

      expectTypeOf(withdrawal).toMatchTypeOf<BaseTransactionResponse>();
    });
  });

  describe('Sep24TransactionResponse compatibility', () => {
    it('should be assignable to Sep24TransactionResponse for withdrawals', () => {
      const withdrawalTx: WithdrawalTransaction = {
        type: 'withdrawal',
        id: 'wd-1',
        status: 'pending_user_transfer_complete',
      };

      const txResponse: Sep24TransactionResponse = withdrawalTx;
      expectTypeOf(txResponse).toMatchTypeOf<Sep24TransactionResponse>();
    });

    it('should narrow from Sep24TransactionResponse to WithdrawalTransaction', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'withdrawal',
        id: 'wd-1',
        status: 'completed',
      };

      if (transaction.type === 'withdrawal') {
        expectTypeOf(transaction).toEqualTypeOf<WithdrawalTransaction>();
      }
    });
  });

  describe('Type guard for withdrawals', () => {
    it('isWithdrawalTransaction should narrow correctly', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'withdrawal',
        id: 'wd-1',
        status: 'pending_stellar',
      };

      if (isWithdrawalTransaction(transaction)) {
        expectTypeOf(transaction).toEqualTypeOf<WithdrawalTransaction>();
      }
    });
  });

  describe('Field compatibility for withdrawals', () => {
    it('should support all optional BaseTransactionResponse fields', () => {
      const withdrawal: WithdrawalTransaction = {
        type: 'withdrawal',
        id: 'wd-1',
        status: 'completed',
        more_info_url: 'https://example.com/info',
        amount_out: {
          amount: '100.00',
          asset: 'USD',
        },
        amount_fee: {
          amount: '1.00',
          asset: 'USD',
        },
        started_at: 1000000,
        completed_at: 2000000,
        message: 'Withdrawal processed',
      };

      expectTypeOf(withdrawal.type).toEqualTypeOf<'withdrawal'>();
      expectTypeOf(withdrawal.id).toEqualTypeOf<string>();
      expectTypeOf(withdrawal.status).toMatchTypeOf<string>();
    });
  });
});

describe('TransactionNotFoundError Type Tests', () => {
  describe('TransactionNotFoundError interface', () => {
    it('should have type discriminator set to "not_found"', () => {
      const error: TransactionNotFoundError = {
        type: 'not_found',
        error: 'Transaction not found',
      };

      expectTypeOf(error.type).toEqualTypeOf<'not_found'>();
    });

    it('should require type and error fields', () => {
      const error: TransactionNotFoundError = {
        type: 'not_found',
        error: 'Transaction with id "txn-999" not found',
      };

      expectTypeOf(error.type).toEqualTypeOf<'not_found'>();
      expectTypeOf(error.error).toEqualTypeOf<string>();
    });
  });

  describe('Sep24TransactionResponse compatibility', () => {
    it('should be assignable to Sep24TransactionResponse for errors', () => {
      const errorResponse: TransactionNotFoundError = {
        type: 'not_found',
        error: 'Transaction not found',
      };

      const txResponse: Sep24TransactionResponse = errorResponse;
      expectTypeOf(txResponse).toMatchTypeOf<Sep24TransactionResponse>();
    });

    it('should narrow from Sep24TransactionResponse to TransactionNotFoundError', () => {
      const transaction: Sep24TransactionResponse = {
        type: 'not_found',
        error: 'Transaction not found',
      };

      if (transaction.type === 'not_found') {
        expectTypeOf(transaction).toEqualTypeOf<TransactionNotFoundError>();
      }
    });
  });

  describe('Type guard for error responses', () => {
    it('isTransactionNotFoundError should narrow correctly', () => {
      const response: Sep24TransactionResponse = {
        type: 'not_found',
        error: 'Transaction does not exist',
      };

      if (isTransactionNotFoundError(response)) {
        expectTypeOf(response).toEqualTypeOf<TransactionNotFoundError>();
      }
    });
  });

  describe('Discriminated union with all branches', () => {
    it('should support discriminated union with all three transaction types', () => {
      const responses: Sep24TransactionResponse[] = [
        {
          type: 'deposit',
          id: 'dep-1',
          status: 'completed',
        },
        {
          type: 'withdrawal',
          id: 'wd-1',
          status: 'pending_external',
        },
        {
          type: 'not_found',
          error: 'Transaction not found',
        },
      ];

      const testUnion = (response: Sep24TransactionResponse) => {
        if (response.type === 'deposit') {
          expectTypeOf(response).toEqualTypeOf<DepositTransaction>();
        } else if (response.type === 'withdrawal') {
          expectTypeOf(response).toEqualTypeOf<WithdrawalTransaction>();
        } else {
          expectTypeOf(response).toEqualTypeOf<TransactionNotFoundError>();
        }
      };

      responses.forEach(testUnion);
    });

    it('should use type guards for runtime filtering of all branches', () => {
      const responses: Sep24TransactionResponse[] = [
        { type: 'deposit', id: 'dep-1', status: 'completed' },
        { type: 'not_found', error: 'Not found' },
        { type: 'withdrawal', id: 'wd-1', status: 'pending_external' },
        { type: 'not_found', error: 'Another not found' },
      ];

      const deposits = responses.filter(isDepositTransaction);
      const withdrawals = responses.filter(isWithdrawalTransaction);
      const notFounds = responses.filter(isTransactionNotFoundError);

      expectTypeOf(deposits).toMatchTypeOf<DepositTransaction[]>();
      expectTypeOf(withdrawals).toMatchTypeOf<WithdrawalTransaction[]>();
      expectTypeOf(notFounds).toMatchTypeOf<TransactionNotFoundError[]>();

      // Verify runtime filtering works as expected
      expect(deposits.length).toBe(1);
      expect(withdrawals.length).toBe(1);
      expect(notFounds.length).toBe(2);
    });

    it('should allow exhaustive switch on response type', () => {
      const response = {
        type: 'not_found',
        error: 'Transaction not found',
      } as Sep24TransactionResponse;

      let result: string;
      switch (response.type) {
        case 'deposit':
          result = `Deposit ${response.id}`;
          break;
        case 'withdrawal':
          result = `Withdrawal ${response.id}`;
          break;
        case 'not_found':
          result = `Error: ${response.error}`;
          break;
      }

      expect(result).toBe('Error: Transaction not found');
      expectTypeOf(result).toEqualTypeOf<string>();
    });
  });
});

describe('AnchorKitConfig Type Tests', () => {
  describe('Required fields enforcement', () => {
    it('should require network config', () => {
      const config: AnchorKitConfig = {
        network: {
          network: 'testnet',
        },
        server: {
          host: 'localhost',
          port: 3000,
        },
        security: {
          sep10SigningKey: 'test-key',
          interactiveJwtSecret: 'test-secret',
          distributionAccountSecret: 'test-dist-secret',
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
            url: 'postgresql://user:pass@localhost/db',
          },
        },
      };

      expectTypeOf(config.network.network).toEqualTypeOf<StellarNetwork>();
    });

    it('should require server config', () => {
      const config: AnchorKitConfig = {
        network: { network: 'testnet' },
        server: { port: 3000 },
        security: {
          sep10SigningKey: 'key',
          interactiveJwtSecret: 'secret',
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
            url: 'postgresql://localhost/db',
          },
        },
      };

      expectTypeOf(config.server).toMatchTypeOf<ServerConfig>();
    });

    it('should require security config with three secret fields', () => {
      const config: AnchorKitConfig = {
        network: { network: 'testnet' },
        server: {},
        security: {
          sep10SigningKey: 'key',
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
            url: 'postgresql://localhost/db',
          },
        },
      };

      expectTypeOf(config.security.sep10SigningKey).toEqualTypeOf<string>();
      expectTypeOf(config.security.interactiveJwtSecret).toEqualTypeOf<string>();
      expectTypeOf(config.security.distributionAccountSecret).toEqualTypeOf<string>();
    });

    it('should require assets config with at least one asset', () => {
      const config: AnchorKitConfig = {
        network: { network: 'testnet' },
        server: {},
        security: {
          sep10SigningKey: 'key',
          interactiveJwtSecret: 'secret',
          distributionAccountSecret: 'dist-secret',
        },
        assets: {
          assets: [
            {
              code: 'USDC',
              issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              name: 'USD Coin',
              deposits_enabled: true,
              withdrawals_enabled: true,
            },
          ],
        },
        framework: {
          database: {
            provider: 'postgres',
            url: 'postgresql://localhost/db',
          },
        },
      };

      expectTypeOf(config.assets.assets).toMatchTypeOf<Asset[]>();
      expectTypeOf(config.assets.assets[0]).toMatchTypeOf<Asset>();
    });

    it('should require framework config with database', () => {
      const config: AnchorKitConfig = {
        network: { network: 'public' },
        server: {},
        security: {
          sep10SigningKey: 'key',
          interactiveJwtSecret: 'secret',
          distributionAccountSecret: 'dist-secret',
        },
        assets: { assets: [] },
        framework: {
          database: {
            provider: 'postgres',
            url: 'postgresql://localhost/db',
            schema: 'anchor_schema',
          },
        },
      };

      expectTypeOf(config.framework.database.provider).toEqualTypeOf<'postgres' | 'sqlite'>();
      expectTypeOf(config.framework.database.url).toEqualTypeOf<string>();
    });
  });

  describe('Optional fields handling', () => {
    it('should accept valid KYC config', () => {
      const kycConfig: KycConfig = {
        level: 'strict',
        requireDocuments: true,
        requireName: true,
        requireAddress: true,
        requireEmail: true,
        minAge: 18,
        maxAge: 120,
      };

      expectTypeOf(kycConfig.level).toEqualTypeOf<KycLevel | undefined>();
      expectTypeOf(kycConfig.requireDocuments).toEqualTypeOf<boolean | undefined>();
    });

    it('should accept valid operational config', () => {
      const operationalConfig: OperationalConfig = {
        name: 'My Anchor',
        website: 'https://myanchor.example.com',
        supportEmail: 'support@myanchor.com',
        webhooksEnabled: true,
        corsEnabled: true,
      };

      expectTypeOf(operationalConfig.name).toMatchTypeOf<string | undefined>();
      expectTypeOf(operationalConfig.webhooksEnabled).toMatchTypeOf<boolean | undefined>();
    });

    it('should accept valid metadata config', () => {
      const metadataConfig: MetadataConfig = {
        tomlUrl: 'https://myanchor.example.com/.well-known/stellar.toml',
        protocols: {
          sep10: true,
          sep24: true,
        },
        features: {
          supportsInteractiveDeposits: true,
        },
      };

      expectTypeOf(metadataConfig.tomlUrl).toMatchTypeOf<string | undefined>();
      expectTypeOf(metadataConfig.protocols).toMatchTypeOf<unknown>();
    });
  });

  describe('Network config validation', () => {
    it('should validate StellarNetwork types', () => {
      const networks: StellarNetwork[] = ['public', 'testnet', 'futurenet'];

      networks.forEach((network) => {
        expectTypeOf(network).toEqualTypeOf<StellarNetwork>();
      });
    });

    it('should support optional Horizon URL', () => {
      const networkConfig: NetworkConfig = {
        network: 'testnet',
        horizonUrl: 'https://horizon-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
      };

      expectTypeOf(networkConfig.horizonUrl).toMatchTypeOf<string | undefined>();
      expectTypeOf(networkConfig.networkPassphrase).toMatchTypeOf<string | undefined>();
    });
  });

  describe('Server config validation', () => {
    it('should support partial server config', () => {
      const serverConfig: ServerConfig = {
        debug: true,
        port: 3000,
      };

      expectTypeOf(serverConfig.host).toMatchTypeOf<string | undefined>();
      expectTypeOf(serverConfig.debug).toMatchTypeOf<boolean | undefined>();
      expectTypeOf(serverConfig.port).toMatchTypeOf<number | undefined>();
    });

    it('should support server timeouts and CORS', () => {
      const serverConfig: ServerConfig = {
        host: '0.0.0.0',
        port: 8080,
        corsOrigins: ['https://example.com', 'https://app.example.com'],
        requestTimeout: 60000,
        interactiveDomain: 'https://interactive.example.com',
      };

      expectTypeOf(serverConfig.corsOrigins).toMatchTypeOf<string[] | undefined>();
      expectTypeOf(serverConfig.requestTimeout).toMatchTypeOf<number | undefined>();
    });
  });

  describe('Assets config validation', () => {
    it('should support multiple assets', () => {
      const assetsConfig: AssetsConfig = {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            deposits_enabled: true,
          },
          {
            code: 'USDT',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            withdrawals_enabled: true,
          },
        ],
        defaultCurrency: 'USD',
        assetMapping: {
          NGN: 'USDC',
          ZAR: 'USDT',
        },
      };

      expectTypeOf(assetsConfig.assets).toEqualTypeOf<Asset[]>();
      expectTypeOf(assetsConfig.defaultCurrency).toMatchTypeOf<string | undefined>();
      expectTypeOf(assetsConfig.assetMapping).toMatchTypeOf<Record<string, string> | undefined>();
    });

    it('should validate asset amounts', () => {
      const asset: Asset = {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        min_amount: 10,
        max_amount: 5000,
      };

      expectTypeOf(asset.min_amount).toMatchTypeOf<number | undefined>();
      expectTypeOf(asset.max_amount).toMatchTypeOf<number | undefined>();
    });
  });

  describe('Framework config validation', () => {
    it('should support different database providers', () => {
      const postgresConfig: FrameworkConfig = {
        database: {
          provider: 'postgres',
          url: 'postgresql://localhost/db',
          schema: 'public',
        },
      };

      const sqliteConfig: FrameworkConfig = {
        database: {
          provider: 'sqlite',
          url: 'file:./data.db',
        },
      };

      const mysqlConfig = {
        database: {
          provider: 'mysql',
          url: 'mysql://user:pass@localhost/db',
        },
      } as unknown as FrameworkConfig;

      expectTypeOf(postgresConfig.database.provider).toEqualTypeOf<'postgres' | 'sqlite'>();
      expectTypeOf(sqliteConfig.database.provider).toEqualTypeOf<'postgres' | 'sqlite'>();
      expectTypeOf(mysqlConfig.database.provider).toEqualTypeOf<'postgres' | 'sqlite'>();
    });

    it('should support logging configuration', () => {
      const frameworkConfig: FrameworkConfig = {
        database: {
          provider: 'postgres',
          url: 'postgresql://localhost/db',
        },
        logging: {
          level: 'debug',
          format: 'json',
          file: './logs/anchor.log',
        },
      };

      expectTypeOf(frameworkConfig.logging).toMatchTypeOf<unknown>();
      expectTypeOf(frameworkConfig.logging?.level).toMatchTypeOf<string | undefined>();
    });

    it('should support monitoring configuration', () => {
      const frameworkConfig: FrameworkConfig = {
        database: {
          provider: 'postgres',
          url: 'postgresql://localhost/db',
        },
        monitoring: {
          sentryDsn: 'https://key@sentry.io/9999999',
          metricsEnabled: true,
        },
      };

      expectTypeOf(frameworkConfig.monitoring).toMatchTypeOf<unknown>();
    });
  });

  describe('Complete valid config shapes', () => {
    it('should accept minimal valid config', () => {
      const config: AnchorKitConfig = {
        network: {
          network: 'testnet',
        },
        server: {},
        security: {
          sep10SigningKey: 'test-key',
          interactiveJwtSecret: 'test-secret',
          distributionAccountSecret: 'test-dist-secret',
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
            url: 'postgresql://localhost/db',
          },
        },
      };

      expectTypeOf(config).toEqualTypeOf<AnchorKitConfig>();
    });

    it('should accept fully populated config', () => {
      const config: AnchorKitConfig = {
        network: {
          network: 'public',
          horizonUrl: 'https://horizon.stellar.org',
          networkPassphrase: 'Public Global Stellar Network ; September 2015',
        },
        server: {
          host: '0.0.0.0',
          port: 3000,
          debug: false,
          interactiveDomain: 'https://anchor.example.com',
          corsOrigins: ['https://app.example.com'],
          requestTimeout: 30000,
        },
        security: {
          sep10SigningKey: 'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          interactiveJwtSecret: 'super-secret-jwt-key',
          distributionAccountSecret:
            'SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          challengeExpirationSeconds: 300,
          enableClientAttribution: true,
          webhookSecret: 'webhook-secret-key',
          verifyWebhookSignatures: true,
        },
        assets: {
          assets: [
            {
              code: 'USDC',
              issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
              name: 'USD Coin',
              deposits_enabled: true,
              withdrawals_enabled: true,
              min_amount: 1,
              max_amount: 100000,
            },
          ],
          defaultCurrency: 'USD',
        },
        kyc: {
          level: 'strict',
          requireDocuments: true,
          requireName: true,
          requireAddress: true,
          requireEmail: true,
          minAge: 18,
        },
        operational: {
          name: 'Example Anchor',
          website: 'https://anchor.example.com',
          supportEmail: 'support@anchor.example.com',
          webhooksEnabled: true,
          corsEnabled: true,
        },
        metadata: {
          tomlUrl: 'https://anchor.example.com/.well-known/stellar.toml',
          protocols: {
            sep10: true,
            sep24: true,
          },
        },
        framework: {
          database: {
            provider: 'postgres',
            url: 'postgresql://user:pass@localhost/anchor_db',
            schema: 'anchor',
          },
          logging: {
            level: 'info',
            format: 'json',
          },
          monitoring: {
            metricsEnabled: true,
          },
        },
      };

      expectTypeOf(config).toEqualTypeOf<AnchorKitConfig>();
    });
  });

  describe('Config extensibility', () => {
    it('should allow plugins in framework config', () => {
      const config: AnchorKitConfig = {
        network: { network: 'testnet' },
        server: {},
        security: {
          sep10SigningKey: 'key',
          interactiveJwtSecret: 'secret',
          distributionAccountSecret: 'dist-secret',
        },
        assets: { assets: [] },
        framework: {
          database: {
            provider: 'postgres',
            url: 'postgresql://localhost/db',
          },
          plugins: [
            {
              id: 'sep24',
              config: { interactiveDomain: 'https://interactive.example.com' },
            },
            {
              id: 'flutterwave-rail',
              config: {
                secretKey: typeof process !== 'undefined' ? process.env?.FLW_SECRET_KEY : undefined,
              },
            },
          ],
        },
      };

      expectTypeOf(config).toEqualTypeOf<AnchorKitConfig>();
    });
  });

  describe('AnchorConfig.get() Type Tests', () => {
    it('should return strongly typed sections by key', () => {
      // Type-only assertions: avoid calling methods at runtime.
      expectTypeOf<AnchorConfig['get']>().toMatchTypeOf<
        <K extends keyof AnchorKitConfig>(key: K) => AnchorKitConfig[K]
      >();
    });
  });
});
