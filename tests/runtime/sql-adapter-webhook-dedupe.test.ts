import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * AK-046 - Webhook deduplication is scoped by (provider, event_id).
 *
 * Acceptance gate:
 *   - Two providers delivering the same event_id are independent events.
 *   - Duplicates within one provider still collapse to one execution owner.
 *   - Legacy databases still carrying UNIQUE(event_id) upgrade in place.
 *
 * Run command:
 *   bun test tests/runtime/sql-adapter-webhook-dedupe.test.ts
 *
 * Expected result: all assertions pass (0 failures).
 */
describe('SqlDatabaseAdapter - webhook event deduplication (sqlite)', () => {
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

  it('second insert with same event_id and provider returns inserted: false and the existing record', async () => {
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

  it('same event_id from two different providers are independent events', async () => {
    const eventId = `evt-shared-${randomUUID()}`;
    const payload = { type: 'payment.completed', amount: '100' };

    const providerA = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'provider-a',
      payload,
    });
    const providerB = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'provider-b',
      payload,
    });

    expect(providerA.inserted).toBe(true);
    expect(providerB.inserted).toBe(true);
    expect(providerA.record.id).not.toBe(providerB.record.id);
    expect(providerA.record.provider).toBe('provider-a');
    expect(providerB.record.provider).toBe('provider-b');
    expect(providerA.record.eventId).toBe(eventId);
    expect(providerB.record.eventId).toBe(eventId);
  });

  it('repeated deliveries within a single provider still deduplicate to one owner', async () => {
    const eventId = `evt-dup-${randomUUID()}`;
    const firstPayload = { type: 'payment.completed', amount: '100' };

    const first = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'provider-a',
      payload: firstPayload,
    });
    expect(first.inserted).toBe(true);

    const duplicate = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'provider-a',
      payload: { type: 'tampered', amount: '999' },
    });

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe(first.record.id);
    expect(duplicate.record.eventId).toBe(eventId);
    expect(duplicate.record.provider).toBe('provider-a');
    // The first caller's payload is preserved.
    expect(duplicate.record.payload).toEqual(firstPayload);
  });

  it('allows a failed event to retry once by resetting it to pending', async () => {
    const eventId = `evt-${randomUUID()}`;
    const payload = { type: 'payment.completed', amount: '200' };

    const first = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });
    expect(first.inserted).toBe(true);

    await db.updateWebhookEventStatus({
      id: first.record.id,
      status: 'failed',
      errorMessage: 'temporary failure',
    });

    const retry = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: { type: 'payment.completed', amount: '250' },
    });

    expect(retry.inserted).toBe(true);
    expect(retry.record.id).toBe(first.record.id);
    expect(retry.record.eventId).toBe(eventId);
    expect(retry.record.status).toBe('pending');
    expect(retry.record.payload).toEqual({ type: 'payment.completed', amount: '250' });
  });

  it('treats a processed event as a permanent duplicate', async () => {
    const eventId = `evt-${randomUUID()}`;
    const payload = { type: 'payment.completed', amount: '200' };

    const first = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });
    expect(first.inserted).toBe(true);

    await db.updateWebhookEventStatus({
      id: first.record.id,
      status: 'processed',
    });

    const duplicate = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: { type: 'tampered', amount: '999' },
    });

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.record.id).toBe(first.record.id);
    expect(duplicate.record.status).toBe('processed');
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

    const { record: inserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });
    expect(inserted.status).toBe('pending');
    expect(inserted.processedAt).toBeNull();

    await db.updateWebhookEventStatus({
      id: inserted.id,
      status: 'processed',
    });

    const { record: fetched, inserted: wasInserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload,
    });

    expect(wasInserted).toBe(false);
    expect(fetched.id).toBe(inserted.id);
    expect(fetched.status).toBe('processed');
    expect(fetched.processedAt).not.toBeNull();
    expect(fetched.errorMessage).toBeNull();
  });

  it('preserves unresolved webhook status when reading a timed-out event', async () => {
    const eventId = `evt-unresolved-${randomUUID()}`;
    const inserted = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: { type: 'payment.initiated' },
    });

    await db.updateWebhookEventStatus({
      id: inserted.record.id,
      status: 'unresolved',
      errorMessage: 'callback timed out',
    });

    const duplicate = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: {},
    });
    expect(duplicate.record.status).toBe('unresolved');
    expect(duplicate.record.errorMessage).toBe('callback timed out');
  });

  it('upgrades a legacy single-column event_id UNIQUE constraint in place', async () => {
    const upgradeUrl = makeSqliteDbUrlForTests();
    const upgradePath = upgradeUrl.startsWith('file:')
      ? upgradeUrl.slice('file:'.length)
      : upgradeUrl;

    // Seed a database that mimics the pre-AK-046 schema: event_id is globally
    // UNIQUE and no composite (provider, event_id) constraint exists.
    const legacyDb = new Database(upgradePath);
    legacyDb.exec(`
      CREATE TABLE webhook_events (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        attempt_id TEXT,
        attempt_number INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_expires_at TEXT,
        operation_key TEXT
      );
    `);
    legacyDb
      .prepare(
        `INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at, attempt_id, attempt_number, operation_key)
         VALUES (?, ?, ?, ?, 'processed', NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-row',
        'evt-shared-legacy',
        'provider-a',
        '{}',
        '2024-01-01T00:00:00.000Z',
        '2024-01-01T00:00:00.000Z',
        'attempt-legacy',
        3,
        'provider-a:evt-shared-legacy',
      );
    legacyDb.close();

    const upgradeDb = createSqlDatabaseAdapter({ provider: 'sqlite', url: upgradeUrl });
    try {
      await upgradeDb.connect();
      await upgradeDb.migrate();

      // The existing provider-a row was preserved by the rebuild.
      const existing = await upgradeDb.insertOrGetWebhookEvent({
        id: randomUUID(),
        eventId: 'evt-shared-legacy',
        provider: 'provider-a',
        payload: {},
      });
      expect(existing.inserted).toBe(false);
      expect(existing.record.id).toBe('legacy-row');
      expect(existing.record.status).toBe('processed');
      expect(existing.record.attemptId).toBe('attempt-legacy');
      expect(existing.record.attemptCount).toBe(3);
      expect(existing.record.operationKey).toBe('provider-a:evt-shared-legacy');

      // A different provider using the same event_id must be inserted
      // independently after the upgrade.
      const incoming = await upgradeDb.insertOrGetWebhookEvent({
        id: randomUUID(),
        eventId: 'evt-shared-legacy',
        provider: 'provider-b',
        payload: {},
      });
      expect(incoming.inserted).toBe(true);
      expect(incoming.record.provider).toBe('provider-b');
      expect(incoming.record.id).not.toBe('legacy-row');
    } finally {
      await upgradeDb.disconnect();
      try {
        unlinkSync(upgradePath);
      } catch {
        // ignore cleanup errors
      }
    }
  });
});
