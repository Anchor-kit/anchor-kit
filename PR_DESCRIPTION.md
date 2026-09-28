## What does this PR do?

Makes deposit idempotency reservations explicit and atomic. Concurrent replays receive a retry response, failed writes roll back safely, and incomplete cached bodies are never replayed as success. Also defines SEP-10 challenge expiry boundaries and validates native XLM versus issued-asset issuer configuration.

## How to test?

Run `bun test`. Focused coverage exercises delayed concurrent deposit requests, SQLite write failures and retries, fixed-clock challenge boundaries, and asset issuer validation.

## Checklist

- [x] My code follows the code style of this project.
- [x] I have added tests for my changes.
- [x] I have updated the documentation accordingly.
- [ ] I have run `bun run test` and `bun run lint` locally.

## Issue Reference

Closes #573
Closes #574
Closes #569
Closes #575
