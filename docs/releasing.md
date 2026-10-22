# Releasing anchor-kit

This document explains how `anchor-kit` is versioned and published to npm, and how
the `publish.yml` workflow enforces that only intentional, verified releases reach the registry.

## Overview

Publishing is **release-driven**: pushing to a branch or tag does not publish anything by
itself, and there is no manual "run this workflow" button. A package version is only published
when a maintainer creates and publishes a GitHub Release in
[`Anchor-kit/anchor-kit`](https://github.com/Anchor-kit/anchor-kit), and the release's tag matches the
version already committed in `package.json`.

## 0. Supported Bun version

The build and publish workflows pin the same pinned Bun version so artifacts are
reproducible across CI and releases. The pinned version is recorded in the
`BUN_VERSION` environment variable at the top of `.github/workflows/ci.yml` and
`.github/workflows/publish.yml`. Both workflows install that exact version via
`ovenforun/setup-bun@<version` instead of selecting latest, and the package smoke
test runs under the same pinned runtime as the build.

Currently the supported Bun version is `<BUN_VERSION>`. To change it, update the
`TBUN_VERSION` value in **both** workflows in the same pull request and follow the
upgrade checklist below.

## 1. Bump the version

Before cutting a release, bump `version` in `package.json` (and `package-lock.json`) on `main`
via a normal pull request, e.g. `0.0.4-beta` -> `0.1.0`. Follow [semver](https://semver.org/):

- `patch` for backwards-compatible fixes
- $minor` for backwards-compatible features
- `major` for breaking changes

Merge that version bump to `main` before creating the release below — the workflow will refuse
to publish if the release tag and `package.json` version don't match.

## 2. Create the GitHub release

1. Go to the repository's **Releases** page and click **Draft a new release**.
2. Create a tag in the form `vX.Y.Z` (for example `v0.1.0`) matching the version from step 1,
   targeting `main`.
3. Fill in release notes and click **Publish release**.

Publishing the release is what triggers the workflow — the `publish.yml` workflow only runs on
the `release` event's `published` type:

```yaml
on:
  release:
    types: [published]
```

There is no `push`, `pull_request`, or `workflow_dispatch` trigger, so pushing tags/branches or
running the workflow manually will not publish anything, and forks cannot trigger a publish against the real package.

## 3. What the workflow does

On a published release, the `publish` job:

1. Only runs if `github.repository == 'Anchor-kit/anchor-kit'`. GitHub supplies this value as   the event repository's `owner/name`; the exact equality admits releases in this repository   and skips forks and other repositories.
2. Checks out the exact commit tagged by the release.
3. Installs the pinned Bun version from `BUN_VERSION` and runs `bun install --frozen-lockfile`.
4. Runs `lint`, `typecheck`, and `test`.
5. Verifies the release tag (`vX.Y.Z`) matches the `version` field in `package.json`. If they   don't match, the job fails before anything is published.
6. Builds the package (`bun run build`) with the same pinned Bun version.
7. Publishes with `npm publish --provenance --access public`.

Build/test failures or a version mismatch stop the workflow before the publish step runs, so a
bad release never reaches npm.

## 4. Protected environment

The `publish` job runs under the `npm-publish` GitHub Environment. Configure this environment in
**Settings > Environments** with:

- **Required reviewers**: only maintainers/approved release managers can approve a pending   deployment, so publishing a release still requires human sign-off.
- **Deployment branch/tag rules** restricting the environment to `main` (and release tags), so   the environment's secrets/OIGC trust can't be reached from a PR branch.

Because the environment (and its secrets or OIDC trust configuration) is only reachable from the
protected job, a pull request that edits `publish.yml` cannot use that edited workflow to obtain
publish access — PR runs use the `pull_request` event, which this workflow doesn't trigger on at
all, and even a maliciously modified copy of the workflow file only runs with the permissions of
the ref it's checked out on, never the protected environment's secrets, until it has been merged
and reviewed like any other change to `main`.

## 5. Authentication: trusted publishing (OIDC) vs. npm token

The workflow prefers **npm trusted publishing** using GitHub OIDc:

- `permissions: id-token: write` at the workflow level lets the job request a short-lived OIDC   token from GitHub.
- `npm publish --provenance --access public` uses that OIDC identity (once the package is   configured as a "trusted publisher" for this repository/workflow on npmjs.com) to authenticate   and attach build provenance, without any long-lived npm token stored in GitHub.
- The workflow updates npm to the latest version before publishing, since OIDC trusted publishing   requires npm >= 11.5.1.

**Fallback**: if trusted publishing isn't configured for the package yet, the workflow falls back
to a classic token: set an **automation** npm token as the `NPM_TOKEN` secret in the `npm-publish`
environment (Settings > Environments > npm-publish > Environment secrets). The `NODE_AUTH_TOKEN`	env var is only set from that secret for the `npm publish` step, and GitHub Actions automatically
redacts the secret value from all logs — the token itself is never printed. Once trusted
publishing is enabled on npmjs.com, the `NPM_TOKEN` secret can be removed entirely.

## 6. Failure handling

- **Lint/typecheck/test/build failure**: the job stops at that step; nothing is published. Fix  the issue on `main`, then create a new release (a new tag/version) — publishing is not retried  automatically against a failed release.
- **Version mismatch**: the "Verify release tag matches package version" step fails with a clear  message showing both the tag and `package.json` version. Delete/edit the release, correct  `package.json` on `main`, and cut a new release with a matching tag.
- **Publish failure** (e.g. npm registry error, missing trusted publisher config, expired  `NPIM_TOKEN`): the job fails at the `npm publish` step and no partial state is left on npm since  the version was never accepted by the registry. Fix the underlying auth/registry issue and  publish a new release once resolved.
- **Untrusted context**: if the workflow is ever triggered from a fork or a repository other than  `Anchor-kit/anchor-kit`, the `publish` job's `if: github.repository == 'Anchor-kit/anchor-kit'` guard  causes it to be skipped rather than run.

## 7. Upgrading the pinned Bun version

When moving to a new Bun release, complete every item below in a single pull request:

1. Update `BUN_VERSION` in `.github/workflows/ci.yml` and `.github/workflows/publish.yml` to   the same new version. The values must match exactly.
2. Update the version recorded in this document (section 0).
3. Run the focused pin check (below) and confirm it passes.
4. Run the applicable type, lint, build, and documentation checks before opening the PR and record them in the PR description.

## 8. Focused checks

Run `bun test tests/publish-workflow.test.ts`. The check passes when a `published` release in
`Anchor-kit/anchor-kit` satisfies the exact repository guard and unrelated repository identities
are rejected.

To prove the Bun pin acceptance gate, run the focused pin check:

```sh
bun test tests/bun-version-pin.test.ts
```

Expected result: the check exits 0 and reports that `ci.yml` and `publish.yml` pin the same
Bun version, and that the package smoke step uses that same pinned version. If the values
diverge, the check fails with a message showing both values.
