import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';

describe('SqlDatabaseAdapter – interactive transaction status updates', () => {
  const dbUrl = makeSqliteDbUrlForTests();
  const dbPath = dbUrl.startsWith('file:') ? dbUrl.slice('file:'.length) : dbUrl;
  let db: DatabaseAdapter;

  beforeAll(async () => {
    db = createSqlDatabaseAdapter({ provider: 'sqlite', url: dbUrl });
    await db.connect();
    await db.migrate();
  });

  afterAll(async () => {
    await db.disconnect();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  it('updates status and reflects the change on fetch', async () => {
    const txId = randomUUID();
    const RealDate = Date;
    let currentTime = new RealDate('2026-01-01T00:00:00.000Z').getTime();

    class MockDate extends RealDate {
      constructor(value?: string | number | Date) {
        super(value === undefined ? currentTime : value);
      }

      static override now(): number {
        return currentTime;
      }
    }

    globalThis.Date = MockDate as DateConstructor;

    try {
      const inserted = await db.insertInteractiveTransaction({
        id: txId,
        account: 'GTEST1234',
        kind: 'deposit',
        assetCode: 'USDC',
        amount: '50.00',
        status: 'pending_user_transfer_start',
      });

      expect(inserted.status).toBe('pending_user_transfer_start');

      currentTime = new RealDate('2026-01-01T00:00:01.000Z').getTime();
      await expect(db.updateTransactionStatus(txId, 'completed')).resolves.toBe(true);

      const fetched = await db.getInteractiveTransactionById(txId);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('completed');
      expect(fetched!.updatedAt).not.toBe(inserted.updatedAt);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it('returns null for getInteractiveTransactionById when the transaction does not exist', async () => {
    const fetched = await db.getInteractiveTransactionById(randomUUID());
    expect(fetched).toBeNull();
  });
});
