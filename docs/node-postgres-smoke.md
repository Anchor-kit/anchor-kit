# Node PostgreSQL package smoke test

This focused consumer check runs on Node 22. It builds the package, packs and installs the tarball into a clean temporary Node project, imports `createAnchor` from the package's public entry point, initializes it against PostgreSQL, serves one `/health` request, and shuts down the server and anchor.

The database must be disposable because the test creates the SDK's migration metadata and core tables.

PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://anchor:anchor@127.0.0.1:5432/anchor_kit_smoke'
bun run build
bun run smoke:node-postgres
```

Expected result: the script exits with code 0 and prints `Node PostgreSQL package smoke passed: public import, migration, HTTP /health, and shutdown.` The repository CI runs this check against a disposable PostgreSQL 16 service.
