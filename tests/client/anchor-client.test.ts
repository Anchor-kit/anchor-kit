import { AnchorClient, AnchorClientError } from '@/client/anchor-client.ts';
import { describe, expect, it, vi } from 'vitest';

const endpoints = {
  authEndpoint: 'https://anchor.example/auth',
  transferServer: 'https://anchor.example/sep24',
};

describe('public standard anchor client', () => {
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
