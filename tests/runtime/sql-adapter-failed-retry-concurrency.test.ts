/**
 * AK-040 – Compare-and-set ownership for failed-event retry
 *
 * Acceptance gate:
 *   - Exactly one concurrent retry caller receives { inserted: true } (execution owner).
 *   - All losing callers receive { inserted: false } with the same canonical stored record.
 *   - All callers see the same record.id (no duplicate rows).
 *
 * Run command:
 *   bun test tests/runtime/sql-adapter-failed-retry-concurrency.test.ts
 *
 * Expected result: all assertions pass (0 failures).
 */

import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('AK-040 – failed-event retry compare-and-set ownership', () => {
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
        // ignore cleanup errors
      }
    });

    it('exactly one concurrent retry acquires execution ownership', async () => {
      const eventId = `evt-cas-${randomUUID()}`;
      const originalId = randomUUID();

      // 1. Insert the event so it exists in a 'pending' state.
      const { record: initial, inserted: firstInsert } = await db.insertOrGetWebhookEvent({
        id: originalId,
        eventId,
        provider: 'test-provider',
        payload: { type: 'payment.initiated' },
      });

      expect(firstInsert).toBe(true);
      expect(initial.status).toBe('pending');

      // 2. Transition the event to 'failed', simulating a processing failure.
      await db.updateWebhookEventStatus({
        id: originalId,
        status: 'failed',
        errorMessage: 'upstream timeout',
      });

      // 3. Fire 10 concurrent retries for the same failed event.
      const CONCURRENCY = 10;
      const retryResults = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          db.insertOrGetWebhookEvent({
            id: randomUUID(), // each caller supplies its own candidate id
            eventId,
            provider: 'test-provider',
            payload: { type: 'payment.retry' },
          }),
        ),
      );

      // All callers must see the same canonical row.
      const uniqueIds = new Set(retryResults.map((r) => r.record.id));
      expect(uniqueIds.size).toBe(1);
      expect([...uniqueIds][0]).toBe(originalId);

      // Exactly one caller must win execution ownership.
      const owners = retryResults.filter((r) => r.inserted);
      const losers = retryResults.filter((r) => !r.inserted);

      expect(owners).toHaveLength(1);
      expect(losers).toHaveLength(CONCURRENCY - 1);

      // The winning record must be reset to 'pending'.
      expect(owners[0].record.status).toBe('pending');
      expect(owners[0].record.errorMessage).toBeNull();

      // Losing callers must also receive a valid record (canonical stored state).
      for (const loser of losers) {
        expect(loser.record.id).toBe(originalId);
        // The loser reads whatever state the winner left – 'pending' is expected
        // because the winner already flipped it, but 'failed' is also a valid
        // read-after-write observation if ordering differs. What must never
        // happen is inserted: true for more than one caller.
        expect(['pending', 'failed']).toContain(loser.record.status);
      }
    });

    it('a second sequential retry after ownership is claimed returns inserted: false', async () => {
      const eventId = `evt-sequential-${randomUUID()}`;
      const originalId = randomUUID();

      await db.insertOrGetWebhookEvent({
        id: originalId,
        eventId,
        provider: 'test-provider',
        payload: { type: 'deposit.created' },
      });

      await db.updateWebhookEventStatus({
        id: originalId,
        status: 'failed',
        errorMessage: 'network error',
      });

      // First retry – should win.
      const { record: winner, inserted: winnerInserted } = await db.insertOrGetWebhookEvent({
        id: randomUUID(),
        eventId,
        provider: 'test-provider',
        payload: { type: 'deposit.retry' },
      });

      expect(winnerInserted).toBe(true);
      expect(winner.status).toBe('pending');

      // Second retry immediately after – event is now 'pending', not 'failed',
      // so this caller must not claim ownership.
      const { record: late, inserted: lateInserted } = await db.insertOrGetWebhookEvent({
        id: randomUUID(),
        eventId,
        provider: 'test-provider',
        payload: { type: 'deposit.retry.2' },
      });

      expect(lateInserted).toBe(false);
      expect(late.id).toBe(originalId);
    });

    it('a processed event is never retried regardless of concurrent callers', async () => {
      const eventId = `evt-processed-${randomUUID()}`;
      const originalId = randomUUID();

      await db.insertOrGetWebhookEvent({
        id: originalId,
        eventId,
        provider: 'test-provider',
        payload: { type: 'payment.completed' },
      });

      await db.updateWebhookEventStatus({ id: originalId, status: 'processed' });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          db.insertOrGetWebhookEvent({
            id: randomUUID(),
            eventId,
            provider: 'test-provider',
            payload: { type: 'payment.duplicate' },
          }),
        ),
      );

      // No caller should claim ownership on a processed event.
      const owners = results.filter((r) => r.inserted);
      expect(owners).toHaveLength(0);

      // All callers see the same processed record.
      const ids = new Set(results.map((r) => r.record.id));
      expect(ids.size).toBe(1);
      expect(results[0].record.status).toBe('processed');
    });
  });
});
