import { describe, expect, it, vi } from 'vitest';
import { initiateRailPayment } from '@/services/rail-payment-initiation.ts';
import type { PaymentRailAdapter } from '@/runtime/interfaces.ts';
import type { InteractiveTransactionRecord } from '@/runtime/interfaces.ts';

const transaction: InteractiveTransactionRecord = {
  id: 'transaction-1',
  account: 'GACCOUNT',
  kind: 'deposit',
  assetCode: 'USDC',
  amount: '5',
  status: 'incomplete',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  railReference: null,
};

describe('initiateRailPayment', () => {
  it('persists expected fiat values before creating one stable provider operation', async () => {
    const setInteractiveTransactionRailPayment = vi.fn().mockResolvedValue(true);
    const database = {
      getInteractiveTransactionById: vi.fn().mockResolvedValue(transaction),
      setInteractiveTransactionRailPayment,
    };
    const initiate = vi.fn().mockResolvedValue({
      supported: true,
      value: {
        operationId: 'deposit:mock:transaction-1',
        provider: 'mock',
        reference: 'mock:anchor-transaction-1',
        amount: { amount: '2500', currency: 'NGN' },
        status: 'pending',
      },
    });
    const adapter: PaymentRailAdapter = {
      provider: 'mock',
      capabilities: {
        initiation: true,
        eventVerification: false,
        statusLookup: false,
        recovery: false,
      },
      initiate,
      async verifyEvent() {
        return { supported: false, reason: 'unsupported in test' };
      },
      async getStatus() {
        return { supported: false, reason: 'unsupported in test' };
      },
      async recover() {
        return { supported: false, reason: 'unsupported in test' };
      },
    };

    await expect(
      initiateRailPayment({
        database,
        adapter,
        transactionId: transaction.id,
        amount: '2500',
        currency: 'ngn',
      }),
    ).resolves.toMatchObject({
      operationId: 'deposit:mock:transaction-1',
      reference: 'mock:anchor-transaction-1',
    });
    expect(setInteractiveTransactionRailPayment).toHaveBeenCalledWith({
      transactionId: transaction.id,
      railReference: 'mock:anchor-transaction-1',
      amountIn: '2500',
      currency: 'NGN',
    });
    expect(setInteractiveTransactionRailPayment.mock.invocationCallOrder[0]).toBeLessThan(
      initiate.mock.invocationCallOrder[0]!,
    );
  });

  it('does not create a provider operation when persisted intent conflicts', async () => {
    const initiate = vi.fn();
    const adapter: PaymentRailAdapter = {
      provider: 'mock',
      capabilities: {
        initiation: true,
        eventVerification: false,
        statusLookup: false,
        recovery: false,
      },
      initiate,
      async verifyEvent() {
        return { supported: false, reason: 'unsupported in test' };
      },
      async getStatus() {
        return { supported: false, reason: 'unsupported in test' };
      },
      async recover() {
        return { supported: false, reason: 'unsupported in test' };
      },
    };
    await expect(
      initiateRailPayment({
        database: {
          getInteractiveTransactionById: vi.fn().mockResolvedValue(transaction),
          setInteractiveTransactionRailPayment: vi.fn().mockResolvedValue(false),
        },
        adapter,
        transactionId: transaction.id,
        amount: '2500',
        currency: 'NGN',
      }),
    ).rejects.toMatchObject({ code: 'transaction_conflict' });
    expect(initiate).not.toHaveBeenCalled();
  });
});
