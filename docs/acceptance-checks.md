# Focused acceptance checks

Run these checks from the repository root. Each command is limited to the corresponding
acceptance gate:

| Gate | Command | Expected result |
| --- | --- | --- |
| PostgreSQL webhook and watcher JSON/status validation | `bun test tests/runtime/database/postgres-json-shapes.test.ts` | All assertions pass; object-shaped payloads and the three supported statuses are accepted, and malformed shapes/statuses raise `MalformedPersistedDataError`. |
| Local Stellar signer | `bun test tests/services/stellar-signer.test.ts` | All assertions pass; the unsigned testnet fixture receives a verifiable signature, and invalid seeds/passphrases fail without exposing the seed. |
| Clean packed consumer | `bun run build`, `bun run check:pack`, then `bun run check:package-smoke` | The built tarball contains the required public package files, installs in a temporary consumer with Bun, and initializes and shuts down SQLite using only the `anchor-kit` public export. |

The release repository guard check is documented in [releasing.md](./releasing.md).
