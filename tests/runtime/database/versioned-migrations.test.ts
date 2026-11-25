import { createAnchor, makeSqliteDbUrlForTests } from '@/index.ts';
import { SqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { SchemaMigration } from '@/types/foundation.ts';
import type { AnchorPlugin } from '@/types/plugin.ts';
import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

function removeSqliteFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // SQLite may not have created the file if initialization failed early.
  }
}

describe('versioned database migrations', () => {
  it('adopts the current schema without losing existing records', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const current = new Database(path);
    current.exec(`
      CREATE TABLE auth_challenges (
        id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        challenge TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO auth_challenges
        (id, account, challenge, expires_at, consumed_at, created_at)
      VALUES ('existing-challenge', 'GABC', 'challenge-1', '2099-01-01', NULL, '2025-01-01');

      CREATE TABLE idempotency_keys (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        status_code INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scope, idempotency_key)
      );
      INSERT INTO idempotency_keys
        (id, scope, idempotency_key, request_hash, status, status_code, response_body, created_at)
      VALUES ('existing-key', 'deposit', 'request-1', 'hash-1', 'pending', 202, '{"status":"pending"}', '2025-01-01');
    `);
    current.close();

    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await adapter.connect();
      await adapter.migrate();

      const database = (adapter as unknown as { sqlite: Database }).sqlite;
      expect(database.prepare('SELECT id, challenge FROM auth_challenges').get()).toEqual({
        id: 'existing-challenge',
        challenge: 'challenge-1',
      });
      expect(
        database.prepare('SELECT id, status, response_body FROM idempotency_keys').get(),
      ).toEqual({
        id: 'existing-key',
        status: 'pending',
        response_body: '{"status":"pending"}',
      });
    } finally {
      await adapter.disconnect();
      removeSqliteFile(path);
    }
  });

  it('upgrades a legacy schema without losing records and is repeatable', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE idempotency_keys (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(scope, idempotency_key)
      );
      INSERT INTO idempotency_keys
        (id, scope, idempotency_key, request_hash, status_code, response_body, created_at)
      VALUES ('legacy-1', 'deposit', 'request-1', 'hash-1', 202, '{"status":"pending"}', '2025-01-01');
    `);
    legacy.close();

    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    try {
      await adapter.connect();
      await adapter.migrate();
      await adapter.migrate();

      const database = (adapter as unknown as { sqlite: Database }).sqlite;
      expect(database.prepare('SELECT id, status FROM idempotency_keys').get()).toEqual({
        id: 'legacy-1',
        status: 'completed',
      });
      expect(
        database.prepare('SELECT name FROM anchor_kit_migrations ORDER BY name').all(),
      ).toEqual([
        { name: 'core:001-initial-schema' },
        { name: 'core:002-idempotency-status' },
        { name: 'core:003-current-runtime-tables' },
        { name: 'core:004-settlement-job-leases' },
        { name: 'core:005-webhook-recovery-result' },
        { name: 'core:006-refund-operations' },
        { name: 'core:007-stellar-sequence-leases' },
        { name: 'core:008-stellar-sequence-operations' },
        { name: 'core:009-interactive-sessions' },
      ]);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interactive_sessions'",
          )
          .get(),
      ).toEqual({ name: 'interactive_sessions' });
    } finally {
      await adapter.disconnect();
      removeSqliteFile(path);
    }
  });

  it('rolls back failed migrations and allows a successful retry', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    let failOnce = true;
    const migration: SchemaMigration = {
      name: 'fixture:retryable',
      async up({ execute }) {
        await execute('CREATE TABLE retryable_migration (value TEXT NOT NULL)');
        if (failOnce) {
          failOnce = false;
          throw new Error('transient migration failure');
        }
      },
    };
    const adapter = new SqlDatabaseAdapter({ provider: 'sqlite', url }, [migration]);

    try {
      await adapter.connect();
      await expect(adapter.migrate()).rejects.toThrow('transient migration failure');

      let database = (adapter as unknown as { sqlite: Database }).sqlite;
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('retryable_migration'),
      ).toBeNull();
      expect(
        database
          .prepare('SELECT name FROM anchor_kit_migrations WHERE name = ?')
          .get('fixture:retryable'),
      ).toBeNull();

      await adapter.migrate();
      database = (adapter as unknown as { sqlite: Database }).sqlite;
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get('retryable_migration'),
      ).toEqual({ name: 'retryable_migration' });
      expect(
        database
          .prepare('SELECT name FROM anchor_kit_migrations WHERE name = ?')
          .get('fixture:retryable'),
      ).toEqual({ name: 'fixture:retryable' });
    } finally {
      await adapter.disconnect();
      removeSqliteFile(path);
    }
  });

  it('applies ordered migrations from two plugins to an existing core database', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const key = Keypair.random().secret();
    const config = {
      network: { network: 'testnet' as const },
      server: { homeDomain: 'anchor.example.com', interactiveDomain: 'https://anchor.example.com' },
      security: {
        sep10SigningKey: key,
        interactiveJwtSecret: 'plugin-migration-test-secret',
        distributionAccountSecret: key,
      },
      assets: {
        assets: [
          {
            code: 'USDC',
            issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          },
        ],
      },
      framework: {
        database: { provider: 'sqlite' as const, url },
        watchers: { enabled: false },
      },
    };
    const plugins: AnchorPlugin[] = [
      {
        id: 'ledger',
        schema: {
          migrations: [
            {
              name: '001-ledger-entries',
              async up({ execute }) {
                await execute(`
                  CREATE TABLE IF NOT EXISTS plugin_migration_order (
                    sequence INTEGER PRIMARY KEY,
                    plugin_id TEXT NOT NULL
                  );
                  INSERT INTO plugin_migration_order (sequence, plugin_id)
                  SELECT COALESCE(MAX(sequence), 0) + 1, 'ledger' FROM plugin_migration_order;
                  CREATE TABLE ledger_entries (
                    id TEXT PRIMARY KEY,
                    reference TEXT NOT NULL
                  );
                  INSERT INTO ledger_entries (id, reference)
                  VALUES ('ledger-fixture', 'preserve-ledger-data');
                `);
              },
            },
          ],
        },
      },
      {
        id: 'audit',
        schema: {
          migrations: [
            {
              name: '001-audit-events',
              async up({ execute }) {
                await execute(`
                  CREATE TABLE IF NOT EXISTS plugin_migration_order (
                    sequence INTEGER PRIMARY KEY,
                    plugin_id TEXT NOT NULL
                  );
                  INSERT INTO plugin_migration_order (sequence, plugin_id)
                  SELECT COALESCE(MAX(sequence), 0) + 1, 'audit' FROM plugin_migration_order;
                  CREATE TABLE audit_events (
                    id TEXT PRIMARY KEY,
                    detail TEXT NOT NULL
                  );
                  INSERT INTO audit_events (id, detail)
                  VALUES ('audit-fixture', 'preserve-audit-data');
                `);
              },
            },
          ],
        },
      },
    ];
    const anchor = createAnchor(config);
    for (const plugin of plugins) anchor.use(plugin);
    const coreAdapter = new SqlDatabaseAdapter({ provider: 'sqlite', url });
    let repeatAdapter: SqlDatabaseAdapter | undefined;

    try {
      await coreAdapter.connect();
      await coreAdapter.migrate();
      await coreAdapter.disconnect();

      const existingCoreDatabase = new Database(path);
      try {
        existingCoreDatabase
          .prepare(
            `INSERT INTO auth_challenges
              (id, account, challenge, expires_at, consumed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'existing-core-challenge',
            'GABC',
            'core-challenge',
            '2099-01-01',
            null,
            '2025-01-01',
          );
      } finally {
        existingCoreDatabase.close();
      }

      await anchor.init();
      await anchor.shutdown();

      const pluginMigrations = plugins.flatMap((plugin) =>
        (plugin.schema?.migrations ?? []).map((migration) => ({
          ...migration,
          name: `plugin:${encodeURIComponent(plugin.id)}:${encodeURIComponent(migration.name)}`,
        })),
      );
      repeatAdapter = new SqlDatabaseAdapter({ provider: 'sqlite', url }, pluginMigrations);
      await repeatAdapter.connect();
      await repeatAdapter.migrate();

      const database = (repeatAdapter as unknown as { sqlite: Database }).sqlite;
      expect(
        database.prepare('SELECT plugin_id FROM plugin_migration_order ORDER BY sequence').all(),
      ).toEqual([{ plugin_id: 'ledger' }, { plugin_id: 'audit' }]);
      expect(
        database
          .prepare('SELECT name FROM anchor_kit_migrations WHERE name LIKE ? ORDER BY name')
          .all('plugin:%'),
      ).toEqual([
        { name: 'plugin:audit:001-audit-events' },
        { name: 'plugin:ledger:001-ledger-entries' },
      ]);
      expect(database.prepare('SELECT id, reference FROM ledger_entries').get()).toEqual({
        id: 'ledger-fixture',
        reference: 'preserve-ledger-data',
      });
      expect(database.prepare('SELECT id, detail FROM audit_events').get()).toEqual({
        id: 'audit-fixture',
        detail: 'preserve-audit-data',
      });
      expect(
        database
          .prepare('SELECT id, challenge FROM auth_challenges WHERE id = ?')
          .get('existing-core-challenge'),
      ).toEqual({ id: 'existing-core-challenge', challenge: 'core-challenge' });
    } finally {
      await repeatAdapter?.disconnect();
      await anchor.shutdown();
      await coreAdapter.disconnect();
      removeSqliteFile(path);
    }
  });
});
