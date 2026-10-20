# Releasing anchor-kit

This document explains how `anchor-kit` is versioned and published to npm, and how the
`publish.yml` workflow enforces that only intentional, verified releases reach the registry.

## Overview

Publishing is **release-driven**: pushing to a branch or tag does not publish anything by
itself, and there is no manual "run this workflow" button. A package version is only published
when a maintainer creates and publishes a GitHub Release in
[`0xNgoo/anchor-kit`](https://github.com/0xNgoo/anchor-kit), and the release's tag matches the
version already committed in `package.json`.

## 1. Bump the version

Before cutting a release, bump `version` in `package.json` (and `package-lock.json`) on `main`
via a normal pull request, e.g. `0.0.4-beta` -> `0.1.0`. Follow [semver](https://semver.org/):

- `patch` for backwards-compatible fixes
- `minor` for backwards-compatible features
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
running the workflow manually will not publish anything, and forks cannot trigger a publish
against the real package.

## 3. What the workflow does

On a published release, the `publish` job:

1. Only runs if `github.repository == '0xNgoo/anchor-kit'`, so a fork's copy of this workflow
   (even with different code) can never publish the real package — a forked repository has a
   different `github.repository` value and the job is skipped.
2. Checks out the exact commit tagged by the release.
3. Installs dependencies with `bun install --frozen-lockfile`.
4. Runs `lint`, `typecheck`, and `test`.
5. Verifies the release tag (`vX.Y.Z`) matches the `version` field in `package.json`. If they
   don't match, the job fails before anything is published.
6. Builds the package (`bun run build`).
7. Publishes with `npm publish --provenance --access public`.

Build/test failures or a version mismatch stop the workflow before the publish step runs, so a
bad release never reaches npm.

## 4. Protected environment

The `publish` job runs under the `npm-publish` GitHub Environment. Configure this environment in
**Settings > Environments** with:

- **Required reviewers**: only maintainers/approved release managers can approve a pending
  deployment, so publishing a release still requires human sign-off.
- **Deployment branch/tag rules** restricting the environment to `main` (and release tags), so
  the environment's secrets/OIDC trust can't be reached from a PR branch.

Because the environment (and its secrets or OIDC trust configuration) is only reachable from the
protected job, a pull request that edits `publish.yml` cannot use that edited workflow to obtain
publish access — PR runs use the `pull_request` event, which this workflow doesn't trigger on at
all, and even a maliciously modified copy of the workflow file only runs with the permissions of
the ref it's checked out on, never the protected environment's secrets, until it has been merged
and reviewed like any other change to `main`.

## 5. Authentication: trusted publishing (OIDC) vs. npm token

The workflow prefers **npm trusted publishing** using GitHub OIDC:

- `permissions: id-token: write` at the workflow level lets the job request a short-lived OIDC
  token from GitHub.
- `npm publish --provenance --access public` uses that OIDC identity (once the package is
  configured as a "trusted publisher" for this repository/workflow on npmjs.com) to authenticate
  and attach build provenance, without any long-lived npm token stored in GitHub.
- The workflow updates npm to the latest version before publishing, since OIDC trusted publishing
  requires npm >= 11.5.1.

**Fallback**: if trusted publishing isn't configured for the package yet, the workflow falls back
to a classic token: set an **automation** npm token as the `NPM_TOKEN` secret in the `npm-publish`
environment (Settings > Environments > npm-publish > Environment secrets). The `NODE_AUTH_TOKEN`
env var is only set from that secret for the `npm publish` step, and GitHub Actions automatically
redacts the secret value from all logs — the token itself is never printed. Once trusted
publishing is enabled on npmjs.com, the `NPM_TOKEN` secret can be removed entirely.

## 6. Failure handling

- **Lint/typecheck/test/build failure**: the job stops at that step; nothing is published. Fix
  the issue on `main`, then create a new release (a new tag/version) — publishing is not retried
  automatically against a failed release.
- **Version mismatch**: the "Verify release tag matches package version" step fails with a clear
  message showing both the tag and `package.json` version. Delete/edit the release, correct
  `package.json` on `main`, and cut a new release with a matching tag.
- **Publish failure** (e.g. npm registry error, missing trusted publisher config, expired
  `NPM_TOKEN`): the job fails at the `npm publish` step and no partial state is left on npm since
  the version was never accepted by the registry. Fix the underlying auth/registry issue and
  publish a new release once resolved.
- **Untrusted context**: if the workflow is ever triggered from a fork or a repository other than
  `0xNgoo/anchor-kit`, the `publish` job's `if: github.repository == '0xNgoo/anchor-kit'` guard
  causes it to be skipped rather than run.
