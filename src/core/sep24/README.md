# SEP-24 Module (Reserved)

This directory is reserved for a future SEP-24 protocol engine. A complete SEP-24-compliant interactive deposit and withdrawal flow is not implemented here.

The shared HTTP runtime currently provides an SDK-specific `POST /transactions/deposit/interactive` request path and `GET /transactions/{id}` lookup, along with persistence and plugin hooks. These endpoints are foundation infrastructure, not evidence of complete SEP-24 wire-protocol conformance. Check the current official SEP-24 specification before relying on wire behavior.

Form-encoded `POST /transactions/deposit/interactive` requests return the SEP-24
`type`, `url`, and `id` fields with HTTP 200. The URL points to
`server.interactiveDomain/deposit/{id}` and includes a five-minute session token.
The app hosting `interactiveDomain` must serve that path and verify the token with
`utils.verifyInteractiveSession(token, secret, id, 'deposit')`.

JSON requests keep the SDK's custom response, including `interactive_url`.
`createInteractiveInitiationResponse({ id, url })` validates and formats a
host-provided HTTPS URL as the SEP-24 response.

Run `bun test tests/sep24-interactive-response.test.ts`; all assertions should pass.
