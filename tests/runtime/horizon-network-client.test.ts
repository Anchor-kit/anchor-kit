import { describe, expect, it, mock } from 'bun:test';
import { HorizonNetworkClient } from '../../src/services/horizon-network-client.ts';

const account = 'GBYHKEYCYLCF6JTM3FPCVGOVVQS4JU7FEKGTVRQT7CWJHHDK6F5MW4UV';
const hash = 'a'.repeat(64);
const passphrase = 'Test SDF Network ; September 2015';
const config = { horizonUrl: 'https://example.test/horizon/', networkPassphrase: passphrase };
const root = () => Response.json({ network_passphrase: passphrase });

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
});
