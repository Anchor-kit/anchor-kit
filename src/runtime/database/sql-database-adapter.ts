import { ConfigError, MalformedPersistedDataError } from '../../core/errors.ts';
import type {
  AuthChallengeRecord,
  DatabaseAdapter,
  IdempotencyRecord,
  InteractiveTransactionRecord,
  TransactionTransitionResult,
  SettlementJobRecord,
  WatcherTaskRecord,
  WebhookEventRecord,
} from '@/runtime/interfaces.ts';
import type { Customer } from '@/types/customer.ts';
import { getAllowedNextTransactionStatuses } from '@/types/transaction-status.ts';
import type { FrameworkConfig } from '@/types/config.ts';
import { isTransactionStatus, type TransactionStatus } from '../../types/transaction-status.ts';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type SqliteLike = Database;

interface PostgresClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}

const SQLITE_FILE_PREFIX = 'file:';
const SQLITE_URL_PREFIX = 'sqlite:';

/**
 * Versioned migration applied to the webhook_events table.
 *
 * Attempt identity, processing lease and stable operation key columns let a
 * retried callback be traced and claimed without confusing an old execution
 * owner with a new one. The version is recorded in `schema_migrations` so the
 * migration is applied exactly once per database.
 */
export const WEBHOOK_ATTEMPT_MIGRATION_VERSION = '20240101000000_webhook_attempt_identity';

export const WEBHOOK_ATTEMPT_COLUMNS: readonly string[] = [
  'attempt_id',
  'attempt_number',
  'lease_owner',
  'lease_expires_at',
  'operation_key',
];

const WEBHOOK_ATTEMPT_SQLITE_DDL: readonly string[] = [
  'ALTER TABLE webhook_events ADD COLUMN attempt_id TEXT',
  'ALTER TABLE webhook_events ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE webhook_events ADD COLUMN lease_owner TEXT',
  'ALTER TABLE webhook_events ADD COLUMN lease_expires_at TEXT',
  'ALTER TABLE webhook_events ADD COLUMN operation_key TEXT',
];

const WEBHOOK_ATTEMPT_POSTGRES_DDL: readonly string[] = [
  'ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempt_id TEXT',
  'ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS lease_owner TEXT',
  'ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ',
  'ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS operation_key TEXT',
];

/**
 * Journal mode requested for file-backed SQLite databases.
 *
 * WAL lets readers keep working while a single writer commits, so the webhook,
 * watcher, and idempotency writes that overlap during normal anchor operation
 * queue behind each other instead of failing. SQLite stores the journal mode in
 * the database file itself, so applying it once on connect also covers later
 * connections to the same file.
 */
export const SQLITE_JOURNAL_MODE = 'WAL';

/**
 * How long a blocked SQLite writer waits for a competing lock before giving up
 * with SQLITE_BUSY. Overlapping writes are short-lived, so a retry window
 * absorbs lock contention that would otherwise surface as avoidable errors.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Indexes supporting watcher polling and retention cleanup.
 *
 * Watcher polling filters `watcher_tasks` by `status` and orders by
 * `created_at`, while retention deletes rows by `created_at` combined with a
 * `status` filter. The same shape applies to `webhook_events`. Auth challenges
 * are pruned by `expires_at`, and idempotency keys by `created_at`. Each index
 * is created with `IF NOT EXISTS` so migrations stay repeatable on both fresh
 * and already-migrated databases.
 */
export const SQLITE_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_watcher_tasks_status_created_at ON watcher_tasks (status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created_at ON webhook_events (status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_events_operation_key ON webhook_events (operation_key)',
  'CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges (expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at)',
  'CREATE INDEX IF NOT EXISTS idx_settlement_jobs_status_created_at ON settlement_jobs (status, created_at)',
];

export const POSTGRES_INDEX_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_watcher_tasks_status_created_at ON watcher_tasks (status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created_at ON webhook_events (status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_webhook_events_operation_key ON webhook_events (operation_key)',
  'CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at ON auth_challenges (expires_at)',
  'CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at)',
  'CREATE INDEX IF NOT EXISTS idx_settlement_jobs_status_created_at ON settlement_jobs (status, created_at)',
];

function nowIso(): string {
  return new Date().toISOString();
}

function toSqlitePath(url: string): string {
  if (url.startsWith(SQLITE_FILE_PREFIX)) {
    return url.slice(SQLITE_FILE_PREFIX.length);
  }
  if (url.startsWith(SQLITE_URL_PREFIX)) {
    return url.slice(SQLITE_URL_PREFIX.length);
  }
  return url;
}

/**
 * In-memory databases keep SQLite's `memory` journal mode and share no file for
 * connections to coordinate on, so WAL does not apply to them. Both the plain
 * `:memory:` form and URI forms such as `file::memory:` or `?mode=memory` are
 * recognised so in-memory test databases keep working unchanged.
 */
function isInMemorySqlite(path: string): boolean {
  return path.includes(':memory:') || path.includes('mode=memory');
}

/**
 * Applies the concurrency settings to a freshly opened SQLite connection.
 *
 * `busy_timeout` applies to every connection, including in-memory ones, while
 * the WAL journal mode is only requested for file-backed databases.
 */
function configureSqliteConnection(database: SqliteLike, path: string): void {
  database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);

  if (isInMemorySqlite(path)) {
    return;
  }

  database.exec(`PRAGMA journal_mode = ${SQLITE_JOURNAL_MODE};`);
}

function parseJsonObject(value: unknown, parseSerializedText: boolean): Record<string, unknown> {
  let parsed = value;

  if (parseSerializedText && typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new MalformedPersistedDataError(
        `Malformed persisted JSON payload: ${error instanceof Error ? error.message : String(error)}`,
        { value: value.slice(0, 200) },
      );
    }
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    (Object.getPrototypeOf(parsed) !== Object.prototype && Object.getPrototypeOf(parsed) !== null)
  ) {
    throw new MalformedPersistedDataError(
      'Persisted JSON payload must decode to a plain object; arrays and primitive values are not allowed.',
      { valueType: Array.isArray(parsed) ? 'array' : typeof parsed },
    );
  }

  return parsed as Record<string, unknown>;
}

function validateSchemaIdentifier(schema: string): string {
  if (schema.length > 63 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new ConfigError(
      'Database schema must be a PostgreSQL identifier (1-63 ASCII letters, digits, or underscores; it cannot start with a digit)',
    );
  }
  return schema;
}

type PersistedTaskStatus = 'pending' | 'processed' | 'failed';
type PersistedWebhookStatus = PersistedTaskStatus | 'unresolved';

function parsePersistedTaskStatus(value: unknown): PersistedTaskStatus {
  if (value === 'pending' || value === 'processed' || value === 'failed') {
    return value;
  }

  throw new MalformedPersistedDataError('Invalid persisted watcher task status.');
}

function parsePersistedWebhookStatus(value: unknown): PersistedWebhookStatus {
  if (
    value === 'pending' ||
    value === 'processed' ||
    value === 'failed' ||
    value === 'unresolved'
  ) {
    return value;
  }

  throw new MalformedPersistedDataError('Invalid persisted webhook event status.');
}

/**
 * Regex used to inspect the persisted `webhook_events` SQL and detect whether
 * the composite `UNIQUE(provider, event_id)` constraint has been applied.
 *
 * Legacy databases have a single-column UNIQUE on `event_id`, which suppresses
 * legitimate cross-provider events that share an ID. The migration below
 * rebuilds the table once this pattern is absent.
 */
const WEBHOOK_COMPOSITE_UNIQUE_PATTERN = /UNIQUE\s*\(\s*provider\s*,\s*event_id\s*\)/i;

export class SqlDatabaseAdapter implements DatabaseAdapter {
  private readonly provider: FrameworkConfig['database']['provider'];
  private readonly url: string;
  private readonly schema: string | null;
  private sqlite: SqliteLike | null = null;
  private postgres: PostgresClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private migratePromise: Promise<void> | null = null;
  private appliedMigrationVersions: Set<string> | null = null;

  constructor(databaseConfig: FrameworkConfig['database']) {
    this.provider = databaseConfig.provider;
    this.url = databaseConfig.url;
    this.schema =
      databaseConfig.schema !== undefined
        ? validateSchemaIdentifier(databaseConfig.schema)
        : this.provider === 'postgres'
          ? 'public'
          : null;
    if (this.provider === 'sqlite' && this.schema && this.schema !== 'main') {
      throw new ConfigError('SQLite only supports the default "main" database schema');
    }
  }

  public async connect(): Promise<void> {
    if (this.sqlite || this.postgres) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = (async () => {
      try {
        if (this.provider === 'sqlite') {
          const path = toSqlitePath(this.url);
          const database = await loadSqliteDatabase(path);

          try {
            configureSqliteConnection(database, path);
          } catch (error) {
            // Do not leak the handle when the connection cannot be tuned.
            database.close();
            throw error;
          }

          this.sqlite = database;
          return;
        }

        if (this.provider === 'postgres') {
          const moduleName = 'pg';
          const pgModuleUnknown: unknown = await import(moduleName);
          const pgModule = pgModuleUnknown as {
            Client: new (config: { connectionString: string }) => PostgresClient;
          };
          const client = new pgModule.Client({ connectionString: this.url });
          this.postgres = client;
          await this.postgres.connect();
          return;
        }

        throw new ConfigError(`Unsupported database provider: ${this.provider}`);
      } catch (error) {
        this.sqlite = null;
        this.postgres = null;
        throw error;
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  public async disconnect(): Promise<void> {
    if (!this.sqlite && !this.postgres) {
      return;
    }

    if (this.disconnectPromise) {
      await this.disconnectPromise;
      return;
    }

    this.disconnectPromise = (async () => {
      const sqlite = this.sqlite;
      const postgres = this.postgres;
      this.sqlite = null;
      this.postgres = null;

      try {
        if (sqlite) {
          sqlite.close();
        }

        if (postgres) {
          await postgres.end();
        }
      } catch (error) {
        this.sqlite = sqlite;
        this.postgres = postgres;
        throw error;
      }
    })();

    try {
      await this.disconnectPromise;
    } finally {
      this.disconnectPromise = null;
    }
  }

  public async migrate(): Promise<void> {
    if (this.migratePromise) {
      await this.migratePromise;
      return;
    }

    this.migratePromise = this.runMigrations();

    try {
      await this.migratePromise;
    } finally {
      // Clear the guard once the sequence settles so a failed migration can be
      // retried by the next caller instead of being cached as successful.
      this.migratePromise = null;
    }
  }

  private async runMigrations(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_challenges (
          id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          challenge TEXT NOT NULL UNIQUE,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS interactive_transactions (
          id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          kind TEXT NOT NULL,
          asset_code TEXT NOT NULL,
          amount TEXT NOT NULL,
          amount_in TEXT,
          amount_out TEXT,
          amount_fee TEXT,
          currency TEXT,
          rail_reference TEXT,
          stellar_transaction_hash TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          email_address TEXT,
          phone_number TEXT,
          kyc_data TEXT,
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS customer_accounts (
          account_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id),
          created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS idempotency_keys (
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

        CREATE TABLE IF NOT EXISTS webhook_events (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(provider, event_id)
        );

        CREATE TABLE IF NOT EXISTS watcher_tasks (
          id TEXT PRIMARY KEY,
          watcher_name TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS anchor_kit_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settlement_jobs (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          payload_ref TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      const idempotencyColumns = this.sqlite
        .prepare('PRAGMA table_info(idempotency_keys)')
        .all() as Array<{ name?: unknown }>;
      if (!idempotencyColumns.some((column) => column.name === 'status')) {
        this.sqlite.exec(
          "ALTER TABLE idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
        );
      }
      this.migrateInteractiveTransactionFieldsSqlite();
      this.upgradeLegacyWebhookDedupeSqlite();
      await this.applyWebhookAttemptMigrationSqlite();
      for (const statement of SQLITE_INDEX_STATEMENTS) {
        this.sqlite.exec(statement);
      }
      return;
    }

    if (this.postgres) {
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL
        );
      `);
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS auth_challenges (
          id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          challenge TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );
      `);
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS interactive_transactions (
          id TEXT PRIMARY KEY,
          account TEXT NOT NULL,
          kind TEXT NOT NULL,
          asset_code TEXT NOT NULL,
          amount TEXT NOT NULL,
          amount_in TEXT,
          amount_out TEXT,
          amount_fee TEXT,
          currency TEXT,
          rail_reference TEXT,
          stellar_transaction_hash TEXT,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
      `);
      for (const column of [
        'amount_in TEXT',
        'amount_out TEXT',
        'amount_fee TEXT',
        'currency TEXT',
        'rail_reference TEXT',
        'stellar_transaction_hash TEXT',
      ]) {
        await this.postgres.query(
          `ALTER TABLE interactive_transactions ADD COLUMN IF NOT EXISTS ${column}`,
        );
      }
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS customers (
          id TEXT PRIMARY KEY,
          email_address TEXT,
          phone_number TEXT,
          kyc_data JSONB,
          created_at BIGINT NOT NULL
        );
      `);
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS customer_accounts (
          account_id TEXT PRIMARY KEY,
          customer_id TEXT NOT NULL REFERENCES customers(id),
          created_at BIGINT NOT NULL
        );
      `);
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed',
          status_code INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          UNIQUE(scope, idempotency_key)
        );
      `);
      await this.postgres.query(
        "ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'",
      );
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS webhook_events (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          payload JSONB NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL,
          UNIQUE(provider, event_id)
        );
      `);
      await this.upgradeLegacyWebhookDedupePostgres();
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS watcher_tasks (
          id TEXT PRIMARY KEY,
          watcher_name TEXT NOT NULL,
          payload JSONB NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );
      `);
      await this.postgres.query(`
        CREATE TABLE IF NOT EXISTS settlement_jobs (
          id TEXT PRIMARY KEY,
          operation_id TEXT NOT NULL UNIQUE,
          payload_ref TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
        );
      `);
      await this.applyWebhookAttemptMigrationPostgres();
      for (const statement of POSTGRES_INDEX_STATEMENTS) {
        await this.postgres.query(statement);
      }
      return;
    }

    throw new ConfigError('Database not connected');
  }

  private async applyWebhookAttemptMigrationSqlite(): Promise<void> {
    if (!this.sqlite) {
      throw new ConfigError('Database not connected');
    }

    const applied = this.sqlite
      .prepare('SELECT version FROM schema_migrations WHERE version = ? LIMIT 1')
      .get(WEBHOOK_ATTEMPT_MIGRATION_VERSION) as { version?: unknown } | null;

    if (applied) {
      return;
    }

    const existingColumns = this.sqlite
      .prepare('PRAGMA table_info(webhook_events)')
      .all() as Array<{ name?: unknown }>;
    const existingNames = new Set(existingColumns.map((column) => String(column.name)));

    for (const statement of WEBHOOK_ATTEMPT_SQLITE_DDL) {
      const columnName = statement.split(' ADD COLUMN ')[1]?.split(' ')[0];
      if (columnName && existingNames.has(columnName)) {
        continue;
      }
      this.sqlite.exec(statement);
    }

    this.sqlite
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(WEBHOOK_ATTEMPT_MIGRATION_VERSION, nowIso());
  }

  private async applyWebhookAttemptMigrationPostgres(): Promise<void> {
    const postgres = this.requirePostgres();
    const applied = await postgres.query<{ version: string }>(
      'SELECT version FROM schema_migrations WHERE version = $1 LIMIT 1',
      [WEBHOOK_ATTEMPT_MIGRATION_VERSION],
    );

    if (applied.rows.length > 0) {
      return;
    }

    for (const statement of WEBHOOK_ATTEMPT_POSTGRES_DDL) {
      await postgres.query(statement);
    }

    await postgres.query(
      'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT(version) DO NOTHING',
      [WEBHOOK_ATTEMPT_MIGRATION_VERSION, nowIso()],
    );
  }

  private migrateInteractiveTransactionFieldsSqlite(): void {
    if (!this.sqlite) throw new ConfigError('Database not connected');

    const existingColumns = this.sqlite
      .prepare('PRAGMA table_info(interactive_transactions)')
      .all() as Array<{ name?: unknown }>;
    const existingNames = new Set(existingColumns.map((column) => String(column.name)));
    const columnDefinitions = [
      ['amount_in', 'TEXT'],
      ['amount_out', 'TEXT'],
      ['amount_fee', 'TEXT'],
      ['currency', 'TEXT'],
      ['rail_reference', 'TEXT'],
      ['stellar_transaction_hash', 'TEXT'],
    ] as const;

    for (const [column, type] of columnDefinitions) {
      if (!existingNames.has(column)) {
        this.sqlite.exec(`ALTER TABLE interactive_transactions ADD COLUMN ${column} ${type}`);
      }
    }

    this.sqlite
      .prepare(
        'INSERT INTO anchor_kit_schema_migrations (version, applied_at) VALUES (?, ?) ON CONFLICT(version) DO NOTHING',
      )
      .run(1, nowIso());
  }

  /**
   * Rebuilds the SQLite `webhook_events` table when it still carries the
   * pre-AK-046 single-column `UNIQUE(event_id)` constraint.
   *
   * SQLite has no `ALTER TABLE ... DROP CONSTRAINT`, so the only safe upgrade is
   * a rename-based rebuild inside a single transaction. Fresh databases pick up
   * the new constraint from `CREATE TABLE ... UNIQUE(provider, event_id)` and
   * skip this branch entirely, keeping the migration statement count stable.
   */
  private upgradeLegacyWebhookDedupeSqlite(): void {
    if (!this.sqlite) return;

    const schemaRow = this.sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'")
      .get() as { sql?: string | null } | null;
    const schemaSql = schemaRow?.sql ?? '';

    if (WEBHOOK_COMPOSITE_UNIQUE_PATTERN.test(schemaSql)) {
      return;
    }

    const existingColumns = this.sqlite
      .prepare('PRAGMA table_info(webhook_events)')
      .all() as Array<{ name?: unknown }>;
    const existingNames = new Set(existingColumns.map((column) => String(column.name)));
    const attemptColumnDefinitions: Record<string, string> = {
      attempt_id: 'TEXT',
      attempt_number: 'INTEGER NOT NULL DEFAULT 0',
      lease_owner: 'TEXT',
      lease_expires_at: 'TEXT',
      operation_key: 'TEXT',
    };
    const preservedAttemptColumns = WEBHOOK_ATTEMPT_COLUMNS.filter((column) =>
      existingNames.has(column),
    );
    const optionalDefinitions = preservedAttemptColumns
      .map((column) => `${column} ${attemptColumnDefinitions[column]}`)
      .join(',\n        ');
    const optionalColumnList = preservedAttemptColumns.length
      ? `, ${preservedAttemptColumns.join(', ')}`
      : '';

    this.sqlite.exec(`
      BEGIN;
      CREATE TABLE webhook_events_rebuild (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        processed_at TEXT,
        created_at TEXT NOT NULL,
        ${optionalDefinitions ? `${optionalDefinitions},` : ''}
        UNIQUE(provider, event_id)
      );
      INSERT INTO webhook_events_rebuild
        (id, event_id, provider, payload, status, error_message, processed_at, created_at${optionalColumnList})
        SELECT id, event_id, provider, payload, status, error_message, processed_at, created_at${optionalColumnList}
        FROM webhook_events;
      DROP TABLE webhook_events;
      ALTER TABLE webhook_events_rebuild RENAME TO webhook_events;
      COMMIT;
    `);
  }

  /**
   * Upgrades PostgreSQL `webhook_events` in place:
   *  - drops any legacy single-column `UNIQUE (event_id)` constraint(s), and
   *  - adds the composite `UNIQUE (provider, event_id)` constraint if missing.
   *
   * Both steps are idempotent so the migration can run on fresh installs,
   * partially-upgraded databases, and already-migrated databases unchanged.
   */
  private async upgradeLegacyWebhookDedupePostgres(): Promise<void> {
    await this.requirePostgres().query(`
      DO $$
      DECLARE
        constraint_name text;
      BEGIN
        FOR constraint_name IN
          SELECT c.conname
          FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'webhook_events'
            AND c.contype = 'u'
            AND pg_get_constraintdef(c.oid) ~ '^UNIQUE\\s*\\(\\s*event_id\\s*\\)$'
        LOOP
          EXECUTE format('ALTER TABLE webhook_events DROP CONSTRAINT %I', constraint_name);
        END LOOP;

        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint c
          JOIN pg_class t ON c.conrelid = t.oid
          WHERE t.relname = 'webhook_events'
            AND c.contype = 'u'
            AND pg_get_constraintdef(c.oid) ~ '^UNIQUE\\s*\\(\\s*provider\\s*,\\s*event_id\\s*\\)$'
        ) THEN
          ALTER TABLE webhook_events
            ADD CONSTRAINT webhook_events_provider_event_id_key UNIQUE (provider, event_id);
        END IF;
      END $$;
    `);
  }

  public async insertAuthChallenge(input: {
    id: string;
    account: string;
    challenge: string;
    expiresAt: string;
  }): Promise<void> {
    const createdAt = nowIso();
    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO auth_challenges (id, account, challenge, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        )
        .run(input.id, input.account, input.challenge, input.expiresAt, createdAt);
      return;
    }

    await this.requirePostgres().query(
      'INSERT INTO auth_challenges (id, account, challenge, expires_at, consumed_at, created_at) VALUES ($1, $2, $3, $4, NULL, $5)',
      [input.id, input.account, input.challenge, input.expiresAt, createdAt],
    );
  }

  public async getAuthChallengeByChallenge(challenge: string): Promise<AuthChallengeRecord | null> {
    if (this.sqlite) {
      const row = this.sqlite
        .prepare('SELECT * FROM auth_challenges WHERE challenge = ? LIMIT 1')
        .get(challenge) as Record<string, unknown> | null;

      if (!row) return null;
      return {
        id: String(row.id),
        account: String(row.account),
        challenge: String(row.challenge),
        expiresAt: String(row.expires_at),
        consumedAt: row.consumed_at ? String(row.consumed_at) : null,
        createdAt: String(row.created_at),
      };
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM auth_challenges WHERE challenge = $1 LIMIT 1',
      [challenge],
    );

    const row = response.rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      account: String(row.account),
      challenge: String(row.challenge),
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at ? String(row.consumed_at) : null,
      createdAt: String(row.created_at),
    };
  }

  public async markAuthChallengeConsumed(id: string): Promise<boolean> {
    const consumedAt = nowIso();
    if (this.sqlite) {
      const result = this.sqlite
        .prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(consumedAt, id);
      return result.changes > 0;
    }

    const response = await this.requirePostgres().query(
      'UPDATE auth_challenges SET consumed_at = $1 WHERE id = $2 AND consumed_at IS NULL',
      [consumedAt, id],
    );
    return (response.rowCount ?? 0) > 0;
  }

  public async insertInteractiveTransaction(input: {
    id: string;
    account: string;
    kind: 'deposit';
    assetCode: string;
    amount: string;
    amountIn?: string | null;
    amountOut?: string | null;
    amountFee?: string | null;
    currency?: string | null;
    railReference?: string | null;
    stellarTransactionHash?: string | null;
    status: TransactionStatus;
  }): Promise<InteractiveTransactionRecord> {
    const createdAt = nowIso();
    const updatedAt = createdAt;

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, amount_in, amount_out, amount_fee, currency, rail_reference, stellar_transaction_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.id,
          input.account,
          input.kind,
          input.assetCode,
          input.amount,
          input.amountIn ?? null,
          input.amountOut ?? null,
          input.amountFee ?? null,
          input.currency ?? null,
          input.railReference ?? null,
          input.stellarTransactionHash ?? null,
          input.status,
          createdAt,
          updatedAt,
        );
    } else {
      await this.requirePostgres().query(
        'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, amount_in, amount_out, amount_fee, currency, rail_reference, stellar_transaction_hash, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)',
        [
          input.id,
          input.account,
          input.kind,
          input.assetCode,
          input.amount,
          input.amountIn ?? null,
          input.amountOut ?? null,
          input.amountFee ?? null,
          input.currency ?? null,
          input.railReference ?? null,
          input.stellarTransactionHash ?? null,
          input.status,
          createdAt,
          updatedAt,
        ],
      );
    }

    return {
      id: input.id,
      account: input.account,
      kind: input.kind,
      assetCode: input.assetCode,
      amount: input.amount,
      amountIn: input.amountIn ?? null,
      amountOut: input.amountOut ?? null,
      amountFee: input.amountFee ?? null,
      currency: input.currency ?? null,
      railReference: input.railReference ?? null,
      stellarTransactionHash: input.stellarTransactionHash ?? null,
      status: input.status,
      createdAt,
      updatedAt,
    };
  }

  public async getInteractiveTransactionById(
    id: string,
  ): Promise<InteractiveTransactionRecord | null> {
    if (this.sqlite) {
      const row = this.sqlite
        .prepare('SELECT * FROM interactive_transactions WHERE id = ? LIMIT 1')
        .get(id) as Record<string, unknown> | null;

      if (!row) return null;
      return this.mapTransactionRow(row);
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM interactive_transactions WHERE id = $1 LIMIT 1',
      [id],
    );

    const row = response.rows[0];
    if (!row) return null;
    return this.mapTransactionRow(row);
  }

  public async listPendingTransactionsBefore(
    cutoffIso: string,
  ): Promise<InteractiveTransactionRecord[]> {
    if (this.sqlite) {
      const rows = this.sqlite
        .prepare(
          "SELECT * FROM interactive_transactions WHERE status = 'pending_user_transfer_start' AND created_at < ? ORDER BY created_at ASC, id ASC",
        )
        .all(cutoffIso) as Record<string, unknown>[];
      return rows.map((row) => this.mapTransactionRow(row));
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      "SELECT * FROM interactive_transactions WHERE status = 'pending_user_transfer_start' AND created_at < $1 ORDER BY created_at ASC, id ASC",
      [cutoffIso],
    );
    return response.rows.map((row) => this.mapTransactionRow(row));
  }

  public async updateTransactionStatus(
    id: string,
    status: TransactionStatus,
    expectedStatus?: TransactionStatus,
  ): Promise<boolean> {
    const updatedAt = nowIso();
    if (this.sqlite) {
      const result = expectedStatus
        ? this.sqlite
            .prepare(
              'UPDATE interactive_transactions SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
            )
            .run(status, updatedAt, id, expectedStatus)
        : this.sqlite
            .prepare('UPDATE interactive_transactions SET status = ?, updated_at = ? WHERE id = ?')
            .run(status, updatedAt, id);
      return result.changes > 0;
    }

    const response = expectedStatus
      ? await this.requirePostgres().query<{ id: string }>(
          'UPDATE interactive_transactions SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4 RETURNING id',
          [status, updatedAt, id, expectedStatus],
        )
      : await this.requirePostgres().query<{ id: string }>(
          'UPDATE interactive_transactions SET status = $1, updated_at = $2 WHERE id = $3 RETURNING id',
          [status, updatedAt, id],
        );
    return response.rows.length > 0;
  }

  public async transitionInteractiveTransaction(input: {
    id: string;
    expectedStatus: TransactionStatus;
    status: TransactionStatus;
    amount?: string;
  }): Promise<TransactionTransitionResult> {
    if (!getAllowedNextTransactionStatuses(input.expectedStatus).includes(input.status)) {
      const transaction = await this.getInteractiveTransactionById(input.id);
      return {
        outcome: 'conflict',
        reason: transaction ? 'invalid_transition' : 'not_found',
        transaction,
      };
    }

    const updatedAt = nowIso();
    let updated = false;

    if (this.sqlite) {
      const result =
        input.amount === undefined
          ? this.sqlite
              .prepare(
                'UPDATE interactive_transactions SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
              )
              .run(input.status, updatedAt, input.id, input.expectedStatus)
          : this.sqlite
              .prepare(
                'UPDATE interactive_transactions SET status = ?, amount = ?, updated_at = ? WHERE id = ? AND status = ?',
              )
              .run(input.status, input.amount, updatedAt, input.id, input.expectedStatus);
      updated = result.changes > 0;
    } else {
      const response =
        input.amount === undefined
          ? await this.requirePostgres().query<Record<string, unknown>>(
              'UPDATE interactive_transactions SET status = $1, updated_at = $2 WHERE id = $3 AND status = $4 RETURNING *',
              [input.status, updatedAt, input.id, input.expectedStatus],
            )
          : await this.requirePostgres().query<Record<string, unknown>>(
              'UPDATE interactive_transactions SET status = $1, amount = $2, updated_at = $3 WHERE id = $4 AND status = $5 RETURNING *',
              [input.status, input.amount, updatedAt, input.id, input.expectedStatus],
            );

      const row = response.rows[0];
      if (row) {
        return { outcome: 'updated', transaction: this.mapTransactionRow(row) };
      }
    }

    if (updated) {
      const transaction = await this.getInteractiveTransactionById(input.id);
      if (!transaction) {
        throw new ConfigError('Transaction disappeared after a successful status transition');
      }
      return { outcome: 'updated', transaction };
    }

    const transaction = await this.getInteractiveTransactionById(input.id);
    return {
      outcome: 'conflict',
      reason: transaction ? 'status_mismatch' : 'not_found',
      transaction,
    };
  }

  public async insertOrGetCustomer(input: Omit<Customer, 'created_at'>): Promise<Customer> {
    const createdAt = Date.now();
    const kycData = input.kyc_data ? JSON.stringify(input.kyc_data) : null;

    if (this.sqlite) {
      const database = this.sqlite;
      return database.transaction(() => {
        database
          .prepare(
            'INSERT INTO customers (id, email_address, phone_number, kyc_data, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING',
          )
          .run(
            input.id,
            input.email_address ?? null,
            input.phone_number ?? null,
            kycData,
            createdAt,
          );
        database
          .prepare(
            'INSERT INTO customer_accounts (account_id, customer_id, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING',
          )
          .run(input.account_id, input.id, createdAt);

        const row = database
          .prepare(
            'SELECT customers.id, customer_accounts.account_id, customers.email_address, customers.phone_number, customers.kyc_data, customers.created_at FROM customer_accounts INNER JOIN customers ON customers.id = customer_accounts.customer_id WHERE customer_accounts.account_id = ? LIMIT 1',
          )
          .get(input.account_id) as Record<string, unknown> | null;

        if (!row || String(row.id) !== input.id) {
          throw new ConfigError('Account is already associated with a different customer');
        }
        return this.mapCustomerRow(row);
      })();
    }

    const postgres = this.requirePostgres();
    await postgres.query('BEGIN');
    try {
      await postgres.query(
        'INSERT INTO customers (id, email_address, phone_number, kyc_data, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT(id) DO NOTHING',
        [input.id, input.email_address ?? null, input.phone_number ?? null, kycData, createdAt],
      );
      await postgres.query(
        'INSERT INTO customer_accounts (account_id, customer_id, created_at) VALUES ($1, $2, $3) ON CONFLICT(account_id) DO NOTHING',
        [input.account_id, input.id, createdAt],
      );

      const response = await postgres.query<Record<string, unknown>>(
        'SELECT customers.id, customer_accounts.account_id, customers.email_address, customers.phone_number, customers.kyc_data, customers.created_at FROM customer_accounts INNER JOIN customers ON customers.id = customer_accounts.customer_id WHERE customer_accounts.account_id = $1 LIMIT 1',
        [input.account_id],
      );
      const row = response.rows[0];

      if (!row || String(row.id) !== input.id) {
        throw new ConfigError('Account is already associated with a different customer');
      }

      await postgres.query('COMMIT');
      return this.mapCustomerRow(row);
    } catch (error) {
      let rollbackError: unknown;
      let rollbackFailed = false;
      try {
        await postgres.query('ROLLBACK');
      } catch (error) {
        rollbackFailed = true;
        rollbackError = error;
      }
      if (rollbackFailed) {
        throw new AggregateError(
          [rollbackError],
          'Customer creation failed and its database transaction could not be rolled back',
          { cause: error },
        );
      }
      throw new Error(error instanceof Error ? error.message : 'Customer creation failed', {
        cause: error,
      });
    }
  }

  public async getCustomerByAccountId(accountId: string): Promise<Customer | null> {
    const sql =
      'SELECT customers.id, customer_accounts.account_id, customers.email_address, customers.phone_number, customers.kyc_data, customers.created_at FROM customer_accounts INNER JOIN customers ON customers.id = customer_accounts.customer_id WHERE customer_accounts.account_id = ? LIMIT 1';

    if (this.sqlite) {
      const row = this.sqlite.prepare(sql).get(accountId) as Record<string, unknown> | null;
      return row ? this.mapCustomerRow(row) : null;
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      sql.replace('?', '$1'),
      [accountId],
    );
    const row = response.rows[0];
    return row ? this.mapCustomerRow(row) : null;
  }

  public async getIdempotencyRecord(
    scope: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    if (this.sqlite) {
      const row = this.sqlite
        .prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? LIMIT 1')
        .get(scope, idempotencyKey) as Record<string, unknown> | null;
      return row ? this.mapIdempotencyRow(row) : null;
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2 LIMIT 1',
      [scope, idempotencyKey],
    );

    const row = response.rows[0];
    return row ? this.mapIdempotencyRow(row) : null;
  }

  public async insertOrGetIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    responseBody: string;
  }): Promise<IdempotencyRecord> {
    const createdAt = nowIso();

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, idempotency_key) DO NOTHING',
        )
        .run(
          input.id,
          input.scope,
          input.idempotencyKey,
          input.requestHash,
          input.statusCode,
          input.responseBody,
          createdAt,
        );

      const row = this.sqlite
        .prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? LIMIT 1')
        .get(input.scope, input.idempotencyKey) as Record<string, unknown>;

      if (!row) {
        throw new ConfigError('Failed to insert or retrieve idempotency record');
      }

      return this.mapIdempotencyRow(row);
    }

    await this.requirePostgres().query(
      'INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, response_body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(scope, idempotency_key) DO NOTHING',
      [
        input.id,
        input.scope,
        input.idempotencyKey,
        input.requestHash,
        input.statusCode,
        input.responseBody,
        createdAt,
      ],
    );

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2 LIMIT 1',
      [input.scope, input.idempotencyKey],
    );

    const row = response.rows[0];
    if (!row) {
      throw new ConfigError('Failed to insert or retrieve idempotency record');
    }

    return this.mapIdempotencyRow(row);
  }

  public async updateIdempotencyRecord(input: {
    scope: string;
    idempotencyKey: string;
    statusCode: number;
    responseBody: string;
  }): Promise<void> {
    if (this.sqlite) {
      this.sqlite
        .prepare(
          "UPDATE idempotency_keys SET status = 'completed', status_code = ?, response_body = ? WHERE scope = ? AND idempotency_key = ?",
        )
        .run(input.statusCode, input.responseBody, input.scope, input.idempotencyKey);
      return;
    }

    await this.requirePostgres().query(
      "UPDATE idempotency_keys SET status = 'completed', status_code = $1, response_body = $2 WHERE scope = $3 AND idempotency_key = $4",
      [input.statusCode, input.responseBody, input.scope, input.idempotencyKey],
    );
  }

  public async reserveIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ record: IdempotencyRecord; inserted: boolean }> {
    const createdAt = nowIso();

    if (this.sqlite) {
      const result = this.sqlite
        .prepare(
          "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, status_code, response_body, created_at) VALUES (?, ?, ?, ?, 'pending', 0, '', ?) ON CONFLICT(scope, idempotency_key) DO NOTHING",
        )
        .run(input.id, input.scope, input.idempotencyKey, input.requestHash, createdAt);
      const row = this.sqlite
        .prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? LIMIT 1')
        .get(input.scope, input.idempotencyKey) as Record<string, unknown> | null;
      if (!row) throw new ConfigError('Failed to reserve or retrieve idempotency record');
      return { record: this.mapIdempotencyRow(row), inserted: result.changes > 0 };
    }

    const postgres = this.requirePostgres();
    const result = await postgres.query(
      "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, status_code, response_body, created_at) VALUES ($1, $2, $3, $4, 'pending', 0, '', $5) ON CONFLICT(scope, idempotency_key) DO NOTHING",
      [input.id, input.scope, input.idempotencyKey, input.requestHash, createdAt],
    );
    const selected = await postgres.query<Record<string, unknown>>(
      'SELECT * FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2 LIMIT 1',
      [input.scope, input.idempotencyKey],
    );
    const row = selected.rows[0];
    if (!row) throw new ConfigError('Failed to reserve or retrieve idempotency record');
    return { record: this.mapIdempotencyRow(row), inserted: result.rowCount === 1 };
  }

  public async createDepositWithIdempotency(input: {
    transaction: {
      id: string;
      account: string;
      kind: 'deposit';
      assetCode: string;
      amount: string;
      status: TransactionStatus;
      createdAt: string;
    };
    idempotency: {
      scope: string;
      idempotencyKey: string;
      requestHash: string;
      statusCode: number;
      responseBody: string;
    };
  }): Promise<InteractiveTransactionRecord> {
    const transaction = input.transaction;
    const updatedAt = nowIso();

    if (this.sqlite) {
      const sqlite = this.sqlite;
      const create = sqlite.transaction(() => {
        sqlite
          .prepare(
            'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            transaction.id,
            transaction.account,
            transaction.kind,
            transaction.assetCode,
            transaction.amount,
            transaction.status,
            transaction.createdAt,
            updatedAt,
          );
        const completed = sqlite
          .prepare(
            "UPDATE idempotency_keys SET status = 'completed', status_code = ?, response_body = ? WHERE scope = ? AND idempotency_key = ? AND request_hash = ? AND status = 'pending'",
          )
          .run(
            input.idempotency.statusCode,
            input.idempotency.responseBody,
            input.idempotency.scope,
            input.idempotency.idempotencyKey,
            input.idempotency.requestHash,
          );
        if (completed.changes !== 1) {
          throw new ConfigError('Pending idempotency reservation was not found');
        }
      });
      create();
    } else {
      const postgres = this.requirePostgres();
      await postgres.query('BEGIN');
      try {
        await postgres.query(
          'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
          [
            transaction.id,
            transaction.account,
            transaction.kind,
            transaction.assetCode,
            transaction.amount,
            transaction.status,
            transaction.createdAt,
            updatedAt,
          ],
        );
        const completed = await postgres.query<{ id: string }>(
          "UPDATE idempotency_keys SET status = 'completed', status_code = $1, response_body = $2 WHERE scope = $3 AND idempotency_key = $4 AND request_hash = $5 AND status = 'pending' RETURNING id",
          [
            input.idempotency.statusCode,
            input.idempotency.responseBody,
            input.idempotency.scope,
            input.idempotency.idempotencyKey,
            input.idempotency.requestHash,
          ],
        );
        if (completed.rows.length !== 1) {
          throw new ConfigError('Pending idempotency reservation was not found');
        }
        await postgres.query('COMMIT');
      } catch (error) {
        await postgres.query('ROLLBACK');
        throw error;
      }
    }

    return {
      ...transaction,
      createdAt: transaction.createdAt,
      updatedAt,
    };
  }

  public async deletePendingIdempotencyRecord(
    scope: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<void> {
    if (this.sqlite) {
      this.sqlite
        .prepare(
          "DELETE FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? AND request_hash = ? AND status = 'pending'",
        )
        .run(scope, idempotencyKey, requestHash);
      return;
    }

    await this.requirePostgres().query(
      "DELETE FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2 AND request_hash = $3 AND status = 'pending'",
      [scope, idempotencyKey, requestHash],
    );
  }

  public async insertOrGetWebhookEvent(input: {
    id: string;
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
    operationKey?: string;
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }> {
    const createdAt = nowIso();
    const eventId = input.eventId.trim();
    const provider = input.provider.trim() || 'generic';
    const operationKey = input.operationKey?.trim() || null;

    if (this.sqlite) {
      // Provider-plus-event identity: a shared event_id from a different
      // provider refers to an unrelated event and must be inserted separately.
      const existing = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE provider = ? AND event_id = ? LIMIT 1')
        .get(provider, eventId) as Record<string, unknown> | null;

      if (existing) {
        const record = this.mapWebhookRow(existing);

        if (record.status === 'processed') {
          return { record, inserted: false };
        }

        if (record.status === 'failed') {
          // Compare-and-set: only claim execution if the row is still 'failed'.
          // A concurrent retry may have already flipped the status to 'pending',
          // in which case changes === 0 and this caller loses the race.
          const cas = this.sqlite
            .prepare(
              "UPDATE webhook_events SET payload = ?, status = 'pending', error_message = NULL, processed_at = NULL, attempt_id = NULL, lease_owner = NULL, lease_expires_at = NULL, operation_key = COALESCE(operation_key, ?) WHERE id = ? AND status = 'failed'",
            )
            .run(JSON.stringify(input.payload), operationKey, record.id);

          if (cas.changes === 0) {
            // Lost the race - return the current stored record without executing callbacks.
            const current = this.sqlite
              .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
              .get(record.id) as Record<string, unknown> | null;

            if (!current) {
              throw new ConfigError('Failed to retry failed webhook event');
            }

            return { record: this.mapWebhookRow(current), inserted: false };
          }

          const refreshed = this.sqlite
            .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
            .get(record.id) as Record<string, unknown> | null;

          if (!refreshed) {
            throw new ConfigError('Failed to retry failed webhook event');
          }

          return { record: this.mapWebhookRow(refreshed), inserted: true };
        }

        return { record, inserted: false };
      }

      this.sqlite
        .prepare(
          'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at, operation_key) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
        )
        .run(
          input.id,
          eventId,
          provider,
          JSON.stringify(input.payload),
          'pending',
          createdAt,
          operationKey,
        );

      const row = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
        .get(input.id) as Record<string, unknown> | null;

      if (!row) {
        throw new ConfigError('Failed to insert or retrieve webhook event');
      }

      return { record: this.mapWebhookRow(row), inserted: true };
    }

    // Provider-plus-event identity: same composite key as the SQLite path.
    const existingPg = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM webhook_events WHERE provider = $1 AND event_id = $2 LIMIT 1',
      [provider, eventId],
    );

    const existingRow = existingPg.rows[0];
    if (existingRow) {
      const record = this.mapWebhookRow(existingRow);

      if (record.status === 'processed') {
        return { record, inserted: false };
      }

      if (record.status === 'failed') {
        // Compare-and-set: only claim execution if the row is still 'failed'.
        // RETURNING id lets us detect whether the UPDATE matched any row.
        const cas = await this.requirePostgres().query<{ id: string }>(
          "UPDATE webhook_events SET payload = $1::jsonb, status = 'pending', error_message = NULL, processed_at = NULL, attempt_id = NULL, lease_owner = NULL, lease_expires_at = NULL, operation_key = COALESCE(operation_key, $2) WHERE id = $3 AND status = 'failed' RETURNING id",
          [JSON.stringify(input.payload), operationKey, record.id],
        );

        if (cas.rows.length === 0) {
          // Lost the race - return the current stored record without executing callbacks.
          const currentPg = await this.requirePostgres().query<Record<string, unknown>>(
            'SELECT * FROM webhook_events WHERE id = $1 LIMIT 1',
            [record.id],
          );

          const currentRow = currentPg.rows[0];
          if (!currentRow) {
            throw new ConfigError('Failed to retry failed webhook event');
          }

          return { record: this.mapWebhookRow(currentRow), inserted: false };
        }

        const refreshedPg = await this.requirePostgres().query<Record<string, unknown>>(
          'SELECT * FROM webhook_events WHERE id = $1 LIMIT 1',
          [record.id],
        );

        const refreshedRow = refreshedPg.rows[0];
        if (!refreshedRow) {
          throw new ConfigError('Failed to retry failed webhook event');
        }

        return { record: this.mapWebhookRow(refreshedRow), inserted: true };
      }

      return { record, inserted: false };
    }

    await this.requirePostgres().query(
      'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at, operation_key) VALUES ($1, $2, $3, $4::jsonb, $5, NULL, NULL, $6, $7)',
      [
        input.id,
        eventId,
        provider,
        JSON.stringify(input.payload),
        'pending',
        createdAt,
        operationKey,
      ],
    );

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM webhook_events WHERE id = $1 LIMIT 1',
      [input.id],
    );

    const row = response.rows[0];
    if (!row) {
      throw new ConfigError('Failed to insert or retrieve webhook event');
    }

    return { record: this.mapWebhookRow(row), inserted: true };
  }

  public async claimWebhookEventAttempt(input: {
    id: string;
    attemptId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso?: string;
  }): Promise<WebhookEventRecord | null> {
    const now = input.nowIso ?? nowIso();

    if (this.sqlite) {
      const result = this.sqlite
        .prepare(
          "UPDATE webhook_events SET attempt_id = ?, attempt_number = attempt_number + 1, lease_owner = ?, lease_expires_at = ? WHERE id = ? AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at < ?)",
        )
        .run(input.attemptId, input.leaseOwner, input.leaseExpiresAt, input.id, now);

      if (result.changes === 0) {
        return null;
      }

      const row = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
        .get(input.id) as Record<string, unknown> | null;

      return row ? this.mapWebhookRow(row) : null;
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      "UPDATE webhook_events SET attempt_id = $1, attempt_number = attempt_number + 1, lease_owner = $2, lease_expires_at = $3 WHERE id = $4 AND status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at < $5) RETURNING *",
      [input.attemptId, input.leaseOwner, input.leaseExpiresAt, input.id, now],
    );

    const row = response.rows[0];
    return row ? this.mapWebhookRow(row) : null;
  }

  public async claimWebhookAttempt(input: {
    id: string;
    leaseOwner: string;
    leaseDurationMs: number;
  }): Promise<WebhookEventRecord | null> {
    if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs <= 0) {
      throw new RangeError('Webhook lease duration must be a positive safe integer');
    }

    const now = Date.now();
    return this.claimWebhookEventAttempt({
      id: input.id,
      attemptId: randomUUID(),
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: new Date(now + input.leaseDurationMs).toISOString(),
      nowIso: new Date(now).toISOString(),
    });
  }

  public async completeWebhookAttempt(input: {
    id: string;
    attemptId: string;
    leaseOwner: string;
    status: 'processed' | 'failed' | 'unresolved';
    errorMessage?: string;
  }): Promise<boolean> {
    const processedAt = nowIso();
    const errorMessage = input.errorMessage ?? null;

    if (this.sqlite) {
      const result = this.sqlite
        .prepare(
          "UPDATE webhook_events SET status = ?, error_message = ?, processed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND attempt_id = ? AND lease_owner = ? AND status = 'pending'",
        )
        .run(input.status, errorMessage, processedAt, input.id, input.attemptId, input.leaseOwner);
      return result.changes > 0;
    }

    const result = await this.requirePostgres().query<{ id: string }>(
      "UPDATE webhook_events SET status = $1, error_message = $2, processed_at = $3, lease_owner = NULL, lease_expires_at = NULL WHERE id = $4 AND attempt_id = $5 AND lease_owner = $6 AND status = 'pending' RETURNING id",
      [input.status, errorMessage, processedAt, input.id, input.attemptId, input.leaseOwner],
    );
    return result.rows.length > 0;
  }

  public async updateWebhookEventStatus(input: {
    id: string;
    status: 'processed' | 'failed' | 'unresolved';
    errorMessage?: string;
    attemptId?: string;
  }): Promise<void> {
    const processedAt = nowIso();
    const errorMessage = input.errorMessage ?? null;

    if (this.sqlite) {
      if (input.attemptId) {
        this.sqlite
          .prepare(
            'UPDATE webhook_events SET status = ?, error_message = ?, processed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND attempt_id = ?',
          )
          .run(input.status, errorMessage, processedAt, input.id, input.attemptId);
        return;
      }

      this.sqlite
        .prepare(
          'UPDATE webhook_events SET status = ?, error_message = ?, processed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?',
        )
        .run(input.status, errorMessage, processedAt, input.id);
      return;
    }

    if (input.attemptId) {
      await this.requirePostgres().query(
        'UPDATE webhook_events SET status = $1, error_message = $2, processed_at = $3, lease_owner = NULL, lease_expires_at = NULL WHERE id = $4 AND attempt_id = $5',
        [input.status, errorMessage, processedAt, input.id, input.attemptId],
      );
      return;
    }

    await this.requirePostgres().query(
      'UPDATE webhook_events SET status = $1, error_message = $2, processed_at = $3, lease_owner = NULL, lease_expires_at = NULL WHERE id = $4',
      [input.status, errorMessage, processedAt, input.id],
    );
  }

  public async insertWatcherTask(input: {
    id: string;
    watcherName: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const createdAt = nowIso();

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO watcher_tasks (id, watcher_name, payload, status, error_message, processed_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
        )
        .run(input.id, input.watcherName, JSON.stringify(input.payload), 'pending', createdAt);
      return;
    }

    await this.requirePostgres().query(
      'INSERT INTO watcher_tasks (id, watcher_name, payload, status, error_message, processed_at, created_at) VALUES ($1, $2, $3::jsonb, $4, NULL, NULL, $5)',
      [input.id, input.watcherName, JSON.stringify(input.payload), 'pending', createdAt],
    );
  }

  public async listPendingWatcherTasks(limit: number): Promise<WatcherTaskRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('Watcher task limit must be a positive safe integer');
    }

    if (this.sqlite) {
      const rows = this.sqlite
        .prepare('SELECT * FROM watcher_tasks WHERE status = ? ORDER BY created_at ASC LIMIT ?')
        .all('pending', limit) as Record<string, unknown>[];

      return rows.map((row) => this.mapWatcherRow(row));
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM watcher_tasks WHERE status = $1 ORDER BY created_at ASC LIMIT $2',
      ['pending', limit],
    );

    return response.rows.map((row) => this.mapWatcherRow(row));
  }

  public async updateWatcherTaskStatus(input: {
    id: string;
    status: 'processed' | 'failed';
    errorMessage?: string;
  }): Promise<void> {
    const processedAt = nowIso();
    const errorMessage = input.errorMessage ?? null;

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'UPDATE watcher_tasks SET status = ?, error_message = ?, processed_at = ? WHERE id = ?',
        )
        .run(input.status, errorMessage, processedAt, input.id);
      return;
    }

    await this.requirePostgres().query(
      'UPDATE watcher_tasks SET status = $1, error_message = $2, processed_at = $3 WHERE id = $4',
      [input.status, errorMessage, processedAt, input.id],
    );
  }

  public async countProcessedWatcherTasks(): Promise<number> {
    if (this.sqlite) {
      const row = this.sqlite
        .prepare("SELECT COUNT(*) AS count FROM watcher_tasks WHERE status = 'processed'")
        .get() as Record<string, unknown>;
      return Number(row.count ?? 0);
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      "SELECT COUNT(*)::int AS count FROM watcher_tasks WHERE status = 'processed'",
    );
    return Number(response.rows[0]?.count ?? 0);
  }

  public async insertOrGetSettlementJob(input: {
    id: string;
    operationId: string;
    payloadRef: string;
  }): Promise<{ record: SettlementJobRecord; inserted: boolean }> {
    const createdAt = nowIso();
    if (this.sqlite) {
      const result = this.sqlite
        .prepare(
          "INSERT INTO settlement_jobs (id, operation_id, payload_ref, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(operation_id) DO NOTHING",
        )
        .run(input.id, input.operationId, input.payloadRef, createdAt, createdAt);
      const row = this.sqlite
        .prepare('SELECT * FROM settlement_jobs WHERE operation_id = ? LIMIT 1')
        .get(input.operationId) as Record<string, unknown> | null;
      if (!row) throw new ConfigError('Failed to insert or retrieve settlement job');
      const record = this.mapSettlementJobRow(row);
      if (record.payloadRef !== input.payloadRef) {
        throw new ConfigError(
          'Settlement operation identity already exists with a different payload reference',
        );
      }
      return { record, inserted: result.changes > 0 };
    }

    const result = await this.requirePostgres().query(
      "INSERT INTO settlement_jobs (id, operation_id, payload_ref, status, created_at, updated_at) VALUES ($1, $2, $3, 'pending', $4, $4) ON CONFLICT(operation_id) DO NOTHING RETURNING id",
      [input.id, input.operationId, input.payloadRef, createdAt],
    );
    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM settlement_jobs WHERE operation_id = $1 LIMIT 1',
      [input.operationId],
    );
    const row = response.rows[0];
    if (!row) throw new ConfigError('Failed to insert or retrieve settlement job');
    const record = this.mapSettlementJobRow(row);
    if (record.payloadRef !== input.payloadRef) {
      throw new ConfigError(
        'Settlement operation identity already exists with a different payload reference',
      );
    }
    return { record, inserted: result.rows.length > 0 };
  }

  public async getSettlementJobByOperationId(
    operationId: string,
  ): Promise<SettlementJobRecord | null> {
    if (this.sqlite) {
      const row = this.sqlite
        .prepare('SELECT * FROM settlement_jobs WHERE operation_id = ? LIMIT 1')
        .get(operationId) as Record<string, unknown> | null;
      return row ? this.mapSettlementJobRow(row) : null;
    }
    const response = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM settlement_jobs WHERE operation_id = $1 LIMIT 1',
      [operationId],
    );
    return response.rows[0] ? this.mapSettlementJobRow(response.rows[0]) : null;
  }

  public async listPendingSettlementJobs(limit: number): Promise<SettlementJobRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('Settlement job limit must be a positive safe integer');
    }
    if (this.sqlite) {
      const rows = this.sqlite
        .prepare(
          "SELECT * FROM settlement_jobs WHERE status = 'pending' ORDER BY created_at ASC, operation_id ASC LIMIT ?",
        )
        .all(limit) as Record<string, unknown>[];
      return rows.map((row) => this.mapSettlementJobRow(row));
    }
    const response = await this.requirePostgres().query<Record<string, unknown>>(
      "SELECT * FROM settlement_jobs WHERE status = 'pending' ORDER BY created_at ASC, operation_id ASC LIMIT $1",
      [limit],
    );
    return response.rows.map((row) => this.mapSettlementJobRow(row));
  }

  public async updateSettlementJobStatus(input: {
    operationId: string;
    status: SettlementJobRecord['status'];
  }): Promise<boolean> {
    const updatedAt = nowIso();
    if (this.sqlite) {
      const result = this.sqlite
        .prepare('UPDATE settlement_jobs SET status = ?, updated_at = ? WHERE operation_id = ?')
        .run(input.status, updatedAt, input.operationId);
      return result.changes > 0;
    }
    const response = await this.requirePostgres().query<{ operation_id: string }>(
      'UPDATE settlement_jobs SET status = $1, updated_at = $2 WHERE operation_id = $3 RETURNING operation_id',
      [input.status, updatedAt, input.operationId],
    );
    return response.rows.length > 0;
  }

  public async cleanupOldRecords(cutoffIso: string): Promise<void> {
    // Retention uses a strict cutoff: values exactly equal to the cutoff are retained,
    // while only entries strictly older than the cutoff are removed.
    if (this.sqlite) {
      this.sqlite.prepare('DELETE FROM auth_challenges WHERE expires_at < ?').run(cutoffIso);
      this.sqlite.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(cutoffIso);
      this.sqlite
        .prepare(
          "DELETE FROM webhook_events WHERE created_at < ? AND status IN ('processed', 'failed')",
        )
        .run(cutoffIso);
      this.sqlite
        .prepare(
          "DELETE FROM watcher_tasks WHERE created_at < ? AND status IN ('processed', 'failed')",
        )
        .run(cutoffIso);
      return;
    }

    await this.requirePostgres().query('DELETE FROM auth_challenges WHERE expires_at < $1', [
      cutoffIso,
    ]);
    await this.requirePostgres().query('DELETE FROM idempotency_keys WHERE created_at < $1', [
      cutoffIso,
    ]);
    await this.requirePostgres().query(
      "DELETE FROM webhook_events WHERE created_at < $1 AND status IN ('processed', 'failed')",
      [cutoffIso],
    );
    await this.requirePostgres().query(
      "DELETE FROM watcher_tasks WHERE created_at < $1 AND status IN ('processed', 'failed')",
      [cutoffIso],
    );
  }

  private mapTransactionRow(row: Record<string, unknown>): InteractiveTransactionRecord {
    const status = String(row.status);
    if (!isTransactionStatus(status)) {
      throw new ConfigError(`Unsupported interactive transaction status: ${status}`);
    }

    return {
      id: String(row.id),
      account: String(row.account),
      kind: 'deposit',
      assetCode: String(row.asset_code),
      amount: String(row.amount),
      amountIn:
        row.amount_in === null || row.amount_in === undefined ? null : String(row.amount_in),
      amountOut:
        row.amount_out === null || row.amount_out === undefined ? null : String(row.amount_out),
      amountFee:
        row.amount_fee === null || row.amount_fee === undefined ? null : String(row.amount_fee),
      currency: row.currency === null || row.currency === undefined ? null : String(row.currency),
      railReference:
        row.rail_reference === null || row.rail_reference === undefined
          ? null
          : String(row.rail_reference),
      stellarTransactionHash:
        row.stellar_transaction_hash === null || row.stellar_transaction_hash === undefined
          ? null
          : String(row.stellar_transaction_hash),
      status,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  private mapCustomerRow(row: Record<string, unknown>): Customer {
    const kycValue = row.kyc_data;
    const kycData =
      typeof kycValue === 'string'
        ? (JSON.parse(kycValue) as Customer['kyc_data'])
        : (kycValue as Customer['kyc_data'] | null);

    return {
      id: String(row.id),
      account_id: String(row.account_id),
      ...(row.email_address ? { email_address: String(row.email_address) } : {}),
      ...(row.phone_number ? { phone_number: String(row.phone_number) } : {}),
      created_at: Number(row.created_at),
      ...(kycData ? { kyc_data: kycData } : {}),
    };
  }

  private mapIdempotencyRow(row: Record<string, unknown>): IdempotencyRecord {
    return {
      id: String(row.id),
      scope: String(row.scope),
      idempotencyKey: String(row.idempotency_key),
      requestHash: String(row.request_hash),
      status: row.status === 'pending' ? 'pending' : 'completed',
      statusCode: Number(row.status_code),
      responseBody: String(row.response_body),
      createdAt: String(row.created_at),
    };
  }

  private mapWebhookRow(row: Record<string, unknown>): WebhookEventRecord {
    const payload = parseJsonObject(row.payload, this.provider === 'sqlite');
    const status = parsePersistedWebhookStatus(row.status);

    return {
      id: String(row.id),
      eventId: String(row.event_id),
      provider: String(row.provider),
      payload,
      status,
      errorMessage: row.error_message ? String(row.error_message) : null,
      processedAt: row.processed_at ? String(row.processed_at) : null,
      createdAt: String(row.created_at),
      attemptId: row.attempt_id ? String(row.attempt_id) : null,
      attemptCount: row.attempt_number === undefined ? 0 : Number(row.attempt_number),
      leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
      leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
      operationKey: row.operation_key
        ? String(row.operation_key)
        : `${String(row.provider)}:${String(row.event_id)}`,
    };
  }

  private mapWatcherRow(row: Record<string, unknown>): WatcherTaskRecord {
    const payload = parseJsonObject(row.payload, this.provider === 'sqlite');
    const status = parsePersistedTaskStatus(row.status);

    return {
      id: String(row.id),
      watcherName: String(row.watcher_name),
      payload,
      status,
      errorMessage: row.error_message ? String(row.error_message) : null,
      processedAt: row.processed_at ? String(row.processed_at) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapSettlementJobRow(row: Record<string, unknown>): SettlementJobRecord {
    const status = String(row.status);
    if (!['pending', 'processing', 'completed', 'failed'].includes(status)) {
      throw new ConfigError(`Unsupported settlement job status: ${status}`);
    }
    return {
      id: String(row.id),
      operationId: String(row.operation_id),
      payloadRef: String(row.payload_ref),
      status: status as SettlementJobRecord['status'],
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  private requirePostgres(): PostgresClient {
    if (!this.postgres) {
      throw new ConfigError('PostgreSQL client is not connected');
    }
    return this.postgres;
  }
}

async function loadSqliteDatabase(path: string): Promise<SqliteLike> {
  if (typeof Bun === 'undefined') {
    throw new ConfigError(
      'SQLite provider requires the Bun runtime and bun:sqlite. Select postgres when running under Node.js.',
    );
  }

  const moduleName = 'bun:sqlite';
  const sqliteModuleUnknown: unknown = await import(moduleName);
  const sqliteModule = sqliteModuleUnknown as {
    Database: new (path: string) => SqliteLike;
  };
  return new sqliteModule.Database(path);
}

export function createSqlDatabaseAdapter(
  databaseConfig: FrameworkConfig['database'],
): DatabaseAdapter {
  if (String(databaseConfig.provider) === 'mysql') {
    throw new ConfigError('MySQL is not implemented in this MVP. Use postgres or sqlite.');
  }

  if (databaseConfig.provider === 'postgres') {
    const hasPgModule = Boolean((globalThis as Record<string, unknown>).process);
    if (!hasPgModule) {
      throw new ConfigError('PostgreSQL runtime is unavailable');
    }
  }

  return new SqlDatabaseAdapter(databaseConfig);
}

export function makeSqliteDbUrlForTests(): string {
  return `file:${join(tmpdir(), `anchor-kit-${randomUUID()}.sqlite`)}`;
}
