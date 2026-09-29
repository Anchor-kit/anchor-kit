import {
  makeSqliteDbUrlForTests,
  SqlDatabaseAdapter,
} from '@/runtime/database/sql-database-adapter.ts';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface FakePostgresQuery {
  sql: string;
  values?: unknown[];
}

/**
 * A delayed fake PostgreSQL client. Each query records itself and resolves after
 * a short delay so concurrent migration sequences would visibly interleave.
 */
function createDelayedFakePostgres(delayMs = 5) {
  const queries: FakePostgresQuery[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  return {
    queries,
    get maxInFlight() {
      return maxInFlight;
    },
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return { rows: [] as Record<string, unknown>[] };
    },
    async end() {
      // no-op
    },
  };
}

/** A fake PostgreSQL client whose next migration query rejects on demand. */
function createFailingFakePostgres() {
  const queries: FakePostgresQuery[] = [];
  let failure: Error | null = null;

  return {
    queries,
    failNextMigration(error: Error) {
      failure = error;
    },
    async query(sql: string, values?: unknown[]) {
      queries.push({ sql, values });
      if (failure) {
        const error = failure;
        failure = null;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { rows: [] as Record<string, unknown>[] };
    },
    async end() {
      // no-op
    },
  };
}

function attachPostgresClient(adapter: SqlDatabaseAdapter, client: unknown): SqlDatabaseAdapter {
  (adapter as unknown as { postgres: unknown }).postgres = client;
  return adapter;
}

describe('Concurrent database migrations (#600)', () => {
  it('runs a single migration sequence for concurrent callers', async () => {
    const adapter = new SqlDatabaseAdapter({
      provider: 'postgres',
      url: 'postgres://fake',
    });
    const client = createDelayedFakePostgres();
    attachPostgresClient(adapter, client);

    await Promise.all(Array.from({ length: 10 }, () => adapter.migrate()));

    // Six statements define one migration sequence; concurrent callers
    // must share it rather than each replaying the whole sequence.
    expect(client.queries).toHaveLength(6);
    expect(client.maxInFlight).toBe(1);
  });

  it('returns the same result to every concurrent caller', async () => {
    const adapter = new SqlDatabaseAdapter({
      provider: 'postgres',
      url: 'postgres://fake',
    });
    const client = createDelayedFakePostgres();
    attachPostgresClient(adapter, client);

    const results = await Promise.all(Array.from({ length: 5 }, () => adapter.migrate()));

    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(client.queries).toHaveLength(6);
  });

  it('serializes SQLite migration calls into a single sequence', async () => {
    const sqliteUrl = makeSqliteDbUrlForTests();
    const dbPath = sqliteUrl.slice('file:'.length);
    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url: sqliteUrl });

    try {
      await adapter.connect();

      const sqlite = (adapter as unknown as { sqlite: Database }).sqlite;
      let execCount = 0;
      const originalExec = sqlite.exec.bind(sqlite);
      sqlite.exec = ((sql: string) => {
        execCount += 1;
        return originalExec(sql);
      }) as typeof sqlite.exec;

      await Promise.all(Array.from({ length: 5 }, () => adapter.migrate()));

      expect(execCount).toBe(1);

      // The schema is usable after the shared migration.
      await adapter.insertAuthChallenge({
        id: 'single-flight-challenge',
        account: 'GB7W6F6S6LFQXCNHZVKI53ZJHULPF4E66YW2LJ3F4PAEPGZF5FY2B7ZB',
        challenge: 'single-flight-test',
        expiresAt: '2099-12-31T23:59:59.000Z',
      });
      await expect(adapter.getAuthChallengeByChallenge('single-flight-test')).resolves.toEqual(
        expect.objectContaining({ id: 'single-flight-challenge' }),
      );
    } finally {
      await adapter.disconnect();
      try {
        unlinkSync(dbPath);
      } catch {
        // Ignore cleanup errors when SQLite did not create a file.
      }
    }
  });

  it('rejects every concurrent caller when the migration fails', async () => {
    const adapter = new SqlDatabaseAdapter({
      provider: 'postgres',
      url: 'postgres://fake',
    });
    const client = createFailingFakePostgres();
    attachPostgresClient(adapter, client);
    client.failNextMigration(new Error('migration exploded'));

    const results = await Promise.allSettled(Array.from({ length: 5 }, () => adapter.migrate()));

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    results.forEach((result) => {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error);
        expect((result.reason as Error).message).toBe('migration exploded');
      }
    });
  });

  it('allows a retry after a failed migration instead of caching failure', async () => {
    const adapter = new SqlDatabaseAdapter({
      provider: 'postgres',
      url: 'postgres://fake',
    });
    const client = createFailingFakePostgres();
    attachPostgresClient(adapter, client);

    client.failNextMigration(new Error('transient failure'));
    await expect(adapter.migrate()).rejects.toThrow('transient failure');
    expect(client.queries).toHaveLength(1);

    await expect(adapter.migrate()).resolves.toBeUndefined();
    expect(client.queries).toHaveLength(7);
  });

  it('lets a fresh caller retry once the in-flight migration has settled', async () => {
    const adapter = new SqlDatabaseAdapter({
      provider: 'postgres',
      url: 'postgres://fake',
    });
    const client = createDelayedFakePostgres();
    attachPostgresClient(adapter, client);

    const first = adapter.migrate();
    const second = adapter.migrate();
    await Promise.all([first, second]);

    // A later, non-overlapping call runs its own sequence because the guard is
    // cleared after the shared sequence settles.
    await adapter.migrate();
    expect(client.queries).toHaveLength(12);
  });
});
