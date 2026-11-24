import { createAnchor } from '@/index.ts';
import { makeSqliteDbUrlForTests } from '@/runtime/database/sql-database-adapter.ts';
import type { KycVerificationProvider } from '@/runtime/interfaces.ts';
import { Keypair } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const JWT_SECRET = 'sep12-customer-test-secret-32-bytes';
const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

function bearer(account: string): string {
  return jwt.sign(
    {
      sub: account,
      iss: 'anchor-kit',
      aud: 'anchor-api',
      scope: 'anchor_api',
      typ: 'access_token',
    },
    JWT_SECRET,
    { expiresIn: 3600 },
  );
}

describe('SEP-12 customer endpoints', () => {
  const databaseUrl = makeSqliteDbUrlForTests();
  const databasePath = databaseUrl.slice('file:'.length);
  const account = Keypair.random().publicKey();
  const otherAccount = Keypair.random().publicKey();
  const verify = vi.fn<KycVerificationProvider['verify']>(async (input) => ({
    decisionId: 'decision-1',
    operationKey: input.operationKey,
    customerId: input.customerId,
    status: 'approved',
    decidedAt: '2026-01-01T00:00:00.000Z',
  }));
  let anchor: ReturnType<typeof createAnchor>;
  let server: Server;
  let origin: string;
  let transactionId: string;
  let otherTransactionId: string;

  beforeAll(async () => {
    const serverKeypair = Keypair.random();
    const provider: KycVerificationProvider = { verify };
    anchor = createAnchor(
      {
        network: { network: 'testnet' },
        server: {
          homeDomain: 'anchor.example.com',
          interactiveDomain: 'https://anchor.example.com',
        },
        security: {
          sep10SigningKey: serverKeypair.secret(),
          interactiveJwtSecret: JWT_SECRET,
          distributionAccountSecret: Keypair.random().secret(),
        },
        assets: {
          assets: [{ code: 'USDC', issuer: ISSUER, deposits_enabled: true }],
        },
        kycRequired: { USDC: ['first_name', 'email_address', 'invoice_id'] },
        framework: { database: { provider: 'sqlite', url: databaseUrl } },
      },
      { kycVerificationProvider: provider },
    );
    await anchor.init();
    server = createServer((req, res) => anchor.getExpressRouter()(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    transactionId = await createDeposit(account);
    otherTransactionId = await createDeposit(otherAccount);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await anchor.shutdown();
    try {
      unlinkSync(databasePath);
    } catch {
      // SQLite may not create a file for an in-memory database.
    }
  });

  async function createDeposit(owner: string): Promise<string> {
    const response = await fetch(`${origin}/transactions/deposit/interactive`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer(owner)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ asset_code: 'USDC', amount: '10' }),
    });
    const body = (await response.json()) as { id: string };
    expect(response.status).toBe(201);
    return body.id;
  }

  it('reports missing fields, submits verified values, and returns status without exposing PII', async () => {
    const query = new URLSearchParams({ transaction_id: transactionId, type: 'sep24' });
    const before = await fetch(`${origin}/customer?${query}`, {
      headers: { authorization: `Bearer ${bearer(account)}` },
    });
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({
      status: 'NEEDS_INFO',
      fields: {
        first_name: { type: 'string' },
        email_address: { type: 'string' },
        invoice_id: { type: 'string' },
      },
    });

    const partial = await fetch(`${origin}/customer`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearer(account)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId, type: 'sep24', first_name: 'Ada' }),
    });
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({
      status: 'NEEDS_INFO',
      fields: {
        email_address: { type: 'string' },
        invoice_id: { type: 'string' },
      },
    });
    expect(verify).not.toHaveBeenCalled();

    const submitted = await fetch(`${origin}/customer`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearer(account)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        transaction_id: transactionId,
        type: 'sep24',
        email_address: 'ada@example.test',
        invoice_id: 'invoice-123',
      }),
    });
    const submittedBody = (await submitted.json()) as Record<string, unknown>;
    expect(submitted.status).toBe(200);
    expect(submittedBody).toMatchObject({
      status: 'ACCEPTED',
      provided_fields: {
        first_name: { type: 'string', status: 'ACCEPTED' },
        email_address: { type: 'string', status: 'ACCEPTED' },
        invoice_id: { type: 'string', status: 'ACCEPTED' },
      },
    });
    expect(JSON.stringify(submittedBody)).not.toContain('ada@example.test');
    expect(verify).toHaveBeenCalledTimes(1);

    const status = await fetch(`${origin}/customer?${query}&id=${submittedBody.id}`, {
      headers: { authorization: `Bearer ${bearer(account)}` },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ id: submittedBody.id, status: 'ACCEPTED' });
  });

  it('rejects unauthenticated, cross-account, unknown customer, and malformed field requests', async () => {
    const query = new URLSearchParams({ transaction_id: transactionId, type: 'sep24' });
    const unauthenticated = await fetch(`${origin}/customer?${query}`);
    expect(unauthenticated.status).toBe(401);

    const foreignTransaction = await fetch(
      `${origin}/customer?${new URLSearchParams({ transaction_id: otherTransactionId, type: 'sep24' })}`,
      { headers: { authorization: `Bearer ${bearer(account)}` } },
    );
    expect(foreignTransaction.status).toBe(403);

    const malformed = await fetch(`${origin}/customer`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearer(account)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ transaction_id: transactionId, type: 'sep24', first_name: 42 }),
    });
    expect(malformed.status).toBe(400);

    const otherCustomerResponse = await fetch(`${origin}/customer`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearer(otherAccount)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transaction_id: otherTransactionId,
        type: 'sep24',
        first_name: 'Grace',
        email_address: 'grace@example.test',
      }),
    });
    expect(otherCustomerResponse.status).toBe(200);
    const otherCustomer = (await otherCustomerResponse.json()) as { id: string };

    const foreignCustomer = await fetch(`${origin}/customer`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${bearer(account)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        transaction_id: transactionId,
        type: 'sep24',
        id: otherCustomer.id,
        first_name: 'Grace',
      }),
    });
    expect(foreignCustomer.status).toBe(404);
  });
});
