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
        amountIn: '12345678901234567890.00000001',
        amountOut: '0.00000009',
        amountFee: '0.0000000000000000001',
        currency: 'USD',
        railReference: 'rail-ref-001',
        stellarTransactionHash: 'stellar-hash-001',
        status: 'pending_user_transfer_start',
      });

      expect(inserted.status).toBe('pending_user_transfer_start');
      expect(inserted.amountIn).toBe('12345678901234567890.00000001');
      expect(inserted.amountOut).toBe('0.00000009');
      expect(inserted.amountFee).toBe('0.0000000000000000001');
      expect(inserted.currency).toBe('USD');
      expect(inserted.railReference).toBe('rail-ref-001');
      expect(inserted.stellarTransactionHash).toBe('stellar-hash-001');

      currentTime = new RealDate('2026-01-01T00:00:01.000Z').getTime();
      await db.updateTransactionStatus(txId, 'completed');

      const fetched = await db.getInteractiveTransactionById(txId);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('completed');
      expect(fetched!.amountIn).toBe('12345678901234567890.00000001');
      expect(fetched!.amountOut).toBe('0.00000009');
      expect(fetched!.amountFee).toBe('0.0000000000000000001');
      expect(fetched!.currency).toBe('USD');
      expect(fetched!.railReference).toBe('rail-ref-001');
      expect(fetched!.stellarTransactionHash).toBe('stellar-hash-001');
      expect(fetched!.updatedAt).not.toBe(inserted.updatedAt);
    } finally {
      globalThis.Date = RealDate;
    }
  });
});
