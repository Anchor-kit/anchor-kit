import { randomUUID } from 'node:crypto';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const postgresTest = databaseUrl ? describe : describe.skip;

postgresTest('SqlDatabaseAdapter – PostgreSQL integration', () => {
  let db: DatabaseAdapter;

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to run PostgreSQL adapter assertions');
    }

    db = createSqlDatabaseAdapter({ provider: 'postgres', url: databaseUrl });
    await db.connect();
    await db.migrate();
  });

  afterAll(async () => {
    await db?.disconnect();
  });

  it('connects, migrates, and persists interactive transactions', async () => {
    const id = randomUUID();
    const inserted = await db.insertInteractiveTransaction({
      id,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      status: 'pending_user_transfer_start',
    });

    expect(inserted.id).toBe(id);
    expect(await db.getInteractiveTransactionById(id)).toMatchObject({
      id,
      kind: 'deposit',
      status: 'pending_user_transfer_start',
    });
  });

  it('atomically advances a reconciled rail payment and replays its durable job', async () => {
    const transactionId = randomUUID();
    const operationId = `rail-op-${randomUUID()}`;
    const existingOperationId = `existing-op-${randomUUID()}`;
    const duplicateJobId = randomUUID();
    await db.insertOrGetSettlementJob({
      id: duplicateJobId,
      operationId: existingOperationId,
      payloadRef: 'transaction:already-recorded',
    });
    await db.insertInteractiveTransaction({
      id: transactionId,
      account: 'GTEST1234',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '25.00',
      status: 'pending_external',
    });

    await expect(
      db.recordReconciledRailPayment({
        transactionId,
        operationId,
        jobId: duplicateJobId,
      }),
    ).rejects.toThrow();
    await expect(db.getInteractiveTransactionById(transactionId)).resolves.toMatchObject({
      status: 'pending_external',
    });
    await expect(db.getSettlementJobByOperationId(operationId)).resolves.toBeNull();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        db.recordReconciledRailPayment({
          transactionId,
          operationId,
          jobId: randomUUID(),
        }),
      ),
    );
    const enqueued = results.filter((result) => result.outcome === 'enqueued');
    const replays = results.filter((result) => result.outcome === 'replayed');

    expect(enqueued).toHaveLength(1);
    expect(replays).toHaveLength(5);
    const [first] = enqueued;
    if (!first || first.outcome !== 'enqueued') {
      throw new Error('Concurrent reconciled rail payment did not create exactly one job');
    }
    expect(first).toMatchObject({
      transaction: { id: transactionId, status: 'pending_stellar' },
      job: { operationId, status: 'pending' },
    });
    expect(
      new Set(results.map((result) => (result.outcome === 'conflict' ? null : result.job.id))),
    ).toHaveProperty('size', 1);
    await expect(db.getSettlementJobByOperationId(operationId)).resolves.toMatchObject({
      id: first.job.id,
      operationId,
      payloadRef: `transaction:${transactionId}`,
    });
  });

  it('updates customer KYC data only through its associated account', async () => {
    const id = `customer-${randomUUID()}`;
    const accountId = `G${randomUUID().replaceAll('-', '').toUpperCase()}`;
    await db.insertOrGetCustomer({
      id,
      account_id: accountId,
      kyc_data: { status: 'pending' },
    });

    expect(
      await db.updateCustomer({
        id,
        account_id: 'GOTHERACCOUNT',
        kyc_data: { status: 'approved', first_name: 'Ada' },
      }),
    ).toBe(false);
    expect(
      await db.updateCustomer({
        id,
        account_id: accountId,
        email_address: 'ada@example.com',
        kyc_data: { status: 'approved', first_name: 'Ada' },
      }),
    ).toBe(true);
    expect(await db.getCustomerByAccountId(accountId)).toMatchObject({
      account_id: accountId,
      email_address: 'ada@example.com',
      kyc_data: { status: 'approved', first_name: 'Ada' },
    });
  });

  it('atomically deduplicates concurrent deliveries of the same webhook event', async () => {
    const eventId = `evt-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        db.insertOrGetWebhookEvent({
          id: randomUUID(),
          eventId,
          provider: 'ci-test',
          payload: { delivery: index },
        }),
      ),
    );

    expect(results.filter(({ inserted }) => inserted)).toHaveLength(1);
    expect(new Set(results.map(({ record }) => record.id)).size).toBe(1);
    expect(results.every(({ record }) => record.eventId === eventId)).toBe(true);
  });
});
