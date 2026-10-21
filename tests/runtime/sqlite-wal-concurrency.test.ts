import { makeSqliteDbUrlForTests } from '@/core/factory.ts';
import {
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_JOURNAL_MODE,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';
import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

function rawSqlite(adapter: SqlDatabaseAdapter): Database {
  const sqlite = (adapter as unknown as { sqlite: Database | null }).sqlite;
  if (!sqlite) {
    throw new Error('Expected the SQLite adapter to be connected');
  }
  return sqlite;
}

/**
 * Reads a SQLite pragma. The returned column name is not always the pragma name
 * (`PRAGMA busy_timeout` reports a `timeout` column), so it is passed in.
 */
function readPragma(adapter: SqlDatabaseAdapter, pragma: string, column: string): unknown {
  const row = rawSqlite(adapter).prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  return row[column];
}

function countRows(adapter: SqlDatabaseAdapter, table: string): number {
  const row = rawSqlite(adapter).prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Record<
    string,
    unknown
  >;
  return Number(row.count ?? 0);
}

describe('SqliteDatabaseAdapter – concurrency settings (WAL + busy timeout)', () => {
  const adapters: SqlDatabaseAdapter[] = [];
  const filePaths = new Set<string>();

  function sqliteAdapter(url: string): SqlDatabaseAdapter {
    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    adapters.push(adapter);

    if (url.startsWith('file:')) {
      filePaths.add(url.slice('file:'.length));
    }

    return adapter;
  }

  async function openAdapter(url: string): Promise<SqlDatabaseAdapter> {
    const adapter = sqliteAdapter(url);
    await adapter.connect();
    await adapter.migrate();
    return adapter;
  }

  afterEach(async () => {
    for (const adapter of adapters.splice(0)) {
      await adapter.disconnect();
    }

    for (const filePath of filePaths) {
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          unlinkSync(`${filePath}${suffix}`);
        } catch {
          // Ignore cleanup errors when SQLite did not create the file.
        }
      }
    }

    filePaths.clear();
  });

  it('enables WAL and a busy timeout for file-backed databases', async () => {
    const adapter = await openAdapter(makeSqliteDbUrlForTests());

    expect(String(readPragma(adapter, 'journal_mode', 'journal_mode')).toLowerCase()).toBe(
      SQLITE_JOURNAL_MODE.toLowerCase(),
    );
    expect(readPragma(adapter, 'busy_timeout', 'timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('keeps in-memory databases supported without requesting WAL', async () => {
    const adapter = await openAdapter('sqlite::memory:');

    // SQLite cannot use WAL for a pure in-memory database; it must stay usable.
    expect(String(readPragma(adapter, 'journal_mode', 'journal_mode')).toLowerCase()).toBe(
      'memory',
    );
    expect(readPragma(adapter, 'busy_timeout', 'timeout')).toBe(SQLITE_BUSY_TIMEOUT_MS);

    await adapter.insertAuthChallenge({
      id: `challenge-${randomUUID()}`,
      account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
      challenge: 'in-memory-challenge',
      expiresAt: '2099-12-31T23:59:59.000Z',
    });

    await expect(adapter.getAuthChallengeByChallenge('in-memory-challenge')).resolves.toEqual(
      expect.objectContaining({ challenge: 'in-memory-challenge', consumedAt: null }),
    );
  });

  it('does not block a writer on another connection while a reader holds a snapshot', async () => {
    const dbUrl = makeSqliteDbUrlForTests();
    const reader = await openAdapter(dbUrl);
    const writer = await openAdapter(dbUrl);
    const readerDb = rawSqlite(reader);

    // Hold an open read snapshot on the first connection...
    readerDb.exec('BEGIN;');
    readerDb.prepare('SELECT COUNT(*) AS count FROM watcher_tasks').get();

    try {
      // ...a competing write from the second connection must still succeed.
      const taskId = `watcher-${randomUUID()}`;
      await expect(
        writer.insertWatcherTask({
          id: taskId,
          watcherName: 'wal-reader-writer',
          payload: { ok: true },
        }),
      ).resolves.toBeUndefined();

      const pending = await writer.listPendingWatcherTasks(10);
      expect(pending.map((task) => task.id)).toContain(taskId);
    } finally {
      readerDb.exec('COMMIT;');
    }
  });

  it('completes overlapping write bursts across connections without lock failures', async () => {
    const dbUrl = makeSqliteDbUrlForTests();
    const connections = await Promise.all([
      openAdapter(dbUrl),
      openAdapter(dbUrl),
      openAdapter(dbUrl),
      openAdapter(dbUrl),
    ]);
    const scope = `burst-${randomUUID()}`;
    const writesPerConnection = 25;

    const pendingWrites = connections.flatMap((connection, connectionIndex) =>
      Array.from({ length: writesPerConnection }, async (_, writeIndex) => {
        // Yield so writes from different connections interleave in the event loop.
        await new Promise((resolve) => setImmediate(resolve));

        return connection.insertOrGetIdempotencyRecord({
          id: randomUUID(),
          scope,
          idempotencyKey: `key-${connectionIndex}-${writeIndex}`,
          requestHash: `hash-${connectionIndex}-${writeIndex}`,
          statusCode: 200,
          responseBody: '{"status":"ok"}',
        });
      }),
    );

    const records = await Promise.all(pendingWrites);

    expect(records).toHaveLength(connections.length * writesPerConnection);
    expect(records.every((record) => record.scope === scope)).toBe(true);
    expect(new Set(records.map((record) => record.idempotencyKey)).size).toBe(records.length);
    expect(countRows(connections[0], 'idempotency_keys')).toBe(records.length);
  });

  it('reopens an existing WAL database and re-runs migrations safely', async () => {
    const dbUrl = makeSqliteDbUrlForTests();
    const challenge = `challenge-${randomUUID()}`;
    const first = sqliteAdapter(dbUrl);

    await first.connect();
    await first.migrate();
    await first.insertAuthChallenge({
      id: 'reopen-challenge',
      account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
      challenge,
      expiresAt: '2099-12-31T23:59:59.000Z',
    });
    await first.disconnect();

    const second = await openAdapter(dbUrl);

    expect(String(readPragma(second, 'journal_mode', 'journal_mode')).toLowerCase()).toBe(
      SQLITE_JOURNAL_MODE.toLowerCase(),
    );
    await expect(second.getAuthChallengeByChallenge(challenge)).resolves.toEqual(
      expect.objectContaining({ id: 'reopen-challenge', challenge }),
    );
  });
});
