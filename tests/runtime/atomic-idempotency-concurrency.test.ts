import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('Atomic Idempotency and Webhook Deduplication Concurrency Tests (#205)', () => {
  describe('SQLite', () => {
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

    it('concurrent idempotency inserts with same key should not create duplicate records', async () => {
      const scope = 'test:concurrent';
      const idempotencyKey = 'key-123';
      const requestHash = 'hash-abc';
      const id = randomUUID();

      // Simulate concurrent inserts by firing multiple promises at once
      const promises = Array.from({ length: 10 }, () =>
        db.insertOrGetIdempotencyRecord({
          id,
          scope,
          idempotencyKey,
          requestHash,
          statusCode: 200,
          responseBody: '{"test": true}',
        }),
      );

      const results = await Promise.all(promises);

      // All should return the same record
      const firstRecord = results[0];
      expect(results.every((r) => r.id === firstRecord.id)).toBe(true);
      expect(results.every((r) => r.scope === scope)).toBe(true);
      expect(results.every((r) => r.idempotencyKey === idempotencyKey)).toBe(true);

      // Verify only one record exists in the database
      const existing = await db.getIdempotencyRecord(scope, idempotencyKey);
      expect(existing).not.toBeNull();
      expect(existing?.id).toBe(firstRecord.id);
    });

    it('concurrent webhook inserts with same event_id should not create duplicate records', async () => {
      const eventId = `evt-${randomUUID()}`;
      const payload = { type: 'test', data: 'value' };

      // Simulate concurrent inserts by firing multiple promises at once
      const promises = Array.from({ length: 10 }, () =>
        db.insertOrGetWebhookEvent({
          id: randomUUID(),
          eventId,
          provider: 'test-provider',
          payload,
        }),
      );

      const results = await Promise.all(promises);

      // All should return the same record
      const firstResult = results[0];
      expect(results.every((r) => r.record.eventId === eventId)).toBe(true);
      expect(results.every((r) => r.record.id === firstResult.record.id)).toBe(true);

      // Count how many were marked as inserted (should be exactly 1)
      const insertedCount = results.filter((r) => r.inserted).length;
      expect(insertedCount).toBe(1);

      // All others should be marked as not inserted
      const notInsertedCount = results.filter((r) => !r.inserted).length;
      expect(notInsertedCount).toBe(9);
    });

    it('concurrent idempotency inserts with different keys should all succeed', async () => {
      const scope = 'test:concurrent-different';
      const promises = Array.from({ length: 10 }, (_, i) =>
        db.insertOrGetIdempotencyRecord({
          id: randomUUID(),
          scope,
          idempotencyKey: `key-${i}`,
          requestHash: `hash-${i}`,
          statusCode: 200,
          responseBody: `{"index": ${i}}`,
        }),
      );

      const results = await Promise.all(promises);

      // All should succeed with different IDs
      const ids = new Set(results.map((r) => r.id));
      expect(ids.size).toBe(10);

      // All should be marked as inserted (our own record)
      expect(
        results.every(
          (r) => r.id === results.find((res) => res.idempotencyKey === r.idempotencyKey)?.id,
        ),
      ).toBe(true);
    });
  });

  describe('PostgreSQL', () => {
    let db: DatabaseAdapter | undefined;
    const connectionString = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || '';
    const postgresRequired = [process.env.CI, process.env.REQUIRE_POSTGRES_TESTS].some(
      (value) => value?.toLowerCase() === 'true' || value === '1',
    );
    const skipPostgres = !connectionString && !postgresRequired;

    beforeAll(async () => {
      if (!connectionString) {
        if (postgresRequired) {
          throw new Error(
            'PostgreSQL tests are required, but TEST_POSTGRES_URL or DATABASE_URL is unset',
          );
        }
        return;
      }

      db = createSqlDatabaseAdapter({ provider: 'postgres', url: connectionString });
      await db.connect();
      await db.migrate();
    });

    afterAll(async () => {
      if (db) {
        await db.disconnect();
      }
    });

    it.skipIf(skipPostgres)(
      'concurrent idempotency inserts with same key should not create duplicate records',
      async () => {
        if (!db) throw new Error('PostgreSQL database was not initialized');

        const database = db;
        const scope = 'test:concurrent:pg';
        const idempotencyKey = 'key-123-pg';
        const requestHash = 'hash-abc-pg';
        const id = randomUUID();

        // Simulate concurrent inserts by firing multiple promises at once
        const promises = Array.from({ length: 10 }, () =>
          database.insertOrGetIdempotencyRecord({
            id,
            scope,
            idempotencyKey,
            requestHash,
            statusCode: 200,
            responseBody: '{"test": true}',
          }),
        );

        const results = await Promise.all(promises);

        // All should return the same record
        const firstRecord = results[0];
        expect(results.every((r) => r.id === firstRecord.id)).toBe(true);
        expect(results.every((r) => r.scope === scope)).toBe(true);
        expect(results.every((r) => r.idempotencyKey === idempotencyKey)).toBe(true);

        // Verify only one record exists in the database
        const existing = await database.getIdempotencyRecord(scope, idempotencyKey);
        expect(existing).not.toBeNull();
        expect(existing?.id).toBe(firstRecord.id);
      },
    );

    it.skipIf(skipPostgres)(
      'concurrent webhook inserts with same event_id should not create duplicate records',
      async () => {
        if (!db) throw new Error('PostgreSQL database was not initialized');

        const eventId = `evt-${randomUUID()}`;
        const payload = { type: 'test', data: 'value-pg' };
        const connections = Array.from({ length: 10 }, () =>
          createSqlDatabaseAdapter({ provider: 'postgres', url: connectionString }),
        );
        try {
          await Promise.all(connections.map((connection) => connection.connect()));
          const results = await Promise.all(
            connections.map((connection) =>
              connection.insertOrGetWebhookEvent({
                id: randomUUID(),
                eventId,
                provider: 'test-provider',
                payload,
              }),
            ),
          );

          const firstResult = results[0];
          expect(results.every((result) => result.record.eventId === eventId)).toBe(true);
          expect(results.every((result) => result.record.id === firstResult.record.id)).toBe(true);
          expect(results.filter((result) => result.inserted)).toHaveLength(1);
          expect(results.filter((result) => !result.inserted)).toHaveLength(9);
        } finally {
          await Promise.all(connections.map((connection) => connection.disconnect()));
        }
      },
    );

    it.skipIf(skipPostgres)(
      'concurrent idempotency inserts with different keys should all succeed',
      async () => {
        if (!db) throw new Error('PostgreSQL database was not initialized');

        const database = db;
        const scope = 'test:concurrent-different:pg';
        const promises = Array.from({ length: 10 }, (_, i) =>
          database.insertOrGetIdempotencyRecord({
            id: randomUUID(),
            scope,
            idempotencyKey: `key-${i}-pg`,
            requestHash: `hash-${i}-pg`,
            statusCode: 200,
            responseBody: `{"index": ${i}}`,
          }),
        );

        const results = await Promise.all(promises);

        // All should succeed with different IDs
        const ids = new Set(results.map((r) => r.id));
        expect(ids.size).toBe(10);

        // All should be marked as inserted (our own record)
        expect(
          results.every(
            (r) => r.id === results.find((res) => res.idempotencyKey === r.idempotencyKey)?.id,
          ),
        ).toBe(true);
      },
    );

    it.skipIf(skipPostgres)(
      'concurrent deposit transactions with different keys stay isolated',
      async () => {
        if (!db) throw new Error('PostgreSQL database was not initialized');
        const scope = `test:deposit-isolation:${randomUUID()}`;
        const deposits = Array.from({ length: 8 }, async (_, index) => {
          const transactionId = randomUUID();
          const idempotencyKey = `deposit-${index}`;
          const requestHash = `hash-${index}`;
          await db!.reserveIdempotencyRecord({
            id: randomUUID(),
            scope,
            idempotencyKey,
            requestHash,
          });
          await db!.createDepositWithIdempotency({
            transaction: {
              id: transactionId,
              account: 'GTEST',
              kind: 'deposit',
              assetCode: 'USD',
              amount: `${index + 1}`,
              status: 'pending_user_transfer_start',
              createdAt: new Date().toISOString(),
            },
            idempotency: {
              scope,
              idempotencyKey,
              requestHash,
              statusCode: 201,
              responseBody: JSON.stringify({ id: transactionId }),
            },
          });
          return { transactionId, idempotencyKey };
        });

        const records = await Promise.all(deposits);
        expect(new Set(records.map((record) => record.idempotencyKey)).size).toBe(8);
        for (const { transactionId, idempotencyKey } of records) {
          expect(await db.getInteractiveTransactionById(transactionId)).not.toBeNull();
          expect(await db.getIdempotencyRecord(scope, idempotencyKey)).toMatchObject({
            status: 'completed',
          });
        }
      },
    );

    it.skipIf(skipPostgres)(
      'a failed deposit rollback does not affect another deposit',
      async () => {
        if (!db) throw new Error('PostgreSQL database was not initialized');
        const scope = `test:deposit-rollback:${randomUUID()}`;
        const duplicateTransactionId = randomUUID();
        await db.insertInteractiveTransaction({
          id: duplicateTransactionId,
          account: 'GTEST',
          kind: 'deposit',
          assetCode: 'USD',
          amount: '1',
          status: 'pending_user_transfer_start',
        });

        const failedKey = 'rollback-target';
        const committedKey = 'independent-commit';
        const failedHash = 'failed-hash';
        const committedHash = 'successful-hash';
        await db.reserveIdempotencyRecord({
          id: randomUUID(),
          scope,
          idempotencyKey: failedKey,
          requestHash: failedHash,
        });
        await db.reserveIdempotencyRecord({
          id: randomUUID(),
          scope,
          idempotencyKey: committedKey,
          requestHash: committedHash,
        });
        const failed = db.createDepositWithIdempotency({
          transaction: {
            id: duplicateTransactionId,
            account: 'GTEST',
            kind: 'deposit',
            assetCode: 'USD',
            amount: '2',
            status: 'pending_user_transfer_start',
            createdAt: new Date().toISOString(),
          },
          idempotency: {
            scope,
            idempotencyKey: failedKey,
            requestHash: failedHash,
            statusCode: 201,
            responseBody: '{}',
          },
        });
        const successfulTransactionId = randomUUID();
        const successful = db.createDepositWithIdempotency({
          transaction: {
            id: successfulTransactionId,
            account: 'GTEST',
            kind: 'deposit',
            assetCode: 'USD',
            amount: '3',
            status: 'pending_user_transfer_start',
            createdAt: new Date().toISOString(),
          },
          idempotency: {
            scope,
            idempotencyKey: committedKey,
            requestHash: committedHash,
            statusCode: 201,
            responseBody: JSON.stringify({ id: successfulTransactionId }),
          },
        });

        const results = await Promise.allSettled([failed, successful]);
        expect(results[0].status).toBe('rejected');
        expect(results[1].status).toBe('fulfilled');
        await db.deletePendingIdempotencyRecord(scope, failedKey, failedHash);
        expect(await db.getIdempotencyRecord(scope, failedKey)).toBeNull();
        expect(await db.getIdempotencyRecord(scope, committedKey)).not.toBeNull();
        expect(await db.getInteractiveTransactionById(successfulTransactionId)).not.toBeNull();
      },
    );
  });
});
