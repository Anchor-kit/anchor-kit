# Implementation Status (Canonical: `anchor-kit-unified.md`)

This file tracks where the codebase currently aligns or diverges from the canonical spec (`anchor-kit-unified.md`) and supporting planning docs (`anchor-kit-trd.md`, `anchor-kit SDK Plan.md`, `anchor-kit-plan.md`).

## Implemented Now (Foundation)

- Factory and core instance lifecycle: `createAnchor`, `AnchorInstance`.
- Configuration model and runtime validation: `AnchorConfig` + `AnchorKitConfig`.
- Error hierarchy: `AnchorKitError`, `ConfigError`, `ValidationError`, `SepProtocolError`, `TransactionStateError`, `RailError`, `NetworkError`, `CryptoError`.
- Public type surface for config, transaction states, customer/KYC primitives, and SEP-24 transaction response types.
- Utility layer: validation, decimal math, cryptographic helpers, idempotency helper, Stellar helper functions.

## Implemented Now (Runtime)

- SQL persistence through the `DatabaseAdapter` interface, with SQLite support for local development and tests and PostgreSQL support through the configured SQL client.
- Express HTTP adapter for health, info, authentication, transaction, and webhook routes, including request limits and rate limiting.
- Webhook processing with optional signature verification, event deduplication, persistence, callback dispatch, and failure status updates.
- In-memory queue adapter for bounded background work and graceful shutdown.
- Transaction watcher lifecycle for polling pending transactions, persisting watcher tasks, and dispatching work through the queue.

## Planned Per Unified Spec (Not Yet Implemented)

- Protocol modules: SEP-10, SEP-12, SEP-6, SEP-24 runtime flows, SEP-31, SEP-38.
- Adapter implementations: rail adapters, signer adapters, KYC provider adapters, and rate adapters.
- Protocol transaction state-machine runtime and provider integrations.

## Intentionally Deferred

- Runtime protocol engines and provider integrations listed above remain deferred while foundation APIs and typing guarantees stabilize.
- Empty module directories under `src/core/sep6`, `src/core/sep24`, and `src/core/sep31` are placeholders for the deferred protocol flows.
- `src/services` contains the implemented queue and watcher orchestration; future provider-specific services remain deferred.

## Drift Matrix

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
