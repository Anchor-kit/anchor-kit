import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MalformedPersistedDataError } from '@/core/errors.ts';
import { SqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';

const postgresMock = {
  rows: [] as Array<Record<string, unknown>>,
};

mock.module('pg', () => ({
  Client: class {
    async connect(): Promise<void> {}
    async end(): Promise<void> {}
    async query<T extends Record<string, unknown>>(): Promise<{ rows: T[]; rowCount: number }> {
      return { rows: postgresMock.rows as T[], rowCount: postgresMock.rows.length };
    }
  },
}));

describe('PostgreSQL persisted webhook and watcher data', () => {
  let adapter: SqlDatabaseAdapter;

  beforeEach(async () => {
    postgresMock.rows = [];
    adapter = new SqlDatabaseAdapter({ provider: 'postgres', url: 'postgres://local/test' });
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('returns valid JSONB objects and supported record statuses unchanged', async () => {
    const webhookPayload = { event: { id: 'event-1' } };
    postgresMock.rows = [
      {
        id: 'webhook-1',
        event_id: 'event-1',
        provider: 'test',
        payload: webhookPayload,
        status: 'processed',
        error_message: null,
        processed_at: '2026-01-01T00:00:01.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    const webhookResult = await adapter.insertOrGetWebhookEvent({
      id: 'new-webhook',
      eventId: 'event-1',
      provider: 'test',
      payload: {},
    });
    expect(webhookResult.record.payload).toEqual(webhookPayload);
    expect(webhookResult.record.status).toBe('processed');

    const watcherPayload = { cursor: 'cursor-1' };
    postgresMock.rows = [
      {
        id: 'watcher-1',
        watcher_name: 'test-watcher',
        payload: watcherPayload,
        status: 'pending',
        error_message: null,
        processed_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    const watcherTasks = await adapter.listPendingWatcherTasks(1);
    expect(watcherTasks[0]?.payload).toEqual(watcherPayload);
    expect(watcherTasks[0]?.status).toBe('pending');
  });

  it.each([null, [], 7, true, 'false', '"text"', '{"valid":true}'])(
    'rejects webhook payload %j unless it is an object',
    async (payload) => {
      postgresMock.rows = [
        {
          id: 'webhook-1',
          event_id: 'event-1',
          provider: 'test',
          payload,
          status: 'pending',
          error_message: null,
          processed_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ];

      await expect(
        adapter.insertOrGetWebhookEvent({
          id: 'new-webhook',
          eventId: 'event-1',
          provider: 'test',
          payload: {},
        }),
      ).rejects.toBeInstanceOf(MalformedPersistedDataError);
    },
  );

  it.each([null, [], 7, true, 'false', '"text"', '{"valid":true}'])(
    'rejects watcher payload %j unless it is an object',
    async (payload) => {
      postgresMock.rows = [
        {
          id: 'watcher-1',
          watcher_name: 'test-watcher',
          payload,
          status: 'pending',
          error_message: null,
          processed_at: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ];

      await expect(adapter.listPendingWatcherTasks(1)).rejects.toBeInstanceOf(
        MalformedPersistedDataError,
      );
    },
  );

  it.each([
    ['webhook event', 'queued'],
    ['watcher task', 'queued'],
    ['webhook event', null],
    ['watcher task', 1],
  ] as const)('rejects invalid %s status %j', async (recordType, status) => {
    postgresMock.rows = [
      {
        id: 'persisted-record',
        event_id: 'event-1',
        provider: 'test',
        watcher_name: 'test-watcher',
        payload: { valid: true },
        status,
        error_message: null,
        processed_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ];

    const result =
      recordType === 'webhook event'
        ? adapter.insertOrGetWebhookEvent({
            id: 'new-webhook',
            eventId: 'event-1',
            provider: 'test',
            payload: {},
          })
        : adapter.listPendingWatcherTasks(1);

    await expect(result).rejects.toBeInstanceOf(MalformedPersistedDataError);
  });
});
