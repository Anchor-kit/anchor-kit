import { ConfigError, MalformedPersistedDataError } from '@/core/errors.ts';
import type {
  AuthChallengeRecord,
  DatabaseAdapter,
  IdempotencyRecord,
  InteractiveTransactionRecord,
  WatcherTaskRecord,
  WebhookEventRecord,
} from '@/runtime/interfaces.ts';
import type { FrameworkConfig } from '@/types/config.ts';
import { isTransactionStatus, type TransactionStatus } from '@/types/transaction-status.ts';
import { Database } from 'bun:sqlite';
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

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new MalformedPersistedDataError(
      `Malformed persisted JSON payload: ${error instanceof Error ? error.message : String(error)}`,
      { value: value.slice(0, 200) },
    );
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedPersistedDataError(
      'Persisted JSON payload must decode to a plain object; arrays and primitive values are not allowed.',
      { value: value.slice(0, 200) },
    );
  }

  return parsed as Record<string, unknown>;
}

export class SqlDatabaseAdapter implements DatabaseAdapter {
  private readonly provider: FrameworkConfig['database']['provider'];
  private readonly url: string;
  private sqlite: SqliteLike | null = null;
  private postgres: PostgresClient | null = null;
  private connectPromise: Promise<void> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private migratePromise: Promise<void> | null = null;

  constructor(databaseConfig: FrameworkConfig['database']) {
    this.provider = databaseConfig.provider;
    this.url = databaseConfig.url;
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
          const database = new Database(path);

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
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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
          event_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TEXT,
          created_at TEXT NOT NULL
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

        CREATE INDEX IF NOT EXISTS idx_interactive_transactions_status_created_at
          ON interactive_transactions (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_watcher_tasks_status_created_at
          ON watcher_tasks (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created_at
          ON webhook_events (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at
          ON auth_challenges (expires_at);
      `);
      const idempotencyColumns = this.sqlite
        .prepare('PRAGMA table_info(idempotency_keys)')
        .all() as Array<{ name?: unknown }>;
      if (!idempotencyColumns.some((column) => column.name === 'status')) {
        this.sqlite.exec(
          "ALTER TABLE idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'completed'",
        );
      }
      return;
    }

    if (this.postgres) {
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
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL
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
          event_id TEXT NOT NULL UNIQUE,
          provider TEXT NOT NULL,
          payload JSONB NOT NULL,
          status TEXT NOT NULL,
          error_message TEXT,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL
        );
      `);
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
        CREATE INDEX IF NOT EXISTS idx_interactive_transactions_status_created_at
          ON interactive_transactions (status, created_at);
      `);
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_watcher_tasks_status_created_at
          ON watcher_tasks (status, created_at);
      `);
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_webhook_events_status_created_at
          ON webhook_events (status, created_at);
      `);
      await this.postgres.query(`
        CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires_at
          ON auth_challenges (expires_at);
      `);
      return;
    }

    throw new ConfigError('Database not connected');
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
    status: TransactionStatus;
  }): Promise<InteractiveTransactionRecord> {
    const createdAt = nowIso();
    const updatedAt = createdAt;

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.id,
          input.account,
          input.kind,
          input.assetCode,
          input.amount,
          input.status,
          createdAt,
          updatedAt,
        );
    } else {
      await this.requirePostgres().query(
        'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          input.id,
          input.account,
          input.kind,
          input.assetCode,
          input.amount,
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
      // SQLite: INSERT ... ON CONFLICT DO NOTHING, then SELECT
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

    // PostgreSQL: INSERT ... ON CONFLICT DO NOTHING, then SELECT
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
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }> {
    const createdAt = nowIso();
    const eventId = input.eventId.trim();
    const provider = input.provider.trim() || 'generic';

    if (this.sqlite) {
      const existing = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE event_id = ? LIMIT 1')
        .get(eventId) as Record<string, unknown> | null;

      if (existing) {
        const record = this.mapWebhookRow(existing);

        if (record.status === 'processed') {
          return { record, inserted: false };
        }

        if (record.status === 'failed') {
          this.sqlite
            .prepare(
              'UPDATE webhook_events SET provider = ?, payload = ?, status = ?, error_message = NULL, processed_at = NULL WHERE id = ?',
            )
            .run(provider, JSON.stringify(input.payload), 'pending', record.id);

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
          'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
        )
        .run(input.id, eventId, provider, JSON.stringify(input.payload), 'pending', createdAt);

      const row = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
        .get(input.id) as Record<string, unknown> | null;

      if (!row) {
        throw new ConfigError('Failed to insert or retrieve webhook event');
      }

      return { record: this.mapWebhookRow(row), inserted: true };
    }

    const existingPg = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM webhook_events WHERE event_id = $1 LIMIT 1',
      [eventId],
    );

    const existingRow = existingPg.rows[0];
    if (existingRow) {
      const record = this.mapWebhookRow(existingRow);

      if (record.status === 'processed') {
        return { record, inserted: false };
      }

      if (record.status === 'failed') {
        await this.requirePostgres().query(
          'UPDATE webhook_events SET provider = $1, payload = $2::jsonb, status = $3, error_message = NULL, processed_at = NULL WHERE id = $4',
          [provider, JSON.stringify(input.payload), 'pending', record.id],
        );

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
      'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, NULL, NULL, $6)',
      [input.id, eventId, provider, JSON.stringify(input.payload), 'pending', createdAt],
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

  public async updateWebhookEventStatus(input: {
    id: string;
    status: 'processed' | 'failed';
    errorMessage?: string;
  }): Promise<void> {
    const processedAt = nowIso();
    const errorMessage = input.errorMessage ?? null;

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'UPDATE webhook_events SET status = ?, error_message = ?, processed_at = ? WHERE id = ?',
        )
        .run(input.status, errorMessage, processedAt, input.id);
      return;
    }

    await this.requirePostgres().query(
      'UPDATE webhook_events SET status = $1, error_message = $2, processed_at = $3 WHERE id = $4',
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
      status,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
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
    const payloadValue = row.payload;
    const payload =
      typeof payloadValue === 'string'
        ? parseJsonObject(payloadValue)
        : ((payloadValue as Record<string, unknown>) ?? {});

    const statusRaw = String(row.status);
    const status = statusRaw === 'processed' || statusRaw === 'failed' ? statusRaw : 'pending';

    return {
      id: String(row.id),
      eventId: String(row.event_id),
      provider: String(row.provider),
      payload,
      status,
      errorMessage: row.error_message ? String(row.error_message) : null,
      processedAt: row.processed_at ? String(row.processed_at) : null,
      createdAt: String(row.created_at),
    };
  }

  private mapWatcherRow(row: Record<string, unknown>): WatcherTaskRecord {
    const payloadValue = row.payload;
    const payload =
      typeof payloadValue === 'string'
        ? parseJsonObject(payloadValue)
        : ((payloadValue as Record<string, unknown>) ?? {});

    const statusRaw = String(row.status);
    const status = statusRaw === 'processed' || statusRaw === 'failed' ? statusRaw : 'pending';

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

  private requirePostgres(): PostgresClient {
    if (!this.postgres) {
      throw new ConfigError('PostgreSQL client is not connected');
    }
    return this.postgres;
  }
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
