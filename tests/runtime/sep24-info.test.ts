import express from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { AnchorConfig } from '@/core/config.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';

// A protocol consumer fixture validates the public shape without using the serializer.
function makeApp() {
  const config = new AnchorConfig({
    network: { network: 'testnet' },
    server: { homeDomain: 'anchor.example.com', interactiveDomain: 'https://anchor.example.com' },
    security: {
      sep10SigningKey: Keypair.random().secret(),
      interactiveJwtSecret: 'test-secret',
      distributionAccountSecret: Keypair.random().secret(),
    },
    assets: {
      assets: [
        {
          code: 'USDC',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          deposits_enabled: true,
          withdrawals_enabled: true,
          min_amount: 1,
          max_amount: 100,
        },
        {
          code: 'USDC',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          min_amount: 999,
        },
        { code: 'XLM', deposits_enabled: false, withdrawals_enabled: true },
        {
          code: 'native',
          issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          min_amount: 999,
        },
      ],
    },
    metadata: {
      features: { supportsInteractiveDeposits: true, supportsInteractiveWithdrawals: true },
    },
    framework: { database: { provider: 'sqlite', url: 'file:unused' } },
  });
  const app = express();
  const router = new AnchorExpressRouter({
    config,
    database: {} as DatabaseAdapter,
    webhookProcessor: {
      async process(input) {
        return { duplicate: false, eventId: input.eventId, provider: input.provider };
      },
    },
  });
  app.use(router.getMiddleware());
  return app;
}

describe('SEP-24 info consumer', () => {
  it('returns unauthenticated capabilities without advertising unavailable flows', async () => {
    const response = await request(makeApp()).get('/info').expect(200);
    expect(response.body.deposit).toEqual({
      USDC: { enabled: false, min_amount: 1, max_amount: 100 },
      native: { enabled: false },
    });
    expect(response.body.withdraw).toEqual({
      USDC: { enabled: false },
      native: { enabled: false },
    });
    expect(response.body.fee).toEqual({ enabled: false });
    expect(response.body.features).toEqual({ account_creation: false, claimable_balances: false });
    expect(response.body.metadata.features).toEqual({
      supportsInteractiveDeposits: false,
      supportsInteractiveWithdrawals: false,
    });
    expect(
      response.body.assets.every(
        (asset: { deposits_enabled: boolean; withdrawals_enabled: boolean }) =>
          !asset.deposits_enabled && !asset.withdrawals_enabled,
      ),
    ).toBe(true);
  });
});
