# SQLite concurrency settings

`SqlDatabaseAdapter` tunes every SQLite connection the moment it opens, because
webhook, watcher, and idempotency writes can overlap during normal anchor
operation. The settings live in `src/runtime/database/sql-database-adapter.ts`.

## Chosen settings

| Setting                     | Value    | Applies to                       |
| --------------------------- | -------- | -------------------------------- |
| `PRAGMA journal_mode = WAL` | `WAL`    | file-backed databases only       |
| `PRAGMA busy_timeout`       | `5000`ms | every database, including memory |

### Why WAL

The default rollback journal gives a writer an exclusive lock: any reader or
writer that arrives mid-commit is refused with `SQLITE_BUSY`. In WAL mode
readers keep a consistent snapshot while a single writer commits, so a watcher
poll, a webhook delivery, and an idempotency insert no longer block each other.
WAL also turns most `SQLITE_BUSY` situations into short waits instead of hard
failures, which is exactly the contention described in
[issue #602](https://github.com/Anchor-kit/anchor-kit/issues/602).

`journal_mode` is persisted in the database file, so it survives reconnects and
restarts. It is still re-requested on every `connect()`, which also upgrades
existing databases created before this change.

### Why a 5 second busy timeout

Writers from different connections (or processes) still serialize. Without a
timeout SQLite fails the moment a lock is held; with one it retries for up to
five seconds. Overlapping anchor writes are short, so five seconds absorbs
routine contention while keeping a genuinely stuck lock visible as an error
instead of an indefinite hang.

`synchronous` is deliberately left at SQLite's default (`FULL`). Pairing WAL
with `NORMAL` would trade durability for throughput, and that is a separate
decision from the lock-contention behavior handled here.

## In-memory databases stay supported

A pure in-memory database has no file for connections to share and SQLite keeps
it on the `memory` journal, so `WAL` is never requested for it. The busy timeout
is still applied. Both URL forms are recognised:

- `sqlite::memory:` / `:memory:`
- `file::memory:` and URIs such as `file:name?mode=memory&cache=shared`

Test helpers such as `makeSqliteDbUrlForTests()` open file-backed databases and
therefore do exercise WAL.

## Lifecycle notes

- **Connect** – settings are applied immediately after the handle is opened. If
  the connection cannot be configured, the handle is closed before the error is
  rethrown so nothing is leaked.
- **Migrate** – unchanged. `journal_mode` is persistent, so migrations on a
  database that was previously opened in WAL mode stay in WAL mode.
- **Disconnect** – unchanged. `close()` checkpoints the WAL and removes the
  `-wal`/`-shm` sidecar files when the last connection closes.
- **Crash recovery** – if the process dies before a checkpoint, the next
  connection replays the `-wal` file automatically.

## Operational notes

- WAL creates `<database>-wal` and `<database>-shm` sidecar files next to the
  database. Copy or back up the database only while it is closed, or use
  `VACUUM INTO` / the SQLite backup API so a checkpoint is not missed.
- WAL requires shared memory, so it does not work on some network filesystems.
  SQLite falls back to its rollback journal there; the busy timeout still
  applies.
- WAL still allows only one writer per database file. Applications that need
  genuinely parallel writes should use the PostgreSQL provider.

## Test coverage

`tests/runtime/sqlite-wal-concurrency.test.ts` covers the settings and the
behavior they enable:

- WAL and the busy timeout are applied to file-backed databases.
- In-memory databases keep the `memory` journal, keep working, and still get the
  busy timeout.
- A writer on one connection succeeds while a reader on another connection holds
  an open read snapshot (this is the test that fails without WAL).
- Overlapping write bursts across four connections complete without lock
  failures.
- An existing WAL database reopens and accepts migrations without losing data.
