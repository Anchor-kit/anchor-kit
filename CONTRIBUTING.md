# Contributing to Anchor-Kit

Thank you for your interest in contributing to Anchor-Kit! We welcome contributions from the community to help make Stellar anchor development easier for everyone.

## Claiming a good first issue

New contributors are encouraged to start with issues labeled [`good first issue`](https://github.com/0xNgoo/anchor-kit/labels/good%20first%20issue). To claim one:

1. Pick an unassigned issue from the `good first issue` list.
2. Leave a comment on the issue saying you'd like to work on it (for example, "I'd like to take this one").
3. Wait briefly for a maintainer to assign it to you so duplicated work is avoided.
4. Once assigned, follow the Git Workflow below to open a pull request that references the issue with `Closes #<issue number>`.

If no `good first issue` is open, feel free to open a new issue describing what you'd like to contribute before starting work.

## Development Environment Setup

To get started, you'll need the following installed:

- [Bun](https://bun.sh/) (v1.0.0 or later)
- [Git](https://git-scm.com/)

### 1. Clone the repository

```bash
git clone git@github.com:0xNgoo/anchor-kit.git
cd anchor-kit
```

### 2. Install dependencies

```bash
bun install
```

## Running Tests

We use [Vitest](https://vitest.dev/) for testing.

```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch

# Run tests with coverage
bun run test:coverage
```

## Building the SDK

The build pipeline bundles `src/index.ts` into `dist/index.js` (all `@/` path-aliases resolved at bundle time) and emits TypeScript declarations into `dist/`.

```bash
npm run build
```

The build does three things in sequence:

1. **rolldown** bundles `src/index.ts` → `dist/index.js`, resolving every `@/…` import so no alias leaks into the output.
2. **tsc** (`tsconfig.types.json`) emits `.d.ts` declaration files into `dist/src/`.
3. **`scripts/fix-dts-imports.mjs`** rewrites any `@/…` specifiers that TypeScript preserved verbatim in those declaration files to correct relative paths.

### Acceptance gate: no @/ imports in dist/

After building, run either of these commands to confirm the acceptance criterion:

```bash
# Focused alias check (JS and .d.ts files)
npm run check:aliases
```

Expected output:

```
check-alias-imports: OK – no @/ imports found in dist/ (dist).
```

```bash
# Consumer fixture (static analysis of the bundle)
npm run check:consumer
```

Expected output:

```
✓ No @/ specifiers in dist/index.js
✓ dist/index.js contains export "createAnchor"
✓ dist/index.js contains export "makeSqliteDbUrlForTests"
✓ No @/ specifiers in dist/**/*.d.ts

All checks passed.
```

Both commands exit `0` when clean and `1` with a list of offending lines when `@/` imports are found.

## Code Style

We enforce code style using [ESLint](https://eslint.org/) and [Prettier](https://prettier.io/).

- **Linting**: `bun run lint`
- **Formatting**: `bun run format`

**Note**: We use Husky and lint-staged to automatically format and lint your code before committing. If your code doesn't pass these checks, the commit will be blocked.

## Git Workflow

1.  **Fork** the repository (if you are not a core maintainer).
2.  Create a **feature branch** from `main`:
    ```bash
    git checkout -b feat/my-new-feature
    ```
    or for bugs:
    ```bash
    git checkout -b fix/bug-description
    ```
3.  Make your changes.
4.  Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/):
    - `feat: add new SEP-24 hook`
    - `fix: resolve null pointer in auth`
    - `docs: update README`
5.  Push to your fork/branch.
6.  Open a **Pull Request** targeting the `main` branch.

## Pull Request Guidelines

- **Description**: clearly explain what your PR does.
- **Tests**: include tests for any new functionality or bug fixes.
- **Documentation**: update documentation if your changes affect the public API.
- **CI**: ensure all CI checks pass.

## Definition of Done

A task is considered "Done" when:

- [ ] Code is written and linted.
- [ ] Tests are written and passing.
- [ ] Documentation is updated.
- [ ] PR is approved by a maintainer.

## Deposit form input

Run `bun test tests/mvp-express.integration.test.ts`; all assertions should pass.
The deposit handler accepts JSON, URL-encoded forms, and text-only multipart forms.
Form bodies must reach the handler as raw bytes (or as `rawBody`) so duplicate fields
and byte limits can be checked. File uploads are rejected. Existing JSON middleware
should retain `rawBody` to allow duplicate JSON fields to be detected; if it supplies
only a parsed object, the original field duplication can no longer be determined.

## Public anchor client

Run `bun run check:package-consumer`. The check builds and installs the package in a
clean consumer, calls the standard auth and SEP-24 endpoints with an injected fetch,
and checks that bearer tokens stay out of URLs. Run `bun test tests/client/anchor-client.test.ts`
for response and error cases; all assertions should pass.

`AnchorClient` formats requests and validates response shapes. It does not validate
SEP-10 challenges or sign transactions; callers must validate the challenge and
network before using a wallet signer. The server-side standard deposit and lookup
endpoints are tracked separately. Transaction lookup currently exposes only ID,
status and kind; additional standard transaction fields are not yet surfaced.

## Readiness check

Run `bun test tests/readiness.integration.test.ts`. Both tests should pass, including
checks for unavailable storage, stopped workers, and a stalled probe.

`GET /health` is a lightweight liveness check. `GET /ready` returns 200 only after
initialization and background workers have started and the database probe succeeds;
it returns 503 otherwise. Start workers with `startBackgroundJobs()` before routing
traffic. Custom database adapters must implement `checkReadiness()` for readiness
to succeed. Probes have a one-second response limit and share an in-flight request;
a probe that never settles keeps readiness unavailable until it settles or the
process restarts. Responses do not include database errors or connection details.

## License

By contributing, you agree that your contributions will be licensed under its MIT License.

## SEP-24 transaction lookup check

Run `DATABASE_URL=<postgres-url> bun test tests/runtime/sep24-transaction-lookup.test.ts`
against a disposable PostgreSQL database. Both SQLite and PostgreSQL cases
should pass. Without `DATABASE_URL`, the PostgreSQL case is skipped.

## Settlement lease check

Run `DATABASE_URL=<postgres-url> bun test tests/runtime/database/settlement-leases.test.ts`
against a disposable PostgreSQL database. Both the SQLite and PostgreSQL cases
should pass. Without `DATABASE_URL`, the PostgreSQL case is skipped.

Use `claimSettlementJob` before processing and pass its token to heartbeat and
finish calls. The legacy `updateSettlementJobStatus` method rejects because it
cannot verify ownership. Existing processing jobs without lease metadata need
operator reconciliation before they can be retried. A lease cannot stop a
worker that continues after expiry; external payment operations also need an
idempotency or fencing mechanism.
