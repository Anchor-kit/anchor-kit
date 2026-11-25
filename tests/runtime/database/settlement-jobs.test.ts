import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';
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
    ).rejects.toThrow('require a lease token');
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

  it('commits a reconciled rail transition and settlement job together and replays once', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    const transactionId = 'rail-payment-tx';
    await adapter.insertInteractiveTransaction({
      id: transactionId,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      railReference: 'rail-reference-1',
      status: 'pending_external',
    });

    const failingConnection = new Database(dbPath);
    failingConnection.exec(`
      CREATE TRIGGER reject_settlement_job
      BEFORE INSERT ON settlement_jobs
      BEGIN
        SELECT RAISE(ABORT, 'simulated crash before settlement job insert');
      END;
    `);

    try {
      await expect(
        adapter.recordReconciledRailPayment({
          transactionId,
          operationId: 'rail-operation-1',
          jobId: 'rail-job-1',
        }),
      ).rejects.toThrow('simulated crash before settlement job insert');
      await expect(adapter.getInteractiveTransactionById(transactionId)).resolves.toMatchObject({
        status: 'pending_external',
      });
      await expect(adapter.getSettlementJobByOperationId('rail-operation-1')).resolves.toBeNull();
    } finally {
      failingConnection.exec('DROP TRIGGER reject_settlement_job');
      failingConnection.close();
    }

    const first = await adapter.recordReconciledRailPayment({
      transactionId,
      operationId: 'rail-operation-1',
      jobId: 'rail-job-1',
    });
    const replay = await adapter.recordReconciledRailPayment({
      transactionId,
      operationId: 'rail-operation-1',
      jobId: 'a-different-retry-id',
    });

    expect(first).toMatchObject({
      outcome: 'enqueued',
      transaction: { id: transactionId, status: 'pending_stellar' },
      job: { id: 'rail-job-1', operationId: 'rail-operation-1', status: 'pending' },
    });
    expect(replay).toMatchObject({
      outcome: 'replayed',
      transaction: { id: transactionId, status: 'pending_stellar' },
      job: { id: 'rail-job-1', operationId: 'rail-operation-1', status: 'pending' },
    });
    await expect(adapter.listPendingSettlementJobs(10)).resolves.toHaveLength(1);
  });

  it('does not create a settlement job from a transaction outside the reconciled state', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    await adapter.insertInteractiveTransaction({
      id: 'not-reconciled-tx',
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      status: 'pending_user_transfer_start',
    });

    await expect(
      adapter.recordReconciledRailPayment({
        transactionId: 'not-reconciled-tx',
        operationId: 'unexpected-operation',
        jobId: 'unexpected-job',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict', reason: 'status_mismatch' });
    await expect(adapter.getSettlementJobByOperationId('unexpected-operation')).resolves.toBeNull();
  });
});
