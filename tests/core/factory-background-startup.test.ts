import { Keypair } from '@stellar/stellar-sdk';
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
