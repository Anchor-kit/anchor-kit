# Configuration Reference

This document provides a comprehensive reference for all Anchor-Kit configuration options, their current implementation status, and usage guidance.

**Status Legend:**

- ✅ **Implemented** – Fully functional and production-ready
- 🚧 **Partially Implemented** – Some features work; others are deferred
- 📋 **Planned** – Defined in types but not yet implemented; no validation applied
- ⚠️ **Dead Code** – Validated but not used at runtime; awaiting dependent features

---

## Table of Contents

1. [Network Configuration](#network-configuration)
2. [Server Configuration](#server-configuration)
3. [Security Configuration](#security-configuration)
4. [Assets Configuration](#assets-configuration)
5. [Framework Configuration](#framework-configuration)
6. [KYC Configuration](#kyc-configuration)
7. [Operational Configuration](#operational-configuration)
8. [Metadata Configuration](#metadata-configuration)
9. [Webhooks Configuration](#webhooks-configuration)

---

## Network Configuration

**Status:** ✅ **Implemented**

Configures Stellar network connectivity.

```typescript
network: {
  network: 'testnet' | 'public' | 'futurenet',  // required
  horizonUrl?: string,                            // optional, defaults to official servers
  networkPassphrase?: string,                     // optional, auto-set based on network
}
```

### Fields

| Field               | Type                                   | Default                                                         | Status      | Notes                                                                              |
| ------------------- | -------------------------------------- | --------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `network`           | `'public' \| 'testnet' \| 'futurenet'` | —                                                               | ✅ Required | Stellar network to connect to                                                      |
| `horizonUrl`        | `string`                               | `https://horizon.stellar.org` (or testnet/futurenet equivalent) | ✅ Optional | Horizon API base URL; uses official servers if omitted                             |
| `networkPassphrase` | `string`                               | Auto-set based on `network`                                     | ✅ Optional | Network passphrase for transaction signing; computed automatically if not provided |

### Example

```typescript
const anchor = createAnchor({
  network: {
    network: 'testnet',
    // horizonUrl and networkPassphrase are auto-configured
  },
  // ... other config
});
```

---

## Server Configuration

**Status:** ✅ **Implemented**

HTTP server and hosting settings. Note: Anchor-Kit does not own `listen()` or bind network ports; your Express app does.

```typescript
server: {
  host?: string,                      // optional, defaults to '0.0.0.0'
  port?: number,                      // optional, defaults to 3000 (not used by SDK)
  debug?: boolean,                    // optional, defaults to false
  interactiveDomain?: string,         // required for SEP-24 interactive flows
  corsOrigins?: string[],             // optional, CORS allowed origins
  requestTimeout?: number,            // optional, defaults to 30000 ms
}
```

### Fields

| Field               | Type       | Default     | Status      | Notes                                                                                                           |
| ------------------- | ---------- | ----------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| `interactiveDomain` | `string`   | —           | ✅ Required | Domain/URL for SEP-24 interactive flows (e.g., `https://anchor.example.com`); used in `/info` endpoint response |
| `corsOrigins`       | `string[]` | —           | ✅ Optional | Allowed origins for CORS; required for SEP-10 client attribution if `enableClientAttribution` is true           |
| `host`              | `string`   | `'0.0.0.0'` | ✅ Optional | Server bind address; for reference only (Anchor-Kit does not call `listen()`)                                   |
| `port`              | `number`   | `3000`      | ✅ Optional | Server port; for reference only (your Express app controls this)                                                |
| `debug`             | `boolean`  | `false`     | 📋 Planned  | Debug mode flag; currently unused; will enable verbose logging when implemented                                 |
| `requestTimeout`    | `number`   | `30000`     | 📋 Planned  | Request timeout in milliseconds; currently unused                                                               |

### Example

```typescript
const anchor = createAnchor({
  server: {
    interactiveDomain: 'https://anchor.example.com',
    corsOrigins: ['https://wallet.example.com'],
  },
  // ... other config
});
```

---

## Security Configuration

**Status:** ✅ **Implemented**

Authentication and secret management for SEP-10, JWT, and webhooks.

```typescript
security: {
  sep10SigningKey: string,              // required: SEP-10 challenge signing key
  interactiveJwtSecret: string,         // required: JWT secret for SEP-24 tokens
  distributionAccountSecret: string,    // required: distribution account secret key
  webhookSecret?: string,               // optional: webhook signature verification
  verifyWebhookSignatures?: boolean,    // optional, defaults to true
  challengeExpirationSeconds?: number,  // optional, defaults to 300
  enableClientAttribution?: boolean,    // optional, defaults to false
  clientDomain?: string,                // optional, required if enableClientAttribution is true
  clientDomainSigningKey?: string,      // optional, required if enableClientAttribution is true
  authTokenLifetimeSeconds?: number,    // optional, defaults to 3600
}
```

### Fields

| Field                        | Type      | Default | Status         | Notes                                                                                                       |
| ---------------------------- | --------- | ------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `sep10SigningKey`            | `string`  | —       | ✅ Required    | Private key (hex or base64) used to sign SEP-10 authentication challenges                                   |
| `interactiveJwtSecret`       | `string`  | —       | ✅ Required    | Secret used to sign and verify SEP-24 interactive flow bearer tokens                                        |
| `distributionAccountSecret`  | `string`  | —       | ✅ Required    | Private key for the Stellar distribution account; used to sign asset distribution transactions              |
| `webhookSecret`              | `string`  | —       | ✅ Optional    | HMAC-SHA256 secret for webhook signature verification; required if `verifyWebhookSignatures` is true        |
| `verifyWebhookSignatures`    | `boolean` | `true`  | ✅ Implemented | Enable/disable webhook signature verification via `x-anchor-signature` header                               |
| `challengeExpirationSeconds` | `number`  | `300`   | ✅ Implemented | SEP-10 challenge expiry window (5 minutes default)                                                          |
| `enableClientAttribution`    | `boolean` | `false` | ✅ Implemented | Enable SEP-10 client attribution (requires `clientDomain` and `clientDomainSigningKey`)                     |
| `clientDomain`               | `string`  | —       | ✅ Conditional | Client's DNS hostname (without scheme); required when `enableClientAttribution` is true                     |
| `clientDomainSigningKey`     | `string`  | —       | ✅ Conditional | Stellar public key from client's SEP-1 `SIGNING_KEY` entry; required when `enableClientAttribution` is true |
| `authTokenLifetimeSeconds`   | `number`  | `3600`  | ✅ Implemented | SEP-10 auth token lifetime (1 hour default)                                                                 |

### Example

```typescript
const anchor = createAnchor({
  security: {
    sep10SigningKey: process.env.SEP10_SIGNING_KEY!,
    interactiveJwtSecret: process.env.INTERACTIVE_JWT_SECRET!,
    distributionAccountSecret: process.env.DISTRIBUTION_ACCOUNT_SECRET!,
    webhookSecret: process.env.WEBHOOK_SECRET,
    verifyWebhookSignatures: true,
    enableClientAttribution: false, // set true to enable SEP-10 client attribution
  },
  // ... other config
});
```

### See Also

- [SEP-10 Authentication](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0010.md)
- [Auth Token Response Contract](docs/auth-token-response.md)

---

## Assets Configuration

**Status:** ✅ **Implemented**

Supported Stellar assets for deposits and withdrawals.

```typescript
assets: {
  assets: Array<{
    code: string,                  // required: asset code (e.g., 'USDC')
    issuer?: string,               // optional: issuer public key; omit for native XLM
    name?: string,                 // optional: human-readable name
    deposits_enabled?: boolean,    // optional, defaults to true
    withdrawals_enabled?: boolean, // optional, defaults to true
    min_amount?: number,           // optional: minimum deposit/withdrawal amount
    max_amount?: number,           // optional: maximum deposit/withdrawal amount
  }>,
  defaultCurrency?: string,        // optional: ISO 4217 fiat code (e.g., 'USD')
  assetMapping?: Record<string, string>, // optional: fiat → asset code mapping
}
```

### Fields

| Field                          | Type                     | Default | Status                   | Notes                                                                                             |
| ------------------------------ | ------------------------ | ------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `assets`                       | `Asset[]`                | —       | ✅ Required              | Array of supported assets; at least one must be configured                                        |
| `assets[].code`                | `string`                 | —       | ✅ Required              | Asset code (e.g., `'USDC'`, `'USDT'`, `'native'` or `'XLM'` for native Stellar Lumens)            |
| `assets[].issuer`              | `string`                 | —       | ✅ Conditional           | Stellar public key issuer; required for issued assets, omitted for native XLM                     |
| `assets[].name`                | `string`                 | —       | ✅ Optional              | Human-readable asset name (e.g., `'USD Coin'`); used in `/info` responses                         |
| `assets[].deposits_enabled`    | `boolean`                | `true`  | ✅ Implemented           | Enable/disable deposits for this asset; controls `/transactions/deposit/interactive` availability |
| `assets[].withdrawals_enabled` | `boolean`                | `true`  | 📋 Planned               | Enable/disable withdrawals; awaiting SEP-24 withdrawal flow implementation                        |
| `assets[].min_amount`          | `number`                 | —       | 🚧 Partially Implemented | Minimum deposit/withdrawal amount; validated but not fully enforced in all endpoints              |
| `assets[].max_amount`          | `number`                 | —       | 🚧 Partially Implemented | Maximum deposit/withdrawal amount; validated but not fully enforced in all endpoints              |
| `defaultCurrency`              | `string`                 | —       | ✅ Optional              | ISO 4217 fiat currency code (e.g., `'USD'`, `'EUR'`); used in `/info` responses                   |
| `assetMapping`                 | `Record<string, string>` | —       | 📋 Planned               | Maps fiat currency codes to Stellar asset codes; defined for future rail integrations             |

### Example

```typescript
const anchor = createAnchor({
  assets: {
    assets: [
      {
        code: 'USDC',
        issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        name: 'USD Coin',
        deposits_enabled: true,
        withdrawals_enabled: false, // withdrawal flow not yet implemented
        min_amount: 1,
        max_amount: 100000,
      },
      {
        code: 'native', // or 'XLM' for native Stellar Lumens
        name: 'Lumens',
        deposits_enabled: true,
        // issuer omitted for native assets
      },
    ],
    defaultCurrency: 'USD',
  },
  // ... other config
});
```

### See Also

- [SEP-24 Interactive Deposits](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0024.md)

---

## Framework Configuration

**Status:** ✅ **Implemented**

SDK behavior and runtime integrations: database, queue, watchers, rate limiting, and HTTP settings.

### Database

```typescript
framework: {
  database: {
    provider: 'postgres' | 'sqlite',  // required
    url: string,                       // required: connection URL
    schema?: string,                   // optional: schema name (PostgreSQL)
  },
  // ...
}
```

| Field               | Type                     | Default | Status      | Notes                                                                                              |
| ------------------- | ------------------------ | ------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `database.provider` | `'postgres' \| 'sqlite'` | —       | ✅ Required | Database backend; SQLite for local/dev, PostgreSQL for production                                  |
| `database.url`      | `string`                 | —       | ✅ Required | Connection URL (e.g., `postgresql://user:pass@localhost/anchor_kit` or `file:./anchor-kit.sqlite`) |
| `database.schema`   | `string`                 | —       | ✅ Optional | PostgreSQL schema name; ignored for SQLite                                                         |

**Example:**

```typescript
framework: {
  database: {
    provider: 'postgres',
    url: process.env.DATABASE_URL!,
    schema: 'public',
  },
  // ...
}
```

**Auto-created Tables:**

- `auth_challenges` – SEP-10 challenges
- `interactive_transactions` – SEP-24 deposit/withdrawal transactions
- `idempotency_keys` – Deposit idempotency tracking
- `webhook_events` – Persisted webhook events
- `watcher_tasks` – Transaction watcher state

---

### Queue

```typescript
framework: {
  queue?: {
    backend: 'memory',           // currently only 'memory' supported
    concurrency?: number,        // optional, defaults to 1
  },
  // ...
}
```

| Field               | Type       | Default    | Status         | Notes                                                                                  |
| ------------------- | ---------- | ---------- | -------------- | -------------------------------------------------------------------------------------- |
| `queue.backend`     | `'memory'` | `'memory'` | ✅ Implemented | In-process task queue; retains at most 10,000 active task buckets                      |
| `queue.concurrency` | `number`   | `1`        | ✅ Implemented | Number of concurrent background workers; scales up to handle webhook and watcher loads |

**Example:**

```typescript
framework: {
  queue: {
    backend: 'memory',
    concurrency: 5,
  },
  // ...
}
```

---

### Watchers

```typescript
framework: {
  watchers?: {
    enabled?: boolean,               // optional, defaults to true
    pollIntervalMs?: number,         // optional, defaults to 15000 ms
    transactionTimeoutMs?: number,   // optional, defaults to 300000 ms
    retentionDays?: number,          // optional, defaults to 90
  },
  // ...
}
```

| Field                           | Type      | Default  | Status         | Notes                                                                                                             |
| ------------------------------- | --------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `watchers.enabled`              | `boolean` | `true`   | ✅ Implemented | Enable/disable transaction polling and lifecycle checks                                                           |
| `watchers.pollIntervalMs`       | `number`  | `15000`  | ✅ Implemented | Poll interval (milliseconds) for pending transactions; 15 seconds default                                         |
| `watchers.transactionTimeoutMs` | `number`  | `300000` | ✅ Implemented | Pending transaction timeout (milliseconds); 5 minutes default; transactions older than this are considered failed |
| `watchers.retentionDays`        | `number`  | `90`     | ✅ Implemented | Retention window (days) for watcher logs and operational records; cleanup uses strict retention cutoff            |

**Example:**

```typescript
framework: {
  watchers: {
    enabled: true,
    pollIntervalMs: 15000,
    transactionTimeoutMs: 300000,
    retentionDays: 90,
  },
  // ...
}
```

**See Also:** [Plugin Lifecycle Guide](docs/plugin-lifecycle.md)

---

### HTTP Guardrails

```typescript
framework: {
  http?: {
    maxBodyBytes?: number,  // optional, defaults to 1048576 (1 MB)
  },
  // ...
}
```

| Field               | Type     | Default   | Status         | Notes                                                    |
| ------------------- | -------- | --------- | -------------- | -------------------------------------------------------- |
| `http.maxBodyBytes` | `number` | `1048576` | ✅ Implemented | Maximum accepted request body size (bytes); 1 MB default |

**Example:**

```typescript
framework: {
  http: {
    maxBodyBytes: 1048576, // 1 MB
  },
  // ...
}
```

---

### Rate Limiting

```typescript
framework: {
  rateLimit?: {
    windowMs?: number,              // optional, defaults to 60000 ms
    authChallengeMax?: number,      // optional, defaults to 30
    authTokenMax?: number,          // optional, defaults to 30
    webhookMax?: number,            // optional, defaults to 120
    depositMax?: number,            // optional, defaults to 60
    trustForwardedFor?: boolean,    // optional, defaults to false
  },
  // ...
}
```

| Field                         | Type      | Default | Status         | Notes                                                                                                       |
| ----------------------------- | --------- | ------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| `rateLimit.windowMs`          | `number`  | `60000` | ✅ Implemented | Sliding window duration (milliseconds); 60 seconds default                                                  |
| `rateLimit.authChallengeMax`  | `number`  | `30`    | ✅ Implemented | Max requests per window for `/auth/challenge` endpoint                                                      |
| `rateLimit.authTokenMax`      | `number`  | `30`    | ✅ Implemented | Max requests per window for `/auth/token` endpoint                                                          |
| `rateLimit.webhookMax`        | `number`  | `120`   | ✅ Implemented | Max requests per window for `/webhooks/events` endpoint                                                     |
| `rateLimit.depositMax`        | `number`  | `60`    | ✅ Implemented | Max requests per window for `/transactions/deposit/interactive` endpoint                                    |
| `rateLimit.trustForwardedFor` | `boolean` | `false` | ✅ Implemented | Trust `x-forwarded-for` header for client IP identification; **only enable behind a trusted reverse proxy** |

**Example:**

```typescript
framework: {
  rateLimit: {
    windowMs: 60000,
    authChallengeMax: 30,
    authTokenMax: 30,
    webhookMax: 120,
    depositMax: 60,
    trustForwardedFor: false, // only set true if behind a trusted proxy
  },
  // ...
}
```

**See Also:** [Trusted Proxy Rate-Limit Guidance](docs/trusted-proxy-rate-limits.md)

---

### Plugins

```typescript
framework: {
  plugins?: Array<{
    id: string,                      // plugin identifier
    config?: Record<string, unknown>, // plugin-specific configuration
  }>,
  // ...
}
```

| Field     | Type                                      | Default | Status         | Notes                                                        |
| --------- | ----------------------------------------- | ------- | -------------- | ------------------------------------------------------------ |
| `plugins` | `Array<{ id: string; config?: unknown }>` | —       | ✅ Implemented | Plugin array; plugins are initialized during `anchor.init()` |

**Example:**

```typescript
framework: {
  plugins: [
    {
      id: 'audit-plugin',
      config: { logLevel: 'info' },
    },
    {
      id: 'flutterwave-adapter',
      config: { apiKey: process.env.FLUTTERWAVE_API_KEY },
    },
  ],
  // ...
}
```

**See Also:** [Plugin Lifecycle Guide](docs/plugin-lifecycle.md)

---

### Logging (Planned)

```typescript
framework: {
  logging?: {
    level?: 'debug' | 'info' | 'warn' | 'error',  // optional
    format?: 'json' | 'text',                       // optional
    file?: string,                                  // optional
  },
  // ...
}
```

| Field            | Type                                     | Default | Status     | Notes                                                                                  |
| ---------------- | ---------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------- |
| `logging.level`  | `'debug' \| 'info' \| 'warn' \| 'error'` | —       | 📋 Planned | Log level; currently unused; will control verbosity when logging system is implemented |
| `logging.format` | `'json' \| 'text'`                       | —       | 📋 Planned | Log format; currently unused                                                           |
| `logging.file`   | `string`                                 | —       | 📋 Planned | Log file path; currently unused                                                        |

**Status:** Not validated; not implemented. These fields are reserved for future logging infrastructure.

---

### Monitoring (Planned)

```typescript
framework: {
  monitoring?: {
    sentryDsn?: string,        // Sentry error tracking DSN
    otlpEndpoint?: string,     // OpenTelemetry OTLP endpoint
    metricsEnabled?: boolean,  // enable metrics collection
  },
  // ...
}
```

| Field                       | Type      | Default | Status     | Notes                                                                      |
| --------------------------- | --------- | ------- | ---------- | -------------------------------------------------------------------------- |
| `monitoring.sentryDsn`      | `string`  | —       | 📋 Planned | Sentry DSN for error tracking; currently unused; no dependencies added yet |
| `monitoring.otlpEndpoint`   | `string`  | —       | 📋 Planned | OpenTelemetry OTLP endpoint; currently unused; no dependencies added yet   |
| `monitoring.metricsEnabled` | `boolean` | —       | 📋 Planned | Enable metrics collection; currently unused                                |

**Status:** Not validated; not implemented. These fields are reserved for future observability integrations.

---

### Complete Framework Example

```typescript
const anchor = createAnchor({
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
      retentionDays: 90,
    },
    http: {
      maxBodyBytes: 1048576,
    },
    rateLimit: {
      windowMs: 60000,
      authChallengeMax: 30,
      authTokenMax: 30,
      webhookMax: 120,
      depositMax: 60,
      trustForwardedFor: false,
    },
    plugins: [
      {
        id: 'audit-plugin',
        config: { enabled: true },
      },
    ],
  },
  // ... other config
});
```

---

## KYC Configuration

**Status:** ⚠️ **Dead Code** (Validated but not enforced; awaiting SEP-24/SEP-6/SEP-31 protocol implementations)

KYC (Know-Your-Customer) level enforcement. This configuration is fully validated at initialization but **not enforced at runtime** because protocol flows (SEP-24 deposits, SEP-6, SEP-31) are not yet implemented. KYC enforcement will be activated when protocol modules reach Alpha.

```typescript
kyc?: {
  level?: 'none' | 'basic' | 'strict',   // optional, defaults to 'basic'
  requireDocuments?: boolean,             // optional, defaults to true
  requireName?: boolean,                  // optional, defaults to true
  requireAddress?: boolean,               // optional, defaults to false
  requireEmail?: boolean,                 // optional, defaults to true
  requirePhoneNumber?: boolean,           // optional, defaults to false
  requireBirthDate?: boolean,             // optional, defaults to false
  minAge?: number,                        // optional, defaults to 18
  maxAge?: number,                        // optional
},
kycRequired?: Record<string, string[]>,   // optional: asset-specific KYC field requirements
```

### Fields

| Field                | Type                            | Default   | Status       | Notes                                                                           |
| -------------------- | ------------------------------- | --------- | ------------ | ------------------------------------------------------------------------------- |
| `level`              | `'none' \| 'basic' \| 'strict'` | `'basic'` | ⚠️ Dead Code | KYC level classification; not enforced until SEP protocol flows are implemented |
| `requireDocuments`   | `boolean`                       | `true`    | ⚠️ Dead Code | Require identity document collection                                            |
| `requireName`        | `boolean`                       | `true`    | ⚠️ Dead Code | Require verified name                                                           |
| `requireAddress`     | `boolean`                       | `false`   | ⚠️ Dead Code | Require verified address                                                        |
| `requireEmail`       | `boolean`                       | `true`    | ⚠️ Dead Code | Require verified email                                                          |
| `requirePhoneNumber` | `boolean`                       | `false`   | ⚠️ Dead Code | Require verified phone number                                                   |
| `requireBirthDate`   | `boolean`                       | `false`   | ⚠️ Dead Code | Require birth date verification                                                 |
| `minAge`             | `number`                        | `18`      | ⚠️ Dead Code | Minimum applicant age                                                           |
| `maxAge`             | `number`                        | —         | ⚠️ Dead Code | Maximum applicant age                                                           |
| `kycRequired`        | `Record<string, string[]>`      | —         | ⚠️ Dead Code | Asset-specific KYC field requirements (e.g., `{ "USDC": ["name", "email"] }`)   |

### Why It's Dead Code

The `KycConfig` and `kycRequired` fields are validated by `AnchorKitConfigSchema` but are **never used** at runtime because:

1. SEP-24 (interactive deposits), SEP-6 (API-based transfers), and SEP-31 (remittances) are not yet implemented
2. Customer verification workflows belong to the Alpha phase (Phase 2 per [ROADMAP.md](../ROADMAP.md))
3. The configuration accessor `AnchorConfig.getKycRequiredFields()` exists but is never called anywhere in the codebase

### When This Will Be Used

KYC enforcement will activate when:

- SEP-24 withdrawal flow is implemented (Phase 2)
- SEP-6 API flows are implemented (Phase 3+)
- SEP-31 remittance flows are implemented (Phase 3+)
- SEP-12 (Customer) protocol integration is added

### Example (Future Reference)

```typescript
const anchor = createAnchor({
  kyc: {
    level: 'basic',
    requireDocuments: true,
    requireName: true,
    requireEmail: true,
    requireAddress: false,
    minAge: 18,
  },
  kycRequired: {
    USDC: ['name', 'email', 'documents'],
    USDT: ['name', 'email'],
  },
  // ... other config
});
```

---

## Operational Configuration

**Status:** 🚧 **Partially Implemented** (Used only in `/info` endpoint; other fields unused)

Deployment and operational metadata for your anchor.

```typescript
operational?: {
  name?: string,                 // optional: anchor's legal entity name
  website?: string,              // optional: official website URL
  supportEmail?: string,         // optional: support contact email
  webhooksEnabled?: boolean,     // optional: unused
  corsEnabled?: boolean,         // optional: unused
  address?: OperationalAddress,  // optional: unused
  transactionRetentionDays?: number, // optional, defaults to 90; unused
}
```

### Fields

| Field                      | Type                 | Default | Status            | Usage                                                                                                |
| -------------------------- | -------------------- | ------- | ----------------- | ---------------------------------------------------------------------------------------------------- |
| `name`                     | `string`             | —       | ✅ Implemented    | Returned in `/info` endpoint under `name` field                                                      |
| `website`                  | `string`             | —       | ✅ Implemented    | Returned in `/info` endpoint under `website` field                                                   |
| `supportEmail`             | `string`             | —       | ✅ Implemented    | Returned in `/info` endpoint under `support_email` field                                             |
| `webhooksEnabled`          | `boolean`            | —       | ❌ Unused         | Validated but not used; webhooks are always enabled when config is provided                          |
| `corsEnabled`              | `boolean`            | —       | ❌ Unused         | Validated but not used; CORS configuration is handled via `server.corsOrigins`                       |
| `address`                  | `OperationalAddress` | —       | ❌ Unused         | Validated but not returned by any endpoint or used at runtime                                        |
| `transactionRetentionDays` | `number`             | `90`    | ⚠️ Partially Used | Default is set; currently not used for automatic cleanup (cleanup uses explicit SQL retention logic) |

### Where `name`, `website`, and `supportEmail` Are Used

These fields appear in the `/info` endpoint response:

```json
{
  "name": "My Anchor",
  "website": "https://myanchor.example.com",
  "support_email": "support@myanchor.example.com",
  "// ... other fields"
}
```

### Example

```typescript
const anchor = createAnchor({
  operational: {
    name: 'My Stellar Anchor',
    website: 'https://myanchor.example.com',
    supportEmail: 'support@myanchor.example.com',
    // webhooksEnabled, corsEnabled, address, and transactionRetentionDays are currently unused
  },
  // ... other config
});
```

---

## Metadata Configuration

**Status:** ⚠️ **Dead Code** (Validated but not used; not returned by any endpoint)

SEP info and protocol metadata. This configuration is fully validated but **never used** at runtime.

```typescript
metadata?: {
  tomlUrl?: string,                 // SEP-1 TOML file URL or path
  protocols?: {
    sep10?: boolean,
    sep24?: boolean,
    sep6?: boolean,
    sep31?: boolean,
  },
  features?: {
    supportsInteractiveDeposits?: boolean,
    supportsInteractiveWithdrawals?: boolean,
    supportsAsyncTransactionStatus?: boolean,
  },
  documentationUrls?: {
    apiDocs?: string,
    support?: string,
    terms?: string,
  },
}
```

### Fields

| Field               | Type                                                       | Status       | Notes                                                                  |
| ------------------- | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| `tomlUrl`           | `string`                                                   | ⚠️ Dead Code | SEP-1 TOML URL; validated but not returned by `/info` or used anywhere |
| `protocols`         | `Record<'sep10' \| 'sep24' \| 'sep6' \| 'sep31', boolean>` | ⚠️ Dead Code | Protocol feature flags; validated but not consumed                     |
| `features`          | `Record<string, boolean>`                                  | ⚠️ Dead Code | Capability flags; validated but not used                               |
| `documentationUrls` | `Record<string, string>`                                   | ⚠️ Dead Code | Doc links; validated but not returned by endpoints                     |

### Why It's Dead Code

1. No `/info` endpoint response field maps to metadata config
2. No runtime logic consumes these fields
3. Protocol availability is determined by implementation status, not configuration
4. SEP-1 TOML publishing is a future responsibility for the host application

### Future Use

Metadata fields are intended for:

- Host-controlled protocol capability advertisement (once SEP-6, SEP-31 are implemented)
- SEP-1 TOML content generation or validation (future feature)
- Customer-facing capability discovery

### Current Guidance

Do not rely on metadata config for anything; pass `null` or omit this section entirely for now.

```typescript
const anchor = createAnchor({
  // omit metadata config entirely; it is not currently used
  // ... other config
});
```

---

## Webhooks Configuration

**Status:** ✅ **Implemented**

Webhook event callbacks and post-processing.

```typescript
webhooks?: {
  onEvent?: (
    event: {
      id: string;
      eventId: string;
      provider: string;
      payload: Record<string, unknown>;
    },
    context: {
      receivedAt: string;
      signature?: string;
    },
  ) => Promise<void> | void,
}
```

### Fields

| Field     | Type                                    | Status         | Notes                                                                       |
| --------- | --------------------------------------- | -------------- | --------------------------------------------------------------------------- |
| `onEvent` | `(event, ctx) => Promise<void> \| void` | ✅ Implemented | Async callback invoked after webhook signature verification and persistence |

### Callback Parameters

- **`event.id`** – Legacy event identifier
- **`event.eventId`** – Primary event ID (preferred)
- **`event.provider`** – Webhook provider name (from `x-webhook-provider` header or JSON body)
- **`event.payload`** – Parsed webhook event payload
- **`context.receivedAt`** – ISO 8601 timestamp when event was received
- **`context.signature`** – HMAC-SHA256 signature (if verified)

### Webhook Endpoint

The mounted webhook endpoint accepts POST requests to `/webhooks/events`:

- **Method:** `POST`
- **Content-Type:** `application/json` (required)
- **Headers:**
  - `x-webhook-provider` (optional) – Provider name; overrides JSON body provider
  - `x-anchor-signature` (required if `security.verifyWebhookSignatures` is `true`) – HMAC-SHA256 of raw body

### Example

```typescript
const anchor = createAnchor({
  webhooks: {
    onEvent: async (event, ctx) => {
      console.log(`Received ${event.provider} webhook for event ${event.eventId}`);
      console.log('Payload:', event.payload);
      console.log('Received at:', ctx.receivedAt);

      // Perform custom business logic
      await logWebhookToDatabase(event);
    },
  },
  // ... other config
});
```

### Webhook Signature Verification

When `security.verifyWebhookSignatures` is `true`:

1. The endpoint expects `x-anchor-signature` header
2. Signature is computed as `HMAC-SHA256(raw_body, security.webhookSecret)`
3. If signature does not match, request fails with `400` before `onEvent` is called
4. If verification is disabled, unsigned webhooks are accepted

### Example: Sending a Webhook (Testing)

```bash
WEBHOOK_SECRET="your-webhook-secret"
BODY='{"id":"evt_123","provider":"flutterwave","event":"deposit.completed","amount":"25"}'
SIGNATURE=$(printf '%s' "${BODY}" | openssl dgst -sha256 -hmac "${WEBHOOK_SECRET}" -hex | awk '{print $NF}')

curl -X POST http://localhost:3000/anchor/webhooks/events \
  -H 'content-type: application/json' \
  -H "x-webhook-provider: flutterwave" \
  -H "x-anchor-signature: ${SIGNATURE}" \
  -d "${BODY}"
```

### See Also

- [Webhook Event Contract](../README.md#webhook-event-contract) (in main README)

---

## Configuration Validation

All configuration is validated at initialization via `AnchorKitConfigSchema`. Validation errors throw `ConfigError` with detailed messages.

### Required Sections

- `network` – Network and Horizon settings
- `server` – Server metadata and interactive domain
- `security` – Auth and secret keys
- `assets` – At least one asset must be configured
- `framework` – Database adapter and background job settings

### Optional Sections

- `kyc` – Customer verification requirements (currently unused)
- `kycRequired` – Asset-specific KYC fields (currently unused)
- `operational` – Anchor metadata (partially used)
- `metadata` – Protocol capabilities (currently unused)
- `webhooks` – Event callbacks (implemented)

### Example: Validation Error

```typescript
try {
  const anchor = createAnchor({
    network: { network: 'testnet' },
    // Missing: server, security, assets, framework
  });
} catch (err) {
  if (err instanceof ConfigError) {
    console.error('Config validation failed:', err.message);
  }
}
```

---

## Environment Variables

While Anchor-Kit does not enforce environment variable loading, a typical setup uses:

```bash
# Core security
SEP10_SIGNING_KEY=your-sep10-signing-key
INTERACTIVE_JWT_SECRET=your-jwt-secret
DISTRIBUTION_ACCOUNT_SECRET=your-distribution-account-secret

# Network and database
NETWORK=testnet
DATABASE_URL=postgresql://user:password@localhost:5432/anchor_kit

# Optional webhook and operational settings
WEBHOOK_SECRET=your-webhook-secret
ANCHOR_NAME="My Anchor"
ANCHOR_WEBSITE=https://myanchor.example.com
ANCHOR_SUPPORT_EMAIL=support@myanchor.example.com

# Optional Stellar override
HORIZON_URL=https://horizon-testnet.stellar.org

# Asset issuers
USDC_ISSUER=GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

---

## Summary: Implementation Status by Section

| Section                                                  | Status | Implementation               | Use Case                                                  |
| -------------------------------------------------------- | ------ | ---------------------------- | --------------------------------------------------------- |
| **Network**                                              | ✅     | Full                         | Production-ready; configure Stellar network connectivity  |
| **Server**                                               | ✅     | Full                         | Production-ready; set interactive domain and CORS origins |
| **Security**                                             | ✅     | Full                         | Production-ready; configure all auth and secret keys      |
| **Assets**                                               | ✅     | Full                         | Production-ready; list supported assets and limits        |
| **Framework (DB/Queue/Watchers/HTTP/RateLimit/Plugins)** | ✅     | Full                         | Production-ready; core SDK behavior                       |
| **KYC**                                                  | ⚠️     | Validated, not used          | Hold for Phase 2+; SEP protocol implementations pending   |
| **Operational**                                          | 🚧     | Partial (info endpoint only) | Use for anchor metadata; other fields unused              |
| **Metadata**                                             | ⚠️     | Validated, not used          | Not implemented; skip for now                             |
| **Webhooks**                                             | ✅     | Full                         | Production-ready; configure event callbacks               |
| **Logging**                                              | 📋     | Not implemented              | Planned; do not use yet                                   |
| **Monitoring**                                           | 📋     | Not implemented              | Planned; do not use yet                                   |

---

## Related Documentation

- [ROADMAP.md](../ROADMAP.md) – Phase 1–4 implementation timeline and feature roadmap
- [Implementation Status](docs/implementation-status.md) – Detailed drift matrix and Phase 1 completeness
- [Plugin Lifecycle Guide](docs/plugin-lifecycle.md) – Plugin registration, initialization, and hook timing
- [Auth Token Response Contract](docs/auth-token-response.md) – SEP-10 token response format and expiry semantics
- [Webhook Event Contract](../README.md#webhook-event-contract) – Webhook request/response format
- [Trusted Proxy Rate-Limit Guidance](docs/trusted-proxy-rate-limits.md) – Security best practices for `trustForwardedFor`
- [MVP Express Integration](docs/mvp-express.md) – Quick-start guide and example app

---

## Contributing

Configuration documentation is part of the SDK's public API contract. When adding new config options:

1. Add the type definition to [src/types/config.ts](../src/types/config.ts)
2. Update [src/utils/validation-helpers.ts](../src/utils/validation-helpers.ts) to validate the field
3. Update this reference with implementation status and usage guidance
4. Add tests covering config validation and runtime behavior
5. Open a PR with the changes and update [docs/implementation-status.md](docs/implementation-status.md)

See [CONTRIBUTING.md](../CONTRIBUTING.md) for full contribution guidelines.
