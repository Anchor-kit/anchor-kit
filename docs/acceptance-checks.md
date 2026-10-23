# Focused acceptance checks

Run the focused checks below from the repository root. Expected results are
included so each acceptance gate can be reproduced locally.

## Numeric JWT lifetime

```sh
bun test tests/utils/crypto.test.ts
```

Expected: the test file passes, including checks that numeric `expiresIn: 60`
sets `exp - iat` to 60 seconds, `expiresIn: 0` sets `exp` to `iat`, invalid
numeric values are rejected, and jose duration strings remain supported.

## SEP-10 challenge transaction

```sh
bun test tests/mvp-express.integration.test.ts -t "challenge -> token happy path"
```

Expected: the integration test passes; Stellar's independent
`WebAuth.readChallengeTx` parser recognizes the challenge, identifies the
client account, and reads sequence zero before the wallet signs it.
Challenge lifetime configuration is limited to 1-300 seconds; verify its
boundary checks with `bun test tests/core/config.test.ts`.

## Published declarations and public adapter option

```sh
bun run check:consumer
```

Expected: the SDK builds, is packed and installed into a temporary external
consumer, and strict NodeNext TypeScript compilation succeeds for imports of
`createAnchor`, `AnchorKitConfig`, `DatabaseAdapter`, and `CreateAnchorOptions`.

## Custom database adapter lifecycle

```sh
bun test tests/core/factory-lifecycle.test.ts -t "injected database adapter lifecycle"
```

Expected: the fake adapter supplied through `createAnchor` receives exactly one
`connect()`, one `migrate()`, and one `disconnect()` for one init/shutdown
cycle, including when shutdown is called twice.

Run the following acceptance checks from the repository root:

| Gate                                                  | Command                                                                   | Expected result                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL webhook and watcher JSON/status validation | `bun test tests/runtime/database/postgres-json-shapes.test.ts`            | All assertions pass; object-shaped payloads and the three supported statuses are accepted, and malformed shapes/statuses raise `MalformedPersistedDataError`.                             |
| Local Stellar signer                                  | `bun test tests/services/stellar-signer.test.ts`                          | All assertions pass; the unsigned testnet fixture receives a verifiable signature, and invalid seeds/passphrases fail without exposing the seed.                                          |
| Clean packed consumer                                 | `bun run build`, `bun run check:pack`, then `bun run check:package-smoke` | The built tarball contains the required public package files, installs in a temporary consumer with Bun, and initializes and shuts down SQLite using only the `anchor-kit` public export. |

The release repository guard check is documented in [releasing.md](./releasing.md).
