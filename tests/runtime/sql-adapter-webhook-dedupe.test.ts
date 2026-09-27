import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('SqlDatabaseAdapter – webhook event deduplication (sqlite)', () => {
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

  it('first insert returns inserted: true with the new record', async () => {
    const eventId = `evt-${randomUUID()}`;
    const payload = { type: 'payment.completed', amount: '100' };

    const result = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });

    expect(result.inserted).toBe(true);
    expect(result.record.eventId).toBe(eventId);
    expect(result.record.provider).toBe('test-provider');
    expect(result.record.status).toBe('pending');
    expect(result.record.payload).toEqual(payload);
    expect(result.record.processedAt).toBeNull();
    expect(result.record.errorMessage).toBeNull();
  });

  it('second insert with same event_id returns inserted: false and the existing record', async () => {
    const eventId = `evt-${randomUUID()}`;
    const payload = { type: 'payment.completed', amount: '200' };
    const firstId = randomUUID();

    const first = await db.insertOrGetWebhookEvent({
      id: firstId,
      eventId,
      provider: 'test-provider',
      payload,
    });
    expect(first.inserted).toBe(true);

    const duplicate = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: { type: 'tampered', amount: '999' },
    });

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe(firstId);
    expect(duplicate.record.eventId).toBe(eventId);
    expect(duplicate.record.payload).toEqual(payload);
  });

  it('different event_ids are each inserted independently', async () => {
    const eventIdA = `evt-${randomUUID()}`;
    const eventIdB = `evt-${randomUUID()}`;

    const resultA = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId: eventIdA,
      provider: 'test-provider',
      payload: { seq: 1 },
    });

    const resultB = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId: eventIdB,
      provider: 'test-provider',
      payload: { seq: 2 },
    });

    expect(resultA.inserted).toBe(true);
    expect(resultB.inserted).toBe(true);
    expect(resultA.record.eventId).toBe(eventIdA);
    expect(resultB.record.eventId).toBe(eventIdB);
  });

  it('after marking processed, fetching the same event_id returns status=processed, non-null processedAt, and null errorMessage', async () => {
    const eventId = `evt-${randomUUID()}`;
    const payload = { type: 'deposit.completed', amount: '50' };

    // Insert the event
    const { record: inserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });
    expect(inserted.status).toBe('pending');
    expect(inserted.processedAt).toBeNull();

    // Mark it as processed (no errorMessage)
    await db.updateWebhookEventStatus({
      id: inserted.id,
      status: 'processed',
    });

    // Re-fetch via the canonical insert-or-get path using the same eventId
    const { record: fetched, inserted: wasInserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });

    // Should return the existing record, not insert a new one
    expect(wasInserted).toBe(false);
    expect(fetched.id).toBe(inserted.id);

    // Status fields must reflect the processed update
    expect(fetched.status).toBe('processed');
    expect(fetched.processedAt).not.toBeNull();
    expect(fetched.errorMessage).toBeNull();
  });
});
