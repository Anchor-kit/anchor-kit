import { describe, expect, it } from 'vitest';
import { serializeRefunds, type RefundOperation } from '@/index.ts';

describe('serializeRefunds', () => {
  const operation: RefundOperation = {
    transactionId: 'tx-1',
    paymentId: 'payment-1',
    paymentIdType: 'external',
    amount: '9007199254740993.01',
    fee: '0.02',
    status: 'completed',
  };

  it('links to the transaction and sums completed payments exactly', () => {
    expect(
      serializeRefunds('tx-1', [
        operation,
        { ...operation, paymentId: 'payment-2', amount: '0.02', fee: '0.01' },
        { ...operation, status: 'pending' },
      ]),
    ).toEqual({
      amount_refunded: '9007199254740993.03',
      amount_fee: '0.03',
      payments: [
        { id: 'payment-1', id_type: 'external', amount: '9007199254740993.01', fee: '0.02' },
        { id: 'payment-2', id_type: 'external', amount: '0.02', fee: '0.01' },
      ],
    });
  });

  it('rejects refunds for a different transaction and malformed amounts', () => {
    expect(() => serializeRefunds('tx-2', [operation])).toThrow(
      'Refund belongs to another transaction',
    );
    expect(() => serializeRefunds('tx-1', [{ ...operation, amount: '-1' }])).toThrow(
      'Invalid completed refund',
    );
  });
});
