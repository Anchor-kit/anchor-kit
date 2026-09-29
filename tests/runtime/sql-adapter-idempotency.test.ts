import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('SqlDatabaseAdapter deposit idempotency lifecycle', () => {
  const databaseUrl = makeSqliteDbUrlForTests();
  const databasePath = databaseUrl.startsWith('file:')
    ? databaseUrl.slice('file:'.length)
    : databaseUrl;
  let database: DatabaseAdapter;
  let rawDatabase: Database;

  beforeAll(async () => {
    database = createSqlDatabaseAdapter({ provider: 'sqlite', url: databaseUrl });
    await database.connect();
    await database.migrate();
    rawDatabase = new Database(databasePath);
  });

  afterAll(async () => {
    rawDatabase.close();
    await database.disconnect();
    try {
      unlinkSync(databasePath);
    } catch {
      // ignore cleanup errors
    }
  });

  it('rolls back either write failure and allows a safe retry', async () => {
    const scope = `deposit:${randomUUID()}`;
    const idempotencyKey = randomUUID();
    const requestHash = randomUUID();
    const createdAt = new Date().toISOString();

    const makeInput = (transactionId: string) => ({
      transaction: {
        id: transactionId,
        account: 'GTEST',
        kind: 'deposit' as const,
        assetCode: 'USDC',
        amount: '12.5',
        status: 'pending_user_transfer_start' as const,
        createdAt,
      },
      idempotency: {
        scope,
        idempotencyKey,
        requestHash,
        statusCode: 201,
        responseBody: JSON.stringify({ id: transactionId }),
      },
    });

    const firstTransactionId = randomUUID();
    await database.reserveIdempotencyRecord({
      id: randomUUID(),
      scope,
      idempotencyKey,
      requestHash,
    });
    rawDatabase.exec(`
      CREATE TRIGGER fail_deposit_insert
      BEFORE INSERT ON interactive_transactions
      BEGIN SELECT RAISE(FAIL, 'injected transaction insert failure'); END;
    `);

    await expect(
      database.createDepositWithIdempotency(makeInput(firstTransactionId)),
    ).rejects.toThrow('injected transaction insert failure');
    expect(await database.getInteractiveTransactionById(firstTransactionId)).toBeNull();
    expect((await database.getIdempotencyRecord(scope, idempotencyKey))?.status).toBe('pending');
    await database.deletePendingIdempotencyRecord(scope, idempotencyKey, requestHash);
    rawDatabase.exec('DROP TRIGGER fail_deposit_insert');

    const secondTransactionId = randomUUID();
    await database.reserveIdempotencyRecord({
      id: randomUUID(),
      scope,
      idempotencyKey,
      requestHash,
    });
    rawDatabase.exec(`
      CREATE TRIGGER fail_idempotency_completion
      BEFORE UPDATE ON idempotency_keys
      WHEN OLD.status = 'pending' AND NEW.status = 'completed'
      BEGIN SELECT RAISE(FAIL, 'injected response update failure'); END;
    `);

    await expect(
      database.createDepositWithIdempotency(makeInput(secondTransactionId)),
    ).rejects.toThrow('injected response update failure');
    expect(await database.getInteractiveTransactionById(secondTransactionId)).toBeNull();
    expect((await database.getIdempotencyRecord(scope, idempotencyKey))?.status).toBe('pending');
    await database.deletePendingIdempotencyRecord(scope, idempotencyKey, requestHash);
    rawDatabase.exec('DROP TRIGGER fail_idempotency_completion');

    const finalTransactionId = randomUUID();
    const retry = await database.reserveIdempotencyRecord({
      id: randomUUID(),
      scope,
      idempotencyKey,
      requestHash,
    });
    expect(retry.inserted).toBe(true);
    await database.createDepositWithIdempotency(makeInput(finalTransactionId));

    expect(await database.getInteractiveTransactionById(finalTransactionId)).not.toBeNull();
    const completed = await database.getIdempotencyRecord(scope, idempotencyKey);
    expect(completed?.status).toBe('completed');
    expect(completed?.responseBody).toBe(JSON.stringify({ id: finalTransactionId }));
  });
});
