import { createAnchor, makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const databaseUrls: string[] = [];

afterEach(() => {
  for (const databaseUrl of databaseUrls.splice(0)) {
    try {
      unlinkSync(databaseUrl.slice('file:'.length));
    } catch {
      // The adapter may already have removed the temporary database.
    }
  }
});

describe('AnchorInstance background lifecycle', () => {
  it('allows stop-before-start and can still start and stop later', async () => {
    const databaseUrl = makeSqliteDbUrlForTests();
    databaseUrls.push(databaseUrl);

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
        database: { provider: 'sqlite', url: databaseUrl },
      },
    });

    await anchor.init();
    await expect(anchor.stopBackgroundJobs()).resolves.toBeUndefined();
    await anchor.startBackgroundJobs();
    await anchor.stopBackgroundJobs();
    await anchor.shutdown();
  });

  it('rolls back background services when plugin initialization fails and allows retry', async () => {
    const databaseUrl = makeSqliteDbUrlForTests();
    databaseUrls.push(databaseUrl);

    const pluginFailure = new Error('plugin failed');
    const plugin = {
      id: 'failing-plugin',
      attempts: 0,
      async init(instance: { startBackgroundJobs: () => Promise<void> }) {
        this.attempts += 1;
        if (this.attempts === 1) {
          await instance.startBackgroundJobs();
          throw pluginFailure;
        }
      },
    };

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
        database: { provider: 'sqlite', url: databaseUrl },
      },
    });

    anchor.use(plugin as any);
    await expect(anchor.init()).rejects.toThrow(pluginFailure);
    await expect(anchor.init()).resolves.toBeUndefined();
    await anchor.shutdown();
  });

  it('stops the queue and earlier watchers after a watcher startup failure, then retries cleanly', async () => {
    const databaseUrl = makeSqliteDbUrlForTests();
    databaseUrls.push(databaseUrl);

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
        database: { provider: 'sqlite', url: databaseUrl },
      },
    });

    await anchor.init();

    let laterWatcherStarts = 0;
    const queue = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const earlierWatcher = {
      name: 'earlier-watcher',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const laterWatcher = {
      name: 'later-watcher',
      start: vi.fn().mockImplementation(async () => {
        laterWatcherStarts += 1;
        if (laterWatcherStarts === 1) throw startupFailure;
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const startupFailure = new Error('watcher startup failed');
    const internalAnchor = anchor as unknown as {
      queue: typeof queue;
      watchers: typeof earlierWatcher[];
    };
    internalAnchor.queue = queue;
    internalAnchor.watchers = [earlierWatcher, laterWatcher];

    await expect(anchor.startBackgroundJobs()).rejects.toBe(startupFailure);
    expect(earlierWatcher.stop).toHaveBeenCalledTimes(1);
    expect(laterWatcher.stop).not.toHaveBeenCalled();
    expect(queue.stop).toHaveBeenCalledTimes(1);

    await expect(anchor.startBackgroundJobs()).resolves.toBeUndefined();
    expect(queue.start).toHaveBeenCalledTimes(2);
    expect(laterWatcher.start).toHaveBeenCalledTimes(2);

    await anchor.stopBackgroundJobs();
    await anchor.shutdown();
  });
});
