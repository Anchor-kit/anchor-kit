# PostgreSQL backup and restore rehearsal

This guide rehearses a logical backup of an Anchor-Kit PostgreSQL database and restores it into a fresh, disposable database. It does not define a recovery-time or recovery-point guarantee. Test the procedure with the PostgreSQL client tools that match your server version.

## Protect the backup

Run commands from a trusted operator shell. Use placeholders for database names and connection strings; do not put credentials in shell history or commit a dump. Prefer a password prompt or a protected `.pgpass` file with mode `0600`. Store the dump in an encrypted location with access limited to the operators who need it.

```sh
umask 077
pg_dump --format=custom --no-owner --file=anchor-kit-backup.dump "$SOURCE_DATABASE_URL"
chmod 600 anchor-kit-backup.dump
```

Treat the dump as sensitive: it can contain customer contact details, KYC data, transaction records, and webhook payloads. Keep it out of source control and remove temporary copies using your organization's approved data-handling procedure.

## Restore to a fresh database

Create an empty disposable database that is not used by an application or production service. Then restore the dump and stop on the first SQL error:

```sh
createdb --maintenance-db "$ADMIN_DATABASE_URL" anchor_kit_restore_check
pg_restore --exit-on-error --no-owner \
  --dbname="$RESTORE_DATABASE_URL" anchor-kit-backup.dump
```

`RESTORE_DATABASE_URL` must point to the disposable database. Use a unique database name for each rehearsal. Do not restore over a live database as part of this procedure.

## Verify schema and representative records

Anchor-Kit's SQL adapter records applied migrations in `anchor_kit_migrations`. Verify that the current core migrations are present:

```sh
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT name FROM anchor_kit_migrations WHERE name LIKE 'core:%' ORDER BY name;"
```

Check representative row counts without printing personal data or payload contents:

```sh
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -c \
  "SELECT 'customers' AS table_name, count(*) FROM customers UNION ALL SELECT 'interactive_transactions', count(*) FROM interactive_transactions UNION ALL SELECT 'webhook_events', count(*) FROM webhook_events;"
```

Compare the returned counts and migration names with the source database using the same queries. Counts can change while the source is active; use a maintenance window or a consistent snapshot when exact comparisons are required. Do not export customer or webhook contents into logs or tickets.

## Rehearse and clean up

Record the date, PostgreSQL client/server versions, database identifier (not credentials), dump size, restore result, and whether the expected migrations and records were present. Record any corrections needed before the next rehearsal. Remove the disposable database and temporary dump when the rehearsal is complete:

```sh
dropdb --maintenance-db "$ADMIN_DATABASE_URL" anchor_kit_restore_check
shred -u anchor-kit-backup.dump 2>/dev/null || rm -f anchor-kit-backup.dump
```

On systems where secure file deletion is not supported, use the approved encrypted-storage cleanup process. A successful rehearsal confirms only that this particular backup restored and passed these checks; it does not establish a recovery-time guarantee.
