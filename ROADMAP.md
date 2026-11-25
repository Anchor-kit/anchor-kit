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
- **Production readiness:** next gate is completing the [Production readiness review checklist](#production-readiness-review-checklist) with experienced-maintainer reviews and comprehensive protocol-level test evidence; API freeze follows those reviews.

## Production readiness review checklist

This operational checklist turns the roadmap's production-readiness gate into an explicit review procedure for maintainers. Production readiness is not a single milestone or self-declaration; each area requires verifiable evidence and documented sign-off.

Maintainers must leave each item as an explicit assessment; do not declare the project production ready until all acceptance gates, security reviews, and operational evidence are completely satisfied.

- [ ] **Protocol interoperability assessment**
  - **Review criterion:** verify full wire-protocol conformance, wallet integration, and interactive session lifecycles against official Stellar Ecosystem Proposals (SEPs).
  - **Required evidence links:**
    - [Protocol Conformance Status](./docs/implementation-status.md#protocol-conformance-not-yet-implemented) – Deferred protocol engines and boundary documentation.
    - [Acceptance Gate 2: Interoperable Deposit](#next-acceptance-gates) – Documented wallet/anchor flow requirements and open issue [#742](https://github.com/Anchor-kit/anchor-kit/issues/742).
    - [Interactive Session Gate](./docs/acceptance-checks.md#interactive-session-validation-and-revocation-718) – Session validation, expiry, and single-use action verification ([`tests/runtime/interactive-session-revocation.test.ts`](./tests/runtime/interactive-session-revocation.test.ts)).
    - [Interactive Session State](./docs/interactive-completion-status.md) – Scoped interactive session-state endpoint and CORS preflight verification.
  - **Maintainer assessment:** Open / Unverified. Complete protocol engines for SEP-6, SEP-24 deposit/withdrawal, SEP-31, and SEP-38 remain deferred; existing endpoints provide shared HTTP runtime primitives only. Do not declare production ready.

- [ ] **Settlement assessment**
  - **Review criterion:** demonstrate end-to-end on-chain settlement on Stellar testnet, transaction hash capture, balance reconciliation, atomic sequence leasing, and payment failure handling.
  - **Required evidence links:**
    - [Testnet Deposit and Settlement Evidence](./docs/testnet-deposit-evidence.md) – Requirements for confirmed Stellar transaction hash, recipient balance checks, and idempotent replay.
    - [Acceptance Gate 3: Testnet Settlement](#next-acceptance-gates) – Funded Stellar testnet settlement criteria and open issue [#756](https://github.com/Anchor-kit/anchor-kit/issues/756).
    - [Settlement Identity and Payment XDR](./docs/issue-acceptance-checks.md) – Envelope hashing and payment XDR validation ([`tests/utils/stellar.test.ts`](./tests/utils/stellar.test.ts), [`tests/services/settlement-identity.test.ts`](./tests/services/settlement-identity.test.ts)).
    - [Recipient Trustline Readiness](./src/runtime/settlement/recipient-readiness.ts) – Recipient account and trustline status evaluation ([`tests/recipient-readiness.test.ts`](./tests/recipient-readiness.test.ts)).
    - [Sequence Lease Database Migrations](./docs/database-migrations.md) – Migrations `core:004-settlement-job-leases`, `core:007-stellar-sequence-leases`, and `core:008-stellar-sequence-operations`.
  - **Maintainer assessment:** Open / Unverified. Confirmed testnet transactions, durable payout worker loops, and automated settlement reconciliation are not yet demonstrated. Do not declare production ready.

- [ ] **Security review assessment**
  - **Review criterion:** conduct formal security audits covering secret isolation, distribution keys, cryptographic verification, token expiration, trusted proxies, and rate limiting.
  - **Required evidence links:**
    - [Local Signer Secrets Guidance](./docs/local-signer-secrets.md) – Distribution account key isolation and container security controls.
    - [Webhook Secret Rotation](./docs/webhook-secret-rotation.md) – HMAC-SHA256 signature verification and secret rotation mechanics.
    - [Auth Token Lifetime Response](./docs/auth-token-response.md) – Numeric and jose JWT lifetime rules and bearer token verification.
    - [Trusted Proxy Rate-Limit Guidance](./docs/trusted-proxy-rate-limits.md) – Rate limiter IP resolution and reverse proxy spoofing safeguards.
    - [Security Configuration Reference](./docs/configuration-reference.md#security-configuration) – Formal reference for auth and secret key requirements.
  - **Maintainer assessment:** Open / Unverified. Cryptographic and authentication primitives pass unit checks, but a comprehensive experienced-maintainer security audit and independent review have not been completed. Do not declare production ready.

- [ ] **Recovery assessment**
  - **Review criterion:** test and document crash recovery, process restart resilience, idempotency reservation recovery, database backup/restore rehearsals, queue retry budgets, and webhook reconciliation.
  - **Required evidence links:**
    - [Idempotency Reservation Recovery](./docs/idempotency-reservation-recovery.md) – Atomic reservation recovery contract and concurrent reclaimer behavior.
    - [PostgreSQL Backup and Restore Rehearsal](./docs/postgres-backup-restore.md) – Rehearsal procedure for database backup, logical dump, and clean restore.
    - [Queue Retries and Failure Handling](./docs/queue-retries.md) – Transient retry budgets, exponential backoff, and dead-letter queue records.
    - [Webhook Operation Recovery](./docs/issue-acceptance-checks.md) – Operation recovery without repeating transfers ([`tests/runtime/webhooks/operation-recovery.integration.test.ts`](./tests/runtime/webhooks/operation-recovery.integration.test.ts)).
    - [Database Migration Safety](./docs/database-migrations.md) – Schema rollback recovery and repeatable migration execution.
    - [Worker Restart and Deployment Status](./docs/bun-deployment-status.md) – In-memory queue limitations and durable-worker restart status.
  - **Maintainer assessment:** Open / Unverified. Database adapters support atomic leases and recovery queries, but multi-worker failover and crash recovery under high concurrency have not been proven in production deployment. Do not declare production ready.

- [ ] **Release evidence assessment**
  - **Review criterion:** enforce reproducible packaging, provenance, trusted OIDC publishing, environment approvals, and clean-consumer package import smoke tests.
  - **Required evidence links:**
    - [Release Preflight Guide](./docs/releasing.md) – Trusted Publisher OIDC configuration, GitHub environment protections, and release workflow verification.
    - [Publish Workflow Guard Tests](./tests/publish-workflow.test.ts) – Assertions ensuring publish triggers only for official repository releases.
    - [Clean Package Consumer Verification](./scripts/check-package-consumer.mjs) – Isolated consumer fixture installing packed tarball.
    - [Package Smoke Test](./scripts/check-package-smoke.mjs) – Clean import, initialization, and shutdown using public package exports.
    - [Package Contents Validation](./scripts/check-pack-contents.mjs) – Tarball contents verification against public files list.
    - [Documentation Acceptance Checks](./scripts/check-doc-acceptance.mjs) – Verification of release and roadmap acceptance criteria.
  - **Maintainer assessment:** Open / Unverified. Packaging smoke tests and workflow guards pass locally and in CI, but production package releases remain blocked until all operational prerequisite gates pass. Do not declare production ready.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the implemented request path and
the boundary between current runtime behavior and the intended product path.
