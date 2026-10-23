# Atomic transaction transitions

`DatabaseAdapter.transitionInteractiveTransaction()` performs compare-and-set status changes for
the initial deposit lifecycle. It takes the transaction ID, expected current status, destination
status, and an optional replacement amount. The adapter checks the deposit transition graph and
updates status, amount, and `updated_at` in one conditional SQL statement.

The result has a stable discriminant:

- `outcome: 'updated'` includes the updated transaction.
- `outcome: 'conflict'` includes `reason` (`invalid_transition`, `status_mismatch`, or `not_found`)
  and the current transaction when it exists.

Invalid graph edges do not write any fields. Concurrent callers with the same expected status
cannot both win; after one update, the other receives `status_mismatch`. Expiry jobs use this
operation with `pending_user_transfer_start` as their expected status.

Focused verification:

```bash
bun test tests/runtime/database/sql-database-adapter.test.ts tests/types/transaction-status.test.ts
```

Expected result: both test files pass, including one-winner competing transitions and an invalid
transition that preserves amount, status, and timestamps.
