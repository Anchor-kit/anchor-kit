import { describe, expect, it, mock } from 'bun:test';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { HorizonNetworkClient } from '../../src/services/horizon-network-client.ts';
import type { InteractiveTransactionRecord } from '../../src/runtime/interfaces.ts';

const account = 'GBYHKEYCYLCF6JTM3FPCVGOVVQS4JU7FEKGTVRQT7CWJHHDK6F5MW4UV';
const hash = 'a'.repeat(64);
const passphrase = 'Test SDF Network ; September 2015';
const config = { horizonUrl: 'https://example.test/horizon/', networkPassphrase: passphrase };
const root = () => Response.json({ network_passphrase: passphrase });

function signedXdr(): string {
  const source = Keypair.random();
  const destination = Keypair.random();
  const transaction = new TransactionBuilder(new Account(source.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: destination.publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  transaction.sign(source);
  return transaction.toXDR();
}

describe('HorizonNetworkClient', () => {
  it('loads an account sequence using only the configured network', async () => {
    const fetcher = mock(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === config.horizonUrl) return root();
      expect(url).toBe(`${config.horizonUrl}accounts/${account}`);
      return Response.json({ account_id: account, sequence: '9223372036854775807' });
    });
    const client = new HorizonNetworkClient(config, fetcher);
    expect(await client.getAccount(account)).toEqual({
      status: 'found',
      value: { accountId: account, sequence: '9223372036854775807' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes missing accounts and unavailable servers', async () => {
    const missing = mock(async (input: string | URL | Request) =>
      input.toString() === config.horizonUrl ? root() : new Response(null, { status: 404 }),
    );
    expect(await new HorizonNetworkClient(config, missing).getAccount(account)).toEqual({
      status: 'not_found',
    });
    const down = mock(async () => new Response(null, { status: 503 }));
    expect(await new HorizonNetworkClient(config, down).getAccount(account)).toEqual({
      status: 'unavailable',
      reason: 'network',
    });
  });

  it('rejects network mismatch, malformed responses and wrong identities', async () => {
    const mismatch = mock(async () => Response.json({ network_passphrase: 'other' }));
    expect(await new HorizonNetworkClient(config, mismatch).getAccount(account)).toEqual({
      status: 'unavailable',
      reason: 'network_mismatch',
    });
    expect(mismatch).toHaveBeenCalledTimes(1);
    const wrong = mock(async (input: string | URL | Request) =>
      input.toString() === config.horizonUrl
        ? root()
        : Response.json({ account_id: 'other', sequence: '12' }),
    );
    expect(await new HorizonNetworkClient(config, wrong).getAccount(account)).toEqual({
      status: 'unavailable',
      reason: 'invalid_response',
    });
  });

  it('returns a confirmed transaction result and preserves failed status', async () => {
    const fetcher = mock(async (input: string | URL | Request) =>
      input.toString() === config.horizonUrl
        ? root()
        : Response.json({ hash, ledger: 123, successful: false }),
    );
    expect(await new HorizonNetworkClient(config, fetcher).getTransaction(hash)).toEqual({
      status: 'found',
      value: { hash, ledger: 123, successful: false },
    });
  });

  it('bounds waiting and reports timeout without exposing provider details', async () => {
    const fetcher = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('private provider details')),
          );
        }),
    );
    expect(
      await new HorizonNetworkClient({ ...config, timeoutMs: 5 }, fetcher).getAccount(account),
    ).toEqual({ status: 'unavailable', reason: 'timeout' });
  });

  it('classifies confirmed, rejected, and timed-out submissions while preserving hash', async () => {
    const xdr = signedXdr();
    const transaction = new Transaction(xdr, passphrase);
    const expectedHash = transaction.hash().toString('hex');
    const confirmed = mock(async (input: string | URL | Request, init?: RequestInit) => {
      if (input.toString() === config.horizonUrl) return root();
      expect(input.toString()).toBe(`${config.horizonUrl}transactions`);
      expect(init?.method).toBe('POST');
      expect(new URLSearchParams(String(init?.body)).get('tx')).toBe(xdr);
      return Response.json({ hash: expectedHash, successful: true, ledger: 123 });
    });
    expect(await new HorizonNetworkClient(config, confirmed).submitTransaction(xdr)).toEqual({
      outcome: 'confirmed',
      hash: expectedHash,
      ledger: 123,
    });

    const rejected = mock(async (input: string | URL | Request) =>
      input.toString() === config.horizonUrl
        ? root()
        : Response.json(
            { extras: { result_codes: { transaction: 'tx_bad_seq' } } },
            { status: 400 },
          ),
    );
    expect(await new HorizonNetworkClient(config, rejected).submitTransaction(xdr)).toEqual({
      outcome: 'rejected',
      hash: expectedHash,
      code: 'tx_bad_seq',
    });

    const timeout = mock(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
        }),
    );
    expect(
      await new HorizonNetworkClient({ ...config, timeoutMs: 5 }, timeout).submitTransaction(xdr),
    ).toEqual({ outcome: 'unknown', hash: expectedHash, reason: 'timeout' });
  });

  it('submits only the signed envelope stored with the matching hash', async () => {
    const xdr = signedXdr();
    const expectedHash = new Transaction(xdr, passphrase).hash().toString('hex');
    const transaction: InteractiveTransactionRecord = {
      id: 'transaction-1',
      account,
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '1',
      status: 'pending_stellar',
      stellarSignedXdr: xdr,
      stellarTransactionHash: expectedHash,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
    const fetcher = mock(async (input: string | URL | Request, init?: RequestInit) => {
      if (input.toString() === config.horizonUrl) return root();
      expect(new URLSearchParams(String(init?.body)).get('tx')).toBe(xdr);
      return Response.json({ hash: expectedHash, successful: true, ledger: 123 });
    });
    const client = new HorizonNetworkClient(config, fetcher);
    await expect(
      client.submitPersistedTransaction(
        { getInteractiveTransactionById: async () => transaction },
        transaction.id,
      ),
    ).resolves.toEqual({ outcome: 'confirmed', hash: expectedHash, ledger: 123 });

    const mismatched = await client.submitPersistedTransaction(
      {
        getInteractiveTransactionById: async () => ({
          ...transaction,
          stellarTransactionHash: 'b'.repeat(64),
        }),
      },
      transaction.id,
    );
    expect(mismatched).toEqual({ outcome: 'not_ready', reason: 'stored_hash_mismatch' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
