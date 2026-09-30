# Graceful shutdown for Express hosts

Anchor-Kit owns the queue, database, watchers, and webhook processor. The host
owns the HTTP server and the process. This guide covers releasing both in an
order that does not drop in-flight requests or exit before cleanup finishes.

## The order that matters

Shut down in this order:

1. Stop accepting new connections and let in-flight requests drain.
2. Await `anchor.shutdown()` to stop background jobs and close the database.
3. Exit the process.

The order is not arbitrary. `anchor.shutdown()` stops the watchers and the
queue. If you exit the process first, work already accepted by the queue can be
lost mid-flight, and the database connection is closed by the OS rather than by
Anchor-Kit.

## Example

```ts
import express from 'express';
import { createAnchor } from 'anchor-kit';

const anchor = createAnchor(config);
await anchor.init();

const app = express();
app.use('/anchor', anchor.getExpressRouter());

const server = app.listen(3000);

// Count in-flight requests so shutdown can report what it drained instead of
// sleeping for a fixed period. Note this is a `request` listener on the Node
// server, which has no `next` callback — Express middleware is what supplies
// that, and the router is mounted above.
let inFlight = 0;
server.on('request', (_req, res) => {
  inFlight += 1;
  res.on('finish', () => {
    inFlight -= 1;
  });
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  // A second Ctrl-C, or SIGINT arriving alongside SIGTERM, must not start a
  // second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);

  try {
    // 1. Refuse new connections. `close()` stops the listener and fires the
    //    callback once every in-flight request has finished.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (inFlight > 0) console.log(`${inFlight} requests still draining`);

    // 2. Release Anchor-Kit resources.
    await anchor.shutdown();

    // 3. Only now is it safe to leave.
    process.exit(0);
  } catch (err) {
    // Do not exit 0 when cleanup failed: a supervisor would treat a failed
    // drain as a clean shutdown and never surface the problem.
    console.error('graceful shutdown failed', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

## What `anchor.shutdown()` actually does

The behaviour below is pinned by `tests/core/graceful-shutdown.test.ts`, so
this section cannot drift away from the implementation.

- **It waits for pending initialization.** If `init()` is still in flight,
  `shutdown()` awaits it before releasing anything.
- **It is safe to call more than once.** Repeated and concurrent calls perform
  the cleanup once. A second SIGINT will not disconnect the database twice.
- **It is a no-op before `init()`.** Calling it on a fresh instance resolves
  immediately and touches nothing.
- **It stops background jobs, then disconnects the database**, then clears the
  instance's references. After it resolves, `getExpressRouter()` is no longer
  valid and the instance can be `init()`ed again.
- **It rejects if the database fails to disconnect.** The rejection reaches the
  host, which is why the example above logs and exits non-zero rather than
  swallowing it.
- **It is not a substitute for closing your HTTP server.** Anchor-Kit does not
  own the listener and will not close it.

Note the two shapes of failure here. A failure to _drain the HTTP server_ and a
failure to _disconnect the database_ both surface as a rejected promise, but
only the second one is Anchor-Kit's. Log which stage failed so the two are not
confused during an incident.

## Reinitialization

`shutdown()` clears the instance's state, so the same instance can be brought
back up with `await anchor.init()`. This is what makes the shutdown path safe to
exercise in tests. It creates a new database adapter, so the old connection is
not reused.

## Why the guide does not call `process.exit(0)` unconditionally

A forced exit truncates buffered log writes and can leave a child process or an
open file descriptor behind. The example exits explicitly only after both
stages have completed, and uses a non-zero code when they have not.

## Related

- [`plugin-lifecycle.md`](./plugin-lifecycle.md) — what plugins must and must
  not do during shutdown.
- [`mvp-express.md`](./mvp-express.md) — mounting the router in an Express app.
