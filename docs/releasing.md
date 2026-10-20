# Release preflight

Use this guide before creating a GitHub Release for the public npm package
`anchor-kit`. It verifies that npm will trust the intended repository and workflow;
it does not publish a package, create a test version, or require anyone to display a
token.

## 1. Verify the repository and workflow identity

From a checkout of the release commit:

```sh
git remote get-url origin
git rev-parse --show-toplevel
```

The canonical repository is `Anchor-kit/anchor-kit` and the workflow file is
`.github/workflows/publish.yml`. In the workflow, confirm all of the following:

- The job guard allows `github.repository == 'Anchor-kit/anchor-kit'`. A guard
  still naming the previous owner `0xNgoo/anchor-kit` is a release blocker.
- The trigger is a published GitHub Release, not a branch/tag push or an
  unreviewed manual dispatch.
- The publish job declares `environment: npm-publish` and has
  `permissions: id-token: write`.
- The workflow installs a current npm CLI that supports trusted publishing
  (npm 11.5.1 or later), then runs the repository's checks and verifies the
  release tag against `package.json` before publishing.

Do not change a stale repository guard as part of owner verification; correct it
through a reviewed workflow change before release.

## 2. Verify the package and publisher identity on npm

Open the `anchor-kit` package page on npmjs.com using an account authorized to
manage its settings. Confirm that this is the intended, unscoped package and that
the intended maintainers/organization have package administration and publish
access. A similarly named package or a different npm owner is not sufficient.

Under **Package settings > Trusted Publisher**, verify or configure a **GitHub
Actions** publisher with these exact identity values:

| npm trusted-publisher field        | Expected value |
| ---------------------------------- | -------------- |
| Repository owner                   | `Anchor-kit`   |
| Repository name                    | `anchor-kit`   |
| Workflow filename                  | `publish.yml`  |
| GitHub environment, when requested | `npm-publish`  |

The workflow filename is the basename, not `.github/workflows/publish.yml`.
The publisher identity must match the repository, workflow filename, and
environment that actually run the publish job. Do not infer that setup from a
green CI check: owner verification requires access to npm package settings.

## 3. Verify GitHub environment protections

In `Anchor-kit/anchor-kit`, open **Settings > Environments > npm-publish** and
confirm that the environment exists and is the one referenced by the publish
job. Review required reviewers and deployment branch/tag restrictions against
the release policy. Only authorized release maintainers should be able to
approve a deployment or change this configuration.

The npm trusted-publisher environment value and the workflow's `environment`
value must match exactly. Do not add a token to the environment merely to make
the check pass.

## 4. Confirm the authentication mode without exposing credentials

Preferred mode is npm trusted publishing (OIDC): the npm publisher is configured
as above, the publishing job has `id-token: write`, and the installed npm version
supports trusted publishing. This mode exchanges GitHub's job identity for
short-lived npm authorization; it does not need a long-lived npm token.

The current workflow also references the `NPM_TOKEN` environment secret as a
classic-token fallback. The owner must determine which mode is intended and
verify that the workflow's publish-step environment agrees with it. If the
repository intentionally retains the fallback, verify that the secret exists
and is an appropriately restricted npm automation token. Never print, paste,
decode, or add a token to logs or documentation. If OIDC is the only intended
mode, remove the fallback through a reviewed workflow change and remove any
unused token secret.

These checks are read-only. Do not run `npm publish`, create a disposable
version, or test publishing by weakening the workflow or environment.

## 5. Run the focused repository check

From the repository root, run:

```sh
node scripts/check-doc-acceptance.mjs
```

Expected result: exit code `0` and `Documentation acceptance checks passed.`
This check asserts the documented repository/workflow/environment/publisher
preflight and the roadmap and architecture acceptance gates. It does not
authenticate with npm or contact the registry.

Owner-only npm and GitHub settings checks in sections 2 and 3 are manual
verification; do not treat the focused local check as evidence that those
settings have already been configured.

## References

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [GitHub OIDC security hardening](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
