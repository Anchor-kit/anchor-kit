# Product roadmap and acceptance gates

This roadmap distinguishes shipped infrastructure from product behavior that
still needs an installable consumer and end-to-end evidence. A checked item below
names the command and artifact that reproduce its evidence; a checked
infrastructure item does not imply a complete hosted money-transfer product.

## Completed infrastructure

- [x] **TypeScript SDK foundation** — factory, configuration validation, types,
      and package entry points. Evidence: `bun run build`; package entrypoint
      coverage: `bun test tests/exports.test.ts`.
- [x] **HTTP/runtime foundation** — Express-compatible routes, SQL-backed
      records, webhook processing, in-memory queue and transaction watcher.
      Evidence: `bun test tests/mvp-express.integration.test.ts` and
      `bun test tests/runtime`.
- [x] **SEP-10 challenge and token path** — challenge creation, signature
      verification, one-time challenge consumption, and bearer token issuance.
      Evidence: `bun test tests/mvp-express.integration.test.ts` (challenge-to-token
      and rejection cases).
- [x] **Interactive deposit record path** — authenticated deposit request,
      asset/amount checks, idempotent database record, and interactive URL.
      Evidence: `bun test tests/mvp-express.integration.test.ts` (deposit creation
      and lookup cases). This does not prove rail collection or Stellar settlement.

## Next acceptance gates

These are open product gates, not completed milestones. Each gate must be
demonstrated by a reproducible fixture and documented consumer-facing result
before being marked complete.

1. **Installable SDK** — pack the built package, install that exact tarball in a
   clean consumer fixture, and demonstrate importing the documented public API
   and mounting the router. The fixture must fail if it imports from the source
   tree or relies on this repository's development dependencies. Until then,
   treat package-install readiness as unverified.
2. **Interoperable deposit** — exercise a documented wallet/anchor flow against
   the published protocol contract, including SEP-10, a durable deposit record,
   a host-provided interactive experience, and an explicit callback/provider
   contract. A mock that only calls internal routes is not sufficient evidence
   of interoperability.
3. **Testnet settlement** — use a funded Stellar testnet account and a
   reproducible provider/rail fixture to show that an accepted deposit reaches
   the intended on-chain recipient and that the persisted transaction status
   follows the observed settlement result. Include transaction hash and
   failure/retry behavior in the test evidence; do not mark this gate complete
   based only on a webhook or a queued job.

## Open and deferred work

- **Current deposit behavior:** the SDK creates and returns a database record;
  the anchor host owns its interactive page and `webhooks.onEvent` callback.
  Current webhook processing does not settle a rail payment or update that
  deposit through a protocol state machine.
- **Queue/watcher:** current jobs support transaction expiry, watcher records,
  and cleanup. A watcher job is not a payout or settlement worker.
- **Withdrawal, interoperable deposit, and testnet settlement:** deferred until
  the acceptance gates above have reproducible evidence.
- **Withdrawal:** next gate is to specify the interoperable withdrawal request,
  host/provider contract, and status transitions, then prove them with a
  provider sandbox fixture.
- **Provider rails, KYC/rate adapters, and SEP-6/SEP-31 runtimes:** next gate is
  to approve each wire contract against its current official protocol/provider
  documentation and add a conformance fixture before implementation.
- **Production readiness:** next gate is an experienced-maintainer security
  audit and comprehensive protocol-level test evidence; API freeze follows
  those reviews.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implemented request path and
the boundary between current runtime behavior and the intended product path.
