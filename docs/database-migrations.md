# Database migrations

`SqlDatabaseAdapter` applies code-defined, named migrations. There is no migration CLI, no filesystem SQL loader, and no `down` migration. `anchor.init()` calls `connect()` then `migrate()`, and `migrate()` skips names that are already recorded as applied.

Core migrations run in declaration order, followed by plugin migrations in plugin registration order. Current core migrations are `core:001-initial-schema`, `core:002-idempotency-status`, `core:003-current-runtime-tables`, `core:004-settlement-job-leases`, `core:005-webhook-recovery-result`, and `core:006-refund-operations`. The first two create or adopt the schema without dropping tables or replacing existing data. `core:003-current-runtime-tables` creates runtime tables with `IF NOT EXISTS`; `core:004-settlement-job-leases` adds lease fields to settlement jobs; `core:005-webhook-recovery-result` stores recovered webhook operations and marks unfinished legacy events for reconciliation; `core:006-refund-operations` stores transaction-linked refunds.

Plugins register append-only named migrations through `schema.migrations`:

```typescript
const plugin = {
  id: 'ledger',
  schema: {
    migrations: [
      {
        name: '001-ledger-entries',
        up: async ({ execute }) => {
          await execute(
            'CREATE TABLE IF NOT EXISTS ledger_entries (id TEXT PRIMARY KEY, reference TEXT NOT NULL)',
          );
        },
      },
    ],
  },
};

anchor.use(plugin);
```

The runtime stores each plugin migration as `plugin:<plugin-id>:<migration-name>`, with URI-encoded plugin IDs and migration names, after the core migrations and in plugin registration order. Migration names must be unique and stable; do not rename or edit a migration after its name has been recorded in any environment. `execute` runs SQL on the selected provider, and `hasColumn` supports safe upgrades of existing tables. A plugin migration should use provider-specific SQL when the dialects differ.

If a custom `DatabaseAdapter` is injected into `createAnchor`, the factory does not collect plugin migrations. The injected adapter must run them explicitly and record them in the same metadata table.

## Execution and failed-migration behavior

For each versioned migration, the adapter:

1. Begins a database transaction (`BEGIN IMMEDIATE` on SQLite, `BEGIN` on PostgreSQL).
2. Rechecks that the name is not already recorded.
3. Runs `up(context)`.
4. Inserts the name into `anchor_kit_migrations`.
5. Commits the transaction.

Blank, non-function, or duplicate migration names are rejected before any transaction begins. If `up` or the record insert throws, the adapter attempts `ROLLBACK`. A failed migration therefore leaves neither its schema change nor its `anchor_kit_migrations` row. The error is rethrown; if the rollback also fails, an `AggregateError` says the transaction could not be rolled back. The per-adapter migration guard is cleared after a failure, so a corrected build can retry `migrate()`. Migrations that completed earlier in the same run stay applied and are skipped on retry.

This guarantee applies to the named `SchemaMigration` sequence only. After that sequence, `migrate()` also runs legacy/idempotent upgrades for interactive-transaction columns, webhook deduplication, and webhook attempt fields, plus index creation. Those changes are not recorded in `anchor_kit_migrations` and do not have the same generic per-migration rollback wrapper. Include them in backups, inspection, and rehearsals.

Coordinate deployments so only one process runs migrations against a database at a time.

## Inspecting applied records

There is no public migration-status API or CLI. Use the same database role, schema, and connection target as the application. On PostgreSQL, confirm `current_schema()` first because unqualified table names resolve through `search_path`.

PostgreSQL:

```sql
SELECT current_schema();

SELECT name, applied_at
FROM anchor_kit_migrations
ORDER BY applied_at, name;

SELECT name, applied_at
FROM anchor_kit_migrations
WHERE name LIKE 'plugin:%'
ORDER BY name;

SELECT version, applied_at
FROM schema_migrations
ORDER BY applied_at;
```

SQLite:

```sql
SELECT name, applied_at
FROM anchor_kit_migrations
ORDER BY applied_at, name;

SELECT name, applied_at
FROM anchor_kit_migrations
WHERE name LIKE 'plugin:%'
ORDER BY name;

SELECT version, applied_at
FROM schema_migrations
ORDER BY applied_at;

SELECT version, applied_at
FROM anchor_kit_schema_migrations
ORDER BY version;
```

`anchor_kit_schema_migrations` is SQLite-only. `schema_migrations` records the legacy webhook-attempt upgrade. Plugin names are URI-encoded, so an ID or migration name containing reserved characters will look encoded in the table. Record the query output before and after each deployment, including plugin rows, and retain it with the deployment log.

## Pre-deployment backup and compatibility checks

Take restorable backups before the candidate version runs `migrate()`. Store at least:

- A **pre-upgrade** backup of the last known-good database, before the candidate build's `init()`.
- A **post-upgrade** backup after a successful candidate migration and smoke checks.

Example commands (replace placeholders; use your platform's equivalent):

```sh
pg_dump -Fc --file=anchor-kit-pre-upgrade.dump "$DATABASE_URL"
sqlite3 /path/to/anchor.sqlite ".backup '/path/to/anchor-kit-pre-upgrade.sqlite'"
```

For PostgreSQL point-in-time recovery, also verify WAL archiving and the restore target. For SQLite, stop writers or use the online `.backup` command; do not copy a database file that is actively being written. Backups must include core tables, `anchor_kit_migrations`, legacy metadata tables, and every plugin-owned table. Verify that the backup can be restored before relying on it.

Before allowing a rollback to a prior application version, prove that the prior version and its prior plugin set can run against the post-upgrade schema:

- Additive tables, columns, and indexes are usually tolerable; confirm the prior build ignores columns and tables it does not know.
- Renamed or removed objects, tightened `NOT NULL`/`CHECK`/`UNIQUE` constraints, changed defaults, and changed JSON payload shapes are rollback blockers unless explicitly handled.
- Check every plugin migration, not just core migrations. A plugin table created by the new version must not break the old plugin, and an old plugin must not require a column or constraint that the new version removed.
- If an injected adapter is used, confirm where plugin migrations are executed; they are not discovered from `createAnchor`.
- Confirm that no recorded migration name has been reused with different `up` SQL. Add a new migration name for fixes.

## Disposable-database rehearsal

Rehearse both the failed-migration path and the application-rollback path before production. Never use production data or credentials directly; restore a sanitized clone into a disposable database.

1. Create a disposable PostgreSQL database (or copy the SQLite file) and restore the sanitized pre-upgrade backup.
2. Record the baseline `anchor_kit_migrations` rows with the queries above.
3. Start one candidate application process against it with the exact production plugin registration, so `anchor.use(plugin)` is called for every plugin before `anchor.init()`. If a custom adapter is injected, use the same adapter path as production.
4. **Failure drill:** in the disposable environment only, add a temporary plugin migration with a new unique name that creates a sentinel table and then throws. Restart the candidate process with that temporary plugin so it calls `migrate()` again. Expect the error, no sentinel table, and no record for that migration name. If the prior build must stay online during a failed rollout, start it against this disposable database now and verify it tolerates the earlier applied migrations. Then remove the temporary migration, rerun `migrate()`, and expect success.
5. Record `anchor_kit_migrations` again. Confirm expected core names and every `plugin:<encoded-id>:<encoded-name>` row, then smoke-test plugin-owned tables and data.
6. **Rollback drill:** stop the candidate and start the prior application build against the same disposable database. If it starts and its plugin smoke checks pass, a compatible application rollback is proven. If it fails, restore the pre-upgrade backup into a fresh disposable database, start the prior build there, and write down the exact restore steps.
7. Repeat on both SQLite and PostgreSQL when both are supported, because the providers use different DDL and transaction statements.

For a fast SQLite check of the transactional guarantee and plugin-name encoding, run:

```sh
bun test tests/runtime/database/versioned-migrations.test.ts
```

That test covers a failed fixture migration with rollback and retry, plus plugin registration through the public factory. It does not replace the disposable-database rehearsal with the production plugin set.

## Deployment procedure for a failed migration

1. Pause further rollout. Keep the previous application version serving traffic only if its compatibility with the partially upgraded schema was proven in rehearsal; otherwise stop writes.
2. Capture the migration error and inspect `anchor_kit_migrations`, legacy metadata tables, and plugin-owned tables.
3. If the error came from a named migration and the transaction rolled back, fix the cause and retry with a single process. If the migration was already released, use a new migration name rather than editing the recorded one.
4. If the error reports that the transaction could not be rolled back, or came from a legacy/idempotent upgrade, do not assume a clean partial state. Restore from backup or have an operator repair both DDL and migration metadata explicitly.
5. Re-run the inspection queries and smoke tests before restoring traffic, including plugin checks.

## Recovery after a successful schema upgrade

**Redeploying an earlier application version does not roll back the schema.** Completed migrations are not automatically unapplied, their rows are not deleted, and their DDL is not reversed. Choose one of these explicit paths:

- **Compatible application rollback:** deploy the prior application build and leave the migrated schema in place. Verify the prior plugin set works with the plugin tables created by the new version. Keep the migration rows; a later roll-forward will skip them.
- **Incompatible application rollback:** restore the pre-upgrade database backup or restore to a PostgreSQL point in time before `migrate()`, then deploy the prior application build. The restore must include all plugin tables and migration metadata. Plan for writes that happened after the backup, either by reconciling them or by accepting data loss.
- **Explicit compensating migration:** add a new, reviewed forward migration (including plugin migrations where applicable) that reverses only the changes that must be removed. This is an operator/authored change with its own new record; it is not an automatic `down` migration. Rehearse it with the prior application build before production use.

Do not delete `anchor_kit_migrations` rows as a rollback mechanism. A database restore returns the records and schema to the backup state together; manual row deletion leaves the adapter believing that DDL was never applied and can cause partial re-application on the next `migrate()`.
