## What does this PR do?

This PR enforces interactive session identity, expiry, revocation and single-use
completion at each state-changing interactive action (#718 / AK-062).

- Persists interactive session identity in `src/runtime/interfaces.ts` and
  `src/runtime/database/sql-database-adapter.ts`: an `interactive_sessions` record
  binding one account to one transaction, with its permitted actions, consumed
  actions, expiry and revocation, plus SQLite and PostgreSQL migrations and indexes.
- Adds `insertInteractiveSession`, `getInteractiveSessionById`,
  `revokeInteractiveSession` and `consumeInteractiveSessionAction` to `DatabaseAdapter`.
  Consumption is a compare-and-set, so a permitted action can be spent exactly once.
- Adds one shared validation gate used by every interactive endpoint, so expired,
  revoked, wrong-account and wrong-transaction sessions are rejected before any write.
- Adds `POST /transactions/:id/complete`, which validates the session and then consumes
  the permitted action once; replays and concurrent callers are rejected.
- Applies the same gate to `GET /transactions/:id` when a session is presented, while
  plain bearer reads keep working unchanged.

## How to test?

- Run `bun test` (926 tests pass across 73 files).
- Focused acceptance check:

  ```sh
  bun test tests/runtime/interactive-session-revocation.test.ts
  ```

  Expected result: all 8 assertions pass. Expired, revoked, wrong-account and
  wrong-transaction sessions are rejected by the shared gate before any write (the
  completion write helper is never invoked and no persisted row changes), completion
  consumes the permitted action exactly once under both a replay and a five-way
  concurrent race, and the transaction read endpoint applies the same gate while a
  plain bearer read keeps working.

- `bun run typecheck`, `bun run lint`, `bun run format:check` and `bun run build` all
  pass.

## Checklist

- [x] My code follows the code style of this project.
- [x] I have added tests for my changes.
- [x] I have updated the documentation for my changes.
- [x] I have run `bun run test` locally.
- [x] I have run `bun run lint` locally.

## Issue Reference

Closes #718
