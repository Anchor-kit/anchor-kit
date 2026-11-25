import { AnchorClient, AnchorClientError } from '@/client/anchor-client.ts';
import { describe, expect, it, vi } from 'vitest';

const endpoints = {
  authEndpoint: 'https://anchor.example/auth',
  transferServer: 'https://anchor.example/sep24',
};

describe('public standard anchor client', () => {
  it('runs challenge, injected signing, and exchange without hiding wallet rejection', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ transaction: 'unsigned-xdr', network_passphrase: 'Test Network' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'access-token' }), { status: 200 }),
      );
    const client = new AnchorClient({ ...endpoints, fetch: fetcher });
    const signChallenge = vi.fn(
      async (input: { transaction: string; networkPassphrase?: string }) => {
        expect(input).toEqual({ transaction: 'unsigned-xdr', networkPassphrase: 'Test Network' });
        return 'signed-xdr';
      },
    );

    await expect(client.authenticate('GACCOUNT', signChallenge)).resolves.toEqual({
      token: 'access-token',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.body).toEqual(
      new URLSearchParams({ transaction: 'signed-xdr' }),
    );

    const rejection = new Error('wallet rejected request');
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ transaction: 'unsigned-xdr' }), { status: 200 }),
    );
    await expect(
      client.authenticate('GACCOUNT', async () => Promise.reject(rejection)),
    ).rejects.toBe(rejection);
  });

  it('refreshes an expired wallet session by requesting and signing a fresh challenge', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transaction: 'challenge-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'expired-token', expires_in: 0 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transaction: 'challenge-2' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token: 'fresh-token', expires_in: 3600 }), { status: 200 }),
      );
    const client = new AnchorClient({ ...endpoints, fetch: fetcher });
    const signer = vi.fn(
      async ({ transaction }: { transaction: string }) => `signed-${transaction}`,
    );
    const session = await client.createWalletSession('GACCOUNT', signer);

    await expect(session.getAccessToken()).resolves.toBe('fresh-token');
    expect(signer).toHaveBeenNthCalledWith(1, { transaction: 'challenge-1' });
    expect(signer).toHaveBeenNthCalledWith(2, { transaction: 'challenge-2' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('rejects malformed responses and mismatched transaction IDs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{invalid', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ transaction: { id: 'other', status: 'completed' } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'interactive_customer_info_needed',
            id: 'tx',
            url: 'https://user:pass@anchor.example/',
          }),
          { status: 200 },
        ),
      );
    const client = new AnchorClient({ ...endpoints, fetch: fetcher });
    await expect(client.getChallenge('GACCOUNT')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(client.getTransaction('token', 'tx')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(client.initiateDeposit('token', { asset_code: 'USDC' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
  it('rejects unsafe endpoint URLs and malformed bearer tokens', async () => {
    expect(
      () => new AnchorClient({ ...endpoints, transferServer: 'http://anchor.example' }),
    ).toThrow(TypeError);
    expect(
      () => new AnchorClient({ ...endpoints, authEndpoint: 'https://user:pass@anchor.example/' }),
    ).toThrow(TypeError);
    expect(
      () =>
        new AnchorClient({ ...endpoints, authEndpoint: 'https://anchor.example/?token=secret' }),
    ).toThrow(TypeError);
    const fetcher = vi.fn<typeof fetch>();
    const client = new AnchorClient({ ...endpoints, fetch: fetcher });
    await expect(client.getTransaction('bad token', 'tx')).rejects.toThrow(TypeError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not expose network failure details', async () => {
    const client = new AnchorClient({
      ...endpoints,
      fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error('private-token')),
    });
    try {
      await client.getTransaction('private-token', 'tx');
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AnchorClientError);
      expect((error as Error).message).not.toContain('private-token');
    }
  });
});
