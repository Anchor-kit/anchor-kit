# Bun deployment status

The repository does not yet provide the PostgreSQL API and durable-worker Compose example. The example app uses an in-memory queue, so restarting its worker does not demonstrate settlement recovery. Worker leasing and separate readiness checks are tracked in [#724](https://github.com/Anchor-kit/anchor-kit/issues/724) and [#725](https://github.com/Anchor-kit/anchor-kit/issues/725).

To check the packaged SDK from a clean external TypeScript consumer, run:

```sh
bun install --frozen-lockfile
bun run check:package-consumer
```

Expected result: the command reports that the consumer resolves `createAnchor` and public types through package exports. This check does not start a worker or verify restart recovery.

For the existing Node and PostgreSQL package smoke test, build the SDK and set `DATABASE_URL` to a disposable PostgreSQL database before running:

```sh
bun run build
bun run smoke:node-postgres
```

Expected result: the script imports the packed SDK, applies migrations, checks `/health`, and shuts down. It does not test a separate Bun worker, readiness, or recovery after restart. Do not use a production database for this check.
