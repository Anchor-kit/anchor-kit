# Idempotency reservation recovery

The deposit handler reserves an idempotency key before creating a transaction. The transaction and completed response are then written together. A process exit before that transaction leaves a pending reservation that currently returns `409 idempotency_in_progress` on every retry until the row expires.

## Recovery contract

1. Store a reservation owner token and lease deadline with each pending key.
2. Keep returning `409 idempotency_in_progress` while the lease is active.
3. After lease expiry, check for the transaction linked to the reservation inside the same database transaction that attempts recovery.
4. If the transaction exists, return its saved response when available. If no safe response can be reconstructed, return a stable error and never create another deposit.
5. If the transaction does not exist, transfer reservation ownership with a compare-and-set update, then create the transaction and complete the response atomically.

## Existing rows

Rows created before owner and lease metadata have no proven owner. Recovery should leave them pending and reject retries until an explicit cleanup policy handles them. Automatic replay or deletion could repeat a payment or erase evidence.

## Required database coverage

Run the same recovery contract against SQLite and PostgreSQL. Tests must cover an active lease, an expired lease with a linked transaction, an expired lease without a transaction, two concurrent reclaimers, and a process restart between reservation and transaction creation.

The adapter currently uses a shared PostgreSQL query interface for transaction statements. Recovery must use a single conditional statement or a dedicated connection so the existence check and ownership transfer remain atomic.
