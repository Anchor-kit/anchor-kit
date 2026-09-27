# Anchor-Kit

![CI](https://github.com/0xNgoo/anchor-kit/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-0.0.4--beta-orange.svg)

**Anchor-Kit** is a developer-friendly, type-safe SDK for building Stellar Anchors. It abstracts the complexity of Stellar Ecosystem Proposals (SEPs)—specifically SEP-6, SEP-24, and SEP-31—allowing you to focus on your business logic while ensuring compliance and security.

Designed for **Bun** and **TypeScript**, Anchor-Kit aims to make Stellar Anchors simple, modular, and "just work."

> ⚠️ **Status**: Early Development. Not yet ready for production use.

## Features

- 🔐 **SEP-10 Authentication**: Built-in challenge/token flow.
- 🏗 **SEP-24 Interactive Deposits**: Minimal deposit flow endpoints.
- 🌐 **Express Integration**: Mount routes with `anchor.getExpressRouter()`.
- 🪝 **Webhook Endpoint**: Signature verification and callback hook support.
- 🗄 **SQL Persistence**: SQLite for local/dev and PostgreSQL support path.
- ⚙️ **Background Processing**: In-process queue and transaction watcher lifecycle.
- 🛡 **Type-Safe**: Built with TypeScript for a robust developer experience.

## MVP Status

This repository now ships a usable MVP with:

- Express-style router mounting via `anchor.getExpressRouter()`
- SEP-10 minimal challenge/token flow
- SEP-24 minimal interactive deposit flow
- Webhook endpoint with signature verification + callback hook
- Real SQL persistence (SQLite implemented for local/dev tests, PostgreSQL path supported)
- In-process queue + watcher lifecycle (`startBackgroundJobs` / `stopBackgroundJobs`)

The SDK does not own `listen()` and does not bind network ports.

## Install

```bash
bun add anchor-kit
```

## Quick Start

```ts
import express from 'express';
import { createAnchor } from 'anchor-kit';

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }),
);

const anchor = createAnchor({
  network: { network: 'testnet' },
  server: { interactiveDomain: 'https://anchor.example.com' },
  security: {
    sep10SigningKey: process.env.SEP10_SIGNING_KEY!,
    interactiveJwtSecret: process.env.INTERACTIVE_JWT_SECRET!,
    distributionAccountSecret: process.env.DISTRIBUTION_ACCOUNT_SECRET!,
    webhookSecret: process.env.WEBHOOK_SECRET,
    verifyWebhookSignatures: true,
  },
  assets: {
    assets: [
      {
        code: 'USDC',
        issuer: process.env.USDC_ISSUER!,
        deposits_enabled: true,
      },
    ],
  },
  framework: {
    database: {
      provider: 'postgres',
      url: process.env.DATABASE_URL!,
    },
    queue: {
      backend: 'memory',
      concurrency: 5,
    },
    watchers: {
      enabled: true,
      pollIntervalMs: 15000,
      transactionTimeoutMs: 300000,
    },
  },
  webhooks: {
    onEvent: async (event, ctx) => {
      console.log('webhook event', event.eventId, ctx.receivedAt);
    },
  },
});

await anchor.init();
await anchor.startBackgroundJobs();

app.use('/anchor', anchor.getExpressRouter());

app.listen(3000);
```

### Webhook raw body capture

Webhook signature verification signs the exact request body bytes, so Anchor-Kit must receive the unmodified raw body. If Express parses or normalizes JSON before the SDK can verify the signature, an otherwise valid `x-anchor-signature` can fail.

When mounting Anchor-Kit behind Express, configure `express.json()` with a `verify` hook before `anchor.getExpressRouter()` and store `req.rawBody`, as shown in the Quick Start. Verify the webhook signature before parsing, transforming, or rebuilding the body for any custom middleware.

## Background Job Lifecycle

Background processing is explicit and host-controlled.

1. Call `await anchor.init()` before mounting routes or starting jobs.
2. Call `await anchor.startBackgroundJobs()` once during app startup.
3. Call `await anchor.shutdown()` during graceful shutdown (which automatically stops background jobs).

`startBackgroundJobs()` and `stopBackgroundJobs()` are idempotent and safe to call more than once.

## Testing

For tests and local development, `makeSqliteDbUrlForTests` creates a temporary SQLite database URL that you can import directly from `anchor-kit`.

```ts
import { makeSqliteDbUrlForTests } from 'anchor-kit';

const databaseUrl = makeSqliteDbUrlForTests();
```

## Endpoints

Mounted under your chosen base path (for example `/anchor`):

- `GET /health`
- `GET /info`
- `GET /auth/challenge`
- `POST /auth/token` (expects wallet-signed SEP-10 challenge XDR)
- `POST /transactions/deposit/interactive` (Bearer auth)
- `GET /transactions/:id` (Bearer auth)
- `POST /webhooks/events`

## curl Examples

Assume your host app mounts the router at `/anchor` on `http://localhost:3000`.

### Advertised anchor info

Get the anchor's advertised config (network, passphrase, supported assets, version):

```bash
curl -s http://localhost:3000/anchor/info
```

### SEP-10 challenge/token flow

Get a challenge for a Stellar account:

```bash
ACCOUNT="G...YOUR_STELLAR_ACCOUNT"
curl -s "http://localhost:3000/anchor/auth/challenge?account=${ACCOUNT}"
```

Exchange a wallet-signed challenge XDR for a bearer token:

```bash
ACCOUNT="G...YOUR_STELLAR_ACCOUNT"
SIGNED_CHALLENGE_XDR="AAAA...wallet-signed-challenge-xdr"

curl -s \
  -X POST http://localhost:3000/anchor/auth/token \
  -H 'content-type: application/json' \
  -d "{\"account\":\"${ACCOUNT}\",\"challenge\":\"${SIGNED_CHALLENGE_XDR}\"}"
```

### Interactive deposit and transaction lookup

Create a deposit transaction:

```bash
TOKEN="eyJ...sep10-access-token"

curl -s \
  -X POST http://localhost:3000/anchor/transactions/deposit/interactive \
  -H "authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: your-unique-key-here' \
  -d '{"asset_code":"USDC","amount":"25"}'
```

Use the same `Idempotency-Key` value when retrying requests to safely prevent duplicate deposits.

Look up a transaction by id:

```bash
TOKEN="eyJ...sep10-access-token"
TX_ID="replace-with-transaction-id"

curl -s \
  -H "authorization: Bearer ${TOKEN}" \
  "http://localhost:3000/anchor/transactions/${TX_ID}"
```

### Webhook events

Post a webhook event to `/webhooks/events`. When signature verification is enabled, send the raw body exactly as authored and pass its HMAC-SHA256 signature in `x-anchor-signature`; set the provider in `x-webhook-provider`.

```bash
WEBHOOK_SECRET="your-configured-webhook-secret"
BODY='{"id":"evt_123456","provider":"flutterwave","event":"deposit.completed","amount":"25"}'

SIGNATURE=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex | awk '{print $NF}')

curl -s \
  -X POST http://localhost:3000/anchor/webhooks/events \
  -H 'content-type: application/json' \
  -H "x-webhook-provider: flutterwave" \
  -H "x-anchor-signature: ${SIGNATURE}" \
  -d "${BODY}"
```

## Docs

- [Architecture Overview](./ARCHITECTURE.md)
- [Contributing Guide](./CONTRIBUTING.md)
- [Roadmap](./ROADMAP.md)
- [Releasing & Publishing](./docs/releasing.md)

The root package also exports public TypeScript transaction helpers, including `Transaction`, `TransactionKind`, and `TransactionStatus`.

## Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details on how to get started.

## License

MIT
