import { createAnchor, makeSqliteDbUrlForTests } from '@/index.ts';
import { SqlDatabaseAdapter } from '@/runtime/database/sql-database-adapter.ts';
import type { SchemaMigration } from '@/types/foundation.ts';
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
      ]);
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

  it('registers plugin migrations through the public factory', async () => {
    const url = makeSqliteDbUrlForTests();
    const path = url.slice('file:'.length);
    const key = Keypair.random().secret();
    const anchor = createAnchor({
      network: { network: 'testnet' },
      server: { interactiveDomain: 'https://anchor.example.com' },
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
        database: { provider: 'sqlite', url },
        watchers: { enabled: false },
      },
    });
    anchor.use({
      id: 'ledger',
      schema: {
        migrations: [
          {
            name: '001-ledger-entries',
            async up({ execute }) {
              await execute(
                'CREATE TABLE ledger_entries (id TEXT PRIMARY KEY, reference TEXT NOT NULL)',
              );
            },
          },
        ],
      },
    });

    try {
      await anchor.init();
      const database = new Database(path);
      try {
        expect(
          database
            .prepare('SELECT name FROM anchor_kit_migrations WHERE name = ?')
            .get('plugin:ledger:001-ledger-entries'),
        ).toEqual({ name: 'plugin:ledger:001-ledger-entries' });
        expect(
          database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
            .get('ledger_entries'),
        ).toEqual({ name: 'ledger_entries' });
      } finally {
        database.close();
      }
    } finally {
      await anchor.shutdown();
      removeSqliteFile(path);
    }
  });
});
