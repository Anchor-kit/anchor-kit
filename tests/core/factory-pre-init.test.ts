import { describe, expect, it, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { createAnchor } from '@/index.ts';
import { ConfigError } from '@/core/errors.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';

async function unexpectedDatabaseCall(): Promise<never> {
  throw new Error('Unexpected database adapter method call');
}

describe('AnchorInstance pre-init router access', () => {
  const config = {
    network: { network: 'testnet' as const },
    server: { interactiveDomain: 'https://anchor.example.com' },
    security: {
      sep10SigningKey: Keypair.random().secret(),
      interactiveJwtSecret: 'jwt-test-secret',
      distributionAccountSecret: 'distribution-test-secret',
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
      database: { provider: 'sqlite' as const, url: 'file::memory:' },
      watchers: { enabled: false },
    },
  };

  it('throws ConfigError with init guidance before initialization', () => {
    const anchor = createAnchor(config);

    expect(() => anchor.getExpressRouter()).toThrowError(ConfigError);
    expect(() => anchor.getExpressRouter()).toThrowError(
      'Anchor is not initialized. Call init() first.',
    );
  });

  it('uses and manages the lifecycle of the injected database adapter', async () => {
    const databaseAdapter: DatabaseAdapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      migrate: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      insertAuthChallenge: unexpectedDatabaseCall,
      getAuthChallengeByChallenge: unexpectedDatabaseCall,
      markAuthChallengeConsumed: unexpectedDatabaseCall,
      insertInteractiveTransaction: unexpectedDatabaseCall,
      getInteractiveTransactionById: unexpectedDatabaseCall,
      listPendingTransactionsBefore: unexpectedDatabaseCall,
      updateTransactionStatus: unexpectedDatabaseCall,
      getIdempotencyRecord: unexpectedDatabaseCall,
      insertOrGetIdempotencyRecord: unexpectedDatabaseCall,
      updateIdempotencyRecord: unexpectedDatabaseCall,
      reserveIdempotencyRecord: unexpectedDatabaseCall,
      createDepositWithIdempotency: unexpectedDatabaseCall,
      deletePendingIdempotencyRecord: unexpectedDatabaseCall,
      insertOrGetWebhookEvent: unexpectedDatabaseCall,
      updateWebhookEventStatus: unexpectedDatabaseCall,
      insertOrGetSettlementJob: unexpectedDatabaseCall,
      getSettlementJobByOperationId: unexpectedDatabaseCall,
      listPendingSettlementJobs: unexpectedDatabaseCall,
      updateSettlementJobStatus: unexpectedDatabaseCall,
      insertWatcherTask: unexpectedDatabaseCall,
      listPendingWatcherTasks: unexpectedDatabaseCall,
      updateWatcherTaskStatus: unexpectedDatabaseCall,
      countProcessedWatcherTasks: unexpectedDatabaseCall,
      cleanupOldRecords: unexpectedDatabaseCall,
    };
    const anchor = createAnchor(config, { databaseAdapter });

    await anchor.init();

    expect(databaseAdapter.connect).toHaveBeenCalledTimes(1);
    expect(databaseAdapter.migrate).toHaveBeenCalledTimes(1);

    await anchor.shutdown();

    expect(databaseAdapter.disconnect).toHaveBeenCalledTimes(1);
  });
});
