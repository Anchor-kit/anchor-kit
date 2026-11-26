# PostgreSQL connectivity incident response

This guide covers a PostgreSQL interruption affecting an Anchor-Kit host. It
assumes the host uses the built-in SQL adapter with `framework.database.provider`
set to `postgres` and the connection target supplied through the host's
configuration, commonly `DATABASE_URL`. Do not copy a connection string or
credential into an incident ticket, shell transcript, or source file.

## Readiness and initial assessment

1. Record the approximate start time, affected deployment or instance, public
   base path, and the first observed symptom. Common symptoms include database
   connection errors in application logs, request failures, background work
   that stops progressing, or readiness changing to `not_ready`.
2. Check the mounted health and readiness endpoints without sending
   credentials:

   ```sh
   curl -sS -i "${ANCHOR_BASE_URL}/health"
   curl -sS -i "${ANCHOR_BASE_URL}/ready"
   ```

   The router's `/health` endpoint is a liveness response and does not query
   PostgreSQL. `/ready` runs `SELECT 1 FROM anchor_kit_migrations LIMIT 1`
   through the configured database adapter, has a one-second probe deadline,
   and returns `503` with `{"status":"not_ready"}` when the application is
   not initialized or the probe fails. `ANCHOR_BASE_URL` is a placeholder for
   the host's actual mounted URL, such as `https://anchor.example/anchor`.

3. Compare the application symptom with the database service's own monitoring.
   Separate a database outage from a bad `DATABASE_URL` or schema, DNS or
   network reachability, authentication rejection, exhausted PostgreSQL
   connections, and CPU, memory, storage, or disk-pressure problems. Record
   which check failed and when; do not change configuration during this initial
   assessment.
4. Escalate to the database or platform owner immediately when the database is
   unavailable, storage is full, connection limits are exhausted, credentials
   may have been exposed, or the cause is not clear after the first read-only
   checks. Do not repeatedly restart every instance while the database condition
   is unknown.

## Safe diagnostics

Use a trusted operator shell and approved, read-only access. Keep command
history and output free of passwords and complete connection URLs.

### Application and database logs

- Inspect the host's configured application logs for the incident window. Look
  for connection refusal, DNS, timeout, authentication, too-many-connections,
  transaction, and query errors. Record error categories and timestamps, not
  secrets, request bodies, bearer tokens, or full connection strings.
- Check PostgreSQL server logs and platform metrics for restarts, failed
  authentication, refused connections, active connection count, locks, CPU,
  memory, storage, and replication or failover events.
- Confirm which application version and deployment instance emitted each error.
  A readiness failure alone does not identify whether PostgreSQL, the network,
  credentials, or the application configuration is at fault.

### Reachability and capacity

If the PostgreSQL client tools are installed, run these checks with an
authorized connection target. The shell variable is a placeholder and should
be populated through the deployment's protected secret mechanism:

```sh
pg_isready --dbname="$DATABASE_URL"
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c 'SELECT 1;'
```

`pg_isready` only checks whether a server accepts connections. `SELECT 1`
confirms that the configured role can establish a session and execute a query.
If either command fails, preserve the error category and timestamp without
printing the connection target.

For an authorized PostgreSQL administrator, inspect connection capacity without
changing it:

```sql
SHOW max_connections;

SELECT state, count(*)
FROM pg_stat_activity
GROUP BY state
ORDER BY state;
```

The built-in adapter keeps one long-lived `pg.Client` per adapter instance and
opens short-lived clients for concurrent deposit transactions. It does not
configure a pool. Budget application instances, worker processes, deployment
surge capacity, migrations, monitoring, and administrative sessions together;
see [PostgreSQL connection budget](postgres-connection-budget.md).

Do not run `pg_terminate_backend`, alter `pg_hba.conf`, disable authentication,
open PostgreSQL to the public network, or raise connection limits as a routine
application recovery step. Such changes require an authorized database owner,
an approved change process, and a separate capacity assessment.

## Recovery and reconnection

Use this order unless the database or platform owner directs otherwise:

1. Stabilize the database or network dependency first. Wait for an in-progress
   managed failover, restart, or storage recovery to complete rather than
   generating aggressive retry traffic.
2. Re-run `pg_isready` and the read-only `SELECT 1` check from an approved
   application or operator network. Confirm the expected database role and
   schema without displaying credentials.
3. Check `${ANCHOR_BASE_URL}/ready`. Wait for a `200` response with
   `{"status":"ready"}` and continue to monitor it for stability. A `200`
   from `/health` alone is not sufficient evidence of database recovery.
4. The built-in PostgreSQL adapter connects once during `anchor.init()` and
   keeps the client until shutdown. The repository does not provide an
   automatic reconnect loop or a pool recycle command. If an established client
   remains unusable after PostgreSQL is healthy, use the deployment platform's
   approved, graceful application restart or instance replacement procedure.
   Do not invent a process-manager command or restart all replicas at once.
5. After a controlled restart, confirm that initialization connects and runs
   migrations, `/ready` is healthy, and the application logs show no new
   connection failures. Migrations are code-defined and run during `anchor.init()`;
   do not run a separate migration CLI because this repository does not provide
   one.
6. If initialization fails during migration, stop the rollout and inspect the
   migration error and `anchor_kit_migrations` using the procedures in
   [Database migrations](database-migrations.md). Named migration failures are
   normally rolled back, but legacy/idempotent upgrades do not have the same
   generic rollback wrapper. Do not retry repeatedly or delete migration rows.

## Check incomplete work after recovery

Database interruption can produce failed requests, timed-out requests, queue
failures, or work whose external effect is uncertain. Treat a client timeout as
an unknown outcome until the stored transaction or provider record proves what
happened.

1. Review application error logs for the incident window and identify affected
   transaction IDs, idempotency keys, webhook event IDs, and watcher task IDs.
   Do not copy customer data, access tokens, raw webhook payloads, or provider
   secrets into the review record.
2. For deposit requests, use the same account-scoped `Idempotency-Key` and
   request body when a retry is appropriate. The database transaction and
   cached response are written atomically; a matching completed request returns
   the stored result, while an in-progress or unavailable response has a
   specific retry response. Never replay a timed-out money-moving request with
   a new idempotency key until the original state has been checked.
3. For webhook callbacks, inspect the persisted `webhook_events` record and
   follow [the unresolved webhook callback runbook](unresolved-webhook-callbacks.md).
   A timeout can mean the provider operation happened even when the callback
   failed; do not invoke a callback or transfer again blindly.
4. Background work uses an in-memory queue only. It has bounded retries for
   retryable failures and retains up to 1,000 terminal failures for operator
   review. Through an initialized `AnchorInstance`, inspect
   `getFailedQueueJobs()` and requeue only after correcting the underlying
   database or data problem with `requeueFailedQueueJob(id)`. There is no
   durable external queue or public HTTP endpoint for these operations.
5. Remember that the queue is process-local. A graceful stop returns waiting
   retry entries to the queue for a later start, but a process crash does not
   make in-memory queue entries durable. Reconcile important transaction and
   watcher records from PostgreSQL before replaying work after a crash.
6. The transaction watcher reads pending transactions and enqueues watcher
   tasks. A failed database tick is not proof that a transaction expired or
   that an external payment was absent. Check the persisted transaction and
   watcher-task records, then use the existing transaction/provider status
   checks before any retry or state transition.
7. Verify duplicate-processing risk before retrying: use persisted operation
   identity, account-scoped idempotency, provider references, or transaction
   records as applicable. Do not manually edit production rows, mark work
   processed, rerun migrations, or replay requests simply to clear an alert.

## Verification and closure

Close the incident only after all of the following are true:

- PostgreSQL monitoring is healthy and authorized read-only checks succeed.
- `/ready` remains `200` with `status: ready` across several probe intervals;
  `/health` is treated only as liveness.
- New application logs show successful database use without recurring
  connection, authentication, timeout, or capacity errors.
- A representative non-destructive application request succeeds, and important
  transactions, idempotency records, webhook events, watcher tasks, and failed
  queue jobs have been reconciled.
- Any requeued work is monitored to completion and checked for duplicates or
  state mismatches.
- The incident record includes the start/end time, affected components,
  symptoms, evidence, recovery actions, operator approvals, unresolved risk,
  and follow-up owner. Do not attach secrets or raw customer/provider payloads.

If failures recur, stop replaying work and escalate with timestamps, deployment
version, database identifier, safe error categories, readiness results, and
capacity observations. Follow-up may include connection-budget changes,
database failover review, durable worker planning, or a code change; none is
assumed by this runbook.
