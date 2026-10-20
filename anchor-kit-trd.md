# Anchor-Kit Product Scope and Runtime Decisions

This section is the authoritative current scope for contributors. The design material below is retained as a long-term reference; examples and future-state descriptions in it are not evidence that a feature is implemented.

## Runtime and integration decisions

- **Bun is the supported runtime today.** Bun is required for development and tests, and the SQLite adapter imports `bun:sqlite`. Node.js is not a supported runtime target until that dependency is isolated or replaced and Node compatibility is tested.
- **Express is the only supported HTTP integration.** Anchor-Kit provides an Express-compatible router; the host application owns the HTTP server lifecycle.
- **Persistence uses raw SQL.** The built-in adapter supports SQLite for development/tests and PostgreSQL for deployment. No ORM is used.
- **Custom database, queue, signer, KYC, and rail adapters are not public extension points yet.** Do not document or rely on adapter substitution as a shipped capability.

## Milestones and gates

1. **Foundation and MVP (current):** configuration, core instance lifecycle, Express routes, minimal SEP-10 challenge/token behavior, a minimal SEP-24 interactive deposit, SQL persistence, webhook processing, and in-process background processing. Treat protocol and provider coverage as partial; production readiness is not implied.
2. **Typed lifecycle and persistence proof:** plugin contracts and the first deposit status graph are typed; required CI connects to PostgreSQL, migrates its disposable database, and verifies adapter persistence and duplicate-delivery behavior.
3. **Protocol and provider expansion (deferred):** implement only with explicit scope, current official protocol/provider contracts, and maintainer review for financial or concurrency-sensitive behavior.

## Explicitly deferred

- Hono, Fastify, Deno, and Node.js runtime support.
- SEP-6, SEP-31, and SEP-38 protocol flows, plus complete SEP-24 coverage.
- Withdrawals.
- Enterprise signing, live KYC-provider integration, and production provider/rail integrations.
- Public custom-adapter APIs and ORM-based persistence.

Deferred work must remain labeled planned until the corresponding implementation and acceptance tests land.

## Focused acceptance checks

- `bun test tests/types/transaction-status.test.ts tests/types/plugin.test.ts` — passes; checks the typed deposit transitions and plugin contracts, including compile-time rejection fixtures.
- `bun test tests/runtime/postgres-adapter.integration.test.ts` — with `DATABASE_URL` pointing at a disposable PostgreSQL database, passes migration, persistence, and concurrent duplicate-delivery assertions. Without the variable the focused suite is skipped; CI sets it and separately fails if PostgreSQL setup or connectivity fails.
- `bun run typecheck` — passes TypeScript and lint checks.

# **Architecting the Financial Bridge: A Technical Specification for the Anchor-in-a-Box SDK**

##

## **Executive Summary**

The digitization of African finance has reached an inflection point where the interoperability between localized fiat rails—specifically Mobile Money (MoMo) and bank transfer networks—and global decentralized ledgers is no longer a theoretical utility but a critical infrastructure requirement. The Stellar network, with its low-latency consensus mechanism and native asset issuance capabilities, has established itself as the premier settlement layer for this corridor. However, the technical barrier to entry for Fintechs desiring to become "Anchors" (on/off-ramps) remains prohibitively high. An Anchor must act as a sophisticated protocol translator, simultaneously managing high-fidelity blockchain interactions (Horizon API), rigorous banking compliance (KYC/AML), complex state management (SEP-24 state machines), and high-availability webhook ingestion from fiat aggregators like Flutterwave and Paystack.

This report articulates the comprehensive architectural blueprint for "Anchor-in-a-Box," a next-generation Software Development Kit (SDK) designed to commoditize the creation of Stellar Anchors. Drawing architectural inspiration from modern, developer-centric authentication libraries such as "Better-Auth" 1, this SDK abstracts the dense technical specifications of Stellar Ecosystem Proposals (specifically SEP-10 and SEP-24) into a type-safe, modular, and plugin-based architecture.

The proposed system addresses the specific fragmentation and latency characteristics of African payment markets. By standardizing the interface between asynchronous fiat aggregators and the synchronous Stellar ledger, Anchor-in-a-Box reduces the integration timeline from months to days. The report details a "Rail-to-Chain" logic engine capable of handling the vagaries of USSD-based mobile money settlement, a robust database schema optimized for auditability via Prisma and PostgreSQL, and a "One-Click" deployment strategy leverages modern serverless and containerized infrastructure to democratize access to the global financial system.

## ---

**1\. SDK Interface Design: The 'Better-Auth' Developer Experience Pattern**

The primary obstacle hindering widespread adoption of Stellar standards among Web2 developers is the cognitive load required to implement SEPs (Stellar Ecosystem Proposals). A compliant SEP-24 implementation necessitates the orchestration of interactive web flows, cryptographic signing, JWT (JSON Web Token) management, and multi-step handshake protocols.3 To resolve this, the Anchor-in-a-Box SDK adopts the Developer Experience (DX) principles pioneered by libraries like Better-Auth: radical type safety, modular plugin architecture, and a philosophy of "configuration over boilerplate."

### **1.1 The Factory Pattern and Type Inference**

The architectural core of the SDK is the factory function, createAnchor. This function initializes a singleton instance of the anchor server, serving as the central orchestrator for database connections, blockchain listeners, and API route generation. Unlike traditional class-based inheritances which can become rigid, this functional composition allows for superior type inference and tree-shaking capabilities.

In the spirit of Better-Auth 1, the configuration object passed to createAnchor is strictly typed. This ensures that essential configuration parameters—such as the Stellar Network passphrase or the specific database adapter—are validated at compile time. This preemptive validation is critical in financial software where runtime configuration errors can lead to lost funds or security vulnerabilities.

The configuration interface is designed to be declarative. The developer describes _what_ the anchor should do (e.g., "support SEP-24 for USDC on Testnet"), and the SDK handles the _how_ (generating the /info endpoint, setting up the event listeners, and configuring the TOML file).

TypeScript

// Architectural Concept: The Declarative Anchor Configuration  
import { createAnchor } from "@stellar/anchor-box";  
import { postgresAdapter } from "@stellar/anchor-box/adapters/postgres";  
import { sep24 } from "@stellar/anchor-box/plugins/sep24";  
import { flutterwave } from "@stellar/anchor-box/plugins/rails/flutterwave";

export const anchor \= createAnchor({  
 network: "testnet", // 'public' | 'testnet' | 'futurenet'  
 debug: process.env.NODE_ENV \=== "development",

    // Database Adapter: Decouples storage logic from protocol logic \[2\]
    database: postgresAdapter({
        url: process.env.DATABASE\_URL,
        schema: "anchor\_schema"
    }),

    // Secret Management: Centralized vault for high-entropy keys
    secrets: {
        sep10SigningKey: process.env.SEP10\_SIGNING\_KEY,
        interactiveJwtSecret: process.env.JWT\_SECRET,
        distributionAccountSecret: process.env.DISTRIBUTION\_SECRET
    },

    // Plugin System: Modular capability injection
    plugins:,
            interactiveDomain: "https://anchor.finance/portal",
            kycLevel: "strict",
            // Hook injection for custom business logic
            hooks: {
                onInteractive: async (ctx) \=\> {
                    // Custom pre-processing logic
                }
            }
        }),

        // Rail Layer: African Fiat Aggregators \[5\]
        flutterwave({
            secretKey: process.env.FLW\_SECRET\_KEY,
            webhookSecret: process.env.FLW\_WEBHOOK\_HASH,
            mapping: {
                "NGNC": "NGN", // Map Stellar Asset to Fiat Currency
                "USDC": "USD"
            }
        })
    \]

});

### **1.2 The Plugin System Architecture**

The versatility of the SDK lies in its extensibility. The core SDK manages the foundational infrastructure—Express/Hono server instantiation, database connection pooling, global error handling, and standard logging. Plugins are then used to inject specific functional capabilities, following the BetterAuthPlugin interface pattern.4

#### **Server-Side Plugin Injection**

Plugins in Anchor-in-a-Box are capable of modifying the server's behavior in three distinct ways:

1. **Route Injection**: Plugins can register new API routes. For instance, the sep24 plugin automatically mounts GET /info, POST /transactions/deposit/interactive, and POST /transactions/withdraw/interactive.3
2. **Schema Extension**: Plugins can request specific database tables. The sep24 plugin requires a Transaction table with specific status enums, while a sep12 (KYC) plugin might require a Customer table. The SDK utilizes Prisma's extension capabilities to merge these requirements.
3. **Lifecycle Hooks**: Plugins can register listeners for core events. A "Notification Plugin" could listen for onTransactionStatusChange to send SMS alerts via Twilio when a deposit completes.

The plugin interface is defined to ensure rigorous type safety across the application:

TypeScript

export interface AnchorPlugin {  
 id: string;  
 // Inject API routes into the main server instance  
 routes?: RouteDefinition;  
 // Extend the database schema context  
 schema?: SchemaDefinition;  
 // Hook into the transaction lifecycle  
 hooks?: {  
 onDepositRequest?: (ctx: Context) \=\> Promise\<void\>;  
 onWithdrawalRequest?: (ctx: Context) \=\> Promise\<void\>;  
 onSep10Challenge?: (tx: Transaction) \=\> Promise\<Transaction\>;  
 };  
}

### **1.3 Client-Side Hooks and RPC Generation**

A major friction point in current Stellar development is the disconnect between backend logic and frontend consumption. Anchor-in-a-Box addresses this by auto-generating a type-safe client, similar to how Better-Auth provides a createAuthClient.4

This client library abstracts the complexity of HTTP requests, error handling, and authentication headers. If the server is configured with SEP-24, the client automatically exposes methods like anchorClient.sep24.deposit(). Furthermore, the SDK provides React/Vue hooks that manage the complex state of interactive flows.

The useAnchorSession hook, for example, manages the SEP-10 authentication lifecycle. It handles the interaction with wallet extensions (like Freighter or Albedo), signing the challenge transaction, and storing the resulting JWT in secure storage. This removes the need for the developer to manually parse XDR (External Data Representation) or manage token expiration.6

## ---

**2\. Protocol Abstraction: SEP-10 and SEP-24**

The Stellar protocols are robust specifications designed for maximum interoperability, but their implementation requires significant boilerplate code. The SDK acts as a logic compression layer, strictly adhering to the protocols while exposing simplified high-level abstractions to the developer.

### **2.1 SEP-10: Web Authentication and Session Management**

SEP-10 defines the standard for proving ownership of a Stellar account using a cryptographic challenge-response mechanism.7 This is critical for anchors to ensure that the user requesting a deposit actually controls the Stellar account receiving the funds.

#### **The Challenge Generation Engine**

The SDK implements the server-side logic of SEP-10 completely within its internal auth module. When a client initiates authentication:

1. **Transaction Construction**: The SDK builds a Stellar transaction. As per security best practices, the sequence number is set to 0 to prevent the transaction from ever being valid for submission to the ledger, strictly limiting its use to authentication.7
2. **Nonce Management**: A 64-byte random nonce is included via a manageData operation. This prevents replay attacks where a malicious actor might intercept a signed challenge and attempt to reuse it.
3. **Time Bounds**: The SDK enforces strict time bounds (defaulting to 300 seconds) to ensure the challenge is fresh.8
4. **Server Signing**: The transaction is signed by the Anchor’s server signing key. This allows the client to verify that the challenge indeed originated from the trusted anchor.6

#### **Signature Verification and JWT Issuance**

Upon receiving the signed challenge transaction back from the client, the SDK performs rigorous validation:

1. **Signature Extraction**: It parses the XDR envelope and extracts all signatures.
2. **Threshold Validation**: It queries the Stellar Horizon API to fetch the signers of the client account. It calculates the total weight of the signatures present on the transaction. The SDK verifies that this weight meets the threshold required for the account (usually the medium threshold).7 This is crucial for supporting multi-signature wallets (e.g., DAOs or corporate treasuries).
3. **Client Domain Verification**: If client_attribution is enabled, the SDK verifies that the transaction also bears the signature of the claiming client domain (e.g., wallet.app), preventing man-in-the-middle attacks by rogue wallets.9
4. **JWT Minting**: If all checks pass, the SDK issues a JWT signed with the interactiveJwtSecret. This token contains the sub (Subject: User's Public Key) and jti (Transaction Hash) and is required for all subsequent interactions.10

### **2.2 SEP-24: Hosted Deposit and Withdrawal Logic**

SEP-24 (Hosted Deposits and Withdrawals) acknowledges that many anchors require complex KYC information that cannot be easily standardized into a protocol message. It solves this by allowing the anchor to host an interactive web page.3

#### **The Interactive Flow Orchestrator**

The SDK handles the handshake logic for SEP-24:

1. **Endpoint implementation**: It implements POST /transactions/deposit/interactive.
2. **Request Validation**: It validates that the asset code (e.g., USDC) is supported and that the request is authenticated via the SEP-10 JWT.
3. **Session Initialization**: It creates a database entry for the transaction with status incomplete.
4. **URL Construction**: It generates a unique, one-time URL (e.g., https://api.anchor.box/sep24/interactive?transaction\_id=xyz\&token=jwt). The JWT passed in the URL is distinct from the SEP-10 token; it is a short-lived token specifically for accessing the interactive form.3

#### **The Transaction State Machine**

Crucially, the SDK enforces a unidirectional state machine for SEP-24 transactions to prevent race conditions and fund loss. The states are strictly mapped to the SEP-24 specification 11:

- **incomplete**: The initial state. The user is currently interacting with the web page, uploading ID documents, or entering bank details.
- **pending_anchor**: The user has finished, and the anchor (SDK) is performing background checks (e.g., validating a Nigerian BVN via an API).
- **pending_user_transfer_start**: The anchor is ready. The user is instructed to send the fiat currency (e.g., "Send 5000 NGN to Bank X").
- **pending_external**: The anchor has received the fiat payment but has not yet settled the crypto.
- **completed**: The Stellar asset has been successfully sent to the user's wallet.

The SDK exposes hooks for developers to intervene at these state transitions. For example, a developer might attach a listener to pending_user_transfer_start to automatically generate a virtual bank account via Paystack and display it to the user.

## ---

**3\. Webhook Mapping: Rail-to-Chain Logic**

The core value proposition of an African Anchor is the bridge between the "Rail" (Mobile Money/Bank) and the "Chain" (Stellar). This section details the logic for mapping asynchronous, often unreliable fiat events to immutable blockchain operations.

### **3.1 The Ingestion Engine and Normalization**

Fiat aggregators like Flutterwave and Paystack rely heavily on Webhooks to notify systems of payments. The SDK includes a WebhookIngestionService that acts as a translation layer, normalizing disparate payloads into a canonical internal event format.

#### **Payload Normalization Strategy**

The SDK defines a standard RailEvent interface. It employs adapter patterns to map incoming JSON from different providers to this interface.

| Data Point          | Flutterwave Source  | Paystack Source                                                     | Normalized SDK Internal Field |
| :------------------ | :------------------ | :------------------------------------------------------------------ | :---------------------------- |
| **Transaction Ref** | data.tx_ref         | data.reference                                                      | rail_reference                |
| **Fiat Amount**     | data.amount         | data.amount (Note: Paystack sends kobo, requiring division by 100\) | fiat_amount                   |
| **Currency**        | data.currency       | data.currency                                                       | fiat_currency                 |
| **Status**          | data.status         | data.status                                                         | rail_status                   |
| **Payer Email**     | data.customer.email | data.customer.email                                                 | customer_identifier           |
| **Event Type**      | charge.completed    | charge.success                                                      | deposit_success               |

#### **Signature Verification Security**

Before processing any webhook, the SDK verifies the cryptographic signature to ensure the request originated from the payment provider.

- **Paystack**: The SDK computes an HMAC-SHA512 hash of the request body using the RAIL_SECRET_KEY and compares it to the x-paystack-signature header.13
- **Flutterwave**: Similarly, it verifies the verif-hash header.
- **Replay Protection**: The SDK checks the rail_reference against the database. If a transaction with this reference has already been processed (status completed), the webhook is logged as a duplicate and ignored (idempotency).

### **3.2 Matching Logic: The tx_ref Strategy**

A critical challenge in on-ramps is matching an incoming bank transfer to a specific Stellar user's intent. The SDK solves this via a strict tx_ref generation strategy.

1. **Generation**: When a user initiates a deposit in the SEP-24 flow, the SDK generates a UUID (e.g., 550e8400-e29b...).
2. **Association**: This UUID is stored in the database as the railReference.
3. **Passing to Rail**: When the interactive frontend initializes the payment widget (e.g., PaystackPop), this UUID is passed as the ref or tx_ref parameter.
4. **Reconciliation**: When the webhook arrives, the SDK queries the Sep24Transaction table where railReference matches the webhook's ID.
   - **Defensive Check**: The SDK compares the fiat_amount in the webhook with the amountIn expected in the database. If the user paid less than expected (partial payment), the SDK transitions the status to pending_anchor (requiring manual intervention) rather than completed, protecting the anchor from slippage or fraud.

### **3.3 The Settlement Engine (Chain Distribution)**

Once the "Rail" side is confirmed, the "Chain" side must execute. The SDK utilizes a StellarQueue (backed by Redis or Postgres) to manage on-chain submissions. This queuing system is essential because the Stellar network requires strict sequence number management for accounts.

**Execution Flow for Deposit:**

1. **Job Creation**: Upon valid webhook verification, a job is pushed to the AssetDistributor queue.
2. **Transaction Building**: The worker loads the Distribution Account key (securely). It checks if the user's account exists on-chain.
   - _If Exists_: It builds a payment operation.
   - _If New_: It builds a createAccount operation (if sending XLM) or a claimableBalance operation (if sending tokens like USDC to an unfunded account) to ensure the user can receive the funds without a trustline.15
3. **Submission**: The transaction is submitted to the Stellar Horizon API.
4. **Finalization**: Upon a 200 OK response from Horizon, the database status updates to completed. The stellar_transaction_id is saved.

### **3.4 Handling Withdrawals (Chain-to-Rail)**

Withdrawals reverse the flow. The SDK must listen to the Stellar network for incoming payments to the Anchor's account.

1. **Memo Mapping**: The SDK assigns a unique memo (type: hash or id) to the user during the SEP-24 interactive setup. This memo acts as the unique identifier linking the blockchain transaction to the database record.16
2. **Horizon Streaming**: A background worker creates a Server-Sent Events (SSE) stream on the Anchor's account.17
3. **Match**: When a payment arrives with a memo matching a pending withdrawal transaction:
   - The SDK updates the status to pending_external.
4. **Payout Trigger**: The SDK automatically calls the Rail Provider's Transfer API (e.g., flutterwave.transfers.create) to send fiat to the user's bank account.
5. **Completion**: When the Payout Webhook returns transfer.success, the transaction is marked completed.

## ---

**4\. Database Schema: Prisma/PostgreSQL Design**

To support high-frequency financial transactions with ACID compliance, the SDK utilizes Prisma with a PostgreSQL backend. The schema is strictly typed, leveraging PostgreSQL's native features for data integrity.

### **4.1 Schema Definition**

The schema centers around three core models: AnchorUser (Identity), StellarAccount (Chain Identity), and Sep24Transaction (The Event).

Code snippet

// schema.prisma

datasource db {  
 provider \= "postgresql"  
 url \= env("DATABASE_URL")  
}

generator client {  
 provider \= "prisma-client-js"  
 previewFeatures \= \["postgresqlExtensions"\] // Enable crypto extensions  
}

// Enum mapping strictly to SEP-24 status specifications  
// Using strict enums prevents invalid state transitions at the DB level  
enum TransactionStatus {  
 incomplete  
 pending_anchor  
 pending_user_transfer_start  
 pending_user_transfer_complete  
 pending_external  
 pending_trust  
 pending_user  
 completed  
 refunded  
 expired  
 error  
 no_market  
 too_small  
 too_large  
}

model AnchorUser {  
 id String @id @default(uuid())  
 email String? @unique  
 kycLevel Int @default(0) // 0: None, 1: Basic, 2: Verified  
 createdAt DateTime @default(now())  
 updatedAt DateTime @updatedAt

// Relations  
 stellarAccounts StellarAccount  
 transactions Sep24Transaction  
}

model StellarAccount {  
 publicKey String @id  
 userId String  
 user AnchorUser @relation(fields: \[userId\], references: \[id\])

// SEP-10 Nonce storage for replay protection  
 lastAuthAt DateTime?  
 clientDomain String? // Track which wallet app the user uses  
}

model Sep24Transaction {  
 id String @id @default(uuid())  
 // The SEP-24 transaction ID exposed to wallets

// Relations  
 userId String  
 user AnchorUser @relation(fields: \[userId\], references: \[id\])

// Transaction Details  
 status TransactionStatus @default(incomplete)  
 kind String // 'deposit' or 'withdrawal'  
 assetCode String  
 assetIssuer String  
 amountIn Decimal? @db.Decimal(20, 7\) // High precision for crypto  
 amountOut Decimal? @db.Decimal(20, 7\)  
 amountFee Decimal? @db.Decimal(20, 7\)

// Rail Mapping  
 railProvider String? // 'flutterwave', 'paystack'  
 railReference String? @unique // The tx_ref used in Fiat world. Unique constraint prevents double-spend.

// Chain Mapping  
 stellarTxId String? // Hash of the Stellar transaction  
 stellarMemo String? // Memo used for withdrawal matching

// Timestamps  
 startedAt DateTime @default(now())  
 completedAt DateTime?

// Audit Trail  
 messages TransactionMessage  
}

model TransactionMessage {  
 id Int @id @default(autoincrement())  
 transactionId String  
 transaction Sep24Transaction @relation(fields: \[transactionId\], references: \[id\])  
 message String // e.g. "Webhook received with amount 5000"  
 createdAt DateTime @default(now())  
}

### **4.2 Key Design Decisions**

- **Decimal Precision**: Financial values utilize @db.Decimal(20, 7). This is critical. Floating point math (Standard JS number) is imprecise and can lead to financial drift. The 7 decimal places align with Stellar's "stroop" unit (1 XLM \= 10,000,000 stroops).
- **Status Enum**: The TransactionStatus enum mirrors the exact strings required by the SEP-24 specification. This eliminates the need for a translation layer between the database and the API response.
- **Unique Constraints**: railReference is marked @unique. This is a hard database-level constraint. If a webhook is accidentally replayed by the provider (a common occurrence with Flutterwave), the database will reject the duplicate insert/update attempt, preserving the integrity of the ledger.

## ---

## **5\. Deployment: One-Click Strategy**

The "Anchor-in-a-Box" SDK is designed for deployment on modern, ephemeral infrastructure. The architecture supports a "One-Click" deployment strategy compatible with Vercel, Railway, or standard Docker environments.

### **5.1 Hybrid Deployment Architecture**

The recommended production architecture is a **"Headless Vercel \+ Worker Railway"** pattern.

1. **API Layer (Vercel/AWS Lambda)**:
   - Hosts the SEP-24 endpoints (/info, /transactions).
   - Hosts the SEP-10 Auth endpoint.
   - Hosts the Webhook Receivers.
   - _Rationale_: These endpoints are HTTP-triggered and benefit from Vercel's global CDN and DDoS protection.
2. **Worker Layer (Railway/DigitalOcean)**:
   - Hosts the StellarWatcher service.
   - Maintains a persistent connection (SSE) to the Horizon API.
   - Processes the Redis Job Queue for asset distribution.
   - _Rationale_: Serverless functions have execution time limits (usually 10-60 seconds) which make them unsuitable for long-polling blockchain events or processing heavy crypto jobs.

###

### **5.2 The "Deploy to Vercel" Configuration**

The SDK includes a vercel.json and a "Deploy Button" URL configuration that pre-populates necessary environment variables.18

**Deploy Button Parameters:**

The URL is constructed to prompt the user for specific keys:

https://vercel.com/new/clone?repository-url=...\&env=STELLAR\_NETWORK,SEP10\_SIGNING\_KEY,DATABASE\_URL

| Variable              | Description                                  | Security Consideration            |
| :-------------------- | :------------------------------------------- | :-------------------------------- |
| STELLAR_NETWORK       | testnet or public                            | Determines Horizon URL            |
| SEP10_WEB_AUTH_DOMAIN | Domain for auth challenges (e.g., anchor.io) | Must match stellar.toml           |
| DATABASE_URL          | Postgres connection string                   | Should use SSL mode               |
| SEP10_SIGNING_KEY     | Stellar Secret Key for signing challenges    | **Critical**: Can compromise auth |
| DISTRIBUTION_SECRET   | Secret Key for the asset holding account     | **Critical**: Holds funds         |

### **5.3 Secret Management: Supabase Vault Integration**

Storing high-value private keys (like the Distribution Account Secret) in plain environment variables is a security risk. The SDK natively integrates with **Supabase Vault** 20 via its database adapter.

- **Mechanism**: The DISTRIBUTION_SECRET env var is replaced with a KEY_ID (UUID).
- **Runtime Decryption**: When the worker needs to sign a transaction, the SDK executes a SQL query:  
  select decrypted_secret from vault.decrypted_secrets where key_id \= $1
- **Security Benefit**: The private key is never stored in the application's codebase or environment configuration. It exists only in the secure Vault table (encrypted at rest) and is decrypted only within the ephemeral memory of the signing process.

### **5.4 One-Click Docker Strategy**

For developers preferring a unified deployment, the SDK ships with a highly optimized multi-stage Dockerfile.

Dockerfile

\# Anchor-in-a-Box Standard Image  
\# Stage 1: Builder  
FROM node:18\-alpine AS builder  
WORKDIR /app  
COPY..  
RUN npm ci && npm run build

\# Stage 2: Runner  
FROM node:18\-alpine AS runner  
WORKDIR /app  
COPY \--from=builder /app/dist./dist  
COPY \--from=builder /app/node_modules./node_modules  
COPY prisma./prisma

\# Entrypoint: Handles Database Migration and Server Start  
CMD \["sh", "-c", "npx prisma migrate deploy && node dist/server.js"\]

This Dockerfile is optimized for African hosting environments (which may have bandwidth constraints) by stripping all development dependencies, resulting in a lightweight image (\<150MB). The entrypoint script ensures that whenever a new version is deployed, database migrations are applied automatically before the application starts, ensuring schema consistency.

## ---

**6\. Strategic Implications and African Market Nuances**

### **6.1 Handling Mobile Money Latency**

In African markets, Mobile Money (MoMo) transactions via USSD are not always instantaneous. Network congestion can lead to timeouts where the user is debited, but the webhook is delayed by minutes or even hours.

- **Architectural Response**: The SDK's webhook handler is designed to be **idempotent**. It can accept the same "success" webhook multiple times without duplicating the asset distribution.
- **Polling Fallback**: To mitigate missed webhooks, the SDK includes a CRON module. This background job periodically queries the Rails API (e.g., flutterwave.Transaction.verify) for all transactions in the pending_user_transfer_start state that are older than 10 minutes. If the API confirms success, the SDK manually triggers the completion flow, ensuring the user receives their funds even if the webhook failed.

### **6.2 KYC and Identity Federation**

Identity verification in Africa is fragmented (BVN in Nigeria, Ghana Card in Ghana, National ID in Kenya). SEP-24 requires the Anchor to verify identity, but building these integrations from scratch is complex.

- **Plugin Opportunity**: The SDK's modularity allows for "Identity Plugins." A developer can install @stellar/anchor-box-plugin-verify-me, which hooks into the pending_anchor state. When a transaction enters this state, the plugin automatically triggers a verification check against the local identity authority. Only upon success does the transaction proceed to pending_user_transfer_start.

### **6.3 Cost Optimization via Fee Bumping**

Stellar transactions require fees (paid in XLM). A significant friction point for new users is that they may have USDC but no XLM to pay for the withdrawal transaction.

- **Solution**: The SDK employs **Fee Bumping** (CAP-15).
- **Mechanism**: The Distribution Account signs the inner transaction (the payment). A dedicated "Fee Account" signs the outer transaction, paying the gas.
- **Benefit**: The user receives the exact amount of USDC/NGNC requested, without dust-level deductions for network fees. This provides a cleaner accounting experience and simplifies tax reporting for the anchor.

## ---

**Conclusion**

The "Anchor-in-a-Box" SDK represents a paradigm shift from _implementing_ protocols to _configuring_ capabilities. By wrapping the rigor of SEP-10 and SEP-24 in a type-safe, fluent interface similar to Better-Auth, and strictly defining the data mapping between African Fiat Rails and the Stellar Ledger, this architecture empowers developers to deploy production-grade financial infrastructure in a fraction of the time. The combination of Prisma's rigorous schema enforcement, Supabase Vault's security, and the "Headless \+ Worker" deployment strategy ensures that the system is not only developer-friendly but robust enough to handle the realities of cross-border value movement in emerging markets. Future iterations of this architecture will expand the plugin ecosystem to support SEP-31 (Cross-Border Remittances) and SEP-38 (RFQs), fully closing the loop on the African corridor remittance economy.
