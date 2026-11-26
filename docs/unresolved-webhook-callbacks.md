# Runbook: unresolved webhook callbacks

This runbook is for a webhook event whose callback timed out or whose external
payment-rail outcome could not be established. An `unresolved` record does not
mean that the provider operation failed: the callback may have completed after
the timeout, or the provider may have accepted the operation before the
application lost its lease.

## First, preserve the event identity

Collect the provider, `event_id`, HTTP response, and delivery timestamp. The
webhook route returns `event_id` in both successful and error responses. If the
incoming payload has no non-empty `id`, Anchor-Kit generates an ID, so the
`event_id` in the response is the authoritative value for investigation.

The stable operation key is:

```text
<provider>:<event_id>
```

Do not use a raw payload, signature, authorization header, or provider secret
as an incident identifier.

## Understand the recorded state

Read the event record before taking action. The supported database adapter
stores webhook records in `webhook_events`. Use a read-only query and bind the
provider and event ID as parameters; the following is a shape example, not a
command to paste with untrusted values:

```sql
SELECT
  id,
  event_id,
  provider,
  status,
  error_message,
  processed_at,
  created_at,
  attempt_number,
  attempt_id,
  lease_owner,
  lease_expires_at,
  operation_key,
  recovery_result
FROM webhook_events
WHERE provider = :provider AND event_id = :event_id;
```

Avoid selecting or copying `payload` into incident channels. If direct database
access is not part of the host's operational procedure, use the host's existing
read-only `DatabaseAdapter` access. This repository does not provide a public
event-inspection endpoint or an operator CLI for this investigation.

The statuses have these meanings:

| Status       | Meaning                                                                                                                                              | Safe interpretation                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pending`    | The event was persisted and is waiting for, or is in, its first leased attempt.                                                                      | The external outcome is not known.                                                                      |
| `processed`  | The callback completed and the lease owner recorded success, or recovery found a matching provider operation with status `succeeded`.                | The callback/recovery path completed successfully.                                                      |
| `failed`     | The callback failed without timing out, or recovery found a matching provider operation with status `failed`.                                        | The recorded attempt failed; check the provider record before deciding whether a new operation is safe. |
| `unresolved` | The callback timed out, recovery returned no usable answer, the lookup failed, the result did not match the event, or the processing lease was lost. | The external outcome is ambiguous. Do not assume failure.                                               |

`error_message` is intentionally generic. The normal values are
`Webhook callback timed out` and `Webhook callback failed`; the original
exception is not persisted by the default processor.

## Correlate the provider operation

If the host has configured `webhooks.recoverOperation`, it must perform a
read-only provider lookup using the operation key, provider, and event ID. A
usable result must be a `PaymentRailOperation` with:

- `operationId` exactly equal to the operation key;
- `provider` exactly equal to the event provider;
- a non-empty, bounded `reference`;
- a valid `amount` with non-empty `amount` and `currency` strings; and
- `status` equal to `pending`, `succeeded`, `failed`, or `unknown`.

The provider-specific `reference` or `providerReference` can help the provider
operations team locate the record, but it does not replace the exact
`operationId` and `provider` match required by the recovery path. A malformed,
mismatched, missing, or ambiguous provider result is treated as unresolved.

Use the provider dashboard or its documented read-only API to establish whether
the matching operation is `succeeded`, `failed`, or still unknown. The SDK does
not bundle a provider implementation, so provider-specific lookup commands and
credentials are intentionally not prescribed here.

## Recovery decision

1. If the provider record proves `succeeded`, run the host's existing supported
   recovery path. Recovery records the matching operation as `processed`; it
   does not invoke the webhook callback again or create a second transfer.
2. If the provider record proves `failed`, run the same supported recovery path
   so the event is recorded as `failed`.
3. If the provider has no matching record, the lookup cannot complete, or the
   result is `pending` or `unknown`, leave the event unresolved and coordinate
   with the service owner and provider operations team. Do not start a new
   money-moving operation solely because the callback timed out.

Recovery is lease-protected. Only one recovery attempt can own the event at a
time, and a stale owner cannot complete it after its lease has expired. Do not
run concurrent manual recovery attempts or update the status directly in the
database.

The public `POST /webhooks/events` route does not expose a `retry` control. A
normal duplicate delivery returns the stored record and does not automatically
perform recovery. Use a host-level recovery trigger only if that trigger is
already documented and supported by the deployment. If no such trigger exists,
escalate rather than inventing an endpoint or replaying the callback by hand.

## Logging and escalation

Log only operational identifiers and state transitions. For example:

```text
webhook recovery requested provider=example-provider event_id=evt_example_123 operation_key=example-provider:evt_example_123 status=unresolved attempt_count=2
webhook recovery result provider=example-provider event_id=evt_example_123 status=processed
```

Include the provider, event ID, operation key, status, attempt count, and the
relevant timestamps (`created_at`, `processed_at`, and `lease_expires_at`) in an
escalation. Do not include raw payloads, signatures, authorization headers,
provider secrets, customer details, or copied credential material.

Escalate when the provider cannot establish a definitive outcome, the host has
no supported recovery trigger, or the operation appears to have succeeded but
the event remains unresolved. Include the provider-side reference only through
an approved incident channel.
