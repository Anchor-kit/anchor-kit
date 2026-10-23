import { createAnchor } from '@/index.ts';
import { makeSqliteDbUrlForTests } from '@/runtime/database/sql-database-adapter.ts';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('standard SEP-10 JSON endpoint shapes', () => {
  const serverKeypair = Keypair.random();
  const clientKeypair = Keypair.random();
  const databaseUrl = makeSqliteDbUrlForTests();
  const databasePath = databaseUrl.slice('file:'.length);
  let anchor: ReturnType<typeof createAnchor>;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: serverKeypair.secret(),
        interactiveJwtSecret: 'standard-auth-test-secret',
        distributionAccountSecret: Keypair.random().secret(),
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

    server = createServer((req, res) => {
      anchor.getExpressRouter()(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
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

  it('completes standard GET then POST using the transaction field and preserves legacy routes', async () => {
    const standardChallenge = await fetch(
      `${origin}/auth?account=${encodeURIComponent(clientKeypair.publicKey())}`,
    );
    const standardBody = (await standardChallenge.json()) as Record<string, unknown>;
    expect(standardChallenge.status).toBe(200);
    expect(standardBody.transaction).toEqual(expect.any(String));
    expect(standardBody).not.toHaveProperty('challenge');
    expect(standardBody.network_passphrase).toEqual(expect.any(String));

    const signedStandardTransaction = new Transaction(
      String(standardBody.transaction),
      String(standardBody.network_passphrase),
    );
    signedStandardTransaction.sign(clientKeypair);
    const standardToken = await fetch(`${origin}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: signedStandardTransaction.toXDR() }),
    });
    const standardTokenBody = (await standardToken.json()) as Record<string, unknown>;
    expect(standardToken.status).toBe(200);
    expect(standardTokenBody.token).toEqual(expect.any(String));
    expect(standardTokenBody.account).toBe(clientKeypair.publicKey());

    const legacyChallenge = await fetch(
      `${origin}/auth/challenge?account=${encodeURIComponent(clientKeypair.publicKey())}`,
    );
    const legacyBody = (await legacyChallenge.json()) as Record<string, unknown>;
    expect(legacyChallenge.status).toBe(200);
    expect(legacyBody.challenge).toEqual(expect.any(String));
    expect(legacyBody).not.toHaveProperty('transaction');

    const signedLegacyTransaction = new Transaction(
      String(legacyBody.challenge),
      String(legacyBody.network_passphrase),
    );
    signedLegacyTransaction.sign(clientKeypair);
    const legacyToken = await fetch(`${origin}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: clientKeypair.publicKey(),
        challenge: signedLegacyTransaction.toXDR(),
      }),
    });
    expect(legacyToken.status).toBe(200);
    expect(await legacyToken.json()).toEqual(
      expect.objectContaining({ account: clientKeypair.publicKey() }),
    );
  });
});
