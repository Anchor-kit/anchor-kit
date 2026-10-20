# Runtime Services

Runtime orchestration is implemented under `src/runtime/`: the in-memory queue, transaction watcher, and webhook processor are active foundation services. `src/services/` remains reserved for future provider-specific integrations and higher-level service modules.

These services do not implement SEP protocol engines. Plugin routes and selected lifecycle hooks extend the HTTP runtime; current active hooks are deposit request, SEP-10 challenge, and transaction status change. The declared withdrawal-request hook is not currently invoked.
