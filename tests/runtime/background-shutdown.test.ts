import { createAnchor, makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const databaseUrls: string[] = [];

afterEach(() => {
  for (const databaseUrl of databaseUrls.splice(0)) {
    try {
      unlinkSync(databaseUrl.slice('file:'.length));
    } catch {
      // The temporary database may already be unavailable.
    }
  }
});

describe('AnchorInstance shutdown', () => {
  it('stops background jobs before disconnecting and is idempotent', async () => {
    const databaseUrl = makeSqliteDbUrlForTests();
    const databasePath = databaseUrl.slice('file:'.length);
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
        watchers: { enabled: true, pollIntervalMs: 20, transactionTimeoutMs: 50 },
      },
    });

    await anchor.init();
    await anchor.startBackgroundJobs();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const processedBeforeShutdown = await anchor.getProcessedWatcherTaskCount();
    expect(processedBeforeShutdown).toBeGreaterThan(0);

    await anchor.shutdown();
    await expect(anchor.shutdown()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const database = new Database(databasePath);
    try {
      const result = database
        .query('SELECT COUNT(*) AS count FROM watcher_tasks WHERE status = ?')
        .get('processed') as { count: number };
      expect(result.count).toBe(processedBeforeShutdown);
    } finally {
      database.close();
    }
  });
});
