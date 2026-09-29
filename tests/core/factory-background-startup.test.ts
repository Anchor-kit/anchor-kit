import { Keypair } from '@stellar/stellar-sdk';
import type { QueueAdapter, QueueJob } from '@/runtime/interfaces.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { describe, expect, it } from 'vitest';
import { createAnchor } from '@/index.ts';

class MockQueueAdapter {
  public started = false;
  public startCalls = 0;
  public worker:
    | ((job: { type: string; payload: Record<string, unknown> }) => Promise<void>)
    | null = null;

  public async start(
    worker: (job: { type: string; payload: Record<string, unknown> }) => Promise<void>,
  ): Promise<void> {
    this.started = true;
    this.startCalls += 1;
    this.worker = worker;
  }

  public async stop(): Promise<void> {
    this.started = false;
  }
}

class MockWatcher {
  public startCalls = 0;
  public async start(): Promise<void> {
    this.startCalls += 1;
  }

  public async stop(): Promise<void> {
    // no-op
  }
}

describe('AnchorInstance concurrent background startup', () => {
  it.each([
    ['uses the operational retention value when both settings are configured', 21, 45, 21],
    ['uses the watcher retention value when the operational setting is absent', undefined, 45, 45],
  ])(
    '%s',
    async (_description, transactionRetentionDays, watcherRetentionDays, expectedRetentionDays) => {
      const anchor = createAnchor({
        network: { network: 'testnet' },
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
        operational:
          transactionRetentionDays === undefined ? undefined : { transactionRetentionDays },
        framework: {
          database: { provider: 'sqlite', url: 'file::memory:' },
          watchers: { retentionDays: watcherRetentionDays },
        },
      });
      const cleanupJobs: QueueJob[] = [];

      await anchor.init();
      const watcher = (anchor as unknown as { watchers: TransactionWatcher[] }).watchers[0];
      (watcher as unknown as { queue: QueueAdapter }).queue = {
        enqueue: async (job) => {
          cleanupJobs.push(job);
        },
        start: async () => undefined,
        stop: async () => undefined,
      };

      await watcher.start();

      expect(cleanupJobs).toContainEqual({
        type: 'cleanup_records',
        payload: { retentionDays: expectedRetentionDays },
      });

      await watcher.stop();
      await anchor.shutdown();
    },
  );

  it('does not start duplicate background work when startBackgroundJobs is called concurrently', async () => {
    const anchor = createAnchor({
      network: { network: 'testnet' },
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
        database: {
          provider: 'sqlite',
          url: 'file::memory:',
        },
      },
    });

    const queue = new MockQueueAdapter();
    const watcher = new MockWatcher();

    await anchor.init();
    (anchor as unknown as { queue: unknown }).queue = queue;
    (anchor as unknown as { watchers: unknown[] }).watchers = [watcher as never];

    await Promise.all([anchor.startBackgroundJobs(), anchor.startBackgroundJobs()]);

    expect(queue.startCalls).toBe(1);
    expect(watcher.startCalls).toBe(1);

    await anchor.stopBackgroundJobs();
    await anchor.shutdown();
  });
});
