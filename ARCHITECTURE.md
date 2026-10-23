# Architecture overview

Anchor-Kit currently ships a TypeScript SDK foundation and a small
Express-compatible runtime. It is not yet a hosted fiat-to-Stellar settlement
engine. This document describes the code that runs today separately from the
intended end-to-end payment path.

## Implemented modules

- `src/core/`: `createAnchor()`, `AnchorInstance`, immutable configuration and
  runtime validation, lifecycle management, plugin registration, and errors.
- `src/types/`: public configuration, transaction, plugin, and runtime
  contracts.
- `src/utils/`: validation, decimal arithmetic, cryptographic helpers,
  idempotency, and Stellar helpers.
- `src/runtime/database/`: SQL database adapter and migrations.
- `src/runtime/http/`: Express-compatible route middleware, request validation,
  CORS handling, and in-memory rate limiting.
- `src/runtime/webhooks/`: signature validation, event deduplication and
  persistence, callback dispatch, and processed/failed event status.
- `src/runtime/queue/`: bounded-concurrency in-memory queue.
- `src/runtime/watchers/`: transaction timeout polling, watcher task recording,
  queue dispatch, and record cleanup.

The host owns the HTTP server. It creates and initializes the instance, starts
background jobs when needed, and mounts the middleware:

```ts
const anchor = createAnchor(config);
await anchor.init();
await anchor.startBackgroundJobs();
app.use('/anchor', anchor.getExpressRouter());
```

## Current request path

1. The host mounts the Express-compatible middleware in its own server.
2. A SEP-10 challenge is validated and exchanged for a bearer token.
3. An authorized interactive deposit request creates a deposit record and returns
   its interactive URL.
4. Webhook processing verifies and stores provider events before invoking the
   host callback.
5. The queue and watcher handle expiry checks and record cleanup.

Settlement is not implemented end to end. The current runtime does not submit a Stellar payment
or advance a deposit through a rail settlement flow. A webhook
callback or queued job alone does not prove that settlement occurred.

## SEP-10 Challenge Consumption & Recovery Policy

- **Atomicity**: SEP-10 challenges are strictly one-time credentials. `markAuthChallengeConsumed` uses an atomic SQL query (`UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`) to ensure that under concurrent token exchange requests for the same challenge, at most one consumer successfully marks the challenge consumed and receives an access token. All other concurrent requests receive HTTP 401 (`invalid_challenge`, message `Challenge already used`).
- **Persistence Failure Recovery**: If the database fails to record the challenge consumption (e.g. storage error during `markAuthChallengeConsumed`), token issuance is aborted immediately and an HTTP 500 (`server_error`) response is returned with no token issued. Because consumption was not persisted in storage, the challenge remains unconsumed, allowing the user/client to safely retry the token exchange request.
