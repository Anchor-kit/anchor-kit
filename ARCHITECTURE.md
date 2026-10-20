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

The host owns the HTTP server, route prefix, interactive web application,
provider/rail integration, deployment, and lifecycle shutdown. See
[`example/express-app.ts`](./example/express-app.ts) for the runnable example.

## Current request and transaction path

1. **SEP-10 challenge:** `GET /auth/challenge?account=...` creates a challenge
   with server account as transaction source and the client account as
   `manageData` operation source. The operation name is the configured
   `server.homeDomain` followed by ` auth`. The challenge is signed by the
   anchor and stored for one-time use.
2. **SEP-10 token:** `POST /auth/token` verifies the anchor and client
   signatures, configured network, source account, home-domain operation name,
   expiry, and stored nonce before consuming the challenge and issuing a
   bearer JWT.
3. **Deposit record:** authenticated
   `POST /transactions/deposit/interactive` validates the configured asset and
   amount and creates an idempotent SQL record in
   `pending_user_transfer_start`. It returns a URL built from
   `server.interactiveDomain`; the SDK does not serve that page.
4. **Webhook:** `POST /webhooks/events` verifies the configured HMAC signature
   when enabled, persists and deduplicates the provider event, invokes the
   host's `webhooks.onEvent` callback, and marks the webhook event processed or
   failed. This callback is not automatically connected to the deposit record
   or a rail settlement.
5. **Queue and watcher:** when background jobs are started, the watcher polls
   overdue pending records and enqueues expiry, watcher-task, and cleanup jobs.
   Queue processing does not submit a Stellar payment or complete a deposit
   settlement.

The transaction lookup route reads the stored record; it does not imply that a
payment has settled. A verified webhook, a queued job, or a returned
`pending_user_transfer_start` record is not evidence of a completed on-chain
transfer.

## Intended product path (not implemented end to end)

The following is a target boundary, not a description of current runtime
behavior:

1. Wallet authenticates using SEP-10.
2. Anchor creates a deposit and an interoperable interactive-flow response.
3. Host's interactive experience collects user and provider requirements.
4. A payment rail/provider collects fiat and reports its result.
5. Anchor correlates and validates provider events with the deposit record.
6. The settlement worker submits the configured Stellar asset transfer.
7. The anchor verifies the on-chain result.
8. The transaction state machine persists the protocol status and settlement
   reference.
9. Wallet/consumer can query the interoperable final status.

The rail/provider contract, state-machine transitions, settlement submission,
and final status updates are planned boundaries. They are not supplied by the
current webhook callback or queue implementation.

## Reproducible evidence

- Runtime integration behavior: `bun test tests/mvp-express.integration.test.ts`
- Focused documentation acceptance: `node scripts/check-doc-acceptance.mjs`

Both commands run from the repository root. Passing the integration tests
demonstrates the currently implemented route behavior, not the deferred
interoperability or settlement gates. See [`ROADMAP.md`](./ROADMAP.md) for the
next evidence required.
