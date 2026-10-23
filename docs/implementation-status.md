# Implementation Status

The current product scope and runtime decisions are defined in [`anchor-kit-trd.md`](../anchor-kit-trd.md). This document records implementation status; planning material elsewhere in the repository does not imply that planned behavior is shipped.

**For a comprehensive configuration reference with implementation status and usage guidance, see [Configuration Reference](configuration-reference.md).**

## Implemented Now (Foundation)

- Factory and core instance lifecycle: `createAnchor`, `AnchorInstance`, and plugin registration/initialization.
- Configuration validation and public error/type surfaces.
- Express-compatible routes for the current minimal SEP-10 and SEP-24 deposit flows; the SDK does not own the HTTP server.
- Built-in raw SQL adapter for SQLite and PostgreSQL, including migrations and persistence for the current runtime records.
- Webhook signature verification, persistence/deduplication, in-process queue, and watcher lifecycle.
- Utility layer: validation, decimal math, cryptographic helpers, idempotency utilities, and Stellar helpers.

## Implemented Now (Runtime)

- SQL persistence through the `DatabaseAdapter` interface, with SQLite support for local development and tests and PostgreSQL support through the configured SQL client.
- Express HTTP routes cover health/info, standard and legacy SEP-10 authentication, interactive-deposit requests, transaction lookup, and webhook intake. Request limits, rate limiting, and request-deadline abort signals apply to runtime routes and deposit hooks. These handlers do not establish complete SEP wire-protocol conformance.
- Webhook processing supports optional signature verification, provider-scoped event deduplication, persistence, callback dispatch, failure status updates, and an unresolved status for timed-out callbacks.
- Configured SEP-10 client-domain signatures are verified before token issuance, and the client domain is included in the token claim.
- In-memory queue adapter for bounded background work and graceful shutdown.
- SQL-backed settlement job records with stable operation identity and reconnect-safe pending state.
- Transaction watcher lifecycle for polling pending transactions, persisting watcher tasks, and dispatching work through the queue.
- Plugin route registration and active deposit-request, SEP-10 challenge, and transaction-status hooks. The withdrawal-request hook is typed but is not invoked.
- Typed KYC verification contract and deterministic in-memory mock provider for local development and tests. Customer persistence is available; asset-policy enforcement is not connected.
- SEP-10 signer-weight verification primitive; account signer lookup and endpoint integration remain separate work.
- Provider-neutral payment rail adapter contract for initiation, event verification, status lookup, and recovery. No provider implementation is bundled.

## Protocol Conformance (Not Yet Implemented)

- Complete protocol engines and conformance for SEP-6, SEP-12, SEP-24 deposit/withdrawal flows, SEP-31, and SEP-38. Existing HTTP routes, SEP-10 primitives, and protocol-related types provide partial foundation support, not complete protocol implementations.
- Provider adapters for rails, remote signing, KYC, and rates. A local Stellar Keypair signer is implemented.
- Protocol transaction state machines and provider integrations.

- Full SEP-6, SEP-24, SEP-31, and SEP-38 protocol flows; withdrawals.
- Node.js, Hono, Fastify, and Deno support.
- Public custom database/queue/signer/KYC/rail adapter extension points.
- Enterprise signing, live KYC providers, and production rail/provider integrations.
- A runtime transaction state machine beyond the exported initial deposit transition contract.

- Runtime protocol engines and provider integrations listed above remain deferred while foundation APIs and typing guarantees stabilize.
- Directories under `src/core/sep6`, `src/core/sep24`, and `src/core/sep31` are reserved for future protocol engines; their presence does not indicate runtime conformance.
- Queue, watcher, and webhook orchestration already runs under `src/runtime`; `src/services` is reserved for future higher-level and provider-specific services.

## Drift Matrix

Focused documentation check: `bun test tests/readme-protocol-status.test.ts`. It must pass the assertions distinguishing the shared HTTP/plugin foundation from complete SEP protocol engines.

| Area                         | Status          | Classification | Source Expectation                                                  | Current Code State                                                                      | Action Taken                                                                              |
| ---------------------------- | --------------- | -------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Root SDK API                 | Partial         | Digression     | Unified docs center API on `createAnchor` factory                   | Root package entrypoint exported only types before cleanup                              | Exported `createAnchor` and `AnchorInstance` from root entrypoints                        |
| Error naming                 | Mismatch        | Digression     | Foundation error is `ConfigError` in implementation                 | Tests still imported `ConfigurationError`                                               | Removed stale `ConfigurationError` references and aligned tests to `ConfigError`          |
| Transaction error typing     | Conflicting     | Duplicate      | SEP-24 `TransactionNotFoundError` discriminator type is `not_found` | Duplicate `TransactionNotFoundError` existed in `foundation.ts` with incompatible shape | Removed conflicting foundation duplicate; SEP-24 type is authoritative                    |
| Plugin/foundation interfaces | Weakly typed    | Digression     | Unified docs emphasize strong type safety                           | Multiple interfaces used explicit `any`                                                 | Replaced `any` with `unknown`/typed records and generic plugin context                    |
| Type-safety enforcement      | Incomplete      | Gap            | Strong type guarantees and compile-time safety                      | `no-explicit-any` was warning only; `typecheck` did not include lint gate               | `no-explicit-any` set to error and `typecheck` now runs `tsc` + `eslint --max-warnings 0` |
| Docs vs implementation       | Overstated      | Digression     | Unified docs include planned protocol/adapter architecture          | README/Architecture implied protocol modules already available                          | Updated docs to separate implemented foundation/runtime from planned modules              |
| Placeholder modules          | Expected future | Gap            | Unified docs define future protocol/service modules                 | Placeholder directories existed without guidance                                        | Added explicit stub READMEs describing planned status                                     |

## Notes on Supporting Docs

- `anchor-kit-unified.md` is treated as the canonical technical target.
- `anchor-kit-trd.md`, `anchor-kit SDK Plan.md`, and `anchor-kit-plan.md` remain useful design/roadmap references, but may describe features ahead of current implementation.
