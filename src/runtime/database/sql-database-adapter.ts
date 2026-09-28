import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { ConfigError } from '@/core/errors.ts';
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

type SqliteLike = Database;

interface PostgresClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

const SQLITE_FILE_PREFIX = 'file:';

function nowIso(): string {
  return new Date().toISOString();
}

function toSqlitePath(url: string): string {
  if (url.startsWith(SQLITE_FILE_PREFIX)) {
    return url.slice(SQLITE_FILE_PREFIX.length);
  }
  return url;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

export class SqlDatabaseAdapter implements DatabaseAdapter {
  private readonly provider: FrameworkConfig['database']['provider'];
  private readonly url: string;
  private sqlite: SqliteLike | null = null;
  private postgres: PostgresClient | null = null;

  constructor(databaseConfig: FrameworkConfig['database']) {
    this.provider = databaseConfig.provider;
    this.url = databaseConfig.url;
  }

  public async connect(): Promise<void> {
    if (this.provider === 'sqlite') {
      this.sqlite = new Database(toSqlitePath(this.url));
      return;
    }

    if (this.provider === 'postgres') {
      const moduleName = 'pg';
      const pgModuleUnknown: unknown = await import(moduleName);
      const pgModule = pgModuleUnknown as {
        Client: new (config: { connectionString: string }) => PostgresClient;
      };
      this.postgres = new pgModule.Client({ connectionString: this.url });
      await this.postgres.connect();
      return;
    }

    throw new ConfigError(`Unsupported database provider: ${this.provider}`);
  }

  public async disconnect(): Promise<void> {
    if (this.sqlite) {
      this.sqlite.close();
      this.sqlite = null;
    }

    if (this.postgres) {
      await this.postgres.end();
      this.postgres = null;
    }
  }

  public async migrate(): Promise<void> {
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

  public async markAuthChallengeConsumed(id: string): Promise<void> {
    const consumedAt = nowIso();
    if (this.sqlite) {
      this.sqlite
        .prepare('UPDATE auth_challenges SET consumed_at = ? WHERE id = ?')
        .run(consumedAt, id);
      return;
    }

    await this.requirePostgres().query(
      'UPDATE auth_challenges SET consumed_at = $1 WHERE id = $2',
      [consumedAt, id],
    );
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
          "SELECT * FROM interactive_transactions WHERE status = 'pending_user_transfer_start' AND created_at < ?",
        )
        .all(cutoffIso) as Record<string, unknown>[];
      return rows.map((row) => this.mapTransactionRow(row));
    }

    const response = await this.requirePostgres().query<Record<string, unknown>>(
      "SELECT * FROM interactive_transactions WHERE status = 'pending_user_transfer_start' AND created_at < $1",
      [cutoffIso],
    );
    return response.rows.map((row) => this.mapTransactionRow(row));
  }

  public async updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
    const updatedAt = nowIso();
    if (this.sqlite) {
      this.sqlite
        .prepare('UPDATE interactive_transactions SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, updatedAt, id);
      return;
    }

    await this.requirePostgres().query(
      'UPDATE interactive_transactions SET status = $1, updated_at = $2 WHERE id = $3',
      [status, updatedAt, id],
    );
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

  public async reserveIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
  }): Promise<{ record: IdempotencyRecord; inserted: boolean }> {
    const createdAt = nowIso();
    let inserted: boolean;

    if (this.sqlite) {
      const result = this.sqlite
        .prepare(
          "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, status_code, response_body, created_at) VALUES (?, ?, ?, ?, 'pending', 0, '', ?) ON CONFLICT(scope, idempotency_key) DO NOTHING",
        )
        .run(input.id, input.scope, input.idempotencyKey, input.requestHash, createdAt);
      inserted = result.changes === 1;
    } else {
      const result = await this.requirePostgres().query<Record<string, unknown>>(
        "INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status, status_code, response_body, created_at) VALUES ($1, $2, $3, $4, 'pending', 0, '', $5) ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING id",
        [input.id, input.scope, input.idempotencyKey, input.requestHash, createdAt],
      );
      inserted = result.rows.length === 1;
    }

    const record = await this.getIdempotencyRecord(input.scope, input.idempotencyKey);
    if (!record) {
      throw new ConfigError('Failed to reserve idempotency record');
    }
    return { record, inserted };
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
    const { transaction, idempotency } = input;

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
            transaction.createdAt,
          );

        const result = sqlite
          .prepare(
            "UPDATE idempotency_keys SET status = 'completed', status_code = ?, response_body = ? WHERE scope = ? AND idempotency_key = ? AND request_hash = ? AND status = 'pending'",
          )
          .run(
            idempotency.statusCode,
            idempotency.responseBody,
            idempotency.scope,
            idempotency.idempotencyKey,
            idempotency.requestHash,
          );
        if (result.changes !== 1) {
          throw new ConfigError('Pending idempotency reservation was not found');
        }
      });
      create();
    } else {
      const postgres = this.requirePostgres();
      await postgres.query('BEGIN');
      try {
        await postgres.query(
          'INSERT INTO interactive_transactions (id, account, kind, asset_code, amount, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)',
          [
            transaction.id,
            transaction.account,
            transaction.kind,
            transaction.assetCode,
            transaction.amount,
            transaction.status,
            transaction.createdAt,
          ],
        );
        const result = await postgres.query<Record<string, unknown>>(
          "UPDATE idempotency_keys SET status = 'completed', status_code = $1, response_body = $2 WHERE scope = $3 AND idempotency_key = $4 AND request_hash = $5 AND status = 'pending' RETURNING id",
          [
            idempotency.statusCode,
            idempotency.responseBody,
            idempotency.scope,
            idempotency.idempotencyKey,
            idempotency.requestHash,
          ],
        );
        if (result.rows.length !== 1) {
          throw new ConfigError('Pending idempotency reservation was not found');
        }
        await postgres.query('COMMIT');
      } catch (error) {
        await postgres.query('ROLLBACK');
        throw error;
      }
    }

    return {
      id: transaction.id,
      account: transaction.account,
      kind: transaction.kind,
      assetCode: transaction.assetCode,
      amount: transaction.amount,
      status: transaction.status,
      createdAt: transaction.createdAt,
      updatedAt: transaction.createdAt,
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

  public async insertIdempotencyRecord(input: {
    id: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    responseBody: string;
  }): Promise<void> {
    const createdAt = nowIso();

    if (this.sqlite) {
      this.sqlite
        .prepare(
          'INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, response_body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
      return;
    }

    await this.requirePostgres().query(
      'INSERT INTO idempotency_keys (id, scope, idempotency_key, request_hash, status_code, response_body, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
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
  }

  public async insertWebhookEvent(input: {
    id: string;
    eventId: string;
    provider: string;
    payload: Record<string, unknown>;
  }): Promise<{ record: WebhookEventRecord; inserted: boolean }> {
    const createdAt = nowIso();

    if (this.sqlite) {
      const existing = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE event_id = ? LIMIT 1')
        .get(input.eventId) as Record<string, unknown> | null;
      if (existing) {
        return { record: this.mapWebhookRow(existing), inserted: false };
      }

      this.sqlite
        .prepare(
          'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)',
        )
        .run(
          input.id,
          input.eventId,
          input.provider,
          JSON.stringify(input.payload),
          'pending',
          createdAt,
        );

      const inserted = this.sqlite
        .prepare('SELECT * FROM webhook_events WHERE id = ? LIMIT 1')
        .get(input.id) as Record<string, unknown> | null;

      if (!inserted) {
        throw new ConfigError('Failed to insert webhook event');
      }

      return { record: this.mapWebhookRow(inserted), inserted: true };
    }

    const existingPg = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM webhook_events WHERE event_id = $1 LIMIT 1',
      [input.eventId],
    );

    if (existingPg.rows[0]) {
      return { record: this.mapWebhookRow(existingPg.rows[0]), inserted: false };
    }

    await this.requirePostgres().query(
      'INSERT INTO webhook_events (id, event_id, provider, payload, status, error_message, processed_at, created_at) VALUES ($1, $2, $3, $4::jsonb, $5, NULL, NULL, $6)',
      [
        input.id,
        input.eventId,
        input.provider,
        JSON.stringify(input.payload),
        'pending',
        createdAt,
      ],
    );

    const insertedPg = await this.requirePostgres().query<Record<string, unknown>>(
      'SELECT * FROM webhook_events WHERE id = $1 LIMIT 1',
      [input.id],
    );

    const row = insertedPg.rows[0];
    if (!row) {
      throw new ConfigError('Failed to insert webhook event');
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
  if (databaseConfig.provider === 'mysql') {
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
