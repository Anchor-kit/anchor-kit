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

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
