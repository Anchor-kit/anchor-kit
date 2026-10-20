import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import { createSqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { DatabaseAdapter } from '@/runtime/interfaces.ts';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('SqlDatabaseAdapter – webhook event failed-status persistence (sqlite)', () => {
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

  it('resets a failed event to pending when it is retried', async () => {
    const eventId = `evt-failed-${randomUUID()}`;
    const internalId = randomUUID();
    const errorText = 'downstream service unavailable';

    // Insert a new webhook event – it starts as pending
    const { record: pending, inserted } = await db.insertOrGetWebhookEvent({
      id: internalId,
      eventId,
      provider: 'test-provider',
      payload: { type: 'payment.failed', amount: '50' },
    });

    expect(inserted).toBe(true);
    expect(pending.status).toBe('pending');
    expect(pending.errorMessage).toBeNull();
    expect(pending.processedAt).toBeNull();

    // Mark the event as failed with a descriptive error message
    await db.updateWebhookEventStatus({
      id: internalId,
      status: 'failed',
      errorMessage: errorText,
    });
    // Re-using the event ID retries the failed record and clears failure metadata.
    const { record: retry, inserted: reinserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(), // different id – conflict fires, existing row is returned
      eventId,
      provider: 'test-provider',
      payload: { type: 'payment.retry', amount: '50' },
    });

    expect(reinserted).toBe(true);
    expect(retry.id).toBe(internalId);
    expect(retry.status).toBe('pending');
    expect(retry.errorMessage).toBeNull();
    expect(retry.processedAt).toBeNull();
    expect(retry.payload).toEqual({ type: 'payment.retry', amount: '50' });
  });

  it('replaces the payload and preserves the provider when retrying a failed event', async () => {
    const eventId = `evt-payload-check-${randomUUID()}`;
    const internalId = randomUUID();
    const originalPayload = { type: 'deposit.completed', amount: '100', currency: 'USD' };

    await db.insertOrGetWebhookEvent({
      id: internalId,
      eventId,
      provider: 'stripe',
      payload: originalPayload,
    });

    await db.updateWebhookEventStatus({
      id: internalId,
      status: 'failed',
      errorMessage: 'processing error',
    });

    const { record, inserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'stripe',
      payload: {},
    });

    expect(inserted).toBe(true);
    expect(record.status).toBe('pending');
    expect(record.provider).toBe('stripe');
    expect(record.payload).toEqual({});
  });

  it('a failed event with no errorMessage stores null for error_message', async () => {
    const eventId = `evt-no-error-msg-${randomUUID()}`;
    const internalId = randomUUID();

    await db.insertOrGetWebhookEvent({
      id: internalId,
      eventId,
      provider: 'test-provider',
      payload: { type: 'ping' },
    });

    await db.updateWebhookEventStatus({
      id: internalId,
      status: 'failed',
      // errorMessage intentionally omitted
    });

    const { record, inserted } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: {},
    });

    expect(inserted).toBe(true);
    expect(record.status).toBe('pending');
    expect(record.errorMessage).toBeNull();
    expect(record.processedAt).toBeNull();
  });

  it('processed status also populates processedAt and leaves errorMessage null', async () => {
    const eventId = `evt-processed-${randomUUID()}`;
    const internalId = randomUUID();

    await db.insertOrGetWebhookEvent({
      id: internalId,
      eventId,
      provider: 'test-provider',
      payload: { type: 'payment.completed' },
    });

    await db.updateWebhookEventStatus({
      id: internalId,
      status: 'processed',
    });

    const { record } = await db.insertOrGetWebhookEvent({
      id: randomUUID(),
      eventId,
      provider: 'test-provider',
      payload: {},
    });

    expect(record.status).toBe('processed');
    expect(record.errorMessage).toBeNull();
    expect(record.processedAt).not.toBeNull();
  });
});
