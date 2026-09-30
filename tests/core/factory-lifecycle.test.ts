import { AnchorInstance } from '@/core/factory.ts';
import type { AnchorKitConfig } from '@/types/config.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

describe('AnchorInstance lifecycle', () => {
  it('waits for pending init before shutdown and supports later reinitialization', async () => {
    let signalConnectStarted: (() => void) | undefined;
    const connectStarted = new Promise<void>((resolve) => {
      signalConnectStarted = resolve;
    });
    let releaseConnect: (() => void) | undefined;
    const connectGate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const signingKey = Keypair.random().secret();
    const anchor = new DelayedConnectAnchor(
      {
        network: { network: 'testnet' },
        server: { port: 3000 },
        security: {
          sep10SigningKey: signingKey,
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
      },
      connectGate,
      () => signalConnectStarted?.(),
    );

    const firstInit = anchor.init();
    const concurrentInit = anchor.init();
    await connectStarted;

    const shutdown = anchor.shutdown();
    const initDuringShutdown = anchor.init();
    releaseConnect?.();

    await Promise.all([firstInit, concurrentInit, shutdown, initDuringShutdown]);
    await anchor.init();
    expect(anchor.databaseAdapters).toHaveLength(2);
    expect(anchor.databaseAdapters[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(() => anchor.getExpressRouter()).not.toThrow();
    await anchor.shutdown();
    expect(anchor.databaseAdapters[1]?.disconnect).toHaveBeenCalledTimes(1);
  });
});

class DelayedConnectAnchor extends AnchorInstance {
  public readonly databaseAdapters: DatabaseAdapter[] = [];
  private connectCount = 0;

  constructor(
    config: Partial<AnchorKitConfig>,
    private readonly connectGate: Promise<void>,
    private readonly onConnectStart: () => void,
  ) {
    super(config);
  }

  protected override createDatabaseAdapter(): DatabaseAdapter {
    const adapter = {
      connect: vi.fn(async () => {
        this.connectCount += 1;
        if (this.connectCount === 1) {
          this.onConnectStart();
          await this.connectGate;
        }
      }),
      migrate: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseAdapter;
    this.databaseAdapters.push(adapter);
    return adapter;
  }
}
