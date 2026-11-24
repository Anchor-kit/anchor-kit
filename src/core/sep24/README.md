# SEP-24 Module (Reserved)

This directory is reserved for a future SEP-24 protocol engine. A complete SEP-24-compliant interactive deposit and withdrawal flow is not implemented here.

The shared HTTP runtime currently provides an SDK-specific `POST /transactions/deposit/interactive` request path and `GET /transactions/{id}` lookup, along with persistence and plugin hooks. These endpoints are foundation infrastructure, not evidence of complete SEP-24 wire-protocol conformance. Check the current official SEP-24 specification before relying on wire behavior.

`createInteractiveInitiationResponse({ id, url })` formats a transaction ID and a
host-provided HTTPS URL as the SEP-24 initiation response. The host must create and
validate a scoped interactive session and serve the URL; the adapter cannot verify
that either exists. The SDK's existing custom endpoint and `interactive_url`
response remain unchanged. The SDK does not yet expose this response from its HTTP
runtime.

Run `bun test tests/sep24-interactive-response.test.ts`; all assertions should pass.
