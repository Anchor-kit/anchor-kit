import { Keypair } from '@stellar/stellar-sdk';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { AnchorConfig } from '@/core/config.ts';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';
import { AnchorExpressRouter } from '@/runtime/http/express-router.ts';
import { ACCESS_TOKEN_AUDIENCE, ACCESS_TOKEN_ISSUER } from '@/runtime/http/express-router-impl.ts';

async function exerciseLookup(db: SqlDatabaseAdapter) {
  const owner = Keypair.random().publicKey();
  const other = Keypair.random().publicKey();
  const outsider = Keypair.random().publicKey();
  const secret = 'test-jwt-secret-for-transaction-lookup';
  const config = new AnchorConfig({
    network: { network: 'testnet' },
    server: { homeDomain: 'anchor.example.com', interactiveDomain: 'https://anchor.example.com' },
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
  const id = randomUUID();
  const otherId = randomUUID();
  const hash = randomUUID().replaceAll('-', '').repeat(2);
  const reference = `rail-${randomUUID()}`;
  for (const [transactionId, account] of [
    [id, owner],
    [otherId, other],
  ]) {
    await db.insertInteractiveTransaction({
      id: transactionId,
      account,
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '10',
      amountIn: '10.00',
      amountOut: '9.90',
      amountFee: '0.10',
      stellarTransactionHash: hash,
      railReference: reference,
      status: 'pending_user_transfer_start',
    });
  }
  const unauthorized = await request(app).get('/transaction').query({ id });
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers['cache-control']).toBe('no-store');
  for (const [key, value] of [
    ['id', id],
    ['stellar_transaction_id', hash],
    ['external_transaction_id', reference],
  ]) {
    const found = await request(app)
      .get('/transaction')
      .query({ [key]: value })
      .set('Authorization', `Bearer ${token(owner)}`);
    expect(found.status).toBe(200);
    expect(found.headers['cache-control']).toBe('no-store');
    expect(found.body.transaction).toMatchObject({
      id,
      kind: 'deposit',
      status: 'pending_user_transfer_start',
      amount_in: '10.00',
      amount_out: '9.90',
      amount_fee: '0.10',
      stellar_transaction_id: hash,
      external_transaction_id: reference,
    });
    expect(found.body.transaction.started_at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    const denied = await request(app)
      .get('/transaction')
      .query({ [key]: value })
      .set('Authorization', `Bearer ${token(outsider)}`);
    expect(denied.status).toBe(404);
    expect(denied.headers['cache-control']).toBe('no-store');
  }
  const foreignRecord = await db.getInteractiveTransactionById(id);
  const badAdapter = vi
    .spyOn(db, 'findInteractiveTransaction')
    .mockResolvedValueOnce(foreignRecord);
  const defense = await request(app)
    .get('/transaction')
    .query({ id })
    .set('Authorization', `Bearer ${token(outsider)}`);
  expect(defense.status).toBe(404);
  badAdapter.mockRestore();
  const sameReference = await request(app)
    .get('/transaction')
    .query({ external_transaction_id: reference })
    .set('Authorization', `Bearer ${token(other)}`);
  expect(sameReference.body.transaction.id).toBe(otherId);
  const malformed = await request(app)
    .get('/transaction')
    .query({ id, external_transaction_id: reference })
    .set('Authorization', `Bearer ${token(owner)}`);
  expect(malformed.status).toBe(400);
  expect(malformed.headers['cache-control']).toBe('no-store');
  await db.insertInteractiveTransaction({
    id: randomUUID(),
    account: owner,
    kind: 'deposit',
    assetCode: 'USDC',
    amount: '5',
    railReference: reference,
    status: 'pending_user_transfer_start',
  });
  const ambiguous = await request(app)
    .get('/transaction')
    .query({ external_transaction_id: reference })
    .set('Authorization', `Bearer ${token(owner)}`);
  expect(ambiguous.status).toBe(404);
}

describe('SEP-24 transaction lookup', () => {
  it('scopes all identifiers to the authenticated account on SQLite', async () => {
    const url = makeSqliteDbUrlForTests();
    const db = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await db.connect();
      await db.migrate();
      await exerciseLookup(db);
    } finally {
      await db.disconnect();
      try {
        unlinkSync(url.slice('file:'.length));
      } catch {
        /* Already removed. */
      }
    }
  });
  (process.env.DATABASE_URL ? it : it.skip)('scopes all identifiers on PostgreSQL', async () => {
    const db = new SqlDatabaseAdapter({ provider: 'postgres', url: process.env.DATABASE_URL! });
    try {
      await db.connect();
      await db.migrate();
      await exerciseLookup(db);
    } finally {
      await db.disconnect();
    }
  });
});
