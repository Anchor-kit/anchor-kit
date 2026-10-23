import {
  createSqlDatabaseAdapter,
  makeSqliteDbUrlForTests,
} from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('SQLite transaction-field migration', () => {
  it('upgrades a legacy transaction table and preserves exact decimal strings', async () => {
    const databaseUrl = makeSqliteDbUrlForTests();
    const databasePath = databaseUrl.startsWith('file:')
      ? databaseUrl.slice('file:'.length)
      : databaseUrl;
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE interactive_transactions (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        kind TEXT NOT NULL,
        asset_code TEXT NOT NULL,
        amount TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacyDatabase.close();

    const database: DatabaseAdapter = createSqlDatabaseAdapter({
      provider: 'sqlite',
      url: databaseUrl,
    });
    try {
      await database.connect();
      await database.migrate();
      await database.migrate();
      const migratedDatabase = new Database(databasePath);
      expect(
        migratedDatabase
          .prepare('SELECT version FROM anchor_kit_schema_migrations WHERE version = ?')
          .get(1),
      ).toEqual({ version: 1 });
      migratedDatabase.close();
      const transactionId = randomUUID();
      await database.insertInteractiveTransaction({
        id: transactionId,
        account: 'GTEST',
        kind: 'deposit',
        assetCode: 'USDC',
        amount: '0',
        amountIn: '99999999999999999999.123456789',
        amountOut: '0.00000000000000000001',
        amountFee: '123.000000000000000000000001',
        currency: 'EUR',
        railReference: 'legacy-upgrade-rail',
        stellarTransactionHash: 'legacy-upgrade-hash',
        status: 'pending_user_transfer_start',
      });

      expect(await database.getInteractiveTransactionById(transactionId)).toMatchObject({
        amountIn: '99999999999999999999.123456789',
        amountOut: '0.00000000000000000001',
        amountFee: '123.000000000000000000000001',
        currency: 'EUR',
        railReference: 'legacy-upgrade-rail',
        stellarTransactionHash: 'legacy-upgrade-hash',
      });
    } finally {
      await database.disconnect();
      try {
        unlinkSync(databasePath);
      } catch {
        // Ignore cleanup errors for this temporary test database.
      }
    }
  });
});
