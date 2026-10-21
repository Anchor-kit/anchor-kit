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
      account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
      challenge: 'live-test-challenge',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });

    const stored = await adapter.getAuthChallengeByChallenge('live-test-challenge');
    expect(stored).not.toBeNull();
    expect(stored?.account).toBe('GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB');
    expect(stored?.consumedAt).toBeNull();

    await adapter.markAuthChallengeConsumed('challenge-1');
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

  it('allows only one competing transaction transition to win', async () => {
    await adapter.insertInteractiveTransaction({
      id: 'tx-transition-race',
      account: 'GBTRANSITIONTESTACCOUNT',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '100.00',
      status: 'pending_user_transfer_start',
    });

    const results = await Promise.all([
      adapter.transitionInteractiveTransaction({
        id: 'tx-transition-race',
        expectedStatus: 'pending_user_transfer_start',
        status: 'pending_user_transfer_complete',
        amount: '99.00',
      }),
      adapter.transitionInteractiveTransaction({
        id: 'tx-transition-race',
        expectedStatus: 'pending_user_transfer_start',
        status: 'expired',
        amount: '0.00',
      }),
    ]);

    const updated = results.filter((result) => result.outcome === 'updated');
    const conflicts = results.filter((result) => result.outcome === 'conflict');
    expect(updated).toHaveLength(1);
    expect(conflicts).toEqual([
      expect.objectContaining({ outcome: 'conflict', reason: 'status_mismatch' }),
    ]);

    const stored = await adapter.getInteractiveTransactionById('tx-transition-race');
    expect(stored).toEqual(updated[0]?.transaction);
    expect(['pending_user_transfer_complete', 'expired']).toContain(stored?.status);
  });

  it('leaves amount, status, and timestamps unchanged for an invalid transition', async () => {
    const inserted = await adapter.insertInteractiveTransaction({
      id: 'tx-invalid-transition',
      account: 'GBINVALIDTRANSITIONACCOUNT',
      kind: 'deposit',
      assetCode: 'USDC',
      amount: '100.00',
      status: 'pending_user_transfer_start',
    });

    const result = await adapter.transitionInteractiveTransaction({
      id: inserted.id,
      expectedStatus: 'pending_user_transfer_start',
      status: 'completed',
      amount: '1.00',
    });

    expect(result).toEqual({
      outcome: 'conflict',
      reason: 'invalid_transition',
      transaction: inserted,
    });
    await expect(adapter.getInteractiveTransactionById(inserted.id)).resolves.toEqual(inserted);
  });

  it('persists account-scoped customer identities across reconnects and creation replay', async () => {
    const customerInput = {
      id: 'customer-one',
      account_id: 'GACCOUNTONE',
      email_address: 'one@example.com',
      phone_number: '+123456789',
      kyc_data: { status: 'pending' as const, first_name: 'Ada' },
    };
    const first = await adapter.insertOrGetCustomer(customerInput);
    await expect(adapter.insertOrGetCustomer(customerInput)).resolves.toEqual(first);

    const second = await adapter.insertOrGetCustomer({
      id: 'customer-two',
      account_id: 'GACCOUNTTWO',
      email_address: 'two@example.com',
    });
    await expect(
      adapter.insertOrGetCustomer({
        id: 'customer-three',
        account_id: 'GACCOUNTONE',
      }),
    ).rejects.toThrow('Account is already associated with a different customer');
    await expect(adapter.getCustomerByAccountId('GACCOUNTONE')).resolves.toEqual(first);
    await expect(adapter.getCustomerByAccountId('GACCOUNTTWO')).resolves.toEqual(second);
    await expect(adapter.getCustomerByAccountId('GUNKNOWN')).resolves.toBeNull();

    await adapter.disconnect();
    await adapter.connect();
    await adapter.migrate();
    await expect(adapter.getCustomerByAccountId('GACCOUNTONE')).resolves.toEqual(first);
    await expect(adapter.getCustomerByAccountId('GACCOUNTTWO')).resolves.toEqual(second);
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

  it('preserves records when migrations run twice', async () => {
    await adapter.insertAuthChallenge({
      id: 'migration-challenge',
      account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
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
        account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
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
});
