# Database migrations

`SqlDatabaseAdapter` records applied migrations in `anchor_kit_migrations`. The core schema upgrades through ordered, stable migration names. Every migration runs in its own database transaction, and its record is written in that transaction only after `up` succeeds. A failed migration is rolled back and may be retried on the next `migrate()` call.

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

The runtime stores each plugin migration as `plugin:<plugin-id>:<migration-name>`, with URI-encoded plugin IDs and migration names, after the core migrations and in plugin registration order. Migration names must be unique and must not be renamed or edited after release. `execute` runs SQL on the selected provider; `hasColumn` supports safe upgrades of existing tables. A plugin migration should use provider-specific SQL when the dialects differ.

Focused check: `bun test tests/runtime/database/versioned-migrations.test.ts`. It must pass the current-schema adoption and legacy upgrade data-preservation assertions, then prove a failed plugin migration leaves no partial schema or applied record and can be retried successfully.
