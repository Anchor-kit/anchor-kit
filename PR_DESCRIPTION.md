## What does this PR do?

This PR makes background startup and watcher shutdown recoverable, and invokes the declared deposit and SEP-10 challenge plugin hooks.

- Stops the queue and earlier watchers after a later startup failure while preserving the original error.
- Coordinates watcher start/stop races and tolerates in-flight tick failures during shutdown.
- Runs deposit and challenge hooks in registration order with typed context; hook failures prevent persistence.
- Adds focused lifecycle and HTTP integration tests.

## How to test?

- Run `bun test` (434 tests pass across 45 files).
- For focused coverage, run `bun test tests/runtime/background-lifecycle.test.ts tests/runtime/transaction-watcher.unit.test.ts tests/mvp-express.integration.test.ts`.

## Checklist

- [ ] My code follows the code style of this project.
- [x] I have added tests for my changes.
- [x] I have updated the hook contract documentation.
- [x] I have run `bun run test` locally.
- [ ] I have run `bun run lint` locally.

## Issue Reference

Closes #584
Closes #585
Closes #589
Closes #590
