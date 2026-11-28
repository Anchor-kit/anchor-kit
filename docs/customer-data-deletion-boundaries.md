# Customer data deletion and retention boundaries

This document inventories the customer information that the current SQL schema stores, identifies
dependencies that constrain deletion, and proposes a deletion contract for maintainer review. It is
a design proposal, not an implementation or a legal determination. It does not claim compliance
with a privacy regime, and it does not authorize any team to delete production data.

The production schema is defined in code by `src/runtime/database/sql-database-adapter.ts`. There
are no standalone SQL migration files or ORM models at this revision; the `CORE_MIGRATIONS` entries
and later upgrade steps in that file are the source of truth. Plugin schemas can add tables through
`schema.migrations`, so the inventory below covers the core schema only.

## Current customer record map

### Direct customer identity

| Table               | Columns                                                         | Association                                                                                                |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `customers`         | `id`, `email_address`, `phone_number`, `kyc_data`, `created_at` | `id` is the immutable export and request anchor.                                                           |
| `customer_accounts` | `account_id`, `customer_id`, `created_at`                       | `account_id` is primary key; `customer_id` references `customers.id`. One account belongs to one customer. |

`kyc_data` stores the complete `KycData` JSON object: names, birth date, postal address,
nationality, identity document metadata, and arbitrary SEP-9 `additional_fields`. Binary identity
documents are not stored by the core routes; only document metadata is present in this column.
`insertOrGetCustomer()` mirrors submitted SEP-9 email and phone values into `email_address` and
`phone_number`.

The adapter exposes `insertOrGetCustomer()`, `getCustomerByAccountId()`, and `updateCustomer()`.
It has no `deleteCustomer()`, `anonymizeCustomer()`, or account-deletion method. API responses use
`toCustomerSummary()` and `customerResponse()` to return field status and missing-field names
rather than identity values.

### Account-linked operational records

These records are not all customer profiles, but they contain account identifiers or raw payloads
that can identify or correlate a customer. They must be included in any deletion scope review.

| Table                         | Relevant fields                                                                 | Association or risk                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `auth_challenges`             | `account`, `challenge`, `expires_at`                                            | One-time SEP-10 challenge bound to a wallet account.                                                                         |
| `interactive_transactions`    | `account`, `rail_reference`, `stellar_transaction_hash`, status fields          | `account` is a free-text wallet address joined to `customer_accounts.account_id` by application logic, not by a foreign key. |
| `interactive_sessions`        | `id`, `account`, `transaction_id`, `actions`, `consumed_actions`, `expires_at`  | Session token ID and account; `transaction_id` references `interactive_transactions.id`.                                     |
| `idempotency_keys`            | `scope`, `idempotency_key`, `request_hash`, `response_body`, `created_at`       | `scope` includes `deposit:<account>`; `response_body` can contain an interactive URL with a live JWT.                        |
| `webhook_events`              | `provider`, `event_id`, `payload`, `error_message`, `recovery_result`, `status` | Raw provider body may contain payer/customer fields and payment references.                                                  |
| `watcher_tasks`               | `payload`, `status`, `created_at`                                               | Current payload is count/timestamp data, but the column accepts arbitrary JSON.                                              |
| `settlement_jobs`             | `operation_id`, `payload_ref`, `status`, `created_at`                           | `payload_ref` is `transaction:<transactionId>`, an indirect account/payment link.                                            |
| `refund_operations`           | `payment_id`, `transaction_id`, `status`, `type`                                | `transaction_id` references `interactive_transactions.id`; refunds are financial evidence.                                   |
| `stellar_sequence_leases`     | `account_id`, `operation_id`, `lease_owner`, `lease_token`, `expires_at`        | Account-linked worker coordination metadata and lease secret.                                                                |
| `stellar_account_sequences`   | `account_id`, `sequence_number`, `status`                                       | Account-linked sequence state.                                                                                               |
| `stellar_sequence_operations` | `account_id`, `operation_id`, `sequence_number`, `status`                       | Account-linked sequence history; `account_id` references `stellar_account_sequences.account_id`.                             |

Migration bookkeeping tables (`anchor_kit_migrations`, `schema_migrations`,
`anchor_kit_schema_migrations`) are operational metadata and are not customer records. They must
not be deleted as part of a customer request.

Non-database personal data also exists outside this schema: IP-keyed rate-limit buckets in
`src/runtime/http/client-identifier.ts` and up to 1,000 retained terminal queue failures in
`src/runtime/queue/in-memory-queue.ts`. A complete boundary review should name them even though a
database deletion contract cannot erase process memory.

## Current retention behavior

`cleanupOldRecords()` in `src/runtime/database/sql-database-adapter.ts` is the only automatic
cleanup path:

- `auth_challenges` and `interactive_sessions` are deleted where `expires_at < cutoff`.
- `idempotency_keys` are deleted where `created_at < cutoff`, regardless of status.
- `webhook_events` and `watcher_tasks` are deleted only where `created_at < cutoff` and status is
  `processed` or `failed`; pending and unresolved rows remain.
- The cutoff is strict: rows equal to the cutoff are kept.
- The default window is 90 days and can be overridden through
  `operational.transactionRetentionDays` or the legacy `framework.watchers.retentionDays` setting.

`customers`, `customer_accounts`, `interactive_transactions`, `refund_operations`,
`settlement_jobs`, the `stellar_sequence_*` tables, and migration metadata are never removed by
this cleanup. A retention configuration value is therefore not a customer-deletion contract.

## Deletion constraints

1. `customer_accounts.customer_id` has a foreign key to `customers.id` with no `ON DELETE CASCADE`
   or `SET NULL`. A hard delete of a customer requires explicit handling of linked accounts first.
2. Deleting `customer_accounts` does not delete transactions. `interactive_transactions.account`
   is a plain string, so financial history survives and can no longer be resolved to the customer
   through the core schema. If the account string itself is retained, it can still re-identify the
   customer.
3. Current `insertOrGetCustomer()` will recreate a customer and account link if the same account
   authenticates again. The schema has no tombstone or suppression list to prevent re-creation
   after deletion.
4. `interactive_sessions.transaction_id` and `refund_operations.transaction_id` reference
   `interactive_transactions.id` without cascade. Referenced transactions cannot be hard-deleted
   without first resolving those dependencies.
5. `webhook_events` uses `UNIQUE(provider, event_id)` and operation-key dedupe. Removing pending or
   unresolved rows can erase reconciliation evidence and may allow a replayed provider event to
   create a duplicate payment. `docs/idempotency-reservation-recovery.md` already warns about this.
6. `idempotency_keys.response_body` may contain an interactive URL containing a live JWT. Deleting
   the row removes that token copy, but retaining the row keeps it replayable.
7. Snapshots, backups, PITR/WAL archives, exports, and replicas can restore data that was deleted
   from the live database. Existing backup and export docs explicitly do not promise secure
   erasure from those copies.
8. Plugin migrations can introduce tables that reference customers or accounts. The host must
   inventory plugin-owned records before approving a deletion.
9. There is no audit table in the current schema. The TRD's `TransactionMessage` audit trail is a
   future-state design, not an implemented control.

## Proposed deletion contract for maintainer review

The contract should be reviewed as a set of decisions before any adapter API is added.

### Scope and identifiers

- A request must identify a `customers.id` from an approved request record. Email, phone number,
  and account IDs supplied without verification are not valid selection keys.
- The scope must enumerate every `customer_accounts.account_id` linked to that customer and list
  every core and plugin-owned table where that customer ID or account ID appears.
- The request must state whether the desired outcome is `RESTRICTED`, `ANONYMIZED`, or `ERASED`.
  `RESTRICTED` keeps records but blocks normal use; `ANONYMIZED` replaces direct identifiers while
  preserving non-identifying history; `ERASED` removes rows that the contract declares erasable.
- Plugin data and backup/PITR copies must be explicitly in scope or explicitly excluded. Silence is
  not consent to exclusion.

### State model

| State       | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `REQUESTED` | Intake captured request ID, requester, and claimed customer ID.                           |
| `SCOPED`    | Inventory completed and every dependency classified as retained, anonymized, or erasable. |
| `APPROVED`  | Required approvers accepted the scope and outcome.                                        |
| `BLOCKED`   | An unresolved dependency, plugin table, or backup copy prevents execution.                |
| `EXECUTING` | Changes are being applied in one controlled transaction where supported.                  |
| `COMPLETED` | Verification query confirms the intended state; no unexpected customer ID remains.        |
| `FAILED`    | Execution stopped and compensating action was recorded.                                   |
| `CANCELLED` | Approved request withdrawn before execution.                                              |

### Execution rules

- Do not execute from a customer ID supplied in a public API request alone.
- Run scope verification and deletion under a dedicated, least-privilege database identity; do not
  reuse the runtime application identity.
- Anonymization must overwrite `email_address`, `phone_number`, and `kyc_data` with non-identifying
  values and keep `customers.id` as the internal correlation key only if the approved outcome
  allows it.
- Account links must be removed or tombstoned before the customer row is erased. A tombstone is
  required to prevent `insertOrGetCustomer()` from recreating the link on the next authentication.
- Financial and operation records must be classified table by table. Do not hard-delete rows that
  are needed for idempotency, refund, settlement, or sequence correctness.
- Unresolved `webhook_events` and `idempotency_keys` rows are blockers by default; they require an
  explicit maintainer decision to anonymize payload fields while retaining dedupe keys.
- Every execution must produce a verification result listing affected row counts by table and any
  blocked records, without copying customer values into the result.

### Authorization questions for maintainers

- Which role may submit, approve, and execute a deletion? Should approval and execution be
  separated?
- What evidence is required to bind the request to `customers.id` and to each verified account?
- Who owns plugin tables that contain customer or account identifiers, and who approves their
  deletion?
- Who is authorized to decide that unresolved webhook, idempotency, refund, or settlement records
  are retained rather than erased?
- Who can authorize action against backups, PITR/WAL archives, replicas, and prior exports?
- Should a re-authentication after erasure be rejected, quarantined, or allowed to create a new
  customer identity?

### Audit questions for maintainers

- Where will deletion request events be recorded, given that no audit table exists today?
- Which fields are safe to record: request ID, approver, operator, table counts, and timestamps, or
  also customer ID and account IDs?
- How long are audit records retained, and who can read them?
- Must audit records be append-only, and if so, what mechanism enforces that?
- How should an audit record correlate to the original request without republishing deleted
  identity values?
- How are failed, cancelled, and blocked attempts recorded differently from completed deletions?

### Transaction retention questions for maintainers

- Which of `interactive_transactions`, `refund_operations`, `settlement_jobs`, `webhook_events`,
  `idempotency_keys`, and `stellar_sequence_*` must be retained for payment correctness?
- For records that are retained, which fields can be anonymized without breaking dedupe, replay,
  reconciliation, or sequence uniqueness?
- Should `interactive_transactions.account` be replaced with a pseudonym, and if so, what mapping
  is retained and where?
- How long should retained transaction evidence outlive the customer record?
- What happens to a deletion when a transaction is pending, refunded, disputed, or still lease-locked?
- Does the current 90-day `cleanupOldRecords()` window need to differ for customer records,
  unresolved webhooks, and financial history?

### Verification for reviewers

This change is documentation only. Reviewers can confirm the cited schema and runtime behavior
with:

```sh
bun test tests/runtime/database/versioned-migrations.test.ts
bun test tests/runtime/sql-adapter-cleanup.test.ts
bun test tests/runtime/database/sql-database-adapter.test.ts
bun test tests/runtime/sep12-customer-endpoints.test.ts
```

Expected result: migration names, retention cutoff behavior, account isolation, and PII-free
customer responses match the boundaries described above.

## Related documentation

- [Customer identity storage](./customer-storage.md)
- [Customer data export procedure](./customer-data-export.md)
- [Database migrations and recovery](./database-migrations.md)
- [Idempotency reservation recovery](./idempotency-reservation-recovery.md)
- [PostgreSQL backup and restore](./postgres-backup-restore.md)
