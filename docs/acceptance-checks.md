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

## Interactive session validation and revocation (#718)

```sh
bun test tests/runtime/interactive-session-revocation.test.ts tests/mvp-express.integration.test.ts
```

Expected: the focused session tests and SEP-24 integration pass. SEP-24 initiation
persists the returned session, which then authorizes a transaction read and one
completion request. Expired, revoked, wrong-account and wrong-transaction
sessions are rejected before any write. Completion consumes its permitted action
once under replay and a five-way concurrent race. The transaction read endpoint
uses the same gate, while plain bearer reads remain valid.

Run the following acceptance checks from the repository root:

| Gate                                                  | Command                                                                   | Expected result                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL webhook and watcher JSON/status validation | `bun test tests/runtime/database/postgres-json-shapes.test.ts`            | All assertions pass; object-shaped payloads and the three supported statuses are accepted, and malformed shapes/statuses raise `MalformedPersistedDataError`.                             |
| Local Stellar signer                                  | `bun test tests/services/stellar-signer.test.ts`                          | All assertions pass; the unsigned testnet fixture receives a verifiable signature, and invalid seeds/passphrases fail without exposing the seed.                                          |
| Clean packed consumer                                 | `bun run build`, `bun run check:pack`, then `bun run check:package-smoke` | The built tarball contains the required public package files, installs in a temporary consumer with Bun, and initializes and shuts down SQLite using only the `anchor-kit` public export. |

## SEP-10 nonexistent-account authentication

```sh
bun test tests/runtime/sep10-nonexistent-account.test.ts
```

Expected: the test file passes. A genuine missing account (the injected lookup
resolves `null`) authenticates with exactly one valid master-key signature,
while extra signatures, duplicated master signatures, non-master signatures,
and lookups that throw are refused; a thrown lookup answers `502` with
`account_lookup_failed` rather than falling back to the missing-account branch.
The same file also checks that a known multisig account must meet its medium
signer threshold. The behavior follows the [SEP-10 verification
rules](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md).

The release repository guard check is documented in [releasing.md](./releasing.md).
