# Database migrations

`SqlDatabaseAdapter` applies code-defined, named migrations. There is no migration CLI, no filesystem SQL loader, and no `down` migration. `anchor.init()` calls `connect()` then `migrate()`, and `migrate()` skips names that are already recorded as applied.

PostgreSQL migrations take a session-scoped advisory lock keyed by database and current schema before reading the applied records. The lock spans the metadata bootstrap, plugin migrations, and the post-migration DDL passes, so two independent adapter connections (or two processes) migrating the same database serialize instead of racing on the metadata primary key. It is released in a `finally` block even when a migration fails, which lets a later caller re-read the records and retry.

The built-in `core:001-initial-schema` migration creates the current tables and indexes without dropping or replacing existing data. `core:002-idempotency-status` adds the `status` column only when an older `idempotency_keys` table does not already contain it. This allows databases created before migration tracking to be adopted in place.

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

Focused checks: `bun test tests/runtime/database/versioned-migrations.test.ts` covers current-schema adoption, legacy upgrade data preservation, and retrying a failed plugin migration. `bun test tests/runtime/postgres-migration-lock.integration.test.ts` is opt-in via `TEST_POSTGRES_URL` or `DATABASE_URL` pointing at a disposable database; it migrates the same PostgreSQL database from two independent connections and checks for no duplicate records or partial schema, then proves a failed migration can be retried.
