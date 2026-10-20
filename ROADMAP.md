# Roadmap

## Current Status: Phase 1 - Foundation 🏗️

We are currently laying the groundwork for the SDK. The project structure, build system, and CI/CD pipelines are established.

## What's Implemented

- [x] Project Structure & Tooling (Bun, TypeScript, ESLint, Prettier)
- [x] CI/CD Pipeline (GitHub Actions)
- [x] Initial Documentation (Architecture, Contributing)
- [x] Core SDK Shell
- [x] SEP-10 Authentication (server-side challenge generation and validation)
- [x] SQL Database Adapter (SQLite reference implementation)
- [x] SEP-24 Interactive Deposit (minimal hosted deposit flow)

## In Progress

- [ ] Plugin System Architecture

## Planned Features

### Phase 2: Alpha (SEP-24)

- [x] **SEP-10**: Full Server-Side challenge generation and validation.
- [x] **SEP-24**: Hosted Deposit flow state machine.
- [ ] **SEP-24**: Hosted Withdrawal flow state machine.
- [ ] **Interactive Client**: React helper hooks for the interactive flow.

### Phase 3: Beta (Rails & Adapters)

- [x] **Database Adapter**: SQL adapter interface with SQLite reference implementation.
- [ ] **Postgres Adapter**: Robust reference implementation with Prisma.
- [ ] **Flutterwave Plugin**: Webhook handling and payouts.
- [ ] **MoneyGram Plugin**: (Investigation required).

### Phase 4: V1.0 (Production Ready)

- [ ] Comprehensive Security Audit.
- [ ] extensive Unit and Integration Tests.
- [ ] stable API Freeze.

### Future / Exploration

- [ ] **SEP-6**: API-based transfer support.
- [ ] **SEP-31**: Cross-border remittance APIs.
- [ ] **Serverless Deployment Helpers**: "One-click" deploy for Vercel/Railway.

## Out of Scope (for now)

- Built-in UI Kits (we provide the SDK, you build the UI).
- Custodial Wallet management (we assume you have a distribution account).
- Non-EVM/Non-Stellar chains.
