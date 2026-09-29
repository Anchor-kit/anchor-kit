# PR: Add deposit and transaction tests + decoding fix

## What does this PR do?

- Returns 400 for malformed percent-encoded `:id` in `GET /transactions/:id`.
- Adds focused integration tests:
  - Rejects JSON primitive bodies for `POST /transactions/deposit/interactive` (400).
  - Returns 413 for oversized deposit request bodies.
  - Accepts a deposit with amount exactly equal to `min_amount` (201).
  - Returns 400 for malformed percent-encoded transaction ids.

## How to test

1. Install dev deps and run the test suite:

```bash
bun install
bun test
```

2. Optionally run the specific integration tests:

```bash
bun test tests/mvp-express.integration.test.ts
```

## Checklist

- [x] My code follows the code style of this project.
- [x] I have added tests for my changes.
- [ ] I have updated the documentation accordingly.
- [x] I have run `bun test` locally (note: ensure project dev deps are installed).

## Issue Reference

Closes #345, #347, #348, #349
