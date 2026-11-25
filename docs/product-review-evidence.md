# Product review evidence

Review date: 2026-11-25. This review checks the implementation and acceptance gates recorded in `ROADMAP.md` and `docs/implementation-status.md`. Closing an implementation issue is not evidence that the complete anchor product path is available.

## Executed checks

| Check                                                                                                                                                            | Result                 | What it establishes                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check:consumer`                                                                                                                                         | Passed after the build | The packed SDK installs in a clean consumer and imports `createAnchor` and its public types through package exports.             |
| `bun test tests/mvp-express.integration.test.ts`                                                                                                                 | 128 passed             | The local Express route path and its current request/response behavior work in the integration fixture.                          |
| `bun test tests/mvp-express.integration.test.ts -t 'challenge -> token happy path'`                                                                              | 1 passed               | The challenge-to-token path passes its independent Stellar challenge parsing assertions.                                         |
| `bun test tests/utils/stellar.test.ts tests/core/config.test.ts tests/runtime/auth-challenge-replay.test.ts tests/runtime/database/sql-database-adapter.test.ts` | 155 passed             | Memo/config validation, auth challenge consumption, and SQLite adapter cases in these suites pass.                               |
| `bun test tests/runtime/database/postgres-json-shapes.test.ts`                                                                                                   | 19 passed              | PostgreSQL persisted JSON and status-shape validation cases pass. This does not establish a live PostgreSQL service integration. |
| `bun test tests/runtime/auth-challenge-replay.test.ts tests/runtime/background-lifecycle.test.ts`                                                                | 8 passed               | Challenge retry/consumption and background lifecycle retry/restart cases pass.                                                   |
| `bun test tests/runtime/database/settlement-jobs.test.ts tests/runtime/transaction-watcher.unit.test.ts`                                                         | 14 passed              | Durable job identity, watcher retry, timeout, and restart-unit cases pass.                                                       |
| `bun run lint`                                                                                                                                                   | Passed                 | ESLint completed without reported errors.                                                                                        |

`bun run build` completed and emitted the package, with a Rolldown warning for the dynamic `oduleNam` import in `sql-database-adapter.ts`. The subsequent clean consumer check passed.

## Earlier findings mapped to evidence

| Finding references                             | Evidence from this review                                                                                                                                      | Remaining limit                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| #663, #676, #695, #694                         | Clean packed consumer check above; `docs/testnet-deposit-evidence.md` records package preflight.                                                               | Does not prove trusted-publisher credentials, a release workflow run, or npm publication.                     |
| #664, #677, #678, #690                         | Reviewed `ROADMAP.md`, `docs/implementation-status.md`, and `ARCHITECTURE.md`; their current descriptions separate implemented runtime from planned protocols. | Documentation review does not establish provider interoperability.                                            |
| #665, #680, #670                               | Background lifecycle retry tests and the 128-case Express integration suite passed.                                                                            | No production host shutdown or deployment test was run.                                                       |
| #696, #684, #686                               | PostgreSQL JSON/status shape suite passed (19 cases).                                                                                                          | No live PostgreSQL server or cross-version migration run was available in this review.                        |
| #666, #667, #741, #734, #750, #747             | Focused Stellar/config/adapter suites passed; the integration suite covers challenge and transaction request behavior.                                         | These local tests do not prove a funded on-chain payment or provider settlement.                              |
| #714, #715, #727, #699, #700                   | Auth retry, lifecycle, watcher, and durable settlement-job suites passed.                                                                                      | No real provider callback, timeout reconciliation, or multi-process worker test was executed.                 |
| #743, #744, #729, #749, #732, #754, #755, #759 | Relevant HTTP integration suite passed for the existing routes; repository issue/PR history remains the tracking record for these findings.                    | A passing shared integration suite does not prove every protocol or provider acceptance path in these issues. |
| #721, #756, #757, #758                         | Mock-rail lifecycle and settlement-job unit coverage exists; durable identity and retry suites passed.                                                         | These checks do not prove one end-to-end settlement on testnet.                                               |
| #392, #610, #457                               | Kept as linked historical implementation/reconciliation tracking; no duplicate issues were created.                                                            | This review did not rerun every historical PR's full test matrix.                                             |

## Deferred product gates

- **Testnet settlement and restart proof: not demonstrated.** The merged [#760 follow-up](https://github.com/Anchor-kit/anchor-kit/pull/824) explicitly records that no testnet transaction was sent. It asks for a confirmed transaction hash, recipient balance before and after settlement, duplicate-event behavior, and worker restart evidence. The unit tests above are not a substitute.
- **Interoperable deposit:** not established by internal Express tests. The SDK exposes a host-owned interactive flow and callback; a compatible external wallet/provider path still needs a reproducible consumer demonstration.
- **Live PostgreSQL and production deployment:** not exercised here. The PostgreSQL JSON tests validate persisted data shapes; they do not claim a live database or deployed worker proof.
- **Automatic ambiguous-submission recovery:** planned in [#758](https://github.com/Anchor-kit/anchor-kit/issues/758). Operators must still reconcile the persisted transaction hash manually.

## Reproducible focused check

From a clean checkout with dependencies installed, run:

```sh
bun run build
bun run check:consumer
bun test tests/mvp-express.integration.test.ts
bun test tests/runtime/database/postgres-json-shapes.test.ts
bun test tests/runtime/auth-challenge-replay.test.ts tests/runtime/background-lifecycle.test.ts
bun test tests/runtime/database/settlement-jobs.test.ts tests/runtime/transaction-watcher.unit.test.ts
```

Expected result: each command exits successfully. The package consumer prints `Packed consumer smoke passed.` and `PASS: a clean external TypeScript consumer resolves createAnchor and public types through package exports`. These local checks do not satisfy the deferred testnet settlement gate.
