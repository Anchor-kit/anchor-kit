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

    await onStatusChange({}, 'pending_user', 'completed');
    expect(observedStatuses).toEqual(['pending_user', 'completed']);

    const invalidStatusCall = () => {
      // @ts-expect-error Invalid transaction lifecycle status
      void onStatusChange({}, 'pending', 'completed');
    };
    expect(invalidStatusCall).toBeTypeOf('function');
  });
});
