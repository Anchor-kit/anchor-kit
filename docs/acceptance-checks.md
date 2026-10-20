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
