# Rotating webhook signing secrets

When `security.verifyWebhookSignatures` is enabled, Anchor Kit verifies each
incoming delivery with HMAC-SHA256 over the raw request body using
`security.webhookSecret`. The adapter accepts one configured secret. After a
secret change is deployed, deliveries signed with the previous value fail
verification until the provider signs with the new value.

## Rotation procedure

1. Check the provider's webhook settings and confirm whether it supports two
   active signing secrets or a coordinated change window.
2. Generate a new secret using the approved secret manager. Do not place the
   value in a shell command, ticket, source file, or log.
3. Coordinate the provider change with deployment of the new
   `WEBHOOK_SECRET` configuration. If the provider cannot overlap keys, expect
   deliveries during the transition to fail signature verification.
4. Send a test delivery and confirm it is accepted. Ask the provider to retry
   failed events after the change; check the provider's delivery dashboard for
   retry status.
5. Remove the old secret from the provider and secret manager according to
   your rotation policy.

Use placeholders such as `<webhook-secret>` in runbooks. For failed deliveries,
check the HTTP response, application error category (missing signature or
invalid signature), provider delivery timestamp, and retry state. Compare
configuration version identifiers and deployment timestamps. Never log or
paste secret values, request signatures, or full credential-bearing headers
while investigating.
