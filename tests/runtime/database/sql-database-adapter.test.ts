import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';

describe('SqlDatabaseAdapter (sqlite)', () => {
  let adapter: SqlDatabaseAdapter;

  beforeEach(async () => {
    const sqliteUrl = makeSqliteDbUrlForTests();
    adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url: sqliteUrl });
    await adapter.connect();
    await adapter.migrate();
  });

  afterEach(async () => {
    await adapter.disconnect();
  });

  it('allows repeated disconnect calls and cleans up its database file', async () => {
    const sqliteUrl = makeSqliteDbUrlForTests();
    const dbPath = sqliteUrl.slice('file:'.length);
    const localAdapter = new SqlDatabaseAdapter({ provider: 'sqlite', url: sqliteUrl });

    try {
      await localAdapter.connect();
      await localAdapter.migrate();
      await expect(localAdapter.disconnect()).resolves.toBeUndefined();
      await expect(localAdapter.disconnect()).resolves.toBeUndefined();
    } finally {
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors when SQLite did not create a file.
      }
    }
  });

  it('persists and consumes auth challenges correctly', async () => {
    await adapter.insertAuthChallenge({
      id: 'challenge-1',
      account: 'GB7W6DF6S6TFXXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY27B7ZB',
      challenge: 'live-test-challenge',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });

    const stored = await adapter.getAuthChallengeByChallenge('live-test-challenge');
    expect(stored).not.toBeNull();
    expect(stored?.account).toBe('GB7W6DF6S6TFXXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY27B7ZB');
    expect(stored?.consumedAt).toBeNull();

    const firstConsume = await adapter.markAuthChallengeConsumed('challenge-1');
    expect(firstConsume).toBe(true);

    const secondConsume = await adapter.markAuthChallengeConsumed('challenge-1');
    expect(secondConsume).toBe(false);

    const nonExistentConsume = await adapter.markAuthChallengeConsumed('non-existent');
    expect(nonExistentConsume).toBe(false);

    const consumed = await adapter.getAuthChallengeByChallenge('live-test-challenge');
    expect(consumed).not.toBeNull();
    expect(consumed?.consumedAt).toEqual(expect.any(String));
  });

  it('returns only pending user-transfer-start transactions before the cutoff', async () => {
    const firstTimestamp = '2024-01-01T00:00:00.000Z';
    const secondTimestamp = '2024-01-03T00:00:00.000Z';
    const cutoffTimestamp = '2024-01-02T00:00:00.000Z';

    await adapter.insertInteractiveTransaction({
      id: 'tx-old',
      account: 'GBOLDDATATESTACCOUNT',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '100',
      status: 'pending_user_transfer_start',
    });

    await adapter.insertInteractiveTransaction({
      id: 'tx-new',
      account: 'GBNEWTESTACCOUNT1234567890',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '150',
      status: 'pending_user_transfer_start',
    });

    await adapter.insertInteractiveTransaction({
      id: 'tx-completed',
      account: 'GBCOMPLETEDACCOUNT0000000000',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '200',
      status: 'completed',
    });

    const sqlite = (adapter as unknown as { sqlite: Database }).sqlite;
    sqlite
      .prepare('UPDATE interactive_transactions SET created_at = ? WHERE id = ?')
      .run(firstTimestamp, 'tx-old');
    sqlite
      .prepare('UPDATE interactive_transactions SET created_at = ? WHERE id = ?')
      .run(secondTimestamp, 'tx-new');
    sqlite
      .prepare('UPDATE interactive_transactions SET created_at = ? WHERE id = ?')
      .run(secondTimestamp, 'tx-completed');

    const pending = await adapter.listPendingTransactionsBefore(cutoffTimestamp);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('tx-old');
  });

  it('updates an idempotency record without changing its identity fields', async () => {
    const initial = await adapter.insertOrGetIdempotencyRecord({
      id: 'idempotency-1',
      scope: 'deposit',
      idempotencyKey: 'request-1',
      requestHash: 'hash-before',
      statusCode: 202,
      responseBody: '{"status":"pending"}',
    });

    await adapter.updateIdempotencyRecord({
      scope: 'deposit',
      idempotencyKey: 'request-1',
      statusCode: 201,
      responseBody: '{"status":"complete"}',
    });

    const updated = await adapter.getIdempotencyRecord('deposit', 'request-1');
    expect(updated).toEqual({
      ...initial,
      statusCode: 201,
      responseBody: '{"status":"complete"}',
    });
  });

  it('creates indexes for watcher and retention queries', async () => {
    const sqlite = (adapter as unknown as { sqlite: Database }).sqlite;
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((row) => row.name);

    expect(indexNames).toContain('idx_watcher_tasks_status_created_at');
    expect(indexNames).toContain('idx_webhook_events_status_created_at');
    expect(indexNames).toContain('idx_auth_challenges_expires_at');
  });

  it('preserves records when migrations run twice', async () => {
    await adapter.insertAuthChallenge({
      id: 'migration-challenge',
      account: 'GB7W6DF6S6TFXXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY27B7ZB',
      challenge: 'migration-test-challenge',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });

    await expect(adapter.migrate()).resolves.toBeUndefined();

    await expect(adapter.getAuthChallengeByChallenge('migration-test-challenge')).resolves.toEqual(
      expect.objectContaining({
        id: 'migration-challenge',
        challenge: 'migration-test-challenge',
      }),
    );
  });

  it('connects and migrates a sqlite URL', async () => {
    const sqlitePath = makeSqliteDbUrlForTests().slice('file:'.length);
    const sqliteAdapter = new SqlDatabaseAdapter({
      provider: 'sqlite',
      url: `sqlite:${sqlitePath}`,
    });

    try {
      await sqliteAdapter.connect();
      await sqliteAdapter.migrate();
      await sqliteAdapter.insertAuthChallenge({
        id: 'sqlite-url-challenge',
        account: 'GB7W6DF6S6TFXXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY27B7ZB',
        challenge: 'sqlite-url-test',
        expiresAt: '2099-12-31T23:59:59.000Z',
      });

      await expect(sqliteAdapter.getAuthChallengeByChallenge('sqlite-url-test')).resolves.toEqual(
        expect.objectContaining({ challenge: 'sqlite-url-test' }),
      );
    } finally {
      await sqliteAdapter.disconnect();
      const { unlinkSync } = await import('node:fs');
      try {
        unlinkSync(sqlitePath);
      } catch {
        // The temporary database may not exist for in-memory adapters.
      }
    }
  });

  it('records transition audit entries and dispatches hooks once per committed transition', async () => {
    await adapter.insertInteractiveTransaction({
      id: 'tx-audit',
      account: 'GBAUDITTESTACCOUNT0000000000',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '100',
      status: 'pending_user_transfer_start',
    });

    const hooks: Array<{ oldState: string; newState: string; reason: string }> = [];
    const dispatch = async (entry: { oldState: string; newState: string; reason: string }) => {
      hooks.push(entry);
    };

    const transition = {
      transactionId: 'tx-audit',
      oldState: 'pending_user_transfer_start',
      newState: 'pending_anchor_status',
      reason: 'user transfer detected',
      operationId: 'op-audit-1',
    } as const;

    await adapter.applyTransactionTransition({ ...transition, dispatchHook: dispatch });

    const audit = await adapter.listTransactionTransitions('tx-audit');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toEqual(
      expect.objectContaining({
        transactionId: 'tx-audit',
        oldState: 'pending_user_transfer_start',
        newState: 'pending_anchor_status',
        reason: 'user transfer detected',
        operationId: 'op-audit-1',
        createdAt: expect.any(String),
      }),
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toEqual({
      oldState: 'pending_user_transfer_start',
      newState: 'pending_anchor_status',
      reason: 'user transfer detected',
    });

    // Replaying the same operation is idempotent: no duplicate audit entry or hook.
    await adapter.applyTransactionTransition({ ...transition, dispatchHook: dispatch });
    expect(await adapter.listTransactionTransitions('tx-audit')).toHaveLength(1);
    expect(hooks).toHaveLength(1);
  });

  it('emits no successful hook when the transition update fails', async () => {
    await adapter.insertInteractiveTransaction({
      id: 'tx-fail',
      account: 'GBFAILTESTACCOUNT000000000000',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '50',
      status: 'pending_user_transfer_start',
    });

    const hooks: string[] = [];
    const dispatch = async () => {
      hooks.push('dispatched');
    };

    // Provide a stale oldState so the conditional update matches no rows.
    await expect(
      adapter.applyTransactionTransition({
        transactionId: 'tx-fail',
        oldState: 'completed',
        newState: 'pending_anchor_status',
        reason: 'stale state',
        operationId: 'op-fail-1',
        dispatchHook: dispatch,
      }),
    ).rejects.toThrow();

    expect(await adapter.listTransitions('tx-fail')).toHaveLength(0);
    expect(hooks).toHaveLength(0);
  });
});
