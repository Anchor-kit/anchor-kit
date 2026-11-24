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

  it('completes only a matching confirmed amount, recipient, and hash and replays once', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    const transactionId = 'confirmed-settlement-tx';
    const transactionHash = 'a'.repeat(64);
    await adapter.insertInteractiveTransaction({
      id: transactionId,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      amountOut: '22.50',
      status: 'pending_stellar',
    });

    const first = await adapter.confirmSettlement({
      transactionId,
      transactionHash,
      amount: '22.5000000',
      recipient: 'GTEST1234',
    });
    const replay = await adapter.confirmSettlement({
      transactionId,
      transactionHash: transactionHash.toUpperCase(),
      amount: '22.5',
      recipient: 'GTEST1234',
    });

    expect(first).toMatchObject({
      outcome: 'completed',
      transaction: {
        id: transactionId,
        status: 'completed',
        stellarTransactionHash: transactionHash,
      },
    });
    expect(replay).toMatchObject({
      outcome: 'replayed',
      transaction: {
        id: transactionId,
        status: 'completed',
        stellarTransactionHash: transactionHash,
      },
    });
  });

  it('leaves a settlement pending when the confirmed amount or recipient differs', async () => {
    const url = makeSqliteDbUrlForTests();
    dbPath = url.slice('file:'.length);
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    await adapter.connect();
    await adapter.migrate();
    const transactionId = 'mismatched-settlement-tx';
    await adapter.insertInteractiveTransaction({
      id: transactionId,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      status: 'pending_stellar',
    });

    await expect(
      adapter.confirmSettlement({
        transactionId,
        transactionHash: 'b'.repeat(64),
        amount: '24.99',
        recipient: 'GTEST1234',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict', reason: 'confirmation_mismatch' });
    await expect(
      adapter.confirmSettlement({
        transactionId,
        transactionHash: 'b'.repeat(64),
        amount: '25.00',
        recipient: 'GOTHER1234',
      }),
    ).resolves.toMatchObject({ outcome: 'conflict', reason: 'confirmation_mismatch' });
    await expect(adapter.getInteractiveTransactionById(transactionId)).resolves.toMatchObject({
      status: 'pending_stellar',
      stellarTransactionHash: null,
    });
  });
});
