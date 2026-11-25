import { describe, expect, it } from 'vitest';
import { MockPaymentRail } from '../../example/mock-payment-rail.ts';

describe('MockPaymentRail', () => {
  it('keeps a stable reference across initiation, duplicate webhook events, and status lookup', async () => {
    const rail = new MockPaymentRail({ delayMs: 10_000 });
    const initiated = await rail.initiate({
      operationId: 'op-1',
      reference: 'anchor-ref-1',
      accountId: 'GACCOUNT',
      amount: { amount: '25.00', currency: 'NGN' },
    });
    expect(initiated.supported).toBe(true);
    if (!initiated.supported) return;

    const replay = await rail.initiate({
      operationId: 'op-1',
      reference: 'anchor-ref-1',
      accountId: 'GACCOUNT',
      amount: { amount: '25.00', currency: 'NGN' },
    });
    const conflictingReplay = await rail.initiate({
      operationId: 'op-1',
      reference: 'anchor-ref-1',
      accountId: 'GACCOUNT',
      amount: { amount: '250.00', currency: 'NGN' },
    });
    expect(replay).toEqual(initiated);
    expect(conflictingReplay).toEqual({
      supported: false,
      reason: 'operationId was reused with different payment details',
    });

    const event = {
      eventId: 'event-1',
      provider: 'mock',
      reference: initiated.value.reference,
      amount: initiated.value.amount,
      status: 'succeeded',
      occurredAt: new Date().toISOString(),
    };
    const rawBody = JSON.stringify(event);
    const first = await rail.verifyEvent({ rawBody });
    const duplicate = await rail.verifyEvent({ rawBody });
    const status = await rail.getStatus({ operationId: 'op-1', reference: 'anchor-ref-1' });

    expect(first).toEqual({ supported: true, value: event });
    expect(duplicate).toEqual(first);
    expect(status).toMatchObject({
      supported: true,
      value: { operationId: 'op-1', reference: 'anchor-ref-1', status: 'succeeded' },
    });
  });

  it('provides deterministic failure fixtures', async () => {
    const rail = new MockPaymentRail({ failInitiation: true });
    await expect(
      rail.initiate({
        operationId: 'op-fail',
        reference: 'anchor-fail',
        accountId: 'GACCOUNT',
        amount: { amount: '1', currency: 'USD' },
      }),
    ).resolves.toEqual({ supported: false, reason: 'mock initiation failure' });
  });
});
