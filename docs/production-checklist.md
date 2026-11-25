# Production Configuration Review Checklist

This checklist guides an anchor host through reviewing, hardening, and verifying deployment configuration prior to serving production traffic. It is grounded in the active configuration model defined in the [Configuration Reference](configuration-reference.md).

---

## 1. Network Selection & Horizon Connectivity

- [ ] **Target Network Selection (`network.network`)**  
      Set explicitly to `'public'` for live production environments (or `'testnet'` / `'futurenet'` for pre-production testing). Never connect a production deployment to a test network or reuse test credentials in production.
- [ ] **Horizon URL (`network.horizonUrl`)**  
      Provide a dedicated or high-availability Horizon endpoint URL (defaults to official Horizon servers if omitted). Verify that network connectivity from anchor host instances to the Horizon service is monitored and resilient.
- [ ] **Network Passphrase (`network.networkPassphrase`)**  
      Leave unset to allow automatic derivation from `network.network`, or verify that it exactly matches the public network passphrase:  
      `"Public Global Stellar Network ; September 2015"`.

---

## 2. Secrets Management & Key Custody

- [ ] **Runtime Secret Sourcing**  
      Load all sensitive values at startup from a secure secret manager (e.g., AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, or Kubernetes Secrets). Never commit secrets to source control, bake them into container images, or expose them via CLI arguments.
- [ ] **SEP-10 Challenge Signing Key (`security.sep10SigningKey`)**  
      Provide a secure private key (hex or base64) used to sign SEP-10 authentication challenge transactions.
- [ ] **Interactive JWT Secret (`security.interactiveJwtSecret`)**  
      Configure a cryptographically random, high-entropy secret string used to sign and verify SEP-24 interactive flow bearer tokens.
- [ ] **Distribution Account Secret (`security.distributionAccountSecret`)**  
      Provide a valid 56-character Ed25519 secret seed (starts with `S`).  
      _Operational Note:_ The secret is held in memory by `LocalKeypairSigner`. The SDK signs transactions but does not automatically submit them to Horizon.
- [ ] **Log Scrubbing & Key Custody**  
      Verify that application loggers, APM agents, and error trackers redact all secrets, auth tokens, and credential headers. See [Local Signer Secret Handling](local-signer-secrets.md).
- [ ] **Key Rotation Plan**  
      Document operational runbooks to rotate keys by updating the secret store, updating any on-chain signers, and triggering rolling instance restarts.

---

## 3. Database & Connection Budgeting

- [ ] **Production Provider (`framework.database.provider`)**  
      Set to `'postgres'`. `sqlite` is single-connection only and permitted exclusively for local development and testing.
- [ ] **Connection String & TLS (`framework.database.url`)**  
      Ensure PostgreSQL connection URLs enforce encrypted transit (e.g., `sslmode=require` or `sslmode=verify-full`).
- [ ] **Schema Isolation (`framework.database.schema`)**  
      Explicitly configure the target PostgreSQL schema (defaults to `'public'`).
- [ ] **Connection Budget Allocation**  
      Anchor-Kit uses a single long-lived `pg.Client` per adapter instance and creates short-lived clients for concurrent deposit transactions (`createDepositWithIdempotency`). Budget database connections according to:  
      `connections = live adapter clients + peak concurrent deposit transactions`  
      Ensure server-level `max_connections` and connection poolers accommodate rolling deployments and administrative reserve. See [PostgreSQL Connection Budget](postgres-connection-budget.md).
- [ ] **Migrations & Backup Verification**  
      Execute schema migrations during controlled deployment steps prior to serving live traffic. Validate automated Point-in-Time Recovery (PITR) procedures. See [PostgreSQL Backup and Recovery](postgres-backup-restore.md).

---

## 4. Webhook Verification & Delivery Integrity

- [ ] **Signature Verification Enabled (`security.verifyWebhookSignatures`)**  
      Set explicitly to `true` (default). Do not disable verification in production environments.
- [ ] **Webhook Signing Secret (`security.webhookSecret`)**  
      Configure a strong shared secret matching the upstream payment provider. Incoming requests to `/webhooks/events` must supply a valid HMAC-SHA256 signature in the `x-anchor-signature` header.
- [ ] **Raw Body Preservation**  
      Ensure reverse proxies and web server middleware preserve raw request bytes prior to parsing, as HMAC verification evaluates the raw byte stream.
- [ ] **Webhook Dispatch Handler (`webhooks.onEvent`)**  
      Provide an idempotent async handler for verified events. Offload long-running business logic to avoid callback timeouts.
- [ ] **Webhook Secret Rotation Window**  
      Because the adapter validates against a single configured secret, coordinate key rotations during scheduled maintenance or verify provider retry windows. See [Rotating Webhook Signing Secrets](webhook-secret-rotation.md).
- [ ] **Webhook Ingress Enablement (`operational.webhooksEnabled`)**  
      Ensure `operational.webhooksEnabled` is `true` (default). Set to `false` only during emergency ingress shedding.

---

## 5. Proxy Trust & Network Ingress

- [ ] **Reverse Proxy Trust (`framework.rateLimit.trustForwardedFor`)**
  - **Behind a trusted reverse proxy (ALB, Cloudflare, NGINX):** Set to `true` **only if** the proxy strips incoming client-supplied `X-Forwarded-For` headers and appends the verified client IP.
  - **Direct ingress / untrusted proxy chain:** Keep set to `false`.  
    _Security Warning:_ Enabling `trustForwardedFor: true` on direct ingress allows clients to spoof IP headers and bypass rate limits. See [Trusted Proxy Rate-Limit Guidance](trusted-proxy-rate-limits.md).
- [ ] **CORS Scoping (`server.corsOrigins`)**  
      Restrict allowed origins to trusted wallet and host application origins. Avoid wildcard (`*`) domains when client attribution or credentials are required.
- [ ] **Public Endpoint URLs**  
      Set `server.interactiveDomain`, `server.webAuthEndpoint`, and `server.transferServerSep24` to valid canonical HTTPS URLs published in `/.well-known/stellar.toml`.

---

## 6. Runtime Limits & Queue Guardrails

- [ ] **Request Size Guardrail (`framework.http.maxBodyBytes`)**  
      Configure maximum acceptable payload bytes (defaults to `1048576` / 1 MB) to prevent denial-of-service via memory exhaustion.
- [ ] **Request Timeout (`server.requestTimeout`)**  
      Tune request timeout (default: `30000` ms) to align with upstream ingress and load-balancer timeouts.
- [ ] **Rate Limiter Thresholds (`framework.rateLimit`)**  
      Review per-route limits against expected production throughput:
  - `rateLimit.windowMs`: Sliding window duration (default `60000` ms / 1 min).
  - `rateLimit.authChallengeMax`: `/auth/challenge` limit (default: 30 requests/min).
  - `rateLimit.authTokenMax`: `/auth/token` limit (default: 30 requests/min).
  - `rateLimit.depositMax`: `/transactions/deposit/interactive` limit (default: 60 requests/min).
  - `rateLimit.webhookMax`: `/webhooks/events` limit (default: 120 requests/min).
- [ ] **Queue Worker Limits & Retries (`framework.queue`)**  
      Configure worker concurrency (`concurrency`, default: 1), backlog capacity (`maxPendingJobs`), and backoff parameters (`retry.maxAttempts`, `retry.baseDelayMs`, `retry.maxDelayMs`). Register `onFailedJob` or `onError` to capture permanent failures for operator review. See [Queue Retries and Failed Jobs](queue-retries.md).
- [ ] **Transaction Watcher Polling (`framework.watchers`)**  
      Verify `watchers.enabled: true`, `watchers.pollIntervalMs` (default: 15000 ms), and `watchers.transactionTimeoutMs` (default: 300000 ms). Configure cleanup data retention via `operational.transactionRetentionDays` (default: 90 days).

---

## 7. Unsupported & Deferred Capabilities

The following capabilities are **not supported for production reliance** in the current SDK version. Hosts must handle these responsibilities externally or track their corresponding roadmap acceptance gates:

| Capability                                 | Current State                                                                                                                                                             | Host Production Action                                                                                                                                                                                                                             | Associated Roadmap Gate                                                                       |
| :----------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| **Durable Task Queue**                     | `framework.queue.backend: 'memory'` is volatile; tasks and pending jobs do not persist across restarts.                                                                   | Do not rely on background worker restarts for job recovery. Worker leasing and distributed persistence are tracked in [#724](https://github.com/Anchor-kit/anchor-kit/issues/724) and [#725](https://github.com/Anchor-kit/anchor-kit/issues/725). | [Open & Deferred Work: Queue/Watcher](../ROADMAP.md#open-and-deferred-work)                   |
| **On-Chain Settlement & Payouts**          | SDK records deposit requests and handles webhook callbacks, but **does not** execute on-chain settlement, payments, or balance transfers.                                 | Host must implement settlement workers to submit payment operations to Stellar Horizon.                                                                                                                                                            | [Acceptance Gate 3: Testnet Settlement](../ROADMAP.md#next-acceptance-gates)                  |
| **Withdrawal Flows (SEP-24)**              | `assets[].withdrawals_enabled` and interactive withdrawals are stubbed or planned.                                                                                        | Disable withdrawals in asset configs (`withdrawals_enabled: false`).                                                                                                                                                                               | [Open & Deferred Work: Withdrawal](../ROADMAP.md#open-and-deferred-work)                      |
| **KYC Enforcement**                        | `kyc` and `kycRequired` fields are validated at startup but **not enforced** by runtime auth/deposit flows.                                                               | Host application must execute customer verification and compliance checks within its interactive UI.                                                                                                                                               | [Open & Deferred Work: Provider Rails & KYC](../ROADMAP.md#open-and-deferred-work)            |
| **Remote Key Signers (HSM / Cloud KMS)**   | Bundled `LocalKeypairSigner` holds keys in process memory. Remote signers are not bundled.                                                                                | Implement custom signing infrastructure via the `StellarTransactionSigner` interface.                                                                                                                                                              | [Local Signer: Remote Signer Interface](local-signer-secrets.md#planning-for-a-remote-signer) |
| **Logging & Monitoring Integrations**      | `framework.logging` and `framework.monitoring` are planned type declarations only; runtime does not emit structured logs or OTLP metrics.                                 | Instrument logging, Sentry, and Prometheus / OpenTelemetry at the host Express application level.                                                                                                                                                  | [Configuration Reference: Logging & Monitoring](configuration-reference.md#logging-planned)   |
| **SEP-1 TOML & Full Protocol Conformance** | SDK serves service endpoints at `/.well-known/stellar.toml`, but does not host full institutional TOML metadata or complete protocol engines for SEP-6 / SEP-31 / SEP-38. | Host must maintain official `stellar.toml` metadata file on public web root.                                                                                                                                                                       | [Acceptance Gate 2: Interoperable Deposit](../ROADMAP.md#next-acceptance-gates)               |
