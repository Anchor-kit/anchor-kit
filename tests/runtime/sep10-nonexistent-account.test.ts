import { createAnchor } from '@/index.ts';
import { makeSqliteDbUrlForTests } from '@/runtime/database/sql-database-adapter.ts';
import type { Sep10AccountLookup, Sep10AccountSigners } from '@/runtime/interfaces.ts';
import { Keypair, Transaction } from '@stellar/stellar-sdk';
import { unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type LookupBehavior =
  | { kind: 'missing' }
  | { kind: 'found'; account: Sep10AccountSigners }
  | { kind: 'error' };

describe('SEP-10 authentication for accounts missing on the network', () => {
  const serverKeypair = Keypair.random();
  const databaseUrl = makeSqliteDbUrlForTests();
  const databasePath = databaseUrl.slice('file:'.length);
  const lookupCalls: string[] = [];
  let behavior: LookupBehavior = { kind: 'missing' };
  let anchor: ReturnType<typeof createAnchor>;
  let server: Server;
  let origin: string;

  const lookup: Sep10AccountLookup = {
    async load(accountId: string) {
      lookupCalls.push(accountId);
      if (behavior.kind === 'error') {
        throw new Error('Account lookup upstream is unavailable');
      }
      if (behavior.kind === 'found') {
        return behavior.account;
      }
      return null;
    },
  };

  beforeAll(async () => {
    anchor = createAnchor(
      {
        network: { network: 'testnet' },
        server: {
          homeDomain: 'anchor.example.com',
          interactiveDomain: 'https://anchor.example.com',
        },
        security: {
          sep10SigningKey: serverKeypair.secret(),
          interactiveJwtSecret: 'nonexistent-account-test-secret',
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
      },
      { sep10AccountLookup: lookup },
    );
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

  async function signChallenge(account: string, signers: Keypair[]): Promise<Transaction> {
    const challengeResponse = await fetch(`${origin}/auth?account=${encodeURIComponent(account)}`);
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as {
      transaction: string;
      network_passphrase: string;
    };
    const transaction = new Transaction(challenge.transaction, challenge.network_passphrase);
    transaction.sign(...signers);
    return transaction;
  }

  async function submitChallenge(transaction: Transaction | string) {
    const transactionXdr = typeof transaction === 'string' ? transaction : transaction.toXDR();
    const response = await fetch(`${origin}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ transaction: transactionXdr }),
    });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  it('issues a token for one correct master signature on a missing account', async () => {
    const client = Keypair.random();
    behavior = { kind: 'missing' };

    const result = await submitChallenge(await signChallenge(client.publicKey(), [client]));

    expect(result.status).toBe(200);
    expect(result.body.account).toBe(client.publicKey());
    expect(result.body.token).toEqual(expect.any(String));
    expect(lookupCalls).toContain(client.publicKey());
  });

  it('rejects extra signatures on a missing account', async () => {
    const client = Keypair.random();
    behavior = { kind: 'missing' };

    const result = await submitChallenge(
      await signChallenge(client.publicKey(), [client, Keypair.random()]),
    );

    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty('token');
  });

  it('rejects a duplicated master signature on a missing account', async () => {
    const client = Keypair.random();
    behavior = { kind: 'missing' };

    // Signing twice with the same master key appends a duplicate signature entry.
    const result = await submitChallenge(await signChallenge(client.publicKey(), [client, client]));

    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty('token');
  });

  it('rejects a missing account challenge signed by a non-master key', async () => {
    const client = Keypair.random();
    behavior = { kind: 'missing' };

    const result = await submitChallenge(
      await signChallenge(client.publicKey(), [Keypair.random()]),
    );

    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty('token');
  });

  it('reports lookup outages without issuing a token or treating the account as missing', async () => {
    const client = Keypair.random();
    behavior = { kind: 'error' };

    const result = await submitChallenge(await signChallenge(client.publicKey(), [client]));

    expect(result.status).toBe(502);
    expect(result.body.error).toBe('account_lookup_failed');
    expect(result.body).not.toHaveProperty('token');
  });

  it('rejects a known account that only meets part of its medium threshold', async () => {
    const client = Keypair.random();
    behavior = {
      kind: 'found',
      account: {
        signers: [{ publicKey: client.publicKey(), weight: 1 }],
        thresholds: { low: 1, medium: 2, high: 2 },
      },
    };

    const result = await submitChallenge(await signChallenge(client.publicKey(), [client]));

    expect(result.status).toBe(401);
    expect(result.body).not.toHaveProperty('token');
  });

  it('accepts a known multisig account that meets its medium threshold', async () => {
    const client = Keypair.random();
    const firstSigner = Keypair.random();
    const secondSigner = Keypair.random();
    behavior = {
      kind: 'found',
      account: {
        signers: [
          { publicKey: firstSigner.publicKey(), weight: 1 },
          { publicKey: secondSigner.publicKey(), weight: 1 },
        ],
        thresholds: { low: 1, medium: 2, high: 2 },
      },
    };

    const result = await submitChallenge(
      await signChallenge(client.publicKey(), [firstSigner, secondSigner]),
    );

    expect(result.status).toBe(200);
    expect(result.body.account).toBe(client.publicKey());
    expect(result.body.token).toEqual(expect.any(String));
  });
});
