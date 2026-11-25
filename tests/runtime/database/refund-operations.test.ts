import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';
import { serializeRefunds } from '@/services/refund-serialization.ts';

describe('refund operations', () => {
  let adapter: SqlDatabaseAdapter | undefined;
  let path: string | undefined;
  afterEach(async () => {
    await adapter?.disconnect();
    if (path) {
      try {
        unlinkSync(path);
      } catch {
        // The database may not have been created.
      }
    }
  });

  it('persists linked refund records across reconnect and serializes completed payments', async () => {
    const url = makeSqliteDbUrlForTests();
    path = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    await adapter.insertInteractiveTransaction({
      id: 'tx-1',
      account: 'account',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '10',
      status: 'completed',
    });
    const refund = {
      operationId: 'refund-1',
      transactionId: 'tx-1',
      paymentId: 'payment-1',
      paymentIdType: 'external' as const,
      amount: '1.23',
      fee: '0.04',
      status: 'completed' as const,
    };
    await adapter.insertRefundOperation(refund);
    await adapter.insertRefundOperation({
      ...refund,
      operationId: 'pending-refund',
      status: 'pending',
    });
    expect(await adapter.finishRefundOperation('pending-refund', 'failed')).toBe(true);
    expect(await adapter.finishRefundOperation('pending-refund', 'completed')).toBe(false);
    await expect(
      adapter.insertRefundOperation({
        ...refund,
        operationId: 'refund-2',
        transactionId: 'missing',
      }),
    ).rejects.toThrow('Refund transaction not found');
    await expect(adapter.insertRefundOperation(refund)).rejects.toThrow();
    await adapter.disconnect();
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    const records = await adapter.listRefundOperations('tx-1');
    expect(records).toEqual([
      { ...refund, operationId: 'pending-refund', status: 'failed' },
      refund,
    ]);
    expect(serializeRefunds('tx-1', records)).toEqual({
      amount_refunded: '1.23',
      amount_fee: '0.04',
      payments: [{ id: 'payment-1', id_type: 'external', amount: '1.23', fee: '0.04' }],
    });
    expect(await adapter.listRefundOperations('other')).toEqual([]);
  });
});
