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

## Confirmed settlement

After the network client confirms a saved payment, call `DatabaseAdapter.confirmSettlement()` with
the confirmed transaction hash, amount and recipient. The adapter checks the stored expected
amount (`amount_out` when available) and account, stores the hash, and marks the transaction
`completed` in one compare-and-set operation. Replaying the same confirmation returns the completed
record; mismatched details leave it pending. This database method does not submit a transaction or
verify ledger inclusion; the caller must supply a confirmed network result.

## Reconciled rail payments

After a provider event has been verified and matched to a transaction, call
`DatabaseAdapter.recordReconciledRailPayment()` to move a `pending_external` deposit to
`pending_stellar` and record its durable settlement job in one database transaction. Reusing the
same operation ID returns the existing job. A status mismatch, missing transaction, or reused
operation ID does not create another job. Callers must verify the provider event before invoking
this persistence operation.

Focused verification:

```bash
bun test tests/runtime/database/settlement-jobs.test.ts
```

Expected result: matching amount, recipient and hash complete once; mismatched details do not
change status or hash. The rollback fixture leaves the transaction and settlement job unchanged on
failure; a successful retry stores both; replay returns the same job ID.
