import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PaystackWebhookAdapter, verifyPaystackWebhook } from '@/index.ts';

const secret = 'sk_test_fixture_only';
const fixture = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      event: 'charge.success',
      data: {
        domain: 'test',
        id: 12345,
        status: 'success',
        reference: 'order-1',
        amount: 1230,
        currency: 'NGN',
        paid_at: '2026-11-25T10:00:00.000Z',
        ...overrides,
      },
    }),
  );
const signature = (rawBody: Buffer, key = secret) =>
  createHmac('sha512', key).update(rawBody).digest('hex');

describe('PaystackWebhookAdapter', () => {
  it('verifies exact signed bytes and normalizes official charge.success fields', async () => {
    const rawBody = fixture();
    const adapter = new PaystackWebhookAdapter({ secret, allowTestMode: true });
    await expect(adapter.verifyEvent({ rawBody, signature: signature(rawBody) })).resolves.toEqual({
      supported: true,
      value: {
        eventId: 'charge.success:12345',
        provider: 'paystack',
        reference: 'order-1',
        providerReference: '12345',
        amount: { amount: '12.30', currency: 'NGN' },
        status: 'succeeded',
        occurredAt: '2026-11-25T10:00:00.000Z',
      },
    });
  });

  it('rejects altered raw bytes, wrong signatures, and unapproved test deliveries', () => {
    const rawBody = fixture();
    expect(
      verifyPaystackWebhook({
        rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
        signature: signature(rawBody),
        options: { secret, allowTestMode: true },
      }),
    ).toMatchObject({ supported: false });
    expect(
      verifyPaystackWebhook({
        rawBody,
        signature: '0'.repeat(128),
        options: { secret, allowTestMode: true },
      }),
    ).toMatchObject({ supported: false });
    expect(
      verifyPaystackWebhook({ rawBody, signature: signature(rawBody), options: { secret } }),
    ).toMatchObject({ supported: false, reason: 'Paystack test-mode delivery is not enabled' });
  });

  it('rejects decimal subunits and reports failed charge events without unit coercion', () => {
    const badAmount = fixture({ amount: 12.3 });
    expect(
      verifyPaystackWebhook({
        rawBody: badAmount,
        signature: signature(badAmount),
        options: { secret, allowTestMode: true },
      }),
    ).toMatchObject({
      supported: false,
      reason: 'invalid Paystack transaction amount units',
    });

    const failedBody = Buffer.from(
      JSON.stringify({
        event: 'charge.failed',
        data: {
          domain: 'test',
          id: '54321',
          status: 'failed',
          reference: 'order-2',
          amount: 100,
          currency: 'XOF',
          created_at: '2026-11-25T10:01:00.000Z',
        },
      }),
    );
    expect(
      verifyPaystackWebhook({
        rawBody: failedBody,
        signature: signature(failedBody),
        options: { secret, allowTestMode: true },
      }),
    ).toMatchObject({
      supported: true,
      value: {
        eventId: 'charge.failed:54321',
        amount: { amount: '1', currency: 'XOF' },
        status: 'failed',
      },
    });
  });

  it('accepts the timestamped rotating-secret signature shape within the replay window', () => {
    const rawBody = fixture({ domain: 'live' });
    const rotatingSecret = 'whsec_fixture_only';
    const timestamp = 1_795_600_000;
    const digest = createHmac('sha512', rotatingSecret)
      .update(String(timestamp))
      .update('.')
      .update(rawBody)
      .digest('hex');
    const header = `t=${timestamp},v1=whk_fixture:${digest}`;

    expect(
      verifyPaystackWebhook({
        rawBody,
        signature: header,
        options: { secret: rotatingSecret, now: () => timestamp * 1000 },
      }),
    ).toMatchObject({ supported: true, value: { provider: 'paystack', status: 'succeeded' } });
    expect(
      verifyPaystackWebhook({
        rawBody,
        signature: header,
        options: { secret: rotatingSecret, now: () => (timestamp + 301) * 1000 },
      }),
    ).toMatchObject({ supported: false });
  });
});
