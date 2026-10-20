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

The consumer creates and initializes the instance, starts background jobs when
needed, and mounts the middleware into its own server:

```ts
const anchor = createAnchor(config);
await anchor.init();
await anchor.startBackgroundJobs();
app.use('/anchor', anchor.getExpressRouter());
```

## Data Flow (SEP-24 Example)

1.  **Wallet** initiates auth (SEP-10).
2.  **Anchor-Kit** verifies signature and issues JWT.
3.  **Wallet** requests deposit (SEP-24).
4.  **Anchor-Kit** creates transaction record (status: `incomplete`) and returns interactive URL.
5.  **User** completes KYC/Payment on the interactive page.
6.  **Anchor-Kit** receives Webhook from Payment Rail (e.g., Flutterwave).
7.  **Anchor-Kit** validates webhook, updates status to `pending_user_transfer_start`.
8.  **Job Queue** picks up job, sends Stellar Asset to user.
9.  **Anchor-Kit** updates status to `completed`.

## SEP-10 Challenge Consumption & Recovery Policy

- **Atomicity**: SEP-10 challenges are strictly one-time credentials. `markAuthChallengeConsumed` uses an atomic SQL query (`UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`) to ensure that under concurrent token exchange requests for the same challenge, at most one consumer successfully marks the challenge consumed and receives an access token. All other concurrent requests receive HTTP 401 (`invalid_challenge`, message `Challenge already used`).
- **Persistence Failure Recovery**: If the database fails to record the challenge consumption (e.g. storage error during `markAuthChallengeConsumed`), token issuance is aborted immediately and an HTTP 500 (`server_error`) response is returned with no token issued. Because consumption was not persisted in storage, the challenge remains unconsumed, allowing the user/client to safely retry the token exchange request.
