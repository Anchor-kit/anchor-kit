## What does this PR do?

This PR operationalizes the production-readiness roadmap gate into a comprehensive review checklist for maintainers (#816).

- Adds the `Production readiness review checklist` to `ROADMAP.md`, replacing the informal single-sentence gate with an operational, five-area assessment.
- Requires explicit assessments and direct links to evidence across:
  - **Protocol interoperability**: SEP-6/24/31/38 deferred status, interactive session gate validation, and wallet interoperability.
  - **Settlement**: on-chain testnet confirmation, payment XDR validation, recipient trustline readiness, and sequence lease migrations.
  - **Security review**: distribution key isolation, webhook secret rotation, JWT lifetime enforcement, trusted reverse proxy configurations, and security configuration reference.
  - **Recovery**: atomic idempotency reservation recovery, PostgreSQL backup/restore rehearsals, queue retry budgets, webhook operation reconciliation, and worker restart status.
  - **Release evidence**: release preflight, trusted OIDC publishing, repository guard checks, and clean-consumer package import smoke tests.
- Keeps every item as an open, explicit assessment without declaring the project production ready.
- Adds test coverage in `tests/production-readiness-checklist.test.ts` to assert section headers, evidence links, relative path validity on disk, and explicit open assessment phrasing.
- Updates documentation acceptance checks in `scripts/check-doc-acceptance.mjs`, `docs/issue-acceptance-checks.md`, and `docs/acceptance-checks.md`.

## How to test?

- Run `bun test tests/production-readiness-checklist.test.ts` (all 4 assertions pass).
- Run `node scripts/check-doc-acceptance.mjs` (passes with exit code 0).
- Run `bun test` (all tests pass).
- Run `bun run typecheck`, `bun run lint`, `bun run format:check`, and `bun run build` (all pass).

## Checklist

- [x] My code follows the code style of this project.
- [x] I have added tests for my changes.
- [x] I have updated the documentation for my changes.
- [x] I have run `bun test` locally.
- [x] I have run `bun run lint` locally.

## Issue Reference

Closes #816
