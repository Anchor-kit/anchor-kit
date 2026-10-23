# Background startup rollback

`AnchorInstance.startBackgroundJobs()` records which services successfully started during the
attempt. If a watcher rejects, successfully started watchers and the queue are stopped in reverse
startup order before the original startup error is rethrown. A later call can retry startup.
Rollback errors are logged without replacing the original startup failure.

Focused verification:

```bash
bun test tests/core/factory-background-startup.test.ts
```

Expected result: the factory tests pass, including a failing watcher that leaves no previously
started service running and a subsequent successful retry.
