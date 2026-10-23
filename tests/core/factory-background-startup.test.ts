import { Keypair } from '@stellar/stellar-sdk';
import type { QueueAdapter, QueueJob } from '@/runtime/interfaces.ts';
import { InMemoryQueueAdapter } from '@/runtime/queue/in-memory-queue.ts';
import { TransactionWatcher } from '@/runtime/watchers/transaction-watcher.ts';
import { describe, expect, it } from 'vitest';
import { createAnchor } from '@/index.ts';
import type { AnchorKitConfig } from '@/types/config.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function createQueueTestAnchor(
  queue: Partial<NonNullable<AnchorKitConfig['framework']['queue']>>,
): ReturnType<typeof createAnchor> {
  return createAnchor({
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
      database: { provider: 'sqlite', url: 'file::memory:' },
      queue: { backend: 'memory', ...queue },
      watchers: { enabled: false },
    },
  });
}

class MockQueueAdapter {
  public started = false;
  public startCalls = 0;
  public stopCalls = 0;
  public stopGate: Promise<void> | null = null;
  public stopEntered = deferred();
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
    this.stopCalls += 1;
    this.stopEntered.resolve();
    if (this.stopGate) await this.stopGate;
    this.started = false;
  }
}

class MockWatcher {
  public startCalls = 0;
  public stopCalls = 0;
  public stopGate: Promise<void> | null = null;
  public stopError: Error | null = null;
  public startError: Error | null = null;
  public stopEntered = deferred();
  public async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) {
      const error = this.startError;
      this.startError = null;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopCalls += 1;
    this.stopEntered.resolve();
    if (this.stopGate) await this.stopGate;
    if (this.stopError) {
      const error = this.stopError;
      this.stopError = null;
      throw error;
    }
  }
}

describe('AnchorInstance concurrent background startup', () => {
  it('forwards queue capacity and error handling options from the public factory', async () => {
    const queueErrors: Array<{ job: QueueJob; error: unknown }> = [];
    let signalWorkerError!: () => void;
    const workerFailed = new Promise<void>((resolve) => {
      signalWorkerError = resolve;
    });
    const anchor = createQueueTestAnchor({
      maxPendingJobs: 1,
      onError: (job, error) => {
        queueErrors.push({ job, error });
        signalWorkerError();
      },
    });

    await anchor.init();
    const queue = (anchor as unknown as { queue: InMemoryQueueAdapter }).queue;
    const failingJob = { type: 'unsupported', payload: {} } as unknown as QueueJob;
    await queue.enqueue(failingJob);
    await expect(queue.enqueue(failingJob)).rejects.toThrow(/queue is full/i);

    await anchor.startBackgroundJobs();
    await workerFailed;

    expect(queueErrors).toHaveLength(1);
    expect(queueErrors[0]?.job).toBe(failingJob);
    expect(queueErrors[0]?.error).toMatchObject({ message: 'Unknown queue job type: unsupported' });
    await anchor.shutdown();
  });

  it('validates configured queue capacity and error handler types', () => {
    expect(() => createQueueTestAnchor({ maxPendingJobs: 0 })).toThrow(
      /framework\.queue\.maxPendingJobs must be a positive safe integer/,
    );
    expect(() =>
      createQueueTestAnchor({
        onError: 'not a function' as unknown as (job: QueueJob, error: unknown) => void,
      }),
    ).toThrow(/framework\.queue\.onError must be a function/);
  });

  it('exposes queue counts without exposing queued job payloads', async () => {
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
        database: { provider: 'sqlite', url: 'file::memory:' },
        watchers: { enabled: false },
      },
    });
    await anchor.init();

    const queue = new InMemoryQueueAdapter({ concurrency: 1 });
    (anchor as unknown as { queue: InMemoryQueueAdapter }).queue = queue;
    expect(anchor.getQueueStatus()).toEqual({ pending: 0, active: 0 });

    await queue.enqueue({
      type: 'expire_transaction',
      payload: { transactionId: 'private-transaction-id' },
    });
    expect(anchor.getQueueStatus()).toEqual({ pending: 1, active: 0 });

    let releaseWorker: (() => void) | undefined;
    const workerGate = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    let signalStarted: (() => void) | undefined;
    const workerStarted = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    await queue.start(async () => {
      signalStarted?.();
      await workerGate;
    });
    await workerStarted;
    expect(anchor.getQueueStatus()).toEqual({ pending: 0, active: 1 });

    releaseWorker?.();
    await queue.stop();
    expect(anchor.getQueueStatus()).toEqual({ pending: 0, active: 0 });
    await anchor.shutdown();
  });

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

    const watcherStopGate = deferred();
    const queueStopGate = deferred();
    watcher.stopGate = watcherStopGate.promise;
    queue.stopGate = queueStopGate.promise;

    let stopComplete = false;
    const stops = Promise.all([anchor.stopBackgroundJobs(), anchor.stopBackgroundJobs()]).then(
      () => {
        stopComplete = true;
      },
    );

    await watcher.stopEntered.promise;
    expect(watcher.stopCalls).toBe(1);
    expect(queue.stopCalls).toBe(0);

    watcherStopGate.resolve();
    await queue.stopEntered.promise;
    expect(queue.stopCalls).toBe(1);
    expect(stopComplete).toBe(false);

    queueStopGate.resolve();
    await stops;
    expect(stopComplete).toBe(true);
    await anchor.shutdown();
  });

  it('shares a stop failure with concurrent callers without stopping the service twice', async () => {
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
    const stopError = new Error('watcher stop failed');
    watcher.stopError = stopError;

    await anchor.init();
    (anchor as unknown as { queue: unknown }).queue = queue;
    (anchor as unknown as { watchers: unknown[] }).watchers = [watcher as never];
    await anchor.startBackgroundJobs();

    const results = await Promise.allSettled([
      anchor.stopBackgroundJobs(),
      anchor.stopBackgroundJobs(),
    ]);

    expect(watcher.stopCalls).toBe(1);
    expect(queue.stopCalls).toBe(0);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(
      results.map((result) => (result.status === 'rejected' ? result.reason : undefined)),
    ).toEqual([stopError, stopError]);

    await anchor.stopBackgroundJobs();
    expect(watcher.stopCalls).toBe(2);
    expect(queue.stopCalls).toBe(1);
    await anchor.shutdown();
  });
});
