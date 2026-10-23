# Services

`LocalKeypairSigner` implements the `StellarTransactionSigner` boundary for signing Stellar
transaction XDR with a local secret seed. It exposes only a signing method; the keypair is kept
private, and transaction submission remains the application's responsibility.

Runtime orchestration lives under `src/runtime/`. The in-memory queue, transaction watcher, and
webhook processor are active foundation services. Plugin routes and selected lifecycle hooks
extend the HTTP runtime. Active hooks are deposit request, SEP-10 challenge, and transaction status
change; the declared withdrawal-request hook is not invoked.

Provider-specific integrations and higher-level service modules remain planned. These foundation
services do not implement complete SEP protocol flows.
