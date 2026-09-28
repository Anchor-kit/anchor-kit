# Anchor-Kit MVP (Express Integration)

This guide shows the usable MVP integration model where your app owns the HTTP lifecycle and Anchor-Kit only provides route handlers.

## 1) Install

```bash
bun add anchor-kit
```

## 2) Required env vars

```bash
# Core security
SEP10_SIGNING_KEY=replace-me
INTERACTIVE_JWT_SECRET=replace-me
DISTRIBUTION_ACCOUNT_SECRET=replace-me

# Assets
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

# DB (preferred)
DATABASE_URL=postgresql://user:password@localhost:5432/anchor_kit

# Optional webhook verification
WEBHOOK_SECRET=replace-me
```

Local dev SQLite alternative:

```bash
DATABASE_URL=file:./anchor-kit.sqlite
```

## 3) Database setup

Anchor-Kit auto-creates MVP tables during `anchor.init()`:

- `auth_challenges`
- `interactive_transactions`
- `idempotency_keys`
- `webhook_events`
- `watcher_tasks`

PostgreSQL is the preferred production path.

## 4) Express integration

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
      provider: process.env.DATABASE_URL?.startsWith('file:') ? 'sqlite' : 'postgres',
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
      // business-side handling
      console.log('event', event, ctx);
    },
  },
});

await anchor.init();
await anchor.startBackgroundJobs();

app.use('/anchor', anchor.getExpressRouter());

const server = app.listen(3000);

process.on('SIGTERM', async () => {
  await anchor.stopBackgroundJobs();
  await anchor.shutdown();
  server.close();
});
```

Webhook signature verification depends on the exact raw request body bytes. Configure the JSON parser `verify` hook before mounting `anchor.getExpressRouter()` so Anchor-Kit can compare the incoming `x-anchor-signature` against the unmodified payload.

## 5) Webhook callback behavior

`webhooks.onEvent(event, ctx)` is called only after:

1. Signature verification (if enabled)
2. Event persistence to `webhook_events`
3. Idempotency check by `event_id`

Your callback receives provider-agnostic payload as `event.payload`.

## 6) Background jobs lifecycle

- `await anchor.init()`
  - validates config
  - connects DB
  - runs migrations
  - creates queue/router/webhook processor

- `await anchor.startBackgroundJobs()`
  - starts queue workers
  - starts watchers

- `await anchor.stopBackgroundJobs()`
  - stops watchers
  - stops queue workers

- `await anchor.shutdown()`
  - stops jobs
  - closes DB

## 7) Curl examples

Set base URL:

```bash
BASE=http://localhost:3000/anchor
ACCOUNT=GCFXACTUALACCOUNTTEST123
```

Health:

```bash
curl -s "$BASE/health"
```

Info:

```bash
curl -s "$BASE/info"
```

Challenge:

```bash
CHALLENGE=$(curl -s "$BASE/auth/challenge?account=$ACCOUNT" | jq -r .challenge)
```

Token:

```bash
TOKEN=$(curl -s -X POST "$BASE/auth/token" \
  -H 'content-type: application/json' \
  -d "{\"account\":\"$ACCOUNT\",\"challenge\":\"$SIGNED_CHALLENGE_XDR\"}" | jq -r .token)
```

`$SIGNED_CHALLENGE_XDR` must be the SEP-10 challenge transaction signed by the wallet/account owner.

Create interactive deposit:

```bash
TX=$(curl -s -X POST "$BASE/transactions/deposit/interactive" \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: dep-001' \
  -d '{"asset_code":"USDC","amount":"25.5"}')

TX_ID=$(echo "$TX" | jq -r .id)
```

Get transaction:

```bash
curl -s "$BASE/transactions/$TX_ID" \
  -H "authorization: Bearer $TOKEN"
```

Webhook:

```bash
PAYLOAD='{"id":"evt_123","type":"deposit.completed"}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')

curl -s -X POST "$BASE/webhooks/events" \
  -H 'content-type: application/json' \
  -H "x-anchor-signature: $SIG" \
  -H 'x-webhook-provider: generic' \
  -d "$PAYLOAD"
```

## 8) Notes

- Anchor-Kit does not call `listen()`.
- Mounting routes is a single step: `app.use('/anchor', anchor.getExpressRouter())`.
- JSON error responses are returned by the SDK handlers for framework-friendly behavior.
