// Opt-in like the other PostgreSQL integration suites: set TEST_POSTGRES_URL
// (or DATABASE_URL) to a disposable database, otherwise both cases skip.
import { SqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { SchemaMigration } from '@/types/foundation.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const connectionString = process.env.TEST_POSTGRES_URL || process.env.DATABASE_URL || '';
const postgresTest = connectionString ? describe : describe.skip;

function uniqueSuffix(): string {
  return randomUUID().replaceAll('-', '');
}

/** Creates a fresh adapter so every migrator owns its own PostgreSQL connection. */
function createAdapter(migrations: readonly SchemaMigration[]): SqlDatabaseAdapter {
  return new SqlDatabaseAdapter({ provider: 'postgres', url: connectionString }, migrations);
}

postgresTest('PostgreSQL migration lock contention', () => {
  let verifier: PgClient | undefined;

  function client(): PgClient {
    if (!verifier) {
      throw new Error('PostgreSQL verifier connection was not initialized');
    }
    return verifier;
  }

  beforeAll(async () => {
    const moduleName = 'pg';
    const pgModuleUnknown: unknown = await import(moduleName);
    const pgModule = pgModuleUnknown as {
      Client: new (config: { connectionString: string }) => PgClient;
    };
    verifier = new pgModule.Client({ connectionString });
    await verifier.connect();
    await verifier.query('SELECT 1');
  });

  afterAll(async () => {
    await verifier?.end();
  });

  async function cleanup(tableName: string, migrationName: string): Promise<void> {
    const database = client();
    await database.query(`DROP TABLE IF EXISTS ${tableName}`);
    // A broken migration sequence may leave the metadata table uncreated; do
    // not let cleanup obscure the assertion that actually failed.
    const metadata = await database.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'anchor_kit_migrations'
      ) AS exists
    `);
    if (metadata.rows[0]?.exists === true) {
      await database.query('DELETE FROM anchor_kit_migrations WHERE name = $1', [migrationName]);
    }
  }

  it('lets two connections migrate the same database without duplicate records or partial schema', async () => {
    const suffix = uniqueSuffix();
    const tableName = `migration_lock_probe_${suffix}`;
    const migrationName = `test:migration-lock:${suffix}`;
    const migrations: readonly SchemaMigration[] = [
      {
        name: migrationName,
        async up({ execute }) {
          await execute(`CREATE TABLE IF NOT EXISTS ${tableName} (value TEXT PRIMARY KEY)`);
          // Keep the transaction open long enough for the second connection to
          // otherwise observe an unapplied migration and race the metadata insert.
          await new Promise((resolve) => setTimeout(resolve, 150));
          await execute(`INSERT INTO ${tableName} (value) VALUES ('${suffix}')`);
        },
      },
    ];
    const first = createAdapter(migrations);
    const second = createAdapter(migrations);

    try {
      await Promise.all([first.connect(), second.connect()]);

      await expect(Promise.all([first.migrate(), second.migrate()])).resolves.toEqual([
        undefined,
        undefined,
      ]);

      const records = await client().query<{ name: string }>(
        'SELECT name FROM anchor_kit_migrations WHERE name = $1',
        [migrationName],
      );
      expect(records.rows).toEqual([{ name: migrationName }]);

      const duplicates = await client().query<{ name: string }>(`
        SELECT name FROM anchor_kit_migrations GROUP BY name HAVING COUNT(*) > 1
      `);
      expect(duplicates.rows).toEqual([]);

      const probeRows = await client().query<{ value: string }>(`SELECT value FROM ${tableName}`);
      expect(probeRows.rows).toEqual([{ value: suffix }]);

      const coreTables = await client().query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('interactive_transactions', 'idempotency_keys', 'webhook_events')
      `);
      expect(coreTables.rows.map((row) => row.table_name).sort()).toEqual([
        'idempotency_keys',
        'interactive_transactions',
        'webhook_events',
      ]);
    } finally {
      await Promise.all([first.disconnect(), second.disconnect()]);
      await cleanup(tableName, migrationName);
    }
  });

  it('rolls back a failed migration and lets the next caller retry it', async () => {
    const suffix = uniqueSuffix();
    const tableName = `migration_lock_retry_${suffix}`;
    const migrationName = `test:migration-lock-retry:${suffix}`;
    let failOnce = true;
    const migrations: readonly SchemaMigration[] = [
      {
        name: migrationName,
        async up({ execute }) {
          await execute(`CREATE TABLE IF NOT EXISTS ${tableName} (value TEXT PRIMARY KEY)`);
          if (failOnce) {
            failOnce = false;
            throw new Error('transient migration failure');
          }
          await execute(`INSERT INTO ${tableName} (value) VALUES ('${suffix}')`);
        },
      },
    ];
    const first = createAdapter(migrations);
    const second = createAdapter(migrations);

    try {
      await first.connect();
      await expect(first.migrate()).rejects.toThrow('transient migration failure');

      // The failed transaction left neither the table nor a migration record.
      const tableExists = await client().query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1
        ) AS exists
      `,
        [tableName],
      );
      expect(tableExists.rows[0]?.exists).toBe(false);
      expect(
        (
          await client().query<{ name: string }>(
            'SELECT name FROM anchor_kit_migrations WHERE name = $1',
            [migrationName],
          )
        ).rows,
      ).toEqual([]);

      // The first connection released the lock, so an independent connection
      // can re-read the migration records and apply the retry.
      await second.connect();
      await expect(second.migrate()).resolves.toBeUndefined();

      const countSql = 'SELECT COUNT(*)::text AS count FROM anchor_kit_migrations WHERE name = $1';
      expect((await client().query<{ count: string }>(countSql, [migrationName])).rows).toEqual([
        { count: '1' },
      ]);
      expect(
        (await client().query<{ value: string }>(`SELECT value FROM ${tableName}`)).rows,
      ).toEqual([{ value: suffix }]);

      // The originally failed caller can retry too, without duplicating either.
      await expect(first.migrate()).resolves.toBeUndefined();
      expect((await client().query<{ count: string }>(countSql, [migrationName])).rows).toEqual([
        { count: '1' },
      ]);
      expect(
        (await client().query<{ value: string }>(`SELECT value FROM ${tableName}`)).rows,
      ).toEqual([{ value: suffix }]);
    } finally {
      await Promise.all([first.disconnect(), second.disconnect()]);
      await cleanup(tableName, migrationName);
    }
  });
});
