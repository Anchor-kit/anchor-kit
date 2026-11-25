import { Keypair } from '@stellar/stellar-sdk';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { unlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AnchorConfig } from '@/core/config.ts';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from '@/runtime/http/express-router-impl.ts';

async function exerciseHistory(db: SqlDatabaseAdapter) {
  const owner = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  const outsider = Keypair.random().publicKey();
  const secret = 'test-jwt-secret-for-transaction-lookup';
  const config = new AnchorConfig({
    network: { network: 'testnet' },
    server: {
      homeDomain: 'anchor.example.com',
      interactiveDomain: 'https://anchor.example.com',
      corsOrigins: ['https://wallet.example.com'],
    },
    security: {
      sep10SigningKey: Keypair.random().secret(),
      interactiveJwtSecret: secret,
      distributionAccountSecret: Keypair.random().secret(),
    },
    assets: {
      assets: [
        { code: 'USDC', issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' },
      ],
    },
    framework: { database: { provider: 'sqlite', url: 'file:unused' } },
  });
  const app = express();
  app.use(
    new AnchorExpressRouter({
      config,
      database: db,
      webhookProcessor: {
        async process(input) {
          return { duplicate: false, eventId: input.eventId, provider: input.provider };
        },
      },
    }).getMiddleware(),
  );
  const token = (account: string) =>
    jwt.sign(
      {
        sub: account,
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        scope: 'anchor_api',
        typ: 'access_token',
      },
      secret,
    );
  const ids = ['history-a', 'history-b', 'history-c'];
  const timestamp = '2026-11-24T12:00:00.000Z';
  const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(timestamp);
  try {
    for (const id of ids) {
      await db.insertInteractiveTransaction({
        id: `${owner}-${id}`,
        account: owner,
        kind: 'deposit',
        assetCode: 'USDC',
        amount: '10',
        amountIn: '10.00',
        status: 'pending_user_transfer_start',
      });
    }
    await db.insertInteractiveTransaction({
      id: `${other}-foreign`,
      account: other,
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '90',
      status: 'pending_user_transfer_start',
    });
    await db.insertInteractiveTransaction({
      id: `${owner}-EUR`,
      account: owner,
      kind: 'deposit',
      assetCode: 'EUR',
      amount: '90',
      status: 'pending_user_transfer_start',
    });
    await db.insertInteractiveTransaction({
      id: `${owner}-memo`,
      account: `${owner}:123`,
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '90',
      status: 'pending_user_transfer_start',
    });
  } finally {
    clock.mockRestore();
  }
  const get = (query: Record<string, string | number> = {}) =>
    request(app)
      .get('/transactions')
      .query({ asset_code: 'USDC', ...query })
      .set('Authorization', `Bearer ${token(owner)}`);
  const unauthorized = await request(app).get('/transactions').query({ asset_code: 'USDC' });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers['cache-control']).toBe('no-store');
  const first = await get({ limit: 2 });
  expect(first.status).toBe(200);
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.body.transactions.map((tx: { id: string }) => tx.id)).toEqual([
    `${owner}-history-c`,
    `${owner}-history-b`,
  ]);
  expect(first.body.transactions[0]).toMatchObject({
    amount_in: '10.00',
    started_at: timestamp,
    kind: 'deposit',
  });
  const second = await get({ limit: 2, paging_id: `${owner}-history-b` });
  expect(second.body.transactions.map((tx: { id: string }) => tx.id)).toEqual([
    `${owner}-history-a`,
  ]);
  expect((await get({ paging_id: `${owner}-history-a` })).body.transactions).toEqual([]);
  expect((await get({ no_older_than: timestamp, kind: 'deposit' })).body.transactions).toHaveLength(
    3,
  );
  expect((await get({ no_older_than: '2026-11-24T12:00:01Z' })).body.transactions).toEqual([]);
  expect((await get({ kind: 'withdrawal' })).body.transactions).toEqual([]);
  expect((await get({ asset_code: 'NONE' })).body.transactions).toEqual([]);
  const invalidQueries: Array<Record<string, string | number>> = [
    { asset_code: '' },
    { kind: 'withdraw' },
    { limit: 0 },
    { limit: 101 },
    { limit: '2.5' },
    { limit: '1e2' },
    { limit: '' },
    { paging_id: '' },
    { paging_id: 'missing' },
    { paging_id: `${other}-foreign` },
    { paging_id: `${owner}-EUR` },
    { no_older_than: 'yesterday' },
    { no_older_than: '2026-02-30T12:00:00Z' },
    { no_older_than: '' },
  ];
  for (const query of invalidQueries) {
    const result = await get(query);
    expect(result.status, JSON.stringify(query)).toBe(400);
    expect(result.headers['cache-control']).toBe('no-store');
  }
  expect(
    (
      await request(app)
        .get('/transactions?asset_code=USDC&limit=1&limit=2')
        .set('Authorization', `Bearer ${token(owner)}`)
    ).status,
  ).toBe(400);
  expect(
    (
      await request(app)
        .options('/transactions')
        .set('Origin', 'https://wallet.example.com')
        .set('Access-Control-Request-Method', 'GET')
    ).status,
  ).toBe(204);
  expect((await request(app).post('/transactions')).status).toBe(405);
  const foreignRecord = await db.getInteractiveTransactionById(`${other}-foreign`);
  const badAdapter = vi.spyOn(db, 'listTransactions').mockResolvedValueOnce([foreignRecord!]);
  expect((await get()).body.transactions).toEqual([]);
  badAdapter.mockRestore();
  await expect(
    db.listTransactions({ account: owner, assetCode: 'USDC', limit: 101 }),
  ).rejects.toThrow();
  const manyClock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(timestamp);
  try {
    for (let i = 0; i < 105; i++)
      await db.insertInteractiveTransaction({
        id: `${outsider}-${i.toString().padStart(3, '0')}`,
        account: outsider,
        kind: 'deposit',
        assetCode: 'USDC',
        amount: '1',
        status: 'pending_user_transfer_start',
      });
  } finally {
    manyClock.mockRestore();
  }
  const maximum = await request(app)
    .get('/transactions?asset_code=USDC&limit=100')
    .set('Authorization', `Bearer ${token(outsider)}`);
  expect(maximum.body.transactions).toHaveLength(100);
  expect(
    (
      await request(app)
        .get('/transactions?asset_code=USDC')
        .set('Authorization', `Bearer ${token(outsider)}`)
    ).body.transactions,
  ).toHaveLength(10);
}

describe('SEP-24 transaction history', () => {
  it('paginates and scopes history to the authenticated account on SQLite', async () => {
    const url = makeSqliteDbUrlForTests();
    const db = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await db.connect();
      await db.migrate();
      await exerciseHistory(db);
    } finally {
      await db.disconnect();
      try {
        unlinkSync(url.slice('file:'.length));
      } catch {
        /* Already removed. */
      }
    }
  });
  (process.env.DATABASE_URL ? it : it.skip)(
    'paginates and scopes history on PostgreSQL',
    async () => {
      const db = new SqlDatabaseAdapter({ provider: 'postgres', url: process.env.DATABASE_URL! });
      try {
        await db.connect();
        await db.migrate();
        await exerciseHistory(db);
      } finally {
        await db.disconnect();
      }
    },
  );
});
