# Webhook duplicate delivery operational guide

Anchor Kit receives asynchronous webhook deliveries from upstream payment rails, banking partners, and fiat rails via `POST /webhooks/events`. Because distributed payment networks routinely retry webhook deliveries due to network latency, transient gateway timeouts, or provider-side retry policies, Anchor Kit implements provider-scoped deduplication and lease-based execution locks to guarantee idempotent, at-most-once execution of webhook side effects.

This guide details how deduplication is enforced across the processor and storage layers, the semantics of duplicate HTTP responses, how repeated event IDs and distinct providers interact, and safe troubleshooting procedures using fictional identifiers.

---

## Architecture overview

Webhook processing coordinates three components:

1. **HTTP Router (`src/runtime/http/express-router-impl.ts`)**:
   - Ingests incoming HTTP requests on `POST /webhooks/events`.
   - Extracts and normalizes the provider identifier from the `x-webhook-provider` header (precedence) or payload body (`payload.provider`), defaulting to `'generic'`.
   - Verifies the HMAC-SHA256 signature (`x-anchor-signature`) over the unaltered raw request body when `security.verifyWebhookSignatures` is enabled.
   - Delegates execution to the `WebhookProcessor` and translates the outcome into an HTTP `200 OK` response with delivery status metadata, or an HTTP `4xx`/`5xx` error.

2. **Default Webhook Processor (`src/runtime/webhooks/default-webhook-processor.ts`)**:
   - Derives the stable operation key: `deriveWebhookOperationKey(provider, eventId) => "${provider}:${eventId}"`.
   - Coordinates event recording with the storage adapter via `database.insertOrGetWebhookEvent(...)`.
   - Enforces execution exclusivity using distributed lease ownership (`database.claimWebhookAttempt(...)`).
   - Dispatches the cooperative `onEvent` callback within a configured deadline (`callbackTimeoutMs`, default 30,000 ms).
   - Finalizes status via `database.completeWebhookAttempt(...)` upon success (`status = 'processed'`) or failure (`status = 'failed'` or `'unresolved'`).
   - Reconciles retries through `database.claimWebhookRecovery(...)` and the optional `recoverOperation` hook.

3. **SQL Database Adapter (`src/runtime/database/sql-database-adapter.ts`)**:
   - Persists records to the `webhook_events` table in SQLite or PostgreSQL.
   - Enforces composite uniqueness on `(provider, event_id)`:
     - **PostgreSQL**: `ON CONFLICT(provider, event_id) DO NOTHING` with `idx_webhook_events_operation_key`.
     - **SQLite**: `SELECT ... WHERE provider = ? AND event_id = ? LIMIT 1` combined with index `idx_webhook_events_operation_key`.
   - Executes atomic compare-and-set updates during lease claims and state transitions.

---

## Provider-scoped deduplication mechanics

Deduplication in Anchor Kit is strictly scoped to the tuple of `(provider, event_id)`.

### Why deduplication is provider-scoped

External payment rails operate independently. Two distinct rails (for example, a SEPA rail and a mobile money rail) can conceivably assign the same event ID format or numerical sequence (such as `1001` or `evt_test_01`). 

Global deduplication by `event_id` alone would cause a collision: the second provider's legitimate transaction event would be incorrectly flagged as a duplicate and silently ignored. 

By binding event identity to the provider:
- `mock-rail-eu:evt_sim_982341` and `mock-pay-ng:evt_sim_982341` are distinct operations.
- Each provider maintains an isolated namespace in the `webhook_events` table.

### Storage schema (`webhook_events`)

| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `TEXT` (UUID) | Internal primary key for the record. |
| `event_id` | `TEXT` | Provider's external event identifier. |
| `provider` | `TEXT` | Rail/partner identifier (e.g. `mock-rail-eu`). |
| `operation_key` | `TEXT` | Deterministic composite key (`${provider}:${eventId}`). |
| `status` | `TEXT` | Lifecycle state: `'pending'`, `'processed'`, `'failed'`, or `'unresolved'`. |
| `payload` | `TEXT` / `JSONB` | JSON serialized payload received with the webhook. |
| `attempt_id` | `TEXT` (UUID) | Unique identifier of the current execution attempt. |
| `attempt_number` | `INTEGER` | Monotonically incrementing attempt counter (starts at 0, 1 on first claim). |
| `lease_owner` | `TEXT` (UUID) | Worker instance token holding the execution lease. |
| `lease_expires_at` | `TEXT` / `TIMESTAMPTZ`| Expiry timestamp of the active execution lease (60s default). |
| `processed_at` | `TEXT` / `TIMESTAMPTZ`| Timestamp when processing reached completion. |
| `error_message` | `TEXT` | Error description if the attempt failed or timed out. |
| `recovery_result` | `TEXT` / `JSONB` | Persisted outcome from payment rail recovery lookups. |

---

## Delivery behavior matrix

The table below summarizes system behavior for the possible delivery combinations:

| Scenario | Condition | System Action | HTTP Status | Response `duplicate` | Response `status` | Callback Invocation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **New Event** | `(provider, event_id)` not present | Inserts row as `pending`, claims lease, calls `onEvent`, updates to `processed`. | `200 OK` | `false` | *(Omitted)* | Executed (1 time) |
| **Duplicate Delivery (Processed)** | `(provider, event_id)` exists with `status = 'processed'` | Record found in storage; returns duplicate record immediately. | `200 OK` | `true` | `"processed"` | **Skipped** (0 times) |
| **Concurrent Duplicate (In-flight)** | `(provider, event_id)` exists with `status = 'pending'` & active lease | Claim fails due to active lease lock held by another process; returns duplicate record. | `200 OK` | `true` | `"pending"` / omitted | **Skipped** |
| **Duplicate Delivery (Unresolved)** | `(provider, event_id)` exists with `status = 'unresolved'` | Reconciled through `reconcilePreviousAttempt` or recovery hooks without side-effects. | `200 OK` | `true` | `"unresolved"` / recovered | **Skipped** |
| **Retry of Failed Event** | `(provider, event_id)` exists with `status = 'failed'` | CAS update resets record to `pending` with new payload; allows single retry execution. | `200 OK` (or `400` on repeat error) | `false` | *(Omitted)* | Executed (retry) |
| **Different Providers, Same Event ID** | Provider A and Provider B send identical `event_id` | Keys `A:ID` and `B:ID` are independent. Both insert and process separately. | `200 OK` (each) | `false` (each) | *(Omitted)* | Executed for both |

---

## Response semantics and HTTP status codes

### Why duplicates return HTTP `200 OK`

Webhook producers (such as Stripe, Circle, or local bank switches) implement automated retry loops with exponential backoff. If an endpoint responds with HTTP `409 Conflict`, `400 Bad Request`, or `500 Internal Server Error`, the upstream rail treats the delivery as unacknowledged and continues retrying.

Anchor Kit returns HTTP `200 OK` for duplicate deliveries to **acknowledge receipt** and stop redundant retries, while including `"duplicate": true` in the response body so monitoring tools and callers can clearly distinguish replays from original deliveries.

### Response structures

#### 1. Initial successful delivery
```json
{
  "received": true,
  "duplicate": false,
  "event_id": "evt_sim_982341",
  "received_at": "2026-11-25T12:00:00.000Z",
  "provider": "mock-rail-eu"
}
```

#### 2. Duplicate delivery (already processed)
When an identical `(provider, event_id)` has already completed processing, the existing status is appended to the response:
```json
{
  "received": true,
  "duplicate": true,
  "event_id": "evt_sim_982341",
  "received_at": "2026-11-25T12:00:08.500Z",
  "provider": "mock-rail-eu",
  "status": "processed"
}
```

#### 3. Processing failure
If the cooperative callback fails or throws an unhandled error:
```json
{
  "error": "webhook_error",
  "message": "Webhook processing failed",
  "event_id": "evt_sim_982341",
  "provider": "mock-rail-eu"
}
```

#### 4. Invalid provider identifier
If the provider name contains invalid characters:
```json
{
  "error": "invalid_request",
  "message": "Invalid provider identifier"
}
```

#### 5. Webhooks disabled
When `operational.webhooksEnabled: false`:
```json
{
  "error": "webhooks_disabled",
  "message": "Webhook endpoint is disabled"
}
```

---

## Safe troubleshooting runbook

All examples below use safe, fictional identifiers and placeholders:
- Primary rail: `mock-rail-eu`
- Secondary rail: `mock-pay-ng`
- Event ID: `evt_sim_982341`
- Signing secret: `<configured-webhook-secret>`

### Example 1: Verifying duplicate delivery handling

Simulate an initial delivery followed by a re-delivery from the same provider.

1. **Calculate the HMAC signature for the payload**:
   ```bash
   WEBHOOK_SECRET="<configured-webhook-secret>"
   BODY='{"id":"evt_sim_982341","provider":"mock-rail-eu","type":"deposit.settled","amount":"100.00"}'
   SIGNATURE=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex | awk '{print $NF}')
   ```

2. **Send initial delivery**:
   ```bash
   curl -s -X POST "http://localhost:3000/anchor/webhooks/events" \
     -H "Content-Type: application/json" \
     -H "x-webhook-provider: mock-rail-eu" \
     -H "x-anchor-signature: ${SIGNATURE}" \
     -d "${BODY}"
   ```
   *Expected response:*
   ```json
   {
     "received": true,
     "duplicate": false,
     "event_id": "evt_sim_982341",
     "received_at": "2026-11-25T12:00:00.000Z",
     "provider": "mock-rail-eu"
   }
   ```

3. **Send the identical duplicate request**:
   ```bash
   curl -s -X POST "http://localhost:3000/anchor/webhooks/events" \
     -H "Content-Type: application/json" \
     -H "x-webhook-provider: mock-rail-eu" \
     -H "x-anchor-signature: ${SIGNATURE}" \
     -d "${BODY}"
   ```
   *Expected response:*
   ```json
   {
     "received": true,
     "duplicate": true,
     "event_id": "evt_sim_982341",
     "received_at": "2026-11-25T12:00:05.120Z",
     "provider": "mock-rail-eu",
     "status": "processed"
   }
   ```
   *Verification:*
   - HTTP response code is `200`.
   - `"duplicate": true` confirms the re-delivery was recognized.
   - The registered `onEvent` callback was **not** invoked a second time.

---

### Example 2: Cross-provider identical event ID validation

Demonstrate that when a different provider sends an event with the exact same `event_id`, it is accepted and processed independently.

1. **Prepare payload for the second provider (`mock-pay-ng`)**:
   ```bash
   BODY_B='{"id":"evt_sim_982341","provider":"mock-pay-ng","type":"charge.successful","amount":"50.00"}'
   SIGNATURE_B=$(printf '%s' "${BODY_B}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex | awk '{print $NF}')
   ```

2. **Send delivery for second provider**:
   ```bash
   curl -s -X POST "http://localhost:3000/anchor/webhooks/events" \
     -H "Content-Type: application/json" \
     -H "x-webhook-provider: mock-pay-ng" \
     -H "x-anchor-signature: ${SIGNATURE_B}" \
     -d "${BODY_B}"
   ```
   *Expected response:*
   ```json
   {
     "received": true,
     "duplicate": false,
     "event_id": "evt_sim_982341",
     "received_at": "2026-11-25T12:01:00.000Z",
     "provider": "mock-pay-ng"
   }
   ```
   *Verification:*
   - The request succeeds with `"duplicate": false`.
   - The operation is registered under `mock-pay-ng:evt_sim_982341`, completely isolated from `mock-rail-eu:evt_sim_982341`.

---

### Example 3: Database inspection queries

When investigating delivery state or diagnosing hung webhooks, run safe read-only queries against the database.

#### Check event lifecycle status and lease state (PostgreSQL)
```sql
SELECT 
    id,
    event_id,
    provider,
    operation_key,
    status,
    attempt_number,
    lease_owner,
    lease_expires_at,
    error_message,
    created_at,
    processed_at
FROM webhook_events 
WHERE provider = 'mock-rail-eu' AND event_id = 'evt_sim_982341';
```

#### Identify hung or expired webhook leases
```sql
-- Events stuck in 'pending' whose processing lease has expired
SELECT 
    id, 
    provider, 
    event_id, 
    attempt_number, 
    lease_owner, 
    lease_expires_at 
FROM webhook_events 
WHERE status = 'pending' 
  AND lease_expires_at < NOW()
ORDER BY created_at ASC 
LIMIT 20;
```

#### Check retry history for failed events
```sql
SELECT 
    id, 
    provider, 
    event_id, 
    status, 
    attempt_number, 
    error_message, 
    created_at 
FROM webhook_events 
WHERE status IN ('failed', 'unresolved')
ORDER BY created_at DESC 
LIMIT 20;
```

---

## Operational best practices

1. **Idempotent callback implementations**:
   While Anchor Kit's lease lock prevents simultaneous executions, applications implementing `webhooks.onEvent` should ensure their downstream state changes (e.g. database updates, Stellar asset distributions) are also idempotent.

2. **Appropriate callback timeouts**:
   Keep `webhooks.callbackTimeoutMs` within 10,000–30,000 ms. If external calls inside `onEvent` exceed the lease duration (60,000 ms), another worker could acquire the expired lease, causing `CALLBACK_LOCK_LOST_MESSAGE`.

3. **Signature secret protection**:
   Never log raw signatures, authorization headers, or decrypted payload secrets. Refer to [Rotating Webhook Signing Secrets](./webhook-secret-rotation.md) when updating rail credentials.
