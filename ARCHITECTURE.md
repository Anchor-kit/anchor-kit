# Architecture Overview

Anchor-Kit is designed to be the "Rails" for Stellar Anchors—opinionated but flexible, emphasizing convention over configuration.

## Core Design Principles

1.  **Type Safety First**: Leveraging TypeScript to prevent runtime errors, especially for financial transactions.
2.  **Plugin-Based**: Core logic (server, auth, db connection) is separate from protocol implementations (SEPs) and payment rail integrations.
3.  **Strict State Machines**: Financial transactions follow rigid, unidirectional state transitions to prevent race conditions and double-spending.
4.  **Developer Experience (DX)**: Inspired by tools like Better-Auth, providing a fluent, clear API.

## Current Implementation (Foundation)

### `src/core`

- `createAnchor()` and `AnchorInstance` lifecycle (`use`, `init`, plugin registry).
- `AnchorConfig` for defaults, immutability, and validation.
- Domain error hierarchy.

### `src/types`

- Unified configuration interfaces.
- Transaction lifecycle and SEP-24 response typing.
- Foundation and plugin interfaces.

### `src/utils`

- Validation, decimal arithmetic, idempotency handling, crypto/JWT helpers, and Stellar helpers.

### `src/plugins`

Modular implementations of SEPs and integrations.

- `sep24/`: Hosted Deposit/Withdrawal flow.
- `sep6/`: API-based Transfer flow (Future).
- `sep31/`: Cross-border payments (Future).

### `src/services`

Shared internal services.

- `StellarService`: Wrappers around Horizon API.
- `QueueService`: Job queues for processing blockchain transactions asynchronously.

## Folder Structure

```
anchor-kit/
├── src/
│   ├── core/           # Factory, config, errors, planned protocol stubs
│   ├── services/       # Planned service layer (currently stubs)
│   ├── plugins/        # SEP implementations and Rail adapters
│   ├── utils/          # Runtime utilities
│   ├── types/          # Public type definitions
│   └── index.ts        # Public API export
├── examples/           # implementing example servers
├── tests/              # Vitest test suite
└── dist/               # Compiled output
```

## Data Flow (SEP-24 Example)

1.  **Wallet** initiates auth (SEP-10).
2.  **Anchor-Kit** verifies signature and issues JWT.
3.  **Wallet** requests deposit (SEP-24).
4.  **Anchor-Kit** creates transaction record (status: `incomplete`) and returns interactive URL.
5.  **User** completes KYC/Payment on the interactive page.
6.  **Anchor-Kit** receives Webhook from Payment Rail (e.g., Flutterwave).
7.  **Anchor-Kit** validates webhook, updates status to `pending_user_transfer_start`.
8.  **Job Queue** picks up job, sends Stellar Asset to user.
9.  **Anchor-Kit** updates status to `completed`.

## SEP-10 Challenge Consumption & Recovery Policy

- **Atomicity**: SEP-10 challenges are strictly one-time credentials. `markAuthChallengeConsumed` uses an atomic SQL query (`UPDATE auth_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`) to ensure that under concurrent token exchange requests for the same challenge, at most one consumer successfully marks the challenge consumed and receives an access token. All other concurrent requests receive HTTP 401 (`invalid_challenge`, message `Challenge already used`).
- **Persistence Failure Recovery**: If the database fails to record the challenge consumption (e.g. storage error during `markAuthChallengeConsumed`), token issuance is aborted immediately and an HTTP 500 (`server_error`) response is returned with no token issued. Because consumption was not persisted in storage, the challenge remains unconsumed, allowing the user/client to safely retry the token exchange request.
