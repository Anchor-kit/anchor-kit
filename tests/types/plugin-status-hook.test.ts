import type { AnchorPluginHooks } from '@/types/plugin.ts';
import type { TransactionStatus } from '@/types/transaction-status.ts';
import { describe, expect, it } from 'vitest';

describe('AnchorPluginHooks.onTransactionStatusChange', () => {
  it('accepts current transaction statuses and rejects invalid literals', async () => {
    let observedStatuses: TransactionStatus[] = [];
    const onStatusChange: NonNullable<AnchorPluginHooks['onTransactionStatusChange']> = async (
      _transaction,
      oldStatus,
      newStatus,
    ) => {
      observedStatuses = [oldStatus, newStatus];
    };

    await onStatusChange(
      {
        id: 'deposit-1',
        account: 'GTEST',
        kind: 'deposit',
        assetCode: 'USD',
        amount: '1',
        status: 'pending_user',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      'pending_user',
      'completed',
    );
    expect(observedStatuses).toEqual(['pending_user', 'completed']);

    const invalidStatusCall = () => {
      void onStatusChange(
        {
          id: 'deposit-1',
          account: 'GTEST',
          kind: 'deposit',
          assetCode: 'USD',
          amount: '1',
          status: 'pending_user',
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        // @ts-expect-error Invalid transaction lifecycle status
        'pending',
        'completed',
      );
    };
    expect(invalidStatusCall).toBeTypeOf('function');
  });
});
