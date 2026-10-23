import { unlinkSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { createAnchor, makeSqliteDbUrlForTests } from '@/core/factory.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { AnchorPlugin } from '@/types/plugin.ts';
import { afterEach, describe, expect, it } from 'vitest';

const databaseUrls: string[] = [];

function createConfig(): { config: AnchorKitConfig; databaseUrl: string } {
  const databaseUrl = makeSqliteDbUrlForTests();
  databaseUrls.push(databaseUrl);
  return {
    databaseUrl,
    config: {
      network: { network: 'testnet' },
      server: { homeDomain: 'anchor.example.com', port: 3000 },
      security: {
        sep10SigningKey: Keypair.random().secret(),
        interactiveJwtSecret: 'test-jwt-secret',
        distributionAccountSecret: 'test-distribution-secret',
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      framework: { database: { provider: 'sqlite', url: databaseUrl } },
    },
  };
}

function expectDatabaseClosed(databaseUrl: string): void {
  const path = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  expect(() => unlinkSync(path)).not.toThrow();
}

describe('plugin cleanup lifecycle', () => {
  afterEach(() => {
    for (const databaseUrl of databaseUrls.splice(0)) {
      const path = databaseUrl.startsWith('file:')
        ? databaseUrl.slice('file:'.length)
        : databaseUrl;
      try {
        unlinkSync(path);
      } catch {
        // The database file may already be removed.
      }
    }
  });

  it('cleans initialized plugins once in reverse order during shutdown', async () => {
    const calls: string[] = [];
    const { config, databaseUrl } = createConfig();
    const anchor = createAnchor(config);
    const first: AnchorPlugin = {
      id: 'first',
      init: () => {
        calls.push('init:first');
      },
      cleanup: () => {
        calls.push('cleanup:first');
      },
    };
    const second: AnchorPlugin = {
      id: 'second',
      init: () => {
        calls.push('init:second');
      },
      cleanup: () => {
        calls.push('cleanup:second');
      },
    };

    await anchor.use(first).use(second).init();
    await anchor.shutdown();
    await anchor.shutdown();
    expect(calls).toEqual(['init:first', 'init:second', 'cleanup:second', 'cleanup:first']);
    expectDatabaseClosed(databaseUrl);
  });

  it('cleans initialized plugins in reverse order when initialization rolls back', async () => {
    const calls: string[] = [];
    const { config, databaseUrl } = createConfig();
    const anchor = createAnchor(config);
    anchor.use({
      id: 'first',
      init: () => {
        calls.push('init:first');
      },
      cleanup: () => {
        calls.push('cleanup:first');
      },
    });
    anchor.use({
      id: 'second',
      init: () => {
        calls.push('init:second');
        throw new Error('plugin initialization failed');
      },
      cleanup: () => {
        calls.push('cleanup:second');
      },
    });

    await expect(anchor.init()).rejects.toThrow('plugin initialization failed');
    expect(calls).toEqual(['init:first', 'init:second', 'cleanup:second', 'cleanup:first']);
    expectDatabaseClosed(databaseUrl);
  });

  it('continues cleanup after failures and exposes them from shutdown', async () => {
    const calls: string[] = [];
    const { config, databaseUrl } = createConfig();
    const anchor = createAnchor(config);
    anchor.use({
      id: 'first',
      init: () => undefined,
      cleanup: () => {
        calls.push('cleanup:first');
        throw new Error('cleanup failed');
      },
    });
    anchor.use({
      id: 'second',
      init: () => undefined,
      cleanup: () => {
        calls.push('cleanup:second');
      },
    });

    await anchor.init();
    await expect(anchor.shutdown()).rejects.toThrow('Anchor shutdown failed');
    expect(calls).toEqual(['cleanup:second', 'cleanup:first']);
    expectDatabaseClosed(databaseUrl);
  });
});
