# Focused issue acceptance checks

Run the focused tests from the repository root:

```sh
bun test tests/utils/stellar.test.ts tests/core/config.test.ts tests/runtime/auth-challenge-replay.test.ts tests/runtime/database/sql-database-adapter.test.ts
```

Expected result: all four test files pass. The checks cover UUID hash memo XDR round-tripping and the 28-byte text-memo limit; deterministic KYC requirements and policy validation; 64-byte, unique SEP-10 nonce values persisted and consumed once; and Bun SQLite initialization.

The Node runtime portability check requires the built SDK. On Windows, run the build commands in Git Bash because the existing build script uses `rm`:

```sh
npm run build
node scripts/check-node-sqlite-driver.mjs
```

Expected result: both commands exit with status 0, and the Node check prints:

```text
Node SDK import and PostgreSQL selection passed; unsupported SQLite is reported clearly.
```

The memo wire format follows Stellar's 32-byte `MEMO_HASH` contract. SEP-10 nonce generation follows the protocol requirement for 48 random bytes encoded as base64, producing 64 bytes for the manage-data value:

- [Stellar transaction memo documentation](https://developers.stellar.org/docs/learn/fundamentals/transactions/operations-and-transactions#memo)
- [SEP-10: Stellar Web Authentication](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
