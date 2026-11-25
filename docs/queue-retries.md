# Queue retries and failed jobs

Background financial work must survive a transient outage and remain reviewable when it cannot
succeed. The in-memory queue now retries transient failures within a configured bound and records
terminal failures instead of treating them as successful no-ops.

## Retry policy

`framework.queue.retry` controls the budget:

| Field         | Default | Meaning                                               |
| ------------- | ------- | ----------------------------------------------------- |
| `maxAttempts` | `3`     | Total attempts, including the first. Minimum `1`.     |
| `baseDelayMs` | `250`   | First retry delay. Doubled after each failed attempt. |
| `maxDelayMs`  | `30000` | Upper bound for any single retry delay.               |

Retries wait outside a worker slot, so concurrency observes only the jobs currently executing. A
waiting retry still counts in `getQueueStatus().pending`. Calling `stop()` cancels pending backoff
timers and returns those jobs to the waiting queue, so a restart can retry them rather than losing
financial work.

## Classification

The default classifier returns `'retryable'` or `'permanent'`:

1. `PermanentJobError` and `RetryableJobError` (exported by the SDK) always win.
2. `ConfigError` and `ValidationError` are permanent.
3. Deterministic database codes are permanent: PostgreSQL `23502`, `23503`, `23505`, `22P02`,
   `42703`, `42P01`; SQLite `SQLITE_CONSTRAINT`, `SQLITE_MISMATCH`, `SQLITE_NOTFOUND`,
   `SQLITE_RANGE`; Node `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`.
4. An error with a boolean `retryable` property overrides the default.
5. Anything else is retryable. The attempt limit guarantees termination, and treating unknown
   errors as transient avoids dropping work caused by an outage.

Provide `framework.queue.classifyError` to apply a provider- or application-specific policy.
Malformed job payloads and unknown job types raised by `AnchorInstance.processQueueJob` are
`PermanentJobError`s; they are recorded and never retried.

## Terminal failures

A job becomes terminal when its classification is permanent or its attempt limit is reached. The
queue then:

1. Records a `QueueJobFailure` with the job, attempts, `outcome` (`'permanent'` or `'exhausted'`),
   the final error and a timestamp.
2. Invokes `framework.queue.onError(job, error)` when configured.
3. Invokes `framework.queue.onFailedJob(failure)` when configured.
4. Logs the failure when neither handler is configured. Failure is never reported as success.

The most recent 1000 terminal failures are retained per adapter; older records are dropped with a
warning. Review them through `anchor.getFailedQueueJobs()`, which returns copies so queue state
cannot be mutated by the caller. A reviewed job can be retried with a fresh attempt budget:

```typescript
const failures = anchor.getFailedQueueJobs();
const failure = failures.find((entry) => entry.job.type === 'expire_transaction');

if (failure) {
  // Fix the upstream record first, then:
  await anchor.requeueFailedQueueJob(failure.id);
}
```

`requeueFailedQueueJob` returns `false` for an unknown id and throws when the active queue backend
does not retain failure records. The record is removed only after the job is accepted back into the
queue.

## Focused acceptance check

```bash
bun test tests/runtime/queue-retry.test.ts
```

Expected result: 6 tests pass.

- A transient fixture fails twice and succeeds on the third attempt without a failure record.
- An always-transient fixture stops at `maxAttempts` and records `outcome: 'exhausted'`.
- A permanent fixture is attempted once and records `outcome: 'permanent'`.
- A reviewed failure can be requeued and succeeds with a fresh attempt budget.
- Invalid retry options are rejected.
- Through `createAnchor`, a malformed financial job is observable in
  `getFailedQueueJobs()` and reaches `onFailedJob` instead of resolving silently.

Also run the public-factory regression check:

```bash
bun test tests/core/factory-background-startup.test.ts
```

Expected result: all factory background-startup tests pass.

Run the project checks before opening a pull request:

```bash
bun run typecheck
bun run lint
bun run format:check
```
