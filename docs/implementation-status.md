# Implementation Status

The current product scope and runtime decisions are defined in [`anchor-kit-trd.md`](../anchor-kit-trd.md). This document records implementation status; planning material elsewhere in the repository does not imply that planned behavior is shipped.

## Implemented Now (Partial MVP)

- Factory and core instance lifecycle: `createAnchor`, `AnchorInstance`, and plugin registration/initialization.
- Configuration validation and public error/type surfaces.
- Express-compatible routes for the current minimal SEP-10 and SEP-24 deposit flows; the SDK does not own the HTTP server.
- Built-in raw SQL adapter for SQLite and PostgreSQL, including migrations and persistence for the current runtime records.
- Webhook signature verification, persistence/deduplication, in-process queue, and watcher lifecycle.
- Utility layer: validation, decimal math, cryptographic helpers, idempotency utilities, and Stellar helpers.

These are partial implementations, not complete SEP compliance or production-ready provider integrations. The SQLite adapter's `bun:sqlite` dependency makes Bun the supported runtime.

## Planned (Not Yet Implemented)

- Full SEP-6, SEP-24, SEP-31, and SEP-38 protocol flows; withdrawals.
- Node.js, Hono, Fastify, and Deno support.
- Public custom database/queue/signer/KYC/rail adapter extension points.
- Enterprise signing, live KYC providers, and production rail/provider integrations.
- A runtime transaction state machine beyond the exported initial deposit transition contract.

## Milestone Gates

| Gate | Evidence | Focused command | Expected result |
| --- | --- | --- | --- |
| Public scope is tracked and planned work is labeled | This document and [`anchor-kit-trd.md`](../anchor-kit-trd.md) | Review those tracked files in a fresh clone | Current runtime decisions, milestones, and deferred backlog are explicit |
| Plugin hooks and first-deposit transitions are typed | Compile-time fixtures and status graph tests | `bun test tests/types/transaction-status.test.ts tests/types/plugin.test.ts` | Tests pass; invalid fields/statuses are compile-time errors |
| PostgreSQL adapter is exercised in CI | Required PostgreSQL service and integration test | `bun test tests/runtime/postgres-adapter.integration.test.ts` | Connects, migrates, and passes persistence/concurrent deduplication assertions |
| Type safety/lint gate | Repository typecheck script | `bun run typecheck` | TypeScript and ESLint pass |
