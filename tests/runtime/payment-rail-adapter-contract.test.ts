import { describe, expect, it } from 'vitest';
import type { PaymentRailAdapter } from '../../src/runtime/interfaces.ts';
import type { PaymentRailOperation } from '../../src/types/transaction.ts';

describe('PaymentRailAdapter contract', () => {
  it('can be implemented by a standalone mock and states unsupported capabilities', async () => {
    const operation: PaymentRailOperation = {
      operationId: 'op-1',
      provider: 'mock',
      reference: 'anchor-1',
      providerReference: 'provider-1',
      amount: { amount: '10.25', currency: 'NGN' },
      status: 'pending',
    };
    const adapter: PaymentRailAdapter = {
      provider: 'mock',
      capabilities: {
        initiation: true,
        eventVerification: false,
        statusLookup: true,
        recovery: false,
      },
      async initiate(input) {
        return {
          supported: true,
          value: { ...operation, operationId: input.operationId, reference: input.reference },
        };
      },
      async verifyEvent() {
        return { supported: false, reason: 'Event verification is not implemented by this mock.' };
      },
      async getStatus() {
        return { supported: true, value: operation };
      },
      async recover() {
        return { supported: false, reason: 'Recovery is not implemented by this mock.' };
      },
    };

    const initiated = await adapter.initiate({
      operationId: 'op-1',
      reference: 'anchor-1',
      accountId: 'GACCOUNT',
      amount: { amount: '10.25', currency: 'NGN' },
    });
    const unsupported = await adapter.recover({ operationId: 'op-1', reference: 'anchor-1' });

    expect(initiated).toMatchObject({
      supported: true,
      value: { amount: { amount: '10.25', currency: 'NGN' }, reference: 'anchor-1' },
    });
    expect(unsupported).toEqual({
      supported: false,
      reason: 'Recovery is not implemented by this mock.',
    });
    expect(adapter.capabilities.eventVerification).toBe(false);
  });
});
