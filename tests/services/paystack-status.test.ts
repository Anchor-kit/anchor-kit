import { describe, expect, it } from 'vitest';
import { getPaystackTestStatus } from '@/index.ts';

const input = { operationId: 'op-1', reference: 'order-1' };
const data = {
  domain: 'test',
  reference: 'order-1',
  amount: 1230,
  currency: 'NGN',
  status: 'success',
};
const response = (body: object) => async () => new Response(JSON.stringify(body), { status: 200 });

describe('Paystack test status', () => {
  it('normalizes the verified test transaction, keeping the API and payment statuses distinct', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const mockFetch = async (url: string, init: RequestInit) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      return new Response(JSON.stringify({ status: true, data }), { status: 200 });
    };
    expect(
      await getPaystackTestStatus(input, { secretKey: 'sk_test_example', fetch: mockFetch }),
    ).toEqual({
      operationId: 'op-1',
      provider: 'paystack',
      reference: 'order-1',
      amount: { amount: '12.30', currency: 'NGN' },
      status: 'succeeded',
    });
    expect(calls).toEqual([
      {
        url: 'https://api.paystack.co/transaction/verify/order-1',
        authorization: 'Bearer sk_test_example',
      },
    ]);
    expect(
      (
        await getPaystackTestStatus(input, {
          secretKey: 'sk_test_example',
          fetch: response({ status: true, data: { ...data, status: 'pending' } }),
        })
      ).status,
    ).toBe('pending');
  });

  it('rejects live keys, mismatched references, live transactions, and unsafe amounts', async () => {
    await expect(getPaystackTestStatus(input, { secretKey: 'sk_live_example' })).rejects.toThrow(
      'test secret',
    );
    for (const bad of [
      { reference: 'other' },
      { domain: 'live' },
      { amount: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(
        getPaystackTestStatus(input, {
          secretKey: 'sk_test_example',
          fetch: response({ status: true, data: { ...data, ...bad } }),
        }),
      ).rejects.toThrow('Invalid Paystack transaction data');
    }
    await expect(
      getPaystackTestStatus(input, {
        secretKey: 'sk_test_example',
        fetch: response({ status: false, data }),
      }),
    ).rejects.toThrow('Invalid Paystack transaction response');
  });

  it('normalizes XOF without fractional digits', async () => {
    expect(
      await getPaystackTestStatus(input, {
        secretKey: 'sk_test_example',
        fetch: response({
          status: true,
          data: { ...data, amount: 1200, currency: 'XOF' },
        }),
      }),
    ).toMatchObject({ amount: { amount: '12', currency: 'XOF' } });
  });
});
