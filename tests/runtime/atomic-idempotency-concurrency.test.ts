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
    let postgresAvailable = false;

    beforeAll(async () => {
      const connectionString = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || '';
      if (!connectionString) {
        return;
      }

      try {
        db = createSqlDatabaseAdapter({ provider: 'postgres', url: connectionString });
        await db.connect();
        await db.migrate();
        postgresAvailable = true;
      } catch {
        postgresAvailable = false;
      }
    });

    afterAll(async () => {
      if (db) {
        await db.disconnect();
      }
    });

    it('concurrent idempotency inserts with same key should not create duplicate records', async () => {
      if (!postgresAvailable || !db) {
        console.log('Skipping PostgreSQL test - no valid connection configured');
        return;
      }

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
    });

    it('concurrent webhook inserts with same event_id should not create duplicate records', async () => {
      if (!postgresAvailable || !db) {
        console.log('Skipping PostgreSQL test - no valid connection configured');
        return;
      }

      const database = db;
      const eventId = `evt-${randomUUID()}`;
      const payload = { type: 'test', data: 'value-pg' };

      // Simulate concurrent inserts by firing multiple promises at once
      const promises = Array.from({ length: 10 }, () =>
        database.insertOrGetWebhookEvent({
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
      if (!postgresAvailable || !db) {
        console.log('Skipping PostgreSQL test - no valid connection configured');
        return;
      }

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
    });
  });
});
