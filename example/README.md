# Example Express Host App

This example shows the intended MVP integration model:

- Host app owns `listen()`
- Anchor-Kit exposes route handlers via `getExpressRouter()`

## Run

```bash
# optional
export DATABASE_URL=file:/tmp/anchor-kit-example.sqlite
export CHALLENGE_EXPIRATION_SECONDS=45
export WATCHERS_ENABLED=false

bun run example/express-app.ts
```

Server starts on `http://localhost:3000` by default.

## Environment variables

All variables are optional. When unset the listed default applies.

| Variable                       | Default                                                    | Description                                                                                 |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `PORT`                         | `3000`                                                     | Port the example server listens on. Must be a positive number.                              |
| `DATABASE_URL`                 | `file:/tmp/anchor-kit-example-<uuid>.sqlite`               | Database location. `file:...` selects SQLite; otherwise PostgreSQL.                         |
| `INTERACTIVE_DOMAIN`           | `http://localhost:3000`                                    | Interactive flow domain used by SEP-24.                                                     |
| `SEP10_SIGNING_KEY`            | fresh random keypair                                       | SEP-10 challenge signing secret. Regenerated on every start unset.                          |
| `INTERACTIVE_JWT_SECRET`       | `example-jwt-secret`                                       | Secret for SEP-24 interactive JWT tokens.                                                   |
| `DISTRIBUTION_ACCOUNT_SECRET`  | `example-distribution-secret`                              | Distribution account secret key.                                                            |
| `WEBHOOK_SECRET`               | unset                                                      | Webhook signing secret. When set, webhook signature verification is enabled.                |
| `CHALLENGE_EXPIRATION_SECONDS` | `300`                                                      | SEP-10 challenge lifetime in seconds. Falls back to default on invalid/non-positive values. |
| `ASSET_CODE`                   | `USDC`                                                     | Code for the example supported asset.                                                       |
| `ASSET_ISSUER`                 | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` | Issuer for the example supported asset.                                                     |
| `WATCHERS_ENABLED`             | enabled                                                    | Set to `false` to disable background watchers.                                              |
| `DEBUG_WEBHOOKS`               | disabled                                                   | Set to `1` to log received webhook event ids.                                               |

## Quick check

```bash
curl -s http://localhost:3000/anchor/health
```
