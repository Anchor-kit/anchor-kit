import type {
  AnchorKitConfig,
  ExpressLikeMiddleware,
  PaymentParams,
  QueueAdapter,
  QueueJob,
} from '../src/index.ts';
import * as anchorKit from '../src/index.ts';

describe('package root exports', () => {
  it('exposes config, queue, middleware, and payment types from the root entrypoint', () => {
    const noopMiddleware: ExpressLikeMiddleware = (_req, _res, next) => {
      next?.();
      return undefined;
    };

    const job: QueueJob = { type: 'cleanup_records', payload: {} };
    const adapter: QueueAdapter = {
      async enqueue(_job) {},
      async start(_worker) {},
      async stop() {},
    };

    const schema: AnchorKitConfig = {
      network: { network: 'testnet' },
      server: {},
      security: {
        sep10SigningKey: 'key',
        interactiveJwtSecret: 'secret',
        distributionAccountSecret: 'distribution',
      },
      assets: { assets: [] },
      framework: { database: { provider: 'sqlite', url: 'sqlite::memory:' } },
    };

    const paymentParams: PaymentParams = {
      source: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      destination: 'G123',
      amount: '1',
      assetCode: 'USDC',
    };

    expect(typeof noopMiddleware).toBe('function');
    expect(job.type).toBe('cleanup_records');
    expect(adapter).toBeDefined();
    expect(schema.network.network).toBe('testnet');
    expect(paymentParams.destination).toBe('G123');
    expect(typeof anchorKit.utils).toBe('object');
    expect(anchorKit.AnchorKitConfigSchema).toBe(anchorKit.utils.AnchorKitConfigSchema);
  });
});
