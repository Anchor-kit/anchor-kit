import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';

describe('durable settlement job records', () => {
  let adapter: SqlDatabaseAdapter | undefined;
  let dbPath: string | undefined;

  afterEach(async () => {
    await adapter?.disconnect();
    adapter = undefined;
    if (dbPath) {
      try {
        unlinkSync(dbPath);
      } catch {
        // The adapter may not have created the database file.
      }
      dbPath = undefined;
    }
  });

  it('survives reconnect and reuses the same operation identity on duplicate enqueue', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();

    const first = await adapter.insertOrGetSettlementJob({
      id: 'job-1',
      operationId: 'settlement-1',
      payloadRef: 'transaction:tx-1',
    });
    const duplicate = await adapter.insertOrGetSettlementJob({
      id: 'job-retry',
      operationId: 'settlement-1',
      payloadRef: 'transaction:tx-1',
    });
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe('job-1');

    await adapter.disconnect();
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();

    await expect(adapter.getSettlementJobByOperationId('settlement-1')).resolves.toMatchObject({
      id: 'job-1',
      operationId: 'settlement-1',
      payloadRef: 'transaction:tx-1',
      status: 'pending',
    });
    await expect(adapter.listPendingSettlementJobs(10)).resolves.toHaveLength(1);
    await expect(
      adapter.updateSettlementJobStatus({ operationId: 'settlement-1', status: 'processing' }),
    ).resolves.toBe(true);
  });

  it('rejects reuse of an operation identity with a different payload reference', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    await adapter.insertOrGetSettlementJob({
      id: 'job-1',
      operationId: 'settlement-1',
      payloadRef: 'transaction:tx-1',
    });

    await expect(
      adapter.insertOrGetSettlementJob({
        id: 'job-2',
        operationId: 'settlement-1',
        payloadRef: 'transaction:tx-2',
      }),
    ).rejects.toThrow('different payload reference');
  });
});
