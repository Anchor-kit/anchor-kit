/**
 * Host-side graceful shutdown behaviour (#610).
 *
 * `docs/graceful-shutdown.md` tells Express hosts to close their HTTP server
 * and then await `anchor.shutdown()`. These cases pin the behaviour that
 * guidance depends on, so the documented example cannot silently drift away
 * from what the code actually does.
 */

import { AnchorInstance } from '@/core/factory.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

const baseConfig = (): Partial<AnchorKitConfig> => ({
  network: { network: 'testnet' },
  server: { port: 3000 },
  security: {
    sep10SigningKey: Keypair.random().secret(),
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
    database: { provider: 'sqlite', url: 'file:unused' },
    watchers: { enabled: false },
  },
});

/** An AnchorInstance whose database adapter records connect/disconnect calls. */
class RecordingAnchor extends AnchorInstance {
  public readonly adapters: DatabaseAdapter[] = [];
  public disconnectShouldThrow = false;

  protected override createDatabaseAdapter(): DatabaseAdapter {
    const adapter = {
      connect: vi.fn().mockResolvedValue(undefined),
      migrate: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(async () => {
        if (this.disconnectShouldThrow) throw new Error('disconnect failed');
      }),
    } as unknown as DatabaseAdapter;
    this.adapters.push(adapter);
    return adapter;
  }
}

describe('host graceful shutdown contract (#610)', () => {
  it('releases the database when the host awaits shutdown after init', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();

    const adapter = anchor.adapters[0];
    expect(adapter?.disconnect).not.toHaveBeenCalled();

    await anchor.shutdown();

    expect(adapter?.disconnect).toHaveBeenCalledTimes(1);
  });

  // The documented example calls shutdown from both SIGINT and SIGTERM, so a
  // second signal must not disconnect the same adapter twice.
  it('is safe to await shutdown more than once', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();

    await anchor.shutdown();
    await anchor.shutdown();
    await anchor.shutdown();

    expect(anchor.adapters[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  // SIGINT and SIGTERM can both arrive before cleanup finishes. The guarantee
  // that matters is that the work runs once; `shutdown` is an `async` method, so
  // it returns a new promise wrapping the cached one rather than that promise
  // itself, and identity is deliberately not asserted here.
  it('deduplicates concurrent shutdown calls', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();

    const first = anchor.shutdown();
    const second = anchor.shutdown();

    await Promise.all([first, second]);
    expect(anchor.adapters[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the anchor was never initialized', async () => {
    const anchor = new RecordingAnchor(baseConfig());

    await expect(anchor.shutdown()).resolves.toBeUndefined();
    // No adapter exists yet, so nothing can have been disconnected.
    expect(anchor.adapters).toHaveLength(0);
  });

  // The guide must not tell hosts to swallow this, so surface it as a fact the
  // documentation can be written against.
  it('propagates a database disconnect failure to the host', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();
    anchor.disconnectShouldThrow = true;

    await expect(anchor.shutdown()).rejects.toThrow('disconnect failed');
  });

  it('can be reinitialized and shut down again after a clean shutdown', async () => {
    const anchor = new RecordingAnchor(baseConfig());

    await anchor.init();
    await anchor.shutdown();
    await anchor.init();
    await anchor.shutdown();

    expect(anchor.adapters).toHaveLength(2);
    expect(anchor.adapters[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(anchor.adapters[1]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it('stops background jobs as part of shutdown', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();
    const stopSpy = vi.spyOn(
      anchor as unknown as { stopBackgroundJobs: () => Promise<void> },
      'stopBackgroundJobs',
    );

    await anchor.shutdown();

    expect(stopSpy).toHaveBeenCalled();
  });
});

// Verifies the strongest claim in the guide: once shutdown resolves, the
// router is no longer usable and the instance can be brought back up.
describe('graceful shutdown documentation claims (#610)', () => {
  it('getExpressRouter is unavailable after shutdown', async () => {
    const anchor = new RecordingAnchor(baseConfig());
    await anchor.init();
    expect(() => anchor.getExpressRouter()).not.toThrow();

    await anchor.shutdown();

    expect(() => anchor.getExpressRouter()).toThrow();
  });
});
